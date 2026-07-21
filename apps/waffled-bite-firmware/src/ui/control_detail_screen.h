// A shared "on/off + pick one of N options + a 0-100 slider" detail screen.
// The Sounds and Nightlight tiles on the Grown-up controls screen are the
// same shape underneath (toggle, tone/color picker, volume/brightness
// slider) — a dedicated screen per tile would just be this file copy-pasted
// twice with different labels, so it's parameterized instead.
#pragma once

#include <lvgl.h>
#include <functional>
#include <string>

struct WbControlOption
{
  const char *key;            // sent to onChange / the PATCH body, e.g. "ocean"
  const char *label;          // shown on the chip, e.g. "Ocean waves"
  bool hasSwatch = false;     // true for color options (Nightlight) — Sounds tones leave this false
  uint32_t swatchHex = 0;     // 0xRRGGBB, only meaningful when hasSwatch is true
};

// Optimistic-update contract, same shape as tasks_screen.h's
// WbTaskCompleteCallback: return true only on a confirmed 200. Always
// describes the FULL desired sub-object (on + option + slider value), never
// a diff — this mirrors the device settings PATCH route's per-key-merge
// semantics (main.cpp sends {sound:{...}} or {night:{...}} whole).
using WbControlChangeCallback = std::function<bool(bool on, const std::string &optionKey, int sliderValue)>;

// Builds onto `parent` (a fresh/cleaned screen object, same convention as
// the other screens — caller does the lv_obj_clean before calling this).
// `options`/`optionCount` describe the picker row; `sliderLabel` is shown
// above the slider (e.g. "Volume" / "Brightness").
void wb_build_control_detail_screen(
    lv_obj_t *parent, const char *title, lv_obj_t *back_scr,
    bool on, const std::string &optionKey, int sliderValue,
    const WbControlOption *options, int optionCount, const char *sliderLabel,
    WbControlChangeCallback onChange);
