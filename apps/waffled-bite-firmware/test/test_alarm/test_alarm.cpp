// Unit tests for the morning alarm — wb_alarm.h (when it fires) and
// wb_tone.h (what it sounds like).
//
// Run with `pio test -e native_test`.
//
// Two separate things are under test here and it's worth keeping them
// straight, because the plan's §5 warns they get conflated:
//
//   wb_alarm — a PURE decision. Given the wall clock the server sent and the
//              parent's alarm setting, should the tone start right now? No
//              audio, no timers, no I/O, so the awkward cases (the same
//              minute polled a dozen times, midnight, a missing clock) are
//              cheap to pin down here rather than on hardware at 6:45am.
//
//   wb_tone  — the DSP. Same house style as test_synth.cpp: assert on the
//              PROPERTIES that make a wake tone usable, never on exact
//              samples.
//
// The one property that matters most is inherited from the sound machine's
// two hardware bugs (plan §9, D5): the board's 30x20mm cavity driver has
// almost no low end, so anything below ~300 Hz measures fine and then can't
// be heard on the device. `fan` and `heartbeat` both shipped broken that way.
// Every tone is checked against that here — not just the ones whose names
// sound bassy.
#include <unity.h>

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "wb_alarm.h"
#include "wb_synth.h" // wb_synth_gain — the tones share the sound machine's volume curve
#include "wb_tone.h"

void setUp(void) {}
void tearDown(void) {}

// ── helpers (same definitions as test_synth.cpp) ───────────────────────────

static const float FULL = 32767.0f;

static float rms(const int16_t *buf, size_t n)
{
  double acc = 0.0;
  for (size_t i = 0; i < n; i++)
  {
    const double v = buf[i] / (double)FULL;
    acc += v * v;
  }
  return (float)sqrt(acc / (double)n);
}

static float peak(const int16_t *buf, size_t n)
{
  float m = 0.0f;
  for (size_t i = 0; i < n; i++)
  {
    const float v = fabsf(buf[i] / FULL);
    if (v > m) m = v;
  }
  return m;
}

// Mean absolute sample-to-sample change, normalised by RMS — see
// test_synth.cpp. High = lots of high-frequency content, which is exactly
// what this speaker can reproduce.
static float brightness(const int16_t *buf, size_t n)
{
  double acc = 0.0;
  for (size_t i = 1; i < n; i++) acc += fabs((buf[i] - buf[i - 1]) / (double)FULL);
  return (float)(acc / (double)(n - 1)) / rms(buf, n);
}

static const size_t N = 22050; // one second

static const WbTone ALL_TONES[] = {
    WbTone::SunriseChime, WbTone::SoftHarp, WbTone::GentleBells,
    WbTone::OceanTide, WbTone::TwinkleStars};
static const size_t TONE_COUNT = sizeof(ALL_TONES) / sizeof(ALL_TONES[0]);

static const char *tone_name(WbTone t)
{
  switch (t)
  {
  case WbTone::SunriseChime: return "sunriseChime";
  case WbTone::SoftHarp: return "softHarp";
  case WbTone::GentleBells: return "gentleBells";
  case WbTone::OceanTide: return "oceanTide";
  case WbTone::TwinkleStars: return "twinkleStars";
  }
  return "?";
}

static void render_tone(WbTone t, int16_t *buf, size_t n, int volume = 100)
{
  WbToneVoice v;
  wb_tone_init(&v, t);
  wb_tone_render(&v, buf, n, volume);
}

// ── when the alarm fires ───────────────────────────────────────────────────

// The device polls the server every ~5s, so the alarm's minute is observed a
// dozen times over. Without a latch the tone would restart on every one of
// them, which on hardware means a 20-second alarm that never ends.
void test_alarm_fires_exactly_once_however_often_its_minute_is_polled(void)
{
  int last = WB_ALARM_NEVER_FIRED;
  int fires = 0;
  for (int poll = 0; poll < 12; poll++)
  {
    const WbAlarmStep step = wb_alarm_step(true, 6, 45, 6, 45, last);
    if (step.fire) fires++;
    last = step.lastFiredMin;
  }
  TEST_ASSERT_EQUAL_INT(1, fires);
}

// The latch must clear itself once the clock moves on, or the alarm fires
// once and then never again for the life of the device.
void test_alarm_rearms_for_the_next_day(void)
{
  WbAlarmStep step = wb_alarm_step(true, 6, 45, 6, 45, WB_ALARM_NEVER_FIRED);
  TEST_ASSERT_TRUE(step.fire);

  // ... the rest of the day goes by ...
  step = wb_alarm_step(true, 6, 45, 6, 46, step.lastFiredMin);
  TEST_ASSERT_FALSE(step.fire);
  step = wb_alarm_step(true, 6, 45, 19, 30, step.lastFiredMin);
  TEST_ASSERT_FALSE(step.fire);

  // ... and tomorrow it rings again.
  step = wb_alarm_step(true, 6, 45, 6, 45, step.lastFiredMin);
  TEST_ASSERT_TRUE(step.fire);
}

