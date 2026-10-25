// Host tests for the Wi-Fi decisions: boot, router reboots, wrong channel,
// outages long enough to need the hotspot, and getting home again.
#include <unity.h>

#include "wifi_policy.h"

using wifi::Actions;
using wifi::Policy;
using wifi::State;

namespace {

// Advances time in 100 ms loop ticks, collecting every action.
Actions runFor(Policy& p, uint32_t& now, uint32_t ms, uint8_t clients = 0) {
  Actions all;
  for (uint32_t end = now + ms; now != end; now += 100) {
    const Actions a = p.tick(now, clients);
    all.connect |= a.connect;
    all.openHotspot |= a.openHotspot;
    all.closeHotspot |= a.closeHotspot;
    all.startScan |= a.startScan;
    all.restartMdns |= a.restartMdns;
  }
  return all;
}

// Router stays off until the hotspot opens.
void runUntilHotspot(Policy& p, uint32_t& now) {
  while (!p.hotspotOn()) {
    const Actions a = runFor(p, now, 100);
    if (a.connect) p.disconnected(now);
  }
}

}  // namespace

void setUp() {}
void tearDown() {}

void boot_uses_the_cached_channel_when_there_is_one() {
  Policy p;
  TEST_ASSERT_TRUE(p.start(0, true).usePin);
  Policy fresh;
  const Actions a = fresh.start(0, false);
  TEST_ASSERT_TRUE(a.connect);
  TEST_ASSERT_FALSE(a.usePin);
}

void first_connection_saves_the_pin_and_keeps_mdns() {
  Policy p;
  p.start(0, false);
  const Actions a = p.gotIp(1800);
  TEST_ASSERT_TRUE(a.savePin);
  TEST_ASSERT_FALSE(a.restartMdns);
  TEST_ASSERT_TRUE(p.state() == State::Online);
}

void stale_pin_is_dropped_and_retried_at_once() {
  Policy p;
  p.start(0, true);
  const Actions a = p.disconnected(900);   // router moved to another channel
  TEST_ASSERT_TRUE(a.forgetPin);
  TEST_ASSERT_TRUE(a.connect);
  TEST_ASSERT_FALSE(a.usePin);
}

void backoff_grows_then_settles_at_a_minute() {
  TEST_ASSERT_EQUAL_UINT32(1'000, Policy::backoffMs(0));
  TEST_ASSERT_EQUAL_UINT32(2'000, Policy::backoffMs(1));
  TEST_ASSERT_EQUAL_UINT32(5'000, Policy::backoffMs(2));
  TEST_ASSERT_EQUAL_UINT32(60'000, Policy::backoffMs(6));
  TEST_ASSERT_EQUAL_UINT32(60'000, Policy::backoffMs(200));
}

void failed_attempt_waits_before_retrying() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.disconnected(now += 500);
  TEST_ASSERT_TRUE(p.state() == State::Waiting);
  TEST_ASSERT_FALSE(runFor(p, now, 900).connect);   // 1 s backoff not over yet
  TEST_ASSERT_TRUE(runFor(p, now, 200).connect);
}

void attempt_with_no_answer_times_out() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  runFor(p, now, config::kWifiAttemptTimeoutMs + 100);
  TEST_ASSERT_TRUE(p.state() == State::Waiting || p.state() == State::Connecting);
  TEST_ASSERT_TRUE(p.failures() >= 1);
}

void dropping_offline_retries_after_one_second() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.gotIp(now += 2000);
  runFor(p, now, 60'000);
  p.disconnected(now);   // router rebooting
  TEST_ASSERT_TRUE(runFor(p, now, 1'100).connect);
}

void short_router_reboot_never_opens_the_hotspot() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.gotIp(now += 2000);
  p.disconnected(now);
  const uint32_t reboot = 90'000;   // typical home router reboot
  Actions seen;
  for (uint32_t end = now + reboot; now < end;) {
    const Actions a = runFor(p, now, 1'000);
    seen.openHotspot |= a.openHotspot;
    if (a.connect) p.disconnected(now);   // router still down
  }
  TEST_ASSERT_FALSE(seen.openHotspot);
  p.gotIp(now);
  TEST_ASSERT_TRUE(p.state() == State::Online);
}

void no_network_at_boot_opens_the_hotspot_after_30_s() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.disconnected(now += 3000);
  bool opened = false;
  while (now < config::kHotspotAfterBootMs - 200) {
    const Actions a = runFor(p, now, 100);
    TEST_ASSERT_FALSE(a.openHotspot);
    if (a.connect) p.disconnected(now);
  }
  for (int i = 0; i < 10 && !opened; i++) {
    const Actions a = runFor(p, now, 100);
    opened = a.openHotspot;
    if (a.connect) p.disconnected(now);
  }
  TEST_ASSERT_TRUE(opened);
  TEST_ASSERT_TRUE(p.hotspotOn());
}

void long_outage_after_being_online_opens_the_hotspot() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.gotIp(now += 1000);
  p.disconnected(now);
  Actions seen;
  for (uint32_t end = now + config::kHotspotAfterDropMs + 1000; now < end;) {
    const Actions a = runFor(p, now, 100);
    seen.openHotspot |= a.openHotspot;
    if (a.connect) p.disconnected(now);
  }
  TEST_ASSERT_TRUE(seen.openHotspot);
}

// With the hotspot up, the board must look before it leaps: a blind connect
// would hop channels and drop the phone that is using the hotspot.
void hotspot_mode_scans_instead_of_connecting_blind() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.disconnected(now += 1000);
  runUntilHotspot(p, now);
  Actions seen;
  for (uint32_t end = now + 3 * config::kHotspotScanMs; now < end;) {
    const Actions a = runFor(p, now, 100);
    seen.connect |= a.connect;
    if (a.startScan) {
      seen.startScan = true;
      p.scanFinished(false, now);   // router still off
    }
  }
  TEST_ASSERT_TRUE(seen.startScan);
  TEST_ASSERT_FALSE(seen.connect);
}

void router_back_is_joined_from_the_scan_result() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.disconnected(now += 1000);
  runUntilHotspot(p, now);
  Actions scan;
  while (!scan.startScan) scan = runFor(p, now, 100);
  const Actions join = p.scanFinished(true, now);
  TEST_ASSERT_TRUE(join.connect);
  TEST_ASSERT_TRUE(join.useScanResult);
  TEST_ASSERT_TRUE(p.gotIp(now).restartMdns);   // announce nather.local on the home network again
}

void hotspot_stays_while_a_phone_uses_it() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.disconnected(now += 1000);
  runUntilHotspot(p, now);
  p.gotIp(now);
  TEST_ASSERT_FALSE(runFor(p, now, config::kHotspotCloseAfterMs + 1000, 1).closeHotspot);
  TEST_ASSERT_TRUE(p.hotspotOn());
  TEST_ASSERT_TRUE(runFor(p, now, 1000, 0).closeHotspot);   // phone left: close it
  TEST_ASSERT_FALSE(p.hotspotOn());
}

