#include "offline_screen.h"
#include "../icons/wb_icons.h"

// Same light palette as settings_screen.cpp/timer_screen.cpp/
// forget_confirm_screen.cpp — a normal utility screen, not a "wind down"
// mood; duplicated rather than shared, same per-file convention as those.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_GOLD lv_color_hex(0xC98A1E)

static void wb_offline_goto_settings_cb(lv_event_t *e)
{
  lv_obj_t *settings_scr = (lv_obj_t *)lv_event_get_user_data(e);
  // NOT a fade — see settings_screen.cpp's wb_open_detail_cb for why.
  lv_scr_load_anim(settings_scr, LV_SCR_LOAD_ANIM_NONE, 0, 0, false);
}

struct WbOfflineActionCtx
{
  WbOfflineActionCallback cb;
};
static void wb_offline_action_delete_cb(lv_event_t *e) { delete (WbOfflineActionCtx *)lv_event_get_user_data(e); }
static void wb_offline_action_clicked_cb(lv_event_t *e)
{
  WbOfflineActionCtx *ctx = (WbOfflineActionCtx *)lv_event_get_user_data(e);
  if (ctx->cb)
    ctx->cb();
}

static lv_obj_t *make_pill_button(lv_obj_t *parent, const char *text, lv_color_t bg, lv_color_t fg)
{
  lv_obj_t *btn = lv_obj_create(parent);
  lv_obj_remove_style_all(btn);
  lv_obj_set_size(btn, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(btn, bg, 0);
  lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(btn, 32, 0);
  lv_obj_set_style_pad_ver(btn, 20, 0);
  lv_obj_clear_flag(btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *lbl = lv_label_create(btn);
  lv_label_set_text(lbl, text);
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(lbl, fg, 0);
  return btn;
}

static lv_obj_t *make_action_btn(lv_obj_t *row, const char *text, lv_color_t bg, lv_color_t fg, WbOfflineActionCallback cb)
{
  lv_obj_t *btn = make_pill_button(row, text, bg, fg);
  WbOfflineActionCtx *ctx = new WbOfflineActionCtx{cb};
  lv_obj_add_event_cb(btn, wb_offline_action_clicked_cb, LV_EVENT_CLICKED, ctx);
  lv_obj_add_event_cb(btn, wb_offline_action_delete_cb, LV_EVENT_DELETE, ctx);
  return btn;
}

void wb_build_offline_screen(lv_obj_t *parent, lv_obj_t *settings_scr, WbOfflineActionCallback onRetry,
                              WbOfflineActionCallback onChangeWifi, WbOfflineActionCallback onChangeServer)
{
  // Split layout — sad unplugged-waffle-iron mascot on the left, message +
  // action buttons on the right — direct request, mirroring the split-row
  // shape quiet_screen.cpp/timer_screen.cpp already use elsewhere in this app.
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(parent, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_hor(parent, 50, 0);
  lv_obj_set_style_pad_ver(parent, 30, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *mascot = lv_image_create(parent);
  lv_image_set_src(mascot, &wb_offline_mascot_320);

  // Fixed width (not LV_SIZE_CONTENT) so the button row below can wrap
  // reliably against a real pixel value — matches wifi_screen.cpp/
  // onboarding_screen.cpp's own "card gets an explicit size, content fills
  // it" reasoning.
  lv_obj_t *right_col = lv_obj_create(parent);
  lv_obj_remove_style_all(right_col);
  lv_obj_set_size(right_col, 560, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(right_col, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(right_col, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
  lv_obj_set_style_pad_row(right_col, 20, 0);
  lv_obj_clear_flag(right_col, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *title = lv_label_create(right_col);
  lv_label_set_text(title, "Can't reach the server");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_32, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_INK, 0);

  lv_obj_t *sub = lv_label_create(right_col);
  lv_label_set_text(sub, "This device can't check in right now, so things like\nstarting a timer or checking off a chore won't work yet.");
  lv_obj_set_style_text_font(sub, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(sub, WB_COLOR_MUTED, 0);

  lv_obj_t *row = lv_obj_create(right_col);
  lv_obj_remove_style_all(row);
  lv_obj_set_size(row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW_WRAP);
  lv_obj_set_style_pad_column(row, 16, 0);
  lv_obj_set_style_pad_row(row, 16, 0);
  lv_obj_set_style_pad_top(row, 10, 0);
  lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

  make_action_btn(row, LV_SYMBOL_REFRESH " Try again", WB_COLOR_GOLD, lv_color_white(), onRetry);
  make_action_btn(row, "Change Wi-Fi network", WB_COLOR_CARD, WB_COLOR_INK, onChangeWifi);
  make_action_btn(row, "Change server address", WB_COLOR_CARD, WB_COLOR_INK, onChangeServer);

  lv_obj_t *settings_btn = make_pill_button(row, "Go to Settings", WB_COLOR_CARD, WB_COLOR_INK);
  lv_obj_add_event_cb(settings_btn, wb_offline_goto_settings_cb, LV_EVENT_CLICKED, settings_scr);
}
