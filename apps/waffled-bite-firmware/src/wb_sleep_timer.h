#pragma once
// The sound machine's sleep timer — "play, then go quiet after N minutes".
//
// Kept pure and in its own file for the same reason wb_alarm.h is: the whole
// difficulty is in the bookkeeping (when does the countdown restart? what
// survives a poll? what happens when the clock wraps?), and bookkeeping is
// only cheap to get right when it can be unit-tested. No audio, no timers, no
// I/O — the caller supplies the clock and stores the state.
//
// == The trap this module exists to survive ==
// main.cpp reconciles playback with `settings.sound` on a fixed cadence and
// calls this on EVERY reconcile. `settings.sound.on` is still true after the
// timer fires — that IS still the parent's setting, and nothing on the device
// writes it back to the server — so a stop that were recomputed from the
// settings alone would be undone by the very next reconcile, forever. The
// expiry is therefore STICKY for the current playback session, and only an
// EDGE re-arms it.
//
// == What counts as a new session (i.e. what re-arms the countdown) ==
//   - `on` going false -> true. Switching the sound machine off and on is how
//     a kid asks for another N minutes.
//   - the selected sound changing. Picking a different sound is a fresh
//     request for that sound.
//   - `timerMin` changing. Without this, a parent who moves 30m -> 60m after
//     the room has already gone quiet would see their change do nothing.
// `volume` deliberately does NOT re-arm: nudging the volume of something
// that's already playing is not a request to start it over, and the volume
// slider is the one control that gets dragged through a dozen intermediate
// values on the way to its destination.
//
// == Time ==
// Callers pass wb_tick_ms() — milliseconds since boot, monotonic — NOT the
// server's wall clock. That is deliberate: the wall clock (WbDeviceState's
// nowHour/nowMin) is absent before the first poll, absent whenever a payload
// is reshaped, and jumps whenever the household's timezone or DST changes. A
// sleep timer is a duration, not an appointment, so none of that can be
// allowed to shorten or extend it. The tick counter wraps every ~49 days;
// unsigned subtraction below makes that a non-event.
//
// Nothing is persisted (decision D2), so a reboot mid-countdown re-arms it —
// the device has no RTC to catch up from, and the alternative (silence after
// a power blip) is worse than a restarted timer.
//
// == While the morning alarm is ringing ==
// The countdown keeps running. It is a promise about the room ("quiet in 30
// minutes"), not a meter of how long the speaker was the sound machine's, and
// the alarm holds the output for at most WB_ALARM_DURATION_SEC anyway. If the
// timer happens to expire during those seconds, wb_audio_seq drops the
// sound machine's `wantPlay` on the floor until the tone releases and then
// simply doesn't resume it — which is exactly the wanted outcome, reached
// without this module needing to know the alarm exists.
#include <stdint.h>

// Sized to hold wb_state.h's WB_TONE_LEN sound names. This header can't
// include wb_state.h to say so directly — that pulls in ArduinoJson, which
// the [env:native_test] build has no lib_deps for — so main.cpp carries a
// static_assert that the two agree, rather than a comment that can rot.
#define WB_SLEEP_TIMER_TONE_LEN 24

// The panel offers 0/15/30/60/120. Anything past a day didn't come from it,
// and is treated as a bad payload -> "no timer" (the same rule wb_alarm.h
// applies to a nonsense alarm time: a bad payload must never silence a
// device at some arbitrary moment). It also keeps timerMin * 60000 inside
// the uint32 the comparison is done in.
#define WB_SLEEP_TIMER_MAX_MIN 1440

// The caller's stored state. Zero-initialising it is equivalent to
// wb_sleep_timer_init(); the function exists so re-arming is spelled out at
// the call sites that need it (a re-pairing, say).
struct WbSleepTimer
{
  bool expired;       // sticky for this session — the point of the whole module
  uint32_t startedMs; // when the current session began
  // The inputs the last call was made with; a difference is the EDGE that
  // starts a new session.
  bool lastOn;
  int lastTimerMin;
  char lastTone[WB_SLEEP_TIMER_TONE_LEN];
};

void wb_sleep_timer_init(WbSleepTimer *t);

// Pure. Advances `t` and answers "should the sound machine be playing right
// now?". `nowMs` is the caller's clock (wb_tick_ms()); `tone` may be NULL.
//
// Only ever takes playback away: it returns false whenever `on` is false, and
// never returns true for a sound machine that is switched off.
bool wb_sleep_timer_step(WbSleepTimer *t, bool on, const char *tone, int timerMin,
                         uint32_t nowMs);
