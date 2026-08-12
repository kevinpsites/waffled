// Unit tests for the sound machine's sleep timer — wb_sleep_timer.h.
//
// Run with `pio test -e native_test`.
//
// Same shape as test_alarm.cpp: the decision under test is PURE. Given what
// the parent set (`settings.sound.on` / `.sound` / `.timerMin`) and a
// millisecond clock the caller supplies, should the sound machine be playing
// right now? No audio, no timers, no I/O — so the cases that are otherwise
// only reachable by sitting next to a device for two hours are cheap here.
//
// The case worth reading first is
// `test_the_stop_is_not_undone_by_the_next_poll`. main.cpp reconciles
// playback with settings on a fixed cadence and calls into this on EVERY
// reconcile, so any "stop" that isn't sticky is silently reversed seconds
// later, forever. Two blockers in this feature have already come from
// exactly that (most recently wb_audio_stop() clearing the alarm request,
// which truncated a 20-second alarm to one poll). This is the test that
// stops it happening a third time.
#include <unity.h>

#include <stdio.h>
#include <string.h>

#include "wb_sleep_timer.h"

void setUp(void) {}
void tearDown(void) {}

static const uint32_t MIN_MS = 60000u;

// A device that has just booted, with the sound machine off and no timer —
// the state main.cpp starts from.
static WbSleepTimer fresh(void)
{
  WbSleepTimer t;
  wb_sleep_timer_init(&t);
  return t;
}

// ── the countdown itself ───────────────────────────────────────────────────

// The whole point of the feature: "30m" in the parent panel means the room
// goes quiet 30 minutes later, not at breakfast. Pinned to the exact
// millisecond on both sides so a later refactor can't quietly turn the
// comparison into "> duration" (one poll late) or start it a poll early.
void test_the_sound_machine_stops_after_exactly_the_timer_length(void)
{
  WbSleepTimer t = fresh();
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, 0));
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, 30 * MIN_MS - 1));
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, 30 * MIN_MS));
}

// 0 is what every panel preset other than 15/30/60/120 sends, and it is also
// the default. It has to mean "play until someone switches it off", not
// "stop immediately" — getting this backwards would silence every device in
// the field that never set a timer.
void test_a_zero_timer_never_stops_the_sound_machine(void)
{
  WbSleepTimer t = fresh();
  for (uint32_t hour = 0; hour < 12; hour++)
    TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 0, hour * 60 * MIN_MS));
}

// THE regression test for this feature. main.cpp's reconcile runs
// unconditionally, on a fixed cadence, for as long as the device is on — so
// the stop must be STICKY for the session rather than recomputed from
// "is the sound machine on?" each time. A non-sticky stop reads as working
// (the first stop happens!) and then the sound comes back within seconds,
// all night.
void test_the_stop_is_not_undone_by_the_next_poll(void)
{
  WbSleepTimer t = fresh();
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "ocean", 15, 0));
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "ocean", 15, 15 * MIN_MS));

  // Eight hours of reconciles with the settings completely unchanged — the
  // parent is asleep, nobody touches anything, the server keeps reporting
  // sound.on == true because that IS still the setting.
  for (uint32_t s = 15 * 60 + 1; s < 8 * 3600; s++)
    TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "ocean", 15, s * 1000u));
}

// The mirror of the test above: sticky must not mean permanent. Switching
// the sound machine off and on again is how a kid asks for another 30
// minutes, and it's the most likely thing anyone does after the timer fires.
void test_the_timer_rearms_when_the_sound_machine_is_switched_back_on(void)
{
  WbSleepTimer t = fresh();
  wb_sleep_timer_step(&t, true, "whiteNoise", 30, 0);
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, 30 * MIN_MS));

  // Off ...
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, false, "whiteNoise", 30, 31 * MIN_MS));
  // ... and on again: a whole new 30 minutes, counted from the moment it was
  // switched on, not from the original session.
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, 32 * MIN_MS));
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, 61 * MIN_MS));
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, 62 * MIN_MS));
}

// Picking a different sound is a fresh request for that sound, so it starts a
// fresh countdown — the same reasoning as switching it off and on, and the
// behaviour a kid swapping ocean for rain at bedtime would expect.
void test_choosing_a_different_sound_rearms_the_timer(void)
{
  WbSleepTimer t = fresh();
  wb_sleep_timer_step(&t, true, "whiteNoise", 30, 0);
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, 30 * MIN_MS));

  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "ocean", 30, 30 * MIN_MS + 1));
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "ocean", 30, 60 * MIN_MS + 1));
}

// This is the case that justifies putting timerMin in the session identity at
// all. A parent who sees the room go quiet too early and moves 30m -> 60m
// must get sound back — if only `on` re-armed, their change would appear to
// do nothing until someone physically toggled the device.
void test_changing_the_timer_length_after_it_expired_starts_a_new_countdown(void)
{
  WbSleepTimer t = fresh();
  wb_sleep_timer_step(&t, true, "whiteNoise", 30, 0);
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, 30 * MIN_MS));

  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 60, 30 * MIN_MS));
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 60, 89 * MIN_MS));
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "whiteNoise", 60, 90 * MIN_MS));

  // ... and clearing the timer to "off" brings the sound back for good.
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 0, 91 * MIN_MS));
}

