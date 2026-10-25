#include "http_api.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <esp_timer.h>
#include <atomic>
#include <cstring>

#include "config.h"
#include "credentials.h"
#include "lights.h"
#include "wifi_link.h"

namespace {

const char* kTag = "api";
constexpr size_t kStateJsonBytes = 1536;
constexpr const char* kRoomsPrefix = "/api/rooms/";

AsyncWebServer server(config::kHttpPort);
AsyncEventSource events("/api/events");
Lights* lights = nullptr;
bool pushPending = true;
// Counted on the loop task only: calling events.count() from the connect
// callback would take the event source's lock while it is already held.
std::atomic<size_t> clientCount{0};
uint32_t lastPushMs = 0;

const char* hwName(config::Hw hw) {
  switch (hw) {
    case config::Hw::Pwm: return "pwm";
    case config::Hw::Relay: return "relay";
    default: return "none";
  }
}

int findRoom(const char* id) {
  for (uint8_t i = 0; i < config::kRoomCount; i++) {
    if (strcmp(id, config::kRooms[i].id) == 0) return i;
  }
  return -1;
}

void writeRoom(JsonObject out, uint8_t i, const RoomState& r) {
  out["on"] = r.on();
  out["brightness"] = r.brightness;
  out["hw"] = hwName(config::kRooms[i].hw);
  out["pin"] = config::kRooms[i].pin;
  out["auto"] = r.byMotion;
}

size_t writeState(char* buf, size_t size) {
  const uint32_t now = millis();
  const Snapshot s = lights->snapshot(now);
  const bool hotspot = wifiHotspotOn();

  JsonDocument doc;
  doc["mode"] = s.mode == Mode::Auto ? "auto" : "manual";

  JsonObject device = doc["device"].to<JsonObject>();
  device["name"] = config::kHostname;
  device["hostname"] = String(config::kHostname) + ".local";
  device["fw"] = config::kFirmwareVersion;
  device["mode"] = hotspot && WiFi.status() != WL_CONNECTED ? "ap" : "sta";
  device["ip"] = (WiFi.status() == WL_CONNECTED ? WiFi.localIP() : WiFi.softAPIP()).toString();
  device["mac"] = WiFi.macAddress();
  if (WiFi.status() == WL_CONNECTED) {
    device["ssid"] = WiFi.SSID();
    device["rssi"] = WiFi.RSSI();
  } else {
    device["ssid"] = hotspot ? config::kHotspotSsid : "";
    device["rssi"] = nullptr;
  }
  device["channel"] = WiFi.channel();
  device["uptime"] = uint32_t(esp_timer_get_time() / 1'000'000);
  device["heap"] = ESP.getFreeHeap();
  device["clients"] = clientCount.load();
  device["auth"] = API_TOKEN[0] != '\0';
  device["simulated"] = false;

  JsonObject rooms = doc["rooms"].to<JsonObject>();
  JsonArray entry = doc["entryRooms"].to<JsonArray>();
  for (uint8_t i = 0; i < config::kRoomCount; i++) {
    writeRoom(rooms[config::kRooms[i].id].to<JsonObject>(), i, s.rooms[i]);
    if (s.entryMask & (1u << i)) entry.add(config::kRooms[i].id);
  }

  JsonObject sensors = doc["sensors"].to<JsonObject>();
  sensors["motion"] = s.motion;
  if (s.sawMotion) sensors["lastMotionAgo"] = s.msSinceMotion / 1000;
  else sensors["lastMotionAgo"] = nullptr;
  if (s.lightPct >= 0) sensors["light"] = s.lightPct;
  else sensors["light"] = nullptr;
  sensors["dark"] = s.dark;

  return serializeJson(doc, buf, size);
}

void sendJson(AsyncWebServerRequest* req, int code, const char* body) {
  AsyncWebServerResponse* res = req->beginResponse(code, "application/json", body);
  res->addHeader("Cache-Control", "no-store");
  req->send(res);
}

void sendError(AsyncWebServerRequest* req, int code, const char* message) {
  JsonDocument doc;
  doc["error"] = message;
  char buf[160];
  serializeJson(doc, buf, sizeof buf);
  sendJson(req, code, buf);
}

void sendDoc(AsyncWebServerRequest* req, const JsonDocument& doc) {
  char buf[256];
  serializeJson(doc, buf, sizeof buf);
  sendJson(req, 200, buf);
}

bool authorised(AsyncWebServerRequest* req) {
  if (API_TOKEN[0] == '\0') return true;
  const AsyncWebHeader* h = req->getHeader("Authorization");
  if (!h) return false;
  const char* value = h->value().c_str();
  return strncmp(value, "Bearer ", 7) == 0 && strcmp(value + 7, API_TOKEN) == 0;
}

// The server frees _tempObject with the request.
void collectBody(AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t index, size_t total) {
  if (total > config::kMaxBodyBytes) return;
  if (index == 0) req->_tempObject = malloc(total + 1);
  if (!req->_tempObject) return;
  memcpy(static_cast<uint8_t*>(req->_tempObject) + index, data, len);
  if (index + len == total) static_cast<char*>(req->_tempObject)[total] = '\0';
}

// Auth, size and JSON checks shared by every write. Sends the error itself.
bool parseAuthorizedBody(AsyncWebServerRequest* req, JsonDocument& body) {
  if (!authorised(req)) {
    sendError(req, 401, "Missing or wrong API token");
    return false;
  }
  if (req->contentLength() > config::kMaxBodyBytes) {
    sendError(req, 413, "Body too large");
    return false;
  }
  if (!req->_tempObject || deserializeJson(body, static_cast<const char*>(req->_tempObject))) {
    sendError(req, 400, "Body is not valid JSON");
    return false;
  }
  return true;
}

void handleRoom(AsyncWebServerRequest* req) {
  JsonDocument body;
  if (!parseAuthorizedBody(req, body)) return;

  const String url = req->url();
  const int room = findRoom(url.c_str() + strlen(kRoomsPrefix));
  if (room < 0) return sendError(req, 404, "Unknown room");

  Result result;
  if (!body["brightness"].isNull()) {
    if (!body["brightness"].is<float>()) return sendError(req, 400, "brightness must be a number from 0 to 100");
    result = lights->setBrightness(room, body["brightness"].as<float>());
  } else if (!body["on"].isNull()) {
    if (!body["on"].is<bool>()) return sendError(req, 400, "on must be true or false");
    result = lights->setOn(room, body["on"].as<bool>());
  } else {
    return sendError(req, 400, "Send on or brightness");
  }
  if (result == Result::BadValue) return sendError(req, 400, "brightness must be a number from 0 to 100");

  JsonDocument out;
  writeRoom(out.to<JsonObject>(), room, lights->snapshot(millis()).rooms[room]);
  sendDoc(req, out);
  ESP_LOGI(kTag, "%s -> %s from %s", config::kRooms[room].id, body["brightness"].isNull() ? "on/off" : "brightness",
           req->client()->remoteIP().toString().c_str());
}

void handleEntryRooms(AsyncWebServerRequest* req) {
  JsonDocument body;
  if (!parseAuthorizedBody(req, body)) return;
  JsonArrayConst list = body["rooms"];
  if (list.isNull()) return sendError(req, 400, "rooms must be an array of room ids");

  uint16_t mask = 0;
  for (JsonVariantConst v : list) {
    const int room = v.is<const char*>() ? findRoom(v.as<const char*>()) : -1;
    if (room < 0) return sendError(req, 400, "Unknown room in rooms");
    mask |= 1u << room;
  }
  lights->setEntryRooms(mask);

  JsonDocument out;
  JsonArray rooms = out["rooms"].to<JsonArray>();
  for (uint8_t i = 0; i < config::kRoomCount; i++) {
    if (mask & (1u << i)) rooms.add(config::kRooms[i].id);
  }
  sendDoc(req, out);
}

void handleMode(AsyncWebServerRequest* req) {
  JsonDocument body;
  if (!parseAuthorizedBody(req, body)) return;
  const char* mode = body["mode"] | "";
  if (strcmp(mode, "auto") != 0 && strcmp(mode, "manual") != 0) {
    return sendError(req, 400, "mode must be \"auto\" or \"manual\"");
  }
  lights->setMode(strcmp(mode, "auto") == 0 ? Mode::Auto : Mode::Manual);
  JsonDocument out;
  out["mode"] = mode;
  sendDoc(req, out);
}

void handleState(AsyncWebServerRequest* req) {
  char buf[kStateJsonBytes];
  writeState(buf, sizeof buf);
  sendJson(req, 200, buf);
}

}  // namespace

