#include "wb_tone.h"

#include <math.h>
#include <string.h>

#include "wb_synth.h" // WB_SAMPLE_RATE_HZ, wb_synth_gain

namespace
{

const float kFs = (float)WB_SAMPLE_RATE_HZ;
const float kTwoPi = 6.28318530718f;

// Every motif is two seconds long and then repeats. Two seconds is long
// enough to be a phrase rather than a beep, and short enough that the alarm
// reads as urgent-ish rather than ambient.
const float kPeriodSec = 2.0f;
const uint32_t kPeriod = (uint32_t)(kPeriodSec * kFs);

// A struck-note envelope: near-instant attack, exponential decay. The attack
// is a few milliseconds rather than zero because a hard step onto a sine is a
// click, which is precisely the bug the sound machine's heartbeat had.
float struck(float t, float tau)
{
  if (t < 0.0f) return 0.0f;
  return (1.0f - expf(-t / 0.003f)) * expf(-t / tau);
}

struct Partial
{
  float ratio;
  float amp;
};

struct Note
{
  float at;   // seconds into the motif
  float freq; // Hz — never below 440, see the header
};

// Sums one note, counting BOTH this pass through the motif and the previous
// one. Without that second term a note still ringing when the motif wraps
// would be chopped to zero, putting a click every two seconds — audible, and
// exactly the failure mode the sound machine's end-of-envelope test was
// written for. Adding the previous period's tail makes the wrap continuous.
float ring(const Note &n, const Partial *partials, size_t np, float tau, float t)
{
  float acc = 0.0f;
  for (int pass = 0; pass < 2; pass++)
  {
    const float dt = t - n.at + (pass ? kPeriodSec : 0.0f);
    const float env = struck(dt, tau);
    if (env <= 0.0f) continue;
    for (size_t p = 0; p < np; p++)
      acc += partials[p].amp * env * sinf(kTwoPi * n.freq * partials[p].ratio * dt);
  }
  return acc;
}

float render_notes(const Note *notes, size_t nn, const Partial *partials, size_t np, float tau,
                   float t)
{
  float acc = 0.0f;
  for (size_t i = 0; i < nn; i++) acc += ring(notes[i], partials, np, tau, t);
  return acc;
}

// ── the five recipes ───────────────────────────────────────────────────────
// Makeup gains are MEASURED, not derived — the same method the sound machine's
// recipes used. Rendering and reading back the real RMS is the only way these
// end up loudness-matched, because summed partials and overlapping decays
// don't compose analytically in any way worth trusting. (First pass here was
// estimated by ear-math and came out 4.8 dB apart; these are the corrected
// numbers.)
//
// All five are tuned to RMS ~0.19 over a full 20-second alarm, which puts them
// alongside the sound machine at full volume (white 0.24, fan 0.20) — an alarm
// quieter than the white noise it interrupts would be useless. The target
// leaves every tone peaking below 0.88, so there's headroom before clipping.

// A rising three-note figure, C5-E5-G5, with a soft bell's partials. The
// rise is what makes it read as "morning" rather than "alert".
const Partial kChimePartials[] = {{1.0f, 1.0f}, {2.0f, 0.50f}, {3.0f, 0.25f}};
const Note kChimeNotes[] = {{0.00f, 523.25f}, {0.45f, 659.25f}, {0.90f, 783.99f}};
const float kChimeMakeup = 0.4635f;

// An arpeggio with a plucked string's harmonic series — more harmonics than
// the chime, decaying faster the higher they go.
const Partial kHarpPartials[] = {{1.0f, 1.0f}, {2.0f, 0.45f}, {3.0f, 0.22f}, {4.0f, 0.10f}};
const Note kHarpNotes[] = {
    {0.00f, 440.00f}, {0.35f, 554.37f}, {0.70f, 659.25f}, {1.05f, 880.00f}};
const float kHarpMakeup = 0.3757f;

// INHARMONIC partials (2.00, 2.76, 5.40) — those ratios are what separate a
// bell from an organ. A harmonic stack at the same frequencies just sounds
// like a note; the clash is the timbre.
const Partial kBellPartials[] = {
    {1.0f, 1.0f}, {2.00f, 0.60f}, {2.76f, 0.40f}, {5.40f, 0.20f}};
const Note kBellNotes[] = {{0.00f, 587.33f}, {1.00f, 783.99f}};
const float kBellMakeup = 0.4323f;

// High, quick sparkles. Short decay and tight spacing, so it shimmers
// continuously rather than pulsing.
const Partial kTwinklePartials[] = {{1.0f, 1.0f}, {2.0f, 0.30f}};
const Note kTwinkleNotes[] = {{0.00f, 1046.50f}, {0.25f, 1318.51f}, {0.50f, 1567.98f},
                              {0.75f, 2093.00f}, {1.00f, 1567.98f}, {1.25f, 1318.51f},
                              {1.50f, 2093.00f}, {1.75f, 1046.50f}};
const float kTwinkleMakeup = 0.5501f;

// The odd one out: noise rather than notes. A first-difference high-pass
// (+6 dB/octave) throws away the bottom end this speaker can't reproduce
// anyway, and a slow swell does the tide part. The swell floors at 0.35
// rather than 0 so the alarm never goes properly silent between waves.
const float kOceanMakeup = 0.3479f;

} // namespace

