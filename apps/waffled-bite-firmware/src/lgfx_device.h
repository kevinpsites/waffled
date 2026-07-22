// The display/touch HAL, as a LovyanGFX `LGFX` device — one class for the real
// ELECROW CrowPanel Basic 7" (ESP32-S3, RGB-parallel panel + GT911 touch) and one
// for the desktop simulator (LovyanGFX's own SDL2 panel). `main.cpp` and every
// screen only ever call LovyanGFX's device-agnostic API (lcd.width()/height()/
// pushImageDMA()/getTouch()), so app code never branches on target — only this
// file does.
//
// Pin mapping, DSI bus/DPI timing, and touch wiring below are copied verbatim
// from Elecrow's own working example for this exact board (not derived —
// sourced from their public repo, matching the "verify against the vendor's
// real source, not guessed" rule this codebase already learned the hard way
// on the earlier ESP32-S3 config):
// github.com/Elecrow-RD/CrowPanel-Advanced-7inch-ESP32-P4-HMI-AI-Display-1024x600-IPS-Touch-Screen,
// example/V1.2/Arduino_Code/Lesson07-Turn_on_the_screen/{board_config.h,esp_panel_board_custom_conf.h}.
//
// IMPORTANT DEVIATION FROM THE VENDOR'S OWN EXAMPLE, flagged for whoever
// picks this up at real hardware bring-up: Elecrow's own proven Arduino
// example does NOT use LovyanGFX at all — it uses Espressif's own
// `ESP32_Display_Panel` library (+ `ESP32_IO_Expander`) bundled with LVGL
// 8.3.11 (their repo's own top-level spec table claims LVGL 9.2, but the
// actual working example code — filenames literally say `lvgl_v8_port.cpp`
// — is v8; the table is stale, trust the code, not the table). This file
// instead uses LovyanGFX's Bus_DSI + Panel_EK79007 (a real, non-experimental
// class — added via an actual LovyanGFX PR, its init sequence lifted
// directly from Espressif's own esp_lcd_ek79007 component) to keep the same
// LGFX_Device abstraction main.cpp/native already share, rather than fork
// the whole app onto a second, unrelated display-driver architecture. This
// is a deliberate choice to preserve the existing codebase shape, not proof
// it's the safer bet for first bring-up — if this doesn't drive the real
// panel, the vendor's own ESP32_Display_Panel-based approach (their
// Lesson07 example) is the documented, vendor-proven fallback.
// UNVERIFIED ON REAL HARDWARE — the board hasn't arrived yet.
#pragma once

#include <LovyanGFX.hpp>

#if defined(ARDUINO)
// ── esp32-p4 target: the real panel (ELECROW CrowPanel Advanced 7", MIPI-DSI) ──
#include <lgfx/v1/platforms/esp32p4/Bus_DSI.hpp>
#include <lgfx/v1/platforms/esp32p4/Panel_EK79007.hpp>

class LGFX : public lgfx::LGFX_Device
{
public:
  lgfx::Bus_DSI _bus_instance;
  lgfx::Panel_EK79007 _panel_instance;

  LGFX(void)
  {
    {
      auto cfg = _bus_instance.config();
      cfg.lane_num = 2;      // ESP_PANEL_BOARD_LCD_MIPI_DSI_LANE_NUM
      cfg.lane_mbps = 1000;  // ESP_PANEL_BOARD_LCD_MIPI_DSI_LANE_RATE_MBPS
      // DSI PHY power: Elecrow's own config sets
      // ESP_PANEL_BOARD_LCD_MIPI_PHY_LDO_ID to -1 ("not used" — this board's
      // DSI PHY isn't powered through the P4's internal LDO channel), but
      // Bus_DSI::config_t has no "disabled" value for ldo_chan_id, only a
      // default channel (3). Left at the LovyanGFX default here —
      // UNVERIFIED whether that conflicts with how this board actually
      // powers the DSI PHY; needs real hardware to resolve either way.
      _bus_instance.config(cfg);
    }
    {
      auto cfg = _panel_instance.config();
      cfg.memory_width = 1024;
      cfg.memory_height = 600;
      cfg.panel_width = 1024;
      cfg.panel_height = 600;
      cfg.pin_rst = 41; // LCD_GPIO_RST
      _panel_instance.config(cfg);

      auto cfg_detail = _panel_instance.config_detail();
      cfg_detail.dpi_freq_mhz = 51;       // LCD_CLK_MHZ
      cfg_detail.hsync_pulse_width = 70;  // LCD_HPW
      cfg_detail.hsync_back_porch = 160;  // LCD_HBP
      cfg_detail.hsync_front_porch = 160; // LCD_HFP
      cfg_detail.vsync_pulse_width = 10;  // LCD_VPW
      cfg_detail.vsync_back_porch = 23;   // LCD_VBP
      cfg_detail.vsync_front_porch = 21;  // LCD_VFP
      _panel_instance.config_detail(cfg_detail);
    }
    _panel_instance.setBus(&_bus_instance);
    setPanel(&_panel_instance);
  }
};

// Backlight: IO31, PWM ~30kHz, active-high (LCD_GPIO_BLIGHT/BLIGHT_PWM_Hz/
// BLIGHT_ON_LEVEL in Elecrow's board_config.h) — handled in main.cpp, same
// as the retired S3 config, not part of the LGFX class itself.
#define WB_BACKLIGHT_PIN 31
#define WB_BACKLIGHT_PWM_HZ 30000
// Touch: GT911 over I2C1 — same chip family/library (TAMC_GT911) as the
// retired S3 board, just different pins, and RST/INT ARE wired on this board
// (they weren't on the old one — main.cpp's TAMC_GT911 constructor call
// currently passes -1,-1 for those and 800,480 for resolution; both need
// updating to WB_TOUCH_RST/WB_TOUCH_INT and 1024,600 — that's a main.cpp
// change, out of scope for this file).
#define WB_TOUCH_SDA 45
#define WB_TOUCH_SCL 46
#define WB_TOUCH_RST 40
#define WB_TOUCH_INT 42

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
    cfg.memory_width = 1024;
    cfg.panel_width = 1024;
    cfg.memory_height = 600;
    cfg.panel_height = 600;
    _panel_instance.config(cfg);
    _panel_instance.setScaling(1, 1);
    setPanel(&_panel_instance);
  }
};
#endif
