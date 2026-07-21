#include "settings_screen.h"
#include <cstdio>

// Palette — kept in sync with home_screen.cpp's by eye; duplicated rather
// than shared since each screen file owns its own small set of local
// helpers and this is a handful of #defines, not real logic.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_TILE lv_color_hex(0xFFFDF8)
#define WB_COLOR_TILE_ACTIVE lv_color_hex(0x1C1A18)
#define WB_COLOR_CHIP lv_color_hex(0xE7E1D6)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)

static void wb_go_home_cb(lv_event_t *e)
{
  lv_obj_t *home_scr = (lv_obj_t *)lv_event_get_user_data(e);
  lv_scr_load_anim(home_scr, LV_SCR_LOAD_ANIM_MOVE_RIGHT, 200, 0, false);
}

// One control tile (Sounds/Nightlight/Set a timer/Bedtime). `icon` may be
// NULL — moon, stopwatch, and bed have no built-in LV_SYMBOL_* match yet;
// a custom icon font is deferred (see the firmware README), so those render
// label-only rather than with a mismatched icon standing in.
static lv_obj_t *make_control_tile(lv_obj_t *parent, const char *icon, const char *label, const char *sub, bool active)
{
  lv_obj_t *tile = lv_obj_create(parent);
  lv_obj_remove_style_all(tile);
  lv_obj_set_flex_grow(tile, 1);
  lv_obj_set_size(tile, LV_SIZE_CONTENT, lv_pct(100));
  lv_obj_set_style_bg_color(tile, active ? WB_COLOR_TILE_ACTIVE : WB_COLOR_TILE, 0);
  lv_obj_set_style_bg_opa(tile, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(tile, 20, 0);
  lv_obj_set_flex_flow(tile, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(tile, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_row(tile, 10, 0);
  lv_obj_clear_flag(tile, LV_OBJ_FLAG_SCROLLABLE);

  lv_color_t fg = active ? lv_color_white() : WB_COLOR_INK;
  lv_color_t sub_fg = active ? lv_color_hex(0xC9C4BC) : WB_COLOR_MUTED;

  if (icon)
  {
    lv_obj_t *icon_lbl = lv_label_create(tile);
    lv_label_set_text(icon_lbl, icon);
    lv_obj_set_style_text_font(icon_lbl, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(icon_lbl, fg, 0);
  }

  lv_obj_t *lbl = lv_label_create(tile);
  lv_label_set_text(lbl, label);
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(lbl, fg, 0);

  if (sub && sub[0])
  {
    lv_obj_t *sub_lbl = lv_label_create(tile);
    lv_label_set_text(sub_lbl, sub);
    lv_obj_set_style_text_font(sub_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(sub_lbl, sub_fg, 0);
  }

  return tile;
}

void wb_build_settings_screen(lv_obj_t *parent, const WbDeviceState &state, lv_obj_t *home_scr)
{
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_all(parent, 20, 0);
  lv_obj_set_style_pad_row(parent, 28, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  // ── top bar: back button + title on the left, locked chip on the right ──
  lv_obj_t *top = lv_obj_create(parent);
  lv_obj_remove_style_all(top);
  lv_obj_set_size(top, lv_pct(100), 56);
  lv_obj_set_flex_flow(top, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(top, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(top, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *left = lv_obj_create(top);
  lv_obj_remove_style_all(left);
  lv_obj_set_size(left, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(left, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(left, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_column(left, 16, 0);
  lv_obj_clear_flag(left, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *back_btn = lv_obj_create(left);
  lv_obj_remove_style_all(back_btn);
  lv_obj_set_size(back_btn, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(back_btn, WB_COLOR_TILE, 0);
  lv_obj_set_style_bg_opa(back_btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(back_btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(back_btn, 16, 0);
  lv_obj_set_style_pad_ver(back_btn, 10, 0);
  lv_obj_clear_flag(back_btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *back_lbl = lv_label_create(back_btn);
  lv_label_set_text(back_lbl, LV_SYMBOL_LEFT " Home");
  lv_obj_set_style_text_font(back_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(back_lbl, WB_COLOR_INK, 0);
  lv_obj_add_event_cb(back_btn, wb_go_home_cb, LV_EVENT_CLICKED, home_scr);

  lv_obj_t *title = lv_label_create(left);
  lv_label_set_text(title, "Grown-up controls");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_INK, 0);

  lv_obj_t *locked = lv_obj_create(top);
  lv_obj_remove_style_all(locked);
  lv_obj_set_size(locked, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(locked, WB_COLOR_CHIP, 0);
  lv_obj_set_style_bg_opa(locked, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(locked, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(locked, 14, 0);
  lv_obj_set_style_pad_ver(locked, 8, 0);
  lv_obj_clear_flag(locked, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *locked_lbl = lv_label_create(locked);
  lv_label_set_text(locked_lbl, "For a grown-up"); // no built-in lock glyph — plain text for now
  lv_obj_set_style_text_font(locked_lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(locked_lbl, WB_COLOR_MUTED, 0);

  // ── control tiles ────────────────────────────────────────────────────────
  lv_obj_t *row = lv_obj_create(parent);
  lv_obj_remove_style_all(row);
  lv_obj_set_size(row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_grow(row, 1);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(row, 16, 0);
  lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

  make_control_tile(row, LV_SYMBOL_VOLUME_MAX, "Sounds", state.soundsOn ? "On" : "Off", false);
  make_control_tile(row, NULL, "Nightlight", state.nightlightOn ? "On" : "Off", state.nightlightOn);
  make_control_tile(row, NULL, "Set a timer", "", false);
  make_control_tile(row, NULL, "Bedtime", "", false);
}
