// Audio output HAL — mirrors the wb_http / wb_wifi / wb_store split, so
// screens never learn which target they're running on.
//
//   wb_audio_esp32.cpp   I2S TX into the NS4168 amp + its enable pin
//   wb_audio_native.cpp  SDL2 audio callback (the desktop simulator)
//
// The sound itself comes from wb_synth (pure DSP, unit-tested); this layer is
// only responsible for getting those samples out of the box without clicking.
#pragma once

#include "wb_synth.h"

// Prepares the audio path. Safe to call once at boot; leaves the amp OFF and
// the output silent.
void wb_audio_init();

// Starts (or switches to) `sound` at `volume` (0-100), fading in. Calling this
// while something is already playing crossfades by way of a short fade-out.
void wb_audio_play(WbSound sound, int volume);

// Changes volume during playback, without restarting the sound.
void wb_audio_set_volume(int volume);

// Fades out and stops, then powers the amp down.
//
// The order matters and is the whole reason this isn't just "write zeros":
// the amp is only enabled once real samples are flowing, and disabled only
// after the fade has reached silence. Cutting the enable pin while the DAC is
// mid-waveform is an audible pop, and on a device that lives in a kid's
// bedroom a pop at lights-out is disqualifying.
void wb_audio_stop();

bool wb_audio_is_playing();
