#include "bedtime_screen.h"
#include <cstdio>
#include <cstring>

#define WB_BEDTIME_BG lv_color_hex(0x05050A)
#define WB_BEDTIME_INK lv_color_hex(0xF5EFE1)
#define WB_BEDTIME_MUTED lv_color_hex(0x9AA3C4)

// warn/wake use fixed system colors (not the parent's chosen nightlight
// color) — they're a status signal, not an aesthetic choice. WB_WARN_HEX
// deliberately doesn't reuse any of WB_BEDTIME_COLORS' six nightlight
// options below. WB_WAKE_HEX matches settings_screen.cpp/control_detail_
// screen.cpp's WB_COLOR_DONE green (same "done"/positive meaning).
#define WB_WARN_HEX 0xE8B23D
#define WB_WAKE_HEX 0x4C9A6A

// Color key -> hex, for the plain nightlight preview. Same six keys/values
// as settings_screen.cpp's WB_NIGHT_OPTIONS (itself copied verbatim from
// apps/web's NIGHT_COLORS) — duplicated here rather than shared, same
// convention as this app's other small per-file reference tables.
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

WbGlowSpec wb_glow_spec_for_device_state(const WbDeviceState &state)
{
  // Quiet time wins if both are somehow active at once — see this file's
  // header comment.
  if (!state.quiet.active)
  {
    if (state.wakeLight.state == WbWakeLightState::Sleep)
      return {wb_bedtime_hex(state.night.color), state.night.brightness, nullptr, false, true, -1, -1};
    if (state.wakeLight.state == WbWakeLightState::Warn)
      return {WB_WARN_HEX, 80, "Almost time to wake up", false, true, state.wakeLight.wakeAtHour, state.wakeLight.wakeAtMinute};
    if (state.wakeLight.state == WbWakeLightState::Wake)
      return {WB_WAKE_HEX, 80, "Time to get up!", true, true, state.wakeLight.wakeAtHour, state.wakeLight.wakeAtMinute};
  }
  // Plain preview — what the Bedtime tile always showed, before the wake-light schedule existed.
  return {wb_bedtime_hex(state.night.color), state.night.brightness, nullptr, true, false, -1, -1};
}

