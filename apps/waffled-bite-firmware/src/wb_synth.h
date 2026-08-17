// Sound-machine synthesis — pure DSP, no platform, no LVGL, no I/O.
//
// This is the one half of the audio feature that can be unit-tested in the
// classic TDD sense (see test/test_synth), and it is deliberately the half
// that decides what the device actually SOUNDS like. `wb_audio_*` (the I2S /
// SDL plumbing that consumes this) is thin by comparison.
//
// Everything here generates its sound from scratch, sample by sample — there
// are no audio assets on the device and no streaming from the server. See
// docs/product/waffled-bites-audio-plan.md §3.1/§3.2 for why.
#pragma once

#include <stddef.h>
#include <stdint.h>

// The whole audio path runs at this rate, 16-bit mono. This is a decision,
// not a default: the board's included cavity speaker is a 30x20 mm 4 ohm
// driver that reproduces nothing meaningful above ~10 kHz, so 22.05 kHz
// (11 kHz Nyquist) spends no cycles or PSRAM on band the hardware throws
// away, and it's a standard rate the I2S clock divider hits exactly.
#define WB_SAMPLE_RATE_HZ 22050

// The five sounds phase 1 can synthesise. The server's sound list also has
// `lullaby` and `forest`, which need real recordings and are phase 2 — those
// are NOT in this enum, and wb_synth_parse() rejects them, on purpose.
enum class WbSound
{
  White,     // "white" — shelved white noise
  Ocean,     // "ocean" — band-passed noise under a slow swell
  Rain,      // "rain"  — high-passed hiss plus droplet transients
  Fan,       // "fan"   — brown-ish noise plus a low motor hum
  Heartbeat, // "heartbeat" — two enveloped low sine thumps at ~60 bpm
};

// Maps a sound key onto a synthesisable sound. Mind the naming: the key
// arrives on the wire as `settings.sound.sound` (yes, nested under its own
// name) and `wb_state_from_json` copies it into `WbSoundSettings.tone`, so
// the JSON key and the C field disagree — feed this the struct's `.tone`.
// Returns false — leaving *out untouched — for the
// phase-2 sampled sounds and for anything unrecognised, so a server that
// learns a new sound before the firmware does simply stays silent rather than
// playing something wrong.
bool wb_synth_parse(const char *tone, WbSound *out);

// Maps the 0-100 volume the parent sets onto a linear gain. Deliberately a
// log curve, over a 24 dB range tuned to this device's speaker: a linear ramp
// spends most of its travel in a range that all sounds the same, while too
// wide a log range leaves the middle of the slider inaudible. Volume 0 is
// exactly silent. See wb_synth.cpp for why 24 and not 40.
float wb_synth_gain(int volume);

// Synthesis state. POD, no heap, no destructor — this lives in a static so
// the audio task never allocates. Treat the fields as private.
struct WbSynth
{
  int sound;
  uint32_t rng; // xorshift32 state — seeded, never bare rand()
  float a1, a2; // one-pole filter coefficients, precomputed by init
  float makeup; // per-recipe gain, tuned so the sounds are loudness-matched
  float lp[3];  // cascaded one-pole lowpass state
  float hp;     // one-pole state used as the low leg of a bandpass

  // Oscillators accumulate PHASE and wrap it, rather than deriving phase from
  // an absolute sample count. A float sample counter would run out of mantissa
  // after ~13 minutes at 22.05 kHz and the slow LFOs would start stepping
  // instead of sliding — which matters a great deal for something that is
  // supposed to run all night.
  float phase; // fan's motor hum, or ocean's swell (never both at once)
  uint32_t beat; // heartbeat position within the current beat, in samples

  float dropAmp, dropPhase, dropInc, dropDecay; // rain droplets
  uint32_t dropWait;
};

// Prepares `s` to generate `sound`. The same seed always produces the same
// samples, which is what makes this testable.
void wb_synth_init(WbSynth *s, WbSound sound, uint32_t seed);

// Renders `count` mono samples at `volume` (0-100) into `out`.
//
// Successive calls continue seamlessly from wherever the previous one
// stopped, so the caller can render in whatever block size its ring buffer
// wants without a click at every boundary. That property is what lets this
// play for eight hours without a loop seam — there is no loop.
void wb_synth_render(WbSynth *s, int16_t *out, size_t count, int volume);
