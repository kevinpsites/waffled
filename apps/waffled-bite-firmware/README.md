# Waffled-Bite firmware

The kid-facing 7" companion device — an [ELECROW CrowPanel Advanced 7"](https://www.elecrow.com/crowpanel-advanced-7inch-esp32-p4-hmi-ai-display-1024x600-ips-touch-screen-with-wifi-6-compatible-with-arduino-lvgl-micropython.html)
(ESP32-P4, 1024×600 MIPI-DSI IPS capacitive touch, WiFi 6/BT 5.3 via an on-board
ESP32-C6 co-processor), paired one-per-kid from the parent web app's Family tab.
This firmware talks to the API that shipped in
[the parent control panel PR](../../CHANGELOG.md) — `POST /api/waffled-bites/pair`,
`POST /api/waffled-bites/device/token`, and polling `GET /api/waffled-bites/device/state`
every ~5s (no WebSockets — see that PR's context for why).

An earlier board (ELECROW CrowPanel Basic 7", ESP32-S3, 800×480 RGB-parallel) was
targeted first and is gone from this repo — superseded before it ever arrived. See
git history if that context is ever needed again.

**Status: milestone 6.** Home + settings ("Grown-up controls") + a tasks screen are
built, the firmware talks to the real backend (onboarding → pairing → a 5s live poll
that rebuilds home *and* settings, token refresh, tap-to-complete on tasks, and now
real Sounds/Nightlight controls that PATCH the backend), and it's been ported to
**LVGL 9.2** + **1024×600** for the new board. Verified end-to-end against a real
running backend on `native` (paired, exchanged tokens, polled real routine/stars
data, completed a task, changed sound/nightlight settings, all for a demo
household's kid — see git history). `esp32-p4` compiles clean against the real
production silicon's toolchain, but nothing has run on actual hardware yet — see
"What's not done" below.

## Two environments, one app

- **`native`** — a desktop build. [LovyanGFX](https://github.com/lovyan03/LovyanGFX)'s
  own SDL2 panel simulates the display and reports mouse clicks as touches through the
  exact same `getTouch()` call a real touch panel uses. No hardware needed.
- **`esp32-p4`** — the real board. **Unverified** — no board in hand yet (ordered);
  compiles clean against the real toolchain, that's as far as this has been proven.

Both environments build the same `src/main.cpp`; only `src/lgfx_device.h` branches
(`#if defined(ARDUINO)`) to pick the real DSI-panel/GT911-touch HAL vs. the SDL one.
Screens and app logic should never need to know which target they're running on.

## Building

Requires [PlatformIO Core](https://platformio.org/install/cli) (`brew install
platformio` on macOS) and, for the simulator, SDL2 (`brew install sdl2`).

```sh
# Simulator — opens a window, same 1024x600 resolution as the real device
pio run -e native -t exec

# Real hardware — will fail without a board plugged in over USB. Uses the
# community "pioarduino" platform fork (mainline PlatformIO has no official
# ESP32-P4 support yet) — see platformio.ini's [env:esp32-p4] comments.
pio run -e esp32-p4 -t upload
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

`src/lgfx_device.h`'s pin mapping, DSI bus/DPI timing, and GT911 touch wiring for
the `esp32-p4` target are sourced from Elecrow's own repo for this exact board —
not derived from datasheets or guessed:
[Elecrow-RD/CrowPanel-Advanced-7inch-ESP32-P4-HMI-AI-Display-1024x600-IPS-Touch-Screen](https://github.com/Elecrow-RD/CrowPanel-Advanced-7inch-ESP32-P4-HMI-AI-Display-1024x600-IPS-Touch-Screen),
`example/V1.2/Arduino_Code/Lesson07-Turn_on_the_screen/{board_config.h,esp_panel_board_custom_conf.h}`.
The simulator's `LGFX` class and `src/sdl_main.cpp` are copied from LovyanGFX's own
`examples_for_PC/PlatformIO_SDL` and `v1_autodetect/LGFX_AutoDetect_sdl.hpp`.

**Important deviation from the vendor's own example**, flagged for whoever picks
this up at real hardware bring-up: Elecrow's own proven Arduino example does
**not** use LovyanGFX — it uses Espressif's own `ESP32_Display_Panel` +
`ESP32_IO_Expander` libraries (their repo's top-level spec table claims LVGL 9.2,
but the actual working example code is v8 — `lvgl_v8_port.cpp` — the table is
stale, trust the code). `lgfx_device.h` instead uses LovyanGFX's `Bus_DSI` +
`Panel_EK79007` (both real, non-experimental classes — the panel's init sequence
is lifted from Espressif's own `esp_lcd_ek79007` component) to keep the same
`LGFX_Device` abstraction `main.cpp`/`native` already share, rather than fork the
app onto a second, unrelated display-driver architecture. This is a deliberate
choice to preserve the existing codebase shape, **not** proof it's the safer bet
for first bring-up — if it doesn't drive the real panel, the vendor's own
`ESP32_Display_Panel`-based approach (their Lesson07 example) is the documented,
vendor-proven fallback.

LVGL is pinned to **9.2.x**. `wb_tick_hal.h`/`.cpp` (the custom tick source)
needed no changes across the v8→v9 migration — only *how* it's wired in changed
(v9 dropped the `LV_TICK_CUSTOM` compile-time macro for a runtime
`lv_tick_set_cb()` call in `main.cpp`).

## What's not done

- **Sounds and Nightlight are done.** Tapping either tile on the Grown-up controls
  screen opens a shared toggle+picker+slider detail screen (`src/ui/control_detail_screen.cpp` —
  one screen parameterized for both, since they're the same shape: on/off, pick a
  tone/color, a volume/brightness slider). Wired to a **new** device-authed route,
  `PATCH /api/waffled-bites/device/settings` (`waffledBites.ts`) — the existing parent-side
  `PATCH /api/waffled-bites/:id/settings` is `adminRoute`-gated and rejects a device's own
  access token (confirmed by the existing test suite), so the on-device screen needed its
  own write path. Allowlisted to just the `sound`/`night` keys so a device can't rewrite
  parent-only settings (schedules, alarm) it has no UI for; TDD'd
  (`waffled-bites.integration.test.ts`) before being implemented. `main.cpp`'s poll now
  rebuilds the settings screen too (previously it only rebuilt home, so Sounds/Nightlight
  never reflected a change made from the parent web app either). Added `wb_http_patch`
  (native: libcurl `CURLOPT_CUSTOMREQUEST`; esp32-p4: `HTTPClient::PATCH`) since this is the
  first PATCH the firmware makes. Verified against the real demo backend: PATCHed both
  sound and night with a real device token (the exact body `wb_patch_settings` in `main.cpp`
  builds), confirmed both persisted on a follow-up poll, confirmed a smuggled non-whitelisted
  key (`alarm`) was silently dropped, confirmed an admin token still gets 403 on the new
  device route; ran the actual compiled `native` binary through a real pair→token→poll cycle
  against the same backend to confirm the port didn't regress. Full `apps/api` suite (880
  tests) and `tsc --noEmit` both clean. What's still open: no on-screen tap-gesture
  verification (same SDL-headless caveat as tasks), and **Set a timer + Bedtime are still
  non-functional placeholders** — no backend concept exists yet for either (see the research
  this milestone did: quiet-time's start/pause/resume/end + computed-on-read pattern is the
  closest reusable primitive for a kid-facing timer, but a true one needs real design; Bedtime
  has no dedicated data model at all, just adjacent wake-schedule/alarm fields and the
  generic evening chore bucket). Nightlight's color chips now show a real swatch (a small
  circle per option plus a larger live preview that updates as you tap through) using the
  exact hex values `apps/web/src/kiosk/WaffledBiteDevice.tsx`'s `NIGHT_COLORS` already uses,
  not invented ones. Opening either detail screen now fades in/out
  (`LV_SCR_LOAD_ANIM_FADE_IN`) instead of sliding, at the user's request — every other
  transition in the app (home↔settings, home↔tasks) still slides.
- **Quiet time has a full-screen, non-exitable device UI** (`src/ui/quiet_screen.cpp`) —
  dark navy background, a countdown ring (`lv_arc`) ticking down once a second locally
  and resyncing to the server-computed value on every 5s poll, "Stay cozy until H:MM"
  below it. Parent-triggered only (`POST /api/waffled-bites/:id/quiet/{start,end}` etc.
  from the web app — no on-device start/stop); `main.cpp`'s poll force-loads this screen
  the moment `runtimeState.quiet.active` is true, overriding whatever screen the kid was
  on, and there is deliberately no back button, gesture handler, or clickable element on
  it anywhere — that absence, not a lock flag, is what makes it non-exitable. Verified by
  starting a real quiet session against the demo backend, confirming the poll response
  and the actual compiled `native` binary picked it up (`lastSeenAt` advanced through a
  real pair→poll cycle while quiet was active), and by code review that the screen has
  zero navigation callbacks. Two things worth flagging: (1) "Stay cozy until" is computed
  from the poll's `now` field, which is the server's plain UTC time — the device has no
  RTC or timezone database, so this reads as UTC, not the household's actual local time,
  until real timezone plumbing lands (same gap as the home screen's still-hardcoded
  placeholder clock, `"4:13"`/`"Wed, Oct 15"` in `home_screen.cpp`, unrelated to this
  milestone but worth knowing about together); (2) no moon icon in the mockup made it in —
  no built-in `LV_SYMBOL_*` match, so the title stands alone rather than pairing with a
  mismatched glyph, same "built-in symbols for now" convention as everywhere else.
- **Tap-to-complete on tasks is done.** Tapping a routine tile or the Chores bar opens
  a task list (`src/ui/tasks_screen.cpp`) with a checkbox per task; tapping an undone
  row calls `POST /api/waffled-bites/device/tasks/:instanceId/complete` with the
  device's access token, optimistically marks the row done, and reverts it if the
  request fails (network error, or a photo-proof-required chore this device can't
  satisfy yet — `ProofRequiredError` on the backend). A successful complete triggers
  an immediate poll so stars/progress update everywhere without waiting up to 5s.
  Verified against the real demo backend: paired a real device, hit the exact
  complete endpoint with a real device token (the same request `wb_complete_task` in
  `main.cpp` builds), confirmed the reward posted (`stars` went 42→48) and the
  instance flipped to `status: "done"` on a follow-up poll; separately ran the actual
  compiled `native` binary through a full pair→token→poll cycle to confirm nothing in
  the port broke the runtime. What's still open: no undo/uncomplete from the device,
  no animation on complete, and mock/placeholder tasks (empty `id`, shown before the
  first real poll lands) render but aren't tappable, by design.
- **No WiFi provisioning UI.** `esp32-p4` connects with hardcoded credentials
  (`WB_WIFI_SSID`/`WB_WIFI_PASS` in `platformio.ini`, both `"CHANGE_ME"`) — a real
  captive-portal/BLE setup flow is deferred.
- **No TLS certificate validation** for `https://` server addresses on `esp32-p4`
  (see the `TODO(hardware bring-up)` comment in `wb_http_esp32.cpp`) — a self-hosted
  household's server is assumed to be plain `http://` on the local LAN for now.
- **No custom icons yet** — the mockup's sun/moon/timer/bed/lightning/star glyphs
  have no LVGL built-in equivalent, so those spots are text-only; gear/speaker/back-
  chevron/checkmark use LVGL's built-in `LV_SYMBOL_*` set. Real per-kid avatars
  (the mockup's turtle emoji) are a colored initial-circle placeholder — a real
  avatar needs a baked bitmap asset, not a font glyph. Flash headroom for these is
  no longer tight (see below), so this is now just unbuilt, not budget-constrained.
- **No OTA** — worth having before this ships to an actual kid's room.
- **`esp32-p4` environment is unverified on real silicon** — compiles clean
  against the real production toolchain (pioarduino, arduino-esp32 3.3.10,
  ESP-IDF libs 5.5.5, RISC-V), and the networking code is the same file across
  both targets (proven live against a real backend on `native`), but **nothing
  has run on the actual board yet** (still ordered, not in hand). Specific
  unknowns to resolve at bring-up, all flagged inline where relevant:
  - Whether LovyanGFX's `Bus_DSI`/`Panel_EK79007` actually drives this panel at
    all — see the vendor-deviation note above; the vendor's own proven
    `ESP32_Display_Panel`-based approach is the fallback if not.
  - The DSI PHY LDO channel — Elecrow's own config disables it (board doesn't
    power the PHY through the P4's internal LDO), but LovyanGFX's `Bus_DSI` has
    no "disabled" value, only a default channel; left at the library default,
    unverified whether that conflicts (`lgfx_device.h`).
  - Whether `WiFi.h`/`HTTPClient` actually work unchanged over the on-board
    ESP32-C6's hosted SDIO link, as Arduino's abstraction is supposed to
    provide — and whether the ~10-minute watchdog-reboot issue reported for a
    different project on this same P4+C6 SDIO link
    ([esphome/esphome#14313](https://github.com/esphome/esphome/issues/14313))
    shows up here too.
- **Backlight is on/off, not dimmable** — the arduino-esp32 LEDC PWM API differs
  across core versions; picked the boring, version-stable option for now (see the
  comment in `main.cpp`). Needed once Screen & display's brightness setting should
  actually do something on-device.
