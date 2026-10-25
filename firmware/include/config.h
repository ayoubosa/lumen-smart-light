#pragma once
// Board wiring and behaviour. Pins follow docs/WIRING.md; the browser demo
// uses the same behaviour numbers (web/js/engine.js).
//
// Plain C++ only: this header is also compiled by the host unit tests.

#include <cstddef>
#include <cstdint>

namespace config {

constexpr const char* kFirmwareVersion = "1.1.0";
constexpr const char* kHostname = "nather";        // http://nather.local and the DHCP name

// Sensors
constexpr int kPirPin = 27;
constexpr uint32_t kPirWarmupMs = 30'000;          // HC-SR501 false-triggers while it settles
constexpr int kLdrPin = 34;                        // ADC1 only (ADC2 is unusable with Wi-Fi on); -1 = not fitted
constexpr int kDarkThresholdPct = 30;
constexpr uint32_t kLdrPeriodMs = 1'000;

// Lighting rules
constexpr uint8_t kDefaultOnBrightness = 50;
constexpr uint8_t kEntryBrightness = 70;
constexpr uint32_t kAutoOffMs = 5 * 60'000;        // 0 disables auto-off

// Outputs
constexpr uint32_t kPwmFrequencyHz = 5'000;
constexpr uint8_t kPwmResolutionBits = 8;
constexpr bool kRelayActiveLow = true;

enum class Hw : uint8_t { None, Pwm, Relay };

struct Room {
  const char* id;
  Hw hw;
  int8_t pin;                                      // -1: tracked but not wired
};

// Reference board: one dimmable LED and a two-channel relay module.
inline constexpr Room kRooms[] = {
  {"living",   Hw::Pwm,   25},
  {"bedroom",  Hw::Relay, 26},
  {"kitchen",  Hw::Relay, 33},
  {"bathroom", Hw::None,  -1},
  {"hallway",  Hw::None,  -1},
  {"garage",   Hw::None,  -1},
};
constexpr uint8_t kRoomCount = sizeof(kRooms) / sizeof(kRooms[0]);
static_assert(kRoomCount <= 16, "entry rooms are stored as a 16-bit mask");

// A set of rooms, one bit per room index.
using RoomMask = uint16_t;
constexpr RoomMask roomBit(uint8_t room) { return RoomMask(1u << room); }
constexpr RoomMask kAllRooms = RoomMask((1u << kRoomCount) - 1);

// Wi-Fi (retry backoff: 1, 2, 5, 10, 20, 30 s, then every 60 s; see wifi_policy.cpp)
constexpr const char* kHotspotSsid = "Nather-Setup";
constexpr uint32_t kWifiAttemptTimeoutMs = 15'000;
constexpr uint32_t kHotspotAfterBootMs = 30'000;   // never connected since power-on
constexpr uint32_t kHotspotAfterDropMs = 180'000;  // was online; most router reboots finish inside this
constexpr uint32_t kHotspotScanMs = 30'000;        // while the hotspot is up, look for home this often
constexpr uint32_t kScanTimeoutMs = 10'000;        // a scan that never reports back counts as "not found"
constexpr uint32_t kHotspotCloseAfterMs = 60'000;  // back online this long and nobody on the hotspot
constexpr uint32_t kHotspotCloseMaxMs = 600'000;   // close it after this long regardless

// HTTP
constexpr uint16_t kHttpPort = 80;
constexpr uint32_t kPushMinIntervalMs = 100;       // merge bursts, e.g. dragging a slider
constexpr uint32_t kHeartbeatMs = 10'000;
constexpr uint32_t kSseRetryMs = 2'000;
constexpr size_t kMaxBodyBytes = 512;

}  // namespace config
