#include "control_detail_screen.h"
#include <cstdio>

// Palette — kept in sync with the other screens' by eye; duplicated rather
// than shared, same rationale as settings_screen.cpp/tasks_screen.cpp.
#define WB_COLOR_BG lv_color_hex(0xF5EFE1)
#define WB_COLOR_CARD lv_color_hex(0xFFFDF8)
#define WB_COLOR_TILE_ACTIVE lv_color_hex(0x1C1A18)
#define WB_COLOR_INK lv_color_hex(0x1C1A18)
#define WB_COLOR_MUTED lv_color_hex(0x8A8074)
#define WB_COLOR_GOLD lv_color_hex(0xC98A1E)

static void wb_go_back_cb(lv_event_t *e)
{
  lv_obj_t *back_scr = (lv_obj_t *)lv_event_get_user_data(e);
  // NOT a fade — see wb_open_detail_cb's comment in settings_screen.cpp for
  // why. Instant cut, no animation; closer to "pop" than the slide used
  // elsewhere without hitting the same freeze.
  lv_scr_load_anim(back_scr, LV_SCR_LOAD_ANIM_NONE, 0, 0, false);
}

// Owns everything the interactive controls need to report a change: the
// current on/option/slider values (kept in sync locally so a later widget's
// callback can read what an earlier one last set) and the single onChange
// callback that PATCHes the whole sub-object. Heap-allocated, freed on
// LV_EVENT_DELETE — this screen rebuilds fresh every time a tile is tapped,
// same rationale as tasks_screen.cpp's WbTaskRowCtx.
struct WbControlCtx
{
  bool on;
  std::string optionKey;
  int sliderValue;
  WbControlChangeCallback onChange;
  lv_obj_t *value_lbl = nullptr;      // slider's live numeric readout
  lv_obj_t *preview_circle = nullptr; // big swatch at the top; null when this tile has no color options (Sounds)
  // The rest are stashed so wb_sync_control_detail_screen can push a later
  // poll's values into this exact screen without a rebuild — same reason
  // settings_screen.cpp's WbSettingsSyncCtx exists (see its comment).
  lv_obj_t *sw = nullptr;
  lv_obj_t *chip_row = nullptr;
  lv_obj_t *slider = nullptr;
};

static void wb_ctx_delete_cb(lv_event_t *e)
{
  WbControlCtx *ctx = (WbControlCtx *)lv_event_get_user_data(e);
  delete ctx;
}

// WbOptionChipCtx's own delete callback (wb_option_chip_delete_cb, below) is
// attached to each chip itself, a real child of `parent` that IS destroyed
// on every lv_obj_clean(parent) — no leak there. WbControlCtx's callback
// must NOT be attached to `parent`: this screen is a persistent singleton
// (main.cpp's detail_scr) that's only ever lv_obj_clean()'d, never
// lv_obj_delete()'d, so a callback on `parent` itself would never fire and
// every tile tap would leak one ctx. Attached to `sw` (the toggle switch)
// instead, below — a fresh child created every rebuild, same pattern
// quiet_screen.cpp's WbQuietCtx already uses correctly.

static void wb_toggle_changed_cb(lv_event_t *e)
{
  WbControlCtx *ctx = (WbControlCtx *)lv_event_get_user_data(e);
  lv_obj_t *sw = (lv_obj_t *)lv_event_get_target(e);
  ctx->on = lv_obj_has_state(sw, LV_STATE_CHECKED);
  if (ctx->onChange)
    ctx->onChange(ctx->on, ctx->optionKey, ctx->sliderValue);
}

// One option chip's own click context — which key it represents, and the
// row of sibling chips so the tapped one can be highlighted and the rest
// un-highlighted (LVGL has no built-in radio-button-group widget).
struct WbOptionChipCtx
{
  WbControlCtx *shared;
  std::string key;
  lv_obj_t *row;
  bool hasSwatch;
  uint32_t swatchHex;
};

static void wb_option_chip_delete_cb(lv_event_t *e)
{
  delete (WbOptionChipCtx *)lv_event_get_user_data(e);
}

