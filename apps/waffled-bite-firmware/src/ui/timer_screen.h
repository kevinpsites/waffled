// "Set a timer" — the third Grown-up controls tile. Unlike quiet_screen.h,
// this one is exitable (a Home button navigates away, no gesture lock), and
// unlike quiet time, either a parent (from the web app) OR the kid (right
// here on the device) can start or end it — see main.cpp's wb_start_timer/
// wb_end_timer, which hit the device-authed
// /api/waffled-bites/device/timer/{start,end} routes.
//
// This screen has two shapes depending on `timer.active`: a duration picker
// (inactive) or a countdown (active, same arc/MM:SS visual language as
// quiet_screen.h). main.cpp rebuilds between the two on the active/inactive
// transition (mirroring how it handles quiet_scr) and calls
// wb_sync_timer_screen every poll otherwise, which is a no-op in picker mode
// and pushes live remaining/running into the countdown in active mode.
#pragma once

#include <lvgl.h>
#include <functional>
#include "../wb_state.h"

// Returns true only on a confirmed 200 — same optimistic-update contract as
// this app's other change callbacks (tasks_screen.h, control_detail_screen.h).
using WbTimerStartCallback = std::function<bool(int durationSec)>;
using WbTimerEndCallback = std::function<bool()>;

// Builds onto `parent` (a fresh/cleaned screen object). `back_scr` is where
// the Home button navigates.
void wb_build_timer_screen(lv_obj_t *parent, const WbTimerState &timer, lv_obj_t *back_scr,
                            WbTimerStartCallback onStart, WbTimerEndCallback onEnd);

// Pushes updated remaining/running into an ALREADY-BUILT countdown screen.
// No-op if `parent` hasn't been built yet, OR if it's currently showing the
// picker (nothing to sync there — main.cpp rebuilds on the active/inactive
// transition instead, see this file's header comment).
void wb_sync_timer_screen(lv_obj_t *parent, const WbTimerState &timer);
