#include "wb_sleep_timer.h"

#include <string.h>

void wb_sleep_timer_init(WbSleepTimer *t)
{
  if (!t) return;
  t->expired = false;
  t->startedMs = 0;
  t->lastOn = false;
  t->lastTimerMin = 0;
  t->lastTone[0] = '\0';
}

bool wb_sleep_timer_step(WbSleepTimer *t, bool on, const char *tone, int timerMin,
                         uint32_t nowMs)
{
  // No state to keep means no timer to enforce — never silence on a
  // programming error.
  if (!t) return on;
  if (!tone) tone = "";

  // The edge. Compared by VALUE, not by pointer: the caller's `tone` lives in
  // a char[] inside a struct that every poll overwrites in place, so the
  // pointer is the same one every time and would never look like a change.
  const bool newSession = on != t->lastOn || timerMin != t->lastTimerMin ||
                          strncmp(tone, t->lastTone, WB_SLEEP_TIMER_TONE_LEN) != 0;
  if (newSession)
  {
    t->expired = false;
    t->startedMs = nowMs;
    t->lastOn = on;
    t->lastTimerMin = timerMin;
    strncpy(t->lastTone, tone, WB_SLEEP_TIMER_TONE_LEN - 1);
    t->lastTone[WB_SLEEP_TIMER_TONE_LEN - 1] = '\0';
  }

  if (!on) return false;
  if (timerMin <= 0 || timerMin > WB_SLEEP_TIMER_MAX_MIN) return true;

  // Sticky: once this session has run out, every later call agrees, however
  // many times the reconcile asks. See the header — this single line is what
  // stops the poll putting the sound back on five seconds later.
  if (t->expired) return false;

  // Unsigned subtraction, so a wrap of the ~49-day tick counter mid-countdown
  // still yields the true elapsed time. Never `startedMs + duration`, which
  // wraps into the past and expires the timer instantly.
  if ((uint32_t)(nowMs - t->startedMs) >= (uint32_t)timerMin * 60000u)
  {
    t->expired = true;
    return false;
  }
  return true;
}
