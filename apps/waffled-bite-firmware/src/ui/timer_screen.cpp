#include "timer_screen.h"
#include <cstdio>

// Palette — kept in sync with the other light screens' by eye; duplicated
// rather than shared, same rationale as settings_screen.cpp/tasks_screen.cpp.
// Deliberately the same light/cream palette as settings/control_detail
// (not quiet_screen's dark navy) — this is a normal, exitable utility
// screen, not a "wind down" mood.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_TILE_ACTIVE lv_color_hex(0x1C1A18)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_GOLD lv_color_hex(0xC98A1E)

static const int WB_TIMER_PRESET_MIN[] = {5, 10, 15, 20, 30};

// The big countdown label — a timer can now run up to 3h (parent-settable,
// was capped at 90min), so a bare "%d:%02d" of minutes:seconds would read as
// "185:00"; switch to "H:MM:SS" once past an hour, same shape as any
// clock/stopwatch. Duplicated from quiet_screen.cpp's identical helper —
// same per-file convention as this app's other small shared pieces (see
// bedtime_screen.cpp's color-table comment).
static void formatCountdown(char *buf, size_t len, int remainingSec)
{
  int h = remainingSec / 3600;
  int m = (remainingSec % 3600) / 60;
  int s = remainingSec % 60;
  if (h > 0)
    snprintf(buf, len, "%d:%02d:%02d", h, m, s);
  else
    snprintf(buf, len, "%d:%02d", m, s);
}

static void wb_timer_close_cb(lv_event_t *e)
{
  lv_obj_t *back_scr = (lv_obj_t *)lv_event_get_user_data(e);
  // NOT a fade — see settings_screen.cpp's wb_open_detail_cb for why.
  lv_scr_load_anim(back_scr, LV_SCR_LOAD_ANIM_NONE, 0, 0, false);
}

