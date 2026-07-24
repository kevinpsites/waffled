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

**Status: milestone 8.** Home + settings ("Grown-up controls") + a tasks screen are
built, the firmware talks to the real backend (onboarding → pairing → a 5s live poll
that keeps every screen in sync, token refresh, tap-to-complete on tasks), all four
Grown-up controls tiles are real (Sounds, Nightlight, Set a timer, Bedtime), and the
wake-light schedule now actually locks the device overnight (sleep → yellow warning →
green wake), not just stores unused data. Ported to **LVGL 9.2** + **1024×600** for the
new board. Verified end-to-end against a real running backend on `native` (paired,
exchanged tokens, polled real routine/stars data, completed a task, changed sound/
nightlight settings, started/ended a timer from both the device and the parent side,
computed a live wake-light state from a real schedule + household timezone, all for a
demo household's kid — see git history). `esp32-p4` has been bring-up tested on the
real board, including an on-device WiFi-provisioning UI (`ui/wifi_screen.cpp` +
`ui/onboarding_screen.cpp` — scan, pick a network, enter a password on the built-in
keyboard, no build-time credentials, plus a "Change Wi-Fi network" option on the
onboarding screen to re-open the picker if the wrong network was picked or the
device moves) and dozens of real-hardware reboot tests confirming the on-board
ESP32-C6 WiFi link connects reliably — see "What's not done" below for the
remaining rough edges.

## Two environments, one app

- **`native`** — a desktop build. [LovyanGFX](https://github.com/lovyan03/LovyanGFX)'s
  own SDL2 panel simulates the display and reports mouse clicks as touches through the
  exact same `getTouch()` call a real touch panel uses. No hardware needed.
  **Known simulator-only gotcha:** LovyanGFX's `Panel_sdl.cpp` binds `L`/`R` (rotate) and
  `1`–`6` (scale) as debug keyboard shortcuts on the SDL window (`_event_proc` in that
  file, vendored — not our code). Pressing one by accident (easy to do while the window
  has focus) skews the mouse→touch coordinate transform in a way that does **not** fully
  self-correct even after rotating back, so taps land on the wrong widget or stop
  registering entirely — this cost a long debugging session that initially looked like a
  real app freeze (see git history around the "settings button doesn't work" investigation:
  a live `lldb` capture showed touch coordinates frozen at one fixed point across many real
  clicks, and `lv_screen_active()` was correct throughout — the bug was in the vendor
  simulator's SDL-event→touch-point math, not LVGL or app code). Only affects `native`; a
  real touchscreen has no keyboard to trigger this. If clicks stop landing right in the
  simulator, close the window and re-run `pio run -e native -t exec` rather than debugging
  the app.
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

> **Status summary:** the app itself is now code-complete — every screen described below
> is wired to the real API and has been run against the real `./waffled-demo` backend. But
> all of that verification happened in the `native` desktop simulator; the `esp32-p4`
> target has never run on the actual board (still not in hand — see "unverified on real
> silicon" below). Treat everything above the hardware-bring-up entries as **simulator-proven,
> not hardware-proven**.

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
  verification (same SDL-headless caveat as tasks). At the time of this milestone, Set a
  timer and Bedtime were still non-functional placeholders — **both were completed in a
  later milestone**, see "Set a timer and Bedtime are done" further down. Nightlight's color options render as plain color circles
  with no text label at all — a swatch was added first (small circle next to a text name
  like "Amber"), then the name was dropped once the swatch made it redundant; selection
  shows as a border ring + a larger live preview above the row, using the exact hex values
  `apps/web/src/kiosk/WaffledBiteDevice.tsx`'s `NIGHT_COLORS` already uses, not invented
  ones. Sounds' tone options keep text chips (no color to show). The detail screen also now
  syncs live on every poll while it's the active screen (`wb_sync_control_detail_screen`) —
  previously a parent flipping a setting from the web app while a kid was sitting on this
  exact screen didn't show up until they backed out and back in. Opening either detail
  screen is an instant cut (`LV_SCR_LOAD_ANIM_NONE`), **not** a fade — a fade was tried
  first per an earlier request ("pop open" feel) but root-caused to a genuine LVGL 9.2.2
  hang (see `wb_open_detail_cb`'s comment in `settings_screen.cpp`); every other transition
  in the app (home↔settings, home↔tasks) still slides.
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
  zero navigation callbacks. Two things worth flagging: (1) at the time of this milestone,
  "Stay cozy until" was computed from the poll's plain UTC `now` field — the device has no
  RTC or timezone database of its own, so this read as UTC, not the household's actual
  local time; **this was fixed in a later milestone** (`waffledBites.ts`'s `now` is now a
  pre-localized `{hour, minute, weekday, month, day}` object, and the home screen's clock/
  date — previously hardcoded placeholders — are wired to it too); (2) no moon icon in the mockup made it in —
  no built-in `LV_SYMBOL_*` match, so the title stands alone rather than pairing with a
  mismatched glyph, same "built-in symbols for now" convention as everywhere else.
- **Set a timer and Bedtime are done.** Both were genuinely ambiguous placeholders until
  direct user feedback pinned them down:
  - **Set a timer** (`src/ui/timer_screen.cpp`) — unlike quiet time, either a parent (web
    app) OR the kid (right on the device) can start or end one, and it's exitable (a Home
    button, no lock). New backend: `runtime_state.timer` mirrors `runtime_state.quiet`'s
    exact shape (`CountdownState`/`countdownView` in `waffledBites.ts`, generalized from
    the quiet-time-only `QuietState`/`quietView`), with the same parent-side
    start/pause/resume/add-time/end routes as quiet time, **plus** two new device-authed
    routes (`POST /api/waffled-bites/device/timer/{start,end}`) so the kid can drive their
    own — pause/resume/add-time stay parent-only either way. TDD'd first (two new `it()`
    blocks in `waffled-bites.integration.test.ts`, watched fail with "Route not found",
    then implemented — full suite 882/882, `tsc --noEmit` clean). The device screen has two
    shapes: a duration-preset picker when no timer is active, or the same arc/MM:SS
    countdown language as `quiet_screen.cpp` (but the app's normal light palette, not
    quiet's dark "wind down" navy — this isn't meant to feel locked-in) once one is
    running. `main.cpp`'s poll keeps it correctly built at all times (not just when
    tapped), same reasoning as the Sounds/Nightlight sync fix — a parent could start one
    while the kid isn't looking at this screen. At the time of this milestone, that only
    kept the screen's *content* correct in the background — starting a timer didn't
    actually navigate onto it, so nothing visibly happened on the device; **this was
    fixed in a later milestone** (it now force-navigates on the same active/inactive
    edge quiet time does, while staying exitable). Parent web app gained a matching "Set
    a timer" card (`WaffledBiteDevice.tsx`) with presets + custom length + pause/+5/end,
    same shape as the existing Quiet time card.
  - **Bedtime** (`src/ui/bedtime_screen.cpp`) — deliberately NOT a routine or countdown:
    just a full-screen preview of the nightlight at its actual configured color and
    brightness, so a kid (or parent) can see what the room will actually look like. No new
    backend at all — reads the existing `settings.night` the Nightlight tile already
    writes. Exitable via a close button. Brightness scales both the glow's size and
    opacity, so a dim setting reads as genuinely dim, not just a different shade.
  - Both tiles' taps are pure navigation (no rebuild-on-tap) — `wb_do_poll` keeps
    `timer_scr`/`bedtime_scr` correctly built/synced every cycle regardless of which
    screen is currently showing, same pattern as `home_scr`/`settings_scr`.
- **The wake-light schedule now actually does something.** Until this pass, `settings.
  schedules` (`days`/`wakeMin`/`leadMin`) was stored and shown on the parent web app's
  "Wake-light schedule" card but drove nothing at all — not on the backend, not on the
  device; `wb_state.h` didn't even parse it. Direct user feedback specified the real
  behavior: a parent sets a bedtime; at that time the device locks into nightlight mode
  (not exitable), switches to a yellow "almost time" warning at the configured lead time
  (also not exitable), then green at the actual wake time, where a close button finally
  appears. This needed a genuinely new field (`bedtimeMin`, absent = this rule never
  locks — old wake-only schedules stay inert, no migration needed since `schedules` is
  jsonb) and the schedule's first real consumer, both backend and device:
  - **Backend** (`waffledBites.ts`): `wakeLightView(schedules, now, tz)` is a pure function
    — `now` is an injected parameter, not `Date.now()` internally, specifically so the exact
    midnight-crossing boundaries (8pm bedtime, 11:59pm, 12:01am, the lead-time cutoff, the
    wake instant) could be asserted in `wake-light.unit.test.ts` (TDD'd first, 7 tests) rather
    than trusted to a real-clock test's tolerances. `days` marks the WAKE morning (matches
    the "🟢 Okay to get up" label already on that field) — a school-days (Mon-Fri) rule
    therefore covers Sun-Thu **nights**, not Fri/Sat; the web app's new bedtime field says
    "the night before" so this isn't a silent surprise. For each schedule, checked against
    3 candidate wake-dates (yesterday/today/tomorrow, via real calendar-date arithmetic, not
    modular minute-of-day wraparound) rather than hand-deciding which single day "today"
    governs. `wake` holds for a 60-minute grace window after the actual wake instant, then
    reverts to `none` with no stored "acknowledged" flag needed. Exposed as
    `runtimeState.wakeLight` on both the device poll and the parent's profile view; new
    `wake-bites.integration.test.ts` case proves the real HTTP wiring (household tz lookup,
    `settings.schedules` parsing) actually reaches it. Verified live against the real demo
    backend (paired a throwaway test device, set a schedule spanning the whole day, confirmed
    `state: 'sleep'` on both the device poll and parent view, cleaned up after).
  - **Device** (`bedtime_screen.cpp`): the Bedtime tile's plain exitable preview and the
    wake-light's forced sleep/warn/wake are now one shared parameterized "glow screen"
    (`WbGlowSpec`: color, brightness, optional label + "until H:MM" text, exitable or not) —
    not three separate screens. `main.cpp` force-navigates on any `WbBedtimeClaim` EDGE
    (`Preview`/`Sleep`/`Warn`/`Wake`) — deliberately an edge check, not "was it previously
    none," since `Preview -> Sleep` on a **second** night is a non-none-to-non-none
    transition a naive check would miss and fail to re-lock for. Quiet time wins if both are
    somehow active at once (an explicit, in-the-moment parent action over a passive
    schedule). `sleep`/`warn` render with zero clickable elements (same "absence, not a lock
    flag" mechanism as `quiet_screen.cpp`); `wake` gets a close button to `home_scr`. `warn`
    uses a fixed amber, `wake` a fixed green — status colors, not the parent's chosen
    nightlight color; `sleep` reuses the actual configured nightlight color/brightness.
  - **Parent web app**: added the missing bedtime `<input type="time">` per schedule (with
    the "the night before" hint), plus a live status pill on the card
    ("🌙 Asleep right now" / "🟡 Almost time to wake" / "🟢 Awake").
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
- **No TLS certificate validation** for `https://` server addresses on `esp32-p4`
  (see the `TODO(hardware bring-up)` comment in `wb_http_esp32.cpp`) — a self-hosted
  household's server is assumed to be plain `http://` on the local LAN for now.
- **Real icons + exact mock colors are now done for the home and grown-up-controls
  screens.** The actual "Waffled Buddy" design mock (claude.ai/design project
  `fb5fb8fb-ed6b-4edd-a02f-bfedc8035966`, pulled via the Claude Design MCP — the
  800×480-panel variant, since this board is 1024×600, but "the idea and icons are the
  same" per direct feedback) turned out to have a real SVG icon set and exact CSS color
  tokens, not just a static screenshot. Both are now baked in: `src/icons/*.c` are the
  mock's own sun/sunhigh/moon/broom/star/gear/sound/timer/bed icons, rasterized and
  packed as LVGL 9 A8 (alpha-only) images — see `tools/icons/README.md` for the exact
  pipeline (`rsvg-convert` + a small stdlib-only Python script; no LVGL image-converter
  tool was used, `lv_img_conv`'s current npm release doesn't install cleanly) and
  `home_screen.cpp`'s `make_icon()` for how one baked asset gets tinted per-tile at
  draw time via `style_image_recolor`. The routine tile colors
  (`WB_COLOR_MORNING`/`AFTERNOON`/`EVENING`/`CHORES` in `home_screen.cpp`) are now the
  mock's exact `buddy-400.css` hex values, not eyeballed approximations. The home
  screen's subtitle is now "Let's have a great {morning/afternoon/evening}" (derived
  from the poll's `nowHour`), matching the mock's dynamic greeting instead of a
  hardcoded "day". Real per-kid avatars are still a colored initial-circle placeholder
  by design, not a gap — the mock's own 800×480-panel adaptation notes explicitly say
  color+initial, never an emoji/photo, for low-DPI legibility (see
  `buddy-400.css`'s "800×480 PANEL ADAPTATIONS" section). Icons vendored but not yet
  wired anywhere: `check`/`close`/`back` (the done-check badge, and the quiet/wake/
  routine-detail/sounds/nightlight screens' back buttons, still use LVGL's built-in
  `LV_SYMBOL_*` glyphs, a reasonable stand-in already) — picking these up, plus
  matching the mock's exact colors/serif-header treatment on the remaining screens
  (routine detail, quiet, wake-light, sounds, nightlight, timer, rewards) is a
  straightforward follow-up using the exact same patterns.
- **Home screen typography/elevation** (an earlier, smaller polish pass, ahead of the
  icon work above): the greeting uses a baked LVGL bitmap font
  (`src/fonts/wb_font_newsreader_semibold_32.c`, generated via `lv_font_conv` from
  Newsreader SemiBold — the same brand serif the marketing site loads, see
  `website/home/src/layouts/Base.astro` — latin range `0x20-0x7E`, 32px/4bpp, ~77KB;
  regenerate with `tools/fonts/Newsreader-SemiBold.woff` plus the exact `lv_font_conv`
  invocation in that file's header comment if the range or size ever needs to change)
  instead of Montserrat, every card/tile has a soft warm-tinted drop shadow
  (`apply_card_shadow` in `home_screen.cpp`), and a fully-completed routine shows a
  small green checkmark circle overlapping its count pill (`make_done_check`) instead
  of a checkmark glyph appended into the pill text.
- **The Waffled logo** (`apps/web/public/logo.png`, resized to 140×140 — the source is
  512×512/244KB, too large to bake as-is) is staged but **not placed anywhere on-device
  yet** — the mock itself has no logo on any kid-device screen (consistent with its
  no-photos/no-emoji low-DPI philosophy above), so there's no obvious slot for it.
  Candidate spot: the onboarding/pairing screens (`onboarding_screen.cpp`), which
  currently have no equivalent brand mark either. Needs a placement decision before
  it's wired in.
- **No OTA** — worth having before this ships to an actual kid's room.
- **`esp32-p4` WiFi reliability: fixed, via a build-mode change.** The on-board
  ESP32-C6 WiFi co-processor talks to the P4 over SDIO (`esp-hosted`), and Arduino's
  own PREBUILT `esp-hosted`/SDIO library for this chip was flaky — a fatal
  `bus_init_internal`/"Q create failed" assertion, or persistent SDIO errors,
  depending on the exact build — regardless of whether it was reached via `WiFi.h`
  or by calling the underlying `esp_wifi_*` functions directly. Neither esp_hosted
  host/slave version pairing, SDIO clock speed, bus width, nor reset GPIO explained
  it: building the exact same code from source under raw ESP-IDF was reliable
  across dozens of reboots, every time. The fix, now in `platformio.ini`:
  `framework = espidf, arduino` (Arduino built as an ESP-IDF *component*, so
  `esp-hosted` compiles fresh from source instead of linking that prebuilt
  package) — keeps all of this project's Arduino-style code (LVGL, touch, `WiFi.h`,
  `HTTPClient`) unchanged. Verified reliable across 30+ real-hardware reboots (both
  an isolated WiFi-only test and the full real firmware). See that env's comment
  for the full investigation, and `sdkconfig.defaults` for the resulting config.
  Two things worth re-checking if this ever regresses: the on-board ESP32-C6's
  reset line showed up as GPIO54 in a boot log despite `sdkconfig.defaults` setting
  GPIO32 — harmless so far (every reboot still succeeded), but not fully explained;
  and the ~10-minute watchdog-reboot issue reported for a different project on this
  same P4+C6 SDIO link
  ([esphome/esphome#14313](https://github.com/esphome/esphome/issues/14313)) hasn't
  been specifically ruled out (reboot tests run in the tens-of-seconds-per-boot
  range, not tens of minutes of continuous uptime).
  A follow-up bring-up pass found a second, separate SDIO issue: sitting idle on the
  onboarding screen (WiFi already connected) for ~13s could hit a transient
  `H_SDIO_DRV: failed to read registers` error that `esp_hosted` (by default)
  treats as fatal — an unconditional full device reboot, looping forever once
  triggered. Fixed by setting `CONFIG_ESP_HOSTED_TRANSPORT_RESTART_ON_FAILURE=n`
  (see `sdkconfig.defaults`), which makes this the same non-fatal retry every other
  transient SDIO error in that driver already gets, instead of a reboot.
  **Important gotcha for whoever debugs this next:** the P4 host can be reset two
  ways that are NOT equivalent — a soft/RTS-pin reset (what `pio run -t upload`
  does automatically, and what most serial-monitor tools use to "restart" the
  board) versus a real power cycle (unplug/replug). Repeated soft resets during
  this investigation left the on-board ESP32-C6 WiFi co-processor in a stale state
  that a fresh P4 boot couldn't talk to — WiFi failed to initialize every time,
  100% reproducible, looking exactly like a firmware bug. A genuine power cycle
  connected cleanly and quickly (~6s) every time. If WiFi ever appears to fail
  hard during bench testing (not on a real, freshly-plugged-in device), power-cycle
  before assuming it's a regression.
- **`esp32-p4` display/touch: bring-up tested, but not exhaustively.** LovyanGFX's
  `Bus_DSI`/`Panel_EK79007` does drive this panel. Real-hardware bring-up found
  touch was mirrored on the X axis (`main.cpp`'s `touchpad_read` — the GT911's
  `ROTATION_NORMAL` flips both axes internally and only the Y half was being
  undone; wide tap targets like list rows masked it, the on-screen keyboard's
  narrow side-by-side keys exposed it), and two onboarding-screen UX gaps: no
  visible way to dismiss the keyboard (only tapping elsewhere closed it — not
  discoverable) and the pairing-code field ending up hidden behind the keyboard
  once it popped up (`ui/onboarding_screen.cpp`'s flex alignment was centered,
  now top-started). The DSI PHY LDO channel question (Elecrow's own config
  disables it; LovyanGFX's `Bus_DSI` has no "disabled" value) hasn't specifically
  been revisited since it didn't block bring-up in practice.
- **Backlight is on/off, not dimmable** — the arduino-esp32 LEDC PWM API differs
  across core versions; picked the boring, version-stable option for now (see the
  comment in `main.cpp`). Needed once Screen & display's brightness setting should
  actually do something on-device.
- **Offline indicator, un-tap, and device-initiated unpair are done** (later milestone,
  not reflected in the entries above): a small "Offline" pill appears after 2 consecutive
  failed polls and clears on the next success; an already-done task row can be tapped again
  to un-complete it (`POST /api/waffled-bites/device/tasks/:id/uncomplete`); a secret
  5-fast-taps gesture on Settings' "For a grown-up" chip opens a confirmation screen that
  clears local pairing **and** calls a new `POST /api/waffled-bites/device/unpair` so the
  parent's panel actually reflects the device as gone, not just the device itself forgetting
  locally. A 401 on the live poll (e.g. a parent unpairing from the web app) now drops the
  device back to onboarding within one 5s poll instead of waiting for the ~4-minute token
  refresh cycle.
