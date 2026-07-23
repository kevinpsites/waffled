#include "wb_tick_hal.h"

#if defined(ARDUINO)
#include <Arduino.h>
extern "C" uint32_t wb_tick_ms(void) { return millis(); }
#else
#include <chrono>
extern "C" uint32_t wb_tick_ms(void)
{
  using namespace std::chrono;
  return static_cast<uint32_t>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}
#endif
