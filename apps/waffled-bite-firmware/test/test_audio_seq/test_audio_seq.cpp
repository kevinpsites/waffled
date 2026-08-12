// Unit tests for wb_audio_seq.h — decision D4's alarm sequence.
//
// Run with `pio test -e native_test`.
//
// This is the logic that used to live inside the I2S task, where it could
// only be checked by standing next to the device at 6:45am. Pulling it out
// means the cases that actually bite — a poll landing mid-alarm, an alarm
// with nothing to resume, unpairing while the tone rings — are ordinary
// assertions.
#include <unity.h>

#include <stdio.h>

#include "wb_audio_seq.h"

void setUp(void) {}
void tearDown(void) {}

// The device's real block size and fade, so the timings under test are the
// ones that actually ship.
static const uint32_t FRAMES = 256;
static const float FADE_STEP = 1.0f / (22050.0f * 0.4f); // 400 ms

// Drives `blocks` blocks and reports what happened across all of them.
struct Tally
{
  int powerUps;
  int powerDowns;
  int toneBlocks;
  int soundBlocks;
  int idleBlocks;
  int initTones;
  int initSounds;
  WbAudioSeqOut last;
};

static Tally run(WbAudioSeq *s, bool wantPlay, bool wantAlarm, int blocks, bool restart = false)
{
  Tally t = {};
  // Mirrors what the backends do: `wantAlarm` is a level the caller raises
  // once, and the backend lowers it when the sequence reports it's done.
  // Without that, an alarm would restart the moment it released.
  bool alarm = wantAlarm;
  for (int i = 0; i < blocks; i++)
  {
    const WbAudioSeqOut o = wb_audio_seq_step(s, wantPlay, alarm, restart, FRAMES, FADE_STEP);
    if (o.alarmDone) alarm = false;
    if (o.powerUp) t.powerUps++;
    if (o.powerDown) t.powerDowns++;
    if (o.initTone) t.initTones++;
    if (o.initSound) t.initSounds++;
    if (o.idle) t.idleBlocks++;
    else if (o.tone) t.toneBlocks++;
    else t.soundBlocks++;
    t.last = o;
  }
  return t;
}

// Comfortably longer than the 20s tone plus both 400ms fades.
static const int BLOCKS_PAST_THE_ALARM = (int)(WB_ALARM_DURATION_FRAMES / FRAMES) + 200;

// ── the ordinary case ──────────────────────────────────────────────────────

void test_idle_stays_idle_and_never_powers_the_amp(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  const Tally t = run(&s, false, false, 50);
  TEST_ASSERT_EQUAL_INT(50, t.idleBlocks);
  TEST_ASSERT_EQUAL_INT(0, t.powerUps);
}

void test_the_sound_machine_plays_when_asked(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  const Tally t = run(&s, true, false, 100);
  TEST_ASSERT_EQUAL_INT(1, t.powerUps);
  TEST_ASSERT_EQUAL_INT(1, t.initSounds);
  TEST_ASSERT_TRUE(t.soundBlocks > 90);
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::Running);
}

// ── D4, the whole sequence ─────────────────────────────────────────────────

void test_the_alarm_pauses_the_sound_machine_then_hands_it_back(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, true, false, 100); // sound machine up and running

  // The alarm fires. It ducks the sound machine first...
  const WbAudioSeqOut first = wb_audio_seq_step(&s, true, true, false, FRAMES, FADE_STEP);
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::AlarmDucking);
  TEST_ASSERT_FALSE(first.tone); // still the sound machine, on its way down
  TEST_ASSERT_TRUE(first.falling);

  // ... rings ...
  run(&s, true, true, 60);
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::AlarmRinging);

  // ... and hands playback back.
  run(&s, true, true, BLOCKS_PAST_THE_ALARM);
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::Running);
}

// THE test. main.cpp reconciles playback with settings on every poll, and a
// poll lands roughly every 5 seconds — so four of them arrive during a
// 20-second alarm. Before this machine existed, each one would have started
// white noise underneath the tone.
void test_a_poll_during_the_alarm_does_not_resume_the_sound_machine_underneath_it(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, true, false, 100);
  run(&s, true, true, 60); // ducked and now ringing
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::AlarmRinging);

  // wantPlay stays true the whole time — that IS the poll saying "the sound
  // machine should be on". The tone must keep the output to itself anyway.
  const Tally t = run(&s, true, true, 1000);
  TEST_ASSERT_EQUAL_INT(1000, t.toneBlocks);
  TEST_ASSERT_EQUAL_INT(0, t.soundBlocks);
  TEST_ASSERT_EQUAL_INT(0, t.initSounds); // and nothing re-seeded it either
}

// "Only if it was actually playing at alarm time" — D4. A kid whose sleep
// timer ran out at 9pm has had silence for nine hours; the alarm must ring
// and then leave the room quiet, not switch the sound machine on for the day.
void test_the_alarm_never_starts_the_sound_machine(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, false, false, 20); // nothing playing

  const Tally t = run(&s, false, true, BLOCKS_PAST_THE_ALARM);
  TEST_ASSERT_TRUE(t.toneBlocks > 0);
  TEST_ASSERT_EQUAL_INT(0, t.soundBlocks);
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::Idle);
  TEST_ASSERT_EQUAL_INT(1, t.powerDowns);
}

