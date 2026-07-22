// The tap-to-complete task list: reached by tapping a routine tile or the
// Chores bar on the home screen. Shows every task in that one WbRoutine as a
// row (title + reward chip + a checkbox affordance); tapping a row toggles
// it — an undone row calls `onComplete` (POST .../tasks/:instanceId/complete),
// a done row calls `onUncomplete` (.../uncomplete) — and optimistically
// flips the row's visual, reverting it if the request fails. A back button
// returns to `home_scr`.
#pragma once

#include <lvgl.h>
#include <functional>
#include <string>
#include "../wb_state.h"

// Synchronous — mirrors this codebase's existing pattern (onboarding's Pair
// button, main.cpp's poll timer) of blocking network calls straight off an
// LVGL event/timer callback rather than an async abstraction this small app
// doesn't otherwise have. Returns true only on a confirmed 200 from the
// server.
using WbTaskCompleteCallback = std::function<bool(const std::string &taskId)>;

// Builds onto `parent` (a fresh/cleaned screen object, same convention as
// wb_build_home_screen/wb_build_settings_screen — caller does the
// lv_obj_clean before calling this, since main.cpp already owns that
// lifecycle for every other screen). `onUncomplete` un-taps an already-done
// row (a mis-tap, or a kid changing their mind) — same shape as
// `onComplete`, just POSTing .../uncomplete instead.
void wb_build_tasks_screen(lv_obj_t *parent, const char *title, const WbRoutine &routine, lv_obj_t *home_scr,
                            WbTaskCompleteCallback onComplete, WbTaskCompleteCallback onUncomplete);
