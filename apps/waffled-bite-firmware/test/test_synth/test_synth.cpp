// Unit tests for wb_synth.h — the sound machine's DSP.
//
// Run with `pio test -e native_test`.
//
// These assert on the PROPERTIES that make a sleep sound usable, not on exact
// sample values: nothing clips, the sounds are loudness-matched so switching
// between them at 2am doesn't blast anyone, brightness goes in the direction
// the recipe name promises, and — the important one — consecutive render
// calls join without a seam, because that is what lets this play for eight
// hours with no loop point.
//
// Also covers wb_wav.h's header, which isn't firmware but is the single most
// likely reason a rendered preview "plays as silence".
#include <unity.h>

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "wb_synth.h"
#include "../../tools/audio/wb_wav.h"

void setUp(void) {}
void tearDown(void) {}

// ── helpers ────────────────────────────────────────────────────────────────

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

// Mean absolute sample-to-sample change, normalised by RMS. A pure
// high-frequency signal moves a lot between adjacent samples; a low-passed
// one barely moves. Dividing by RMS is what stops this from being fooled by
// one sound simply being quieter than another.
static float brightness(const int16_t *buf, size_t n)
{
  double acc = 0.0;
  for (size_t i = 1; i < n; i++) acc += fabs((buf[i] - buf[i - 1]) / (double)FULL);
  return (float)(acc / (double)(n - 1)) / rms(buf, n);
}

static void render(WbSound sound, int16_t *buf, size_t n, int volume = 100, uint32_t seed = 12345)
{
  WbSynth s;
  wb_synth_init(&s, sound, seed);
  wb_synth_render(&s, buf, n, volume);
}

static const size_t N = 22050; // one second

// ── the sound list ─────────────────────────────────────────────────────────

void test_parse_accepts_the_five_synthesised_sounds(void)
{
  WbSound got;
  TEST_ASSERT_TRUE(wb_synth_parse("white", &got));
  TEST_ASSERT_TRUE(got == WbSound::White);
  TEST_ASSERT_TRUE(wb_synth_parse("ocean", &got));
  TEST_ASSERT_TRUE(got == WbSound::Ocean);
  TEST_ASSERT_TRUE(wb_synth_parse("rain", &got));
  TEST_ASSERT_TRUE(got == WbSound::Rain);
  TEST_ASSERT_TRUE(wb_synth_parse("fan", &got));
  TEST_ASSERT_TRUE(got == WbSound::Fan);
  TEST_ASSERT_TRUE(wb_synth_parse("heartbeat", &got));
  TEST_ASSERT_TRUE(got == WbSound::Heartbeat);
}

// The server's picker offers seven sounds; two of them need real recordings.
// An unknown sound must stay SILENT rather than fall back to something
// arbitrary — a kid asking for a lullaby and getting white noise is a worse
// failure than getting nothing.
void test_parse_rejects_sampled_and_unknown_sounds(void)
{
  WbSound got = WbSound::Fan;
  TEST_ASSERT_FALSE(wb_synth_parse("lullaby", &got));
  TEST_ASSERT_FALSE(wb_synth_parse("forest", &got));
  TEST_ASSERT_FALSE(wb_synth_parse("birdsong", &got));
  TEST_ASSERT_FALSE(wb_synth_parse("", &got));
  TEST_ASSERT_FALSE(wb_synth_parse(NULL, &got));
  TEST_ASSERT_TRUE(got == WbSound::Fan); // left untouched on every rejection
}

// ── volume ─────────────────────────────────────────────────────────────────

void test_volume_zero_is_exactly_silent(void)
{
  TEST_ASSERT_EQUAL_FLOAT(0.0f, wb_synth_gain(0));

  int16_t buf[1024];
  render(WbSound::White, buf, 1024, 0);
  for (size_t i = 0; i < 1024; i++) TEST_ASSERT_EQUAL_INT16(0, buf[i]);
}

void test_volume_curve_is_logarithmic_and_monotonic(void)
{
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 1.0f, wb_synth_gain(100));

  // Halfway up the slider sits below half the gain (it's a dB curve, not a
  // line), but not so far below that the middle of the slider is useless.
  // The range is 24 dB: at the original 40 dB, volume 50 was 10% amplitude,
  // which on the device's small speaker was inaudible for the quieter sounds.
  TEST_ASSERT_TRUE(wb_synth_gain(50) < 0.40f);
  TEST_ASSERT_TRUE(wb_synth_gain(50) > 0.15f);

  float prev = -1.0f;
  for (int v = 0; v <= 100; v++)
  {
    const float g = wb_synth_gain(v);
    TEST_ASSERT_TRUE(g > prev);
    prev = g;
  }

  // Out-of-range values from a bad server payload must clamp, not explode.
  TEST_ASSERT_EQUAL_FLOAT(0.0f, wb_synth_gain(-20));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 1.0f, wb_synth_gain(500));
}

