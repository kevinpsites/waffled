# Waffled-Bite firmware

The kid-facing 7" companion device — an [ELECROW CrowPanel Basic 7"](https://www.elecrow.com/esp32-display-7-inch-hmi-display-rgb-tft-lcd-touch-screen-support-lvgl.html)
(ESP32-S3-WROOM-1-N4R8, 800×480 RGB-parallel capacitive touch), paired one-per-kid
from the parent web app's Family tab. This firmware talks to the API that shipped in
[the parent control panel PR](../../CHANGELOG.md) — `POST /api/waffled-bites/pair`,
`POST /api/waffled-bites/device/token`, and polling `GET /api/waffled-bites/device/state`
every ~5s (no WebSockets — see that PR's context for why).

**Status: milestone 1 only.** The toolchain is proven end to end — it builds, LVGL
renders, and the simulator actually runs — but there's no real screen yet (just a
placeholder), no networking, and no hardware to test against. See "What's not done"
below before assuming more works than does.

## Two environments, one app

- **`native`** — a desktop build. [LovyanGFX](https://github.com/lovyan03/LovyanGFX)'s
  own SDL2 panel simulates the display and reports mouse clicks as touches through the
  exact same `getTouch()` call a real touch panel uses. No hardware needed.
- **`esp32-s3`** — the real board. **Unverified** — no board in hand yet (ordered).

Both environments build the same `src/main.cpp`; only `src/lgfx_device.h` branches
(`#if defined(ARDUINO)`) to pick the real RGB-panel/GT911-touch HAL vs. the SDL one.
Screens and app logic should never need to know which target they're running on.

## Building

Requires [PlatformIO Core](https://platformio.org/install/cli) (`brew install
platformio` on macOS) and, for the simulator, SDL2 (`brew install sdl2`).

```sh
# Simulator — opens a window, same 800x480 resolution as the real device
pio run -e native -t exec

# Real hardware — will fail without a board plugged in over USB
pio run -e esp32-s3 -t upload
```

## Where the hardware config came from

`src/lgfx_device.h`'s pin mapping, RGB bus timing, and GT911 touch wiring for the
`esp32-s3` target are copied from Elecrow's own working example for this exact
board — not derived from datasheets or guessed, since RGB-panel timing is exactly
the kind of thing that looks plausible but doesn't actually drive the panel:
[Elecrow-RD/CrowPanel-7.0-HMI-ESP32-Display-800x480](https://github.com/Elecrow-RD/CrowPanel-7.0-HMI-ESP32-Display-800x480),
`example/V3.0/Arduino/Course/LVGL_Arduino7.0/`. The simulator's `LGFX` class and
`src/sdl_main.cpp` are copied from LovyanGFX's own
`examples_for_PC/PlatformIO_SDL` and `v1_autodetect/LGFX_AutoDetect_sdl.hpp`.

LVGL is pinned to **8.4.x** (not the current 9.x) because Elecrow's reference code
uses the v8 driver-registration API (`lv_disp_drv_t`/`lv_indev_drv_t`) throughout —
matching it avoids having to port their proven touch/display glue to v9 blind,
before any of it has run on real hardware.

## What's not done

- **No real screens yet** — `main.cpp` renders a static placeholder label to prove
  the pipeline works. Porting the actual mockup screens (home/routines, quiet time,
  night light, wake light, sound machine, rewards, first-run Wi-Fi + pairing) is
  next, likely via [SquareLine Studio](https://squareline.io/) for layout.
- **No networking** — no HTTP client, no pairing flow, no polling loop. The `native`
  target has no Arduino `HTTPClient`; a cross-platform HTTP approach (or a small
  abstraction with a native and an Arduino implementation) is needed before this can
  talk to the real API.
- **No WiFi provisioning UI** — device-side captive-portal/BLE Wi-Fi setup.
- **No OTA** — worth having before this ships to an actual kid's room.
- **esp32-s3 environment is unverified** — builds cleanly (`pio run -e esp32-s3`),
  but nothing has run on real silicon. In particular: confirm PSRAM is actually
  detected (`psramFound()`) once a board arrives — the `qio_opi` memory_type +
  4MB flash_size + `default.csv` partitions overrides in `platformio.ini` are
  reasoned from the module's N4R8 designation, not confirmed against the chip.
- **Backlight is on/off, not dimmable** — the arduino-esp32 LEDC PWM API differs
  across core versions; picked the boring, version-stable option for now (see the
  comment in `main.cpp`). Needed once Screen & display's brightness setting should
  actually do something on-device.
