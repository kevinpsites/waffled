#include "home_screen.h"
#include <cstdio>

// Palette — warm cream/ink, echoing the web app's theme, plus one tint per
// routine tile matching the latest mocks. No custom icon font yet (see the
// firmware README's icons note) — LV_SYMBOL_* built-ins stand in wherever
// they actually match (checkmark, gear); everything else (sun/moon/lightning)
// is text-only for now rather than a fabricated mismatched icon.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_GREET_CARD lv_color_hex(0xE7E1D6)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_GOLD lv_color_hex(0xC98A1E)
#define WB_COLOR_STARS_BG lv_color_hex(0xFBEFD6)

#define WB_COLOR_MORNING lv_color_hex(0xDCC981)
#define WB_COLOR_MORNING_TEXT lv_color_hex(0x6B551C)
#define WB_COLOR_AFTERNOON lv_color_hex(0xCC9E70)
#define WB_COLOR_AFTERNOON_TEXT lv_color_hex(0x6B3F1B)
#define WB_COLOR_EVENING lv_color_hex(0xACA8DC)
#define WB_COLOR_EVENING_TEXT lv_color_hex(0x362F73)
#define WB_COLOR_CHORES lv_color_hex(0xA7C9AC)
#define WB_COLOR_CHORES_TEXT lv_color_hex(0x2C5A34)

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

