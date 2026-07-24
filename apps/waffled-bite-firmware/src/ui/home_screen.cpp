#include "home_screen.h"
#include "../icons/wb_icons.h"
#include <cstdio>

// Palette — warm cream/ink, echoing the web app's theme, plus one tint per
// routine tile matching the "Waffled Buddy" mock. Routine/gear/star icons are
// baked A8 images (see icons/wb_icons.h) tinted per-tile via
// style_image_recolor — see make_icon()'s comment.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_GREET_CARD lv_color_hex(0xE7E1D6)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_GOLD lv_color_hex(0xC98A1E)
#define WB_COLOR_STARS_BG lv_color_hex(0xFBEFD6)

// Exact tokens from the "Waffled Buddy" mock's buddy-400.css (--morning/-i etc.),
// not eyeballed — see tools/icons/README.md for where this mock came from.
#define WB_COLOR_MORNING lv_color_hex(0xF6E2A0)
#define WB_COLOR_MORNING_TEXT lv_color_hex(0x8A6A1E)
#define WB_COLOR_AFTERNOON lv_color_hex(0xF4C9A0)
#define WB_COLOR_AFTERNOON_TEXT lv_color_hex(0x9C5A2A)
#define WB_COLOR_EVENING lv_color_hex(0xC6C9F2)
#define WB_COLOR_EVENING_TEXT lv_color_hex(0x4B4EA8)
#define WB_COLOR_CHORES lv_color_hex(0xBEE6D6)
#define WB_COLOR_CHORES_TEXT lv_color_hex(0x1C7A56)
#define WB_COLOR_DONE_GREEN lv_color_hex(0x4CAF6D)

