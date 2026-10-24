// ─────────────────────────────────────────────────────────────
//  Nather controller firmware (ESP32, Arduino framework)
//
//  - Joins Wi-Fi as "nather" and answers at http://nather.local (mDNS)
//  - Serves the website from LittleFS (../web)
//  - REST API + Server-Sent Events, contract in docs/API.md
//  - PIR + optional light sensor drive "entry lighting"
//  - Falls back to its own hotspot when the home Wi-Fi is unavailable
//
//  The lighting rules mirror web/js/engine.js (used by the browser demo
//  and the mock controller). Change both together.
// ─────────────────────────────────────────────────────────────

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <math.h>

#include "config.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "include/secrets.h not found: building with the placeholders in secrets.example.h"
#include "secrets.example.h"
#endif

// ── State ────────────────────────────────────────────────────

struct Room {
  bool on = false;
  uint8_t brightness = 0;
  uint8_t last = DEFAULT_ON_BRIGHTNESS;  // restored when switched back on
  bool autoOn = false;                   // switched on by motion, eligible for auto-off
};

static Room rooms[ROOM_COUNT];
static bool entry[ROOM_COUNT];

static bool motion = false;
static bool everMotion = false;
static uint32_t lastMotionMs = 0;
static int lightPct = -1;                // -1 = no light sensor
static float lightAvg = -1;

static bool apMode = false;
static volatile bool stateDirty = true;
static uint32_t lastPushMs = 0;
static uint32_t lastWifiRetryMs = 0;
static const uint32_t WIFI_RETRY_MS = 5UL * 60UL * 1000UL;

// The web server runs on its own task, the sensors on loop(): one mutex
// keeps them from changing the room state at the same time.
static SemaphoreHandle_t stateMutex;
struct StateLock {
  StateLock() { xSemaphoreTake(stateMutex, portMAX_DELAY); }
  ~StateLock() { xSemaphoreGive(stateMutex); }
};

static AsyncWebServer server(80);
static AsyncEventSource events("/api/events");
static Preferences prefs;

// ── Helpers ──────────────────────────────────────────────────

static const char* hwName(Hw hw) {
  switch (hw) {
    case Hw::Pwm: return "pwm";
    case Hw::Relay: return "relay";
    default: return "none";
  }
}

static int findRoom(const String& id) {
  for (uint8_t i = 0; i < ROOM_COUNT; i++) {
    if (id == ROOMS[i].id) return i;
  }
  return -1;
}

static bool isDark() {
  return lightPct < 0 || lightPct < DARK_THRESHOLD;
}

// ── Outputs ──────────────────────────────────────────────────

static void setupOutputs() {
  for (uint8_t i = 0; i < ROOM_COUNT; i++) {
    const RoomConfig& c = ROOMS[i];
    if (c.pin < 0) continue;
    if (c.hw == Hw::Relay) {
      // write the "off" level before enabling the pin so the relay does not click on at boot
      digitalWrite(c.pin, RELAY_ACTIVE_LOW ? HIGH : LOW);
      pinMode(c.pin, OUTPUT);
    } else if (c.hw == Hw::Pwm) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
      ledcAttach(c.pin, PWM_FREQ_HZ, PWM_BITS);
#else
      ledcSetup(i, PWM_FREQ_HZ, PWM_BITS);
      ledcAttachPin(c.pin, i);
#endif
    }
  }
}

static void writeOutput(uint8_t i) {
  const RoomConfig& c = ROOMS[i];
  if (c.pin < 0) return;
  const Room& r = rooms[i];
  if (c.hw == Hw::Relay) {
    const bool high = r.on != RELAY_ACTIVE_LOW;
    digitalWrite(c.pin, high ? HIGH : LOW);
  } else if (c.hw == Hw::Pwm) {
    const uint32_t maxDuty = (1UL << PWM_BITS) - 1;
    // gamma 2.2: the eye sees brightness roughly logarithmically,
    // so this makes 50 % on the dial look like half brightness
    uint32_t duty = r.on ? (uint32_t)lroundf(powf(r.brightness / 100.0f, 2.2f) * maxDuty) : 0;
    if (r.on && r.brightness > 0 && duty == 0) duty = 1;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWrite(c.pin, duty);
#else
    ledcWrite(i, duty);
#endif
  }
}

// ── Lighting rules (mirror of web/js/engine.js) ──────────────

