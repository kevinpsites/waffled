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
#include "wb_tone.h"

// Prepares the audio path. Safe to call once at boot; leaves the amp OFF and
// the output silent.
void wb_audio_init();

// Starts (or switches to) `sound` at `volume` (0-100), fading in. Calling this
// while something is already playing crossfades by way of a short fade-out.
void wb_audio_play(WbSound sound, int volume);

// Changes volume during playback, without restarting the sound.
void wb_audio_set_volume(int volume);

// Fires the morning alarm (decision D4): the sound machine fades down, `tone`
// plays for WB_ALARM_DURATION_SEC at its OWN volume, and then playback is
// handed back exactly where it left off.
//
// The alarm takes ownership of the output while it runs — wb_audio_play() and
// wb_audio_stop() still record what the sound machine should be doing, but
// nothing acts on them until the tone finishes. That's deliberate: main.cpp
// reconciles playback with settings every poll, and without it the tone would
// end up with white noise playing underneath it. See wb_audio_seq.h.
//
// Resumes only what was ACTUALLY playing when the alarm fired. If the device
// was silent, the tone plays alone and it goes back to silence — an alarm must
// never switch the sound machine on.
void wb_audio_alarm(WbTone tone, int volume);

bool wb_audio_alarm_active();

// Ends a ringing alarm early — what the on-screen "Stop" button calls.
//
// NOT the same as wb_audio_stop(): this cancels only the alarm, so the sound
// machine still fades back in if it was playing. Stopping outright would
// silence the room as a side effect of dismissing an alarm, which is not what
// tapping "Stop" on an alarm means.
void wb_audio_alarm_dismiss();

// Fades out and stops, then powers the amp down. Also CANCELS a running alarm
// — this is what silences a device that's been unpaired, which has no UI left
// to reach.
//
// The order matters and is the whole reason this isn't just "write zeros":
// the amp is only enabled once real samples are flowing, and disabled only
// after the fade has reached silence. Cutting the enable pin while the DAC is
// mid-waveform is an audible pop, and on a device that lives in a kid's
// bedroom a pop at lights-out is disqualifying.
void wb_audio_stop();

bool wb_audio_is_playing();
