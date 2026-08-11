#include "wb_synth.h"

#include <math.h>
#include <string.h>

namespace
{

const float kPi = 3.14159265358979f;
const float kTwoPi = 2.0f * kPi;
const float kFs = (float)WB_SAMPLE_RATE_HZ;

// Per-recipe makeup gains, normalising each sound onto a common loudness so
// that switching sounds at 2am doesn't change how loud the room is.
//
// These are MEASURED, not derived — `render_wav --measure` prints each
// recipe's raw RMS and peak, and these numbers put them all near -13 dBFS
// with headroom left. Re-run it after touching any recipe.
//
//   recipe   raw rms   crest factor   lands at
//   white     0.481        2.1          0.24
//   rain      0.504        3.7          0.20
//   fan       0.087        3.9          0.20
//   ocean     0.128        5.5          0.155
//
// Ocean sits lower on purpose. Its swell rides band-passed noise, which is
// near-Gaussian and so peaks at ~5.5x its own RMS; matching the others'
// loudness would drive those peaks into the clamp. Uniform-ish white noise
// gets away with far more because its crest factor is barely 2.
const float kMakeupWhite = 0.499f;
const float kMakeupRain = 0.397f;
const float kMakeupFan = 2.292f;
const float kMakeupOcean = 1.207f;

// xorshift32. Seeded and carried in the struct rather than using rand(),
// because "same seed, same samples" is what makes the DSP testable at all.
inline uint32_t xorshift(uint32_t &s)
{
  s ^= s << 13;
  s ^= s >> 17;
  s ^= s << 5;
  return s;
}

// Uniform white noise in [-1, 1).
inline float noise(uint32_t &s)
{
  return (float)(int32_t)xorshift(s) * (1.0f / 2147483648.0f);
}

// Coefficient for a one-pole lowpass at `hz`: y += a * (x - y).
inline float lpCoeff(float hz)
{
  return 1.0f - expf(-kTwoPi * hz / kFs);
}

inline void advance(float &phase, float inc)
{
  phase += inc;
  if (phase >= kTwoPi) phase -= kTwoPi;
}

// One heart thump: a low sine under a fast-attack / short-decay envelope.
// The attack is not instant — a step straight to full amplitude reads as a
// click rather than a thump.
inline float thump(float samplesSinceOnset, float hz)
{
  if (samplesSinceOnset < 0.0f) return 0.0f;
  const float t = samplesSinceOnset / kFs;
  if (t > 0.35f) return 0.0f; // fully decayed; skip the transcendentals
  const float env = (1.0f - expf(-t / 0.004f)) * expf(-t / 0.055f);
  return env * sinf(kTwoPi * hz * t);
}

inline int16_t toPcm(float v)
{
  // The makeup gains are tuned to leave headroom, but a hard clamp is the
  // difference between an unexpectedly hot sample and a wraparound crack in a
  // sleeping kid's room.
  if (v > 1.0f) v = 1.0f;
  if (v < -1.0f) v = -1.0f;
  return (int16_t)lrintf(v * 32767.0f);
}

} // namespace

bool wb_synth_parse(const char *tone, WbSound *out)
{
  if (tone == NULL || out == NULL) return false;
  if (strcmp(tone, "white") == 0) { *out = WbSound::White; return true; }
  if (strcmp(tone, "ocean") == 0) { *out = WbSound::Ocean; return true; }
  if (strcmp(tone, "rain") == 0) { *out = WbSound::Rain; return true; }
  if (strcmp(tone, "fan") == 0) { *out = WbSound::Fan; return true; }
  if (strcmp(tone, "heartbeat") == 0) { *out = WbSound::Heartbeat; return true; }
  return false; // "lullaby"/"forest" are sampled (phase 2), and unknown stays silent
}

float wb_synth_gain(int volume)
{
  if (volume <= 0) return 0.0f;
  if (volume >= 100) return 1.0f;
  // -40 dB at the bottom of the useful range, straight line in dB. Volume 50
  // lands at -20 dB, which is the point: loudness is logarithmic, so a linear
  // slider would put every usable sleep level in its bottom few percent.
  return powf(10.0f, (float)(volume - 100) * 0.02f);
}

