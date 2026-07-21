// The device's home screen: greeting + stars, the four routine tiles
// (morning/afternoon/evening/chores), and the bottom dock (sounds/nightlight/
// timer/bedtime). Mirrors the mockup's buddy-device.js `home()`.
#pragma once

#include <lvgl.h>
#include "../wb_state.h"

// Builds the screen onto `parent` (pass lv_scr_act()) from `state`. Safe to call
// again later with fresh state once networking exists — for now it's built once
// with wb_mock_state() and never updates, since there's nothing yet to poll.
void wb_build_home_screen(lv_obj_t *parent, const WbDeviceState &state);