// Applies the "selected" look to one option chip. Swatch chips (Nightlight)
// have no label — the color itself is the label, see the build function's
// comment — so selection shows as a border ring on the circle instead of a
// bg/text recolor. Text chips (Sounds) keep the original pill recolor.
static void wb_style_option_chip(lv_obj_t *chip, bool hasSwatch, bool selected)
{
  if (hasSwatch)
  {
    lv_obj_set_style_border_width(chip, selected ? 4 : 2, 0);
    lv_obj_set_style_border_color(chip, selected ? WB_COLOR_TILE_ACTIVE : WB_COLOR_CARD, 0);
  }
  else
  {
    lv_obj_set_style_bg_color(chip, selected ? WB_COLOR_TILE_ACTIVE : WB_COLOR_CARD, 0);
    lv_obj_t *lbl = lv_obj_get_child(chip, 0);
    lv_obj_set_style_text_color(lbl, selected ? lv_color_white() : WB_COLOR_INK, 0);
  }
}

static void wb_option_chip_clicked_cb(lv_event_t *e)
{
  WbOptionChipCtx *chip = (WbOptionChipCtx *)lv_event_get_user_data(e);
  lv_obj_t *tapped = (lv_obj_t *)lv_event_get_target(e);

  uint32_t n = lv_obj_get_child_count(chip->row);
  for (uint32_t i = 0; i < n; i++)
  {
    lv_obj_t *sibling = lv_obj_get_child(chip->row, i);
    WbOptionChipCtx *sib_ctx = (WbOptionChipCtx *)lv_obj_get_user_data(sibling);
    wb_style_option_chip(sibling, sib_ctx && sib_ctx->hasSwatch, sibling == tapped);
  }

  chip->shared->optionKey = chip->key;
  if (chip->hasSwatch && chip->shared->preview_circle)
    lv_obj_set_style_bg_color(chip->shared->preview_circle, lv_color_hex(chip->swatchHex), 0);
  if (chip->shared->onChange)
    chip->shared->onChange(chip->shared->on, chip->shared->optionKey, chip->shared->sliderValue);
}

static void wb_slider_released_cb(lv_event_t *e)
{
  WbControlCtx *ctx = (WbControlCtx *)lv_event_get_user_data(e);
  lv_obj_t *slider = (lv_obj_t *)lv_event_get_target(e);
  ctx->sliderValue = lv_slider_get_value(slider);
  if (ctx->onChange)
    ctx->onChange(ctx->on, ctx->optionKey, ctx->sliderValue);
}

// Live-updates the numeric readout while dragging, without firing a network
// call on every pixel of movement — that only happens on release, above.
static void wb_slider_value_changed_cb(lv_event_t *e)
{
  WbControlCtx *ctx = (WbControlCtx *)lv_event_get_user_data(e);
  lv_obj_t *slider = (lv_obj_t *)lv_event_get_target(e);
  char buf[8];
  snprintf(buf, sizeof(buf), "%d%%", (int)lv_slider_get_value(slider));
  lv_label_set_text(ctx->value_lbl, buf);
}