// Applies {brightness} or {on} to one room. Returns an HTTP status.
// Call with the state lock held.
static int applyPatch(uint8_t i, JsonVariantConst body, String& err) {
  if (!body.is<JsonObjectConst>()) { err = "Body must be a JSON object"; return 400; }
  Room& r = rooms[i];
  JsonVariantConst b = body["brightness"];
  JsonVariantConst on = body["on"];
  if (!b.isNull()) {
    if (!b.is<float>() || !isfinite(b.as<float>())) { err = "brightness must be a number from 0 to 100"; return 400; }
    long v = lroundf(b.as<float>());
    r.brightness = (uint8_t)constrain(v, 0L, 100L);
    r.on = r.brightness > 0;
  } else if (!on.isNull()) {
    if (!on.is<bool>()) { err = "on must be true or false"; return 400; }
    r.on = on.as<bool>();
    r.brightness = r.on ? (r.brightness ? r.brightness : (r.last ? r.last : DEFAULT_ON_BRIGHTNESS)) : 0;
  } else {
    err = "Send on or brightness";
    return 400;
  }
  if (r.brightness > 0) r.last = r.brightness;
  r.autoOn = false;
  writeOutput(i);
  return 200;
}

static void onMotion(bool active) {
  StateLock lock;
  motion = active;
  if (active) {
    everMotion = true;
    lastMotionMs = millis();
    if (isDark()) {
      for (uint8_t i = 0; i < ROOM_COUNT; i++) {
        Room& r = rooms[i];
        if (entry[i] && !r.on) {
          r.on = true;
          r.brightness = ENTRY_BRIGHTNESS;
          r.last = ENTRY_BRIGHTNESS;
          r.autoOn = true;
          writeOutput(i);
          Serial.printf("[pir] %s on\n", ROOMS[i].id);
        }
      }
    }
  }
  Serial.printf("[pir] motion %s\n", active ? "start" : "end");
  stateDirty = true;
}

static void checkAutoOff(uint32_t now) {
  if (AUTO_OFF_SECONDS == 0 || motion || !everMotion) return;
  if (now - lastMotionMs < AUTO_OFF_SECONDS * 1000UL) return;
  StateLock lock;
  for (uint8_t i = 0; i < ROOM_COUNT; i++) {
    Room& r = rooms[i];
    if (r.autoOn && r.on) {
      r.on = false;
      r.brightness = 0;
      r.autoOn = false;
      writeOutput(i);
      stateDirty = true;
      Serial.printf("[auto-off] %s off\n", ROOMS[i].id);
    }
  }
}

// ── Sensors ──────────────────────────────────────────────────

static void readPir(uint32_t now) {
  if (now < PIR_WARMUP_MS) return;
  const bool v = digitalRead(PIR_PIN) == HIGH;
  if (v != motion) onMotion(v);
}

#if LDR_PIN >= 0
static uint32_t lastLdrMs = 0;
static void readLight(uint32_t now) {
  if (now - lastLdrMs < LDR_READ_MS) return;
  lastLdrMs = now;
  const float pct = analogRead(LDR_PIN) * 100.0f / 4095.0f;
  lightAvg = lightAvg < 0 ? pct : lightAvg * 0.8f + pct * 0.2f;  // smooth flicker and noise
  const int rounded = (int)lroundf(lightAvg);
  if (lightPct < 0 || abs(rounded - lightPct) >= 2) {
    StateLock lock;
    lightPct = rounded;
    stateDirty = true;
  }
}
#else
static void readLight(uint32_t) {}
#endif

// ── Persistence (only the entry-room choice survives a reboot) ──

static void loadEntry() {
  const uint16_t mask = prefs.getUShort("entry", 0);
  for (uint8_t i = 0; i < ROOM_COUNT; i++) entry[i] = mask & (1U << i);
}

static void saveEntry() {
  uint16_t mask = 0;
  for (uint8_t i = 0; i < ROOM_COUNT; i++) if (entry[i]) mask |= (1U << i);
  if (prefs.getUShort("entry", 0) != mask) prefs.putUShort("entry", mask);  // spare the flash
}

// ── JSON ─────────────────────────────────────────────────────

static void roomJson(JsonObject out, uint8_t i) {
  out["on"] = rooms[i].on;
  out["brightness"] = rooms[i].brightness;
  out["hw"] = hwName(ROOMS[i].hw);
  out["pin"] = ROOMS[i].pin;
  out["auto"] = rooms[i].autoOn;
}

