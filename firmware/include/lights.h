#pragma once
// Room state and the lighting rules. Same behaviour as web/js/engine.js.
// No Arduino code here, so the host tests can run it (test/test_lights).

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>

#include "config.h"

enum class Mode : uint8_t { Auto, Manual };
enum class Result : uint8_t { Ok, UnknownRoom, BadValue };

struct RoomState {
  uint8_t brightness = 0;          // 0 = off
  bool byMotion = false;           // switched on by the PIR; auto-off may switch it off
  bool on() const { return brightness > 0; }
};

struct Snapshot {
  std::array<RoomState, config::kRoomCount> rooms{};
  config::RoomMask entryMask = 0;
  Mode mode = Mode::Auto;
  bool motion = false;
  bool sawMotion = false;
  uint32_t msSinceMotion = 0;
  int lightPct = -1;               // -1 = no light sensor
  bool dark = true;
};

class Lights {
 public:
  // Called with the lock held whenever a room's brightness changes. Keep it fast.
  using Output = void (*)(uint8_t room, uint8_t brightness);

  explicit Lights(Output output) : output_(output) { lastBrightness_.fill(config::kDefaultOnBrightness); }

  Result setBrightness(uint8_t room, float pct);
  Result setOn(uint8_t room, bool on);
  void setEntryRooms(config::RoomMask rooms);
  void setMode(Mode mode);
  void restore(config::RoomMask entryRooms, Mode mode);

  // Return the rooms they switched, for logging.
  config::RoomMask onMotion(bool active, uint32_t now);
  config::RoomMask tick(uint32_t now);

  void onLight(int pct);

  Snapshot snapshot(uint32_t now) const;
  config::RoomMask entryMask() const;
  Mode mode() const;

  // True once after any change; the HTTP layer uses it to push state.
  bool takeChanged() { return changed_.exchange(false); }

 private:
  void write(uint8_t room, uint8_t brightness, bool byMotion);
  bool dark() const { return lightPct_ < config::kDarkThresholdPct; }   // -1 (no sensor) counts as dark

  mutable std::mutex mutex_;
  std::array<RoomState, config::kRoomCount> rooms_{};
  std::array<uint8_t, config::kRoomCount> lastBrightness_{};
  config::RoomMask entryMask_ = 0;
  Mode mode_ = Mode::Auto;
  bool motion_ = false;
  bool sawMotion_ = false;
  uint32_t lastMotionMs_ = 0;      // last time motion was seen, start or end
  int lightPct_ = -1;
  std::atomic<bool> changed_{true};
  Output output_;
};
