// The device-side view of a Waffled-Bite's state — deliberately shaped to match
// GET /api/waffled-bites/device/state's JSON response (see
// apps/api/src/modules/waffledBites/waffledBites.ts), so the screen code that
// reads this struct doesn't change whether it's fed wb_mock_state() or a real
// poll parsed by wb_state_from_json().
//
// Strings are fixed-size owned buffers, not `const char *` — a real poll's
// JsonDocument is short-lived (freed once parsing finishes), so the values it
// contains have to be copied out, not pointed into.
#pragma once

#include <cstdint>
#include <ArduinoJson.h>

#define WB_MAX_TASKS 8
#define WB_NAME_LEN 40
#define WB_TITLE_LEN 64
#define WB_ID_LEN 40 // holds a uuid (36 chars) + nul

struct WbTask
{
  char id[WB_ID_LEN];      // the chore instance id — POST .../tasks/:instanceId/complete
                            // target; unused until tap-to-complete lands, plumbed through now
  char title[WB_TITLE_LEN]; // choreTitle in the real payload
  bool done;                 // true when status=="done"; "awaiting" (photo-proof pending
                              // approval) counts as not-done for progress purposes this pass —
                              // no distinct UI for it yet
  int rewardAmount;
};

struct WbRoutine
{
  WbTask tasks[WB_MAX_TASKS];
  int count;
};

struct WbQuietState
{
  bool active;
  bool running;
  int remainingSec;
  int durationSec;
};

struct WbDeviceState
{
  char personName[WB_NAME_LEN];
  int stars;
  WbRoutine morning;
  WbRoutine afternoon;
  WbRoutine evening;
  WbRoutine chores; // unscheduled/general — no due time
  WbQuietState quiet;
  bool soundsOn;
  bool nightlightOn;
};

// Fallback/offline demo data — also what native boots into before any real
// poll has succeeded.
const WbDeviceState &wb_mock_state(void);

// Fills `out` from a parsed GET /api/waffled-bites/device/state response
// (routines.{morning,afternoon,evening,chores}[], stars, person.name,
// settings.sound.on / settings.night.on — confirmed against the real keys
// the web control panel writes, apps/web/src/kiosk/WaffledBiteDevice.tsx;
// NOT "sounds"/"nightlight"). Returns false if the document doesn't look
// like a valid state payload (missing required fields) — callers should
// keep the previous WbDeviceState on false rather than overwrite it with a
// half-filled one.
bool wb_state_from_json(JsonDocument &doc, WbDeviceState &out);
