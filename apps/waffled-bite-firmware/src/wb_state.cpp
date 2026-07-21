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
      false, // soundsOn
      true,  // nightlightOn
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

  // Real settings keys are "night"/"sound" (not "nightlight"/"sounds") —
  // confirmed against apps/web/src/kiosk/WaffledBiteDevice.tsx.
  JsonObjectConst settings = doc["settings"];
  out.nightlightOn = settings["night"]["on"] | false;
  out.soundsOn = settings["sound"]["on"] | false;

  return true;
}
