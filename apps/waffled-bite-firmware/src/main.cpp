// Milestone 1: prove the toolchain end to end (PlatformIO + LovyanGFX + LVGL +
// SDL2 on the native/simulator target, same app code targeting the real esp32-s3
// panel) with a placeholder screen. Real screens (routines, quiet time, wake
// light, ...) and the Waffled-Bites API client come next, once this renders.
#include <lvgl.h>
#include "lgfx_device.h"

#if defined(ARDUINO)
#include <Wire.h>
#include <TAMC_GT911.h>
static TAMC_GT911 ts = TAMC_GT911(WB_TOUCH_SDA, WB_TOUCH_SCL, -1, -1, 800, 480);
#else
#include <chrono>
#include <thread>
#endif

static LGFX lcd;

static lv_disp_draw_buf_t draw_buf;
// A partial buffer (40 rows) is plenty for LVGL's chunked flush — the full
// 800x480 framebuffer lives in the panel driver, not here.
static lv_color_t buf1[800 * 40];
static lv_disp_drv_t disp_drv;

static void disp_flush(lv_disp_drv_t *disp, const lv_area_t *area, lv_color_t *color_p)
{
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;
  lcd.pushImageDMA(area->x1, area->y1, w, h, (lgfx::rgb565_t *)&color_p->full);
  lv_disp_flush_ready(disp);
}

// Native: LovyanGFX's SDL panel reports mouse clicks as touches through the same
// getTouch() call real touch panels use. Hardware: the GT911 over I2C.
static void touchpad_read(lv_indev_drv_t * /*indev_drv*/, lv_indev_data_t *data)
{
#if defined(ARDUINO)
  ts.read();
  if (ts.isTouched)
  {
    data->state = LV_INDEV_STATE_PR;
    data->point.x = ts.points[0].x;
    data->point.y = ts.points[0].y;
  }
  else
  {
    data->state = LV_INDEV_STATE_REL;
  }
#else
  int32_t x, y;
  if (lcd.getTouch(&x, &y))
  {
    data->state = LV_INDEV_STATE_PR;
    data->point.x = x;
    data->point.y = y;
  }
  else
  {
    data->state = LV_INDEV_STATE_REL;
  }
#endif
}

static void build_placeholder_ui(void)
{
  lv_obj_t *scr = lv_scr_act();
  lv_obj_set_style_bg_color(scr, lv_color_hex(0xF5EFE1), 0); // Waffled's cream background
  lv_obj_t *label = lv_label_create(scr);
  lv_label_set_text(label, "Waffled-Bite\nsimulator OK");
  lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_color(label, lv_color_hex(0x1C1A18), 0);
  lv_obj_center(label);
}

void setup()
{
#if defined(ARDUINO)
  Serial.begin(115200);
  Wire.begin(WB_TOUCH_SDA, WB_TOUCH_SCL);
  // Plain on/off for now, not PWM brightness — the LEDC API differs across
  // arduino-esp32 core versions (ledcAttach(pin,...) vs. the older
  // ledcSetup+ledcAttachPin+ledcWrite(channel,...)) and this hasn't been checked
  // against real hardware yet. Revisit once a board's in hand and Screen &
  // display's brightness setting needs to actually dim something.
  pinMode(WB_BACKLIGHT_PIN, OUTPUT);
  digitalWrite(WB_BACKLIGHT_PIN, HIGH);
#endif

  lcd.init();

#if defined(ARDUINO)
  ts.begin();
  ts.setRotation(ROTATION_NORMAL);
#endif

  lv_init();
  lv_disp_draw_buf_init(&draw_buf, buf1, NULL, 800 * 40);

  lv_disp_drv_init(&disp_drv);
  disp_drv.hor_res = 800;
  disp_drv.ver_res = 480;
  disp_drv.flush_cb = disp_flush;
  disp_drv.draw_buf = &draw_buf;
  lv_disp_drv_register(&disp_drv);

  static lv_indev_drv_t indev_drv;
  lv_indev_drv_init(&indev_drv);
  indev_drv.type = LV_INDEV_TYPE_POINTER;
  indev_drv.read_cb = touchpad_read;
  lv_indev_drv_register(&indev_drv);

  build_placeholder_ui();
}

void loop()
{
  lv_timer_handler();
#if defined(ARDUINO)
  delay(5);
#else
  std::this_thread::sleep_for(std::chrono::milliseconds(5));
#endif
}

