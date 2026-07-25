// Baked icon set — line-icon glyphs from the "Waffled Buddy" mock (claude.ai/design
// project fb5fb8fb-ed6b-4edd-a02f-bfedc8035966, "Waffled Buddy icons/*.svg"), rasterized
// and packed as LVGL 9 A8 (alpha-only) lv_image_dsc_t constants — see tools/icons/README.md
// for how to regenerate. A8 images carry no color of their own: LVGL's software renderer
// fills the shape using the lv_image object's style_image_recolor color at draw time (see
// lv_draw_sw_img.c's `cf == LV_COLOR_FORMAT_A8` branch), so one baked icon can be tinted
// to match whichever tile/screen it's placed on — set style_image_recolor (and
// style_image_recolor_opa to LV_OPA_COVER, though the A8 path doesn't actually check opa)
// before use.
#pragma once

#ifdef LV_LVGL_H_INCLUDE_SIMPLE
#include "lvgl.h"
#else
#include "lvgl.h"
#endif

#ifdef __cplusplus
extern "C" {
#endif

extern const lv_image_dsc_t wb_icon_sun_64;      // Morning routine tile (32->48->64 on request, now centered+larger in the tile)
extern const lv_image_dsc_t wb_icon_sunhigh_64;  // Afternoon routine tile (32->48->64, same request)
extern const lv_image_dsc_t wb_icon_moon_64;     // Evening routine tile (32->48->64, same request)
extern const lv_image_dsc_t wb_icon_moon_40;     // Nightlight grown-up-control tile
extern const lv_image_dsc_t wb_icon_moon_solid_128; // Quiet-time screen — same crescent
                                                     // path as wb_icon_moon_*, baked FILLED
                                                     // (tools/icons/moon_solid.svg) instead of
                                                     // outline-stroked, at a bigger size for a
                                                     // solid centerpiece glyph rather than a
                                                     // small tile icon — recolor gold at use.
extern const lv_image_dsc_t wb_icon_broom_48;    // Chores bar (32->48, same request)
extern const lv_image_dsc_t wb_icon_star_18;     // Stars badges/pills
extern const lv_image_dsc_t wb_icon_gear_24;     // Settings gear button
extern const lv_image_dsc_t wb_icon_sound_40;    // Sounds grown-up-control tile
extern const lv_image_dsc_t wb_icon_timer_40;    // Set a timer grown-up-control tile
extern const lv_image_dsc_t wb_icon_bed_40;      // Bedtime grown-up-control tile
extern const lv_image_dsc_t wb_icon_check_18;    // Spare: checkmark, not yet wired anywhere
extern const lv_image_dsc_t wb_icon_close_18;    // Spare: close/X, not yet wired anywhere
extern const lv_image_dsc_t wb_icon_back_18;     // Spare: back chevron, not yet wired anywhere

// The Waffled logo (a higher-res version of apps/web/public/logo.png — see
// tools/logo/README.md) — full-color **ARGB8888** with a real alpha channel
// (chroma-keyed transparent background, not the flat opaque RGB565 this used
// to be), so it sits directly on whichever screen's own background instead of
// showing a box. No LVGL-recolor trick like the A8 icons above — it's the
// real multi-color mark.
extern const lv_image_dsc_t wb_logo_96;  // Onboarding (onboarding_screen.cpp) + WiFi "Connecting..." (wifi_screen.cpp)
extern const lv_image_dsc_t wb_logo_40;  // Small mark next to the home screen's clock
extern const lv_image_dsc_t wb_logo_160; // Boot screen (main.cpp) — bigger, on request

// A sad, unplugged waffle-iron mascot (broken WiFi symbol) — same full-color
// ARGB8888-with-real-alpha treatment as the logo above, baked from
// tools/mascot/waffled-down-source.png. offline_screen.cpp's "can't reach
// the server" state.
extern const lv_image_dsc_t wb_offline_mascot_320;

#ifdef __cplusplus
}
#endif
