#include "alarm_screen.h"

#include <stdio.h>

// A sunrise palette rather than the usual warm-paper background — this is the
// one screen that means "it's morning, time to get up", and it should read as
// that across a dark bedroom from a bed, not as another settings page.
#define WB_COLOR_BG lv_color_hex(0xFFB454)
#define WB_COLOR_INK lv_color_hex(0x3A2411)
#define WB_COLOR_MUTED lv_color_hex(0x7A5322)
#define WB_COLOR_BTN lv_color_hex(0xFFFDF8)

static void wb_alarm_stop_cb(lv_event_t *e)
{
  WbAlarmStopCallback onStop = (WbAlarmStopCallback)lv_event_get_user_data(e);
  if (onStop) onStop();
}

void wb_build_alarm_screen(lv_obj_t *parent, const char *personName, int nowHour, int nowMin,
                           WbAlarmStopCallback onStop)
{
  lv_obj_clean(parent);
  lv_obj_set_style_bg_color(parent, WB_COLOR_BG, 0);
  lv_obj_set_style_bg_opa(parent, LV_OPA_COVER, 0);
  lv_obj_set_flex_flow(parent, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(parent, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_row(parent, 18, 0);
  lv_obj_set_style_pad_all(parent, 30, 0);
  lv_obj_clear_flag(parent, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *sun = lv_label_create(parent);
  lv_label_set_text(sun, LV_SYMBOL_BELL);
  lv_obj_set_style_text_font(sun, &lv_font_montserrat_48, 0);
  lv_obj_set_style_text_color(sun, WB_COLOR_INK, 0);

  lv_obj_t *title = lv_label_create(parent);
  if (personName && personName[0])
  {
    char buf[64]; // "Good morning, " + WB_NAME_LEN + "!"
    snprintf(buf, sizeof(buf), "Good morning, %s!", personName);
    lv_label_set_text(title, buf);
  }
  else
  {
    lv_label_set_text(title, "Good morning!");
  }
  lv_obj_set_style_text_font(title, &lv_font_montserrat_32, 0);
  lv_obj_set_style_text_color(title, WB_COLOR_INK, 0);

  // Omitted rather than shown as "-1:-1" when the poll carried no clock.
  if (nowHour >= 0 && nowMin >= 0)
  {
    const int h12 = (nowHour % 12 == 0) ? 12 : nowHour % 12;
    char timeBuf[16];
    snprintf(timeBuf, sizeof(timeBuf), "%d:%02d %s", h12, nowMin, nowHour < 12 ? "AM" : "PM");
    lv_obj_t *time = lv_label_create(parent);
    lv_label_set_text(time, timeBuf);
    lv_obj_set_style_text_font(time, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(time, WB_COLOR_MUTED, 0);
  }

  // Big and central: this gets tapped by someone half asleep, in the dark.
  lv_obj_t *btn = lv_obj_create(parent);
  lv_obj_remove_style_all(btn);
  lv_obj_set_size(btn, 320, 110);
  lv_obj_set_style_bg_color(btn, WB_COLOR_BTN, 0);
  lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(btn, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_margin_top(btn, 14, 0);
  lv_obj_clear_flag(btn, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_flag(btn, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(btn, wb_alarm_stop_cb, LV_EVENT_CLICKED, (void *)onStop);

  lv_obj_t *lbl = lv_label_create(btn);
  lv_label_set_text(lbl, "Stop");
  lv_obj_set_style_text_font(lbl, &lv_font_montserrat_48, 0);
  lv_obj_set_style_text_color(lbl, WB_COLOR_INK, 0);
  lv_obj_center(lbl);
}
