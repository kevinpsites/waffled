// Milestone 3: real networking. Boots into onboarding (server address +
// pairing code) if no device secret is stored, otherwise exchanges the
// stored secret for an access token and starts a 5s poll of
// GET /api/waffled-bites/device/state, rebuilding the home screen from live
// data each time. wb_mock_state() is still used as the immediate placeholder
// while the very first poll is in flight, and as onboarding's fallback if
// this ever needs to demo offline.
//
// Milestone 4: ported to LVGL 9.2 + 1024x600 for the new target board
// (ELECROW CrowPanel Advanced 7", ESP32-P4 — the CrowPanel Basic 7"/ESP32-S3
// this was originally built against was superseded before it arrived). The
// display/indev registration below is v9's API (lv_display_create/
// lv_indev_create), not v8's lv_disp_drv_t/lv_indev_drv_t — see the plan
// doc / commit history for the full v8→v9 delta if this looks unfamiliar.
#include <lvgl.h>
#include "lgfx_device.h"
#include "wb_state.h"
#include "wb_http.h"
#include "wb_store.h"
#include "wb_tick_hal.h"
#include "wb_wifi.h"
#include "wb_boot_flow.h"
#include "ui/home_screen.h"
#include "ui/settings_screen.h"
#include "ui/control_detail_screen.h"
#include "ui/onboarding_screen.h"
#include "ui/wifi_screen.h"
#include "ui/quiet_screen.h"
#include "ui/timer_screen.h"
#include "ui/bedtime_screen.h"
#include "icons/wb_icons.h"
#include <ArduinoJson.h>
#include <string>
#include <cstring>

#if defined(ARDUINO)
#include <Wire.h>
#include <TAMC_GT911.h>
static TAMC_GT911 ts = TAMC_GT911(WB_TOUCH_SDA, WB_TOUCH_SCL, WB_TOUCH_INT, WB_TOUCH_RST, 1024, 600);
#else
#include <chrono>
#include <thread>
#endif

#ifndef WB_API_BASE_URL
#define WB_API_BASE_URL "http://localhost:8081"
#endif

static LGFX lcd;

// A partial buffer (40 rows at the panel's full width) is plenty for LVGL's
// chunked flush — the full 1024x600 framebuffer lives in the panel driver,
// not here. Raw bytes (not lv_color_t[]) because v9's lv_display_set_buffers
// takes the size in bytes and flush_cb now hands back a raw uint8_t*, not a
// typed color pointer — see disp_flush below.
static uint8_t buf1[1024 * 40 * 2]; // *2: 2 bytes/pixel at RGB565

static void disp_flush(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;
  lcd.pushImageDMA(area->x1, area->y1, w, h, (lgfx::rgb565_t *)px_map);
  // pushImageDMA only STARTS the transfer — it returns immediately, while the
  // DMA hardware keeps reading from `buf1` in the background. There's only
  // one flush buffer (see buf1's comment), so without waiting here,
  // lv_display_flush_ready() below tells LVGL it's safe to render the NEXT
  // chunk into the same buffer the DMA engine may still be mid-read on —
  // a classic single-buffer/async-DMA tear. Previously invisible against
  // plain color+text content (or just not looked at closely enough); a real
  // bitmap image on the boot screen — held on-screen for many redraw cycles
  // by the blocking WiFi-connect wait loop below — made it obvious as
  // sustained flicker. waitDMA() blocks until the in-flight transfer
  // actually finishes before the buffer is handed back.
  lcd.waitDMA();
  lv_display_flush_ready(disp);
}

// Native: LovyanGFX's SDL panel reports mouse clicks as touches through the same
// getTouch() call real touch panels use. Hardware: the GT911 over I2C.
static void touchpad_read(lv_indev_t * /*indev*/, lv_indev_data_t *data)
{
#if defined(ARDUINO)
  ts.read();
  if (ts.isTouched)
  {
    data->state = LV_INDEV_STATE_PR;
    // TAMC_GT911's ROTATION_NORMAL (set in setup(), below) flips BOTH axes
    // (x = width - x_raw, y = height - y_raw internally). The Y half needed
    // undoing (confirmed on real hardware: swiping up scrolled the list
    // down, backwards from every phone/tablet's "content follows your
    // finger" convention) — see the on-screen keyboard's floating-flag fix
    // nearby for the same "confirmed on real hardware" bar. The X half
    // looked correct at first only because it was tested against full-width
    // tap targets (list rows, wide chips), where a mirrored X still lands in
    // the same row; the on-screen keyboard's narrow, side-by-side keys
    // exposed it for real (confirmed: tapping a key hit the mirrored key on
    // the opposite side) — undo it the same way. None of TAMC_GT911's four
    // rotation presets express "flip neither axis, this board's touch
    // controller and panel orientation just don't line up otherwise," so
    // both axes end up hand-corrected here rather than picking a different
    // preset.
    // 1023/599, not 1024/600: valid coordinates on this 1024x600 panel are
    // 0..1023 / 0..599, so flipping against the raw panel size put an edge
    // touch (raw 0) one pixel past the last valid column/row.
    data->point.x = 1023 - ts.points[0].x;
    data->point.y = 599 - ts.points[0].y;
  }
  else
  {
    data->state = LV_INDEV_STATE_REL;
  }
#else
  int32_t x, y;
  if (lcd.getTouch(&x, &y))
  {
    data->state = LV_INDEV_STATE_PR;
    data->point.x = x;
    data->point.y = y;
  }
  else
  {
    data->state = LV_INDEV_STATE_REL;
  }
#endif
}

