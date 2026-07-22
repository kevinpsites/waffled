#include "quiet_screen.h"
#include <cstdio>

// Dark, calm palette — deliberately distinct from every other screen's warm
// cream/ink theme, matching the mockup's navy "wind down" mood. No moon/star
// glyph yet (no built-in LV_SYMBOL_* match, no custom icon font — same
// "built-in symbols for now" convention as the rest of this app), so the
// title stands alone rather than pairing with a mismatched icon.
#define WB_QUIET_BG lv_color_hex(0x1B2A4A)
#define WB_QUIET_RING lv_color_hex(0xE7E1D6)
#define WB_QUIET_INK lv_color_hex(0xF5EFE1)
#define WB_QUIET_MUTED lv_color_hex(0x9AA3C4)

// Owns the 1s local countdown ticker + everything a later poll's sync needs
// to update without a full rebuild. `parent` (the quiet screen itself) is a
// persistent singleton created once in main.cpp's setup() and only ever
// lv_obj_clean()'d before a rebuild — never itself deleted — so this ctx (and
// its timer) is attached to `arc`, a genuine child that DOES get deleted on
// every lv_obj_clean(parent), not to `parent`. Attaching to `parent` would
// leak a new 1Hz timer every poll while quiet time is active (this screen
// used to rebuild every poll — see main.cpp's history — that's now fixed,
// but the ctx lifetime rule stays the same regardless). `parent` also holds
// a raw pointer to this ctx via lv_obj_set_user_data so wb_sync_quiet_screen
// (called every poll once this screen is already showing) can reach it
// without a rebuild.
struct WbQuietCtx
{
  int remainingSec;
  bool running; // false while paused — the 1s ticker holds still until this flips back
  lv_obj_t *arc;
  lv_obj_t *time_lbl;
  lv_obj_t *until_lbl;
  lv_timer_t *tick_timer;
};

static void wb_quiet_ctx_delete_cb(lv_event_t *e)
{
  WbQuietCtx *ctx = (WbQuietCtx *)lv_event_get_user_data(e);
  lv_timer_del(ctx->tick_timer);
  delete ctx;
}

// Shared by the initial build and every later sync so "Stay cozy until" is
// computed identically in both places.
static void formatUntilText(char *buf, size_t len, int remainingSec, int nowHour, int nowMin)
{
  if (nowHour < 0)
  {
    snprintf(buf, len, "Stay cozy for a bit longer");
    return;
  }
  int totalMin = nowHour * 60 + nowMin + (remainingSec + 59) / 60; // round up to the next minute
  totalMin %= (24 * 60);
  int h24 = totalMin / 60;
  int m = totalMin % 60;
  int h12 = h24 % 12;
  if (h12 == 0)
    h12 = 12;
  snprintf(buf, len, "Stay cozy until %d:%02d %s", h12, m, h24 < 12 ? "AM" : "PM");
}

// Only counts down while `running` — paused (active but not running, e.g. a
// parent hit pause from the web app) holds the display still instead of
// ticking down locally against a server value that isn't actually moving.
static void wb_quiet_tick_cb(lv_timer_t *timer)
{
  WbQuietCtx *ctx = (WbQuietCtx *)lv_timer_get_user_data(timer);
  if (!ctx->running)
    return;
  if (ctx->remainingSec > 0)
    ctx->remainingSec--;
  lv_arc_set_value(ctx->arc, ctx->remainingSec);
  char buf[8];
  snprintf(buf, sizeof(buf), "%d:%02d", ctx->remainingSec / 60, ctx->remainingSec % 60);
  lv_label_set_text(ctx->time_lbl, buf);
}