// Short weekday/month names for the clock's date line — index matches
// waffledBites.ts's nowLocalView (weekday 0=Sun, month 1-12).
static const char *WB_WEEKDAY_NAMES[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char *WB_MONTH_NAMES[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

// Renders "H:MM" (12-hour, no AM/PM — matches this screen's original mockup)
// and "Wed, Oct 15" from the poll's already-localized now* fields (see
// wb_state.h's header comment — the device does no timezone math of its
// own). Falls back to placeholder dashes when unavailable (nowHour < 0:
// mock/pre-first-poll state).
static void format_clock_date(char *clockBuf, size_t clockLen, char *dateBuf, size_t dateLen, const WbDeviceState &state)
{
  if (state.nowHour < 0)
  {
    snprintf(clockBuf, clockLen, "--:--");
    dateBuf[0] = '\0';
    return;
  }
  int h12 = state.nowHour % 12;
  if (h12 == 0)
    h12 = 12;
  snprintf(clockBuf, clockLen, "%d:%02d", h12, state.nowMin);

  const char *weekday = (state.nowWeekday >= 0 && state.nowWeekday <= 6) ? WB_WEEKDAY_NAMES[state.nowWeekday] : "";
  const char *month = (state.nowMonth >= 1 && state.nowMonth <= 12) ? WB_MONTH_NAMES[state.nowMonth - 1] : "";
  snprintf(dateBuf, dateLen, "%s, %s %d", weekday, month, state.nowDay);
}

// "Let's have a great {period}" — matches the mock's dynamic time-of-day
// subtitle rather than a hardcoded "day". Same morning/afternoon/evening
// split as the routine tiles' names, not the routines' own schedules (those
// can be configured per-household; this is just a friendly greeting).
static const char *greeting_period(const WbDeviceState &state)
{
  if (state.nowHour < 0)
    return "day"; // mock/pre-first-poll state — see format_clock_date's comment
  if (state.nowHour < 12)
    return "morning";
  if (state.nowHour < 17)
    return "afternoon";
  return "evening";
}

static int routine_done_count(const WbRoutine &r)
{
  int n = 0;
  for (int i = 0; i < r.count; i++)
    if (r.tasks[i].done)
      n++;
  return n;
}

// Soft, warm-tinted elevation shared by every card/tile on this screen —
// matches the mock's gentle drop shadow rather than LVGL's default black one.
static void apply_card_shadow(lv_obj_t *obj)
{
  lv_obj_set_style_shadow_width(obj, 20, 0);
  lv_obj_set_style_shadow_spread(obj, 0, 0);
  lv_obj_set_style_shadow_ofs_y(obj, 6, 0);
  lv_obj_set_style_shadow_color(obj, WB_COLOR_INK, 0);
  lv_obj_set_style_shadow_opa(obj, LV_OPA_10, 0);
}

static lv_obj_t *make_card(lv_obj_t *parent)
{
  lv_obj_t *card = lv_obj_create(parent);
  lv_obj_set_style_bg_color(card, WB_COLOR_CARD, 0);
  lv_obj_set_style_border_width(card, 0, 0);
  lv_obj_set_style_radius(card, 16, 0);
  lv_obj_set_style_pad_all(card, 14, 0);
  lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);
  apply_card_shadow(card);
  return card;
}

// A baked A8 icon (see icons/wb_icons.h) tinted to `color` — A8 images carry
// no color of their own, LVGL fills the shape with style_image_recolor at
// draw time, so the same baked asset works on any tile/background.
static lv_obj_t *make_icon(lv_obj_t *parent, const lv_image_dsc_t *src, lv_color_t color)
{
  lv_obj_t *img = lv_image_create(parent);
  lv_image_set_src(img, src);
  lv_obj_set_style_image_recolor(img, color, 0);
  lv_obj_set_style_image_recolor_opa(img, LV_OPA_COVER, 0);
  return img;
}

// A small rounded pill for counts/status ("1 / 3", "24 stars"). Sized to hug
// its label — every caller must NOT also set an explicit size, or it falls
// back to LVGL's 100x100 default object size (bit us once already).
// `icon`, when given, renders before the label (the mock's star-badge chips) —
// see make_icon's comment on why it needs `fg` as a recolor.
// `out_lbl` optionally hands back the inner label so a caller can update its
// text later without a rebuild (see wb_sync_home_screen).
static lv_obj_t *make_badge(lv_obj_t *parent, const char *text, lv_color_t bg, lv_color_t fg, const lv_image_dsc_t *icon = nullptr,
                             lv_obj_t **out_lbl = nullptr)
{
  lv_obj_t *pill = lv_obj_create(parent);
  lv_obj_remove_style_all(pill);
  lv_obj_set_size(pill, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(pill, bg, 0);
  lv_obj_set_style_bg_opa(pill, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(pill, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(pill, 10, 0);
  lv_obj_set_style_pad_ver(pill, 4, 0);
  lv_obj_set_flex_flow(pill, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(pill, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_column(pill, 5, 0);
  lv_obj_clear_flag(pill, LV_OBJ_FLAG_SCROLLABLE);

  if (icon)
    make_icon(pill, icon, fg);

  lv_obj_t *lbl = lv_label_create(pill);
  lv_label_set_text(lbl, text);
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(lbl, fg, 0);
  if (out_lbl)
    *out_lbl = lbl;
  return pill;
}

// A small green checkmark circle that overlaps a routine tile's count pill
// once every task in it is done — matches the mock's overlapping-badge
// treatment (not a checkmark glyph appended into the pill text, which is
// what this screen did before). `align`/`ofs_x`/`ofs_y` position it over
// wherever the pill actually sits (top-right corner for the column-flow
// tiles, right-middle for the horizontal chores bar). Always created (so
// wb_sync_home_screen can toggle it without a rebuild) but hidden by
// default; the caller shows/hides it based on all_done.
static lv_obj_t *make_done_check(lv_obj_t *tile, lv_align_t align, lv_coord_t ofs_x, lv_coord_t ofs_y)
{
  lv_obj_t *badge = lv_obj_create(tile);
  lv_obj_remove_style_all(badge);
  lv_obj_set_size(badge, 26, 26);
  lv_obj_set_style_radius(badge, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(badge, WB_COLOR_DONE_GREEN, 0);
  lv_obj_set_style_bg_opa(badge, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(badge, 2, 0);
  lv_obj_set_style_border_color(badge, lv_color_white(), 0);
  lv_obj_clear_flag(badge, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_flag(badge, LV_OBJ_FLAG_IGNORE_LAYOUT);
  lv_obj_add_flag(badge, LV_OBJ_FLAG_HIDDEN);
  lv_obj_align(badge, align, ofs_x, ofs_y);

  lv_obj_t *icon = lv_label_create(badge);
  lv_label_set_text(icon, LV_SYMBOL_OK);
  lv_obj_set_style_text_font(icon, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(icon, lv_color_white(), 0);
  lv_obj_center(icon);
  return badge;
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
// `out_badge_lbl`/`out_bar`/`out_check` optionally hand back the pieces that
// change between polls (done count, progress, all-done state) so
// wb_sync_home_screen can update them in place without tearing this tile
// down.
static lv_obj_t *make_routine_tile(lv_obj_t *parent, const char *name, const WbRoutine &r, lv_color_t bg, lv_color_t fg,
                                    const lv_image_dsc_t *icon,
                                    lv_obj_t **out_badge_lbl = nullptr, lv_obj_t **out_bar = nullptr, lv_obj_t **out_check = nullptr)
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
  apply_card_shadow(tile);

  int done = routine_done_count(r);
  bool all_done = r.count > 0 && done == r.count;

  lv_obj_t *top_row = lv_obj_create(tile);
  lv_obj_remove_style_all(top_row);
  lv_obj_set_size(top_row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(top_row, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(top_row, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(top_row, LV_OBJ_FLAG_SCROLLABLE);

  make_icon(top_row, icon, fg);

  char badge_buf[24];
  snprintf(badge_buf, sizeof(badge_buf), "%d / %d", done, r.count);
  lv_obj_t *badge_lbl = nullptr;
  make_badge(top_row, badge_buf, lv_color_white(), fg, nullptr, &badge_lbl);
  if (out_badge_lbl)
    *out_badge_lbl = badge_lbl;

  lv_obj_t *check = make_done_check(tile, LV_ALIGN_TOP_RIGHT, 6, -6);
  if (all_done)
    lv_obj_clear_flag(check, LV_OBJ_FLAG_HIDDEN);
  if (out_check)
    *out_check = check;

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
// `out_badge_lbl`/`out_bar`/`out_check` — see make_routine_tile's comment, same idea.
static lv_obj_t *make_chores_bar(lv_obj_t *parent, const WbRoutine &r, lv_obj_t **out_badge_lbl = nullptr, lv_obj_t **out_bar = nullptr,
                                  lv_obj_t **out_check = nullptr)
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
  apply_card_shadow(bar_card);

  int done = routine_done_count(r);
  bool all_done = r.count > 0 && done == r.count;

  make_icon(bar_card, &wb_icon_broom_32, WB_COLOR_CHORES_TEXT);

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
  snprintf(badge_buf, sizeof(badge_buf), "%d / %d", done, r.count);
  lv_obj_t *badge_lbl = nullptr;
  make_badge(bar_card, badge_buf, lv_color_white(), WB_COLOR_CHORES_TEXT, nullptr, &badge_lbl);
  if (out_badge_lbl)
    *out_badge_lbl = badge_lbl;

  lv_obj_t *check = make_done_check(bar_card, LV_ALIGN_RIGHT_MID, 6, 0);
  if (all_done)
    lv_obj_clear_flag(check, LV_OBJ_FLAG_HIDDEN);
  if (out_check)
    *out_check = check;

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
  WbTaskCompleteCallback onUncomplete;
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
  wb_build_tasks_screen(ctx->tasks_scr, ctx->title, *ctx->routine, ctx->home_scr, ctx->onComplete, ctx->onUncomplete);
  lv_scr_load_anim(ctx->tasks_scr, LV_SCR_LOAD_ANIM_MOVE_LEFT, 200, 0, false);
}

// Attaches the open-tasks-screen tap handler to a tile/bar that's already
// clickable (lv_obj_create's default flags include CLICKABLE).
static void wb_wire_open_tasks(lv_obj_t *tile, const char *title, const WbRoutine &routine, lv_obj_t *tasks_scr, lv_obj_t *home_scr,
                                WbTaskCompleteCallback onComplete, WbTaskCompleteCallback onUncomplete)
{
  WbOpenTasksCtx *ctx = new WbOpenTasksCtx{title, &routine, tasks_scr, home_scr, onComplete, onUncomplete};
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

  make_icon(btn, &wb_icon_gear_24, WB_COLOR_INK);

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
  lv_obj_t *clock_lbl;
  lv_obj_t *date_lbl;
  lv_obj_t *sub_lbl;
  lv_obj_t *stars_greet_lbl;
  lv_obj_t *morning_badge_lbl;
  lv_obj_t *morning_bar;
  lv_obj_t *morning_check;
  lv_obj_t *afternoon_badge_lbl;
  lv_obj_t *afternoon_bar;
  lv_obj_t *afternoon_check;
  lv_obj_t *evening_badge_lbl;
  lv_obj_t *evening_bar;
  lv_obj_t *evening_check;
  lv_obj_t *chores_badge_lbl;
  lv_obj_t *chores_bar_obj;
  lv_obj_t *chores_check;
};

static void wb_home_sync_ctx_delete_cb(lv_event_t *e)
{
  delete (WbHomeSyncCtx *)lv_event_get_user_data(e);
}

// Shared by wb_build_home_screen (initial values) and wb_sync_home_screen
// (later polls) so a routine tile's badge+bar+check are computed identically
// both places.
static void sync_routine_widgets(lv_obj_t *badge_lbl, lv_obj_t *bar, lv_obj_t *check, const WbRoutine &r)
{
  int done = routine_done_count(r);
  bool all_done = r.count > 0 && done == r.count;
  char badge_buf[24];
  snprintf(badge_buf, sizeof(badge_buf), "%d / %d", done, r.count);
  lv_label_set_text(badge_lbl, badge_buf);
  lv_bar_set_range(bar, 0, r.count > 0 ? r.count : 1);
  lv_bar_set_value(bar, done, LV_ANIM_OFF);
  if (all_done)
    lv_obj_clear_flag(check, LV_OBJ_FLAG_HIDDEN);
  else
    lv_obj_add_flag(check, LV_OBJ_FLAG_HIDDEN);
}

void wb_sync_home_screen(lv_obj_t *parent, const WbDeviceState &state)
{
  WbHomeSyncCtx *ctx = (WbHomeSyncCtx *)lv_obj_get_user_data(parent);
  if (!ctx)
    return; // not built yet

  char clock_buf[8], date_buf[24];
  format_clock_date(clock_buf, sizeof(clock_buf), date_buf, sizeof(date_buf), state);
  lv_label_set_text(ctx->clock_lbl, clock_buf);
  lv_label_set_text(ctx->date_lbl, date_buf);

  char sub_buf[40];
  snprintf(sub_buf, sizeof(sub_buf), "Let's have a great %s", greeting_period(state));
  lv_label_set_text(ctx->sub_lbl, sub_buf);

  char stars_buf[24];
  snprintf(stars_buf, sizeof(stars_buf), "%d stars", state.stars);
  lv_label_set_text(ctx->stars_greet_lbl, stars_buf);

  sync_routine_widgets(ctx->morning_badge_lbl, ctx->morning_bar, ctx->morning_check, state.morning);
  sync_routine_widgets(ctx->afternoon_badge_lbl, ctx->afternoon_bar, ctx->afternoon_check, state.afternoon);
  sync_routine_widgets(ctx->evening_badge_lbl, ctx->evening_bar, ctx->evening_check, state.evening);
  sync_routine_widgets(ctx->chores_badge_lbl, ctx->chores_bar_obj, ctx->chores_check, state.chores);
}

void wb_build_home_screen(lv_obj_t *parent, const WbDeviceState &state, lv_obj_t *settings_scr, lv_obj_t *tasks_scr,
                           WbTaskCompleteCallback onComplete, WbTaskCompleteCallback onUncomplete)
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
  lv_obj_t *clock_logo = lv_image_create(clock_col);
  lv_image_set_src(clock_logo, &wb_logo_40);
  char clock_buf[8], date_buf[24];
  format_clock_date(clock_buf, sizeof(clock_buf), date_buf, sizeof(date_buf), state);
  lv_obj_t *clock_lbl = lv_label_create(clock_col);
  lv_label_set_text(clock_lbl, clock_buf);
  lv_obj_set_style_text_font(clock_lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(clock_lbl, WB_COLOR_INK, 0);
  lv_obj_t *date_lbl = lv_label_create(clock_col);
  lv_label_set_text(date_lbl, date_buf);
  lv_obj_set_style_text_font(date_lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(date_lbl, WB_COLOR_MUTED, 0);

  // Just the gear now — this used to also hold a small stars badge, but it
  // duplicated the greeting card's stars pill and rendered too cramped up
  // here (real-device feedback: "next to the settings icon there is a
  // little- I think it's supposed to be stars but I'm not entirely sure
  // what it is"). The greeting card's stars_greet_lbl is still the one
  // source of truth for the stars count.
  make_gear_button(top, settings_scr);

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
  lv_obj_set_style_text_font(hi_lbl, &wb_font_newsreader_semibold_32, 0);
  lv_obj_set_style_text_color(hi_lbl, WB_COLOR_INK, 0);
  lv_obj_set_style_pad_top(hi_lbl, 8, 0);

  char sub_buf[40];
  snprintf(sub_buf, sizeof(sub_buf), "Let's have a great %s", greeting_period(state));
  lv_obj_t *sub_lbl = lv_label_create(greet);
  lv_label_set_text(sub_lbl, sub_buf);
  lv_obj_set_style_text_font(sub_lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(sub_lbl, WB_COLOR_MUTED, 0);
  lv_obj_set_style_pad_bottom(sub_lbl, 4, 0);

  lv_obj_t *stars_greet_lbl = nullptr;
  make_badge(greet, stars_buf, WB_COLOR_STARS_BG, WB_COLOR_GOLD, &wb_icon_star_18, &stars_greet_lbl);

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

  lv_obj_t *morning_badge_lbl = nullptr, *morning_bar = nullptr, *morning_check = nullptr;
  lv_obj_t *afternoon_badge_lbl = nullptr, *afternoon_bar = nullptr, *afternoon_check = nullptr;
  lv_obj_t *evening_badge_lbl = nullptr, *evening_bar = nullptr, *evening_check = nullptr;
  lv_obj_t *morning_tile = make_routine_tile(tiles_row, "Morning", state.morning, WB_COLOR_MORNING, WB_COLOR_MORNING_TEXT, &wb_icon_sun_32, &morning_badge_lbl, &morning_bar, &morning_check);
  lv_obj_t *afternoon_tile = make_routine_tile(tiles_row, "Afternoon", state.afternoon, WB_COLOR_AFTERNOON, WB_COLOR_AFTERNOON_TEXT, &wb_icon_sunhigh_32, &afternoon_badge_lbl, &afternoon_bar, &afternoon_check);
  lv_obj_t *evening_tile = make_routine_tile(tiles_row, "Evening", state.evening, WB_COLOR_EVENING, WB_COLOR_EVENING_TEXT, &wb_icon_moon_32, &evening_badge_lbl, &evening_bar, &evening_check);
  wb_wire_open_tasks(morning_tile, "Morning", state.morning, tasks_scr, parent, onComplete, onUncomplete);
  wb_wire_open_tasks(afternoon_tile, "Afternoon", state.afternoon, tasks_scr, parent, onComplete, onUncomplete);
  wb_wire_open_tasks(evening_tile, "Evening", state.evening, tasks_scr, parent, onComplete, onUncomplete);

  lv_obj_t *chores_badge_lbl = nullptr, *chores_bar_obj = nullptr, *chores_check = nullptr;
  lv_obj_t *chores_bar = make_chores_bar(right_col, state.chores, &chores_badge_lbl, &chores_bar_obj, &chores_check);
  wb_wire_open_tasks(chores_bar, "Chores", state.chores, tasks_scr, parent, onComplete, onUncomplete);

  // Stash the pieces wb_sync_home_screen updates in place on later polls —
  // see WbHomeSyncCtx's comment for the leak-avoidance rule (delete cb on
  // `top`, a real child, not on `parent` itself).
  WbHomeSyncCtx *sync_ctx = new WbHomeSyncCtx{
      clock_lbl, date_lbl, sub_lbl,
      stars_greet_lbl,
      morning_badge_lbl, morning_bar, morning_check,
      afternoon_badge_lbl, afternoon_bar, afternoon_check,
      evening_badge_lbl, evening_bar, evening_check,
      chores_badge_lbl, chores_bar_obj, chores_check,
  };
  lv_obj_add_event_cb(top, wb_home_sync_ctx_delete_cb, LV_EVENT_DELETE, sync_ctx);
  lv_obj_set_user_data(parent, sync_ctx);
}