// ── app state: screens + the live pairing/polling session ──────────────────
// All three screens are created once at boot and never torn down — matches
// onboarding_screen.cpp's own lifetime assumption (its per-button context is
// intentionally never freed on the same premise).
static lv_obj_t *home_scr;
static lv_obj_t *settings_scr;
static lv_obj_t *onboarding_scr;
static lv_obj_t *wifi_scr; // WiFi picker — shown before onboarding_scr whenever there's no saved/working WiFi (see wb_boot_next)
static lv_obj_t *tasks_scr;  // rebuilt fresh each time a routine tile is tapped — see home_screen.cpp
static lv_obj_t *detail_scr;  // rebuilt fresh each time the Sounds/Nightlight tile is tapped — see settings_screen.cpp
static lv_obj_t *quiet_scr;   // force-shown whenever the poll reports quiet time active — see wb_do_poll
static lv_obj_t *timer_scr;   // picker <-> countdown, kept correctly built by every poll — see wb_do_poll
static lv_obj_t *bedtime_scr; // plain preview OR wake-light sleep/warn/wake — see wb_bedtime_claim_of
static lv_obj_t *forget_scr;  // rebuilt fresh each time (see settings_screen.cpp's 5-tap sequence), no live state to sync
static bool onboarding_built = false;
static bool g_quietWasActive = false;
static bool g_timerWasActive = false; // tracks timer_scr's built shape (picker vs countdown), same role as g_quietWasActive

// What's currently claiming bedtime_scr — used only to detect the edges
// wb_do_poll force-navigates on (see its wake-light block). The actual
// visual comes from wb_glow_spec_for_device_state (bedtime_screen.h); this
// only tracks enough to know when to rebuild+force-load vs. just sync.
enum class WbBedtimeClaim
{
  Preview, // no wake-light lock active (or quiet time is active instead) — tap-only, never auto-shown
  Sleep,
  Warn,
  Wake,
};
static WbBedtimeClaim wb_bedtime_claim_of(const WbDeviceState &s)
{
  if (s.quiet.active)
    return WbBedtimeClaim::Preview; // quiet time wins — see bedtime_screen.h's header comment
  switch (s.wakeLight.state)
  {
  case WbWakeLightState::Sleep:
    return WbBedtimeClaim::Sleep;
  case WbWakeLightState::Warn:
    return WbBedtimeClaim::Warn;
  case WbWakeLightState::Wake:
    return WbBedtimeClaim::Wake;
  default:
    return WbBedtimeClaim::Preview;
  }
}
static WbBedtimeClaim g_bedtimeClaim = WbBedtimeClaim::Preview;
static bool g_bedtimeScrBuilt = false;
// Home/settings get one full lv_obj_clean+rebuild per (re-)pairing session —
// the mock-data build in wb_enter_app(), then the first real poll after it —
// and are only ever synced-in-place after that (see wb_do_poll). Reset to
// false in wb_enter_app() so a re-pairing session gets its own fresh build,
// pointing settings_screen.cpp's WbOpenDetailCtx at the new session's
// `liveState` rather than syncing widgets that no longer exist post-rebuild.
static bool g_liveScreensBuilt = false;

static std::string g_serverUrl;
static std::string g_deviceSecret;
static std::string g_accessToken;
static uint32_t g_tokenExpiresAtMs = 0; // wb_tick_ms() deadline; 0 forces an immediate refresh
static lv_timer_t *g_pollTimer = nullptr;

// A small "Offline" pill on lv_layer_top() — LVGL's always-on-top overlay
// layer, which renders above whichever screen is active and survives
// lv_scr_load/lv_scr_load_anim, so this doesn't need its own copy on every
// screen. Hidden by default; wb_mark_poll_failed/wb_mark_poll_ok toggle it.
// A single miss doesn't show it (transient hiccups are normal on real
// WiFi) — only WB_OFFLINE_AFTER_MISSES consecutive ones do.
#define WB_OFFLINE_AFTER_MISSES 2
static lv_obj_t *g_offlineBadge = nullptr;
static int g_pollFailStreak = 0;
static void wb_mark_poll_failed()
{
  g_pollFailStreak++;
  if (g_pollFailStreak >= WB_OFFLINE_AFTER_MISSES)
    lv_obj_clear_flag(g_offlineBadge, LV_OBJ_FLAG_HIDDEN);
}
static void wb_mark_poll_ok()
{
  g_pollFailStreak = 0;
  lv_obj_add_flag(g_offlineBadge, LV_OBJ_FLAG_HIDDEN);
}

