// Full-screen "can't reach the server" state — takes over whenever the
// device has been offline for a few consecutive polls (see main.cpp's
// WB_OFFLINE_AFTER_MISSES, the same threshold the small "Offline" badge
// already used before this screen existed), and keeps re-asserting itself
// on every subsequent offline poll (not just the first) so sitting on some
// other screen while still offline doesn't just quietly stay there forever
// — see main.cpp's wb_mark_poll_failed for the exact recovery-flow-screen
// exemptions (it won't yank someone off the WiFi picker or the forget-pairing
// confirm screen mid-fix). Every device-initiated action (starting a timer,
// completing a chore, toggling sound/nightlight...) needs a live request to
// the server and used to just silently do nothing when one failed — this
// gives the kid/parent an actual explanation and a way out instead of a
// dead tap.
//
// Exposes a direct "Change server address" shortcut straight into
// forget_confirm_screen.h's confirm step (bypassing Settings' 5-tap
// "For a grown-up" gesture, but NOT the confirm step itself — that's still
// a genuine "Forget this device?" tap-to-confirm, not a silent one-tap
// unpair) — direct request, after the 5-tap-only version proved too
// roundabout in practice. The offline state itself (2+ consecutive missed
// polls) is already a real gate on top of that confirm step: reaching this
// screen isn't as trivial as tapping around Settings, since it requires an
// actual connectivity failure first.
#pragma once

#include <lvgl.h>
#include <functional>

using WbOfflineActionCallback = std::function<void()>;

// Builds onto `parent`. Caller is responsible for lv_obj_clean(parent)
// before calling this and lv_scr_load_anim after — same convention as
// forget_confirm_screen.h's build-then-navigate call sites (no live state
// to sync; main.cpp force-navigates away the moment a poll next succeeds).
// `onRetry` should trigger an immediate poll attempt (not just wait for the
// next scheduled one, which may be backed off up to 30s); `onChangeWifi`
// re-opens the WiFi picker; `onChangeServer` opens the forget-pairing
// confirm screen (see header comment above).
void wb_build_offline_screen(lv_obj_t *parent, lv_obj_t *settings_scr, WbOfflineActionCallback onRetry,
                              WbOfflineActionCallback onChangeWifi, WbOfflineActionCallback onChangeServer);
