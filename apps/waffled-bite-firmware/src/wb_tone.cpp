#include "wb_tone.h"

#include <math.h>
#include <string.h>

#include "wb_synth.h" // WB_SAMPLE_RATE_HZ, wb_synth_gain

namespace
{

const float kFs = (float)WB_SAMPLE_RATE_HZ;
const float kTwoPi = 6.28318530718f;
const float kPi = 3.14159265359f;

// Every motif is two seconds long and then repeats. Two seconds is long
// enough to be a phrase rather than a beep, and short enough that the alarm
// reads as urgent-ish rather than ambient.
const float kPeriodSec = 2.0f;
const uint32_t kPeriod = (uint32_t)(kPeriodSec * kFs);

// The attack. A few milliseconds rather than zero, because a hard step onto a
// waveform is a click.
const float kAttackSec = 0.003f;

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

struct Recipe
{
  const Note *notes;
  int noteCount;
  const Partial *partials;
  int partialCount;
  float tau;    // decay time constant, seconds
  float makeup; // measured, see below
};

// ── the five recipes ───────────────────────────────────────────────────────
// Makeup gains are MEASURED, not derived — the same method the sound machine's
// recipes used. Rendering and reading back the real RMS is the only way these
// end up loudness-matched, because summed partials and overlapping decays
// don't compose analytically in any way worth trusting.
//
// All five are tuned to RMS ~0.19 over a full 20-second alarm, which puts them
// alongside the sound machine at full volume (white 0.24, fan 0.20) — an alarm
// quieter than the white noise it interrupts would be useless.

// A rising three-note figure, C5-E5-G5, with a soft bell's partials. The
// rise is what makes it read as "morning" rather than "alert".
const Partial kChimePartials[] = {{1.0f, 1.0f}, {2.0f, 0.50f}, {3.0f, 0.25f}};
const Note kChimeNotes[] = {{0.00f, 523.25f}, {0.45f, 659.25f}, {0.90f, 783.99f}};

// An arpeggio with a plucked string's harmonic series — more harmonics than
// the chime, decaying faster the higher they go.
const Partial kHarpPartials[] = {{1.0f, 1.0f}, {2.0f, 0.45f}, {3.0f, 0.22f}, {4.0f, 0.10f}};
const Note kHarpNotes[] = {
    {0.00f, 440.00f}, {0.35f, 554.37f}, {0.70f, 659.25f}, {1.05f, 880.00f}};

// INHARMONIC partials (2.00, 2.76, 5.40) — those ratios are what separate a
// bell from an organ. A harmonic stack at the same frequencies just sounds
// like a note; the clash is the timbre.
const Partial kBellPartials[] = {
    {1.0f, 1.0f}, {2.00f, 0.60f}, {2.76f, 0.40f}, {5.40f, 0.20f}};
const Note kBellNotes[] = {{0.00f, 587.33f}, {1.00f, 783.99f}};

// High, quick sparkles. Short decay and tight spacing, so it shimmers
// continuously rather than pulsing.
const Partial kTwinklePartials[] = {{1.0f, 1.0f}, {2.0f, 0.30f}};
const Note kTwinkleNotes[] = {{0.00f, 1046.50f}, {0.25f, 1318.51f}, {0.50f, 1567.98f},
                              {0.75f, 2093.00f}, {1.00f, 1567.98f}, {1.25f, 1318.51f},
                              {1.50f, 2093.00f}, {1.75f, 1046.50f}};

const Recipe kRecipes[] = {
    {kChimeNotes, 3, kChimePartials, 3, 0.35f, 0.4595f},   // SunriseChime
    {kHarpNotes, 4, kHarpPartials, 4, 0.40f, 0.3731f},     // SoftHarp
    {kBellNotes, 2, kBellPartials, 4, 0.50f, 0.4258f},     // GentleBells
    {NULL, 0, NULL, 0, 0.0f, 0.3479f},                     // OceanTide — noise, not notes
    {kTwinkleNotes, 8, kTwinklePartials, 2, 0.12f, 0.5307f}, // TwinkleStars
};

const Recipe &recipeFor(WbTone t) { return kRecipes[(int)t]; }

// Strikes a note into a free slot. Voices are never stolen: the pool is sized
// so a motif can't fill it, and dropping a strike is a far better failure than
// cutting a ringing note dead.
void strike(WbToneVoice *v, const Recipe &r, const Note &n)
{
  for (int i = 0; i < WB_TONE_VOICES; i++)
  {
    WbToneNoteVoice &nv = v->notes[i];
    if (nv.active) continue;

    nv.active = true;
    nv.partials = r.partialCount;
    for (int p = 0; p < r.partialCount; p++)
    {
      const float f = n.freq * r.partials[p].ratio;
      // Coupled-form ("magic circle") resonator. Stepping it is two multiplies
      // and two adds; k sets the frequency exactly, and starting at (1, 0)
      // makes the output a sine from zero — no click on the attack.
      nv.ok[p] = 2.0f * sinf(kPi * f / kFs);
      nv.ox[p] = 1.0f;
      nv.oy[p] = 0.0f;
      nv.oa[p] = r.partials[p].amp;
    }
    // env = (1 - attack) * decay, with both states stepped by a multiply.
    nv.attack = 1.0f;
    nv.decay = 1.0f;
    nv.ca = expf(-1.0f / (kAttackSec * kFs));
    nv.cd = expf(-1.0f / (r.tau * kFs));
    return;
  }
}

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
  v->nextNote = 0;
  for (int i = 0; i < WB_TONE_VOICES; i++) v->notes[i].active = false;
}