static void wb_show_onboarding();
static void wb_show_wifi_picker();
static void wb_enter_app();

// Clears the local pairing and falls back to onboarding. Does NOT itself
// touch the server — used as-is when the SERVER already told us we're
// revoked (401 on a token refresh or a live poll — see wb_do_poll), where
// there's nothing left to tell it. wb_forget_pairing_and_unpair (below)
// wraps this with the actual server call for the case where the DEVICE is
// the one initiating the forget.
static void wb_forget_pairing()
{
  wb_store_clear("deviceSecret");
  g_deviceSecret.clear();
  if (g_pollTimer)
  {
    lv_timer_del(g_pollTimer);
    g_pollTimer = nullptr;
  }
  wb_mark_poll_ok(); // hide any stale "Offline" badge before onboarding takes over
  wb_show_onboarding();
}

// The on-device "Forget this device" confirm screen (settings_screen.cpp's
// 5-tap sequence into forget_confirm_screen.h) — the DEVICE is initiating
// this, unlike wb_forget_pairing's other caller, so tell the server first
// (POST /device/unpair, same revocation the parent web app's own "Unpair"
// button triggers) so the device is ACTUALLY unpaired, not just locally
// forgetful of its own secret. Best-effort: a network hiccup shouldn't
// block forgetting locally — the local clear always happens regardless.
static void wb_forget_pairing_and_unpair()
{
  if (!g_accessToken.empty())
  {
    std::string url = g_serverUrl + "/api/waffled-bites/device/unpair";
    wb_http_post(url.c_str(), "{}", g_accessToken.c_str());
  }
  wb_forget_pairing();
}

static WbTaskCompleteResult wb_complete_task(const std::string &taskId);
static WbTaskCompleteResult wb_uncomplete_task(const std::string &taskId);
static bool wb_patch_settings(WbSettingsKey key, bool on, const std::string &optionKey, int sliderValue);
static bool wb_start_timer(int durationSec);
static bool wb_end_timer();

// Mints (or refreshes) a short-lived access token from the stored device
// secret. On 401 (waffledBites.ts: revoked device) clears the stored
// pairing and falls back to onboarding — any other failure (network hiccup,
// 5xx) just leaves the old token in place to retry on the next poll tick.
static bool wb_refresh_access_token()
{
  JsonDocument reqDoc;
  reqDoc["deviceSecret"] = g_deviceSecret;
  std::string body;
  serializeJson(reqDoc, body);

  std::string url = g_serverUrl + "/api/waffled-bites/device/token";
  WbHttpResponse resp = wb_http_post(url.c_str(), body.c_str(), nullptr);

  if (resp.ok && resp.status == 401)
  {
    wb_forget_pairing();
    return false;
  }
  if (!resp.ok || resp.status != 200)
    return false;

  JsonDocument doc;
  if (deserializeJson(doc, resp.body) || !doc["accessToken"].is<const char *>())
    return false;

  g_accessToken = doc["accessToken"].as<const char *>();
  int expiresIn = doc["expiresIn"] | 300; // seconds
  // Refresh at 80% of the window rather than right at the deadline.
  g_tokenExpiresAtMs = wb_tick_ms() + (uint32_t)(expiresIn * 800);
  return true;
}

