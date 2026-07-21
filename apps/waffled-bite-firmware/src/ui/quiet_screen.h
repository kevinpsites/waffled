// Full-screen, non-exitable "Quiet time" takeover. Parent-triggered only
// (POST /api/waffled-bites/:id/quiet/start from the web app) — there is
// deliberately no on-device way to start OR dismiss this screen. main.cpp
// force-loads it on every poll while runtimeState.quiet.active is true,
// regardless of whatever screen the kid was previously on, and this screen
// itself has no back button, no gesture handler, and no clickable child
// that navigates anywhere. That absence — not a special lock flag — is the
// actual "not exitable" mechanism; see main.cpp's wb_do_poll for the other
// half (forcing this screen in, and handing control back to home_scr once
// the poll reports quiet is no longer active).
#pragma once

#include <lvgl.h>
#include "../wb_state.h"

// `nowHour`/`nowMin` come from WbDeviceState (parsed from the poll's "now"),
// -1/-1 if unavailable — see wb_state.h's comment on that field for the
// known UTC-vs-household-timezone caveat this screen's "Stay cozy until"
// line inherits.
void wb_build_quiet_screen(lv_obj_t *parent, const WbQuietState &quiet, int nowHour, int nowMin);

// Pushes updated server state into an ALREADY-BUILT quiet screen (main.cpp
// calls this on every poll after the first, instead of rebuilding) — updates
// the countdown, the paused/running flag the local ticker checks, and the
// "Stay cozy until" text, without a lv_obj_clean+rebuild+lv_scr_load cycle.
// That cycle used to run unconditionally every 5s poll, which both reset the
// countdown visibly every tick and re-forced navigation onto this screen
// even when the kid had (illegitimately) wandered elsewhere — this function
// is what lets subsequent polls update in place instead. No-ops if `parent`
// hasn't been built yet (see wb_build_quiet_screen's lv_obj_set_user_data).
void wb_sync_quiet_screen(lv_obj_t *parent, const WbQuietState &quiet, int nowHour, int nowMin);
