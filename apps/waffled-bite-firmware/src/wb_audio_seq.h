#pragma once
// The audio output's phase machine — pure, so decision D4's alarm sequence
// can be unit-tested instead of discovered on hardware at 6:45am.
//
// Both backends (wb_audio_esp32.cpp's I2S task, wb_audio_native.cpp's SDL
// callback) drive this and do only what it says. Keeping it out of the
// backends is what makes the awkward case testable at all — see
// `test_a_poll_during_the_alarm_does_not_resume_the_sound_machine`.
//
// == Why the alarm OWNS the output ==
// main.cpp reconciles playback with `settings.sound` on every successful poll
// (~5s), unconditionally. If the alarm's pause were merely a flag that
// reconciliation read, the first poll inside the 20-second alarm would start
// white noise up UNDERNEATH the tone — which is the exact failure D4 exists
// to prevent, since white noise under an alarm is why the alarm goes unheard.
//
// So while an alarm phase is active this machine ignores `wantPlay` entirely.
// The caller's requests still land in those flags — they're the RECORD of what
// the sound machine should be doing — but they aren't acted on until the alarm
// releases. That single rule also delivers the two halves of D4 for free:
// playback resumes because the pre-alarm state was recorded, and the alarm
// never *starts* the sound machine because an alarm from Idle has nothing
// recorded to resume.
#include <stdint.h>

#include "wb_synth.h" // WB_SAMPLE_RATE_HZ

// D4: the tone plays for 20 seconds. Driven from a sample count rather than
// wall clock so it's exact and testable.
#define WB_ALARM_DURATION_SEC 20
#define WB_ALARM_DURATION_FRAMES ((uint32_t)WB_ALARM_DURATION_SEC * (uint32_t)WB_SAMPLE_RATE_HZ)

enum class WbAudioPhase
{
  Idle,           // nothing playing, amp down
  Running,        // sound machine playing
  Stopping,       // sound machine fading out, then power down
  AlarmDucking,   // alarm fired — fading the sound machine down first
  AlarmRinging,   // the wake tone
  AlarmReleasing, // tone finished — hand back to the sound machine, or power down
};

struct WbAudioSeq
{
  WbAudioPhase phase;
  float fade;            // 0..1, block-granular; the backend ramps per sample to the same value
  uint32_t alarmLeft;    // frames of tone still to play
  bool resumeAfterAlarm; // was the sound machine actually playing when the alarm fired?
};

// What the backend should do for this block.
struct WbAudioSeqOut
{
  bool powerUp;    // enable the I2S channel + amp BEFORE writing this block
  bool powerDown;  // after writing, amp off + channel disable
  bool idle;       // nothing to write; just wait
  bool tone;       // render the wake tone (otherwise the sound machine)
  bool initTone;   // reset the tone voice before rendering
  bool initSound;  // reset the sound-machine synth before rendering
  bool falling;    // fade direction for this block
  // The alarm has finished. The backend MUST clear its own `wantAlarm` when it
  // sees this: `wantAlarm` is a level, not a pulse, so leaving it raised would
  // start the next alarm the instant this one released — a 20-second tone on
  // an endless loop.
  bool alarmDone;
};

void wb_audio_seq_init(WbAudioSeq *s);

// Advances one block of `frames` samples. `fadeStep` is the per-sample fade
// increment; the backend must apply the identical per-sample ramp so its fade
// ends exactly where this one does.
//
// `wantPlay` / `wantAlarm` are the caller's requests. `wantAlarm` going false
// cancels a running alarm — that's how unpairing silences the device.
WbAudioSeqOut wb_audio_seq_step(WbAudioSeq *s, bool wantPlay, bool wantAlarm, bool restart,
                                uint32_t frames, float fadeStep);