// A small rounded pill for counts/status ("1 / 3", "24 stars"). Sized to hug
// its label — every caller must NOT also set an explicit size, or it falls
// back to LVGL's 100x100 default object size (bit us once already).
// `out_lbl` optionally hands back the inner label so a caller can update its
// text later without a rebuild (see wb_sync_home_screen).
static lv_obj_t *make_badge(lv_obj_t *parent, const char *text, lv_color_t bg, lv_color_t fg, lv_obj_t **out_lbl = nullptr)
{
  lv_obj_t *pill = lv_obj_create(parent);
  lv_obj_remove_style_all(pill);
  lv_obj_set_size(pill, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(pill, bg, 0);
  lv_obj_set_style_bg_opa(pill, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(pill, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(pill, 10, 0);
  lv_obj_set_style_pad_ver(pill, 4, 0);
  lv_obj_clear_flag(pill, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *lbl = lv_label_create(pill);
  lv_label_set_text(lbl, text);
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(lbl, fg, 0);
  if (out_lbl)
    *out_lbl = lbl;
  return pill;
}

// A colored circle standing in for a real avatar image until per-person
// avatar art is baked in (bitmap assets, not a font glyph — see the icons
// discussion in the PR). Just the child's initial, centered.
static lv_obj_t *make_avatar_circle(lv_obj_t *parent, char initial, lv_coord_t diameter)
{
  lv_obj_t *circle = lv_obj_create(parent);
  lv_obj_remove_style_all(circle);
  lv_obj_set_size(circle, diameter, diameter);
  lv_obj_set_style_radius(circle, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(circle, WB_COLOR_GOLD, 0);
  lv_obj_set_style_bg_opa(circle, LV_OPA_COVER, 0);
  lv_obj_set_flex_flow(circle, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(circle, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(circle, LV_OBJ_FLAG_SCROLLABLE);

  char buf[2] = {initial, '\0'};
  lv_obj_t *lbl = lv_label_create(circle);
  lv_label_set_text(lbl, buf);
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(lbl, lv_color_white(), 0);
  return circle;
}

// One of the three scheduled routine tiles: a colored card with a status
// badge pinned top-right and the name + progress bar pinned to the bottom.
// `out_badge_lbl`/`out_bar` optionally hand back the two pieces that change
// between polls (done count, progress) so wb_sync_home_screen can update
// them in place without tearing this tile down.
static lv_obj_t *make_routine_tile(lv_obj_t *parent, const char *name, const WbRoutine &r, lv_color_t bg, lv_color_t fg,
                                    lv_obj_t **out_badge_lbl = nullptr, lv_obj_t **out_bar = nullptr)
{
  lv_obj_t *tile = lv_obj_create(parent);
  lv_obj_remove_style_all(tile);
  lv_obj_set_style_bg_color(tile, bg, 0);
  lv_obj_set_style_bg_opa(tile, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(tile, 20, 0);
  lv_obj_set_style_pad_all(tile, 16, 0);
  lv_obj_set_flex_grow(tile, 1);
  lv_obj_set_size(tile, LV_SIZE_CONTENT, lv_pct(100));
  lv_obj_set_flex_flow(tile, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(tile, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
  lv_obj_clear_flag(tile, LV_OBJ_FLAG_SCROLLABLE);

  int done = routine_done_count(r);
  bool all_done = r.count > 0 && done == r.count;

  lv_obj_t *top_row = lv_obj_create(tile);
  lv_obj_remove_style_all(top_row);
  lv_obj_set_size(top_row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(top_row, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(top_row, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(top_row, LV_OBJ_FLAG_SCROLLABLE);

  char badge_buf[24];
  if (all_done)
    snprintf(badge_buf, sizeof(badge_buf), "%d %s", done, LV_SYMBOL_OK);
  else
    snprintf(badge_buf, sizeof(badge_buf), "%d / %d", done, r.count);
  lv_obj_t *badge_lbl = nullptr;
  make_badge(top_row, badge_buf, lv_color_white(), fg, &badge_lbl);
  if (out_badge_lbl)
    *out_badge_lbl = badge_lbl;

  lv_obj_t *bottom = lv_obj_create(tile);
  lv_obj_remove_style_all(bottom);
  lv_obj_set_size(bottom, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(bottom, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(bottom, 8, 0);
  lv_obj_clear_flag(bottom, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *title = lv_label_create(bottom);
  lv_label_set_text(title, name);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(title, fg, 0);

  lv_obj_t *bar = lv_bar_create(bottom);
  lv_obj_set_size(bar, lv_pct(100), 8);
  lv_bar_set_range(bar, 0, r.count > 0 ? r.count : 1);
  lv_bar_set_value(bar, done, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(bar, lv_color_white(), LV_PART_MAIN);
  lv_obj_set_style_bg_opa(bar, LV_OPA_40, LV_PART_MAIN);
  lv_obj_set_style_bg_color(bar, fg, LV_PART_INDICATOR);
  lv_obj_set_style_radius(bar, 4, LV_PART_MAIN);
  lv_obj_set_style_radius(bar, 4, LV_PART_INDICATOR);
  if (out_bar)
    *out_bar = bar;

  return tile;
}

// The unscheduled "Chores" bucket — a full-width bar below the three tiles.
// `out_badge_lbl`/`out_bar` — see make_routine_tile's comment, same idea.
static lv_obj_t *make_chores_bar(lv_obj_t *parent, const WbRoutine &r, lv_obj_t **out_badge_lbl = nullptr, lv_obj_t **out_bar = nullptr)
{
  lv_obj_t *bar_card = lv_obj_create(parent);
  lv_obj_remove_style_all(bar_card);
  lv_obj_set_style_bg_color(bar_card, WB_COLOR_CHORES, 0);
  lv_obj_set_style_bg_opa(bar_card, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(bar_card, 20, 0);
  lv_obj_set_style_pad_hor(bar_card, 20, 0);
  lv_obj_set_style_pad_column(bar_card, 16, 0);
  lv_obj_set_size(bar_card, lv_pct(100), 96);
  lv_obj_set_flex_flow(bar_card, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(bar_card, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(bar_card, LV_OBJ_FLAG_SCROLLABLE);

  int done = routine_done_count(r);
  bool all_done = r.count > 0 && done == r.count;

  lv_obj_t *title = lv_label_create(bar_card);
  lv_label_set_text(title, "Chores");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_CHORES_TEXT, 0);

  lv_obj_t *bar = lv_bar_create(bar_card);
  lv_obj_set_flex_grow(bar, 1);
  lv_obj_set_height(bar, 8);
  lv_bar_set_range(bar, 0, r.count > 0 ? r.count : 1);
  lv_bar_set_value(bar, done, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(bar, lv_color_white(), LV_PART_MAIN);
  lv_obj_set_style_bg_opa(bar, LV_OPA_40, LV_PART_MAIN);
  lv_obj_set_style_bg_color(bar, WB_COLOR_CHORES_TEXT, LV_PART_INDICATOR);
  lv_obj_set_style_radius(bar, 4, LV_PART_MAIN);
  lv_obj_set_style_radius(bar, 4, LV_PART_INDICATOR);
  if (out_bar)
    *out_bar = bar;

  char badge_buf[24];
  if (all_done)
    snprintf(badge_buf, sizeof(badge_buf), "%d %s", done, LV_SYMBOL_OK);
  else
    snprintf(badge_buf, sizeof(badge_buf), "%d / %d", done, r.count);
  lv_obj_t *badge_lbl = nullptr;
  make_badge(bar_card, badge_buf, lv_color_white(), WB_COLOR_CHORES_TEXT, &badge_lbl);
  if (out_badge_lbl)
    *out_badge_lbl = badge_lbl;

  return bar_card;
}

static void wb_open_settings_cb(lv_event_t *e)
{
  lv_obj_t *settings_scr = (lv_obj_t *)lv_event_get_user_data(e);
  lv_scr_load_anim(settings_scr, LV_SCR_LOAD_ANIM_MOVE_LEFT, 200, 0, false);
}

// Bundles what a tapped routine tile/chores bar needs to open the tasks
// screen: which routine to show, and the screens/callback to hand
// wb_build_tasks_screen. `routine` points into the WbDeviceState this
// wb_build_home_screen call was given — always static storage in practice
// (wb_mock_state()'s function-static, or main.cpp's `static WbDeviceState
// liveState`), so it safely outlives this context. Heap-allocated per tile
// per rebuild and freed on LV_EVENT_DELETE — see tasks_screen.cpp's
// WbTaskRowCtx comment for why (this screen gets rebuilt on every poll, so
// "never freed" like onboarding's context would leak).
struct WbOpenTasksCtx
{
  const char *title;
  const WbRoutine *routine;
  lv_obj_t *tasks_scr;
  lv_obj_t *home_scr;
  WbTaskCompleteCallback onComplete;
};

static void wb_open_tasks_ctx_delete_cb(lv_event_t *e)
{
  WbOpenTasksCtx *ctx = (WbOpenTasksCtx *)lv_event_get_user_data(e);
  delete ctx;
}

static void wb_open_tasks_cb(lv_event_t *e)
{
  WbOpenTasksCtx *ctx = (WbOpenTasksCtx *)lv_event_get_user_data(e);
  lv_obj_clean(ctx->tasks_scr);
  wb_build_tasks_screen(ctx->tasks_scr, ctx->title, *ctx->routine, ctx->home_scr, ctx->onComplete);
  lv_scr_load_anim(ctx->tasks_scr, LV_SCR_LOAD_ANIM_MOVE_LEFT, 200, 0, false);
}

// Attaches the open-tasks-screen tap handler to a tile/bar that's already
// clickable (lv_obj_create's default flags include CLICKABLE).
static void wb_wire_open_tasks(lv_obj_t *tile, const char *title, const WbRoutine &routine, lv_obj_t *tasks_scr, lv_obj_t *home_scr, WbTaskCompleteCallback onComplete)
{
  WbOpenTasksCtx *ctx = new WbOpenTasksCtx{title, &routine, tasks_scr, home_scr, onComplete};
  lv_obj_add_event_cb(tile, wb_open_tasks_cb, LV_EVENT_CLICKED, ctx);
  lv_obj_add_event_cb(tile, wb_open_tasks_ctx_delete_cb, LV_EVENT_DELETE, ctx);
}

static lv_obj_t *make_gear_button(lv_obj_t *parent, lv_obj_t *settings_scr)
{
  lv_obj_t *btn = lv_obj_create(parent);
  lv_obj_remove_style_all(btn);
  lv_obj_set_size(btn, 48, 48);
  lv_obj_set_style_radius(btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(btn, WB_COLOR_CARD, 0);
  lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
  lv_obj_set_flex_flow(btn, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(btn, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(btn, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *icon = lv_label_create(btn);
  lv_label_set_text(icon, LV_SYMBOL_SETTINGS);
  lv_obj_set_style_text_font(icon, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(icon, WB_COLOR_INK, 0);

  // lv_obj_create's default flags already include CLICKABLE.
  lv_obj_add_event_cb(btn, wb_open_settings_cb, LV_EVENT_CLICKED, settings_scr);
  return btn;
}

// Widgets wb_sync_home_screen updates in place on every poll after the
// first, without a rebuild. Stashed on `parent` via lv_obj_set_user_data;
// the delete callback is attached to `top` (a genuine child destroyed by
// lv_obj_clean(parent), e.g. on re-pairing), not to `parent` itself, which
// is a persistent singleton that's never lv_obj_delete()'d — same leak-
// avoidance rule established for quiet_screen.cpp's WbQuietCtx.
struct WbHomeSyncCtx
{
  lv_obj_t *stars_top_lbl;
  lv_obj_t *stars_greet_lbl;
  lv_obj_t *morning_badge_lbl;
  lv_obj_t *morning_bar;
  lv_obj_t *afternoon_badge_lbl;
  lv_obj_t *afternoon_bar;
  lv_obj_t *evening_badge_lbl;
  lv_obj_t *evening_bar;
  lv_obj_t *chores_badge_lbl;
  lv_obj_t *chores_bar_obj;
};

static void wb_home_sync_ctx_delete_cb(lv_event_t *e)
{
  delete (WbHomeSyncCtx *)lv_event_get_user_data(e);
}

// Shared by wb_build_home_screen (initial values) and wb_sync_home_screen
// (later polls) so a routine tile's badge+bar are computed identically both
// places.
static void sync_routine_widgets(lv_obj_t *badge_lbl, lv_obj_t *bar, const WbRoutine &r)
{
  int done = routine_done_count(r);
  bool all_done = r.count > 0 && done == r.count;
  char badge_buf[24];
  if (all_done)
    snprintf(badge_buf, sizeof(badge_buf), "%d %s", done, LV_SYMBOL_OK);
  else
    snprintf(badge_buf, sizeof(badge_buf), "%d / %d", done, r.count);
  lv_label_set_text(badge_lbl, badge_buf);
  lv_bar_set_range(bar, 0, r.count > 0 ? r.count : 1);
  lv_bar_set_value(bar, done, LV_ANIM_OFF);
}

void wb_sync_home_screen(lv_obj_t *parent, const WbDeviceState &state)
{
  WbHomeSyncCtx *ctx = (WbHomeSyncCtx *)lv_obj_get_user_data(parent);
  if (!ctx)
    return; // not built yet

  char stars_buf[24];
  snprintf(stars_buf, sizeof(stars_buf), "%d stars", state.stars);
  lv_label_set_text(ctx->stars_top_lbl, stars_buf);
  lv_label_set_text(ctx->stars_greet_lbl, stars_buf);

  sync_routine_widgets(ctx->morning_badge_lbl, ctx->morning_bar, state.morning);
  sync_routine_widgets(ctx->afternoon_badge_lbl, ctx->afternoon_bar, state.afternoon);
  sync_routine_widgets(ctx->evening_badge_lbl, ctx->evening_bar, state.evening);
  sync_routine_widgets(ctx->chores_badge_lbl, ctx->chores_bar_obj, state.chores);
}

void wb_build_home_screen(lv_obj_t *parent, const WbDeviceState &state, lv_obj_t *settings_scr, lv_obj_t *tasks_scr, WbTaskCompleteCallback onComplete)
{
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_all(parent, 20, 0);
  lv_obj_set_style_pad_row(parent, 16, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  char stars_buf[24];
  snprintf(stars_buf, sizeof(stars_buf), "%d stars", state.stars);

  // ── top bar: clock/date, stars, settings gear ───────────────────────────
  lv_obj_t *top = lv_obj_create(parent);
  lv_obj_remove_style_all(top);
  lv_obj_set_size(top, lv_pct(100), 56);
  lv_obj_set_flex_flow(top, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(top, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(top, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *clock_col = lv_obj_create(top);
  lv_obj_remove_style_all(clock_col);
  lv_obj_set_size(clock_col, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(clock_col, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(clock_col, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_END);
  lv_obj_set_style_pad_column(clock_col, 8, 0);
  lv_obj_clear_flag(clock_col, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *clock_lbl = lv_label_create(clock_col);
  lv_label_set_text(clock_lbl, "4:13"); // placeholder — no RTC/NTP wired up yet
  lv_obj_set_style_text_font(clock_lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(clock_lbl, WB_COLOR_INK, 0);
  lv_obj_t *date_lbl = lv_label_create(clock_col);
  lv_label_set_text(date_lbl, "Wed, Oct 15");
  lv_obj_set_style_text_font(date_lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(date_lbl, WB_COLOR_MUTED, 0);

  lv_obj_t *top_right = lv_obj_create(top);
  lv_obj_remove_style_all(top_right);
  lv_obj_set_size(top_right, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(top_right, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(top_right, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_column(top_right, 10, 0);
  lv_obj_clear_flag(top_right, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *stars_top_lbl = nullptr;
  make_badge(top_right, stars_buf, WB_COLOR_STARS_BG, WB_COLOR_GOLD, &stars_top_lbl);
  make_gear_button(top_right, settings_scr);

  // ── middle: greeting card + the three routine tiles + chores bar ────────
  lv_obj_t *middle = lv_obj_create(parent);
  lv_obj_remove_style_all(middle);
  lv_obj_set_size(middle, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_grow(middle, 1);
  lv_obj_set_flex_flow(middle, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(middle, 20, 0);
  lv_obj_clear_flag(middle, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *greet = make_card(middle);
  lv_obj_set_style_bg_color(greet, WB_COLOR_GREET_CARD, 0);
  lv_obj_set_size(greet, 280, lv_pct(100));
  lv_obj_set_flex_flow(greet, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(greet, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_row(greet, 6, 0);

  make_avatar_circle(greet, state.personName[0], 72);

  char hi_buf[40];
  snprintf(hi_buf, sizeof(hi_buf), "Hi, %s!", state.personName);
  lv_obj_t *hi_lbl = lv_label_create(greet);
  lv_label_set_text(hi_lbl, hi_buf);
  lv_obj_set_style_text_font(hi_lbl, &lv_font_montserrat_32, 0);
  lv_obj_set_style_text_color(hi_lbl, WB_COLOR_INK, 0);
  lv_obj_set_style_pad_top(hi_lbl, 8, 0);

  lv_obj_t *sub_lbl = lv_label_create(greet);
  lv_label_set_text(sub_lbl, "Let's have a great day");
  lv_obj_set_style_text_font(sub_lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(sub_lbl, WB_COLOR_MUTED, 0);
  lv_obj_set_style_pad_bottom(sub_lbl, 4, 0);

  lv_obj_t *stars_greet_lbl = nullptr;
  make_badge(greet, stars_buf, WB_COLOR_STARS_BG, WB_COLOR_GOLD, &stars_greet_lbl);

  lv_obj_t *right_col = lv_obj_create(middle);
  lv_obj_remove_style_all(right_col);
  lv_obj_set_flex_grow(right_col, 1);
  lv_obj_set_size(right_col, LV_SIZE_CONTENT, lv_pct(100));
  lv_obj_set_flex_flow(right_col, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(right_col, 16, 0);
  lv_obj_clear_flag(right_col, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *tiles_row = lv_obj_create(right_col);
  lv_obj_remove_style_all(tiles_row);
  lv_obj_set_size(tiles_row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_grow(tiles_row, 1);
  lv_obj_set_flex_flow(tiles_row, LV_FLEX_FLOW_ROW);
  lv_obj_set_style_pad_column(tiles_row, 14, 0);
  lv_obj_clear_flag(tiles_row, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *morning_badge_lbl = nullptr, *morning_bar = nullptr;
  lv_obj_t *afternoon_badge_lbl = nullptr, *afternoon_bar = nullptr;
  lv_obj_t *evening_badge_lbl = nullptr, *evening_bar = nullptr;
  lv_obj_t *morning_tile = make_routine_tile(tiles_row, "Morning", state.morning, WB_COLOR_MORNING, WB_COLOR_MORNING_TEXT, &morning_badge_lbl, &morning_bar);
  lv_obj_t *afternoon_tile = make_routine_tile(tiles_row, "Afternoon", state.afternoon, WB_COLOR_AFTERNOON, WB_COLOR_AFTERNOON_TEXT, &afternoon_badge_lbl, &afternoon_bar);
  lv_obj_t *evening_tile = make_routine_tile(tiles_row, "Evening", state.evening, WB_COLOR_EVENING, WB_COLOR_EVENING_TEXT, &evening_badge_lbl, &evening_bar);
  wb_wire_open_tasks(morning_tile, "Morning", state.morning, tasks_scr, parent, onComplete);
  wb_wire_open_tasks(afternoon_tile, "Afternoon", state.afternoon, tasks_scr, parent, onComplete);
  wb_wire_open_tasks(evening_tile, "Evening", state.evening, tasks_scr, parent, onComplete);

  lv_obj_t *chores_badge_lbl = nullptr, *chores_bar_obj = nullptr;
  lv_obj_t *chores_bar = make_chores_bar(right_col, state.chores, &chores_badge_lbl, &chores_bar_obj);
  wb_wire_open_tasks(chores_bar, "Chores", state.chores, tasks_scr, parent, onComplete);

  // Stash the pieces wb_sync_home_screen updates in place on later polls —
  // see WbHomeSyncCtx's comment for the leak-avoidance rule (delete cb on
  // `top`, a real child, not on `parent` itself).
  WbHomeSyncCtx *sync_ctx = new WbHomeSyncCtx{
      stars_top_lbl, stars_greet_lbl,
      morning_badge_lbl, morning_bar,
      afternoon_badge_lbl, afternoon_bar,
      evening_badge_lbl, evening_bar,
      chores_badge_lbl, chores_bar_obj,
  };
  lv_obj_add_event_cb(top, wb_home_sync_ctx_delete_cb, LV_EVENT_DELETE, sync_ctx);
  lv_obj_set_user_data(parent, sync_ctx);
}
