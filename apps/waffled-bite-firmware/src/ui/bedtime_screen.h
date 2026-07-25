// A shared full-screen colored-glow visual with two distinct jobs:
//
// 1. The "Bedtime" Grown-up controls tile's exitable nightlight PREVIEW —
//    per direct user feedback, just shows the current nightlight color/
//    brightness so a kid or parent can see what the room will look like.
//    No schedule involved.
// 2. The wake-light schedule's FORCED sleep -> warn -> wake sequence
//    (main.cpp force-navigates here the same way it does for quiet_scr,
//    computed server-side by wakeLightView — see waffledBites.ts). sleep
//    and warn are non-exitable; wake is exitable (a close button), per
//    direct user feedback: "until the green state the nightlight is
//    forced ... the yellow state cannot be exited either."
//
// wb_glow_spec_for_device_state decides which of these applies from the
// full device state and builds the right WbGlowSpec; main.cpp doesn't need
// its own copy of that decision.
#pragma once

#include <lvgl.h>
#include "../wb_state.h"

struct WbGlowSpec
{
  uint32_t colorHex;
  int brightness;   // 0-100, scales the glow's size/opacity
  const char *label; // shown near the top; nullptr for the plain preview (no schedule context to narrate)
  bool exitable;     // false for sleep/warn, true for wake and the plain preview
  bool forced;       // true for sleep/warn/wake — main.cpp force-navigates here; false for the plain preview (tap-only)
  int wakeAtHour;    // -1 if not applicable — shown as "until H:MM" under `label` when >= 0
  int wakeAtMinute;
};

// Decides the current glow spec from the full device state: the wake-light
// schedule's sleep/warn/wake if it's active (quiet time wins if both are
// somehow active at once — an explicit, in-the-moment parent action should
// override a passive schedule), else the plain exitable nightlight preview.
WbGlowSpec wb_glow_spec_for_device_state(const WbDeviceState &state);

// Builds onto `parent`. `back_scr` is only reachable when `spec.exitable` is
// true (the preview's Home button, or wake's close button) — for sleep/warn
// no navigation element exists at all, matching quiet_screen.h's "absence,
// not a lock flag" non-exitability.
void wb_build_bedtime_screen(lv_obj_t *parent, const WbGlowSpec &spec, lv_obj_t *back_scr);

// Pushes an updated spec into an ALREADY-BUILT screen (main.cpp calls this
// every poll while this screen's overall MODE hasn't changed — see
// WbBedtimeClaim in main.cpp). No-op if `parent` hasn't been built yet.
void wb_sync_bedtime_screen(lv_obj_t *parent, const WbGlowSpec &spec);