void test_the_tone_rings_for_twenty_seconds(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, false, false, 5);

  int toneBlocks = 0;
  bool alarm = true;
  for (int i = 0; i < BLOCKS_PAST_THE_ALARM; i++)
  {
    const WbAudioSeqOut o = wb_audio_seq_step(&s, false, alarm, false, FRAMES, FADE_STEP);
    if (o.alarmDone) alarm = false; // as the backend does — otherwise it re-arms at once
    if (o.tone) toneBlocks++;
  }

  // Within one block of 20 seconds. The fades happen underneath the tone
  // rather than on either side of it, so the tone's own length is exact.
  const uint32_t rendered = (uint32_t)toneBlocks * FRAMES;
  char msg[96];
  snprintf(msg, sizeof(msg), "rang for %.2fs", (double)rendered / 22050.0);
  TEST_ASSERT_TRUE_MESSAGE(rendered >= WB_ALARM_DURATION_FRAMES, msg);
  TEST_ASSERT_TRUE_MESSAGE(rendered < WB_ALARM_DURATION_FRAMES + FRAMES * 2, msg);
}

// Powering the amp down between the pause and the tone (and up again after)
// would be two extra transitions through the exact sequence that pops. The
// amp comes up once and stays up until the whole thing is over.
void test_the_amp_stays_powered_for_the_whole_alarm(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, true, false, 100);

  const Tally t = run(&s, true, true, BLOCKS_PAST_THE_ALARM);
  TEST_ASSERT_EQUAL_INT(0, t.powerDowns);
  TEST_ASSERT_EQUAL_INT(0, t.powerUps);
}

// D4 says the sound machine resumes "where it left off". Re-seeding the synth
// would restart ocean's slow swell from zero every morning.
void test_the_sound_machine_is_not_reseeded_when_it_resumes(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, true, false, 100);

  const Tally t = run(&s, true, true, BLOCKS_PAST_THE_ALARM);
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::Running);
  TEST_ASSERT_EQUAL_INT(0, t.initSounds);
}

void test_the_tone_voice_is_reset_for_each_alarm(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, false, false, 5);
  const Tally first = run(&s, false, true, BLOCKS_PAST_THE_ALARM);
  TEST_ASSERT_EQUAL_INT(1, first.initTones);

  const Tally second = run(&s, false, true, BLOCKS_PAST_THE_ALARM);
  TEST_ASSERT_EQUAL_INT(1, second.initTones);
}

// Unpairing tears the device's poll down and leaves no UI to reach — the
// sound machine playing forever after an unpair was a real blocker found in
// review last time. The alarm must be cancellable the same way.
void test_dropping_the_alarm_request_silences_it(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, true, false, 100);
  run(&s, true, true, 60);
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::AlarmRinging);

  // Everything off, as wb_audio_stop() leaves it.
  const Tally t = run(&s, false, false, 400);
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::Idle);
  TEST_ASSERT_EQUAL_INT(1, t.powerDowns);
}

// A parent switching the sound machine off during the alarm shouldn't have it
// come back when the tone ends.
void test_switching_sound_off_during_the_alarm_is_respected(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, true, false, 100);
  run(&s, true, true, 60);

  run(&s, false, true, BLOCKS_PAST_THE_ALARM); // alarm runs out, sound now off
  TEST_ASSERT_TRUE(s.phase == WbAudioPhase::Idle);
}

// ── fades ──────────────────────────────────────────────────────────────────

// The backend ramps its fade per sample and this machine tracks it per block.
// They must agree, or the audible fade and the phase transitions drift apart.
void test_the_fade_stays_within_range_and_reaches_both_ends(void)
{
  WbAudioSeq s;
  wb_audio_seq_init(&s);
  run(&s, true, false, 200);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 1.0f, s.fade);

  run(&s, false, false, 200);
  TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.0f, s.fade);
}

int main(void)
{
  UNITY_BEGIN();
  RUN_TEST(test_idle_stays_idle_and_never_powers_the_amp);
  RUN_TEST(test_the_sound_machine_plays_when_asked);
  RUN_TEST(test_the_alarm_pauses_the_sound_machine_then_hands_it_back);
  RUN_TEST(test_a_poll_during_the_alarm_does_not_resume_the_sound_machine_underneath_it);
  RUN_TEST(test_the_alarm_never_starts_the_sound_machine);
  RUN_TEST(test_the_tone_rings_for_twenty_seconds);
  RUN_TEST(test_the_amp_stays_powered_for_the_whole_alarm);
  RUN_TEST(test_the_sound_machine_is_not_reseeded_when_it_resumes);
  RUN_TEST(test_the_tone_voice_is_reset_for_each_alarm);
  RUN_TEST(test_dropping_the_alarm_request_silences_it);
  RUN_TEST(test_switching_sound_off_during_the_alarm_is_respected);
  RUN_TEST(test_the_fade_stays_within_range_and_reaches_both_ends);
  UNITY_END();
  return 0;
}
