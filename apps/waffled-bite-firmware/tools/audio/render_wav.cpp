// Renders wb_synth's sounds to WAV files you can listen to on a laptop,
// before any hardware is involved.
//
// HOST-ONLY — this is not part of either firmware build. It exists so the
// synthesis recipes can be judged by ear (which is the only way to judge
// them) without a flash cycle. What it writes is bit-for-bit what the device
// will push to I2S at the same volume, so if it sounds wrong here it will
// sound wrong there.
//
//   Build:  clang++ -std=c++14 -O2 -Isrc tools/audio/render_wav.cpp \
//                   src/wb_synth.cpp -o /tmp/wb_render
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
  const size_t seconds = (size_t)((argc > 2 && !measureOnly) ? atoi(argv[2]) : 20);
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
  return 0;
}