void test_alarm_stays_silent_at_every_other_minute_of_the_day(void)
{
  for (int minute = 0; minute < 1440; minute++)
  {
    if (minute == 6 * 60 + 45) continue;
    const WbAlarmStep step =
        wb_alarm_step(true, 6, 45, minute / 60, minute % 60, WB_ALARM_NEVER_FIRED);
    TEST_ASSERT_FALSE(step.fire);
  }
}

void test_a_switched_off_alarm_never_fires(void)
{
  const WbAlarmStep step = wb_alarm_step(false, 6, 45, 6, 45, WB_ALARM_NEVER_FIRED);
  TEST_ASSERT_FALSE(step.fire);
}

// Every now* field is -1 when the poll didn't carry a usable clock (mock
// state, a reshaped payload, or before the first successful poll). Firing on
// that would mean a random 3am alarm, so it's guarded explicitly.
void test_alarm_needs_a_real_wall_clock(void)
{
  TEST_ASSERT_FALSE(wb_alarm_step(true, 6, 45, -1, -1, WB_ALARM_NEVER_FIRED).fire);
  TEST_ASSERT_FALSE(wb_alarm_step(true, 6, 45, -1, 45, WB_ALARM_NEVER_FIRED).fire);
  TEST_ASSERT_FALSE(wb_alarm_step(true, 6, 45, 6, -1, WB_ALARM_NEVER_FIRED).fire);

  // A missing clock must not clear a latch that's already set, or the alarm
  // re-fires as soon as the clock comes back inside the same minute.
  const WbAlarmStep step = wb_alarm_step(true, 6, 45, -1, -1, 6 * 60 + 45);
  TEST_ASSERT_EQUAL_INT(6 * 60 + 45, step.lastFiredMin);
}

// A nonsense alarm time from a bad payload must not fire at some arbitrary
// moment; out-of-range is treated as "no alarm".
void test_a_nonsense_alarm_time_never_fires(void)
{
  TEST_ASSERT_FALSE(wb_alarm_step(true, 25, 0, 1, 0, WB_ALARM_NEVER_FIRED).fire);
  TEST_ASSERT_FALSE(wb_alarm_step(true, -1, 0, 23, 0, WB_ALARM_NEVER_FIRED).fire);
  TEST_ASSERT_FALSE(wb_alarm_step(true, 6, 60, 7, 0, WB_ALARM_NEVER_FIRED).fire);
}

void test_alarm_works_at_midnight(void)
{
  const WbAlarmStep step = wb_alarm_step(true, 0, 0, 0, 0, WB_ALARM_NEVER_FIRED);
  TEST_ASSERT_TRUE(step.fire);
  TEST_ASSERT_EQUAL_INT(0, step.lastFiredMin);
}

// A deliberate, documented consequence of latching on the minute rather than
// on a transition: a parent who sets the alarm TO the current minute hears it
// immediately. Same for flipping `on` during that minute. Both are the
// behaviour you'd want if you were testing the alarm from the parent app, so
// this pins it rather than treating it as a bug.
void test_setting_the_alarm_to_right_now_rings_it(void)
{
  TEST_ASSERT_TRUE(wb_alarm_step(true, 7, 15, 7, 15, WB_ALARM_NEVER_FIRED).fire);
}

// ── the tone list ──────────────────────────────────────────────────────────