// One poll cycle: refresh the token if due, GET the live state, rebuild the
// home screen on success. A transient failure (network, parse) just skips
// this tick and leaves the screen showing the last-good state — never
// blanks it on a single hiccup, but WB_OFFLINE_AFTER_MISSES in a row shows
// the "Offline" badge. A 401 (device revoked/unpaired server-side) is
// handled immediately, not treated as a generic miss — see wb_forget_pairing.
static void wb_do_poll()
{
  if (wb_tick_ms() >= g_tokenExpiresAtMs)
  {
    if (!wb_refresh_access_token())
    {
      // If the secret's gone, wb_forget_pairing() already ran (401 case) —
      // onboarding's showing and the badge is already hidden; nothing more
      // to do. Otherwise this was a generic network/server hiccup.
      if (!g_deviceSecret.empty())
        wb_mark_poll_failed();
      return;
    }
  }

  std::string url = g_serverUrl + "/api/waffled-bites/device/state";
  WbHttpResponse resp = wb_http_get(url.c_str(), g_accessToken.c_str());
  if (resp.ok && resp.status == 401)
  {
    wb_forget_pairing();
    return;
  }
  if (!resp.ok || resp.status != 200)
  {
    wb_mark_poll_failed();
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, resp.body))
  {
    wb_mark_poll_failed();
    return;
  }

  static WbDeviceState liveState;
  if (wb_state_from_json(doc, liveState))
  {
    wb_mark_poll_ok();
    // Full clean+rebuild only ONCE per (re-)pairing session — the first real
    // poll after wb_enter_app()'s mock-data build. Every poll after that
    // used to lv_obj_clean+rebuild both screens unconditionally, even while
    // the kid was actively looking at / tapping into one of them, which
    // could tear a fade-in animation or an in-flight tap out from under
    // itself — that's what caused Settings to "freeze" (couldn't tap Back,
    // Sounds, or Nightlight) after sitting on it a few seconds. Now, once
    // built, later polls call wb_sync_*_screen to push live values into the
    // existing widgets in place — no clean, no rebuild, no reload.
    if (!g_liveScreensBuilt)
    {
      lv_obj_clean(home_scr);
      wb_build_home_screen(home_scr, liveState, settings_scr, tasks_scr, wb_complete_task, wb_uncomplete_task);
      lv_obj_clean(settings_scr);
      wb_build_settings_screen(settings_scr, liveState, home_scr, detail_scr, timer_scr, bedtime_scr, forget_scr, wb_patch_settings, wb_forget_pairing_and_unpair);
      lv_obj_clean(timer_scr);
      wb_build_timer_screen(timer_scr, liveState.timer, settings_scr, wb_start_timer, wb_end_timer);
      g_timerWasActive = liveState.timer.active;
      // Covers a device reboot/re-pair landing mid-timer (rare, but quiet_scr's
      // unconditional block below handles the equivalent case for quiet time —
      // this is the timer's analogue for the very first poll).
      if (g_timerWasActive && lv_screen_active() != timer_scr)
        lv_scr_load(timer_scr);
      g_liveScreensBuilt = true;
    }
    else
    {
      wb_sync_home_screen(home_scr, liveState);
      wb_sync_settings_screen(settings_scr, liveState);

      // timer_scr has two SHAPES (picker vs countdown), not just values to
      // push — only rebuild on the active/inactive transition (mirrors
      // g_quietWasActive below), sync in place otherwise.
      if (liveState.timer.active != g_timerWasActive)
      {
        lv_obj_clean(timer_scr);
        wb_build_timer_screen(timer_scr, liveState.timer, settings_scr, wb_start_timer, wb_end_timer);
        g_timerWasActive = liveState.timer.active;
        // BUG FIX: a timer starting (from either the kid on-device or a parent
        // remotely) used to only update timer_scr's content in the background —
        // it never actually force-navigated onto it, so nothing visibly happened
        // on the device when a timer began. Mirrors quiet_scr's force-load below,
        // except timer_scr stays exitable (its own Home button still works,
        // unlike quiet's on-device lock) — this only controls the *automatic*
        // navigation, not whether the kid can back out once they're on it.
        // The `lv_screen_active() != timer_scr` guard matters here (unlike
        // quiet_scr's unconditional load): unlike quiet time, a kid can reach
        // timer_scr manually (Settings tile) and tap Start themselves, so this
        // edge can fire while they're already sitting on the screen being
        // rebuilt — reloading an already-active screen is the exact scenario
        // that's hung LVGL 9.2.2's layer compositing elsewhere in this app
        // (see settings_screen.cpp's wb_open_detail_cb).
        if (g_timerWasActive && lv_screen_active() != timer_scr)
          lv_scr_load(timer_scr);
        else if (!g_timerWasActive && lv_screen_active() == timer_scr)
          // It just ended (parent ended it remotely, or it ran out) while the
          // kid was sitting on this exact screen — hand control back to home
          // instead of leaving them stranded on a picker they didn't ask for.
          lv_scr_load(home_scr);
      }
      else
      {
        wb_sync_timer_screen(timer_scr, liveState.timer);
      }

      // The Sounds/Nightlight detail screen only gets built at tap time
      // (see wb_open_detail_cb) — without this, a parent flipping a setting
      // from the web app while a kid is sitting on this exact screen didn't
      // show up until they backed out and back in.
      if (lv_screen_active() == detail_scr)
      {
        WbSettingsKey openKey = wb_open_detail_current_key();
        bool on;
        std::string optionKey;
        int sliderValue;
        if (openKey == WbSettingsKey::Sound)
        {
          on = liveState.sound.on;
          optionKey = liveState.sound.tone;
          sliderValue = liveState.sound.volume;
        }
        else
        {
          on = liveState.night.on;
          optionKey = liveState.night.color;
          sliderValue = liveState.night.brightness;
        }
        wb_sync_control_detail_screen(detail_scr, on, optionKey, sliderValue);
      }
    }

    // Quiet time is parent-triggered only (no on-device start/stop) and
    // takes priority over whatever screen was showing — force it in
    // regardless of current navigation state, same "computed on read"
    // trust as the rest of this state. Build+load only ONCE, on the
    // false→true transition (g_quietWasActive false here); while it's
    // already showing, sync the existing screen's values instead of
    // rebuilding+reloading every poll — that used to run unconditionally
    // every 5s, which broke pause (the local ticker has no server-driven
    // reason to hold still if it gets torn down and recreated every poll
    // regardless of paused state) and re-forced navigation onto this
    // screen even during a pause, when `active` is still true but
    // `running` is false. See quiet_screen.h for the sync contract.
    if (liveState.quiet.active)
    {
      if (!g_quietWasActive)
      {
        lv_obj_clean(quiet_scr);
        wb_build_quiet_screen(quiet_scr, liveState.quiet, liveState.nowHour, liveState.nowMin);
        lv_scr_load(quiet_scr);
      }
      else
      {
        wb_sync_quiet_screen(quiet_scr, liveState.quiet, liveState.nowHour, liveState.nowMin);
      }
      g_quietWasActive = true;
    }
    else if (g_quietWasActive)
    {
      // A parent ended it from the web app — hand control back to home.
      // NOT a fade — full-screen FADE_IN hangs LVGL 9.2.2's layer-compositing
      // path at this resolution; see the detailed root-cause comment in
      // settings_screen.cpp's wb_open_detail_cb. Instant cut instead.
      lv_scr_load_anim(home_scr, LV_SCR_LOAD_ANIM_NONE, 0, 0, false);
      g_quietWasActive = false;
    }

    // Wake-light schedule (bedtime -> yellow warning -> green wake) and the
    // Bedtime tile's plain preview share bedtime_scr — see WbBedtimeClaim's
    // comment for why. Rebuild+force-load on any claim EDGE (this must be
    // an edge check, not "was it previously none": Preview->Sleep on a
    // SECOND night is a non-none->non-none transition by a naive check, but
    // is still a real edge that must re-lock the screen), sync in place
    // otherwise. Force-loads with plain lv_scr_load (no anim), same as
    // quiet_scr above, and only when not already showing it — avoid
    // reloading a screen that's already active given this app's history
    // with animated transitions hanging LVGL (see settings_screen.cpp's
    // wb_open_detail_cb). The reverse edge (forced -> Preview, e.g. a
    // schedule edited/removed mid-lock) explicitly navigates back to home_scr
    // too — see the wasForced branch below; don't rely on the rebuilt
    // screen's own close button alone to end a lock that's already over.
    WbBedtimeClaim claim = wb_bedtime_claim_of(liveState);
    WbGlowSpec spec = wb_glow_spec_for_device_state(liveState);
    if (!g_bedtimeScrBuilt || claim != g_bedtimeClaim)
    {
      bool wasForced = g_bedtimeClaim != WbBedtimeClaim::Preview;
      lv_obj_clean(bedtime_scr);
      lv_obj_t *back = (claim == WbBedtimeClaim::Preview) ? settings_scr : home_scr;
      wb_build_bedtime_screen(bedtime_scr, spec, back);
      if (claim != WbBedtimeClaim::Preview && lv_screen_active() != bedtime_scr)
        lv_scr_load(bedtime_scr);
      else if (claim == WbBedtimeClaim::Preview && wasForced && lv_screen_active() == bedtime_scr)
        // The lock just ended mid-session (schedule edited/removed from the
        // web app, or the wake grace period elapsed) — hand control back to
        // home instead of leaving them stranded on the now-unlocked screen
        // waiting to notice a close button. Mirrors the quiet-time block
        // above; only fires if they're actually still sitting on this
        // screen (not if they'd already tapped away from an exitable Wake).
        lv_scr_load(home_scr);
      g_bedtimeScrBuilt = true;
      g_bedtimeClaim = claim;
    }
    else
    {
      wb_sync_bedtime_screen(bedtime_scr, spec);
    }
  }
  else
  {
    wb_mark_poll_failed();
  }
}

