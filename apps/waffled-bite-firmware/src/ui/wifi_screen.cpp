#include "wifi_screen.h"
#include "../wb_wifi.h"
#include "../icons/wb_icons.h"
#include <cstdio>
#include <cstring>
#include <cstdlib>

// Palette — kept in sync with onboarding_screen.cpp's/settings_screen.cpp's
// by eye; duplicated rather than shared, same rationale as those files.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_ROW lv_color_hex(0xF0EAE0)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_GOLD lv_color_hex(0xC98A1E)
#define WB_COLOR_ERROR lv_color_hex(0xB3372C)

// How many times to silently retry a scan that fails to even start (STA
// driver busy — see wb_wifi_esp32.cpp's wb_wifi_begin_scan()) before giving
// up and telling the kid to tap Rescan themselves.
#define WB_WIFI_SCAN_RETRY_LIMIT 5

enum class WbWifiUiState
{
  List,
  Password,
  Connecting,
};

// Bundles every widget/callback the poll timer and tap handlers need to
// reach. Unlike onboarding_screen.cpp's screen (genuinely built once),
// wb_build_wifi_screen() reruns every time the picker is reopened (e.g. the
// "Change Wi-Fi network" chip on the paired-app screens calls
// wb_show_wifi_picker(), which does lv_obj_clean(wifi_scr) then rebuilds) —
// so this ctx and its 200ms poll timer must be torn down on every rebuild,
// same pattern as quiet_screen.cpp's WbQuietCtx/timer_screen.cpp's own ctx:
// tied to a real child object's LV_EVENT_DELETE (see wb_wifi_ctx_delete_cb
// below), not left to a "never freed" assumption that doesn't hold here.
struct WbWifiScreenCtx
{
  lv_obj_t *list_view;
  lv_obj_t *scanning_lbl;
  lv_obj_t *rows_container;
  bool rowsBuilt;
  int scanFailCount; // consecutive WbWifiScanStatus::Failed results since the last begin_scan()

  lv_obj_t *password_view;
  lv_obj_t *password_title_lbl;
  lv_obj_t *password_ta;
  lv_obj_t *password_error_lbl;

  lv_obj_t *connecting_view;
  lv_obj_t *connecting_lbl;

  lv_obj_t *kb;
  WbWifiUiState uiState;
  std::string selectedSsid;
  WbWifiConnectedCallback onConnected;
  lv_timer_t *pollTimer;
};

// Fires when `card` (a real child of the wifi screen, recreated on every
// wb_build_wifi_screen() call) is destroyed — i.e. on the next
// lv_obj_clean(wifi_scr) before a rebuild, or whenever the whole screen tree
// is torn down. Without this, a picker reopen left the old ctx's poll timer
// running forever against just-freed LVGL objects (a use-after-free) on top
// of leaking the ctx itself — confirmed by code audit, not yet seen on a
// real device, but a real bug regardless of the WiFi-scan fix session that
// surfaced it.
static void wb_wifi_ctx_delete_cb(lv_event_t *e)
{
  WbWifiScreenCtx *ctx = (WbWifiScreenCtx *)lv_event_get_user_data(e);
  if (ctx->pollTimer)
    lv_timer_del(ctx->pollTimer);
  delete ctx;
}