// The stored value is a display string today ('Sunrise chime'), and the plan
// (§5 gap 3, Q2) recommends migrating to stable keys. Accepting BOTH is what
// lets that migration happen later without the firmware caring: existing rows
// work now, migrated rows work after, and no backfill has to be timed against
// a firmware release.
void test_tone_parse_accepts_both_display_strings_and_stable_keys(void)
{
  WbTone got;
  TEST_ASSERT_TRUE(wb_tone_parse("Sunrise chime", &got));
  TEST_ASSERT_TRUE(got == WbTone::SunriseChime);
  TEST_ASSERT_TRUE(wb_tone_parse("sunriseChime", &got));
  TEST_ASSERT_TRUE(got == WbTone::SunriseChime);

  TEST_ASSERT_TRUE(wb_tone_parse("Soft harp", &got));
  TEST_ASSERT_TRUE(got == WbTone::SoftHarp);
  TEST_ASSERT_TRUE(wb_tone_parse("softHarp", &got));
  TEST_ASSERT_TRUE(got == WbTone::SoftHarp);

  TEST_ASSERT_TRUE(wb_tone_parse("Gentle bells", &got));
  TEST_ASSERT_TRUE(got == WbTone::GentleBells);
  TEST_ASSERT_TRUE(wb_tone_parse("gentleBells", &got));
  TEST_ASSERT_TRUE(got == WbTone::GentleBells);

  TEST_ASSERT_TRUE(wb_tone_parse("Ocean tide", &got));
  TEST_ASSERT_TRUE(got == WbTone::OceanTide);
  TEST_ASSERT_TRUE(wb_tone_parse("oceanTide", &got));
  TEST_ASSERT_TRUE(got == WbTone::OceanTide);

  TEST_ASSERT_TRUE(wb_tone_parse("Twinkle stars", &got));
  TEST_ASSERT_TRUE(got == WbTone::TwinkleStars);
  TEST_ASSERT_TRUE(wb_tone_parse("twinkleStars", &got));
  TEST_ASSERT_TRUE(got == WbTone::TwinkleStars);
}

// Birdsong is the one tone that genuinely needs a recording (plan §5), so it
// ships disabled alongside forest/lullaby. Unlike the sound machine — where
// an unknown sound stays silent on purpose — an alarm that makes NO noise has
// failed at its only job, so anything unrecognised falls back to a tone that
// works.
void test_an_unplayable_tone_falls_back_rather_than_going_silent(void)
{
  WbTone got = WbTone::TwinkleStars;
  TEST_ASSERT_FALSE(wb_tone_parse("Birdsong", &got));
  TEST_ASSERT_FALSE(wb_tone_parse("birdsong", &got));
  TEST_ASSERT_FALSE(wb_tone_parse("some future tone", &got));
  TEST_ASSERT_FALSE(wb_tone_parse("", &got));
  TEST_ASSERT_FALSE(wb_tone_parse(NULL, &got));
  TEST_ASSERT_TRUE(got == WbTone::TwinkleStars); // left untouched on every rejection

  // The caller doesn't have to invent that fallback itself.
  TEST_ASSERT_TRUE(wb_tone_default() == WbTone::SunriseChime);
}

// ── how the tones sound ────────────────────────────────────────────────────

void test_no_tone_clips_at_full_volume(void)
{
  static int16_t buf[N * 3];
  for (size_t i = 0; i < TONE_COUNT; i++)
  {
    render_tone(ALL_TONES[i], buf, N * 3);
    const float p = peak(buf, N * 3);
    char msg[96];
    snprintf(msg, sizeof(msg), "%s peaks at %.3f", tone_name(ALL_TONES[i]), p);
    TEST_ASSERT_TRUE_MESSAGE(p < 0.99f, msg);
  }
}

// THE test for this speaker. `fan` (three poles at 420 Hz) and `heartbeat`
// (52/44 Hz) both measured fine and were then inaudible on the device — the
// driver has almost no output below ~300 Hz. Every tone is held against the
// same reference the heartbeat fix used, so a bassy recipe can't reach
// hardware again.
void test_every_tone_survives_a_speaker_with_no_low_end(void)
{
  static int16_t ref[N];
  for (size_t i = 0; i < N; i++)
    ref[i] = (int16_t)(sinf(2.0f * 3.14159265f * 55.0f * (float)i / 22050.0f) * 8000.0f);
  const float floor = brightness(ref, N) * 2.0f;

  static int16_t buf[N * 3];
  for (size_t i = 0; i < TONE_COUNT; i++)
  {
    render_tone(ALL_TONES[i], buf, N * 3);
    const float b = brightness(buf, N * 3);
    char msg[112];
    snprintf(msg, sizeof(msg), "%s brightness %.4f needs > %.4f", tone_name(ALL_TONES[i]), b, floor);
    TEST_ASSERT_TRUE_MESSAGE(b > floor, msg);
  }
}