void apiBegin(Lights& l) {
  lights = &l;

  // Lets a dashboard served from another machine on the LAN call the API.
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  server.on("/api/state", HTTP_GET, handleState);
  server.on("/api/rooms/*", HTTP_PUT, handleRoom, nullptr, collectBody);
  server.on("/api/entry-rooms", HTTP_PUT, handleEntryRooms, nullptr, collectBody);
  server.on("/api/mode", HTTP_PUT, handleMode, nullptr, collectBody);

  events.onConnect([](AsyncEventSourceClient* client) {
    char buf[kStateJsonBytes];
    writeState(buf, sizeof buf);
    client->send(buf, "state", millis(), config::kSseRetryMs);
  });
  server.addHandler(&events);

  // Images rarely change; pages and scripts must match the firmware, so they always revalidate.
  server.serveStatic("/img/", LittleFS, "/img/").setCacheControl("max-age=86400");
  server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html").setCacheControl("no-cache");

  server.onNotFound([](AsyncWebServerRequest* req) {
    if (req->method() == HTTP_OPTIONS) return req->send(204);   // CORS preflight
    sendError(req, 404, "Not found");
  });

  server.begin();
}

void apiPoll(uint32_t now) {
  clientCount = events.count();
  pushPending |= lights->takeChanged();
  const uint32_t sinceLast = now - lastPushMs;
  const bool due = (pushPending && sinceLast >= config::kPushMinIntervalMs) || sinceLast >= config::kHeartbeatMs;
  if (!due) return;
  pushPending = false;
  lastPushMs = now;
  if (clientCount == 0) return;
  char buf[kStateJsonBytes];
  writeState(buf, sizeof buf);
  events.send(buf, "state", now);
}
