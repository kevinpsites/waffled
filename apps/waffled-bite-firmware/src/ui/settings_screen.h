// The "Grown-up controls" screen: back-to-home button, title, a locked chip,
// and a row of control tiles (Sounds/Nightlight/Set a timer/Bedtime).
// Mirrors the mockup's buddy-phone.js grown-up-controls page.
#pragma once

#include <lvgl.h>
#include "../wb_state.h"

// Builds the screen onto `parent` (a fresh lv_obj_create(NULL)). `home_scr`
// is the screen the back button navigates to.
void wb_build_settings_screen(lv_obj_t *parent, const WbDeviceState &state, lv_obj_t *home_scr);