void wb_build_control_detail_screen(
    lv_obj_t *parent, const char *title, lv_obj_t *back_scr,
    bool on, const std::string &optionKey, int sliderValue,
    const WbControlOption *options, int optionCount, const char *sliderLabel,
    WbControlChangeCallback onChange)
{
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_all(parent, 20, 0);
  lv_obj_set_style_pad_row(parent, 24, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  WbControlCtx *ctx = new WbControlCtx{on, optionKey, sliderValue, onChange};

  // ── top bar: back button + title, same shape as the other screens' ──────
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
  lv_obj_set_style_bg_color(back_btn, WB_COLOR_CARD, 0);
  lv_obj_set_style_bg_opa(back_btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(back_btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(back_btn, 16, 0);
  lv_obj_set_style_pad_ver(back_btn, 10, 0);
  lv_obj_clear_flag(back_btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *back_lbl = lv_label_create(back_btn);
  lv_label_set_text(back_lbl, LV_SYMBOL_LEFT " Back");
  lv_obj_set_style_text_font(back_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(back_lbl, WB_COLOR_INK, 0);
  lv_obj_add_event_cb(back_btn, wb_go_back_cb, LV_EVENT_CLICKED, back_scr);

  lv_obj_t *title_lbl = lv_label_create(top);
  lv_label_set_text(title_lbl, title);
  lv_obj_set_style_text_font(title_lbl, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(title_lbl, WB_COLOR_INK, 0);

  // ── color preview (Nightlight only — Sounds' tone options have no swatch) ──
  // The user couldn't tell what "Amber"/"Peach"/etc. actually looked like
  // from text-only chips — this shows the currently-picked color at a glance,
  // updated live as chips below are tapped (see wb_option_chip_clicked_cb).
  bool anySwatch = false;
  uint32_t initialHex = 0;
  for (int i = 0; i < optionCount; i++)
  {
    if (!options[i].hasSwatch)
      continue;
    anySwatch = true;
    if (optionKey == options[i].key)
      initialHex = options[i].swatchHex;
  }
  if (anySwatch && initialHex == 0)
  {
    // optionKey didn't match any known option (e.g. a stale/unknown value) —
    // fall back to the first swatch rather than showing black.
    for (int i = 0; i < optionCount; i++)
      if (options[i].hasSwatch) { initialHex = options[i].swatchHex; break; }
  }
  if (anySwatch)
  {
    lv_obj_t *preview = lv_obj_create(parent);
    lv_obj_remove_style_all(preview);
    lv_obj_set_size(preview, 64, 64);
    lv_obj_set_style_radius(preview, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(preview, lv_color_hex(initialHex), 0);
    lv_obj_set_style_bg_opa(preview, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(preview, 3, 0);
    lv_obj_set_style_border_color(preview, WB_COLOR_CARD, 0);
    lv_obj_clear_flag(preview, LV_OBJ_FLAG_SCROLLABLE);
    ctx->preview_circle = preview;
  }

  // ── on/off toggle ─────────────────────────────────────────────────────────
  lv_obj_t *toggle_row = lv_obj_create(parent);
  lv_obj_remove_style_all(toggle_row);
  lv_obj_set_size(toggle_row, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(toggle_row, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(toggle_row, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(toggle_row, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *toggle_lbl = lv_label_create(toggle_row);
  lv_label_set_text(toggle_lbl, "On");
  lv_obj_set_style_text_font(toggle_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(toggle_lbl, WB_COLOR_INK, 0);

  lv_obj_t *sw = lv_switch_create(toggle_row);
  if (on)
    lv_obj_add_state(sw, LV_STATE_CHECKED);
  lv_obj_set_style_bg_color(sw, WB_COLOR_TILE_ACTIVE, LV_PART_INDICATOR | LV_STATE_CHECKED);
  lv_obj_add_event_cb(sw, wb_toggle_changed_cb, LV_EVENT_VALUE_CHANGED, ctx);
  lv_obj_add_event_cb(sw, wb_ctx_delete_cb, LV_EVENT_DELETE, ctx);
  ctx->sw = sw;

  // ── option chips (tone/color — whichever this tile is for) ─────────────────
  if (optionCount > 0)
  {
    lv_obj_t *chip_row = lv_obj_create(parent);
    lv_obj_remove_style_all(chip_row);
    lv_obj_set_size(chip_row, lv_pct(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(chip_row, LV_FLEX_FLOW_ROW_WRAP);
    lv_obj_set_style_pad_column(chip_row, 10, 0);
    lv_obj_set_style_pad_row(chip_row, 10, 0);
    lv_obj_clear_flag(chip_row, LV_OBJ_FLAG_SCROLLABLE);
    ctx->chip_row = chip_row;

    for (int i = 0; i < optionCount; i++)
    {
      bool selected = optionKey == options[i].key;
      lv_obj_t *chip = lv_obj_create(chip_row);
      lv_obj_remove_style_all(chip);
      lv_obj_clear_flag(chip, LV_OBJ_FLAG_SCROLLABLE);

      if (options[i].hasSwatch)
      {
        // Color IS the label here — the user couldn't tell what a named
        // color ("Amber", "Peach"...) actually looked like before a swatch
        // was added; now that the color shows, the name is redundant, so
        // this is just a big tappable circle with a selection ring, no text.
        lv_obj_set_size(chip, 44, 44);
        lv_obj_set_style_radius(chip, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_color(chip, lv_color_hex(options[i].swatchHex), 0);
        lv_obj_set_style_bg_opa(chip, LV_OPA_COVER, 0);
      }
      else
      {
        lv_obj_set_size(chip, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(chip, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(chip, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_pad_hor(chip, 16, 0);
        lv_obj_set_style_pad_ver(chip, 10, 0);
        lv_obj_set_flex_flow(chip, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(chip, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

        lv_obj_t *chip_lbl = lv_label_create(chip);
        lv_label_set_text(chip_lbl, options[i].label);
        lv_obj_set_style_text_font(chip_lbl, &lv_font_montserrat_14, 0);
      }
      wb_style_option_chip(chip, options[i].hasSwatch, selected);

      WbOptionChipCtx *chip_ctx = new WbOptionChipCtx{ctx, options[i].key, chip_row, options[i].hasSwatch, options[i].swatchHex};
      lv_obj_add_event_cb(chip, wb_option_chip_clicked_cb, LV_EVENT_CLICKED, chip_ctx);
      lv_obj_add_event_cb(chip, wb_option_chip_delete_cb, LV_EVENT_DELETE, chip_ctx);
      // wb_sync_control_detail_screen's way to re-derive each chip's key/
      // swatch without re-deriving from the raw WbControlOption array.
      lv_obj_set_user_data(chip, chip_ctx);
    }
  }

  // ── slider (volume/brightness — whichever this tile is for) ────────────────
  lv_obj_t *slider_hdr = lv_obj_create(parent);
  lv_obj_remove_style_all(slider_hdr);
  lv_obj_set_size(slider_hdr, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(slider_hdr, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(slider_hdr, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(slider_hdr, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *slider_lbl = lv_label_create(slider_hdr);
  lv_label_set_text(slider_lbl, sliderLabel);
  lv_obj_set_style_text_font(slider_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(slider_lbl, WB_COLOR_INK, 0);

  char value_buf[8];
  snprintf(value_buf, sizeof(value_buf), "%d%%", sliderValue);
  lv_obj_t *value_lbl = lv_label_create(slider_hdr);
  lv_label_set_text(value_lbl, value_buf);
  lv_obj_set_style_text_font(value_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(value_lbl, WB_COLOR_GOLD, 0);
  ctx->value_lbl = value_lbl;

  lv_obj_t *slider = lv_slider_create(parent);
  lv_obj_set_size(slider, lv_pct(100), 20);
  lv_slider_set_range(slider, 0, 100);
  lv_slider_set_value(slider, sliderValue, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(slider, WB_COLOR_TILE_ACTIVE, LV_PART_INDICATOR);
  lv_obj_set_style_bg_color(slider, WB_COLOR_TILE_ACTIVE, LV_PART_KNOB);
  lv_obj_add_event_cb(slider, wb_slider_value_changed_cb, LV_EVENT_VALUE_CHANGED, ctx);
  lv_obj_add_event_cb(slider, wb_slider_released_cb, LV_EVENT_RELEASED, ctx);
  ctx->slider = slider;

  lv_obj_set_user_data(parent, ctx); // wb_sync_control_detail_screen's way back to this ctx
}

void wb_sync_control_detail_screen(lv_obj_t *parent, bool on, const std::string &optionKey, int sliderValue)
{
  WbControlCtx *ctx = (WbControlCtx *)lv_obj_get_user_data(parent);
  if (!ctx)
    return; // not built yet

  ctx->on = on;
  ctx->optionKey = optionKey;
  ctx->sliderValue = sliderValue;

  if (ctx->sw)
  {
    if (on)
      lv_obj_add_state(ctx->sw, LV_STATE_CHECKED);
    else
      lv_obj_remove_state(ctx->sw, LV_STATE_CHECKED);
  }

  if (ctx->chip_row)
  {
    uint32_t n = lv_obj_get_child_count(ctx->chip_row);
    for (uint32_t i = 0; i < n; i++)
    {
      lv_obj_t *chip = lv_obj_get_child(ctx->chip_row, i);
      WbOptionChipCtx *chip_ctx = (WbOptionChipCtx *)lv_obj_get_user_data(chip);
      if (!chip_ctx)
        continue;
      bool selected = chip_ctx->key == optionKey;
      wb_style_option_chip(chip, chip_ctx->hasSwatch, selected);
      if (selected && chip_ctx->hasSwatch && ctx->preview_circle)
        lv_obj_set_style_bg_color(ctx->preview_circle, lv_color_hex(chip_ctx->swatchHex), 0);
    }
  }

  if (ctx->slider)
    lv_slider_set_value(ctx->slider, sliderValue, LV_ANIM_OFF);
  if (ctx->value_lbl)
  {
    char buf[8];
    snprintf(buf, sizeof(buf), "%d%%", sliderValue);
    lv_label_set_text(ctx->value_lbl, buf);
  }
}
