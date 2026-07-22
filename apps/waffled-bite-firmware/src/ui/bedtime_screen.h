// "Bedtime" — the fourth Grown-up controls tile. Per direct user feedback,
// this is deliberately NOT a routine/checklist/countdown: it's just a full-
// screen preview of the nightlight, showing its actual color at its actual
// brightness so a kid (or parent) can see what the room will look like.
// Unlike quiet_screen.h, this IS exitable — a close button navigates back.
#pragma once

#include <lvgl.h>
#include "../wb_state.h"

// Builds onto `parent` (a fresh/cleaned screen object). `back_scr` is where
// the close button navigates to.
void wb_build_bedtime_screen(lv_obj_t *parent, const WbNightSettings &night, lv_obj_t *back_scr);

// Pushes an updated color/brightness into an ALREADY-BUILT bedtime screen
// (main.cpp calls this on every poll while this screen is active) — same
// sync-in-place contract as the other screens. No-op if not built yet.
void wb_sync_bedtime_screen(lv_obj_t *parent, const WbNightSettings &night);
