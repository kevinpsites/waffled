// LVGL's tick source (LV_TICK_CUSTOM in lv_conf.h) needs one expression that works
// on both build targets, and this header gets #included from LVGL's own plain-C
// sources — so it must declare a pure C-callable function, not inline C++ (the
// implementation, which needs <chrono> on the native target, lives in
// wb_tick_hal.cpp instead).
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t wb_tick_ms(void);

#ifdef __cplusplus
}
#endif
