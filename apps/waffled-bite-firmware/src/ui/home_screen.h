// The device's home screen: top bar (clock/date, stars, settings gear),
// greeting card with an avatar placeholder, the three scheduled routine
// tiles (morning/afternoon/evening), and the unscheduled Chores bar.
// Mirrors the mockup's buddy-device.js `home()`.
#pragma once

#include <lvgl.h>
#include "../wb_state.h"
#include "tasks_screen.h"

// Builds the screen onto `parent` (pass a fresh lv_obj_create(NULL), not
// lv_scr_act() — home and settings are two real LVGL screens now, swapped via
// lv_scr_load on gear/back taps). `settings_scr` is the screen the gear
// button navigates to. `tasks_scr` is a fourth screen object, reused/rebuilt
// each time a routine tile or the Chores bar is tapped, showing that
// routine's tap-to-complete task list (see tasks_screen.h); `onComplete` is
// forwarded straight through to it.
void wb_build_home_screen(lv_obj_t *parent, const WbDeviceState &state, lv_obj_t *settings_scr, lv_obj_t *tasks_scr, WbTaskCompleteCallback onComplete);
