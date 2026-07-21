# Waffled-Bite firmware

The kid-facing 7" companion device — an [ELECROW CrowPanel Basic 7"](https://www.elecrow.com/esp32-display-7-inch-hmi-display-rgb-tft-lcd-touch-screen-support-lvgl.html)
(ESP32-S3-WROOM-1-N4R8, 800×480 RGB-parallel capacitive touch), paired one-per-kid
from the parent web app's Family tab. This firmware talks to the API that shipped in
[the parent control panel PR](../../CHANGELOG.md) — `POST /api/waffled-bites/pair`,
`POST /api/waffled-bites/device/token`, and polling `GET /api/waffled-bites/device/state`
every ~5s (no WebSockets — see that PR's context for why).

**Status: milestone 3.** Home + settings ("Grown-up controls") screens are built,
and the firmware talks to the real backend: an onboarding screen (server address +
pairing code) shown when nothing's paired yet, real pairing via `POST
/api/waffled-bites/pair`, a 5s poll of `GET /api/waffled-bites/device/state` that
rebuilds the home screen from live data, and token refresh via `POST
/api/waffled-bites/device/token`. Verified end-to-end against a real running
backend (paired, exchanged tokens, and polled real routine/stars data for a demo
household's kid — see git history for the session that did this). Still no
hardware to test on, though — see "What's not done" below.

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

## Networking + pairing (native dev)

The `native` build defaults to `WB_API_BASE_URL=http://localhost:8081` (set in
`platformio.ini`), matching the local `./waffled-demo` stack. On first launch with
no stored pairing, it shows the onboarding screen — enter a server address and a
pairing code minted from the parent web app (Family → tap a kid → Waffled-Bite →
Pair). A successful pair is cached in `.wb_pairing.json` next to the binary (dev
convenience only, gitignored, plaintext — not modeling real device security) so
relaunching the simulator doesn't force re-pairing every run; delete that file to
force onboarding again. `esp32-s3` uses real NVS (`Preferences`) instead.

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

- **Only the home + settings screens exist.** Quiet time, night light, wake light,
  sound machine, and rewards from the mockup are still just the (non-functional)
  control tiles on the settings screen — tapping them does nothing yet.
- **No tap-to-complete on tasks.** The poll shows live routine/chore data, but there's
  no per-task list UI to tap, so `POST /api/waffled-bites/device/tasks/:instanceId/complete`
  is never called. `WbTask.id` is already plumbed through from the real payload for
  when this lands.
- **No WiFi provisioning UI.** `esp32-s3` connects with hardcoded credentials
  (`WB_WIFI_SSID`/`WB_WIFI_PASS` in `platformio.ini`, both `"CHANGE_ME"`) — a real
  captive-portal/BLE setup flow is deferred.
- **No TLS certificate validation** for `https://` server addresses on `esp32-s3`
  (see the `TODO(hardware bring-up)` comment in `wb_http_esp32.cpp`) — a self-hosted
  household's server is assumed to be plain `http://` on the local LAN for now.
- **No custom icons yet** — the mockup's sun/moon/timer/bed/lightning/star glyphs
  have no LVGL built-in equivalent, so those spots are text-only; gear/speaker/back-
  chevron/checkmark use LVGL's built-in `LV_SYMBOL_*` set. Real per-kid avatars
  (the mockup's turtle emoji) are a colored initial-circle placeholder — a real
  avatar needs a baked bitmap asset, not a font glyph.
- **No OTA** — worth having before this ships to an actual kid's room.
- **Flash headroom is getting tight on `esp32-s3`**: adding ArduinoJson + WiFi +
  HTTPClient + Preferences pushed flash usage from 48% to **95.8%** of the 4MB
  N4R8 partition (`pio run -e esp32-s3` prints the exact number). The custom icon
  font and avatar bitmaps above will eat into what's left — worth checking budget
  before adding either, and revisiting partition scheme / trimmed dependencies if
  it gets close to the limit.
- **esp32-s3 environment is unverified on real silicon** — builds cleanly, and the
  networking code is the same file across both targets (proven live against a real
  backend on `native`), but nothing has run on the actual board yet (still ordered,
  not in hand). In particular: confirm PSRAM is actually detected (`psramFound()`)
  — the `qio_opi` memory_type + 4MB flash_size + `default.csv` partitions overrides
  in `platformio.ini` are reasoned from the module's N4R8 designation, not confirmed
  against the chip — and confirm `HTTPClient::begin(String)` actually handles both
  `http://` and `https://` end-to-end on this specific arduino-esp32 core version
  (see `wb_http_esp32.cpp`).
- **Backlight is on/off, not dimmable** — the arduino-esp32 LEDC PWM API differs
  across core versions; picked the boring, version-stable option for now (see the
  comment in `main.cpp`). Needed once Screen & display's brightness setting should
  actually do something on-device.