void hotspot_closes_eventually_even_with_a_phone_on_it() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.disconnected(now += 1000);
  runUntilHotspot(p, now);
  p.gotIp(now);
  TEST_ASSERT_TRUE(runFor(p, now, config::kHotspotCloseMaxMs + 1000, 2).closeHotspot);
}

void a_scan_that_never_reports_back_is_retried() {
  Policy p;
  uint32_t now = 0;
  p.start(now, false);
  p.disconnected(now += 1000);
  runUntilHotspot(p, now);
  int scans = 0;
  for (uint32_t end = now + 2 * (config::kScanTimeoutMs + config::kHotspotScanMs); now < end;) {
    if (runFor(p, now, 100).startScan) scans++;   // never call scanFinished()
  }
  TEST_ASSERT_TRUE(scans >= 2);
}

void works_across_millis_wraparound() {
  Policy p;
  uint32_t now = 0xFFFFFFFFu - 499;   // the retry is due 500 ms after millis() wraps
  p.start(now, false);
  p.disconnected(now);
  TEST_ASSERT_TRUE(runFor(p, now, 1'100).connect);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(boot_uses_the_cached_channel_when_there_is_one);
  RUN_TEST(first_connection_saves_the_pin_and_keeps_mdns);
  RUN_TEST(stale_pin_is_dropped_and_retried_at_once);
  RUN_TEST(backoff_grows_then_settles_at_a_minute);
  RUN_TEST(failed_attempt_waits_before_retrying);
  RUN_TEST(attempt_with_no_answer_times_out);
  RUN_TEST(dropping_offline_retries_after_one_second);
  RUN_TEST(short_router_reboot_never_opens_the_hotspot);
  RUN_TEST(no_network_at_boot_opens_the_hotspot_after_30_s);
  RUN_TEST(long_outage_after_being_online_opens_the_hotspot);
  RUN_TEST(hotspot_mode_scans_instead_of_connecting_blind);
  RUN_TEST(router_back_is_joined_from_the_scan_result);
  RUN_TEST(hotspot_stays_while_a_phone_uses_it);
  RUN_TEST(hotspot_closes_eventually_even_with_a_phone_on_it);
  RUN_TEST(a_scan_that_never_reports_back_is_retried);
  RUN_TEST(works_across_millis_wraparound);
  return UNITY_END();
}