static void make_home_button(lv_obj_t *parent, lv_obj_t *back_scr)
{
  lv_obj_t *top = lv_obj_create(parent);
  lv_obj_remove_style_all(top);
  lv_obj_set_size(top, lv_pct(100), 56);
  lv_obj_set_flex_flow(top, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(top, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(top, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *home_btn = lv_obj_create(top);
  lv_obj_remove_style_all(home_btn);
  lv_obj_set_size(home_btn, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(home_btn, WB_COLOR_CARD, 0);
  lv_obj_set_style_bg_opa(home_btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(home_btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(home_btn, 16, 0);
  lv_obj_set_style_pad_ver(home_btn, 10, 0);
  lv_obj_clear_flag(home_btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *lbl = lv_label_create(home_btn);
  lv_label_set_text(lbl, LV_SYMBOL_LEFT " Home");
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(lbl, WB_COLOR_INK, 0);
  lv_obj_add_event_cb(home_btn, wb_timer_close_cb, LV_EVENT_CLICKED, back_scr);
}

// ── picker mode (timer.active == false) ─────────────────────────────────────
struct WbTimerPresetCtx
{
  int minutes;
  WbTimerStartCallback onStart;
};
static void wb_timer_preset_delete_cb(lv_event_t *e) { delete (WbTimerPresetCtx *)lv_event_get_user_data(e); }
static void wb_timer_preset_clicked_cb(lv_event_t *e)
{
  WbTimerPresetCtx *ctx = (WbTimerPresetCtx *)lv_event_get_user_data(e);
  if (ctx->onStart)
    ctx->onStart(ctx->minutes * 60); // main.cpp polls immediately on success, which rebuilds this screen into countdown mode
}

// ── custom length (a stepper, not a text keyboard — faster for a kid to
// tap through on a touchscreen than typing an exact number) ────────────────
#define WB_TIMER_CUSTOM_MIN 1
#define WB_TIMER_CUSTOM_MAX 90
struct WbTimerCustomCtx
{
  int minutes;
  lv_obj_t *value_lbl;
  WbTimerStartCallback onStart;
};
static void wb_timer_custom_delete_cb(lv_event_t *e) { delete (WbTimerCustomCtx *)lv_event_get_user_data(e); }
static void wb_timer_custom_refresh(WbTimerCustomCtx *ctx)
{
  char buf[8];
  snprintf(buf, sizeof(buf), "%dm", ctx->minutes);
  lv_label_set_text(ctx->value_lbl, buf);
}
// Holds the step's direction alongside a pointer back to the shared custom
// ctx — one of these per +/- button, freed with its own button (not the
// shared ctx, which the Start button owns; see wb_timer_custom_delete_cb).
struct WbTimerStepCtx
{
  WbTimerCustomCtx *custom;
  int delta;
};
static void wb_timer_step_delete_cb(lv_event_t *e) { delete (WbTimerStepCtx *)lv_event_get_user_data(e); }
static void wb_timer_custom_step_cb(lv_event_t *e)
{
  WbTimerStepCtx *step = (WbTimerStepCtx *)lv_event_get_user_data(e);
  WbTimerCustomCtx *ctx = step->custom;
  ctx->minutes = LV_CLAMP(WB_TIMER_CUSTOM_MIN, ctx->minutes + step->delta, WB_TIMER_CUSTOM_MAX);
  wb_timer_custom_refresh(ctx);
}
static void wb_timer_custom_start_cb(lv_event_t *e)
{
  WbTimerCustomCtx *ctx = (WbTimerCustomCtx *)lv_event_get_user_data(e);
  if (ctx->onStart)
    ctx->onStart(ctx->minutes * 60); // main.cpp polls immediately on success, which rebuilds this screen into countdown mode
}

static lv_obj_t *make_round_btn(lv_obj_t *parent, const char *text, lv_color_t bg, lv_color_t fg)
{
  lv_obj_t *btn = lv_obj_create(parent);
  lv_obj_remove_style_all(btn);
  lv_obj_set_size(btn, 44, 44);
  lv_obj_set_style_bg_color(btn, bg, 0);
  lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_flex_flow(btn, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(btn, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *lbl = lv_label_create(btn);
  lv_label_set_text(lbl, text);
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(lbl, fg, 0);
  return btn;
}

static void wb_build_timer_picker(lv_obj_t *parent, WbTimerStartCallback onStart)
{
  lv_obj_t *title = lv_label_create(parent);
  lv_label_set_text(title, "Set a timer");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_INK, 0);

  lv_obj_t *sub = lv_label_create(parent);
  lv_label_set_text(sub, "Pick how long.");
  lv_obj_set_style_text_font(sub, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(sub, WB_COLOR_MUTED, 0);

  lv_obj_t *row = lv_obj_create(parent);
  lv_obj_remove_style_all(row);
  lv_obj_set_size(row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW_WRAP);
  lv_obj_set_style_pad_column(row, 10, 0);
  lv_obj_set_style_pad_row(row, 10, 0);
  lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

  for (int minutes : WB_TIMER_PRESET_MIN)
  {
    lv_obj_t *chip = lv_obj_create(row);
    lv_obj_remove_style_all(chip);
    lv_obj_set_size(chip, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(chip, WB_COLOR_CARD, 0);
    lv_obj_set_style_bg_opa(chip, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(chip, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_pad_hor(chip, 20, 0);
    lv_obj_set_style_pad_ver(chip, 14, 0);
    lv_obj_clear_flag(chip, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *chip_lbl = lv_label_create(chip);
    char buf[8];
    snprintf(buf, sizeof(buf), "%dm", minutes);
    lv_label_set_text(chip_lbl, buf);
    lv_obj_set_style_text_font(chip_lbl, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(chip_lbl, WB_COLOR_INK, 0);

    WbTimerPresetCtx *preset_ctx = new WbTimerPresetCtx{minutes, onStart};
    lv_obj_add_event_cb(chip, wb_timer_preset_clicked_cb, LV_EVENT_CLICKED, preset_ctx);
    lv_obj_add_event_cb(chip, wb_timer_preset_delete_cb, LV_EVENT_DELETE, preset_ctx);
  }

  lv_obj_t *custom_sub = lv_label_create(parent);
  lv_label_set_text(custom_sub, "Or choose your own");
  lv_obj_set_style_text_font(custom_sub, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(custom_sub, WB_COLOR_MUTED, 0);

  lv_obj_t *custom_row = lv_obj_create(parent);
  lv_obj_remove_style_all(custom_row);
  lv_obj_set_size(custom_row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(custom_row, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(custom_row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_column(custom_row, 14, 0);
  lv_obj_clear_flag(custom_row, LV_OBJ_FLAG_SCROLLABLE);

  WbTimerCustomCtx *custom_ctx = new WbTimerCustomCtx{10, nullptr, onStart};

  lv_obj_t *minus_btn = make_round_btn(custom_row, LV_SYMBOL_MINUS, WB_COLOR_CARD, WB_COLOR_INK);
  WbTimerStepCtx *minus_step = new WbTimerStepCtx{custom_ctx, -1};
  lv_obj_add_event_cb(minus_btn, wb_timer_custom_step_cb, LV_EVENT_CLICKED, minus_step);
  lv_obj_add_event_cb(minus_btn, wb_timer_step_delete_cb, LV_EVENT_DELETE, minus_step);

  lv_obj_t *value_lbl = lv_label_create(custom_row);
  lv_obj_set_style_text_font(value_lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(value_lbl, WB_COLOR_INK, 0);
  lv_obj_set_style_pad_hor(value_lbl, 4, 0);
  custom_ctx->value_lbl = value_lbl;
  wb_timer_custom_refresh(custom_ctx);

  lv_obj_t *plus_btn = make_round_btn(custom_row, LV_SYMBOL_PLUS, WB_COLOR_CARD, WB_COLOR_INK);
  WbTimerStepCtx *plus_step = new WbTimerStepCtx{custom_ctx, 1};
  lv_obj_add_event_cb(plus_btn, wb_timer_custom_step_cb, LV_EVENT_CLICKED, plus_step);
  lv_obj_add_event_cb(plus_btn, wb_timer_step_delete_cb, LV_EVENT_DELETE, plus_step);

  lv_obj_t *start_btn = lv_obj_create(custom_row);
  lv_obj_remove_style_all(start_btn);
  lv_obj_set_size(start_btn, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(start_btn, WB_COLOR_TILE_ACTIVE, 0);
  lv_obj_set_style_bg_opa(start_btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(start_btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(start_btn, 20, 0);
  lv_obj_set_style_pad_ver(start_btn, 12, 0);
  lv_obj_clear_flag(start_btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *start_lbl = lv_label_create(start_btn);
  lv_label_set_text(start_lbl, "Start");
  lv_obj_set_style_text_font(start_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(start_lbl, lv_color_white(), 0);
  lv_obj_add_event_cb(start_btn, wb_timer_custom_start_cb, LV_EVENT_CLICKED, custom_ctx);
  // Owns custom_ctx's lifetime — the last widget built that references it.
  lv_obj_add_event_cb(start_btn, wb_timer_custom_delete_cb, LV_EVENT_DELETE, custom_ctx);
}

// ── countdown mode (timer.active == true) ───────────────────────────────────
// Owns the 1s local ticker — same "attach to a genuine per-rebuild child,
// not the persistent screen singleton" rule as quiet_screen.cpp's WbQuietCtx.
struct WbTimerCountdownCtx
{
  int remainingSec;
  bool running;
  lv_obj_t *arc;
  lv_obj_t *time_lbl;
  lv_timer_t *tick_timer;
};

static void wb_timer_countdown_ctx_delete_cb(lv_event_t *e)
{
  WbTimerCountdownCtx *ctx = (WbTimerCountdownCtx *)lv_event_get_user_data(e);
  lv_timer_del(ctx->tick_timer);
  delete ctx;
}

static void wb_timer_tick_cb(lv_timer_t *timer)
{
  WbTimerCountdownCtx *ctx = (WbTimerCountdownCtx *)lv_timer_get_user_data(timer);
  if (!ctx->running)
    return;
  if (ctx->remainingSec > 0)
    ctx->remainingSec--;
  lv_arc_set_value(ctx->arc, ctx->remainingSec);
  char buf[8];
  formatCountdown(buf, sizeof(buf), ctx->remainingSec);
  lv_label_set_text(ctx->time_lbl, buf);
}

struct WbTimerEndCtx
{
  WbTimerEndCallback onEnd;
};
static void wb_timer_end_delete_cb(lv_event_t *e) { delete (WbTimerEndCtx *)lv_event_get_user_data(e); }
static void wb_timer_end_clicked_cb(lv_event_t *e)
{
  WbTimerEndCtx *ctx = (WbTimerEndCtx *)lv_event_get_user_data(e);
  if (ctx->onEnd)
    ctx->onEnd(); // main.cpp polls immediately on success, which rebuilds this screen back into picker mode
}

static WbTimerCountdownCtx *wb_build_timer_countdown(lv_obj_t *parent, const WbTimerState &timer, WbTimerEndCallback onEnd)
{
  lv_obj_set_flex_align(parent, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

  lv_obj_t *title = lv_label_create(parent);
  lv_label_set_text(title, "Timer running");
  lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_INK, 0);

  int durationSec = timer.durationSec > 0 ? timer.durationSec : 1;
  int remainingSec = timer.remainingSec > 0 ? timer.remainingSec : 0;

  lv_obj_t *arc = lv_arc_create(parent);
  lv_obj_set_size(arc, 220, 220);
  lv_arc_set_rotation(arc, 270);
  lv_arc_set_bg_angles(arc, 0, 360);
  lv_arc_set_range(arc, 0, durationSec);
  lv_arc_set_value(arc, remainingSec);
  lv_obj_remove_style(arc, NULL, LV_PART_KNOB);
  lv_obj_clear_flag(arc, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_arc_color(arc, WB_COLOR_GOLD, LV_PART_INDICATOR);
  lv_obj_set_style_arc_width(arc, 10, LV_PART_INDICATOR);
  lv_obj_set_style_arc_color(arc, WB_COLOR_CARD, LV_PART_MAIN);
  lv_obj_set_style_arc_width(arc, 10, LV_PART_MAIN);

  lv_obj_t *time_lbl = lv_label_create(arc);
  char time_buf[8];
  formatCountdown(time_buf, sizeof(time_buf), remainingSec);
  lv_label_set_text(time_lbl, time_buf);
  lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_32, 0);
  lv_obj_set_style_text_color(time_lbl, WB_COLOR_INK, 0);
  lv_obj_center(time_lbl);

  lv_obj_t *end_btn = lv_obj_create(parent);
  lv_obj_remove_style_all(end_btn);
  lv_obj_set_size(end_btn, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(end_btn, WB_COLOR_TILE_ACTIVE, 0);
  lv_obj_set_style_bg_opa(end_btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(end_btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(end_btn, 22, 0);
  lv_obj_set_style_pad_ver(end_btn, 12, 0);
  lv_obj_clear_flag(end_btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *end_lbl = lv_label_create(end_btn);
  lv_label_set_text(end_lbl, "End timer");
  lv_obj_set_style_text_font(end_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(end_lbl, lv_color_white(), 0);
  WbTimerEndCtx *end_ctx = new WbTimerEndCtx{onEnd};
  lv_obj_add_event_cb(end_btn, wb_timer_end_clicked_cb, LV_EVENT_CLICKED, end_ctx);
  lv_obj_add_event_cb(end_btn, wb_timer_end_delete_cb, LV_EVENT_DELETE, end_ctx);

  WbTimerCountdownCtx *ctx = new WbTimerCountdownCtx{remainingSec, timer.running, arc, time_lbl, nullptr};
  ctx->tick_timer = lv_timer_create(wb_timer_tick_cb, 1000, ctx);
  lv_obj_add_event_cb(arc, wb_timer_countdown_ctx_delete_cb, LV_EVENT_DELETE, ctx);
  return ctx;
}

void wb_build_timer_screen(lv_obj_t *parent, const WbTimerState &timer, lv_obj_t *back_scr,
                            WbTimerStartCallback onStart, WbTimerEndCallback onEnd)
{
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_all(parent, 20, 0);
  lv_obj_set_style_pad_row(parent, 20, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  make_home_button(parent, back_scr);

  // Countdown-mode's own ctx (WbTimerCountdownCtx) is stashed on `parent` for
  // wb_sync_timer_screen; picker mode has nothing to sync, so it leaves
  // parent's user_data null — wb_sync_timer_screen treats that as a no-op.
  if (timer.active)
    lv_obj_set_user_data(parent, wb_build_timer_countdown(parent, timer, onEnd));
  else
  {
    lv_obj_set_user_data(parent, nullptr);
    wb_build_timer_picker(parent, onStart);
  }
}

void wb_sync_timer_screen(lv_obj_t *parent, const WbTimerState &timer)
{
  WbTimerCountdownCtx *ctx = (WbTimerCountdownCtx *)lv_obj_get_user_data(parent);
  if (!ctx)
    return; // picker mode, or not built yet — nothing to sync

  ctx->remainingSec = timer.remainingSec > 0 ? timer.remainingSec : 0;
  ctx->running = timer.running;

  int durationSec = timer.durationSec > 0 ? timer.durationSec : 1;
  lv_arc_set_range(ctx->arc, 0, durationSec);
  lv_arc_set_value(ctx->arc, ctx->remainingSec);

  char buf[8];
  formatCountdown(buf, sizeof(buf), ctx->remainingSec);
  lv_label_set_text(ctx->time_lbl, buf);
}