// The counterpart to the re-arm tests: an UNCHANGED setting must not re-arm.
// Every reconcile passes the same values through, so if any of them looked
// like a change the deadline would be pushed back by five seconds forever and
// the sound would never stop — the exact bug this feature exists to fix,
// hiding inside its own fix.
void test_repeated_polls_do_not_push_the_deadline_back(void)
{
  WbSleepTimer t = fresh();
  uint32_t stoppedAt = 0;
  for (uint32_t s = 0; s <= 40 * 60; s += 5) // 5s cadence, 40 minutes of it
  {
    // A fresh buffer each time: the caller's `tone` is a char[] inside a
    // struct that gets overwritten by every poll, so this must compare by
    // VALUE and not by pointer.
    char tone[16];
    snprintf(tone, sizeof(tone), "%s", "whiteNoise");
    if (!wb_sleep_timer_step(&t, true, tone, 30, s * 1000u))
    {
      stoppedAt = s;
      break;
    }
  }
  TEST_ASSERT_EQUAL_UINT32(30 * 60, stoppedAt);
}

// The deadline is time, not poll count. WiFi drops are routine and the poll
// backs off to 30s intervals when it happens (WB_POLL_INTERVAL_OFFLINE_MS),
// so the timer must expire on the first look AFTER the deadline rather than
// counting calls it never got.
void test_the_deadline_is_measured_in_time_not_in_polls(void)
{
  WbSleepTimer t = fresh();
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "rain", 15, 1000));
  // ... an hour offline, one single look afterwards ...
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "rain", 15, 61 * MIN_MS));
}

// wb_tick_ms() is a uint32 of milliseconds since boot, so it wraps every ~49
// days — and a device in a kid's bedroom stays powered for months. Unsigned
// subtraction makes the wrap a non-event; written as a test because the
// "obvious" signed/`start + duration` formulation silently stops working for
// one session every seven weeks, which nobody would ever reproduce.
void test_the_countdown_survives_the_tick_counters_wraparound(void)
{
  WbSleepTimer t = fresh();
  const uint32_t start = 0xFFFFFFFFu - 10 * MIN_MS; // 10 minutes before the wrap
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, start));
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, start + 29 * MIN_MS));
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, "whiteNoise", 30, start + 30 * MIN_MS));
}

// Same rule as wb_alarm's nonsense-time guard: a value that can't have come
// from the panel is a bad payload, and the safe reading of a bad payload is
// "no timer" rather than "silence the device at some arbitrary moment".
// Negatives and absurd lengths also keep timerMin * 60000 from overflowing
// the uint32 the comparison is done in.
void test_a_nonsense_timer_length_is_treated_as_no_timer(void)
{
  WbSleepTimer t = fresh();
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", -30, 0));
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, "whiteNoise", -30, 10 * 60 * MIN_MS));

  WbSleepTimer u = fresh();
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&u, true, "whiteNoise", 999999, 0));
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&u, true, "whiteNoise", 999999, 10 * 60 * MIN_MS));
}

// A switched-off sound machine is silent whatever the timer says — the timer
// only ever takes playback away, it never grants it.
void test_a_switched_off_sound_machine_never_plays(void)
{
  WbSleepTimer t = fresh();
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, false, "whiteNoise", 0, 0));
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, false, "whiteNoise", 30, 1000));
}

// A missing tone (a reshaped payload, or the pre-pairing default) must not
// crash the reconcile that runs every second. It reads as its own session,
// nothing more.
void test_a_missing_sound_name_is_handled_rather_than_dereferenced(void)
{
  WbSleepTimer t = fresh();
  TEST_ASSERT_TRUE(wb_sleep_timer_step(&t, true, NULL, 30, 0));
  TEST_ASSERT_FALSE(wb_sleep_timer_step(&t, true, NULL, 30, 30 * MIN_MS));
}

// ── main ───────────────────────────────────────────────────────────────────

int main(void)
{
  UNITY_BEGIN();
  RUN_TEST(test_the_sound_machine_stops_after_exactly_the_timer_length);
  RUN_TEST(test_a_zero_timer_never_stops_the_sound_machine);
  RUN_TEST(test_the_stop_is_not_undone_by_the_next_poll);
  RUN_TEST(test_the_timer_rearms_when_the_sound_machine_is_switched_back_on);
  RUN_TEST(test_choosing_a_different_sound_rearms_the_timer);
  RUN_TEST(test_changing_the_timer_length_after_it_expired_starts_a_new_countdown);
  RUN_TEST(test_repeated_polls_do_not_push_the_deadline_back);
  RUN_TEST(test_the_deadline_is_measured_in_time_not_in_polls);
  RUN_TEST(test_the_countdown_survives_the_tick_counters_wraparound);
  RUN_TEST(test_a_nonsense_timer_length_is_treated_as_no_timer);
  RUN_TEST(test_a_switched_off_sound_machine_never_plays);
  RUN_TEST(test_a_missing_sound_name_is_handled_rather_than_dereferenced);
  UNITY_END();
  return 0;
}
