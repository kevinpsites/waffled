#include "wb_state.h"

const WbDeviceState &wb_mock_state(void)
{
  static const WbDeviceState state = {
      "Hudson",
      24,
      // morning
      {{{"Get dressed", true, 1}, {"Brush teeth", true, 1}, {"Make bed", true, 1}, {"Eat breakfast", true, 1}, {"Pack backpack", true, 1}}, 5},
      // afternoon
      {{{"Quiet reading", true, 1}, {"Tidy up toys", false, 1}, {"Outside play", false, 1}}, 3},
      // evening
      {{{"Bath time", false, 1}, {"Put on PJs", false, 1}, {"Brush teeth", false, 1}, {"Story time", false, 1}, {"Lights out", false, 1}}, 5},
      // chores (unscheduled)
      {{{"Feed the dog", true, 1}, {"Clothes in hamper", false, 1}, {"Tidy playroom", false, 1}}, 3},
      // quiet
      {false, false, 0, 0},
      false, // soundsOn
      true,  // nightlightOn
  };
  return state;
}