void wb_synth_init(WbSynth *s, WbSound sound, uint32_t seed)
{
  memset(s, 0, sizeof(*s));
  s->sound = (int)sound;
  s->rng = seed ? seed : 1u; // xorshift is stuck at zero

  switch (sound)
  {
  case WbSound::White:
    // Raw white noise is harsh and fatiguing. A gentle shelf keeps it
    // recognisably "white" while taking the edge off the very top.
    s->a1 = lpCoeff(6000.0f);
    s->makeup = kMakeupWhite;
    break;
  case WbSound::Ocean:
    s->a1 = lpCoeff(1300.0f); // upper edge of the band
    s->a2 = lpCoeff(200.0f);  // lower edge, subtracted back out
    s->makeup = kMakeupOcean;
    break;
  case WbSound::Rain:
    s->a1 = lpCoeff(1500.0f); // what gets subtracted to leave hiss
    s->makeup = kMakeupRain;
    break;
  case WbSound::Fan:
    s->a1 = lpCoeff(420.0f); // three cascaded poles here = a dull rumble
    s->makeup = kMakeupFan;
    break;
  case WbSound::Heartbeat:
    s->makeup = 1.0f; // pulses are shaped by their envelope, not normalised
    break;
  }
  s->dropWait = 1;
  s->dropDecay = expf(-1.0f / (0.028f * kFs));
}

void wb_synth_render(WbSynth *s, int16_t *out, size_t count, int volume)
{
  const float g = wb_synth_gain(volume);
  const WbSound sound = (WbSound)s->sound;

  for (size_t i = 0; i < count; i++)
  {
    float y = 0.0f;

    switch (sound)
    {
    case WbSound::White:
    {
      const float x = noise(s->rng);
      s->lp[0] += s->a1 * (x - s->lp[0]);
      y = s->lp[0] * s->makeup;
      break;
    }

    case WbSound::Fan:
    {
      // Three cascaded one-poles turn white noise brown-ish: a low, wide
      // rumble with no hiss left in it, which is what a box fan across a
      // room actually sounds like.
      const float x = noise(s->rng);
      s->lp[0] += s->a1 * (x - s->lp[0]);
      s->lp[1] += s->a1 * (s->lp[0] - s->lp[1]);
      s->lp[2] += s->a1 * (s->lp[1] - s->lp[2]);
      advance(s->phase, kTwoPi * 118.0f / kFs); // motor hum
      y = s->lp[2] * s->makeup + 0.035f * sinf(s->phase);
      break;
    }

    case WbSound::Rain:
    {
      // Hiss = the noise minus its own lowpass, i.e. a one-pole highpass.
      const float x = noise(s->rng);
      s->lp[0] += s->a1 * (x - s->lp[0]);
      const float hiss = x - s->lp[0];

      // Individual droplets on top, otherwise it's just shaped static.
      if (s->dropWait == 0)
      {
        s->dropAmp = 0.25f + 0.55f * fabsf(noise(s->rng));
        s->dropInc = kTwoPi * (600.0f + 1800.0f * fabsf(noise(s->rng))) / kFs;
        s->dropPhase = 0.0f;
        s->dropWait = 250u + (xorshift(s->rng) % 900u);
      }
      s->dropWait--;
      advance(s->dropPhase, s->dropInc);
      s->dropAmp *= s->dropDecay;

      y = hiss * s->makeup + s->dropAmp * sinf(s->dropPhase) * 0.30f;
      break;
    }

    case WbSound::Ocean:
    {
      // Band-passed noise (a lowpass minus a lower lowpass) under a slow
      // swell. ~7 s a wave, which is roughly real surf and slow enough to
      // breathe with rather than count.
      const float x = noise(s->rng);
      s->lp[0] += s->a1 * (x - s->lp[0]);
      s->hp += s->a2 * (s->lp[0] - s->hp);
      const float band = s->lp[0] - s->hp;

      advance(s->phase, kTwoPi * 0.14f / kFs);
      const float u = 0.5f * (1.0f - cosf(s->phase));
      const float swell = 0.22f + 0.78f * u * u; // squared = a sharper crest

      y = band * swell * s->makeup;
      break;
    }

    case WbSound::Heartbeat:
    {
      // 60 bpm, lub then dub ~0.32 s later and quieter. The gaps are truly
      // silent by design — that's what makes it read as a heartbeat.
      const float t = (float)s->beat;
      y = thump(t, 52.0f) * 0.80f + thump(t - 0.32f * kFs, 44.0f) * 0.50f;
      if (++s->beat >= (uint32_t)WB_SAMPLE_RATE_HZ) s->beat = 0;
      break;
    }
    }

    out[i] = toPcm(y * g);
  }
}
