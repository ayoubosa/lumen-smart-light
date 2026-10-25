#include "lights.h"

#include <cmath>

using Lock = std::lock_guard<std::mutex>;

void Lights::write(uint8_t room, uint8_t brightness, bool byMotion) {
  RoomState& r = rooms_[room];
  r.byMotion = byMotion;
  if (r.brightness == brightness) return;
  r.brightness = brightness;
  if (brightness > 0) lastBrightness_[room] = brightness;
  if (output_) output_(room, brightness);
  changed_ = true;
}

Result Lights::setBrightness(uint8_t room, float pct) {
  if (room >= config::kRoomCount) return Result::UnknownRoom;
  if (!std::isfinite(pct)) return Result::BadValue;
  const long clamped = std::lround(pct < 0 ? 0 : pct > 100 ? 100 : pct);
  Lock lock(mutex_);
  write(room, static_cast<uint8_t>(clamped), false);
  changed_ = true;   // even if the value did not change, it is now manual
  return Result::Ok;
}

Result Lights::setOn(uint8_t room, bool on) {
  if (room >= config::kRoomCount) return Result::UnknownRoom;
  Lock lock(mutex_);
  const uint8_t current = rooms_[room].brightness;
  write(room, on ? (current ? current : lastBrightness_[room]) : 0, false);
  changed_ = true;
  return Result::Ok;
}

void Lights::setEntryRooms(uint16_t mask) {
  Lock lock(mutex_);
  entryMask_ = mask & ((1u << config::kRoomCount) - 1);
  changed_ = true;
}

void Lights::setMode(Mode mode) {
  Lock lock(mutex_);
  mode_ = mode;
  // Manual means nothing switches by itself, so hand motion-lit rooms to the user.
  if (mode == Mode::Manual) {
    for (RoomState& r : rooms_) r.byMotion = false;
  }
  changed_ = true;
}

void Lights::restore(uint16_t entryMask, Mode mode) {
  Lock lock(mutex_);
  entryMask_ = entryMask & ((1u << config::kRoomCount) - 1);
  mode_ = mode;
}

uint16_t Lights::onMotion(bool active, uint32_t now) {
  Lock lock(mutex_);
  uint16_t switched = 0;
  if (active != motion_) changed_ = true;
  motion_ = active;
  sawMotion_ = true;
  lastMotionMs_ = now;   // on both edges: auto-off counts from when movement stopped
  if (!active || mode_ != Mode::Auto || !dark()) return 0;
  for (uint8_t i = 0; i < config::kRoomCount; i++) {
    if ((entryMask_ & (1u << i)) && !rooms_[i].on()) {
      write(i, config::kEntryBrightness, true);
      switched |= 1u << i;
    }
  }
  return switched;
}

uint16_t Lights::tick(uint32_t now) {
  Lock lock(mutex_);
  if (config::kAutoOffMs == 0 || mode_ != Mode::Auto || motion_ || !sawMotion_) return 0;
  if (now - lastMotionMs_ < config::kAutoOffMs) return 0;
  uint16_t switched = 0;
  for (uint8_t i = 0; i < config::kRoomCount; i++) {
    if (rooms_[i].byMotion && rooms_[i].on()) {
      write(i, 0, false);
      switched |= 1u << i;
    }
  }
  return switched;
}

void Lights::onLight(int pct) {
  Lock lock(mutex_);
  if (pct == lightPct_) return;
  lightPct_ = pct;
  changed_ = true;
}

Snapshot Lights::snapshot(uint32_t now) const {
  Lock lock(mutex_);
  Snapshot s;
  s.rooms = rooms_;
  s.entryMask = entryMask_;
  s.mode = mode_;
  s.motion = motion_;
  s.sawMotion = sawMotion_;
  s.msSinceMotion = sawMotion_ ? now - lastMotionMs_ : 0;
  s.lightPct = lightPct_;
  s.dark = dark();
  return s;
}

uint16_t Lights::entryMask() const {
  Lock lock(mutex_);
  return entryMask_;
}

Mode Lights::mode() const {
  Lock lock(mutex_);
  return mode_;
}
