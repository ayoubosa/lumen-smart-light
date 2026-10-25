// Host tests for the lighting rules. Mirrors tools/test/engine.test.cjs.
#include <unity.h>

#include <cmath>

#include "lights.h"

namespace {

uint8_t written[config::kRoomCount];
int writes = 0;

void record(uint8_t room, uint8_t brightness) {
  written[room] = brightness;
  writes++;
}

constexpr uint8_t kLiving = 0, kBedroom = 1, kHallway = 4, kGarage = 5;
constexpr uint16_t bit(uint8_t room) { return 1u << room; }

}  // namespace

void setUp() {
  for (auto& w : written) w = 0;
  writes = 0;
}
void tearDown() {}

void brightness_sets_level_and_zero_means_off() {
  Lights l(record);
  TEST_ASSERT_TRUE(l.setBrightness(kLiving, 40) == Result::Ok);
  TEST_ASSERT_EQUAL_UINT8(40, written[kLiving]);
  TEST_ASSERT_TRUE(l.snapshot(0).rooms[kLiving].on());
  l.setBrightness(kLiving, 0);
  TEST_ASSERT_FALSE(l.snapshot(0).rooms[kLiving].on());
}

void brightness_is_clamped_and_rounded() {
  Lights l(record);
  l.setBrightness(kLiving, 140);
  TEST_ASSERT_EQUAL_UINT8(100, written[kLiving]);
  l.setBrightness(kLiving, -5);
  TEST_ASSERT_EQUAL_UINT8(0, written[kLiving]);
  l.setBrightness(kLiving, 33.6f);
  TEST_ASSERT_EQUAL_UINT8(34, written[kLiving]);
}

void bad_input_is_rejected() {
  Lights l(record);
  TEST_ASSERT_TRUE(l.setOn(config::kRoomCount, true) == Result::UnknownRoom);
  TEST_ASSERT_TRUE(l.setBrightness(kLiving, std::nanf("")) == Result::BadValue);
  TEST_ASSERT_EQUAL(0, writes);
}

void switching_on_restores_last_brightness() {
  Lights l(record);
  l.setOn(kBedroom, true);
  TEST_ASSERT_EQUAL_UINT8(config::kDefaultOnBrightness, written[kBedroom]);
  l.setBrightness(kBedroom, 80);
  l.setOn(kBedroom, false);
  l.setOn(kBedroom, true);
  TEST_ASSERT_EQUAL_UINT8(80, written[kBedroom]);
}

void unchanged_value_does_not_rewrite_the_output() {
  Lights l(record);
  l.setBrightness(kLiving, 60);
  const int before = writes;
  l.setBrightness(kLiving, 60);
  TEST_ASSERT_EQUAL(before, writes);
}

void motion_switches_entry_rooms_when_dark() {
  Lights l(record);
  l.setEntryRooms(bit(kHallway) | bit(kLiving));
  l.onLight(80);
  TEST_ASSERT_EQUAL_UINT16(0, l.onMotion(true, 1000));
  l.onMotion(false, 2000);
  l.onLight(10);
  TEST_ASSERT_EQUAL_UINT16(bit(kHallway) | bit(kLiving), l.onMotion(true, 3000));
  TEST_ASSERT_EQUAL_UINT8(config::kEntryBrightness, written[kHallway]);
  TEST_ASSERT_TRUE(l.snapshot(3000).rooms[kHallway].byMotion);
}

void dark_means_below_the_threshold() {
  Lights l(record);
  l.setEntryRooms(bit(kHallway));
  l.onLight(config::kDarkThresholdPct);
  TEST_ASSERT_EQUAL_UINT16(0, l.onMotion(true, 0));
  l.onMotion(false, 0);
  l.onLight(config::kDarkThresholdPct - 1);
  TEST_ASSERT_EQUAL_UINT16(bit(kHallway), l.onMotion(true, 0));
}

void no_light_sensor_counts_as_dark() {
  Lights l(record);
  l.setEntryRooms(bit(kGarage));
  TEST_ASSERT_EQUAL_UINT16(bit(kGarage), l.onMotion(true, 0));
}

void motion_leaves_a_room_that_is_already_on() {
  Lights l(record);
  l.setEntryRooms(bit(kLiving));
  l.setBrightness(kLiving, 20);
  TEST_ASSERT_EQUAL_UINT16(0, l.onMotion(true, 0));
  TEST_ASSERT_EQUAL_UINT8(20, written[kLiving]);
}