void wb_build_quiet_screen(lv_obj_t *parent, const WbQuietState &quiet, int nowHour, int nowMin)
{
  lv_obj_set_style_bg_color(parent, WB_QUIET_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(parent, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_row(parent, 16, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);
  // No back button, no gear, no gesture handler, nothing clickable below
  // that navigates anywhere — this is the actual "not exitable" mechanism.

  lv_obj_t *title = lv_label_create(parent);
  lv_label_set_text(title, "Quiet time");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(title, WB_QUIET_INK, 0);

  int durationSec = quiet.durationSec > 0 ? quiet.durationSec : 1;
  int remainingSec = quiet.remainingSec > 0 ? quiet.remainingSec : 0;

  lv_obj_t *arc = lv_arc_create(parent);
  lv_obj_set_size(arc, 260, 260);
  lv_arc_set_rotation(arc, 270);
  lv_arc_set_bg_angles(arc, 0, 360);
  lv_arc_set_range(arc, 0, durationSec);
  lv_arc_set_value(arc, remainingSec);
  lv_obj_remove_style(arc, NULL, LV_PART_KNOB); // display-only ring, no draggable knob
  lv_obj_clear_flag(arc, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_arc_color(arc, WB_QUIET_RING, LV_PART_INDICATOR);
  lv_obj_set_style_arc_width(arc, 10, LV_PART_INDICATOR);
  lv_obj_set_style_arc_color(arc, WB_QUIET_RING, LV_PART_MAIN);
  lv_obj_set_style_arc_opa(arc, LV_OPA_30, LV_PART_MAIN);
  lv_obj_set_style_arc_width(arc, 10, LV_PART_MAIN);

  lv_obj_t *time_lbl = lv_label_create(arc);
  char time_buf[8];
  snprintf(time_buf, sizeof(time_buf), "%d:%02d", remainingSec / 60, remainingSec % 60);
  lv_label_set_text(time_lbl, time_buf);
  lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_32, 0);
  lv_obj_set_style_text_color(time_lbl, WB_QUIET_INK, 0);
  lv_obj_center(time_lbl);

  lv_obj_t *left_lbl = lv_label_create(arc);
  lv_label_set_text(left_lbl, "LEFT");
  lv_obj_set_style_text_font(left_lbl, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(left_lbl, WB_QUIET_MUTED, 0);
  lv_obj_align_to(left_lbl, time_lbl, LV_ALIGN_OUT_BOTTOM_MID, 0, 6);

  lv_obj_t *until_lbl = lv_label_create(parent);
  lv_obj_set_style_text_font(until_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(until_lbl, WB_QUIET_MUTED, 0);
  lv_obj_set_style_pad_top(until_lbl, 8, 0);
  char until_buf[48];
  formatUntilText(until_buf, sizeof(until_buf), remainingSec, nowHour, nowMin);
  lv_label_set_text(until_lbl, until_buf);

  WbQuietCtx *ctx = new WbQuietCtx{remainingSec, quiet.running, arc, time_lbl, until_lbl, nullptr};
  ctx->tick_timer = lv_timer_create(wb_quiet_tick_cb, 1000, ctx);
  lv_obj_add_event_cb(arc, wb_quiet_ctx_delete_cb, LV_EVENT_DELETE, ctx);
  lv_obj_set_user_data(parent, ctx); // wb_sync_quiet_screen's way back to this ctx
}

void wb_sync_quiet_screen(lv_obj_t *parent, const WbQuietState &quiet, int nowHour, int nowMin)
{
  WbQuietCtx *ctx = (WbQuietCtx *)lv_obj_get_user_data(parent);
  if (!ctx)
    return; // not built yet — main.cpp only calls this after a build, but don't crash if that ever changes

  ctx->remainingSec = quiet.remainingSec > 0 ? quiet.remainingSec : 0;
  ctx->running = quiet.running;

  int durationSec = quiet.durationSec > 0 ? quiet.durationSec : 1;
  lv_arc_set_range(ctx->arc, 0, durationSec); // a parent could add-time mid-session, changing the total
  lv_arc_set_value(ctx->arc, ctx->remainingSec);

  char time_buf[8];
  snprintf(time_buf, sizeof(time_buf), "%d:%02d", ctx->remainingSec / 60, ctx->remainingSec % 60);
  lv_label_set_text(ctx->time_lbl, time_buf);

  char until_buf[48];
  formatUntilText(until_buf, sizeof(until_buf), ctx->remainingSec, nowHour, nowMin);
  lv_label_set_text(ctx->until_lbl, until_buf);
}
