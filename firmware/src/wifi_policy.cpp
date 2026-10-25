#include "wifi_policy.h"

namespace wifi {

namespace {
constexpr uint32_t kBackoffMs[] = {1'000, 2'000, 5'000, 10'000, 20'000, 30'000, 60'000};
constexpr uint8_t kBackoffSteps = sizeof(kBackoffMs) / sizeof(kBackoffMs[0]);
}  // namespace

uint32_t Policy::backoffMs(uint8_t failures) {
  return kBackoffMs[failures < kBackoffSteps ? failures : kBackoffSteps - 1];
}

Actions Policy::attempt(uint32_t now, bool pinned, bool fromScan) {
  Actions a;
  a.connect = true;
  a.usePin = pinned;
  a.useScanResult = fromScan;
  state_ = State::Connecting;
  pinnedAttempt_ = pinned;
  attemptStart_ = now;
  return a;
}

Actions Policy::start(uint32_t now, bool havePin) {
  offlineSince_ = now;
  return attempt(now, havePin, false);
}

Actions Policy::gotIp(uint32_t now) {
  Actions a;
  a.savePin = true;
  a.restartMdns = everOnline_ || hotspotOn_;   // the first time, wifiBegin() has just started mDNS
  state_ = State::Online;
  everOnline_ = true;
  failures_ = 0;
  onlineSince_ = now;
  return a;
}

Actions Policy::failAttempt(uint32_t now) {
  Actions a;
  if (pinnedAttempt_) {
    // The router may have changed channel or BSSID: forget the pin and scan normally, straight away.
    a = attempt(now, false, false);
    a.forgetPin = true;
    return a;
  }
  state_ = State::Waiting;
  waitStart_ = now;
  waitMs_ = hotspotOn_ ? t_.scanEveryMs : backoffMs(failures_);
  if (failures_ < 255) failures_++;
  return a;
}

Actions Policy::disconnected(uint32_t now) {
  if (state_ == State::Online) {
    offlineSince_ = now;
    failures_ = 0;
    pinnedAttempt_ = false;
    state_ = State::Connecting;   // fall through as a failed attempt so the backoff starts at 1 s
  }
  if (state_ != State::Connecting) return {};
  return failAttempt(now);
}

Actions Policy::scanFinished(bool homeVisible, uint32_t now) {
  scanning_ = false;
  if (state_ != State::Waiting) return {};
  if (homeVisible) return attempt(now, false, true);
  waitStart_ = now;
  waitMs_ = t_.scanEveryMs;
  return {};
}

Actions Policy::tick(uint32_t now, uint8_t hotspotClients) {
  Actions a;

  if (scanning_ && now - scanStart_ >= t_.scanTimeoutMs) a = scanFinished(false, now);

  if (state_ == State::Connecting && now - attemptStart_ >= t_.attemptTimeoutMs) {
    a = failAttempt(now);   // no event arrived: treat it as a failure
  }

  if (state_ != State::Online && !hotspotOn_) {
    const uint32_t limit = everOnline_ ? t_.hotspotAfterDropMs : t_.hotspotAfterBootMs;
    if (now - offlineSince_ >= limit) {
      hotspotOn_ = true;
      a.openHotspot = true;
      a.restartMdns = true;
      // From now on look before connecting: a blind attempt makes the radio hop
      // channels and drops phones that are on the hotspot.
      if (state_ == State::Waiting) {
        waitStart_ = now;
        waitMs_ = 0;
      }
    }
  }

  if (state_ == State::Waiting && !scanning_ && now - waitStart_ >= waitMs_) {
    if (hotspotOn_) {
      scanning_ = true;
      scanStart_ = now;
      a.startScan = true;
    } else {
      const Actions next = attempt(now, false, false);
      a.connect = next.connect;
    }
  }

  if (state_ == State::Online && hotspotOn_) {
    const uint32_t up = now - onlineSince_;
    if ((up >= t_.closeHotspotAfterMs && hotspotClients == 0) || up >= t_.closeHotspotAnywayMs) {
      hotspotOn_ = false;
      a.closeHotspot = true;
    }
  }

  return a;
}

}  // namespace wifi