// Switching tones in the parent app shouldn't change how loud the alarm is,
// the same way the sound machine's recipes are loudness-matched.
void test_the_tones_are_loudness_matched(void)
{
  static int16_t buf[N * 3];
  float lo = 1.0f, hi = 0.0f;
  for (size_t i = 0; i < TONE_COUNT; i++)
  {
    render_tone(ALL_TONES[i], buf, N * 3);
    const float r = rms(buf, N * 3);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  char msg[96];
  snprintf(msg, sizeof(msg), "quietest %.4f vs loudest %.4f", lo, hi);
  // The floor is set against the sound machine, not against zero: an alarm
  // quieter than the white noise it interrupts (RMS 0.24 at full volume)
  // would be inaudible under it. All five are tuned to ~0.19.
  TEST_ASSERT_TRUE_MESSAGE(lo > 0.15f, msg);
  TEST_ASSERT_TRUE_MESSAGE(hi < lo * 1.1f, msg); // within 1 dB of each other
}

// An alarm has to keep making noise for its whole 20 seconds. A single chime
// that rings once and decays into 18 seconds of silence is a notification,
// not an alarm — so the motif has to repeat, with no long dead air.
void test_a_tone_keeps_ringing_for_the_whole_alarm(void)
{
  static int16_t buf[N * 20]; // the full D4 alarm duration
  for (size_t i = 0; i < TONE_COUNT; i++)
  {
    render_tone(ALL_TONES[i], buf, N * 20);

    const float quiet = peak(buf, N * 20) * 0.02f;
    size_t run = 0, worst = 0;
    for (size_t j = 0; j < N * 20; j++)
    {
      if (fabsf(buf[j] / FULL) < quiet)
      {
        if (++run > worst) worst = run;
      }
      else
        run = 0;
    }
    char msg[112];
    snprintf(msg, sizeof(msg), "%s goes quiet for %.2fs", tone_name(ALL_TONES[i]),
             (double)worst / 22050.0);
    TEST_ASSERT_TRUE_MESSAGE(worst < N * 3 / 2, msg); // never silent for 1.5s
  }
}

// Same seam guarantee as the sound machine: the alarm is rendered in whatever
// block size the I2S driver asks for, so block boundaries must be inaudible.
void test_consecutive_tone_blocks_join_without_a_seam(void)
{
  static int16_t whole[N * 2], split[N * 2];
  for (size_t i = 0; i < TONE_COUNT; i++)
  {
    render_tone(ALL_TONES[i], whole, N * 2);

    WbToneVoice v;
    wb_tone_init(&v, ALL_TONES[i]);
    wb_tone_render(&v, split, 1000, 100);
    wb_tone_render(&v, split + 1000, 3411, 100);
    wb_tone_render(&v, split + 4411, N * 2 - 4411, 100);

    for (size_t j = 0; j < N * 2; j++)
      TEST_ASSERT_EQUAL_INT16(whole[j], split[j]);
  }
}

// D3 gives the alarm its own volume, but it must be the SAME curve the sound
// machine uses — a second, subtly different curve is how "volume 50" comes to
// mean two different loudnesses on one device.
void test_the_alarm_volume_uses_the_sound_machines_curve(void)
{
  static int16_t full[N], half[N];
  render_tone(WbTone::SunriseChime, full, N, 100);
  render_tone(WbTone::SunriseChime, half, N, 50);

  const float ratio = rms(half, N) / rms(full, N);
  TEST_ASSERT_FLOAT_WITHIN(0.02f, wb_synth_gain(50), ratio);
}

void test_alarm_volume_zero_is_exactly_silent(void)
{
  static int16_t buf[N];
  render_tone(WbTone::GentleBells, buf, N, 0);
  for (size_t i = 0; i < N; i++) TEST_ASSERT_EQUAL_INT16(0, buf[i]);
}

// ── main ───────────────────────────────────────────────────────────────────

int main(void)
{
  UNITY_BEGIN();
  RUN_TEST(test_alarm_fires_exactly_once_however_often_its_minute_is_polled);
  RUN_TEST(test_alarm_rearms_for_the_next_day);
  RUN_TEST(test_alarm_stays_silent_at_every_other_minute_of_the_day);
  RUN_TEST(test_a_switched_off_alarm_never_fires);
  RUN_TEST(test_alarm_needs_a_real_wall_clock);
  RUN_TEST(test_a_nonsense_alarm_time_never_fires);
  RUN_TEST(test_alarm_works_at_midnight);
  RUN_TEST(test_setting_the_alarm_to_right_now_rings_it);
  RUN_TEST(test_tone_parse_accepts_both_display_strings_and_stable_keys);
  RUN_TEST(test_an_unplayable_tone_falls_back_rather_than_going_silent);
  RUN_TEST(test_no_tone_clips_at_full_volume);
  RUN_TEST(test_every_tone_survives_a_speaker_with_no_low_end);
  RUN_TEST(test_the_tones_are_loudness_matched);
  RUN_TEST(test_a_tone_keeps_ringing_for_the_whole_alarm);
  RUN_TEST(test_consecutive_tone_blocks_join_without_a_seam);
  RUN_TEST(test_the_alarm_volume_uses_the_sound_machines_curve);
  RUN_TEST(test_alarm_volume_zero_is_exactly_silent);
  UNITY_END();
  return 0;
}
