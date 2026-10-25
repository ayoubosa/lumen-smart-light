#pragma once
// Decides what the Wi-Fi link should do next. Pure logic with no Arduino
// calls: wifi_link.cpp feeds it events and carries out the Actions, and
// test/test_wifi_policy drives it through outages on the host.

#include <cstdint>

#include "config.h"

namespace wifi {

enum class State : uint8_t { Connecting, Online, Waiting };

// Where to point begin(): let the radio scan, or go straight to a known
// access point (BSSID + channel), which skips the channel scan.
enum class JoinVia : uint8_t { Scan, CachedAp, ScanResult };

struct Actions {
  bool connect = false;            // disconnect() then begin()
  JoinVia via = JoinVia::Scan;
  bool forgetCachedAp = false;     // the saved BSSID/channel did not work
  bool saveCachedAp = false;       // connected: remember BSSID/channel for the next boot
  bool openHotspot = false;
  bool closeHotspot = false;
  bool startScan = false;          // look for the home network without leaving the hotspot
  bool restartMdns = false;

  Actions& operator|=(const Actions& o);
};

struct Timing {
  uint32_t attemptTimeoutMs = config::kWifiAttemptTimeoutMs;
  uint32_t hotspotAfterBootMs = config::kHotspotAfterBootMs;
  uint32_t hotspotAfterDropMs = config::kHotspotAfterDropMs;
  uint32_t scanEveryMs = config::kHotspotScanMs;
  uint32_t scanTimeoutMs = config::kScanTimeoutMs;
  uint32_t closeHotspotAfterMs = config::kHotspotCloseAfterMs;
  uint32_t closeHotspotAnywayMs = config::kHotspotCloseMaxMs;
};

class Policy {
 public:
  explicit Policy(Timing timing = {}) : t_(timing) {}

  Actions start(uint32_t now, bool haveCachedAp);
  Actions gotIp(uint32_t now);
  Actions disconnected(uint32_t now);
  Actions scanFinished(bool homeVisible, uint32_t now);
  Actions tick(uint32_t now, uint8_t hotspotClients);

  State state() const { return state_; }
  bool hotspotOn() const { return hotspotOn_; }
  uint8_t failures() const { return failures_; }

  static uint32_t backoffMs(uint8_t failures);

 private:
  Actions attempt(uint32_t now, JoinVia via);
  Actions failAttempt(uint32_t now);

  Timing t_;
  State state_ = State::Waiting;
  bool hotspotOn_ = false;
  bool everOnline_ = false;
  bool cachedAttempt_ = false;
  bool scanning_ = false;
  uint8_t failures_ = 0;
  uint32_t attemptStart_ = 0;
  uint32_t scanStart_ = 0;
  uint32_t offlineSince_ = 0;
  uint32_t onlineSince_ = 0;
  uint32_t waitStart_ = 0;
  uint32_t waitMs_ = 0;
};

}  // namespace wifi
