// Lumen controller: ESP32 firmware for the smart-light project.
// See README.md for the hardware and docs/API.md for the HTTP contract.

#include <Arduino.h>
#include <LittleFS.h>

#include "board.h"
#include "config.h"
#include "http_api.h"
#include "lights.h"
#include "wifi_link.h"

static const char* kTag = "main";
static constexpr uint32_t kLoopDelayMs = 10;

static Lights lights(outputWrite);

void setup() {
  Serial.begin(115200);
  ESP_LOGI(kTag, "Lumen controller %s", config::kFirmwareVersion);

  outputsBegin();
  sensorsBegin();
  settingsBegin(lights);

  if (!LittleFS.begin(true)) {
    ESP_LOGE(kTag, "LittleFS mount failed");
  } else if (!LittleFS.exists("/index.html")) {
    ESP_LOGW(kTag, "website missing, run: pio run -t uploadfs");
  }

  // Does not wait for the connection: the web server and sensors start straight away.
  wifiBegin();
  apiBegin(lights);
}

void loop() {
  const uint32_t now = millis();
  wifiPoll(now);
  sensorsPoll(lights, now);
  settingsPoll(lights);
  apiPoll(now);
  delay(kLoopDelayMs);
}
