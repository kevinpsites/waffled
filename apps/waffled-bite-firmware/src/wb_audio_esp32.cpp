// ESP32-P4 backend for wb_audio.h — I2S TX into the board's NS4168 class-D
// amplifier.
//
// Pin assignments are the vendor's (Elecrow CrowPanel Advanced 7"), and are
// confirmed working on real hardware: a 440 Hz probe through exactly this
// configuration came out of the speaker on the first try.
//
// The NS4168 is an amplifier, NOT a codec, despite what the product page
// calls it — there is no I2C register map, no init sequence and no driver
// library. You write I2S frames and it makes sound. The only control it has
// is an enable pin, and sequencing that pin correctly is most of this file.
#if defined(ARDUINO)

#include "wb_audio.h"

#include <Arduino.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "wb_audio_seq.h"

#define WB_AUDIO_LRCLK GPIO_NUM_21
#define WB_AUDIO_BCLK GPIO_NUM_22
#define WB_AUDIO_DOUT GPIO_NUM_23
#define WB_AUDIO_CTRL GPIO_NUM_30 // NS4168 enable — see WB_AUDIO_AMP_ON_LEVEL

// The amplifier enable on this board is ACTIVE LOW: driving GPIO30 low turns
// the amp ON. Established empirically on real hardware, not from a datasheet,
// because it is the opposite of what the pin name suggests — with the pin held
// low, an underrunning I2S channel popped continuously through the speaker;
// with the pin held high, identical code was completely silent.
//
// Getting this backwards costs you a whole debugging session: everything
// initialises with ESP_OK, every write succeeds, and nothing comes out.
#define WB_AUDIO_AMP_ON_LEVEL 0

// Frames per DMA write. ~12 ms at 22.05 kHz: short enough that a volume or
// stop request is acted on promptly, long enough that the task isn't waking
// constantly.
#define WB_AUDIO_FRAMES 256

// Fades are 400 ms. Long enough to be inaudible as a transition, short enough
// that a kid tapping "off" doesn't think the tap missed.
#define WB_AUDIO_FADE_MS 400

namespace
{

i2s_chan_handle_t s_tx = NULL;
TaskHandle_t s_task = NULL;

// Written by whoever calls the public API, read by the audio task. Single
// writer per field and word-sized, so no lock is needed for these.
volatile bool s_wantPlay = false;
volatile int s_wantSound = (int)WbSound::White;
volatile int s_wantVolume = 50;
volatile bool s_restart = false;
volatile bool s_running = false;

// The alarm's requests. `s_wantAlarm` is a level the caller raises and the
// audio task lowers when the sequence reports it's finished — see
// wb_audio_seq.h's alarmDone.
volatile bool s_wantAlarm = false;
volatile int s_wantTone = (int)WbTone::SunriseChime;
volatile int s_wantToneVolume = 80;

int16_t s_mono[WB_AUDIO_FRAMES];
int16_t s_stereo[WB_AUDIO_FRAMES * 2];

void writeSilence(int blocks)
{
  memset(s_stereo, 0, sizeof(s_stereo));
  for (int i = 0; i < blocks; i++)
  {
    size_t written = 0;
    i2s_channel_write(s_tx, s_stereo, sizeof(s_stereo), &written, 200);
  }
}

void ampEnable(bool on)
{
  gpio_set_level(WB_AUDIO_CTRL, on ? WB_AUDIO_AMP_ON_LEVEL : !WB_AUDIO_AMP_ON_LEVEL);
}

// All the phase/fade decisions live in wb_audio_seq (pure, unit-tested); this
// task only carries them out. That split is what makes decision D4's alarm
// sequence testable at all — it used to be impossible to check any of it
// without standing next to the device at 6:45am.
void audioTask(void *)
{
  WbAudioSeq seq;
  wb_audio_seq_init(&seq);

  WbSynth synth;
  WbToneVoice tone;
  float fade = 0.0f;
  const float fadeStep = 1.0f / ((float)WB_SAMPLE_RATE_HZ * (WB_AUDIO_FADE_MS / 1000.0f));

  for (;;)
  {
    const WbAudioSeqOut o =
        wb_audio_seq_step(&seq, s_wantPlay, s_wantAlarm, s_restart, WB_AUDIO_FRAMES, fadeStep);

    // The sequence owns when the alarm is over; lowering the request here is
    // what stops it re-arming immediately and ringing forever.
    if (o.alarmDone) s_wantAlarm = false;

    if (o.powerUp)
    {
      // Bring the output up in the one order that doesn't click: enable the
      // channel, push real (silent) frames so the DMA buffer holds zeros
      // rather than whatever was left in it, and only THEN power the amp.
      i2s_channel_enable(s_tx);
      writeSilence(2);
      ampEnable(true);
      vTaskDelay(pdMS_TO_TICKS(30)); // amp settle
      fade = 0.0f;
    }

    if (!o.idle)
    {
      if (o.initSound)
      {
        wb_synth_init(&synth, (WbSound)s_wantSound, 0x5EEDu);
        s_restart = false;
      }
      if (o.initTone) wb_tone_init(&tone, (WbTone)s_wantTone);

      if (o.tone)
        wb_tone_render(&tone, s_mono, WB_AUDIO_FRAMES, s_wantToneVolume);
      else
        wb_synth_render(&synth, s_mono, WB_AUDIO_FRAMES, s_wantVolume);

      for (int i = 0; i < WB_AUDIO_FRAMES; i++)
      {
        fade += o.falling ? -fadeStep : fadeStep;
        if (fade > 1.0f) fade = 1.0f;
        if (fade < 0.0f) fade = 0.0f;
        const int16_t v = (int16_t)((float)s_mono[i] * fade);
        // Mono duplicated to both slots. I2S Philips framing makes you write
        // both channels regardless, and a sleep sound has no stereo image.
        s_stereo[i * 2 + 0] = v;
        s_stereo[i * 2 + 1] = v;
      }

      // i2s_channel_write is what paces this loop: it blocks until the DMA
      // has room. If it ever fails instead (a disabled channel, a timeout),
      // nothing throttles the task and it spins at priority 5 on core 1 —
      // so yield explicitly rather than assuming the write always blocks.
      size_t written = 0;
      if (i2s_channel_write(s_tx, s_stereo, sizeof(s_stereo), &written, 500) != ESP_OK)
        vTaskDelay(pdMS_TO_TICKS(5));
    }

    if (o.powerDown)
    {
      // Mirror of the start sequence: silence first, then kill the amp, then
      // the channel. Dropping the enable pin mid-waveform pops.
      writeSilence(2);
      ampEnable(false);
      i2s_channel_disable(s_tx);
    }

    s_running = (seq.phase != WbAudioPhase::Idle);

    // Nothing to write and nothing to wait on — don't spin.
    if (o.idle && !o.powerDown) vTaskDelay(pdMS_TO_TICKS(20));
  }
}

} // namespace