static void wb_poll_timer_cb(lv_timer_t * /*timer*/)
{
  wb_do_poll();
}

// The tasks screen's tap-to-complete callback (tasks_screen.h). Synchronous,
// same as wb_do_poll/wb_refresh_access_token — refreshes the token first if
// due, same pattern as wb_do_poll, since a tap can land well after the last
// poll refreshed it. On success, runs an immediate poll so stars/progress
// update everywhere (home screen tiles, greeting badge) without waiting up
// to 5s for the next timer tick — the tapped row itself already updated
// optimistically in tasks_screen.cpp before this was even called.
static WbTaskCompleteResult wb_complete_task(const std::string &taskId)
{
  if (taskId.empty()) // mock/placeholder tasks have no real instance id
    return WbTaskCompleteResult::Failed;

  if (wb_tick_ms() >= g_tokenExpiresAtMs)
  {
    if (!wb_refresh_access_token())
      return WbTaskCompleteResult::Failed;
  }

  std::string url = g_serverUrl + "/api/waffled-bites/device/tasks/" + taskId + "/complete";
  WbHttpResponse resp = wb_http_post(url.c_str(), "{}", g_accessToken.c_str());
  if (!resp.ok || resp.status != 200)
    return WbTaskCompleteResult::Failed;

  // A photo-proof/approval-required chore still answers HTTP 200, but with
  // instance.status "awaiting", not "done" — that's a distinct result from a
  // plain completion (see WbTaskCompleteResult), not a failure.
  JsonDocument doc;
  if (deserializeJson(doc, resp.body))
    return WbTaskCompleteResult::Failed;
  const char *status = doc["instance"]["status"].is<const char *>() ? doc["instance"]["status"].as<const char *>() : "";
  WbTaskCompleteResult result = strcmp(status, "done") == 0     ? WbTaskCompleteResult::Success
                                 : strcmp(status, "awaiting") == 0 ? WbTaskCompleteResult::AwaitingApproval
                                                                    : WbTaskCompleteResult::Failed;
  if (result != WbTaskCompleteResult::Failed)
    wb_do_poll();
  return result;
}

