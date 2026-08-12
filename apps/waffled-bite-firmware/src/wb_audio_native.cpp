// Desktop backend for wb_audio.h — SDL2 audio, so the sound machine can be
// heard in the simulator with no board attached.
//
// SDL2 is already a dependency here (LovyanGFX's SDL panel draws the display),
// so this costs an audio callback and nothing else.
#if !defined(ARDUINO)

#include "wb_audio.h"

#include <SDL.h>
#include <string.h>

namespace
{

SDL_AudioDeviceID s_dev = 0;
WbSynth s_synth;
bool s_playing = false;
int s_current = -1; // which sound s_synth was initialised for
int s_volume = 50;
float s_fade = 0.0f;

// Same 400 ms fade as the device, for the same anti-pop reason — desktop
// speakers click too, and tuning fades against a sound that doesn't fade
// would be misleading.
const float kFadeStep = 1.0f / (float)(WB_SAMPLE_RATE_HZ * 0.4f);

void fill(void *, Uint8 *stream, int len)
{
  int16_t *out = (int16_t *)stream;
  const int frames = len / (int)sizeof(int16_t);

  if (!s_playing && s_fade <= 0.0f)
  {
    memset(stream, 0, (size_t)len);
    return;
  }

  wb_synth_render(&s_synth, out, (size_t)frames, s_volume);
  for (int i = 0; i < frames; i++)
  {
    s_fade += s_playing ? kFadeStep : -kFadeStep;
    if (s_fade > 1.0f) s_fade = 1.0f;
    if (s_fade < 0.0f) s_fade = 0.0f;
    out[i] = (int16_t)((float)out[i] * s_fade);
  }
}

} // namespace

void wb_audio_init()
{
  if (s_dev) return;
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
  if (!s_playing || (int)sound != s_current)
  {
    wb_synth_init(&s_synth, sound, 0x5EEDu);
    s_current = (int)sound;
  }
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

void wb_audio_stop()
{
  if (!s_dev) return;
  SDL_LockAudioDevice(s_dev);
  s_playing = false;
  SDL_UnlockAudioDevice(s_dev);
}

bool wb_audio_is_playing() { return s_playing || s_fade > 0.0f; }

#endif // !ARDUINO