static void wb_wifi_show_view(WbWifiScreenCtx *ctx, WbWifiUiState state)
{
  lv_obj_add_flag(ctx->list_view, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(ctx->password_view, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(ctx->connecting_view, LV_OBJ_FLAG_HIDDEN);
  switch (state)
  {
  case WbWifiUiState::List:
    lv_obj_clear_flag(ctx->list_view, LV_OBJ_FLAG_HIDDEN);
    break;
  case WbWifiUiState::Password:
    lv_obj_clear_flag(ctx->password_view, LV_OBJ_FLAG_HIDDEN);
    break;
  case WbWifiUiState::Connecting:
    lv_obj_clear_flag(ctx->connecting_view, LV_OBJ_FLAG_HIDDEN);
    break;
  }
  ctx->uiState = state;
}

static const char *wb_signal_label(int rssi)
{
  if (rssi >= -60)
    return "Strong signal";
  if (rssi >= -75)
    return "Good signal";
  return "Weak signal";
}

static void wb_open_password_cb(lv_event_t *e)
{
  WbWifiScreenCtx *ctx = (WbWifiScreenCtx *)lv_event_get_user_data(e);
  const char *ssid = (const char *)lv_obj_get_user_data((lv_obj_t *)lv_event_get_target(e));
  ctx->selectedSsid = ssid;
  lv_label_set_text_fmt(ctx->password_title_lbl, "Password for \"%s\"", ssid);
  lv_textarea_set_text(ctx->password_ta, "");
  lv_obj_add_flag(ctx->password_error_lbl, LV_OBJ_FLAG_HIDDEN);
  wb_wifi_show_view(ctx, WbWifiUiState::Password);
}

// Open networks skip the password screen entirely — connect immediately.
static void wb_open_network_cb(lv_event_t *e)
{
  WbWifiScreenCtx *ctx = (WbWifiScreenCtx *)lv_event_get_user_data(e);
  const char *ssid = (const char *)lv_obj_get_user_data((lv_obj_t *)lv_event_get_target(e));
  ctx->selectedSsid = ssid;
  lv_label_set_text_fmt(ctx->connecting_lbl, "Connecting to \"%s\"...", ssid);
  wb_wifi_connect(ctx->selectedSsid, "");
  wb_wifi_show_view(ctx, WbWifiUiState::Connecting);
}

// Row SSID text is heap-copied (strdup) because lv_obj_set_user_data just
// stores a raw pointer — the JsonDocument-free WbWifiNetwork list backing it
// doesn't outlive this call. Freed on the row's LV_EVENT_DELETE, which fires
// for every row when wb_wifi_build_rows next clears rows_container (rescan
// or a fresh scan on the very first build).
static void wb_row_ssid_delete_cb(lv_event_t *e)
{
  free(lv_obj_get_user_data((lv_obj_t *)lv_event_get_target(e)));
}

static void wb_wifi_build_rows(WbWifiScreenCtx *ctx)
{
  lv_obj_clean(ctx->rows_container);
  std::vector<WbWifiNetwork> networks = wb_wifi_scan_results();
  for (const WbWifiNetwork &net : networks)
  {
    lv_obj_t *row = lv_obj_create(ctx->rows_container);
    lv_obj_remove_style_all(row);
    lv_obj_set_size(row, lv_pct(100), LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(row, WB_COLOR_ROW, 0);
    lv_obj_set_style_bg_opa(row, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(row, 20, 0);
    lv_obj_set_style_pad_hor(row, 24, 0);
    lv_obj_set_style_pad_ver(row, 18, 0);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_COLUMN);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *ssid_lbl = lv_label_create(row);
    lv_label_set_text(ssid_lbl, net.ssid.c_str());
    lv_obj_set_style_text_font(ssid_lbl, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(ssid_lbl, WB_COLOR_INK, 0);

    lv_obj_t *sub_lbl = lv_label_create(row);
    char sub[48];
    // Plain hyphen, not a middle dot (·, U+00B7) — the built-in LVGL
    // Montserrat fonts are only baked with the Basic Latin (ASCII) range
    // here (see lv_conf.h), so anything outside 0x20-0x7E renders as a
    // missing-glyph box instead of the actual character. Confirmed live on
    // real hardware (a "tofu" square between "Secured" and "Strong signal").
    snprintf(sub, sizeof(sub), "%s - %s", net.secure ? "Secured" : "Open", wb_signal_label(net.rssi));
    lv_label_set_text(sub_lbl, sub);
    lv_obj_set_style_text_font(sub_lbl, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(sub_lbl, WB_COLOR_MUTED, 0);

    lv_obj_set_user_data(row, strdup(net.ssid.c_str()));
    lv_obj_add_event_cb(row, wb_row_ssid_delete_cb, LV_EVENT_DELETE, nullptr);
    lv_obj_add_event_cb(row, net.secure ? wb_open_password_cb : wb_open_network_cb, LV_EVENT_CLICKED, ctx);
  }
}

// A big, chunky tappable pill (icon/text label wrapped in a padded,
// backgrounded container) — used for Rescan and Back. Plain clickable
// labels (the original shape here) have no background for LVGL's default
// press-state darkening to show against, and a tiny hit-box matching just
// the rendered glyphs — near-impossible to tell whether a real finger
// actually landed on them (confirmed on real hardware during bring-up: no
// visible feedback at all on tap). This gives both a real touch target size
// and visible press feedback, matching settings_screen.cpp's back_btn
// pattern. Sized up (font_14/pad 16x10 -> font_24/pad 32x18, fully rounded)
// per direct request — this and every other utility-screen button read too
// small/adult-app-ish for a kid-facing device next to the big home-screen
// tiles.
static lv_obj_t *make_tap_chip(lv_obj_t *parent, const char *text, lv_color_t text_color)
{
  lv_obj_t *chip = lv_obj_create(parent);
  lv_obj_remove_style_all(chip);
  lv_obj_set_size(chip, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(chip, WB_COLOR_ROW, 0);
  lv_obj_set_style_bg_opa(chip, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(chip, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(chip, 32, 0);
  lv_obj_set_style_pad_ver(chip, 18, 0);
  lv_obj_clear_flag(chip, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *lbl = lv_label_create(chip);
  lv_label_set_text(lbl, text);
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(lbl, text_color, 0);
  return chip;
}

static void wb_rescan_clicked_cb(lv_event_t *e)
{
  WbWifiScreenCtx *ctx = (WbWifiScreenCtx *)lv_event_get_user_data(e);
  lv_obj_clean(ctx->rows_container);
  ctx->rowsBuilt = false;
  ctx->scanFailCount = 0;
  lv_label_set_text(ctx->scanning_lbl, "Scanning for networks...");
  lv_obj_clear_flag(ctx->scanning_lbl, LV_OBJ_FLAG_HIDDEN);
  wb_wifi_begin_scan();
}

static void wb_password_back_cb(lv_event_t *e)
{
  WbWifiScreenCtx *ctx = (WbWifiScreenCtx *)lv_event_get_user_data(e);
  wb_wifi_show_view(ctx, WbWifiUiState::List);
}

static void wb_password_connect_cb(lv_event_t *e)
{
  WbWifiScreenCtx *ctx = (WbWifiScreenCtx *)lv_event_get_user_data(e);
  const char *pass = lv_textarea_get_text(ctx->password_ta);
  lv_label_set_text_fmt(ctx->connecting_lbl, "Connecting to \"%s\"...", ctx->selectedSsid.c_str());
  wb_wifi_connect(ctx->selectedSsid, pass);
  wb_wifi_show_view(ctx, WbWifiUiState::Connecting);
}

// Bundles what the focus/defocus handlers need — kb plus `card` so it can be
// shifted up out from under the keyboard (see wb_ta_focused_cb).
struct WbKbCtx
{
  lv_obj_t *kb;
  lv_obj_t *card;
};
static void wb_kb_ctx_delete_cb(lv_event_t *e) { delete (WbKbCtx *)lv_event_get_user_data(e); }

// Shared LV_EVENT_FOCUSED/DEFOCUSED handlers for the password textarea —
// identical pattern to onboarding_screen.cpp's wb_ta_focused_cb/
// wb_ta_defocused_cb, duplicated rather than shared for the same reason
// those aren't factored out (each screen file owns its own small helpers).
// Shifts `card` up if the focused field would otherwise sit under the
// keyboard overlay — see onboarding_screen.cpp's identical fix for the full
// rationale (confirmed live there; applied here defensively too, since this
// screen's password field sits inside the same kind of fixed-size card and
// shares the identical risk, just not yet confirmed broken on real hardware).
static void wb_ta_focused_cb(lv_event_t *e)
{
  lv_obj_t *ta = (lv_obj_t *)lv_event_get_target(e);
  WbKbCtx *kbCtx = (WbKbCtx *)lv_event_get_user_data(e);
  lv_keyboard_set_textarea(kbCtx->kb, ta);
  lv_obj_clear_flag(kbCtx->kb, LV_OBJ_FLAG_HIDDEN);

  lv_area_t ta_coords, kb_coords;
  lv_obj_get_coords(ta, &ta_coords);
  lv_obj_get_coords(kbCtx->kb, &kb_coords);
  int32_t overflow = ta_coords.y2 - kb_coords.y1 + 16; // 16px breathing room above the keyboard
  lv_obj_set_style_translate_y(kbCtx->card, overflow > 0 ? -overflow : 0, 0);
}

static void wb_ta_defocused_cb(lv_event_t *e)
{
  WbKbCtx *kbCtx = (WbKbCtx *)lv_event_get_user_data(e);
  lv_obj_add_flag(kbCtx->kb, LV_OBJ_FLAG_HIDDEN);
  lv_obj_set_style_translate_y(kbCtx->card, 0, 0);
}

static void wb_wifi_screen_poll_cb(lv_timer_t *timer)
{
  WbWifiScreenCtx *ctx = (WbWifiScreenCtx *)lv_timer_get_user_data(timer);

  if (ctx->uiState == WbWifiUiState::List && !ctx->rowsBuilt)
  {
    WbWifiScanStatus status = wb_wifi_scan_status();
    if (status == WbWifiScanStatus::Done)
    {
      wb_wifi_build_rows(ctx);
      ctx->rowsBuilt = true;
      lv_obj_add_flag(ctx->scanning_lbl, LV_OBJ_FLAG_HIDDEN);
    }
    else if (status == WbWifiScanStatus::Failed)
    {
      // The scan request itself failed to even start (STA driver was still
      // busy) — retry a few times before asking the kid to tap Rescan
      // themselves, rather than silently showing an empty list forever.
      ctx->scanFailCount++;
      if (ctx->scanFailCount <= WB_WIFI_SCAN_RETRY_LIMIT)
      {
        wb_wifi_begin_scan();
      }
      else
      {
        lv_label_set_text(ctx->scanning_lbl, "Couldn't scan for networks. Tap Rescan to try again.");
      }
    }
  }
  else if (ctx->uiState == WbWifiUiState::Connecting)
  {
    WbWifiConnStatus status = wb_wifi_connect_status();
    if (status == WbWifiConnStatus::Connected)
    {
      std::string ssid = ctx->selectedSsid;
      std::string pass = lv_textarea_get_text(ctx->password_ta);
      lv_timer_del(ctx->pollTimer);
      ctx->pollTimer = nullptr;
      ctx->onConnected(ssid, pass);
    }
    else if (status == WbWifiConnStatus::Failed)
    {
      lv_label_set_text(ctx->password_error_lbl, "Couldn't connect. Check the password and try again.");
      lv_obj_clear_flag(ctx->password_error_lbl, LV_OBJ_FLAG_HIDDEN);
      wb_wifi_show_view(ctx, WbWifiUiState::Password);
    }
  }
}

void wb_build_wifi_screen(lv_obj_t *parent, WbWifiConnectedCallback onConnected)
{
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(parent, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_all(parent, 24, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  // Grown from 460x460 alongside the chunkier button/row sizing below — the
  // smaller card started clipping/crowding once rows and buttons doubled in
  // size; 620x560 still leaves real margin on the 1024x600 panel.
  lv_obj_t *card = lv_obj_create(parent);
  lv_obj_remove_style_all(card);
  lv_obj_set_size(card, 620, 560);
  lv_obj_set_style_bg_color(card, WB_COLOR_CARD, 0);
  lv_obj_set_style_bg_opa(card, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(card, 20, 0);
  lv_obj_set_style_pad_all(card, 24, 0);
  lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

  auto *ctx = new WbWifiScreenCtx{};
  ctx->onConnected = onConnected;
  ctx->uiState = WbWifiUiState::List;
  ctx->rowsBuilt = false;
  ctx->scanFailCount = 0;
  lv_obj_add_event_cb(card, wb_wifi_ctx_delete_cb, LV_EVENT_DELETE, ctx);

  // ── list view ────────────────────────────────────────────────────────────
  lv_obj_t *list_view = lv_obj_create(card);
  lv_obj_remove_style_all(list_view);
  lv_obj_set_size(list_view, lv_pct(100), lv_pct(100));
  lv_obj_set_flex_flow(list_view, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(list_view, 10, 0);
  lv_obj_clear_flag(list_view, LV_OBJ_FLAG_SCROLLABLE);
  ctx->list_view = list_view;

  // A plain row wrapper, not lv_obj_set_align on the image directly — same
  // "flex column ignores per-child align" reasoning as onboarding_screen.cpp's
  // logo_row.
  lv_obj_t *logo_row = lv_obj_create(list_view);
  lv_obj_remove_style_all(logo_row);
  lv_obj_set_size(logo_row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(logo_row, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(logo_row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(logo_row, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *logo = lv_image_create(logo_row);
  lv_image_set_src(logo, &wb_logo_96);

  lv_obj_t *title = lv_label_create(list_view);
  lv_label_set_text(title, "Connect to WiFi");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_INK, 0);

  lv_obj_t *scanning_lbl = lv_label_create(list_view);
  lv_label_set_text(scanning_lbl, "Scanning for networks...");
  lv_obj_set_style_text_font(scanning_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(scanning_lbl, WB_COLOR_MUTED, 0);
  ctx->scanning_lbl = scanning_lbl;

  lv_obj_t *rows_container = lv_obj_create(list_view);
  lv_obj_remove_style_all(rows_container);
  lv_obj_set_size(rows_container, lv_pct(100), lv_pct(100));
  lv_obj_set_flex_grow(rows_container, 1);
  lv_obj_set_flex_flow(rows_container, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(rows_container, 12, 0);
  ctx->rows_container = rows_container;

  lv_obj_t *rescan_btn = make_tap_chip(list_view, LV_SYMBOL_REFRESH " Rescan", WB_COLOR_GOLD);
  lv_obj_add_event_cb(rescan_btn, wb_rescan_clicked_cb, LV_EVENT_CLICKED, ctx);

  // ── password view ────────────────────────────────────────────────────────
  lv_obj_t *password_view = lv_obj_create(card);
  lv_obj_remove_style_all(password_view);
  lv_obj_set_size(password_view, lv_pct(100), lv_pct(100));
  lv_obj_set_flex_flow(password_view, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(password_view, 10, 0);
  lv_obj_clear_flag(password_view, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_flag(password_view, LV_OBJ_FLAG_HIDDEN);
  ctx->password_view = password_view;

  lv_obj_t *back_chip = make_tap_chip(password_view, LV_SYMBOL_LEFT " Back", WB_COLOR_MUTED);
  lv_obj_add_event_cb(back_chip, wb_password_back_cb, LV_EVENT_CLICKED, ctx);

  lv_obj_t *password_title_lbl = lv_label_create(password_view);
  lv_label_set_text(password_title_lbl, "Password");
  lv_obj_set_style_text_font(password_title_lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(password_title_lbl, WB_COLOR_INK, 0);
  lv_label_set_long_mode(password_title_lbl, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(password_title_lbl, lv_pct(100));
  ctx->password_title_lbl = password_title_lbl;

  lv_obj_t *password_ta = lv_textarea_create(password_view);
  lv_textarea_set_one_line(password_ta, true);
  lv_textarea_set_password_mode(password_ta, true);
  lv_obj_set_size(password_ta, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(password_ta, WB_COLOR_ROW, 0);
  lv_obj_set_style_bg_opa(password_ta, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(password_ta, 0, 0);
  lv_obj_set_style_radius(password_ta, 16, 0);
  lv_obj_set_style_pad_all(password_ta, 14, 0);
  lv_obj_set_style_text_font(password_ta, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(password_ta, WB_COLOR_INK, 0);
  ctx->password_ta = password_ta;

  lv_obj_t *password_error_lbl = lv_label_create(password_view);
  lv_label_set_text(password_error_lbl, "");
  lv_obj_set_style_text_font(password_error_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(password_error_lbl, WB_COLOR_ERROR, 0);
  lv_label_set_long_mode(password_error_lbl, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(password_error_lbl, lv_pct(100));
  lv_obj_add_flag(password_error_lbl, LV_OBJ_FLAG_HIDDEN);
  ctx->password_error_lbl = password_error_lbl;

  lv_obj_t *connect_btn = lv_obj_create(password_view);
  lv_obj_remove_style_all(connect_btn);
  lv_obj_set_size(connect_btn, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(connect_btn, WB_COLOR_GOLD, 0);
  lv_obj_set_style_bg_opa(connect_btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(connect_btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_ver(connect_btn, 20, 0);
  lv_obj_set_flex_flow(connect_btn, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(connect_btn, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_top(connect_btn, 20, 0);
  lv_obj_clear_flag(connect_btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *connect_lbl = lv_label_create(connect_btn);
  lv_label_set_text(connect_lbl, "Connect");
  lv_obj_set_style_text_font(connect_lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(connect_lbl, lv_color_white(), 0);
  lv_obj_add_event_cb(connect_btn, wb_password_connect_cb, LV_EVENT_CLICKED, ctx);

  // Shared keyboard for the password field — parented to `parent` (not
  // `card`) so it docks to the bottom of the whole screen, same reasoning as
  // onboarding_screen.cpp's own keyboard. FLOATING is required: `parent` is
  // a centered flex column, and without this flag the keyboard becomes a
  // normal flex item — its own built-in bottom-docking (lv_keyboard_create
  // already calls lv_obj_align(BOTTOM_MID) internally) gets silently
  // overridden by the flex layout, which instead centers card+keyboard as
  // one stacked group. Confirmed on real hardware during bring-up: `card`
  // rendered shoved toward the top and the keyboard's bottom rows ran off
  // the bottom of the screen. FLOATING excludes it from flex layout so its
  // own alignment call actually takes effect.
  lv_obj_t *kb = lv_keyboard_create(parent);
  lv_obj_add_flag(kb, LV_OBJ_FLAG_FLOATING);
  lv_obj_add_flag(kb, LV_OBJ_FLAG_HIDDEN);
  lv_keyboard_set_textarea(kb, password_ta);
  ctx->kb = kb;
  // Freed on card's LV_EVENT_DELETE, same rule as `ctx` itself
  // (wb_wifi_ctx_delete_cb) — this screen rebuilds on every picker reopen,
  // so "never freed" would leak one of these per reopen.
  WbKbCtx *kbCtx = new WbKbCtx{kb, card};
  lv_obj_add_event_cb(card, wb_kb_ctx_delete_cb, LV_EVENT_DELETE, kbCtx);
  lv_obj_add_event_cb(password_ta, wb_ta_focused_cb, LV_EVENT_FOCUSED, kbCtx);
  lv_obj_add_event_cb(password_ta, wb_ta_defocused_cb, LV_EVENT_DEFOCUSED, kbCtx);

  // ── connecting view ──────────────────────────────────────────────────────
  lv_obj_t *connecting_view = lv_obj_create(card);
  lv_obj_remove_style_all(connecting_view);
  lv_obj_set_size(connecting_view, lv_pct(100), lv_pct(100));
  lv_obj_set_flex_flow(connecting_view, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(connecting_view, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(connecting_view, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_flag(connecting_view, LV_OBJ_FLAG_HIDDEN);
  ctx->connecting_view = connecting_view;

  lv_obj_t *connecting_logo = lv_image_create(connecting_view);
  lv_image_set_src(connecting_logo, &wb_logo_96);
  lv_obj_set_style_pad_bottom(connecting_logo, 8, 0);

  lv_obj_t *connecting_lbl = lv_label_create(connecting_view);
  lv_label_set_text(connecting_lbl, "Connecting...");
  lv_obj_set_style_text_font(connecting_lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(connecting_lbl, WB_COLOR_INK, 0);
  ctx->connecting_lbl = connecting_lbl;

  ctx->pollTimer = lv_timer_create(wb_wifi_screen_poll_cb, 200, ctx);

  wb_wifi_begin_scan();
}
