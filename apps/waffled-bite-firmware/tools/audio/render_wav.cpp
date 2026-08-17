// Renders wb_synth's sounds to WAV files you can listen to on a laptop,
// before any hardware is involved.
//
// HOST-ONLY — this is not part of either firmware build. It exists so the
// synthesis recipes can be judged by ear (which is the only way to judge
// them) without a flash cycle. What it writes is bit-for-bit what the device
// will push to I2S at the same volume, so if it sounds wrong here it will
// sound wrong there.
//
// Covers the morning alarm's wake tones as well as the sound machine — those
// get judged by ear too, and a laptop is the only way to tell "the recipe is
// wrong" apart from "the device is struggling to play it".
//
//   Build:  clang++ -std=c++14 -O2 -Isrc tools/audio/render_wav.cpp \
//                   src/wb_synth.cpp src/wb_tone.cpp -o /tmp/wb_render
//   Write:  /tmp/wb_render <output-dir> [seconds]
//   Check:  /tmp/wb_render --measure     (levels only, writes nothing)
//
// Deliberately writes NOTHING into the repo: phase 1 ships zero audio assets
// (audio plan §3.2), and committed .wav files would read like shipped assets
// to the next person who opens the tree.
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#include "wb_synth.h"
#include "wb_tone.h"
#include "wb_wav.h"

namespace
{

struct Entry
{
  const char *key;
  WbSound sound;
};

const Entry kSounds[] = {
    {"white", WbSound::White},
    {"ocean", WbSound::Ocean},
    {"rain", WbSound::Rain},
    {"fan", WbSound::Fan},
    {"heartbeat", WbSound::Heartbeat},
};
const int kSoundCount = 5;

struct ToneEntry
{
  const char *key;
  WbTone tone;
};

const ToneEntry kTones[] = {
    {"tone-sunriseChime", WbTone::SunriseChime},
    {"tone-softHarp", WbTone::SoftHarp},
    {"tone-gentleBells", WbTone::GentleBells},
    {"tone-oceanTide", WbTone::OceanTide},
    {"tone-twinkleStars", WbTone::TwinkleStars},
};
const int kToneCount = 5;

std::vector<int16_t> renderTone(WbTone tone, size_t total, int volume)
{
  std::vector<int16_t> pcm(total);
  WbToneVoice v;
  wb_tone_init(&v, tone);
  const size_t block = 512;
  for (size_t i = 0; i < total; i += block)
  {
    const size_t n = (i + block <= total) ? block : (total - i);
    wb_tone_render(&v, pcm.data() + i, n, volume);
  }
  return pcm;
}

// Renders in blocks on purpose: it exercises the same continue-from-where-you-
// stopped path the device's ring buffer will use, so a seam bug shows up in
// the preview instead of at 2am.
std::vector<int16_t> renderSound(WbSound sound, size_t total, int volume)
{
  std::vector<int16_t> pcm(total);
  WbSynth s;
  wb_synth_init(&s, sound, 0x5EEDu);
  const size_t block = 512;
  for (size_t i = 0; i < total; i += block)
  {
    const size_t n = (i + block <= total) ? block : (total - i);
    wb_synth_render(&s, pcm.data() + i, n, volume);
  }
  return pcm;
}

void measure(const std::vector<int16_t> &pcm, double *rmsOut, double *peakOut)
{
  double acc = 0.0, peak = 0.0;
  for (size_t i = 0; i < pcm.size(); i++)
  {
    const double v = pcm[i] / 32767.0;
    acc += v * v;
    if (fabs(v) > peak) peak = fabs(v);
  }
  *rmsOut = sqrt(acc / (double)pcm.size());
  *peakOut = peak;
}

} // namespace

int main(int argc, char **argv)
{
  const bool measureOnly = (argc > 1 && strcmp(argv[1], "--measure") == 0);
  // Clamped: atoi returns 0 for junk, and a 0-length render writes a WAV with
  // a valid header and no audio — which looks like the synth broke.
  int wanted = (argc > 2 && !measureOnly) ? atoi(argv[2]) : 20;
  if (wanted < 1) wanted = 20;
  if (wanted > 600) wanted = 600;
  const size_t seconds = (size_t)wanted;
  const size_t total = (size_t)WB_SAMPLE_RATE_HZ * (measureOnly ? 30 : seconds);

  if (!measureOnly && argc < 2)
  {
    fprintf(stderr, "usage: %s <output-dir> [seconds]\n       %s --measure\n", argv[0], argv[0]);
    return 2;
  }

  if (measureOnly)
  {
    printf("%-10s %8s %8s   (30s at volume 100)\n", "sound", "rms", "peak");
    for (int i = 0; i < kSoundCount; i++)
    {
      double r, p;
      measure(renderSound(kSounds[i].sound, total, 100), &r, &p);
      printf("%-10s %8.4f %8.4f\n", kSounds[i].key, r, p);
    }
    for (int i = 0; i < kToneCount; i++)
    {
      double r, p;
      measure(renderTone(kTones[i].tone, total, 100), &r, &p);
      printf("%-18s %8.4f %8.4f\n", kTones[i].key, r, p);
    }
    return 0;
  }

  for (int i = 0; i < kSoundCount; i++)
  {
    const std::vector<int16_t> pcm = renderSound(kSounds[i].sound, total, 100);

    char path[1024];
    snprintf(path, sizeof(path), "%s/%s.wav", argv[1], kSounds[i].key);
    FILE *f = fopen(path, "wb");
    if (!f)
    {
      fprintf(stderr, "cannot write %s\n", path);
      return 1;
    }

    uint8_t header[44];
    wb_wav_header(header, (uint32_t)WB_SAMPLE_RATE_HZ, (uint32_t)pcm.size());
    fwrite(header, 1, sizeof(header), f);
    fwrite(pcm.data(), sizeof(int16_t), pcm.size(), f);
    fclose(f);

    double r, p;
    measure(pcm, &r, &p);
    printf("%-10s %s  (%zus, rms %.3f, peak %.3f)\n", kSounds[i].key, path, seconds, r, p);
  }

  // The wake tones. Rendered at volume 50 as well as 100, because the question
  // that matters for an alarm is whether it carries at a normal setting — the
  // level the device is actually left on.
  for (int i = 0; i < kToneCount; i++)
  {
    const int volumes[] = {100, 50};
    for (int vi = 0; vi < 2; vi++)
    {
      const std::vector<int16_t> pcm = renderTone(kTones[i].tone, total, volumes[vi]);

      char path[1024];
      snprintf(path, sizeof(path), "%s/%s-v%d.wav", argv[1], kTones[i].key, volumes[vi]);
      FILE *f = fopen(path, "wb");
      if (!f)
      {
        fprintf(stderr, "cannot write %s\n", path);
        return 1;
      }

      uint8_t header[44];
      wb_wav_header(header, (uint32_t)WB_SAMPLE_RATE_HZ, (uint32_t)pcm.size());
      fwrite(header, 1, sizeof(header), f);
      fwrite(pcm.data(), sizeof(int16_t), pcm.size(), f);
      fclose(f);

      double r, p;
      measure(pcm, &r, &p);
      printf("%-18s %s  (%zus, rms %.3f, peak %.3f)\n", kTones[i].key, path, seconds, r, p);
    }
  }
  return 0;
}
