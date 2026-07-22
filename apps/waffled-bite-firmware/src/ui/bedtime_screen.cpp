#include "bedtime_screen.h"
#include <cstring>

#define WB_BEDTIME_BG lv_color_hex(0x05050A)

// Color key -> hex. Same six keys/values as settings_screen.cpp's
// WB_NIGHT_OPTIONS (itself copied verbatim from apps/web's NIGHT_COLORS) —
// duplicated here rather than shared, same convention as this app's other
// small per-file reference tables (see WB_NIGHT_OPTIONS' own comment).
struct WbColorEntry
{
  const char *key;
  uint32_t hex;
};
static const WbColorEntry WB_BEDTIME_COLORS[] = {
    {"amber", 0xF0A94B}, {"peach", 0xF28E6B}, {"blush", 0xEF7FA6},
    {"lilac", 0xA98BE8}, {"ocean", 0x5AA7E0}, {"mint", 0x5BC98B},
};

static uint32_t wb_bedtime_hex(const char *colorKey)
{
  for (const auto &c : WB_BEDTIME_COLORS)
    if (strcmp(c.key, colorKey) == 0)
      return c.hex;
  return WB_BEDTIME_COLORS[0].hex; // unknown/stale key — fall back rather than show black
}

// Owns the three glow rings + close button so wb_sync_bedtime_screen can
// push a later color/brightness change into an already-showing screen
// without a rebuild. Attached to `close_btn` (a genuine per-rebuild child),
// not `parent` (the persistent singleton) — same leak-avoidance rule as
// every other screen's sync ctx in this app.
struct WbBedtimeCtx
{
  lv_obj_t *glow_outer;
  lv_obj_t *glow_mid;
  lv_obj_t *glow_core;
};

static void wb_bedtime_ctx_delete_cb(lv_event_t *e)
{
  delete (WbBedtimeCtx *)lv_event_get_user_data(e);
}

static void wb_bedtime_close_cb(lv_event_t *e)
{
  lv_obj_t *back_scr = (lv_obj_t *)lv_event_get_user_data(e);
  lv_scr_load_anim(back_scr, LV_SCR_LOAD_ANIM_NONE, 0, 0, false); // NOT a fade — see settings_screen.cpp's wb_open_detail_cb
}

// Brightness (0-100) scales both how big and how strong the glow reads —
// a dim nightlight should look dim here too, not just tint the same glow.
static void wb_apply_glow(WbBedtimeCtx *ctx, uint32_t hex, int brightness)
{
  float b = (brightness <= 0 ? 5 : brightness) / 100.0f; // never fully invisible, even at a very low setting
  lv_color_t color = lv_color_hex(hex);

  lv_obj_set_style_bg_color(ctx->glow_outer, color, 0);
  lv_obj_set_style_bg_opa(ctx->glow_outer, (lv_opa_t)(60 * b), 0);
  int outerSize = (int)(520 * (0.7f + 0.3f * b));
  lv_obj_set_size(ctx->glow_outer, outerSize, outerSize);

  lv_obj_set_style_bg_color(ctx->glow_mid, color, 0);
  lv_obj_set_style_bg_opa(ctx->glow_mid, (lv_opa_t)(120 * b), 0);
  int midSize = (int)(300 * (0.7f + 0.3f * b));
  lv_obj_set_size(ctx->glow_mid, midSize, midSize);

  lv_obj_set_style_bg_color(ctx->glow_core, color, 0);
  lv_obj_set_style_bg_opa(ctx->glow_core, (lv_opa_t)(220 * b), 0);
  int coreSize = (int)(140 * (0.7f + 0.3f * b));
  lv_obj_set_size(ctx->glow_core, coreSize, coreSize);
}

static lv_obj_t *wb_make_glow_ring(lv_obj_t *parent)
{
  lv_obj_t *ring = lv_obj_create(parent);
  lv_obj_remove_style_all(ring);
  lv_obj_set_style_radius(ring, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_opa(ring, LV_OPA_COVER, 0);
  lv_obj_clear_flag(ring, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(ring, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_align(ring, LV_ALIGN_BOTTOM_MID, 0, 120); // glow's brightest point sits low, per the reference mockup
  return ring;
}

void wb_build_bedtime_screen(lv_obj_t *parent, const WbNightSettings &night, lv_obj_t *back_scr)
{
  lv_obj_set_style_bg_color(parent, WB_BEDTIME_BG, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  WbBedtimeCtx *ctx = new WbBedtimeCtx();
  ctx->glow_outer = wb_make_glow_ring(parent);
  ctx->glow_mid = wb_make_glow_ring(parent);
  ctx->glow_core = wb_make_glow_ring(parent);
  wb_apply_glow(ctx, wb_bedtime_hex(night.color), night.brightness);

  lv_obj_t *close_btn = lv_obj_create(parent);
  lv_obj_remove_style_all(close_btn);
  lv_obj_set_size(close_btn, 44, 44);
  lv_obj_set_style_bg_color(close_btn, lv_color_hex(0x2A2A32), 0);
  lv_obj_set_style_bg_opa(close_btn, LV_OPA_70, 0);
  lv_obj_set_style_radius(close_btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_flex_flow(close_btn, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(close_btn, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(close_btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_align(close_btn, LV_ALIGN_TOP_RIGHT, -20, 20);
  lv_obj_t *close_lbl = lv_label_create(close_btn);
  lv_label_set_text(close_lbl, LV_SYMBOL_CLOSE);
  lv_obj_set_style_text_color(close_lbl, lv_color_white(), 0);
  lv_obj_add_event_cb(close_btn, wb_bedtime_close_cb, LV_EVENT_CLICKED, back_scr);
  lv_obj_add_event_cb(close_btn, wb_bedtime_ctx_delete_cb, LV_EVENT_DELETE, ctx);

  lv_obj_set_user_data(parent, ctx); // wb_sync_bedtime_screen's way back to this ctx
}

void wb_sync_bedtime_screen(lv_obj_t *parent, const WbNightSettings &night)
{
  WbBedtimeCtx *ctx = (WbBedtimeCtx *)lv_obj_get_user_data(parent);
  if (!ctx)
    return; // not built yet
  wb_apply_glow(ctx, wb_bedtime_hex(night.color), night.brightness);
}
