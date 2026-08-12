#include "wb_alarm.h"

// The latch is stored as a MINUTE-OF-DAY rather than a bool, which is what
// makes "fire once" and "re-arm tomorrow" the same mechanism: the latch is
// cleared as soon as the clock reads any other minute, so by the time the
// alarm's minute comes round again the next day it is already armed. A plain
// bool would need a separate reset, and getting that reset wrong is how an
// alarm rings once and then never again.
WbAlarmStep wb_alarm_step(bool on, int alarmHour, int alarmMin, int nowHour, int nowMin,
                          int lastFiredMin)
{
  WbAlarmStep out;
  out.fire = false;
  out.lastFiredMin = lastFiredMin;

  // No usable wall clock (a mock state, a reshaped payload, or before the
  // first successful poll). Hold the latch exactly as it was: clearing it
  // here would let the alarm re-fire the moment the clock came back inside
  // the minute it had already rung in.
  if (nowHour < 0 || nowHour > 23 || nowMin < 0 || nowMin > 59) return out;

  const int nowMod = nowHour * 60 + nowMin;

  // Re-arm as soon as the clock leaves the minute we last fired in.
  if (lastFiredMin != nowMod) out.lastFiredMin = WB_ALARM_NEVER_FIRED;

  if (!on) return out;
  // A nonsense time from a bad payload means "no alarm", not "alarm at some
  // arbitrary moment".
  if (alarmHour < 0 || alarmHour > 23 || alarmMin < 0 || alarmMin > 59) return out;
  if (alarmHour * 60 + alarmMin != nowMod) return out;
  if (out.lastFiredMin != WB_ALARM_NEVER_FIRED) return out;

  out.fire = true;
  out.lastFiredMin = nowMod;
  return out;
}
