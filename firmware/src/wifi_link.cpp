#include "wifi_link.h"

#include <Arduino.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <atomic>
#include <cstring>

#include "config.h"
#include "credentials.h"
#include "wifi_policy.h"

// All radio work happens on the loop task. The Wi-Fi event callback runs on
// another task, so it only queues the event.

namespace {

const char* kTag = "wifi";
constexpr uint8_t kQueueLength = 8;
constexpr uint32_t kScanMsPerChannel = 100;      // short dwell so hotspot clients stay connected
constexpr uint32_t kSelfDisconnectWindowMs = 1'000;
constexpr uint8_t kReasonAssocLeave = 8;         // what our own disconnect() reports

enum class EventType : uint8_t { GotIp, Disconnected };
struct Event {
  EventType type;
  uint8_t reason;
};

struct Pin {
  uint8_t bssid[6] = {};
  uint8_t channel = 0;
  bool valid() const { return channel != 0; }
};

QueueHandle_t events;
wifi::Policy policy;
Preferences store;
Pin cached;        // from flash: where the router was last time
Pin scanned;       // from the latest scan while the hotspot was up
std::atomic<bool> hotspotOn{false};
uint32_t selfDisconnectAt = 0;

void loadPin() {
  store.begin("wifi", false);
  if (store.getBytes("bssid", cached.bssid, sizeof cached.bssid) == sizeof cached.bssid) {
    cached.channel = store.getUChar("ch", 0);
  }
}

void savePin() {
  Pin now;
  memcpy(now.bssid, WiFi.BSSID(), sizeof now.bssid);
  now.channel = WiFi.channel();
  if (now.channel == cached.channel && memcmp(now.bssid, cached.bssid, sizeof now.bssid) == 0) return;
  store.putBytes("bssid", now.bssid, sizeof now.bssid);
  store.putUChar("ch", now.channel);
  cached = now;
}

void forgetPin() {
  store.remove("bssid");
  store.remove("ch");
  cached = Pin{};
}

void restartMdns() {
  MDNS.end();
  if (MDNS.begin(config::kHostname)) MDNS.addService("http", "tcp", config::kHttpPort);
}

void connect(const Pin* pin, uint32_t now) {
  if (WiFi.status() != WL_DISCONNECTED && WiFi.status() != WL_IDLE_STATUS) {
    selfDisconnectAt = now;
    WiFi.disconnect();
  }
  if (pin && pin->valid()) {
    ESP_LOGI(kTag, "joining \"%s\" on channel %u", WIFI_SSID, pin->channel);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD, pin->channel, pin->bssid);
  } else {
    ESP_LOGI(kTag, "joining \"%s\"", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

void openHotspot() {
  const uint8_t channel = cached.valid() ? cached.channel : 1;   // the router's channel, so joining it later needs no hop
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(config::kHotspotSsid, AP_PASSWORD, channel);
  hotspotOn = true;
  ESP_LOGW(kTag, "no home network, hotspot \"%s\" at %s", config::kHotspotSsid, WiFi.softAPIP().toString().c_str());
}

void closeHotspot() {
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  hotspotOn = false;
  ESP_LOGI(kTag, "hotspot closed");
}

void apply(const wifi::Actions& a, uint32_t now) {
  if (a.forgetPin) forgetPin();
  if (a.openHotspot) openHotspot();
  if (a.connect) connect(a.useScanResult ? &scanned : a.usePin ? &cached : nullptr, now);
  if (a.startScan) WiFi.scanNetworks(true, false, false, kScanMsPerChannel);
  if (a.savePin) savePin();
  if (a.closeHotspot) closeHotspot();
  if (a.restartMdns) restartMdns();
}

// Returns true if the home network was in the finished scan, and records where.
bool readScan() {
  const int16_t count = WiFi.scanComplete();
  bool found = false;
  for (int16_t i = 0; i < count && !found; i++) {
    if (WiFi.SSID(i) != WIFI_SSID) continue;
    memcpy(scanned.bssid, WiFi.BSSID(i), sizeof scanned.bssid);
    scanned.channel = WiFi.channel(i);
    found = true;
  }
  WiFi.scanDelete();
  return found;
}

}  // namespace

void wifiBegin() {
  events = xQueueCreate(kQueueLength, sizeof(Event));
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    Event e{};
    if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
      e.type = EventType::GotIp;
    } else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      e.type = EventType::Disconnected;
      e.reason = info.wifi_sta_disconnected.reason;
    } else {
      return;
    }
    xQueueSend(events, &e, 0);
  });

  WiFi.persistent(false);          // credentials come from secrets.h; don't rewrite flash on every begin()
  WiFi.setAutoReconnect(false);    // wifi_policy decides when to retry
  WiFi.setHostname(config::kHostname);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);            // modem sleep delays every reply noticeably
  restartMdns();                   // answers on whichever interface comes up first

  loadPin();
  apply(policy.start(millis(), cached.valid()), millis());
}

void wifiPoll(uint32_t now) {
  Event e;
  while (xQueueReceive(events, &e, 0) == pdTRUE) {
    if (e.type == EventType::GotIp) {
      ESP_LOGI(kTag, "online  ip %s  gateway %s  rssi %d dBm  channel %d",
               WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(),
               WiFi.RSSI(), WiFi.channel());
      apply(policy.gotIp(now), now);
      continue;
    }
    if (e.reason == kReasonAssocLeave && now - selfDisconnectAt < kSelfDisconnectWindowMs) continue;
    ESP_LOGW(kTag, "disconnected, reason %u", e.reason);
    apply(policy.disconnected(now), now);
  }

  if (WiFi.scanComplete() >= 0) {
    const bool found = readScan();
    ESP_LOGI(kTag, "scan: home network %s", found ? "found" : "not found");
    apply(policy.scanFinished(found, now), now);
  }

  apply(policy.tick(now, hotspotOn ? WiFi.softAPgetStationNum() : 0), now);
}

bool wifiHotspotOn() {
  return hotspotOn;
}
