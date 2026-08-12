#pragma once
// The morning alarm's timing decision, kept pure so it can be unit-tested.
//
// This answers exactly one question — "should the alarm tone start on this
// poll?" — and touches no audio, no timers and no I/O. Everything awkward
// about the alarm lives here (the same minute arriving a dozen times, a
// missing wall clock, midnight, re-arming for tomorrow), which is why it's
// worth its own file rather than a few lines inside main.cpp's poll handler.
//
// The device has NO real-time clock. Wall-clock time arrives from the server,
// already localised to the household's timezone, as WbDeviceState's
// nowHour/nowMin. That has a consequence the plan accepts deliberately (§5,
// gap 1): an alarm that falls during an offline stretch is simply missed.
// Persisting anything across a reboot is out of scope by decision D2, so a
// reboot inside the alarm's own minute re-fires it — a rare, harmless case
// that isn't worth engineering around.

// No alarm has fired yet today (or the clock has since moved on). Callers
// should seed their stored latch with this at boot.
#define WB_ALARM_NEVER_FIRED (-1)

// How long the tone plays once it starts, per decision D4.
#define WB_ALARM_DURATION_SEC 20

struct WbAlarmStep
{
  bool fire;       // start the tone now
  int lastFiredMin; // the caller's new latch value — store it and pass it back next poll
};

// Pure. `lastFiredMin` is the value returned by the previous call (start with
// WB_ALARM_NEVER_FIRED). `nowHour`/`nowMin` are WbDeviceState's, so -1 means
// "no usable clock" and is never treated as midnight.
WbAlarmStep wb_alarm_step(bool on, int alarmHour, int alarmMin, int nowHour, int nowMin,
                          int lastFiredMin);
