// Canonical 44-byte RIFF/WAVE header for 16-bit mono PCM.
//
// HOST-ONLY. This is not firmware — the device never writes a WAV, it writes
// I2S frames. This exists so `render_wav.cpp` can dump wb_synth's output to
// files a human can actually listen to on a laptop before anyone solders
// anything. Header-only so the unit tests can include it directly.
#pragma once

#include <stddef.h>
#include <stdint.h>

static const size_t WB_WAV_HEADER_BYTES = 44;

namespace wb_wav_detail
{
inline void put_u32(uint8_t *p, uint32_t v)
{
  p[0] = (uint8_t)(v & 0xff);
  p[1] = (uint8_t)((v >> 8) & 0xff);
  p[2] = (uint8_t)((v >> 16) & 0xff);
  p[3] = (uint8_t)((v >> 24) & 0xff);
}
inline void put_u16(uint8_t *p, uint16_t v)
{
  p[0] = (uint8_t)(v & 0xff);
  p[1] = (uint8_t)((v >> 8) & 0xff);
}
} // namespace wb_wav_detail

// Fills `out` with the header for `sampleCount` mono 16-bit samples at
// `sampleRate`. Both length fields are derived from sampleCount — getting
// either wrong is the usual reason a file opens and plays as silence.
inline void wb_wav_header(uint8_t *out, uint32_t sampleRate, uint32_t sampleCount)
{
  using namespace wb_wav_detail;
  const uint16_t channels = 1;
  const uint16_t bits = 16;
  const uint32_t dataBytes = sampleCount * channels * (bits / 8);
  const uint32_t byteRate = sampleRate * channels * (bits / 8);

  out[0] = 'R'; out[1] = 'I'; out[2] = 'F'; out[3] = 'F';
  put_u32(out + 4, 36 + dataBytes); // everything after this field
  out[8] = 'W'; out[9] = 'A'; out[10] = 'V'; out[11] = 'E';

  out[12] = 'f'; out[13] = 'm'; out[14] = 't'; out[15] = ' ';
  put_u32(out + 16, 16);        // fmt chunk size (PCM)
  put_u16(out + 20, 1);         // format 1 = uncompressed PCM
  put_u16(out + 22, channels);
  put_u32(out + 24, sampleRate);
  put_u32(out + 28, byteRate);
  put_u16(out + 32, (uint16_t)(channels * (bits / 8))); // block align
  put_u16(out + 34, bits);

  out[36] = 'd'; out[37] = 'a'; out[38] = 't'; out[39] = 'a';
  put_u32(out + 40, dataBytes);
}
