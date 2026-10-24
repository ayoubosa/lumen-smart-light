#pragma once
// ─────────────────────────────────────────────────────────────
//  Nather controller — hardware and behaviour settings.
//  Match the pin map to how your board is wired (docs/WIRING.md).
//  The browser demo uses the same defaults (web/js/engine.js).
// ─────────────────────────────────────────────────────────────

#include <stdint.h>

#define FIRMWARE_VERSION "1.0.0"

// The board answers as http://nather.local (mDNS) and uses this
// name as its DHCP hostname, so it shows up by name in the router.
#define DEVICE_HOSTNAME "nather"

// ── Sensors ──────────────────────────────────────────────────
// HC-SR501 PIR output. It drives 3.3 V, so it connects straight to a GPIO.
#define PIR_PIN 27
// The HC-SR501 gives false triggers for up to ~60 s after power-on.
#define PIR_WARMUP_MS 30000

// LDR + 10 kΩ divider. Must be an ADC1 pin (GPIO 32–39): ADC2 cannot be
// read while Wi-Fi is on. Set to -1 if no light sensor is fitted.
#define LDR_PIN 34
// Ambient light % below which motion is allowed to switch lights on.
#define DARK_THRESHOLD 30
#define LDR_READ_MS 1000

// ── Behaviour ────────────────────────────────────────────────
#define DEFAULT_ON_BRIGHTNESS 50   // first switch-on of a room
#define ENTRY_BRIGHTNESS 70        // rooms switched on by motion
#define AUTO_OFF_SECONDS 300       // motion-lit rooms go off after 5 min of stillness; 0 = never

// ── Outputs ──────────────────────────────────────────────────
// 5 kHz is above visible flicker and within what LED MOSFET drivers handle well.
#define PWM_FREQ_HZ 5000
#define PWM_BITS 8
// Common blue relay boards switch ON when IN is pulled LOW.
#define RELAY_ACTIVE_LOW true

enum class Hw : uint8_t { None, Pwm, Relay };

struct RoomConfig {
  const char* id;
  Hw hw;
  int8_t pin;   // -1 = no hardware, state is still tracked
};

// Reference board: one dimmable LED and a 2-channel relay module.
static const RoomConfig ROOMS[] = {
  {"living",   Hw::Pwm,   25},
  {"bedroom",  Hw::Relay, 26},
  {"kitchen",  Hw::Relay, 33},
  {"bathroom", Hw::None,  -1},
  {"hallway",  Hw::None,  -1},
  {"garage",   Hw::None,  -1},
};
static const uint8_t ROOM_COUNT = sizeof(ROOMS) / sizeof(ROOMS[0]);

// ── Network ──────────────────────────────────────────────────
#define WIFI_CONNECT_TIMEOUT_MS 15000
// If the home Wi-Fi cannot be joined, the board opens its own hotspot
// so it is still reachable at http://192.168.4.1
#define AP_SSID "Nather-Setup"
#define STATE_PUSH_MIN_MS 100      // coalesce bursts (e.g. dragging the dial)
#define HEARTBEAT_MS 10000         // push state even when nothing changed
#define MAX_BODY_BYTES 512