void wb_audio_init()
{
  if (s_task) return;

  gpio_config_t io = {};
  io.pin_bit_mask = 1ULL << (int)WB_AUDIO_CTRL;
  io.mode = GPIO_MODE_OUTPUT;
  io.pull_up_en = GPIO_PULLUP_DISABLE;
  io.pull_down_en = GPIO_PULLDOWN_DISABLE;
  io.intr_type = GPIO_INTR_DISABLE;
  gpio_config(&io);
  ampEnable(false); // stay silent until something asks for sound

  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.auto_clear = true; // underruns emit silence, not the last buffer again
  if (i2s_new_channel(&chan, &s_tx, NULL) != ESP_OK) return;

  // Filled field by field rather than through I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG:
  // those macros use designated initializers, a GNU extension in C++ whose
  // failure mode is a confusing compile error.
  i2s_std_config_t cfg = {};
  cfg.clk_cfg.sample_rate_hz = WB_SAMPLE_RATE_HZ;
  cfg.clk_cfg.clk_src = I2S_CLK_SRC_DEFAULT;
  cfg.clk_cfg.mclk_multiple = I2S_MCLK_MULTIPLE_256;

  cfg.slot_cfg.data_bit_width = I2S_DATA_BIT_WIDTH_16BIT;
  cfg.slot_cfg.slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO;
  cfg.slot_cfg.slot_mode = I2S_SLOT_MODE_STEREO;
  cfg.slot_cfg.slot_mask = I2S_STD_SLOT_BOTH;
  cfg.slot_cfg.ws_width = 16;
  cfg.slot_cfg.ws_pol = false;
  cfg.slot_cfg.bit_shift = true; // Philips
  cfg.slot_cfg.left_align = true;
  cfg.slot_cfg.big_endian = false;
  cfg.slot_cfg.bit_order_lsb = false;

  cfg.gpio_cfg.mclk = I2S_GPIO_UNUSED; // an amp, not a codec — no MCLK needed
  cfg.gpio_cfg.bclk = WB_AUDIO_BCLK;
  cfg.gpio_cfg.ws = WB_AUDIO_LRCLK;
  cfg.gpio_cfg.dout = WB_AUDIO_DOUT;
  cfg.gpio_cfg.din = I2S_GPIO_UNUSED;
  cfg.gpio_cfg.invert_flags.mclk_inv = false;
  cfg.gpio_cfg.invert_flags.bclk_inv = false;
  cfg.gpio_cfg.invert_flags.ws_inv = false;

  if (i2s_channel_init_std_mode(s_tx, &cfg) != ESP_OK) return;

  // Core 1: core 0 carries the esp-hosted/SDIO WiFi work, and an audio task
  // that misses its deadline underruns audibly.
  xTaskCreatePinnedToCore(audioTask, "wb_audio", 4096, NULL, 5, &s_task, 1);
}

void wb_audio_play(WbSound sound, int volume)
{
  s_wantVolume = volume;
  // Publish the new sound BEFORE raising s_restart, never the other way round.
  // Callers run on core 0 and the audio task on core 1, so if s_restart were
  // visible first the task could re-init the synth with the OLD sound and then
  // clear the flag — and nothing re-arms it, because by the next poll
  // s_wantSound already equals the requested sound, so the comparison below is
  // false. A lost sound change would be permanent, not self-healing.
  const bool changing = s_wantPlay && (int)sound != s_wantSound;
  s_wantSound = (int)sound;
  if (changing) s_restart = true;
  s_wantPlay = true;
}

void wb_audio_set_volume(int volume) { s_wantVolume = volume; }

void wb_audio_alarm(WbTone tone, int volume)
{
  // Same publish-before-flag ordering as wb_audio_play, and for the same
  // reason: callers run on core 0 and the audio task on core 1, so if the
  // request flag became visible first the task could start ringing with the
  // previous tone.
  s_wantTone = (int)tone;
  s_wantToneVolume = volume;
  s_wantAlarm = true;
}

bool wb_audio_alarm_active() { return s_wantAlarm; }

void wb_audio_stop()
{
  s_wantPlay = false;
  s_wantAlarm = false; // cancels a ringing alarm — see the header
}

bool wb_audio_is_playing() { return s_running; }

#endif // ARDUINO
