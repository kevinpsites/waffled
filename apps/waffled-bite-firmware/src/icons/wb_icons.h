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

extern const lv_image_dsc_t wb_icon_sun_32;      // Morning routine tile
extern const lv_image_dsc_t wb_icon_sunhigh_32;  // Afternoon routine tile
extern const lv_image_dsc_t wb_icon_moon_32;     // Evening routine tile
extern const lv_image_dsc_t wb_icon_moon_40;     // Nightlight grown-up-control tile
extern const lv_image_dsc_t wb_icon_broom_32;    // Chores bar
extern const lv_image_dsc_t wb_icon_star_18;     // Stars badges/pills
extern const lv_image_dsc_t wb_icon_gear_24;     // Settings gear button
extern const lv_image_dsc_t wb_icon_sound_40;    // Sounds grown-up-control tile
extern const lv_image_dsc_t wb_icon_timer_40;    // Set a timer grown-up-control tile
extern const lv_image_dsc_t wb_icon_bed_40;      // Bedtime grown-up-control tile
extern const lv_image_dsc_t wb_icon_check_18;    // Spare: checkmark, not yet wired anywhere
extern const lv_image_dsc_t wb_icon_close_18;    // Spare: close/X, not yet wired anywhere
extern const lv_image_dsc_t wb_icon_back_18;     // Spare: back chevron, not yet wired anywhere

#ifdef __cplusplus
}
#endif
