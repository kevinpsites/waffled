// A deliberately-hidden destructive action, reached only via 5 taps on
// Settings' "For a grown-up" chip (see settings_screen.cpp's tap-counter) —
// not a normal nav target, so a kid tapping around can't land here by
// accident. `onConfirm` performs the actual forget (clears the stored
// pairing on THIS device and falls back to onboarding — see main.cpp's
// wb_forget_pairing); Cancel just navigates back to Settings without
// calling it.
#pragma once

#include <lvgl.h>
#include <functional>

using WbForgetConfirmCallback = std::function<void()>;

// Builds onto `parent`. Caller is responsible for lv_obj_clean(parent)
// before calling this and lv_scr_load_anim after — same convention as
// control_detail_screen.h's build-then-navigate call sites (this screen has
// no live state to keep in sync, so it doesn't need its own wb_sync_*).
void wb_build_forget_confirm_screen(lv_obj_t *parent, lv_obj_t *settings_scr, WbForgetConfirmCallback onConfirm);