// tasks_screen.h's onUncomplete — un-tapping an already-done row. Mirrors
// wb_complete_task exactly, just POSTing .../uncomplete instead. Never
// returns AwaitingApproval — there's no photo/approval ambiguity on the way
// back to "pending".
static WbTaskCompleteResult wb_uncomplete_task(const std::string &taskId)
{
  if (taskId.empty())
    return WbTaskCompleteResult::Failed;

  if (wb_tick_ms() >= g_tokenExpiresAtMs)
  {
    if (!wb_refresh_access_token())
      return WbTaskCompleteResult::Failed;
  }

  std::string url = g_serverUrl + "/api/waffled-bites/device/tasks/" + taskId + "/uncomplete";
  WbHttpResponse resp = wb_http_post(url.c_str(), "{}", g_accessToken.c_str());
  bool ok = resp.ok && resp.status == 200;
  if (ok)
    wb_do_poll();
  return ok ? WbTaskCompleteResult::Success : WbTaskCompleteResult::Failed;
}

// The settings detail screen's onChange callback (settings_screen.h).
// Synchronous, same pattern as wb_complete_task: refreshes the token first
// if due, PATCHes the whole sub-object (device/settings only merges keys
// present in the body — see waffledBites.ts's deepMerge — so leaving
// timerMin out here doesn't clobber it), and on success runs an immediate
// poll so the tile's own On/Off subtitle and any other open screen catch up
// without waiting up to 5s.
static bool wb_patch_settings(WbSettingsKey key, bool on, const std::string &optionKey, int sliderValue)
{
  if (wb_tick_ms() >= g_tokenExpiresAtMs)
  {
    if (!wb_refresh_access_token())
      return false;
  }

  JsonDocument reqDoc;
  if (key == WbSettingsKey::Sound)
  {
    JsonObject sound = reqDoc["sound"].to<JsonObject>();
    sound["on"] = on;
    sound["sound"] = optionKey;
    sound["volume"] = sliderValue;
  }
  else
  {
    JsonObject night = reqDoc["night"].to<JsonObject>();
    night["on"] = on;
    night["color"] = optionKey;
    night["brightness"] = sliderValue;
  }
  std::string body;
  serializeJson(reqDoc, body);

  std::string url = g_serverUrl + "/api/waffled-bites/device/settings";
  WbHttpResponse resp = wb_http_patch(url.c_str(), body.c_str(), g_accessToken.c_str());
  bool ok = resp.ok && resp.status == 200;
  if (ok)
    wb_do_poll();
  return ok;
}

// timer_screen.h's onStart/onEnd. Unlike wb_patch_settings/wb_complete_task,
// these hit device-authed routes dedicated to the kid starting/ending their
// OWN timer (/api/waffled-bites/device/timer/{start,end}) — a parent starts/
// ends one from the web app instead, via the parent-side routes. Same
// synchronous refresh-then-poll-on-success pattern as the others.
static bool wb_start_timer(int durationSec)
{
  if (wb_tick_ms() >= g_tokenExpiresAtMs)
  {
    if (!wb_refresh_access_token())
      return false;
  }
  JsonDocument reqDoc;
  reqDoc["durationSec"] = durationSec;
  std::string body;
  serializeJson(reqDoc, body);

  std::string url = g_serverUrl + "/api/waffled-bites/device/timer/start";
  WbHttpResponse resp = wb_http_post(url.c_str(), body.c_str(), g_accessToken.c_str());
  bool ok = resp.ok && resp.status == 200;
  if (ok)
    wb_do_poll();
  return ok;
}

static bool wb_end_timer()
{
  if (wb_tick_ms() >= g_tokenExpiresAtMs)
  {
    if (!wb_refresh_access_token())
      return false;
  }
  std::string url = g_serverUrl + "/api/waffled-bites/device/timer/end";
  WbHttpResponse resp = wb_http_post(url.c_str(), "{}", g_accessToken.c_str());
  bool ok = resp.ok && resp.status == 200;
  if (ok)
    wb_do_poll();
  return ok;
}

// Builds home/settings from mock data as an immediate placeholder (so
// lv_scr_load never shows a blank screen), shows home, then does one
// synchronous poll right away rather than waiting up to 5s for the first
// real data, and (re)starts the 5s poll timer.
static void wb_enter_app()
{
  g_liveScreensBuilt = false; // next wb_do_poll() does one real full build, not a sync
  lv_obj_clean(home_scr);
  lv_obj_clean(settings_scr);
  wb_build_home_screen(home_scr, wb_mock_state(), settings_scr, tasks_scr, wb_complete_task, wb_uncomplete_task);
  wb_build_settings_screen(settings_scr, wb_mock_state(), home_scr, detail_scr, timer_scr, bedtime_scr, forget_scr, wb_patch_settings, wb_forget_pairing_and_unpair);
  lv_scr_load(home_scr);

  wb_do_poll(); // also does timer_scr/bedtime_scr's real first build — see wb_do_poll's g_liveScreensBuilt branch

  if (g_pollTimer)
    lv_timer_del(g_pollTimer);
  g_pollTimer = lv_timer_create(wb_poll_timer_cb, 5000, nullptr);
}