// A single flat full-screen fill — went through a concentric-circles
// version (looked like an off-center blob) and a gradient-band version
// (looked "weird"/murky, per direct feedback on two rounds of screenshots)
// before landing here. The color itself carries brightness (blended toward
// black — see wb_apply_glow) rather than any spatial falloff, so a dim
// nightlight reads as a darker flat color, not a smaller/fainter one.
//
// Owns the fill + optional label/until text so wb_sync_bedtime_screen can
// push a later spec change into an already-showing screen without a
// rebuild. Attached to a genuine per-rebuild child (see
// wb_build_bedtime_screen), not `parent` — same leak-avoidance rule as
// every other screen's sync ctx in this app.
struct WbBedtimeCtx
{
  lv_obj_t *glow_bg;
  lv_obj_t *label_lbl;  // null if this build had no label (sleep / the plain preview)
  lv_obj_t *until_lbl;  // null if this build had no wake time to show
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

// Brightness (0-100) scales how saturated the fill reads — a dim nightlight
// should look dim (blended toward black) here too, not just a fainter smear
// of the same full-strength color. Applies uniformly to every spec (sleep,
// warn, wake, the plain preview) — nothing here is status-vs-ambient
// specific anymore; only whether a label chip is shown differs.
static void wb_apply_glow(WbBedtimeCtx *ctx, const WbGlowSpec &spec)
{
  float b = (spec.brightness <= 0 ? 5 : spec.brightness) / 100.0f; // never fully invisible, even at a very low setting
  lv_color_t base = lv_color_hex(spec.colorHex);
  // Blend toward black for dimness rather than toward transparent — keeps
  // the color saturated/warm instead of washing it out. coreMix ranges
  // 90 (dim) - 255 (full brightness).
  uint8_t coreMix = (uint8_t)(90 + 165 * b);
  lv_color_t coreColor = lv_color_mix(base, lv_color_black(), coreMix);
  lv_obj_set_style_bg_color(ctx->glow_bg, coreColor, 0);

  if (ctx->label_lbl)
    lv_label_set_text(ctx->label_lbl, spec.label ? spec.label : "");
  if (ctx->until_lbl)
  {
    if (spec.wakeAtHour >= 0)
    {
      int h12 = spec.wakeAtHour % 12;
      if (h12 == 0)
        h12 = 12;
      char buf[32];
      snprintf(buf, sizeof(buf), "Until %d:%02d %s", h12, spec.wakeAtMinute, spec.wakeAtHour < 12 ? "AM" : "PM");
      lv_label_set_text(ctx->until_lbl, buf);
    }
    else
    {
      lv_label_set_text(ctx->until_lbl, "");
    }
  }
}

static lv_obj_t *wb_make_glow_bg(lv_obj_t *parent)
{
  lv_obj_t *bg = lv_obj_create(parent);
  lv_obj_remove_style_all(bg);
  lv_obj_set_style_bg_opa(bg, LV_OPA_COVER, 0);
  lv_obj_set_size(bg, lv_pct(100), lv_pct(100));
  lv_obj_clear_flag(bg, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(bg, LV_OBJ_FLAG_CLICKABLE);
  return bg;
}

void wb_build_bedtime_screen(lv_obj_t *parent, const WbGlowSpec &spec, lv_obj_t *back_scr)
{
  lv_obj_set_style_bg_color(parent, WB_BEDTIME_BG, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  WbBedtimeCtx *ctx = new WbBedtimeCtx();
  ctx->glow_bg = wb_make_glow_bg(parent);
  ctx->label_lbl = nullptr;
  ctx->until_lbl = nullptr;

  if (spec.label)
  {
    // A solid dark chip behind the label, not a gradient — reads clearly
    // against the flat colored background without relying on a fade to
    // separate it.
    lv_obj_t *box = lv_obj_create(parent);
    lv_obj_remove_style_all(box);
    lv_obj_set_style_bg_color(box, lv_color_hex(0x14140F), 0);
    lv_obj_set_style_bg_opa(box, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(box, 16, 0);
    lv_obj_set_style_pad_hor(box, 24, 0);
    lv_obj_set_style_pad_ver(box, 14, 0);
    lv_obj_set_flex_flow(box, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(box, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(box, 6, 0);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(box, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_align(box, LV_ALIGN_TOP_MID, 0, 50);

    lv_obj_t *label_lbl = lv_label_create(box);
    lv_obj_set_style_text_font(label_lbl, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(label_lbl, WB_BEDTIME_INK, 0);
    ctx->label_lbl = label_lbl;

    lv_obj_t *until_lbl = lv_label_create(box);
    lv_obj_set_style_text_font(until_lbl, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(until_lbl, WB_BEDTIME_MUTED, 0);
    ctx->until_lbl = until_lbl;
  }

  // No back button, no gesture handler, nothing clickable below that
  // navigates anywhere, when NOT exitable — this is the actual "not
  // exitable" mechanism, same as quiet_screen.cpp.
  if (spec.exitable)
  {
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
  }
  else
  {
    // No clickable child exists to own the ctx's delete callback in this
    // branch — attach it to a genuine (invisible, non-interactive) child
    // instead of `parent` itself (the persistent singleton), same rule as
    // every other screen's sync ctx.
    lv_obj_add_event_cb(ctx->glow_bg, wb_bedtime_ctx_delete_cb, LV_EVENT_DELETE, ctx);
  }

  wb_apply_glow(ctx, spec);
  lv_obj_set_user_data(parent, ctx); // wb_sync_bedtime_screen's way back to this ctx
}

void wb_sync_bedtime_screen(lv_obj_t *parent, const WbGlowSpec &spec)
{
  WbBedtimeCtx *ctx = (WbBedtimeCtx *)lv_obj_get_user_data(parent);
  if (!ctx)
    return; // not built yet
  wb_apply_glow(ctx, spec);
}