static void buildState(JsonDocument& doc) {
  JsonObject dev = doc["device"].to<JsonObject>();
  dev["name"] = DEVICE_HOSTNAME;
  dev["hostname"] = DEVICE_HOSTNAME ".local";
  dev["fw"] = FIRMWARE_VERSION;
  dev["mode"] = apMode ? "ap" : "sta";
  dev["ip"] = (apMode ? WiFi.softAPIP() : WiFi.localIP()).toString();
  dev["mac"] = WiFi.macAddress();
  if (apMode) {
    dev["ssid"] = AP_SSID;
    dev["rssi"] = nullptr;
  } else {
    dev["ssid"] = WiFi.SSID();
    dev["rssi"] = WiFi.RSSI();
  }
  dev["channel"] = WiFi.channel();
  dev["uptime"] = millis() / 1000;
  dev["heap"] = ESP.getFreeHeap();
  dev["clients"] = events.count();
  dev["auth"] = strlen(API_TOKEN) > 0;
  dev["simulated"] = false;

  JsonObject rs = doc["rooms"].to<JsonObject>();
  for (uint8_t i = 0; i < ROOM_COUNT; i++) roomJson(rs[ROOMS[i].id].to<JsonObject>(), i);

  JsonArray er = doc["entryRooms"].to<JsonArray>();
  for (uint8_t i = 0; i < ROOM_COUNT; i++) if (entry[i]) er.add(ROOMS[i].id);

  JsonObject s = doc["sensors"].to<JsonObject>();
  s["motion"] = motion;
  if (everMotion) s["lastMotionAgo"] = (millis() - lastMotionMs) / 1000;
  else s["lastMotionAgo"] = nullptr;
  if (lightPct >= 0) s["light"] = lightPct;
  else s["light"] = nullptr;
  s["dark"] = isDark();
}

static String stateJson() {
  JsonDocument doc;
  {
    StateLock lock;
    buildState(doc);
  }
  String out;
  serializeJson(doc, out);
  return out;
}

// ── HTTP ─────────────────────────────────────────────────────

static void sendJson(AsyncWebServerRequest* req, int code, const String& body) {
  AsyncWebServerResponse* res = req->beginResponse(code, "application/json", body);
  res->addHeader("Cache-Control", "no-store");
  req->send(res);
}

static void sendError(AsyncWebServerRequest* req, int code, const String& message) {
  JsonDocument doc;
  doc["error"] = message;
  String out;
  serializeJson(doc, out);
  sendJson(req, code, out);
}

static bool authorised(AsyncWebServerRequest* req) {
  if (strlen(API_TOKEN) == 0) return true;
  const AsyncWebHeader* h = req->getHeader("Authorization");
  return h && h->value() == String("Bearer ") + API_TOKEN;
}

// Collects a request body into req->_tempObject (the server frees it).
static void collectBody(AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t index, size_t total) {
  if (total > MAX_BODY_BYTES) return;
  if (index == 0) req->_tempObject = malloc(total + 1);
  if (!req->_tempObject) return;
  memcpy((uint8_t*)req->_tempObject + index, data, len);
  if (index + len == total) ((char*)req->_tempObject)[total] = '\0';
}

// Common checks for writes. Returns false after sending the error.
static bool readWrite(AsyncWebServerRequest* req, JsonDocument& body) {
  if (!authorised(req)) { sendError(req, 401, "Missing or wrong API token"); return false; }
  if (req->contentLength() > MAX_BODY_BYTES) { sendError(req, 413, "Body too large"); return false; }
  if (!req->_tempObject || deserializeJson(body, (const char*)req->_tempObject)) {
    sendError(req, 400, "Body is not valid JSON");
    return false;
  }
  return true;
}

static void handleRoomPut(AsyncWebServerRequest* req) {
  const String id = req->url().substring(strlen("/api/rooms/"));
  const int i = findRoom(id);
  if (i < 0) { sendError(req, 404, "Unknown room: " + id); return; }
  JsonDocument body;
  if (!readWrite(req, body)) return;

  String err;
  int code;
  JsonDocument out;
  {
    StateLock lock;
    code = applyPatch(i, body.as<JsonVariantConst>(), err);
    if (code == 200) roomJson(out.to<JsonObject>(), i);
  }
  if (code != 200) { sendError(req, code, err); return; }
  stateDirty = true;
  String s;
  serializeJson(out, s);
  sendJson(req, 200, s);
  Serial.printf("[api] %s -> %u%% from %s\n", id.c_str(), rooms[i].brightness, req->client()->remoteIP().toString().c_str());
}

static void handleEntryPut(AsyncWebServerRequest* req) {
  JsonDocument body;
  if (!readWrite(req, body)) return;
  JsonVariantConst list = body["rooms"];
  if (!list.is<JsonArrayConst>()) { sendError(req, 400, "rooms must be an array of room ids"); return; }

  bool next[ROOM_COUNT] = {};
  for (JsonVariantConst v : list.as<JsonArrayConst>()) {
    const int i = v.is<const char*>() ? findRoom(v.as<String>()) : -1;
    if (i < 0) { sendError(req, 400, "Unknown room: " + v.as<String>()); return; }
    next[i] = true;
  }
  {
    StateLock lock;
    memcpy(entry, next, sizeof(entry));
  }
  saveEntry();
  stateDirty = true;

  JsonDocument out;
  JsonArray rs = out["rooms"].to<JsonArray>();
  for (uint8_t i = 0; i < ROOM_COUNT; i++) if (entry[i]) rs.add(ROOMS[i].id);
  String s;
  serializeJson(out, s);
  sendJson(req, 200, s);
}