void wb_tone_render(WbToneVoice *v, int16_t *out, size_t frames, int volume)
{
  if (!v || !out) return;
  const float gain = wb_synth_gain(volume);
  const WbTone tone = (WbTone)v->tone;
  const Recipe &r = recipeFor(tone);

  for (size_t i = 0; i < frames; i++)
  {
    float s = 0.0f;

    if (tone == WbTone::OceanTide)
    {
      // xorshift, same generator the sound machine uses.
      v->rng ^= v->rng << 13;
      v->rng ^= v->rng >> 17;
      v->rng ^= v->rng << 5;
      const float white = ((float)(int32_t)v->rng / 2147483648.0f);
      // First difference = high-pass (+6 dB/octave), which throws away the
      // bottom end this speaker can't reproduce anyway. The memory lives in
      // the VOICE so consecutive blocks join seamlessly.
      const float hp = white - v->hpPrev;
      v->hpPrev = white;
      // A slow swell, floored well above zero so the alarm never goes properly
      // silent between waves. sqrtf is a single instruction where powf is a
      // call — same curve, a fraction of the cost.
      const float u = 0.5f - 0.5f * cosf(kTwoPi * (float)v->pos / (float)kPeriod);
      const float swell = 0.35f + 0.65f * (u * sqrtf(u));
      s = hp * swell * r.makeup;
    }
    else
    {
      // Strike whatever is due at this sample. `>=` rather than `==` so a
      // note can't be skipped, and nextNote resets with the motif.
      while (v->nextNote < r.noteCount &&
             v->pos >= (uint32_t)(r.notes[v->nextNote].at * kFs))
      {
        strike(v, r, r.notes[v->nextNote]);
        v->nextNote++;
      }

      for (int n = 0; n < WB_TONE_VOICES; n++)
      {
        WbToneNoteVoice &nv = v->notes[n];
        if (!nv.active) continue;

        nv.attack *= nv.ca;
        nv.decay *= nv.cd;
        // Below about -80 dBFS a note is done. Retiring it frees the slot and
        // stops it costing anything.
        if (nv.decay < 0.0001f)
        {
          nv.active = false;
          continue;
        }
        const float env = (1.0f - nv.attack) * nv.decay;

        float acc = 0.0f;
        for (int p = 0; p < nv.partials; p++)
        {
          nv.ox[p] -= nv.ok[p] * nv.oy[p];
          nv.oy[p] += nv.ok[p] * nv.ox[p];
          acc += nv.oa[p] * nv.oy[p];
        }
        s += acc * env;
      }
      s *= r.makeup;
    }

    float y = s * gain;
    if (y > 1.0f) y = 1.0f;
    if (y < -1.0f) y = -1.0f;
    out[i] = (int16_t)(y * 32767.0f);

    v->pos++;
    if (v->pos >= kPeriod)
    {
      v->pos = 0;
      v->nextNote = 0; // notes still ringing keep ringing — no click at the wrap
    }
  }
}
