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
#include "ui/home_screen.h"
#include "ui/settings_screen.h"
#include "ui/control_detail_screen.h"
#include "ui/onboarding_screen.h"
#include "ui/quiet_screen.h"
#include <ArduinoJson.h>
#include <string>

#if defined(ARDUINO)
#include <Wire.h>
#include <TAMC_GT911.h>
#include <WiFi.h>
static TAMC_GT911 ts = TAMC_GT911(WB_TOUCH_SDA, WB_TOUCH_SCL, WB_TOUCH_INT, WB_TOUCH_RST, 1024, 600);
#ifndef WB_WIFI_SSID
#define WB_WIFI_SSID "" // set via platformio.ini's esp32-p4 build_flags
#endif
#ifndef WB_WIFI_PASS
#define WB_WIFI_PASS ""
#endif
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
    data->point.x = ts.points[0].x;
    data->point.y = ts.points[0].y;
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
static lv_obj_t *tasks_scr;  // rebuilt fresh each time a routine tile is tapped — see home_screen.cpp
static lv_obj_t *detail_scr; // rebuilt fresh each time the Sounds/Nightlight tile is tapped — see settings_screen.cpp
static lv_obj_t *quiet_scr;  // force-shown whenever the poll reports quiet time active — see wb_do_poll
static bool onboarding_built = false;
static bool g_quietWasActive = false;
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

static void wb_show_onboarding();
static void wb_enter_app();
static bool wb_complete_task(const std::string &taskId);
static bool wb_patch_settings(WbSettingsKey key, bool on, const std::string &optionKey, int sliderValue);

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
    wb_store_clear("deviceSecret");
    g_deviceSecret.clear();
    if (g_pollTimer)
    {
      lv_timer_del(g_pollTimer);
      g_pollTimer = nullptr;
    }
    wb_show_onboarding();
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
// home screen on success. Any failure (network, parse, revoked) just skips
// this tick and leaves the screen showing the last-good state — never
// blanks it on a transient hiccup.
static void wb_do_poll()
{
  if (wb_tick_ms() >= g_tokenExpiresAtMs)
  {
    if (!wb_refresh_access_token())
      return;
  }

  std::string url = g_serverUrl + "/api/waffled-bites/device/state";
  WbHttpResponse resp = wb_http_get(url.c_str(), g_accessToken.c_str());
  if (!resp.ok || resp.status != 200)
    return;

  JsonDocument doc;
  if (deserializeJson(doc, resp.body))
    return;

  static WbDeviceState liveState;
  if (wb_state_from_json(doc, liveState))
  {
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
      wb_build_home_screen(home_scr, liveState, settings_scr, tasks_scr, wb_complete_task);
      lv_obj_clean(settings_scr);
      wb_build_settings_screen(settings_scr, liveState, home_scr, detail_scr, wb_patch_settings);
      g_liveScreensBuilt = true;
    }
    else
    {
      wb_sync_home_screen(home_scr, liveState);
      wb_sync_settings_screen(settings_scr, liveState);

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
static bool wb_complete_task(const std::string &taskId)
{
  if (taskId.empty()) // mock/placeholder tasks have no real instance id
    return false;

  if (wb_tick_ms() >= g_tokenExpiresAtMs)
  {
    if (!wb_refresh_access_token())
      return false;
  }

  std::string url = g_serverUrl + "/api/waffled-bites/device/tasks/" + taskId + "/complete";
  WbHttpResponse resp = wb_http_post(url.c_str(), "{}", g_accessToken.c_str());
  bool ok = resp.ok && resp.status == 200;
  if (ok)
    wb_do_poll();
  return ok;
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

// Builds home/settings from mock data as an immediate placeholder (so
// lv_scr_load never shows a blank screen), shows home, then does one
// synchronous poll right away rather than waiting up to 5s for the first
// real data, and (re)starts the 5s poll timer.
static void wb_enter_app()
{
  g_liveScreensBuilt = false; // next wb_do_poll() does one real full build, not a sync
  lv_obj_clean(home_scr);
  lv_obj_clean(settings_scr);
  wb_build_home_screen(home_scr, wb_mock_state(), settings_scr, tasks_scr, wb_complete_task);
  wb_build_settings_screen(settings_scr, wb_mock_state(), home_scr, detail_scr, wb_patch_settings);
  lv_scr_load(home_scr);

  wb_do_poll();

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
    wb_build_onboarding_screen(onboarding_scr, g_serverUrl.empty() ? WB_API_BASE_URL : g_serverUrl.c_str(), wb_on_paired);
    onboarding_built = true;
  }
  lv_scr_load(onboarding_scr);
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
  // Hardcoded credentials until real WiFi provisioning exists (deferred —
  // see the firmware README); blocking wait at boot only, a connection lost
  // later just makes every wb_http call fail until it comes back, which
  // wb_do_poll already tolerates by skipping that tick.
  WiFi.mode(WIFI_STA);
  WiFi.begin(WB_WIFI_SSID, WB_WIFI_PASS);
  uint32_t wifiStart = wb_tick_ms();
  while (WiFi.status() != WL_CONNECTED && wb_tick_ms() - wifiStart < 15000)
    delay(200);
#endif

  home_scr = lv_obj_create(NULL);
  settings_scr = lv_obj_create(NULL);
  onboarding_scr = lv_obj_create(NULL);
  tasks_scr = lv_obj_create(NULL);
  detail_scr = lv_obj_create(NULL);
  quiet_scr = lv_obj_create(NULL);

  g_deviceSecret = wb_store_get("deviceSecret");
  g_serverUrl = wb_store_get("serverUrl");
  if (g_serverUrl.empty())
    g_serverUrl = WB_API_BASE_URL;

  if (g_deviceSecret.empty())
    wb_show_onboarding();
  else
    wb_enter_app();
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