// ── level ──────────────────────────────────────────────────────────────────

void test_no_sound_clips_at_full_volume(void)
{
  const WbSound all[] = {WbSound::White, WbSound::Ocean, WbSound::Rain,
                         WbSound::Fan, WbSound::Heartbeat};
  static int16_t buf[N * 4];
  for (int i = 0; i < 5; i++)
  {
    render(all[i], buf, N * 4); // 4s, long enough to cross ocean's swell peak
    TEST_ASSERT_TRUE(peak(buf, N * 4) < 0.999f);
  }
}

// Switching sounds must not change how loud the room is. The four continuous
// sounds are compared on RMS; heartbeat is mostly silence by design, so it
// gets compared on peak instead.
void test_the_continuous_sounds_are_loudness_matched(void)
{
  const WbSound cont[] = {WbSound::White, WbSound::Ocean, WbSound::Rain, WbSound::Fan};
  static int16_t buf[N * 4];
  float lo = 1e9f, hi = 0.0f;
  for (int i = 0; i < 4; i++)
  {
    render(cont[i], buf, N * 4);
    const float r = rms(buf, N * 4);
    TEST_ASSERT_TRUE(r > 0.10f); // audible
    TEST_ASSERT_TRUE(r < 0.45f); // not shouting
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  TEST_ASSERT_TRUE(hi / lo < 1.8f); // within ~5 dB of each other
}

// The device's speaker is a 30x20mm cavity driver with essentially no output
// below a couple of hundred Hz. A heartbeat built on a 52 Hz fundamental is
// therefore INAUDIBLE on the actual hardware even though it looks perfect in
// a WAV — which is exactly what happened on the first hardware test.
//
// So this asserts a physical property, not a taste: the thump must carry more
// high-frequency energy than a pure low sine, or the speaker can't reproduce
// it. Compared against a synthesised 55 Hz reference so the threshold is
// meaningful rather than a magic number.
void test_heartbeat_survives_a_speaker_with_no_low_end(void)
{
  static int16_t hb[N * 4];
  render(WbSound::Heartbeat, hb, N * 4);

  // Reference: a pure 55 Hz sine, i.e. the old heartbeat's fundamental.
  static int16_t ref[N];
  for (size_t i = 0; i < N; i++)
    ref[i] = (int16_t)(sinf(2.0f * 3.14159265f * 55.0f * (float)i / 22050.0f) * 8000.0f);

  TEST_ASSERT_TRUE(brightness(hb, N * 4) > brightness(ref, N) * 2.0f);
}

// Heartbeat is a pulse, so it's PEAK-limited where the continuous sounds are
// RMS-limited — which made it so much quieter in practice that it was only
// audible with the volume at 100%. Reported from the device, not theorised.
//
// A short spike can hit full scale and still carry very little energy, so
// "doesn't clip" is not the same as "you can hear it". This pins the average
// level to within a few dB of the continuous sounds.
void test_heartbeat_is_audible_below_full_volume(void)
{
  static int16_t hb[N * 4], wh[N * 4];
  render(WbSound::Heartbeat, hb, N * 4);
  // Measured against white noise, not ocean: white's level is rock-steady,
  // while ocean's swell makes its short-window RMS swing enough to make this
  // assertion flap for reasons that have nothing to do with the heartbeat.
  render(WbSound::White, wh, N * 4);

  TEST_ASSERT_TRUE(rms(hb, N * 4) > rms(wh, N * 4) * 0.5f); // within ~6 dB
}

void test_heartbeat_thumps_once_a_second_with_a_quiet_gap(void)
{
  static int16_t buf[N * 4];
  render(WbSound::Heartbeat, buf, N * 4);

  TEST_ASSERT_TRUE(peak(buf, N * 4) > 0.25f); // the thump is actually audible

  // Beat at t=0 of each second; the back half of the second is the rest.
  const float beat = rms(buf, N / 4);              // 0.00-0.25s
  const float gap = rms(buf + (N * 3) / 4, N / 4); // 0.75-1.00s
  TEST_ASSERT_TRUE(beat > gap * 8.0f);
}

// ── character ──────────────────────────────────────────────────────────────

void test_brightness_matches_what_each_recipe_promises(void)
{
  static int16_t white[N], fan[N], rain[N], ocean[N];
  render(WbSound::White, white, N);
  render(WbSound::Fan, fan, N);
  render(WbSound::Rain, rain, N);
  render(WbSound::Ocean, ocean, N);

  // A box fan is a dull rumble; white noise is a hiss.
  TEST_ASSERT_TRUE(brightness(fan, N) < brightness(white, N) * 0.5f);
  // Rain is hiss plus droplets — brighter than the fan, and brighter than
  // ocean, which is band-limited under a swell.
  TEST_ASSERT_TRUE(brightness(rain, N) > brightness(fan, N));
  TEST_ASSERT_TRUE(brightness(ocean, N) < brightness(white, N));
}

// ── continuity: the property that makes an 8-hour night possible ───────────

// If render() rebuilt its state per call, the filter states and oscillator
// phases would snap back and every block boundary would click. Fan and
// heartbeat are the sounds where that would be audible: both are dominated by
// low frequencies, so a reset is a large step.
void test_consecutive_blocks_join_without_a_seam(void)
{
  const WbSound tested[] = {WbSound::Fan, WbSound::Heartbeat, WbSound::Ocean};
  for (int i = 0; i < 3; i++)
  {
    WbSynth s;
    wb_synth_init(&s, tested[i], 999);

    int16_t a[512], b[512];
    wb_synth_render(&s, a, 512, 100);
    wb_synth_render(&s, b, 512, 100);

    int biggestInside = 0;
    for (size_t k = 1; k < 512; k++)
    {
      const int d = abs(a[k] - a[k - 1]);
      if (d > biggestInside) biggestInside = d;
    }
    const int acrossTheJoin = abs(b[0] - a[511]);
    TEST_ASSERT_TRUE(acrossTheJoin <= biggestInside);
  }
}

void test_render_is_deterministic_for_a_given_seed(void)
{
  int16_t a[4096], b[4096], c[4096];
  render(WbSound::White, a, 4096, 100, 7);
  render(WbSound::White, b, 4096, 100, 7);
  render(WbSound::White, c, 4096, 100, 8);

  TEST_ASSERT_EQUAL_INT(0, memcmp(a, b, sizeof(a)));
  TEST_ASSERT_TRUE(memcmp(a, c, sizeof(a)) != 0);
}

// ── the preview renderer's WAV header ──────────────────────────────────────

void test_wav_header_is_well_formed(void)
{
  uint8_t h[44];
  const uint32_t samples = 1000;
  wb_wav_header(h, WB_SAMPLE_RATE_HZ, samples);

  TEST_ASSERT_EQUAL_size_t(44, WB_WAV_HEADER_BYTES);
  TEST_ASSERT_EQUAL_INT(0, memcmp(h + 0, "RIFF", 4));
  TEST_ASSERT_EQUAL_INT(0, memcmp(h + 8, "WAVE", 4));
  TEST_ASSERT_EQUAL_INT(0, memcmp(h + 12, "fmt ", 4));
  TEST_ASSERT_EQUAL_INT(0, memcmp(h + 36, "data", 4));

  const uint32_t dataBytes = samples * 2;
  uint32_t riffSize, fmtSize, rate, byteRate, dataSize;
  uint16_t format, channels, align, bits;
  memcpy(&riffSize, h + 4, 4);
  memcpy(&fmtSize, h + 16, 4);
  memcpy(&format, h + 20, 2);
  memcpy(&channels, h + 22, 2);
  memcpy(&rate, h + 24, 4);
  memcpy(&byteRate, h + 28, 4);
  memcpy(&align, h + 32, 2);
  memcpy(&bits, h + 34, 2);
  memcpy(&dataSize, h + 40, 4);

  TEST_ASSERT_EQUAL_UINT32(36 + dataBytes, riffSize);
  TEST_ASSERT_EQUAL_UINT32(16, fmtSize);
  TEST_ASSERT_EQUAL_UINT16(1, format);
  TEST_ASSERT_EQUAL_UINT16(1, channels);
  TEST_ASSERT_EQUAL_UINT32((uint32_t)WB_SAMPLE_RATE_HZ, rate);
  TEST_ASSERT_EQUAL_UINT32((uint32_t)WB_SAMPLE_RATE_HZ * 2, byteRate);
  TEST_ASSERT_EQUAL_UINT16(2, align);
  TEST_ASSERT_EQUAL_UINT16(16, bits);
  TEST_ASSERT_EQUAL_UINT32(dataBytes, dataSize);
}

int main(int argc, char **argv)
{
  UNITY_BEGIN();
  RUN_TEST(test_parse_accepts_the_five_synthesised_sounds);
  RUN_TEST(test_parse_rejects_sampled_and_unknown_sounds);
  RUN_TEST(test_volume_zero_is_exactly_silent);
  RUN_TEST(test_volume_curve_is_logarithmic_and_monotonic);
  RUN_TEST(test_no_sound_clips_at_full_volume);
  RUN_TEST(test_the_continuous_sounds_are_loudness_matched);
  RUN_TEST(test_heartbeat_thumps_once_a_second_with_a_quiet_gap);
  RUN_TEST(test_heartbeat_survives_a_speaker_with_no_low_end);
  RUN_TEST(test_heartbeat_is_audible_below_full_volume);
  RUN_TEST(test_brightness_matches_what_each_recipe_promises);
  RUN_TEST(test_consecutive_blocks_join_without_a_seam);
  RUN_TEST(test_render_is_deterministic_for_a_given_seed);
  RUN_TEST(test_wav_header_is_well_formed);
  return UNITY_END();
}
