// The "Grown-up controls" screen: back-to-home button, title, a locked chip,
// and a row of control tiles (Sounds/Nightlight/Set a timer/Bedtime).
// Mirrors the mockup's buddy-phone.js grown-up-controls page.
//
// Sounds and Nightlight are real now — tapping either opens
// control_detail_screen.h's shared toggle+picker+slider screen. Set a timer
// and Bedtime are still non-functional placeholders (need real design —
// see the firmware README's "What's not done").
#pragma once

#include <lvgl.h>
#include <functional>
#include <string>
#include "../wb_state.h"
#include "forget_confirm_screen.h"

// Which settings sub-object a change applies to — main.cpp uses this to
// build the right PATCH body ({sound:{...}} vs {night:{...}}).
enum class WbSettingsKey
{
  Sound,
  Night,
};

// Optimistic-update contract, same shape as tasks_screen.h's
// WbTaskCompleteCallback: return true only on a confirmed 200.
using WbSettingsChangeCallback = std::function<bool(WbSettingsKey key, bool on, const std::string &optionKey, int sliderValue)>;

// Builds the screen onto `parent` (a fresh lv_obj_create(NULL)). `home_scr`
// is the screen the back button navigates to. `detail_scr` is a fifth
// screen object, reused/rebuilt each time the Sounds or Nightlight tile is
// tapped (same convention as home_screen.h's tasks_scr); `onChange` is
// forwarded straight through to whichever detail screen opens.
//
// `timer_scr`/`bedtime_scr` are kept CORRECTLY BUILT by main.cpp's poll at
// all times (unlike detail_scr, which only rebuilds at tap time) — a timer
// can be started remotely by a parent, or bedtime's nightlight color/
// brightness can change, while the kid isn't even looking at either screen,
// so both tiles here are pure navigation (no rebuild-on-tap): see
// wb_go_scr_cb.
//
// `forget_scr`/`onForget`: tapping the "For a grown-up" chip 5 times in a
// row (a fast sequence — a >2s gap between taps resets the count, so idle
// slow taps over a long session can't accidentally accumulate to 5) opens
// forget_confirm_screen.h's confirmation screen, wired to `onForget`
// (main.cpp's wb_forget_pairing). This is intentionally not a normal,
// visible button — see forget_confirm_screen.h's header comment.
void wb_build_settings_screen(lv_obj_t *parent, const WbDeviceState &state, lv_obj_t *home_scr, lv_obj_t *detail_scr,
                               lv_obj_t *timer_scr, lv_obj_t *bedtime_scr, lv_obj_t *forget_scr,
                               WbSettingsChangeCallback onChange, WbForgetConfirmCallback onForget);

// Pushes updated Sounds/Nightlight on-off + Nightlight's active styling into
// an ALREADY-BUILT settings screen (main.cpp calls this on every poll after
// the first, instead of rebuilding) — no lv_obj_clean+rebuild, so a tap or
// the fade-in animation into the detail screen never gets torn out from
// under itself. No-op if `parent` hasn't been built yet. The Sounds/
// Nightlight tiles' tap targets don't need their own sync path: their
// WbOpenDetailCtx holds a pointer to the same WbDeviceState main.cpp always
// passes by the same address, so they read live tone/volume/color/
// brightness at tap time without any extra plumbing.
void wb_sync_settings_screen(lv_obj_t *parent, const WbDeviceState &state);

// Which control (Sound/Night) the shared detail screen was most recently
// opened for — main.cpp needs this to know which half of WbDeviceState to
// read when syncing an already-open detail screen on a later poll (see
// control_detail_screen.h's wb_sync_control_detail_screen). Meaningless
// before the first tile tap; main.cpp only consults it while detail_scr is
// the active screen, which can't happen before then.
WbSettingsKey wb_open_detail_current_key();
