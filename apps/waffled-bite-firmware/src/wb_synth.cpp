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
//   recipe      lands at rms   peak
//   white           0.240       0.49
//   fan             0.200       0.84
//   rain            0.179       0.63
//   ocean           0.155       0.86
//   heartbeat       0.141       0.86
//
// Ocean sits lower on purpose. Its swell rides band-passed noise, which is
// near-Gaussian and so peaks at ~5.5x its own RMS; matching the others'
// loudness would drive those peaks into the clamp. Uniform-ish white noise
// gets away with far more because its crest factor is barely 2.
//
// Heartbeat is peak-limited rather than RMS-limited, being a pulse: its
// envelope is shaped to carry as much energy as it can under the same peak,
// because a fast spike hits full scale while still being too quiet to hear.
const float kMakeupWhite = 0.499f;
const float kMakeupRain = 0.397f;
const float kMakeupFan = 1.349f;
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

// One heart thump: a harmonic stack under a fast-attack / short-decay
// envelope. The attack is not instant — a step straight to full amplitude
// reads as a click rather than a thump.
//
// Why a stack rather than the single low sine this used to be: the device's
// speaker is a 30x20mm cavity driver with essentially no output below a couple
// of hundred Hz, so the original 52 Hz fundamental was flat-out INAUDIBLE on
// real hardware — confirmed on the board, not theorised. Putting most of the
// energy in the 2nd/3rd/5th harmonics gives the driver something it can
// actually move, while the ear still infers the low pitch from the harmonic
// series (the "missing fundamental" effect).
//
// The rhythm is doing most of the work anyway: a lub-dub at 60 bpm reads as a
// heartbeat almost regardless of timbre.
inline float thump(float samplesSinceOnset, float hz)
{
  if (samplesSinceOnset < 0.0f) return 0.0f;
  const float t = samplesSinceOnset / kFs;
  // Skip the transcendentals once the tail is inaudible — but not a moment
  // before. At 0.35s (where this used to cut) the envelope is still at ~4%,
  // so the output stepped straight to zero and clicked once a second, right
  // in the quiet gap. By 0.85s it's under -60 dBFS, which truncates silently.
  if (t > 0.85f) return 0.0f;
  // Attack is slow enough, and decay long enough, that the thump carries real
  // energy rather than being a spike. A pulse is PEAK-limited, so a fast spike
  // hits full scale while staying too quiet to hear — which is why this was
  // only audible with the volume at 100%.
  const float env = (1.0f - expf(-t / 0.010f)) * expf(-t / 0.110f);
  const float w = kTwoPi * hz * t;
  const float tone = 0.50f * sinf(w)          //  fundamental — for real speakers
                     + 0.70f * sinf(2.0f * w) //  the ones a small driver
                     + 0.50f * sinf(3.0f * w) //  can actually reproduce
                     + 0.25f * sinf(5.0f * w);
  return env * tone * 0.45f;
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
  // Straight line in dB, because loudness is logarithmic and a linear slider
  // would cram every usable sleep level into its bottom few percent.
  //
  // The RANGE is 24 dB, not the 40 dB this started as. 40 dB is right for
  // headphones and wrong for this hardware: it put volume 50 at just 10%
  // amplitude, and on a 30x20mm driver that is inaudible — the fan and
  // heartbeat only became usable above 75% on the slider. 24 dB keeps a real
  // curve while leaving the middle of the slider actually useful.
  return powf(10.0f, (float)(volume - 100) * 0.012f);
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
    s->a1 = lpCoeff(900.0f); // two cascaded poles here = dull, but audible
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
      // Two cascaded one-poles: still clearly duller than white noise (no
      // hiss), but centred where the speaker can actually move air.
      //
      // This was three poles at 420 Hz, which measured beautifully and was
      // nearly inaudible on the device — almost all of its energy sat below
      // the driver's usable range, so "box fan" needed 75%+ on the slider to
      // be heard at all. A small cavity driver does NOT flatter brown noise;
      // it simply cannot reproduce it.
      const float x = noise(s->rng);
      s->lp[0] += s->a1 * (x - s->lp[0]);
      s->lp[1] += s->a1 * (s->lp[0] - s->lp[1]);
      // Motor hum, with its 2nd harmonic — the 120 Hz fundamental alone is
      // below what this speaker reproduces, so the harmonic carries it.
      advance(s->phase, kTwoPi * 120.0f / kFs);
      const float hum = 0.018f * sinf(s->phase) + 0.030f * sinf(2.0f * s->phase);
      y = s->lp[1] * s->makeup + hum;
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
      y = thump(t, 110.0f) * 1.76f + thump(t - 0.32f * kFs, 88.0f) * 1.14f;
      if (++s->beat >= (uint32_t)WB_SAMPLE_RATE_HZ) s->beat = 0;
      break;
    }
    }

    out[i] = toPcm(y * g);
  }
}
