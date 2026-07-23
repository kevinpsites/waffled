#include "forget_confirm_screen.h"

// Same light palette as settings_screen.cpp/timer_screen.cpp — a normal
// utility screen, not a "wind down" mood. WB_COLOR_DANGER matches
// WaffledBiteDevice.tsx's --danger token (#b3372c) so the destructive
// action reads the same way on both the device and the parent web app.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_DANGER lv_color_hex(0xB3372C)

static void wb_forget_cancel_cb(lv_event_t *e)
{
  lv_obj_t *settings_scr = (lv_obj_t *)lv_event_get_user_data(e);
  // NOT a fade — see settings_screen.cpp's wb_open_detail_cb for why.
  lv_scr_load_anim(settings_scr, LV_SCR_LOAD_ANIM_NONE, 0, 0, false);
}

struct WbForgetConfirmCtx
{
  WbForgetConfirmCallback onConfirm;
};
static void wb_forget_confirm_delete_cb(lv_event_t *e) { delete (WbForgetConfirmCtx *)lv_event_get_user_data(e); }
static void wb_forget_confirm_clicked_cb(lv_event_t *e)
{
  WbForgetConfirmCtx *ctx = (WbForgetConfirmCtx *)lv_event_get_user_data(e);
  if (ctx->onConfirm)
    ctx->onConfirm();
}

static lv_obj_t *make_pill_button(lv_obj_t *parent, const char *text, lv_color_t bg, lv_color_t fg)
{
  lv_obj_t *btn = lv_obj_create(parent);
  lv_obj_remove_style_all(btn);
  lv_obj_set_size(btn, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(btn, bg, 0);
  lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(btn, 22, 0);
  lv_obj_set_style_pad_ver(btn, 12, 0);
  lv_obj_clear_flag(btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *lbl = lv_label_create(btn);
  lv_label_set_text(lbl, text);
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(lbl, fg, 0);
  return btn;
}

void wb_build_forget_confirm_screen(lv_obj_t *parent, lv_obj_t *settings_scr, WbForgetConfirmCallback onConfirm)
{
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(parent, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_row(parent, 18, 0);
  lv_obj_set_style_pad_all(parent, 30, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *title = lv_label_create(parent);
  lv_label_set_text(title, "Forget this device?");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_INK, 0);

  lv_obj_t *sub = lv_label_create(parent);
  lv_label_set_text(sub, "This clears the pairing on THIS device only.\nYou'll need the pairing code again to set it back up.");
  lv_obj_set_style_text_font(sub, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(sub, WB_COLOR_MUTED, 0);
  lv_obj_set_style_text_align(sub, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_width(sub, lv_pct(70));

  lv_obj_t *row = lv_obj_create(parent);
  lv_obj_remove_style_all(row);
  lv_obj_set_size(row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(row, 14, 0);
  lv_obj_set_style_pad_top(row, 10, 0);
  lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *cancel_btn = make_pill_button(row, "Cancel", WB_COLOR_CARD, WB_COLOR_INK);
  lv_obj_add_event_cb(cancel_btn, wb_forget_cancel_cb, LV_EVENT_CLICKED, settings_scr);

  lv_obj_t *confirm_btn = make_pill_button(row, "Forget this device", WB_COLOR_DANGER, lv_color_white());
  WbForgetConfirmCtx *ctx = new WbForgetConfirmCtx{onConfirm};
  lv_obj_add_event_cb(confirm_btn, wb_forget_confirm_clicked_cb, LV_EVENT_CLICKED, ctx);
  lv_obj_add_event_cb(confirm_btn, wb_forget_confirm_delete_cb, LV_EVENT_DELETE, ctx);
}