bool wb_tone_parse(const char *name, WbTone *out)
{
  if (!name || !out) return false;

  struct Entry
  {
    const char *display;
    const char *key;
    WbTone tone;
  };
  // Both spellings for each tone — see the header for why.
  static const Entry kTones[] = {
      {"Sunrise chime", "sunriseChime", WbTone::SunriseChime},
      {"Soft harp", "softHarp", WbTone::SoftHarp},
      {"Gentle bells", "gentleBells", WbTone::GentleBells},
      {"Ocean tide", "oceanTide", WbTone::OceanTide},
      {"Twinkle stars", "twinkleStars", WbTone::TwinkleStars},
  };

  for (size_t i = 0; i < sizeof(kTones) / sizeof(kTones[0]); i++)
  {
    if (strcmp(name, kTones[i].display) == 0 || strcmp(name, kTones[i].key) == 0)
    {
      *out = kTones[i].tone;
      return true;
    }
  }
  return false;
}

WbTone wb_tone_default(void) { return WbTone::SunriseChime; }

void wb_tone_init(WbToneVoice *v, WbTone tone)
{
  if (!v) return;
  v->tone = (int)tone;
  v->pos = 0;
  v->rng = 0x1234567u; // fixed: renders must be reproducible, as for wb_synth
  v->hpPrev = 0.0f;
}

void wb_tone_render(WbToneVoice *v, int16_t *out, size_t frames, int volume)
{
  if (!v || !out) return;
  const float gain = wb_synth_gain(volume);
  if (gain <= 0.0f)
  {
    memset(out, 0, frames * sizeof(int16_t));
    v->pos = (uint32_t)((v->pos + frames) % kPeriod);
    return;
  }

  const WbTone tone = (WbTone)v->tone;
  for (size_t i = 0; i < frames; i++)
  {
    const float t = (float)v->pos / kFs;
    float s = 0.0f;

    switch (tone)
    {
    case WbTone::SunriseChime:
      s = render_notes(kChimeNotes, sizeof(kChimeNotes) / sizeof(kChimeNotes[0]),
                       kChimePartials, sizeof(kChimePartials) / sizeof(kChimePartials[0]),
                       0.35f, t) *
          kChimeMakeup;
      break;
    case WbTone::SoftHarp:
      s = render_notes(kHarpNotes, sizeof(kHarpNotes) / sizeof(kHarpNotes[0]), kHarpPartials,
                       sizeof(kHarpPartials) / sizeof(kHarpPartials[0]), 0.40f, t) *
          kHarpMakeup;
      break;
    case WbTone::GentleBells:
      s = render_notes(kBellNotes, sizeof(kBellNotes) / sizeof(kBellNotes[0]), kBellPartials,
                       sizeof(kBellPartials) / sizeof(kBellPartials[0]), 0.50f, t) *
          kBellMakeup;
      break;
    case WbTone::TwinkleStars:
      s = render_notes(kTwinkleNotes, sizeof(kTwinkleNotes) / sizeof(kTwinkleNotes[0]),
                       kTwinklePartials,
                       sizeof(kTwinklePartials) / sizeof(kTwinklePartials[0]), 0.12f, t) *
          kTwinkleMakeup;
      break;
    case WbTone::OceanTide:
    {
      // xorshift, same generator the sound machine uses.
      v->rng ^= v->rng << 13;
      v->rng ^= v->rng >> 17;
      v->rng ^= v->rng << 5;
      const float white = ((float)(int32_t)v->rng / 2147483648.0f);
      // First difference = high-pass. The memory lives in the VOICE, not in a
      // static: a static would be shared between voices and would carry over
      // between renders, which breaks both determinism and the guarantee that
      // consecutive blocks join seamlessly.
      const float hp = white - v->hpPrev;
      v->hpPrev = white;
      const float swell = 0.35f + 0.65f * powf(0.5f - 0.5f * cosf(kTwoPi * t / kPeriodSec), 1.5f);
      s = hp * swell * kOceanMakeup;
      break;
    }
    }

    float y = s * gain;
    if (y > 1.0f) y = 1.0f;
    if (y < -1.0f) y = -1.0f;
    out[i] = (int16_t)(y * 32767.0f);

    v->pos++;
    if (v->pos >= kPeriod) v->pos = 0;
  }
}
