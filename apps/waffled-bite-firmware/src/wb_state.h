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
#define WB_TONE_LEN 16 // e.g. "ocean", "whiteNoise" — matches apps/web's SOUNDS keys
#define WB_COLOR_LEN 16 // e.g. "amber" — matches apps/web's NIGHT_COLORS keys

struct WbSoundSettings
{
  bool on;
  char tone[WB_TONE_LEN];
  int volume;    // 0-100
  int timerMin;  // 0 = no sleep timer
};

struct WbNightSettings
{
  bool on;
  char color[WB_COLOR_LEN];
  int brightness; // 0-100
};

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

// Same shape as WbQuietState (see wb_state_from_json's runtimeState.timer
// parse) — unlike quiet time, a timer can be started/ended by the kid
// directly on the device too, and isn't full-screen-locked.
using WbTimerState = WbQuietState;

// The wake-light schedule's computed state — the server does all the
// timezone/day-of-week math (see waffledBites.ts's wakeLightView); the
// device just renders whatever it's told. `sleep`/`warn` are forced
// (non-exitable, force-navigated the same way quiet time is); `wake` is
// forced-navigated too but exitable (a close button, per direct user
// feedback). See bedtime_screen.h for how this drives the shared glow
// screen's visual.
enum class WbWakeLightState
{
  None,
  Sleep,
  Warn,
  Wake,
};

struct WbWakeLightInfo
{
  WbWakeLightState state;
  int wakeAtHour;   // -1 if not applicable (state == None)
  int wakeAtMinute;
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
  WbTimerState timer;
  WbWakeLightInfo wakeLight;
  WbSoundSettings sound;
  WbNightSettings night;
  // Wall-clock hour/minute parsed from the poll's top-level "now" (server's
  // new Date().toISOString(), plain UTC — the device has no RTC/timezone
  // database of its own). -1/-1 when unavailable (mock state, or an
  // unexpectedly-shaped "now"). Used only for quiet_screen's "Stay cozy
  // until H:MM" line today; NOTE this is UTC, not the household's local
  // timezone — a real clock needs the same timezone plumbing the backend
  // already has for day-boundary math (see waffledBites.ts's householdTz),
  // not yet wired to the device.
  int nowHour;
  int nowMin;
};

// Fallback/offline demo data — also what native boots into before any real
// poll has succeeded.
const WbDeviceState &wb_mock_state(void);

// Fills `out` from a parsed GET /api/waffled-bites/device/state response
// (routines.{morning,afternoon,evening,chores}[], stars, person.name,
// settings.sound.{on,sound,volume,timerMin} / settings.night.{on,color,
// brightness} — confirmed against the real keys the web control panel
// writes, apps/web/src/kiosk/WaffledBiteDevice.tsx; NOT "sounds"/
// "nightlight", and the JSON key for sound's tone/track name is "sound",
// not "tone" — WbSoundSettings.tone is renamed on this side only because
// "sound.sound" would be a confusing field name in C++. Returns false if
// the document doesn't look like a valid state payload (missing required
// fields) — callers should keep the previous WbDeviceState on false rather
// than overwrite it with a half-filled one.
bool wb_state_from_json(JsonDocument &doc, WbDeviceState &out);
