// Full-screen "the alarm is going off" takeover, with a Stop button.
//
// Unlike quiet_screen (which is deliberately not exitable), this screen exists
// precisely SO it can be dismissed. An alarm that rings with nothing on screen
// and no way to silence it was the first thing reported the moment this ran on
// real hardware — the tone came out of the speaker with the device showing the
// ordinary home screen, which reads as a malfunction rather than an alarm.
//
// main.cpp force-loads this the moment the alarm fires (not on the next poll —
// a five-second wait between the sound starting and the screen appearing would
// be its own bug), and hands control back to home when the alarm ends, whether
// that's because it ran its 20 seconds or because Stop was tapped.
#pragma once

#include <lvgl.h>

typedef void (*WbAlarmStopCallback)(void);

// `nowHour`/`nowMin` come from WbDeviceState, -1/-1 when the poll carried no
// usable clock — the time line is simply omitted in that case rather than
// showing "-1:-1".
void wb_build_alarm_screen(lv_obj_t *parent, const char *personName, int nowHour, int nowMin,
                           WbAlarmStopCallback onStop);