static void wb_on_paired(const std::string &serverUrl, const std::string &deviceSecret)
{
  wb_store_set("serverUrl", serverUrl);
  wb_store_set("deviceSecret", deviceSecret);
  g_serverUrl = serverUrl;
  g_deviceSecret = deviceSecret;
  g_tokenExpiresAtMs = 0; // force an immediate token mint in wb_enter_app's poll
  wb_enter_app();
}

static void wb_show_onboarding()
{
  if (!onboarding_built)
  {
    wb_build_onboarding_screen(onboarding_scr, g_serverUrl.empty() ? WB_API_BASE_URL : g_serverUrl.c_str(), wb_on_paired, wb_show_wifi_picker);
    onboarding_built = true;
  }
  lv_scr_load(onboarding_scr);
}

// wifi_screen.h's onConnected — WiFi just came up (or the desktop simulator
// pretended it did). Persists the credentials so setup() doesn't need to
// show wifi_scr again next boot, then falls through to whichever of
// onboarding/the live app comes next (same decision wb_boot_next made once
// already at boot, re-evaluated here since only the WiFi half of it was
// unknown then).
static void wb_on_wifi_connected(const std::string &ssid, const std::string &pass)
{
  wb_store_set("wifiSsid", ssid);
  wb_store_set("wifiPass", pass);
  if (g_deviceSecret.empty())
    wb_show_onboarding();
  else
    wb_enter_app();
}

// Re-opens the WiFi picker from the onboarding screen's "Change Wi-Fi
// network" chip — the only way back to it once a network's already saved,
// otherwise a wrong/moved network left onboarding permanently unreachable.
// Rebuilt fresh on every tap (same pattern as tasks_scr/detail_scr/
// forget_scr — see their declarations above) rather than built once at boot,
// so it doesn't kick off an extra WiFi scan on every boot that already has
// working WiFi.
static void wb_show_wifi_picker()
{
  lv_obj_clean(wifi_scr);
  wb_build_wifi_screen(wifi_scr, wb_on_wifi_connected);
  lv_scr_load(wifi_scr);
}

