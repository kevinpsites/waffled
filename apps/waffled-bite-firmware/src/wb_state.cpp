#include "wb_state.h"
#include <cstring>

const WbDeviceState &wb_mock_state(void)
{
  static const WbDeviceState state = {
      "Hudson",
      24,
      // morning — {id, title, done, rewardAmount}; id is "" since mock tasks
      // have no real instance to complete against
      {{{"", "Get dressed", true, 1}, {"", "Brush teeth", true, 1}, {"", "Make bed", true, 1}, {"", "Eat breakfast", true, 1}, {"", "Pack backpack", true, 1}}, 5},
      // afternoon
      {{{"", "Quiet reading", true, 1}, {"", "Tidy up toys", false, 1}, {"", "Outside play", false, 1}}, 3},
      // evening
      {{{"", "Bath time", false, 1}, {"", "Put on PJs", false, 1}, {"", "Brush teeth", false, 1}, {"", "Story time", false, 1}, {"", "Lights out", false, 1}}, 5},
      // chores (unscheduled)
      {{{"", "Feed the dog", true, 1}, {"", "Clothes in hamper", false, 1}, {"", "Tidy playroom", false, 1}}, 3},
      // quiet
      {false, false, 0, 0},
      // timer
      {false, false, 0, 0},
      // wakeLight
      {WbWakeLightState::None, -1, -1},
      {false, "white", 50, 0},  // sound: off, defaults picked to match apps/web's own fallback UI state
      {true, "amber", 40},      // night: on, matching the pre-settings-screen mock's nightlightOn=true
      16, 13, 3, 10, 15,        // now: 4:13pm, Wed Oct 15 — matches this screen's original hardcoded placeholder text
  };
  return state;
}

// Copies a JSON string field into a fixed-size buffer, truncating (never
// overrunning) if it's longer than the buffer — real chore titles/names are
// short, but nothing here should be able to corrupt neighboring struct
// fields if the server ever sends something unexpectedly long.
static void copyField(char *dst, size_t dstLen, JsonVariantConst v, const char *fallback = "")
{
  const char *s = v.is<const char *>() ? v.as<const char *>() : fallback;
  strncpy(dst, s, dstLen - 1);
  dst[dstLen - 1] = '\0';
}

// Pulls the household-local wall-clock parts out of "now" — a JSON object
// (waffledBites.ts's nowLocalView), not a raw ISO timestamp, specifically so
// the device never has to do its own UTC->local conversion (it has no
// timezone database to do that with). Missing/wrong-shaped fields fall back
// to -1, same "unavailable" sentinel the mock state and callers already
// expect (see wb_state.h).
static void parseNow(JsonVariantConst nowVal, int &outHour, int &outMin, int &outWeekday, int &outMonth, int &outDay)
{
  outHour = nowVal["hour"] | -1;
  outMin = nowVal["minute"] | -1;
  outWeekday = nowVal["weekday"] | -1;
  outMonth = nowVal["month"] | -1;
  outDay = nowVal["day"] | -1;
}

static void parseRoutine(JsonArrayConst arr, WbRoutine &out)
{
  out.count = 0;
  for (JsonVariantConst item : arr)
  {
    if (out.count >= WB_MAX_TASKS)
      break;
    WbTask &t = out.tasks[out.count];
    copyField(t.id, WB_ID_LEN, item["id"]);
    copyField(t.title, WB_TITLE_LEN, item["choreTitle"], "Task");
    const char *status = item["status"].is<const char *>() ? item["status"].as<const char *>() : "pending";
    t.done = strcmp(status, "done") == 0; // "awaiting" (photo-proof pending) counts as not-done for now
    t.rewardAmount = item["rewardAmount"] | 0;
    out.count++;
  }
}

bool wb_state_from_json(JsonDocument &doc, WbDeviceState &out)
{
  if (!doc["person"].is<JsonObjectConst>() || !doc["routines"].is<JsonObjectConst>())
    return false;

  copyField(out.personName, WB_NAME_LEN, doc["person"]["name"], "Kiddo");
  out.stars = doc["stars"] | 0;

  JsonObjectConst routines = doc["routines"];
  parseRoutine(routines["morning"], out.morning);
  parseRoutine(routines["afternoon"], out.afternoon);
  parseRoutine(routines["evening"], out.evening);
  parseRoutine(routines["chores"], out.chores);

  JsonObjectConst rt = doc["runtimeState"]["quiet"];
  out.quiet.active = rt["active"] | false;
  out.quiet.running = rt["running"] | false;
  out.quiet.remainingSec = rt["remainingSec"] | 0;
  out.quiet.durationSec = rt["durationSec"] | 0;

  JsonObjectConst timerRt = doc["runtimeState"]["timer"];
  out.timer.active = timerRt["active"] | false;
  out.timer.running = timerRt["running"] | false;
  out.timer.remainingSec = timerRt["remainingSec"] | 0;
  out.timer.durationSec = timerRt["durationSec"] | 0;

  JsonObjectConst wakeLightRt = doc["runtimeState"]["wakeLight"];
  const char *wlState = wakeLightRt["state"].is<const char *>() ? wakeLightRt["state"].as<const char *>() : "none";
  if (strcmp(wlState, "sleep") == 0)
    out.wakeLight.state = WbWakeLightState::Sleep;
  else if (strcmp(wlState, "warn") == 0)
    out.wakeLight.state = WbWakeLightState::Warn;
  else if (strcmp(wlState, "wake") == 0)
    out.wakeLight.state = WbWakeLightState::Wake;
  else
    out.wakeLight.state = WbWakeLightState::None;
  out.wakeLight.wakeAtHour = wakeLightRt["wakeAtHour"] | -1;
  out.wakeLight.wakeAtMinute = wakeLightRt["wakeAtMinute"] | -1;

  // Real settings keys are "night"/"sound" (not "nightlight"/"sounds") —
  // confirmed against apps/web/src/kiosk/WaffledBiteDevice.tsx. Both are
  // optional (a never-configured device has neither key at all), so every
  // field falls back to a sensible default rather than a zeroed struct.
  JsonObjectConst settings = doc["settings"];
  JsonObjectConst sound = settings["sound"];
  out.sound.on = sound["on"] | false;
  copyField(out.sound.tone, WB_TONE_LEN, sound["sound"], "white");
  out.sound.volume = sound["volume"] | 50;
  out.sound.timerMin = sound["timerMin"] | 0;

  JsonObjectConst night = settings["night"];
  out.night.on = night["on"] | false;
  copyField(out.night.color, WB_COLOR_LEN, night["color"], "amber");
  out.night.brightness = night["brightness"] | 40;

  parseNow(doc["now"], out.nowHour, out.nowMin, out.nowWeekday, out.nowMonth, out.nowDay);

  return true;
}
