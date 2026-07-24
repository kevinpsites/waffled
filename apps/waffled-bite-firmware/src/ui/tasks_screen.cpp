#include "tasks_screen.h"
#include <cstdio>

// Palette — kept in sync with the other screens' by eye; duplicated rather
// than shared, same rationale as settings_screen.cpp/onboarding_screen.cpp.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_TILE lv_color_hex(0xFFFDF8)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_STARS_BG lv_color_hex(0xFBEFD6)
#define WB_COLOR_GOLD lv_color_hex(0xC98A1E)
#define WB_COLOR_DONE lv_color_hex(0x4C9A6A)
#define WB_COLOR_DONE_RING lv_color_hex(0xD8D2C4)

static void wb_go_home_cb(lv_event_t *e)
{
  lv_obj_t *home_scr = (lv_obj_t *)lv_event_get_user_data(e);
  lv_scr_load_anim(home_scr, LV_SCR_LOAD_ANIM_MOVE_RIGHT, 200, 0, false);
}

// A small rounded pill, same shape as home_screen.cpp's make_badge — not
// shared (see the palette comment above), just the same visual language.
static lv_obj_t *make_badge(lv_obj_t *parent, const char *text, lv_color_t bg, lv_color_t fg)
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
  return pill;
}

// The three looks a row can be in — Pending/Done are the plain checkbox
// states; Awaiting is a tapped, photo/approval-required chore sitting in the
// parent's approval queue (see WbTaskCompleteResult).
enum class WbRowVisual
{
  Pending,
  Done,
  Awaiting,
};

// Owns everything one row's tap handler needs: the task id to POST, the
// checkbox/label/status-label to update in place, current done-state (so a
// tap knows which direction to flip), and the complete/uncomplete callbacks.
// Heap-allocated per row and freed on LV_EVENT_DELETE — unlike
// onboarding_screen.cpp's context (built once at boot, "intentionally never
// freed" is fine there), this screen gets rebuilt every time a routine tile
// is tapped, so leaving these unfreed would leak a little more heap every
// single tap over the device's lifetime.
struct WbTaskRowCtx
{
  std::string taskId;
  lv_obj_t *checkbox;      // hidden entirely while Awaiting — see wb_set_row_visual
  lv_obj_t *checkbox_icon;
  lv_obj_t *label;
  lv_obj_t *status_label; // "Waiting on a parent's approval" — shown only while Awaiting
  bool done;
  WbTaskCompleteCallback onComplete;
  WbTaskCompleteCallback onUncomplete;
};

static void wb_row_ctx_delete_cb(lv_event_t *e)
{
  WbTaskRowCtx *ctx = (WbTaskRowCtx *)lv_event_get_user_data(e);
  delete ctx;
}

