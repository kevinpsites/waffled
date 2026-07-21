// The device-side view of a Waffled-Bite's state — deliberately shaped to match
// GET /api/waffled-bites/device/state's JSON response 1:1 (see
// apps/api/src/modules/waffledBites/waffledBites.ts), so that swapping the mock
// data source below for a real network poll later is a one-line change in
// main.cpp, not a rewrite of the screen code that reads this struct.
#pragma once

#include <cstdint>

#define WB_MAX_TASKS 8

struct WbTask
{
  const char *title;
  bool done;
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
  const char *personName;
  int stars;
  WbRoutine morning;
  WbRoutine afternoon;
  WbRoutine evening;
  WbRoutine chores; // unscheduled/general — no due time
  WbQuietState quiet;
  bool soundsOn;
  bool nightlightOn;
};

// Stand-in for the real poll until networking exists (see the firmware README's
// "What's not done") — same shape the real response will have, so home_screen.cpp
// never needs to change when this is replaced by an actual HTTP call.
const WbDeviceState &wb_mock_state(void);
