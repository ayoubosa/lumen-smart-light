#include "board.h"

#include <Arduino.h>
#include <Preferences.h>
#include <cmath>
#include <cstdlib>

#include "config.h"
#include "lights.h"

static const char* kTag = "board";

// Outputs

void outputsBegin() {
  for (uint8_t i = 0; i < config::kRoomCount; i++) {
    const config::Room& room = config::kRooms[i];
    if (room.pin < 0) continue;
    if (room.hw == config::Hw::Relay) {
      // Set the "off" level before the pin becomes an output, or the relay clicks on at boot.
      digitalWrite(room.pin, config::kRelayActiveLow ? HIGH : LOW);
      pinMode(room.pin, OUTPUT);
    } else if (room.hw == config::Hw::Pwm) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
      ledcAttach(room.pin, config::kPwmFrequencyHz, config::kPwmResolutionBits);
#else
      ledcSetup(i, config::kPwmFrequencyHz, config::kPwmResolutionBits);
      ledcAttachPin(room.pin, i);
#endif
    }
    outputWrite(i, 0);
  }
}

void outputWrite(uint8_t room, uint8_t brightness) {
  const config::Room& r = config::kRooms[room];
  if (r.pin < 0) return;
  if (r.hw == config::Hw::Relay) {
    const bool on = brightness > 0;
    digitalWrite(r.pin, on != config::kRelayActiveLow ? HIGH : LOW);
    return;
  }
  // Perceptual (gamma 2.2) curve, so 50 % on the slider looks like half brightness.
  constexpr uint32_t kMaxDuty = (1u << config::kPwmResolutionBits) - 1;
  uint32_t duty = std::lround(std::pow(brightness / 100.0f, 2.2f) * kMaxDuty);
  if (brightness > 0 && duty == 0) duty = 1;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(r.pin, duty);
#else
  ledcWrite(room, duty);
#endif
}

// Sensors

namespace {
constexpr int kAdcMax = 4095;
constexpr float kLightSmoothing = 0.2f;   // weight of each new reading
constexpr int kLightHysteresisPct = 2;    // ignore smaller changes (flicker, ADC noise)

bool pirReady = false;
bool pirLevel = false;
uint32_t bootMs = 0;
uint32_t lastLightReadMs = 0;
float lightAvg = -1;
int lightReported = -1;
}  // namespace

void sensorsBegin() {
  pinMode(config::kPirPin, INPUT_PULLDOWN);   // reads "no motion" if the sensor is unplugged
  bootMs = millis();
  ESP_LOGI(kTag, "PIR warming up for %u s", unsigned(config::kPirWarmupMs / 1000));
}

void sensorsPoll(Lights& lights, uint32_t now) {
  if (!pirReady && now - bootMs >= config::kPirWarmupMs) pirReady = true;
  if (pirReady) {
    const bool level = digitalRead(config::kPirPin) == HIGH;
    if (level != pirLevel) {
      pirLevel = level;
      const uint16_t switched = lights.onMotion(level, now);
      ESP_LOGI(kTag, "motion %s, switched on 0x%02x", level ? "start" : "end", switched);
    }
  }

  const uint16_t switchedOff = lights.tick(now);
  if (switchedOff) ESP_LOGI(kTag, "auto-off 0x%02x", switchedOff);

  if constexpr (config::kLdrPin >= 0) {
    if (now - lastLightReadMs < config::kLdrPeriodMs) return;
    lastLightReadMs = now;
    const float pct = analogRead(config::kLdrPin) * 100.0f / kAdcMax;
    lightAvg = lightAvg < 0 ? pct : lightAvg + kLightSmoothing * (pct - lightAvg);
    const int rounded = std::lround(lightAvg);
    if (lightReported < 0 || std::abs(rounded - lightReported) >= kLightHysteresisPct) {
      lightReported = rounded;
      lights.onLight(rounded);
    }
  }
}

// Settings: only the entry rooms and the mode survive a reboot. Lights come
// back off after a power cut, on purpose.

namespace {
Preferences prefs;
uint16_t savedEntryMask = 0;
bool savedAuto = true;
}  // namespace

void settingsBegin(Lights& lights) {
  prefs.begin("nather", false);
  savedEntryMask = prefs.getUShort("entry", 0);
  savedAuto = prefs.getBool("auto", true);
  lights.restore(savedEntryMask, savedAuto ? Mode::Auto : Mode::Manual);
}

void settingsPoll(const Lights& lights) {
  const uint16_t mask = lights.entryMask();
  const bool isAuto = lights.mode() == Mode::Auto;
  if (mask != savedEntryMask) {
    prefs.putUShort("entry", mask);
    savedEntryMask = mask;
  }
  if (isAuto != savedAuto) {
    prefs.putBool("auto", isAuto);
    savedAuto = isAuto;
  }
}