static void setupServer() {
  // Allow a dashboard served from another origin (e.g. a laptop) to call the API.
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  server.on("/api/state", HTTP_GET, [](AsyncWebServerRequest* req) { sendJson(req, 200, stateJson()); });
  server.on("/api/rooms/*", HTTP_PUT, handleRoomPut, nullptr, collectBody);
  server.on("/api/entry-rooms", HTTP_PUT, handleEntryPut, nullptr, collectBody);

  events.onConnect([](AsyncEventSourceClient* client) {
    Serial.printf("[sse] client connected (%u open)\n", (unsigned)events.count());
    client->send(stateJson().c_str(), "state", millis(), 2000);  // 2000 = browser retry delay in ms
  });
  server.addHandler(&events);

  // Images rarely change; pages and scripts must match the firmware, so they always revalidate.
  server.serveStatic("/img/", LittleFS, "/img/").setCacheControl("max-age=86400");
  server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html").setCacheControl("no-cache");

  server.onNotFound([](AsyncWebServerRequest* req) {
    if (req->method() == HTTP_OPTIONS) { req->send(204); return; }  // CORS preflight
    sendError(req, 404, "Not found");
  });

  server.begin();
}

static void pushState(uint32_t now) {
  const bool changed = stateDirty && now - lastPushMs >= STATE_PUSH_MIN_MS;
  if (!changed && now - lastPushMs < HEARTBEAT_MS) return;
  stateDirty = false;
  lastPushMs = now;
  if (events.count() == 0) return;
  const String json = stateJson();
  events.send(json.c_str(), "state", now);
}

// ── Wi-Fi ────────────────────────────────────────────────────

static void startWifi() {
  WiFi.setHostname(DEVICE_HOSTNAME);   // DHCP hostname; set before the interface starts
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                // modem sleep adds 100–300 ms to every reply
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[wifi] joining \"%s\"", WIFI_SSID);

  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected  ip %s  mask %s  gateway %s  rssi %d dBm  channel %d\n",
                  WiFi.localIP().toString().c_str(), WiFi.subnetMask().toString().c_str(),
                  WiFi.gatewayIP().toString().c_str(), WiFi.RSSI(), WiFi.channel());
    return;
  }

  // Keep the lights controllable without the router: open a hotspot.
  // Auto-reconnect is off here because each retry scans other channels
  // and drops phones connected to the hotspot; maintainWifi() retries slowly.
  apMode = true;
  WiFi.setAutoReconnect(false);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  lastWifiRetryMs = millis();
  Serial.printf("[wifi] could not join; hotspot \"%s\" at http://%s\n", AP_SSID, WiFi.softAPIP().toString().c_str());
}

static void maintainWifi(uint32_t now) {
  if (!apMode) return;
  if (WiFi.status() == WL_CONNECTED) {
    apMode = false;
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    Serial.printf("[wifi] home network back, hotspot closed, ip %s\n", WiFi.localIP().toString().c_str());
    stateDirty = true;
    return;
  }
  if (now - lastWifiRetryMs >= WIFI_RETRY_MS) {
    lastWifiRetryMs = now;
    Serial.println("[wifi] retrying home network");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// ── Arduino entry points ─────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nNather controller %s\n", FIRMWARE_VERSION);

  stateMutex = xSemaphoreCreateMutex();
  setupOutputs();
  for (uint8_t i = 0; i < ROOM_COUNT; i++) writeOutput(i);
  pinMode(PIR_PIN, INPUT_PULLDOWN);    // reads "no motion" if the sensor is unplugged

  prefs.begin("nather", false);
  loadEntry();

  if (!LittleFS.begin(true)) Serial.println("[fs] LittleFS mount failed");
  else if (!LittleFS.exists("/index.html")) Serial.println("[fs] website missing: run `pio run -t uploadfs`");

  startWifi();

  if (MDNS.begin(DEVICE_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.printf("[mdns] http://%s.local\n", DEVICE_HOSTNAME);
  }

  setupServer();
  Serial.printf("[pir] warming up for %u s\n", (unsigned)(PIR_WARMUP_MS / 1000));
}

void loop() {
  const uint32_t now = millis();
  readPir(now);
  readLight(now);
  checkAutoOff(now);
  maintainWifi(now);
  pushState(now);
  delay(10);
}