void auto_off_switches_only_motion_lit_rooms() {
  Lights l(record);
  l.setEntryRooms(bit(kHallway));
  l.setOn(kBedroom, true);
  l.onMotion(true, 0);
  l.onMotion(false, 1000);
  TEST_ASSERT_EQUAL_UINT16(0, l.tick(1000 + config::kAutoOffMs - 1));
  TEST_ASSERT_EQUAL_UINT16(bit(kHallway), l.tick(1000 + config::kAutoOffMs));
  TEST_ASSERT_TRUE(l.snapshot(0).rooms[kBedroom].on());
}

// The bug the review found: the timer used to start when motion began.
void auto_off_counts_from_when_movement_stopped() {
  Lights l(record);
  l.setEntryRooms(bit(kHallway));
  l.onMotion(true, 0);
  const uint32_t stopped = config::kAutoOffMs + 60'000;   // someone moved for longer than the timeout
  l.onMotion(false, stopped);
  TEST_ASSERT_EQUAL_UINT16(0, l.tick(stopped + 1));
  TEST_ASSERT_EQUAL_UINT16(bit(kHallway), l.tick(stopped + config::kAutoOffMs));
}

void auto_off_waits_while_motion_continues() {
  Lights l(record);
  l.setEntryRooms(bit(kHallway));
  l.onMotion(true, 0);
  TEST_ASSERT_EQUAL_UINT16(0, l.tick(10 * config::kAutoOffMs));
}

void touching_a_motion_lit_room_makes_it_manual() {
  Lights l(record);
  l.setEntryRooms(bit(kHallway));
  l.onMotion(true, 0);
  l.onMotion(false, 0);
  l.setBrightness(kHallway, 90);
  TEST_ASSERT_EQUAL_UINT16(0, l.tick(2 * config::kAutoOffMs));
}

void manual_mode_reports_motion_but_switches_nothing() {
  Lights l(record);
  l.setEntryRooms(bit(kHallway));
  l.setMode(Mode::Manual);
  TEST_ASSERT_EQUAL_UINT16(0, l.onMotion(true, 0));
  TEST_ASSERT_TRUE(l.snapshot(0).motion);
  TEST_ASSERT_EQUAL(0, writes);
}

void going_manual_hands_rooms_to_the_user() {
  Lights l(record);
  l.setEntryRooms(bit(kHallway));
  l.onMotion(true, 0);
  l.onMotion(false, 0);
  l.setMode(Mode::Manual);
  TEST_ASSERT_FALSE(l.snapshot(0).rooms[kHallway].byMotion);
  l.setMode(Mode::Auto);
  TEST_ASSERT_EQUAL_UINT16(0, l.tick(2 * config::kAutoOffMs));
  TEST_ASSERT_TRUE(l.snapshot(0).rooms[kHallway].on());
}

void change_flag_is_set_once_per_change() {
  Lights l(record);
  l.takeChanged();
  TEST_ASSERT_FALSE(l.takeChanged());
  l.setOn(kLiving, true);
  TEST_ASSERT_TRUE(l.takeChanged());
  TEST_ASSERT_FALSE(l.takeChanged());
}

void timers_survive_millis_wraparound() {
  Lights l(record);
  l.setEntryRooms(bit(kHallway));
  const uint32_t nearWrap = 0xFFFFFFFFu - 1000;
  l.onMotion(true, nearWrap);
  l.onMotion(false, nearWrap);
  TEST_ASSERT_EQUAL_UINT16(0, l.tick(nearWrap + 2000));                       // wrapped, 2 s later
  TEST_ASSERT_EQUAL_UINT16(bit(kHallway), l.tick(nearWrap + config::kAutoOffMs));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(brightness_sets_level_and_zero_means_off);
  RUN_TEST(brightness_is_clamped_and_rounded);
  RUN_TEST(bad_input_is_rejected);
  RUN_TEST(switching_on_restores_last_brightness);
  RUN_TEST(unchanged_value_does_not_rewrite_the_output);
  RUN_TEST(motion_switches_entry_rooms_when_dark);
  RUN_TEST(dark_means_below_the_threshold);
  RUN_TEST(no_light_sensor_counts_as_dark);
  RUN_TEST(motion_leaves_a_room_that_is_already_on);
  RUN_TEST(auto_off_switches_only_motion_lit_rooms);
  RUN_TEST(auto_off_counts_from_when_movement_stopped);
  RUN_TEST(auto_off_waits_while_motion_continues);
  RUN_TEST(touching_a_motion_lit_room_makes_it_manual);
  RUN_TEST(manual_mode_reports_motion_but_switches_nothing);
  RUN_TEST(going_manual_hands_rooms_to_the_user);
  RUN_TEST(change_flag_is_set_once_per_change);
  RUN_TEST(timers_survive_millis_wraparound);
  return UNITY_END();
}
