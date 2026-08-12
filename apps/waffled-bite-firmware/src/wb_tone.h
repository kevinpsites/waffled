#pragma once
// Morning-alarm wake tones — the one-shot counterpart to wb_synth.h.
//
// Deliberately NOT folded into WbSound. The sound machine's recipes are
// endless textures with no structure; a wake tone is a short musical motif
// that repeats. Sharing one render contract would mean one of them fighting
// the other's assumptions, so they're parallel types that share the one thing
// they genuinely have in common: wb_synth_gain(), the volume curve. Decision
// D3 gives the alarm its own `alarm.volume`, and it must feel the same as the
// sound machine's slider at the same number — two curves on one device is how
// "50" comes to mean two different loudnesses.
//
// Like the sound machine, these are SYNTHESISED — no assets, no filesystem,
// no download. That's what makes the alarm work when the server is down,
// which is the whole point of a bedside device.
//
// == The constraint that matters ==
// The board's speaker (a 30x20mm YZ3020 cavity driver) has almost no output
// below roughly 300 Hz. Two sound-machine recipes shipped inaudible for
// exactly that reason before it was understood. Every tone here keeps its
// fundamental at 440 Hz or above, and test_alarm.cpp holds all five against a
// brightness floor so a bassy recipe can't reach hardware again.
#include <stddef.h>
#include <stdint.h>

// Birdsong is deliberately absent: it's the one tone in the parent app's
// picker that genuinely needs a recording, so it ships disabled alongside the
// sampled sounds (forest, lullaby) until phase 2.
enum class WbTone
{
  SunriseChime,
  SoftHarp,
  GentleBells,
  OceanTide,
  TwinkleStars,
};

// Accepts BOTH the display strings the parent app stores today ("Sunrise
// chime") and the stable keys it may migrate to ("sunriseChime").
//
// Accepting both is what keeps that migration (plan §5 gap 3, open question
// Q2) from having to be timed against a firmware release: existing rows work
// now, migrated rows work later, and no backfill has to land in lockstep.
// Returns false and leaves `*out` untouched for anything unrecognised.
bool wb_tone_parse(const char *name, WbTone *out);

// What to play when the stored tone isn't recognised. Note this is the
// OPPOSITE of the sound machine's rule, on purpose: an unknown sleep sound
// stays silent (a kid who asked for a lullaby is better served by nothing
// than by white noise), but an alarm that makes no noise has failed at its
// only job.
WbTone wb_tone_default(void);

// A motif is at most this many notes deep at once. Generous: the densest
// recipe (twinkle stars, 8 strikes in 2 s with a 0.12 s decay) never has more
// than about three ringing together.
#define WB_TONE_VOICES 8
#define WB_TONE_MAX_PARTIALS 4

// One ringing note.
//
// Each partial is a resonator stepped by multiply-and-add rather than a sinf()
// per sample, and the envelope is a pair of one-pole decays rather than two
// expf() calls. That isn't premature optimisation: the first version computed
// both analytically and sounded fine rendered to a WAV, but STARVED THE I2S
// DMA on the device and came out scratchy — roughly 18 sines and 12
// exponentials per sample, on a core that is also drawing the screen.
struct WbToneNoteVoice
{
  bool active;
  int partials;
  float ox[WB_TONE_MAX_PARTIALS], oy[WB_TONE_MAX_PARTIALS]; // resonator state
  float ok[WB_TONE_MAX_PARTIALS];                           // 2*sin(pi*f/fs)
  float oa[WB_TONE_MAX_PARTIALS];                           // partial amplitude
  float attack, decay;                                      // envelope state
  float ca, cd;                                             // envelope coefficients
};

struct WbToneVoice
{
  int tone;      // WbTone
  uint32_t pos;  // sample position within the repeating motif
  uint32_t rng;  // ocean tide's noise state — kept here so blocks join seamlessly
  float hpPrev;  // ocean tide's high-pass memory, for the same reason
  int nextNote;  // next strike due in this pass through the motif
  WbToneNoteVoice notes[WB_TONE_VOICES];
};

void wb_tone_init(WbToneVoice *v, WbTone tone);

// Renders `frames` mono samples at WB_SAMPLE_RATE_HZ. The motif repeats for
// as long as it's called, so the caller — not the DSP — decides when the
// alarm ends (D4: 20 seconds). `volume` is 0-100 through wb_synth_gain().
void wb_tone_render(WbToneVoice *v, int16_t *out, size_t frames, int volume);
