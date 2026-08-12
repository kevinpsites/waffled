// Desktop backend for wb_audio.h — SDL2 audio, so the sound machine can be
// heard in the simulator with no board attached.
//
// SDL2 is already a dependency here (LovyanGFX's SDL panel draws the display),
// so this costs an audio callback and nothing else.
#if !defined(ARDUINO)

#include "wb_audio.h"

#include <SDL.h>
#include <string.h>

#include "wb_audio_seq.h"

namespace
{

SDL_AudioDeviceID s_dev = 0;
WbSynth s_synth;
WbToneVoice s_tone;
WbAudioSeq s_seq;
bool s_playing = false;
bool s_alarm = false;
bool s_restart = false;
int s_current = -1; // which sound s_synth was initialised for
int s_wantTone = (int)WbTone::SunriseChime;
int s_volume = 50;
int s_toneVolume = 80;
float s_fade = 0.0f;

// Same 400 ms fade as the device, for the same anti-pop reason — desktop
// speakers click too, and tuning fades against a sound that doesn't fade
// would be misleading.
const float kFadeStep = 1.0f / (float)(WB_SAMPLE_RATE_HZ * 0.4f);

// Drives the same phase machine the device does (wb_audio_seq), so the
// simulator's behaviour — including the whole D4 alarm sequence — matches the
// board rather than being a second, subtly different implementation.
void fill(void *, Uint8 *stream, int len)
{
  int16_t *out = (int16_t *)stream;
  const int frames = len / (int)sizeof(int16_t);

  const WbAudioSeqOut o =
      wb_audio_seq_step(&s_seq, s_playing, s_alarm, s_restart, (uint32_t)frames, kFadeStep);
  if (o.alarmDone) s_alarm = false;

  if (o.idle)
  {
    memset(stream, 0, (size_t)len);
    return;
  }

  // Re-seeding here rather than in wb_audio_play, so the simulator runs the
  // SAME crossfade the device does. It used to re-seed in the caller, which
  // meant the simulator could not reproduce a sound-change bug on the board at
  // all — and that is exactly how one got missed.
  if (o.initSound)
  {
    wb_synth_init(&s_synth, (WbSound)s_current, 0x5EEDu);
    s_restart = false;
  }
  if (o.initTone) wb_tone_init(&s_tone, (WbTone)s_wantTone);

  if (o.tone)
    wb_tone_render(&s_tone, out, (size_t)frames, s_toneVolume);
  else
    wb_synth_render(&s_synth, out, (size_t)frames, s_volume);

  for (int i = 0; i < frames; i++)
  {
    s_fade += o.falling ? -kFadeStep : kFadeStep;
    if (s_fade > 1.0f) s_fade = 1.0f;
    if (s_fade < 0.0f) s_fade = 0.0f;
    out[i] = (int16_t)((float)out[i] * s_fade);
  }
}

} // namespace

void wb_audio_init()
{
  if (s_dev) return;
  wb_audio_seq_init(&s_seq);
  if (SDL_InitSubSystem(SDL_INIT_AUDIO) != 0) return;

  SDL_AudioSpec want;
  SDL_zero(want);
  want.freq = WB_SAMPLE_RATE_HZ;
  want.format = AUDIO_S16SYS;
  want.channels = 1;
  want.samples = 512;
  want.callback = fill;

  SDL_AudioSpec got;
  s_dev = SDL_OpenAudioDevice(NULL, 0, &want, &got, 0);
  if (s_dev) SDL_PauseAudioDevice(s_dev, 0);
}

void wb_audio_play(WbSound sound, int volume)
{
  if (!s_dev) return;
  SDL_LockAudioDevice(s_dev);
  // Only re-seed the synth when the sound actually changes. main.cpp calls
  // this on EVERY poll (~5s) to keep playback in step with settings, and
  // re-initialising each time restarts every slow LFO from zero — ocean's ~7s
  // swell could never reach its crest, and the heartbeat would never advance
  // past its first beat. The simulator is exactly where the plan says these
  // recipes get judged by ear, so silently rebuilding state there is worse
  // than a cosmetic bug.
  //
  // The re-seed itself happens in the audio callback at the bottom of the
  // fade (see fill's initSound) — this only records that one is due.
  const bool changing = s_playing && (int)sound != s_current;
  s_current = (int)sound;
  if (changing) s_restart = true;
  s_volume = volume;
  s_playing = true;
  SDL_UnlockAudioDevice(s_dev);
}

void wb_audio_set_volume(int volume)
{
  if (!s_dev) return;
  SDL_LockAudioDevice(s_dev);
  s_volume = volume;
  SDL_UnlockAudioDevice(s_dev);
}

void wb_audio_alarm(WbTone tone, int volume)
{
  if (!s_dev) return;
  SDL_LockAudioDevice(s_dev);
  s_wantTone = (int)tone;
  s_toneVolume = volume;
  s_alarm = true;
  SDL_UnlockAudioDevice(s_dev);
}

bool wb_audio_alarm_active() { return s_alarm; }

void wb_audio_alarm_dismiss()
{
  if (!s_dev) return;
  SDL_LockAudioDevice(s_dev);
  s_alarm = false;
  SDL_UnlockAudioDevice(s_dev);
}

void wb_audio_stop()
{
  if (!s_dev) return;
  SDL_LockAudioDevice(s_dev);
  s_playing = false;
  s_alarm = false; // cancels a ringing alarm — see the header
  SDL_UnlockAudioDevice(s_dev);
}

bool wb_audio_is_playing() { return s_seq.phase != WbAudioPhase::Idle; }

#endif // !ARDUINO
