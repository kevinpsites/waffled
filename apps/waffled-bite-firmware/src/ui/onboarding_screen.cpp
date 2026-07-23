#include "onboarding_screen.h"
#include "../wb_http.h"
#include <ArduinoJson.h>
#include <cstdio>

// Palette — kept in sync with home_screen.cpp's/settings_screen.cpp's by eye;
// duplicated rather than shared, same rationale as settings_screen.cpp.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_GOLD lv_color_hex(0xC98A1E)
#define WB_COLOR_ERROR lv_color_hex(0xB3372C)

// Bundles the two textareas + the error label + the caller's callback so a
// single LV_EVENT_CLICKED handler on the Pair button can reach all of them —
// LVGL event callbacks only carry one void* of user data.
struct WbOnboardingCtx
{
  lv_obj_t *server_ta;
  lv_obj_t *code_ta;
  lv_obj_t *error_lbl;
  WbPairedCallback onPaired;
};

static lv_obj_t *make_field_label(lv_obj_t *parent, const char *text)
{
  lv_obj_t *lbl = lv_label_create(parent);
  lv_label_set_text(lbl, text);
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(lbl, WB_COLOR_MUTED, 0);
  return lbl;
}

static lv_obj_t *make_textarea(lv_obj_t *parent)
{
  lv_obj_t *ta = lv_textarea_create(parent);
  lv_textarea_set_one_line(ta, true);
  lv_obj_set_size(ta, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(ta, WB_COLOR_CARD, 0);
  lv_obj_set_style_bg_opa(ta, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(ta, 0, 0);
  lv_obj_set_style_radius(ta, 12, 0);
  lv_obj_set_style_text_font(ta, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(ta, WB_COLOR_INK, 0);
  return ta;
}

// Shared LV_EVENT_FOCUSED handler for both textareas: attaches the on-screen
// keyboard (created once, hidden by default) to whichever field was tapped.
// The keyboard object is stashed as this event's user_data.
static void wb_ta_focused_cb(lv_event_t *e)
{
  lv_obj_t *ta = (lv_obj_t *)lv_event_get_target(e);
  lv_obj_t *kb = (lv_obj_t *)lv_event_get_user_data(e);
  lv_keyboard_set_textarea(kb, ta);
  lv_obj_clear_flag(kb, LV_OBJ_FLAG_HIDDEN);
}

static void wb_ta_defocused_cb(lv_event_t *e)
{
  lv_obj_t *kb = (lv_obj_t *)lv_event_get_user_data(e);
  lv_obj_add_flag(kb, LV_OBJ_FLAG_HIDDEN);
}

static void wb_show_error(lv_obj_t *error_lbl, const char *message)
{
  lv_label_set_text(error_lbl, message);
  lv_obj_clear_flag(error_lbl, LV_OBJ_FLAG_HIDDEN);
}

static void wb_pair_clicked_cb(lv_event_t *e)
{
  WbOnboardingCtx *ctx = (WbOnboardingCtx *)lv_event_get_user_data(e);
  lv_obj_add_flag(ctx->error_lbl, LV_OBJ_FLAG_HIDDEN);

  const char *serverUrl = lv_textarea_get_text(ctx->server_ta);
  const char *code = lv_textarea_get_text(ctx->code_ta);
  if (serverUrl[0] == '\0' || code[0] == '\0')
  {
    wb_show_error(ctx->error_lbl, "Enter a server address and pairing code.");
    return;
  }

  JsonDocument reqDoc;
  reqDoc["code"] = code;
  std::string body;
  serializeJson(reqDoc, body);

  char url[160];
  snprintf(url, sizeof(url), "%s/api/waffled-bites/pair", serverUrl);

  // Synchronous/blocking on tap — a pairing request is a one-time,
  // user-initiated action (~1s), not worth an async abstraction this codebase
  // doesn't otherwise have.
  WbHttpResponse resp = wb_http_post(url, body.c_str(), nullptr);

  if (!resp.ok)
  {
    wb_show_error(ctx->error_lbl, "Couldn't reach that server. Check the address and try again.");
    return;
  }

  JsonDocument respDoc;
  DeserializationError parseErr = deserializeJson(respDoc, resp.body);

  if (resp.status == 201 && !parseErr && respDoc["deviceSecret"].is<const char *>())
  {
    std::string deviceSecret = respDoc["deviceSecret"].as<const char *>();
    ctx->onPaired(std::string(serverUrl), deviceSecret);
    return;
  }

  const char *serverMessage = (!parseErr && respDoc["message"].is<const char *>())
                                   ? respDoc["message"].as<const char *>()
                                   : "Something went wrong — try again.";
  wb_show_error(ctx->error_lbl, serverMessage);
}

void wb_build_onboarding_screen(lv_obj_t *parent, const char *defaultServerUrl, WbPairedCallback onPaired)
{
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(parent, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_all(parent, 24, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *card = lv_obj_create(parent);
  lv_obj_remove_style_all(card);
  lv_obj_set_size(card, 420, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(card, WB_COLOR_CARD, 0);
  lv_obj_set_style_bg_opa(card, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(card, 20, 0);
  lv_obj_set_style_pad_all(card, 24, 0);
  lv_obj_set_flex_flow(card, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(card, 6, 0);
  lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *title = lv_label_create(card);
  lv_label_set_text(title, "Set up your Waffled-Bite");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_INK, 0);
  lv_obj_set_style_pad_bottom(title, 10, 0);

  make_field_label(card, "Server address");
  lv_obj_t *server_ta = make_textarea(card);
  lv_textarea_set_text(server_ta, defaultServerUrl ? defaultServerUrl : "");
  lv_obj_set_style_pad_bottom(server_ta, 10, 0);

  make_field_label(card, "Pairing code");
  lv_obj_t *code_ta = make_textarea(card);
  lv_textarea_set_max_length(code_ta, 6);
  lv_textarea_set_placeholder_text(code_ta, "ABC123");

  lv_obj_t *error_lbl = lv_label_create(card);
  lv_label_set_text(error_lbl, "");
  lv_obj_set_style_text_font(error_lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(error_lbl, WB_COLOR_ERROR, 0);
  lv_label_set_long_mode(error_lbl, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(error_lbl, lv_pct(100));
  lv_obj_set_style_pad_top(error_lbl, 10, 0);
  lv_obj_add_flag(error_lbl, LV_OBJ_FLAG_HIDDEN);

  lv_obj_t *pair_btn = lv_obj_create(card);
  lv_obj_remove_style_all(pair_btn);
  lv_obj_set_size(pair_btn, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(pair_btn, WB_COLOR_GOLD, 0);
  lv_obj_set_style_bg_opa(pair_btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(pair_btn, 14, 0);
  lv_obj_set_style_pad_ver(pair_btn, 12, 0);
  lv_obj_set_flex_flow(pair_btn, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(pair_btn, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_top(pair_btn, 16, 0);
  lv_obj_clear_flag(pair_btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *pair_lbl = lv_label_create(pair_btn);
  lv_label_set_text(pair_lbl, "Pair");
  lv_obj_set_style_text_font(pair_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(pair_lbl, lv_color_white(), 0);

  // The on-screen keyboard: one shared instance, hidden until a textarea is
  // focused. Parented to the top-level `parent`, not `card`, so it docks to
  // the bottom of the whole screen rather than getting laid out inside the
  // card's flex column. FLOATING is required: `parent` is a centered flex
  // column, and without this flag the keyboard becomes a normal flex item —
  // its own built-in bottom-docking (lv_keyboard_create already calls
  // lv_obj_align(BOTTOM_MID) internally) gets silently overridden by the
  // flex layout, which instead centers card+keyboard as one stacked group
  // (confirmed on real hardware: card shoved toward the top, keyboard's
  // bottom rows running off-screen — see wifi_screen.cpp's identical fix).
  lv_obj_t *kb = lv_keyboard_create(parent);
  lv_obj_add_flag(kb, LV_OBJ_FLAG_FLOATING);
  lv_obj_add_flag(kb, LV_OBJ_FLAG_HIDDEN);
  lv_keyboard_set_textarea(kb, server_ta);

  lv_obj_add_event_cb(server_ta, wb_ta_focused_cb, LV_EVENT_FOCUSED, kb);
  lv_obj_add_event_cb(server_ta, wb_ta_defocused_cb, LV_EVENT_DEFOCUSED, kb);
  lv_obj_add_event_cb(code_ta, wb_ta_focused_cb, LV_EVENT_FOCUSED, kb);
  lv_obj_add_event_cb(code_ta, wb_ta_defocused_cb, LV_EVENT_DEFOCUSED, kb);

  // Heap-allocated and intentionally never freed: this context must outlive
  // the button's event callback for the lifetime of the screen, and the
  // screen itself is never torn down (home/settings/onboarding are all
  // created once at boot and just shown/hidden via lv_scr_load).
  WbOnboardingCtx *ctx = new WbOnboardingCtx{server_ta, code_ta, error_lbl, onPaired};
  lv_obj_add_event_cb(pair_btn, wb_pair_clicked_cb, LV_EVENT_CLICKED, ctx);
}
