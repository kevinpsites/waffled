// The display/touch HAL, as a LovyanGFX `LGFX` device — one class for the real
// ELECROW CrowPanel Basic 7" (ESP32-S3, RGB-parallel panel + GT911 touch) and one
// for the desktop simulator (LovyanGFX's own SDL2 panel). `main.cpp` and every
// screen only ever call LovyanGFX's device-agnostic API (lcd.width()/height()/
// pushImageDMA()/getTouch()), so app code never branches on target — only this
// file does.
//
// The hardware pin mapping, RGB bus timing, and touch wiring below are copied
// verbatim from Elecrow's own working example for this exact board (not derived —
// sourced from their public repo, since getting RGB-panel timing wrong is the kind
// of thing that "looks plausible" but doesn't actually drive the panel):
// github.com/Elecrow-RD/CrowPanel-7.0-HMI-ESP32-Display-800x480,
// example/V3.0/Arduino/Course/LVGL_Arduino7.0/{LVGL_Arduino7.0.ino,touch.h}
// UNVERIFIED ON REAL HARDWARE — the board hasn't arrived yet. Confirm on first
// bring-up before trusting this beyond "it's what the vendor shipped."
#pragma once

#include <LovyanGFX.hpp>

#if defined(ARDUINO)
// ── esp32-s3 target: the real panel ─────────────────────────────────────────
#include <lgfx/v1/platforms/esp32s3/Bus_RGB.hpp>
#include <lgfx/v1/platforms/esp32s3/Panel_RGB.hpp>

class LGFX : public lgfx::LGFX_Device
{
public:
  lgfx::Bus_RGB _bus_instance;
  lgfx::Panel_RGB _panel_instance;

  LGFX(void)
  {
    {
      auto cfg = _bus_instance.config();
      cfg.panel = &_panel_instance;

      // clang-format off
      cfg.pin_d0  = GPIO_NUM_15; // B0
      cfg.pin_d1  = GPIO_NUM_7;  // B1
      cfg.pin_d2  = GPIO_NUM_6;  // B2
      cfg.pin_d3  = GPIO_NUM_5;  // B3
      cfg.pin_d4  = GPIO_NUM_4;  // B4

      cfg.pin_d5  = GPIO_NUM_9;  // G0
      cfg.pin_d6  = GPIO_NUM_46; // G1
      cfg.pin_d7  = GPIO_NUM_3;  // G2
      cfg.pin_d8  = GPIO_NUM_8;  // G3
      cfg.pin_d9  = GPIO_NUM_16; // G4
      cfg.pin_d10 = GPIO_NUM_1;  // G5

      cfg.pin_d11 = GPIO_NUM_14; // R0
      cfg.pin_d12 = GPIO_NUM_21; // R1
      cfg.pin_d13 = GPIO_NUM_47; // R2
      cfg.pin_d14 = GPIO_NUM_48; // R3
      cfg.pin_d15 = GPIO_NUM_45; // R4
      // clang-format on

      cfg.pin_henable = GPIO_NUM_41;
      cfg.pin_vsync = GPIO_NUM_40;
      cfg.pin_hsync = GPIO_NUM_39;
      cfg.pin_pclk = GPIO_NUM_0;
      cfg.freq_write = 15000000;

      cfg.hsync_polarity = 0;
      cfg.hsync_front_porch = 40;
      cfg.hsync_pulse_width = 48;
      cfg.hsync_back_porch = 40;

      cfg.vsync_polarity = 0;
      cfg.vsync_front_porch = 1;
      cfg.vsync_pulse_width = 31;
      cfg.vsync_back_porch = 13;

      cfg.pclk_active_neg = 1;
      cfg.de_idle_high = 0;
      cfg.pclk_idle_high = 0;

      _bus_instance.config(cfg);
    }
    {
      auto cfg = _panel_instance.config();
      cfg.memory_width = 800;
      cfg.memory_height = 480;
      cfg.panel_width = 800;
      cfg.panel_height = 480;
      cfg.offset_x = 0;
      cfg.offset_y = 0;
      _panel_instance.config(cfg);
    }
    _panel_instance.setBus(&_bus_instance);
    setPanel(&_panel_instance);
  }
};

// Backlight PWM pin (ledc), separate from the LGFX bus config above.
#define WB_BACKLIGHT_PIN 2
// Touch (GT911, I2C) shares a bus with the onboard DHT20 + PCA9557 — SDA/SCL only,
// no INT/RST wired on this board variant. Handled by a separate library (TAMC_GT911)
// rather than LovyanGFX's own touch support, matching the vendor example — LovyanGFX
// wasn't confirmed to have a ready-made profile for this touch wiring.
#define WB_TOUCH_SDA 19
#define WB_TOUCH_SCL 20

#else
// ── native target: LovyanGFX's own SDL2 panel, sized/scaled like the real device.
// Mirrors LovyanGFX's own LGFX_AutoDetect_sdl.hpp (memory/panel size + setScaling +
// the init_impl(use_reset=false) override) rather than guessing at Panel_sdl's API. ──
#include <lgfx/v1/platforms/sdl/Panel_sdl.hpp>

class LGFX : public lgfx::LGFX_Device
{
public:
  lgfx::Panel_sdl _panel_instance;

  bool init_impl(bool /*use_reset*/, bool use_clear) override { return lgfx::LGFX_Device::init_impl(false, use_clear); }

  LGFX(void)
  {
    auto cfg = _panel_instance.config();
    cfg.memory_width = 800;
    cfg.panel_width = 800;
    cfg.memory_height = 480;
    cfg.panel_height = 480;
    _panel_instance.config(cfg);
    _panel_instance.setScaling(1, 1);
    setPanel(&_panel_instance);
  }
};
#endif