// Awaiting drops the checkbox circle entirely rather than showing it in some
// third color — direct feedback was that a circle next to "Sent!" still read
// as a checkbox waiting to be tapped again. The text alone says what's
// actually true: this one isn't up to the kid anymore.
static void wb_set_row_visual(WbTaskRowCtx *ctx, WbRowVisual visual)
{
  bool done = visual == WbRowVisual::Done;
  bool awaiting = visual == WbRowVisual::Awaiting;

  if (awaiting)
  {
    lv_obj_add_flag(ctx->checkbox, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(ctx->status_label, LV_OBJ_FLAG_HIDDEN);
  }
  else
  {
    lv_obj_clear_flag(ctx->checkbox, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(ctx->status_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_bg_color(ctx->checkbox, done ? WB_COLOR_DONE : WB_COLOR_CARD, 0);
    lv_obj_set_style_border_width(ctx->checkbox, done ? 0 : 2, 0);
    lv_obj_set_style_border_color(ctx->checkbox, WB_COLOR_DONE_RING, 0);
    lv_label_set_text(ctx->checkbox_icon, done ? LV_SYMBOL_OK : "");
  }
  lv_obj_set_style_text_decor(ctx->label, done ? LV_TEXT_DECOR_STRIKETHROUGH : LV_TEXT_DECOR_NONE, 0);
  lv_obj_set_style_text_color(ctx->label, (done || awaiting) ? WB_COLOR_MUTED : WB_COLOR_INK, 0);
}

// A tap toggles: undone -> done calls onComplete, done -> undone calls
// onUncomplete (a mis-tap, or a kid changing their mind — same "no
// confirmation dialog" UX call as completing). Optimistically flips the
// visual immediately.
//
// Three outcomes, not two: Failed reverts the optimistic flip (network
// error, or an uncomplete that didn't take); Success keeps it, since the
// server confirmed the plain done/pending transition; AwaitingApproval means
// the tap DID succeed — the chore needed a photo or a parent's OK, so the
// instance is sitting in the approval queue rather than "done" — the row
// shows that pending state instead of silently reverting to unchecked with
// no explanation, and stops accepting taps. This screen (tasks_scr) is only
// ever rebuilt when a routine tile is tapped from Home, NOT on the
// background 5s poll (see main.cpp's wb_do_poll — only home_scr/settings_scr
// get synced in place while open, to avoid tearing an in-flight tap out from
// under itself), so a frozen row stays frozen until the kid backs out to
// Home and re-enters — at which point it reads whatever the most recent
// poll already knows (e.g. a parent's approval that landed while this
// screen was still open).
static void wb_row_clicked_cb(lv_event_t *e)
{
  WbTaskRowCtx *ctx = (WbTaskRowCtx *)lv_event_get_user_data(e);
  lv_obj_t *row = (lv_obj_t *)lv_event_get_target(e);

  bool wasDone = ctx->done;
  bool completing = !wasDone;
  wb_set_row_visual(ctx, completing ? WbRowVisual::Done : WbRowVisual::Pending);
  lv_obj_remove_event_cb(row, wb_row_clicked_cb);
  lv_obj_clear_flag(row, LV_OBJ_FLAG_CLICKABLE);

  WbTaskCompleteCallback &cb = completing ? ctx->onComplete : ctx->onUncomplete;
  WbTaskCompleteResult result = cb ? cb(ctx->taskId) : WbTaskCompleteResult::Failed;

  if (result == WbTaskCompleteResult::AwaitingApproval)
  {
    ctx->done = false;
    wb_set_row_visual(ctx, WbRowVisual::Awaiting);
    return; // frozen — no click handler re-attached
  }

  if (result == WbTaskCompleteResult::Failed)
  {
    ctx->done = wasDone;
    wb_set_row_visual(ctx, wasDone ? WbRowVisual::Done : WbRowVisual::Pending);
  }
  else
  {
    ctx->done = completing;
  }
  lv_obj_add_event_cb(row, wb_row_clicked_cb, LV_EVENT_CLICKED, ctx);
  lv_obj_add_flag(row, LV_OBJ_FLAG_CLICKABLE);
}

static void wb_make_task_row(lv_obj_t *parent, const WbTask &task, WbTaskCompleteCallback onComplete, WbTaskCompleteCallback onUncomplete)
{
  lv_obj_t *row = lv_obj_create(parent);
  lv_obj_remove_style_all(row);
  lv_obj_set_style_bg_color(row, WB_COLOR_TILE, 0);
  lv_obj_set_style_bg_opa(row, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(row, 16, 0);
  lv_obj_set_style_pad_hor(row, 18, 0);
  lv_obj_set_style_pad_ver(row, 14, 0);
  lv_obj_set_style_pad_column(row, 12, 0);
  lv_obj_set_size(row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *label = lv_label_create(row);
  lv_label_set_text(label, task.title);
  lv_obj_set_flex_grow(label, 1);
  lv_obj_set_style_text_font(label, &lv_font_montserrat_16, 0);

  if (task.rewardAmount > 0)
  {
    char reward_buf[16];
    snprintf(reward_buf, sizeof(reward_buf), "+%d", task.rewardAmount);
    make_badge(row, reward_buf, WB_COLOR_STARS_BG, WB_COLOR_GOLD);
  }

  // Hidden unless the row is Awaiting — see wb_set_row_visual. A photo-required
  // row shows its own always-on pill instead (built separately below), never
  // this one.
  lv_obj_t *status_label = lv_label_create(row);
  lv_label_set_text(status_label, "Waiting on a parent's approval");
  lv_obj_set_style_text_font(status_label, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(status_label, WB_COLOR_GOLD, 0);
  lv_obj_add_flag(status_label, LV_OBJ_FLAG_HIDDEN);

  if (task.requiresPhoto)
    make_badge(row, "Needs a photo", WB_COLOR_BG, WB_COLOR_MUTED);

  lv_obj_t *checkbox = lv_obj_create(row);
  lv_obj_remove_style_all(checkbox);
  lv_obj_set_size(checkbox, 40, 40);
  lv_obj_set_style_radius(checkbox, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_opa(checkbox, LV_OPA_COVER, 0);
  lv_obj_set_flex_flow(checkbox, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(checkbox, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(checkbox, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(checkbox, LV_OBJ_FLAG_CLICKABLE); // taps land on the row, not this inner circle

  lv_obj_t *checkbox_icon = lv_label_create(checkbox);
  lv_obj_set_style_text_font(checkbox_icon, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(checkbox_icon, lv_color_white(), 0);

  WbTaskRowCtx *ctx = new WbTaskRowCtx{std::string(task.id), checkbox, checkbox_icon, label, status_label, task.done, onComplete, onUncomplete};
  WbRowVisual initial = task.done ? WbRowVisual::Done : (task.awaiting ? WbRowVisual::Awaiting : WbRowVisual::Pending);
  wb_set_row_visual(ctx, initial);

  // Mock data (native's placeholder before the first real poll) uses empty
  // ids — nothing to POST against. A photo-required chore isn't tappable on
  // this device at all (no camera-capture flow — completed from a parent's
  // phone/web instead); an already-awaiting row is frozen (see
  // wb_row_clicked_cb's comment on why). Everything else (undone or done,
  // real id, not requiring a photo) toggles either direction on tap.
  bool interactive = task.id[0] != '\0' && !task.requiresPhoto && !task.awaiting;
  if (!interactive)
  {
    lv_obj_clear_flag(row, LV_OBJ_FLAG_CLICKABLE);
    delete ctx;
  }
  else
  {
    lv_obj_add_event_cb(row, wb_row_clicked_cb, LV_EVENT_CLICKED, ctx);
    lv_obj_add_event_cb(row, wb_row_ctx_delete_cb, LV_EVENT_DELETE, ctx);
  }
}

void wb_build_tasks_screen(lv_obj_t *parent, const char *title, const WbRoutine &routine, lv_obj_t *home_scr,
                            WbTaskCompleteCallback onComplete, WbTaskCompleteCallback onUncomplete)
{
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_all(parent, 20, 0);
  lv_obj_set_style_pad_row(parent, 20, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  // ── top bar: back button + title, same shape as settings_screen.cpp's ──
  lv_obj_t *top = lv_obj_create(parent);
  lv_obj_remove_style_all(top);
  lv_obj_set_size(top, lv_pct(100), 56);
  lv_obj_set_flex_flow(top, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(top, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_column(top, 16, 0);
  lv_obj_clear_flag(top, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *back_btn = lv_obj_create(top);
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

  lv_obj_t *title_lbl = lv_label_create(top);
  lv_label_set_text(title_lbl, title);
  lv_obj_set_style_text_font(title_lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(title_lbl, WB_COLOR_INK, 0);

  // ── scrollable task list ─────────────────────────────────────────────────
  lv_obj_t *list = lv_obj_create(parent);
  lv_obj_remove_style_all(list);
  lv_obj_set_size(list, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_grow(list, 1);
  lv_obj_set_flex_flow(list, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(list, 10, 0);
  lv_obj_add_flag(list, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_scroll_dir(list, LV_DIR_VER);

  if (routine.count == 0)
  {
    lv_obj_t *empty_lbl = lv_label_create(list);
    lv_label_set_text(empty_lbl, "Nothing here right now.");
    lv_obj_set_style_text_font(empty_lbl, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(empty_lbl, WB_COLOR_MUTED, 0);
    return;
  }

  for (int i = 0; i < routine.count; i++)
    wb_make_task_row(list, routine.tasks[i], onComplete, onUncomplete);
}
