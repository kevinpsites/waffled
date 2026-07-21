#include "home_screen.h"
#include <cstdio>

// Palette — warm cream/ink, echoing the web app's theme. No icon/emoji glyphs yet
// (LVGL's default fonts don't include them; baking a custom font with the specific
// glyphs the mockup uses is follow-up work, not attempted here) — text labels
// stand in for now.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_GOLD lv_color_hex(0xC98A1E)
#define WB_COLOR_DONE lv_color_hex(0x2E8B57)
#define WB_COLOR_TRACK lv_color_hex(0xE7DFCE)

static int routine_done_count(const WbRoutine &r)
{
  int n = 0;
  for (int i = 0; i < r.count; i++)
    if (r.tasks[i].done)
      n++;
  return n;
}

static lv_obj_t *make_card(lv_obj_t *parent)
{
  lv_obj_t *card = lv_obj_create(parent);
  lv_obj_set_style_bg_color(card, WB_COLOR_CARD, 0);
  lv_obj_set_style_border_width(card, 0, 0);
  lv_obj_set_style_radius(card, 16, 0);
  lv_obj_set_style_pad_all(card, 14, 0);
  lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);
  return card;
}

// One of the four routine tiles: name, a progress bar, and an X/Y count.
static lv_obj_t *make_routine_tile(lv_obj_t *parent, const char *name, const WbRoutine &r)
{
  lv_obj_t *tile = make_card(parent);
  lv_obj_set_size(tile, lv_pct(48), lv_pct(48));
  lv_obj_set_flex_flow(tile, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(tile, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

  lv_obj_t *title = lv_label_create(tile);
  lv_label_set_text(title, name);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_INK, 0);

  int done = routine_done_count(r);
  bool all_done = r.count > 0 && done == r.count;

  lv_obj_t *bar = lv_bar_create(tile);
  lv_obj_set_size(bar, lv_pct(100), 10);
  lv_bar_set_range(bar, 0, r.count > 0 ? r.count : 1);
  lv_bar_set_value(bar, done, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(bar, WB_COLOR_TRACK, LV_PART_MAIN);
  lv_obj_set_style_bg_color(bar, all_done ? WB_COLOR_DONE : WB_COLOR_GOLD, LV_PART_INDICATOR);
  lv_obj_set_style_radius(bar, 5, LV_PART_MAIN);
  lv_obj_set_style_radius(bar, 5, LV_PART_INDICATOR);

  lv_obj_t *count = lv_label_create(tile);
  char buf[24];
  if (all_done)
  {
    snprintf(buf, sizeof(buf), "Done! %d/%d", done, r.count);
  }
  else
  {
    snprintf(buf, sizeof(buf), "%d of %d", done, r.count);
  }
  lv_label_set_text(count, buf);
  lv_obj_set_style_text_font(count, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(count, all_done ? WB_COLOR_DONE : WB_COLOR_MUTED, 0);

  return tile;
}

static lv_obj_t *make_dock_button(lv_obj_t *parent, const char *label, const char *sub)
{
  lv_obj_t *btn = make_card(parent);
  lv_obj_set_flex_grow(btn, 1);
  lv_obj_set_height(btn, lv_pct(100));
  lv_obj_set_flex_flow(btn, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(btn, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

  lv_obj_t *l = lv_label_create(btn);
  lv_label_set_text(l, label);
  lv_obj_set_style_text_font(l, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(l, WB_COLOR_INK, 0);

  if (sub && sub[0])
  {
    lv_obj_t *s = lv_label_create(btn);
    lv_label_set_text(s, sub);
    lv_obj_set_style_text_font(s, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(s, WB_COLOR_MUTED, 0);
  }
  return btn;
}

void wb_build_home_screen(lv_obj_t *parent, const WbDeviceState &state)
{
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_all(parent, 0, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  // ── top bar ──────────────────────────────────────────────────────────────
  lv_obj_t *top = lv_obj_create(parent);
  lv_obj_remove_style_all(top);
  lv_obj_set_size(top, lv_pct(100), 76);
  lv_obj_set_style_pad_hor(top, 20, 0);
  lv_obj_set_flex_flow(top, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(top, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(top, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *clock_col = lv_obj_create(top);
  lv_obj_remove_style_all(clock_col);
  lv_obj_set_size(clock_col, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(clock_col, LV_FLEX_FLOW_COLUMN);
  lv_obj_clear_flag(clock_col, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *clock_lbl = lv_label_create(clock_col);
  lv_label_set_text(clock_lbl, "4:12 PM"); // placeholder — no RTC/NTP wired up yet
  lv_obj_set_style_text_font(clock_lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(clock_lbl, WB_COLOR_INK, 0);
  lv_obj_t *date_lbl = lv_label_create(clock_col);
  lv_label_set_text(date_lbl, "Wed, Oct 15");
  lv_obj_set_style_text_font(date_lbl, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(date_lbl, WB_COLOR_MUTED, 0);

  lv_obj_t *stars_chip = make_card(top);
  lv_obj_set_size(stars_chip, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(stars_chip, lv_color_hex(0xFBEFD6), 0);
  char stars_buf[24];
  snprintf(stars_buf, sizeof(stars_buf), "%d stars", state.stars);
  lv_obj_t *stars_lbl = lv_label_create(stars_chip);
  lv_label_set_text(stars_lbl, stars_buf);
  lv_obj_set_style_text_font(stars_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(stars_lbl, WB_COLOR_GOLD, 0);

  // ── middle: greeting + the four routine tiles ───────────────────────────
  lv_obj_t *middle = lv_obj_create(parent);
  lv_obj_remove_style_all(middle);
  lv_obj_set_size(middle, lv_pct(100), lv_pct(100));
  lv_obj_set_flex_grow(middle, 1);
  lv_obj_set_style_pad_all(middle, 20, 0);
  lv_obj_set_flex_flow(middle, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(middle, 24, 0);
  lv_obj_clear_flag(middle, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *greet = lv_obj_create(middle);
  lv_obj_remove_style_all(greet);
  lv_obj_set_size(greet, 260, lv_pct(100));
  lv_obj_set_flex_flow(greet, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(greet, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(greet, LV_OBJ_FLAG_SCROLLABLE);

  char hi_buf[40];
  snprintf(hi_buf, sizeof(hi_buf), "Hi, %s!", state.personName);
  lv_obj_t *hi_lbl = lv_label_create(greet);
  lv_label_set_text(hi_lbl, hi_buf);
  lv_obj_set_style_text_font(hi_lbl, &lv_font_montserrat_32, 0);
  lv_obj_set_style_text_color(hi_lbl, WB_COLOR_INK, 0);

  lv_obj_t *sub_lbl = lv_label_create(greet);
  lv_label_set_text(sub_lbl, "Let's have a great day");
  lv_obj_set_style_text_font(sub_lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(sub_lbl, WB_COLOR_MUTED, 0);
  lv_obj_set_style_pad_bottom(sub_lbl, 10, 0);

  lv_obj_t *stars_big = lv_label_create(greet);
  lv_label_set_text(stars_big, stars_buf);
  lv_obj_set_style_text_font(stars_big, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(stars_big, WB_COLOR_GOLD, 0);

  lv_obj_t *tiles = lv_obj_create(middle);
  lv_obj_remove_style_all(tiles);
  lv_obj_set_flex_grow(tiles, 1);
  lv_obj_set_size(tiles, lv_pct(100), lv_pct(100));
  lv_obj_set_flex_flow(tiles, LV_FLEX_FLOW_ROW_WRAP);
  lv_obj_set_style_pad_column(tiles, 12, 0);
  lv_obj_set_style_pad_row(tiles, 12, 0);
  lv_obj_clear_flag(tiles, LV_OBJ_FLAG_SCROLLABLE);

  make_routine_tile(tiles, "Morning", state.morning);
  make_routine_tile(tiles, "Afternoon", state.afternoon);
  make_routine_tile(tiles, "Evening", state.evening);
  make_routine_tile(tiles, "Chores", state.chores);

  // ── bottom dock ──────────────────────────────────────────────────────────
  lv_obj_t *dock = lv_obj_create(parent);
  lv_obj_remove_style_all(dock);
  lv_obj_set_size(dock, lv_pct(100), 84);
  lv_obj_set_style_pad_all(dock, 12, 0);
  lv_obj_set_style_pad_column(dock, 10, 0);
  lv_obj_set_flex_flow(dock, LV_FLEX_FLOW_ROW);
  lv_obj_clear_flag(dock, LV_OBJ_FLAG_SCROLLABLE);

  // Sub-screens for these don't exist yet — dock is display-only for now, not
  // wired to navigation (that's the same "next" as networking: nothing to show
  // without live state to control).
  make_dock_button(dock, "Sounds", state.quiet.active ? "Playing" : "Off");
  make_dock_button(dock, "Nightlight", "Off");
  make_dock_button(dock, "Timer", "");
  make_dock_button(dock, "Bedtime", "");
}
