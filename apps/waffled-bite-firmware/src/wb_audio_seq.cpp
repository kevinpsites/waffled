#include "wb_audio_seq.h"

void wb_audio_seq_init(WbAudioSeq *s)
{
  if (!s) return;
  s->phase = WbAudioPhase::Idle;
  s->fade = 0.0f;
  s->alarmLeft = 0;
  s->resumeAfterAlarm = false;
}

WbAudioSeqOut wb_audio_seq_step(WbAudioSeq *s, bool wantPlay, bool wantAlarm, bool restart,
                                uint32_t frames, float fadeStep)
{
  WbAudioSeqOut o = {};
  if (!s) return o;

  // ── transitions ──────────────────────────────────────────────────────────
  switch (s->phase)
  {
  case WbAudioPhase::Idle:
    if (wantAlarm)
    {
      // Straight to ringing: there's nothing playing to duck. This is also
      // the branch that makes "the alarm never starts the sound machine"
      // true — resumeAfterAlarm is false, so there's nothing to hand back to.
      o.powerUp = true;
      o.initTone = true;
      s->alarmLeft = WB_ALARM_DURATION_FRAMES;
      s->resumeAfterAlarm = false;
      s->phase = WbAudioPhase::AlarmRinging;
    }
    else if (wantPlay)
    {
      o.powerUp = true;
      o.initSound = true;
      s->phase = WbAudioPhase::Running;
    }
    else
    {
      o.idle = true;
      return o;
    }
    break;

  case WbAudioPhase::Running:
    if (wantAlarm)
    {
      s->resumeAfterAlarm = true; // it WAS playing — D4 says hand it back
      s->phase = WbAudioPhase::AlarmDucking;
    }
    else if (!wantPlay)
      s->phase = WbAudioPhase::Stopping;
    else if (restart && s->fade <= 0.0f)
      o.initSound = true; // sound changed; re-seed at the bottom of the fade
    break;

  case WbAudioPhase::Stopping:
    if (wantAlarm)
    {
      // Already on its way out, so there's nothing worth resuming.
      s->resumeAfterAlarm = false;
      s->phase = WbAudioPhase::AlarmDucking;
    }
    else if (wantPlay)
      s->phase = WbAudioPhase::Running; // changed its mind mid-fade
    break;

  case WbAudioPhase::AlarmDucking:
    if (!wantAlarm)
      s->phase = WbAudioPhase::AlarmReleasing; // cancelled before it rang
    else if (s->fade <= 0.0f)
    {
      o.initTone = true;
      s->alarmLeft = WB_ALARM_DURATION_FRAMES;
      s->phase = WbAudioPhase::AlarmRinging;
    }
    break;

  case WbAudioPhase::AlarmRinging:
    // Cancelling (wb_audio_stop, e.g. unpairing) ends the tone early rather
    // than cutting it dead — it still fades out through AlarmReleasing.
    if (!wantAlarm) s->alarmLeft = 0;
    if (s->alarmLeft == 0) s->phase = WbAudioPhase::AlarmReleasing;
    break;

  case WbAudioPhase::AlarmReleasing:
    if (s->fade <= 0.0f)
    {
      o.alarmDone = true;
      if (s->resumeAfterAlarm && wantPlay)
      {
        // Back to Running WITHOUT initSound: D4's "where it left off". The
        // synth is untouched, so ocean's slow swell carries on rather than
        // restarting from zero every morning.
        s->phase = WbAudioPhase::Running;
      }
      else
      {
        o.powerDown = true;
        o.idle = true;
        s->phase = WbAudioPhase::Idle;
        return o;
      }
    }
    break;
  }

  // ── outputs ──────────────────────────────────────────────────────────────
  o.tone = (s->phase == WbAudioPhase::AlarmRinging || s->phase == WbAudioPhase::AlarmReleasing);

  switch (s->phase)
  {
  case WbAudioPhase::Stopping:
  case WbAudioPhase::AlarmDucking:
  case WbAudioPhase::AlarmReleasing:
    o.falling = true;
    break;
  case WbAudioPhase::AlarmRinging:
    // The fade-out happens INSIDE the 20 seconds rather than after it, so the
    // alarm is 20 seconds long as decided, not 20 seconds plus a tail.
    o.falling = (float)s->alarmLeft <= (1.0f / fadeStep);
    break;
  default:
    break;
  }

  // Block-granular fade, matching the per-sample ramp the backend applies.
  // Both clamp, and clamping is monotonic, so the two end each block on
  // exactly the same value and can't drift apart.
  s->fade += (o.falling ? -fadeStep : fadeStep) * (float)frames;
  if (s->fade > 1.0f) s->fade = 1.0f;
  if (s->fade < 0.0f) s->fade = 0.0f;

  if (s->phase == WbAudioPhase::AlarmRinging)
    s->alarmLeft = (s->alarmLeft > frames) ? s->alarmLeft - frames : 0;

  if (s->phase == WbAudioPhase::Stopping && s->fade <= 0.0f)
  {
    o.powerDown = true;
    s->phase = WbAudioPhase::Idle;
  }

  return o;
}