void setup()
{
#if defined(ARDUINO)
  Serial.begin(115200);
  Wire.begin(WB_TOUCH_SDA, WB_TOUCH_SCL);
  // Plain on/off for now, not PWM brightness — the LEDC API differs across
  // arduino-esp32 core versions (ledcAttach(pin,...) vs. the older
  // ledcSetup+ledcAttachPin+ledcWrite(channel,...)) and this hasn't been checked
  // against real hardware yet. Revisit once a board's in hand and Screen &
  // display's brightness setting needs to actually dim something.
  pinMode(WB_BACKLIGHT_PIN, OUTPUT);
  digitalWrite(WB_BACKLIGHT_PIN, HIGH);
#endif

  lcd.init();

#if defined(ARDUINO)
  ts.begin();
  ts.setRotation(ROTATION_NORMAL);
#endif

  lv_init();
  // v9 dropped LV_TICK_CUSTOM from lv_conf.h in favor of this runtime call —
  // wb_tick_ms's signature (uint32_t(*)(void)) already matches lv_tick_get_cb_t
  // exactly, so wb_tick_hal.h/.cpp themselves needed no changes.
  lv_tick_set_cb(wb_tick_ms);

  lv_display_t *disp = lv_display_create(1024, 600);
  lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
  lv_display_set_flush_cb(disp, disp_flush);
  lv_display_set_buffers(disp, buf1, NULL, sizeof(buf1), LV_DISPLAY_RENDER_MODE_PARTIAL);

  lv_indev_t *indev = lv_indev_create();
  lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(indev, touchpad_read);

#if defined(ARDUINO)
  // Show something before the WiFi-connect attempt below — previously the
  // very first screen wasn't built until after that attempt, so a slow/absent
  // network left the panel showing an undefined framebuffer for the whole
  // wait with zero feedback. This screen is a one-time throwaway (never
  // referenced again after lv_scr_load below switches away from it).
  lv_obj_t *boot_scr = lv_obj_create(NULL);
  lv_obj_set_style_bg_color(boot_scr, lv_color_hex(0xF5EFE1), 0);
  lv_obj_set_style_bg_opa(boot_scr, LV_OPA_COVER, 0);
  lv_obj_set_flex_flow(boot_scr, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(boot_scr, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_t *boot_logo = lv_image_create(boot_scr);
  lv_image_set_src(boot_logo, &wb_logo_96);
  lv_obj_set_style_pad_bottom(boot_logo, 8, 0);
  lv_obj_t *boot_title = lv_label_create(boot_scr);
  lv_label_set_text(boot_title, "Waffled");
  lv_obj_set_style_text_font(boot_title, &lv_font_montserrat_24, 0);
  lv_obj_t *boot_sub = lv_label_create(boot_scr);
  lv_label_set_text(boot_sub, "Connecting...");
  lv_obj_set_style_text_color(boot_sub, lv_color_hex(0x8A8478), 0);
  lv_scr_load(boot_scr);
  lv_timer_handler(); // flush this frame before the blocking wait below
#endif

  home_scr = lv_obj_create(NULL);
  settings_scr = lv_obj_create(NULL);
  onboarding_scr = lv_obj_create(NULL);
  wifi_scr = lv_obj_create(NULL);
  tasks_scr = lv_obj_create(NULL);
  detail_scr = lv_obj_create(NULL);
  quiet_scr = lv_obj_create(NULL);
  timer_scr = lv_obj_create(NULL);
  bedtime_scr = lv_obj_create(NULL);
  forget_scr = lv_obj_create(NULL);

  // A small "Offline" pill on the always-on-top layer — see g_offlineBadge's
  // header comment. Built once here, toggled hidden/visible by
  // wb_mark_poll_failed/wb_mark_poll_ok, never rebuilt.
  g_offlineBadge = lv_obj_create(lv_layer_top());
  lv_obj_remove_style_all(g_offlineBadge);
  lv_obj_set_size(g_offlineBadge, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(g_offlineBadge, lv_color_hex(0x1C1A18), 0);
  lv_obj_set_style_bg_opa(g_offlineBadge, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(g_offlineBadge, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(g_offlineBadge, 14, 0);
  lv_obj_set_style_pad_ver(g_offlineBadge, 8, 0);
  lv_obj_set_flex_flow(g_offlineBadge, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(g_offlineBadge, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_column(g_offlineBadge, 6, 0);
  lv_obj_clear_flag(g_offlineBadge, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(g_offlineBadge, LV_OBJ_FLAG_CLICKABLE); // never eat a tap meant for the screen underneath
  lv_obj_align(g_offlineBadge, LV_ALIGN_TOP_LEFT, 16, 16);
  lv_obj_add_flag(g_offlineBadge, LV_OBJ_FLAG_HIDDEN);

  lv_obj_t *offline_dot = lv_obj_create(g_offlineBadge);
  lv_obj_remove_style_all(offline_dot);
  lv_obj_set_size(offline_dot, 8, 8);
  lv_obj_set_style_bg_color(offline_dot, lv_color_hex(0xE8B23D), 0); // same amber as the wake-light warn state — "needs attention"
  lv_obj_set_style_bg_opa(offline_dot, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(offline_dot, LV_RADIUS_CIRCLE, 0);
  lv_obj_clear_flag(offline_dot, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(offline_dot, LV_OBJ_FLAG_CLICKABLE);

  lv_obj_t *offline_lbl = lv_label_create(g_offlineBadge);
  lv_label_set_text(offline_lbl, "Offline");
  lv_obj_set_style_text_font(offline_lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(offline_lbl, lv_color_white(), 0);

  g_deviceSecret = wb_store_get("deviceSecret");
  g_serverUrl = wb_store_get("serverUrl");
  if (g_serverUrl.empty())
    g_serverUrl = WB_API_BASE_URL;

  // Try the saved WiFi credentials (if any) before deciding what to show.
  // Uses wb_wifi.h (real WiFi.h on esp32-p4, a simulated connect on native)
  // rather than a raw blocking WiFi.begin loop, so this same path is
  // exercisable in the desktop simulator too — see wb_wifi_native.cpp.
  std::string savedWifiSsid = wb_store_get("wifiSsid");
  std::string savedWifiPass = wb_store_get("wifiPass");
  bool wifiConnected = false;
  if (!savedWifiSsid.empty())
  {
    wb_wifi_connect(savedWifiSsid, savedWifiPass);
    uint32_t wifiStart = wb_tick_ms();
    while (wb_wifi_connect_status() == WbWifiConnStatus::Connecting && wb_tick_ms() - wifiStart < 15000)
    {
      lv_timer_handler(); // keep the display/touch pipeline alive during the wait, not frozen
#if defined(ARDUINO)
      delay(5);
#endif
    }
    wifiConnected = (wb_wifi_connect_status() == WbWifiConnStatus::Connected);
  }

  switch (wb_boot_next(!savedWifiSsid.empty(), wifiConnected, !g_deviceSecret.empty()))
  {
  case WbBootNext::ShowWifiPicker:
    wb_show_wifi_picker();
    break;
  case WbBootNext::ShowOnboarding:
    wb_show_onboarding();
    break;
  case WbBootNext::EnterApp:
    wb_enter_app();
    break;
  }
}

void loop()
{
  lv_timer_handler();
#if defined(ARDUINO)
  delay(5);
#else
  std::this_thread::sleep_for(std::chrono::milliseconds(5));
#endif
}

