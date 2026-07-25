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
  zero navigation callbacks. "Stay cozy until" was computed from the poll's plain UTC
  `now` field at the time of this milestone — the device has no RTC or timezone database
  of its own, so this read as UTC, not the household's actual local time; **this was
  fixed in a later milestone** (`waffledBites.ts`'s `now` is now a pre-localized
  `{hour, minute, weekday, month, day}` object, and the home screen's clock/date —
  previously hardcoded placeholders — are wired to it too). **Layout reworked to match an
  updated design mock** (later still): was a single centered column (title above the
  ring); now a split row — a gold crescent moon + the "Quiet time" title in
  `wb_font_newsreader_semibold_32` (the same warm serif as the home screen's greeting) +
  "Stay cozy until…" on the left, the ring on the right. The moon is
  `wb_icon_moon_solid_128` — the *same* crescent path as the small outline moon icon used
  on the Evening tile/Nightlight control (`wb_icon_moon_32`/`_40`), just baked filled
  instead of stroked and at a bigger size (a small outline icon scaled way up at runtime
  would blur), tinted gold via the usual A8 recolor trick — see
  `tools/icons/README.md`'s `moon_solid.svg` note.
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
    same shape as the existing Quiet time card. **Countdown layout reworked to match
    quiet time's split mock** (later still, direct request): was a single centered
    column (title above the ring, matching quiet time's own earlier layout); now a
    split row — the ring on the **left** (sized up 220 -> 260, since it's the only
    thing on that side, unlike quiet time's ring which shares its side with nothing),
    the "Timer running" title + End-timer button stacked on the right. Deliberately
    mirrored left/right from quiet time's ring-on-the-right, per the request.
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
- **Tap-to-complete (and un-complete) on tasks is done, with a three-way result, not
  pass/fail.** Tapping a routine tile or the Chores bar opens a task list
  (`src/ui/tasks_screen.cpp`) with a checkbox per row; an undone row calls
  `POST .../tasks/:instanceId/complete`, a done row calls `.../uncomplete`, both with
  the device's access token. `WbTaskCompleteResult` (`tasks_screen.h`) distinguishes
  three outcomes rather than a plain bool: `Success` (optimistic flip stands),
  `Failed` (network error, 401, or an uncomplete that didn't take — row reverts), and
  `AwaitingApproval` — a chore requiring a parent's OK still answers HTTP 200, just
  with `instance.status: "awaiting"` rather than `"done"`. That case used to fall
  through to the same silent revert as a hard failure, which real-device testing
  showed reads exactly like "tapping does nothing" (every chore due that day needed
  either approval or a photo, so *every* tap silently failed). Now an
  `AwaitingApproval` result drops the row's checkbox circle entirely and shows
  "Waiting on a parent's approval" as plain text instead — direct feedback was that a
  circle next to a "Sent!" pill still read as a checkbox waiting to be tapped again —
  and freezes the row (no more taps) until the kid leaves and re-enters this screen
  (`tasks_scr` is only ever rebuilt on a routine-tile tap, not on the background 5s
  poll — see `wb_do_poll`'s comment on why). A chore requiring a photo
  (`WbTask.requiresPhoto`, plumbed through from the device poll's `requiresPhoto`
  field — `apps/api/.../waffledBites.ts`) is hidden from this list entirely, not
  merely disabled — no camera-capture flow exists yet, so it'd just 422
  `ProofRequiredError` every time, and the first cut (shown-but-disabled with a
  "Needs a photo" note) still read as broken per direct feedback ("I see chores that
  require a photo... and I can't do anything with them"). It's completed from a
  parent's phone/web instead. A routine that's entirely photo-required chores (count
  > 0 but nothing visible) gets its own message rather than the plain "Nothing here
  right now," which would wrongly imply nothing's assigned at all. A successful
  complete/uncomplete triggers an immediate poll so stars/progress update everywhere
  without waiting up to 5s. Mock/placeholder tasks (empty `id`, shown before the first
  real poll lands) render but aren't tappable, by design. Root-caused via a live
  serial console on real hardware (`pio device monitor`, wrapped in `script -q` to
  survive running backgrounded) while tapping real rows, then confirmed against the
  actual DB rows behind those instance ids — no animation on complete yet. The routine
  tiles' "X of Y done" counts and progress rings (`home_screen.cpp`'s
  `routine_visible_count`/`routine_done_count`) also exclude hidden photo-required
  tasks from both X and Y, so the numbers match what's actually shown on the opened
  list and a routine can still reach "all done" once every visible chore is checked —
  a photo-required task that happens to already be `done` (completed elsewhere, with a
  photo) still doesn't count toward either side, for consistency.
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
- **Grown-up-controls tile sizing matches the updated mock.** `make_control_tile`
  (`settings_screen.cpp`) used to stretch each tile's height to `lv_pct(100)` of the
  tile row, filling nearly the whole screen below the top bar. The mock shows compact,
  roughly-square tiles with real breathing room above and below. Tiles are now a fixed
  height (220px) instead of a percentage, and the row's cross-axis flex alignment is
  CENTER instead of the default START, so the fixed-height tiles land vertically
  centered in the remaining space rather than pinned to the top.
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
- **`esp32-p4` WiFi: picker showed zero networks when the saved AP was out of range —
  fixed.** Boot always retries `wifiSsid`/`wifiPass` from NVS first
  (`main.cpp`'s `setup()`); when that network isn't reachable (device moved to a new
  location), the STA driver ends up stuck reporting `WL_NO_SSID_AVAIL`, and the WiFi
  picker's scan (`wb_wifi_begin_scan()`) issued from that state fails synchronously
  (`WIFI_SCAN_FAILED`) even with real networks in range — `wb_wifi_scan_status()` used
  to collapse that straight into `Done`, indistinguishable from "scan succeeded, found
  nothing." First fix attempt (`WiFi.disconnect()` before scanning) did **not** clear
  it — confirmed live on real hardware via temporary serial logging: `WiFi.status()`
  kept reporting `WL_NO_SSID_AVAIL` and `scanNetworks()` kept returning
  `WIFI_SCAN_FAILED` across dozens of attempts, even after a full power cycle of the
  device (ruling out the "stale ESP32-C6 co-processor, needs a real power cycle" issue
  documented above — this is a different, software-clearable stuck state on the P4
  side). What actually works: power-cycling the STA mode itself in software —
  `WiFi.mode(WIFI_OFF)` then `WiFi.mode(WIFI_STA)` with a 200ms settle each side —
  before every scan, which resets the driver's internal state machine rather than just
  its connection state. Separately, `WbWifiScanStatus` gained a `Failed` state distinct
  from `Done`, so `wifi_screen.cpp` retries a failed scan automatically
  (`WB_WIFI_SCAN_RETRY_LIMIT`, 5 attempts) instead of silently rendering an empty list.
  Also found in the same live-debugging session: a network broadcast from more than one
  BSSID (mesh WiFi, dual-band routers) was showing up once per BSSID in the list, since
  `scanNetworks()` returns one row per access-point radio, not per SSID —
  `wb_wifi_scan_results()` now dedupes by SSID, keeping the strongest-signal copy.
  A code audit prompted by this session (checking whether all the WiFi churn while
  debugging could have degraded the device generally) turned up a real, separate bug
  in `wifi_screen.cpp`: `wb_build_wifi_screen()` is **not** a one-time call the way
  `onboarding_screen.cpp`'s screen is — `main.cpp`'s `wb_show_wifi_picker()` (used by
  the "Change Wi-Fi network" option on the paired-app screens) calls it again on every
  reopen, `lv_obj_clean()`-ing the old tree first. The old `WbWifiScreenCtx` and its
  200ms poll timer had no cleanup tied to that clean, so reopening the picker while a
  scan/connect was still in flight leaked the ctx and left the old timer running
  forever against freed LVGL objects (a use-after-free, not just a leak). Fixed by
  tying `ctx`'s lifetime to `card`'s `LV_EVENT_DELETE` (`wb_wifi_ctx_delete_cb`),
  the same pattern already used correctly by `quiet_screen.cpp`'s `WbQuietCtx` and
  `timer_screen.cpp`'s own ctx.
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
- **Offline: the poll used to freeze the whole UI, not just show a badge — fixed.**
  `wb_do_poll()` runs synchronously on the same LVGL thread that drives touch/rendering
  (`wb_poll_timer_cb`, `main.cpp`) — there's no task offload, and `wb_http_esp32.cpp`'s
  `HTTPClient` had no explicit connect-phase timeout, so it fell back to the
  arduino-esp32 default (`HTTPCLIENT_DEFAULT_TCP_TIMEOUT`, 5000ms). A genuinely
  unreachable server (the common case: `serverUrl` is a plain LAN address typed in at
  pairing time — see "What's not done" below — and the device has since moved to a
  different network) blocked the entire touchscreen for that long on every single 5s
  poll, which looked exactly like a device-wide slowdown or memory issue, not a network
  one, when reported live. Fixed two ways: `wb_http_esp32.cpp` now sets an explicit,
  shorter `http.setConnectTimeout(3000)` so one failed attempt costs less; more
  importantly, once offline (`WB_OFFLINE_AFTER_MISSES` misses), `main.cpp` backs the
  poll timer off from 5s to 30s (`lv_timer_set_period`, `WB_POLL_INTERVAL_OFFLINE_MS`)
  so the device stays responsive to touch between checks instead of stuttering every 5s
  indefinitely, and snaps back to the normal 5s cadence on the next success.
  **Not fixed, and not really fixable device-side:** the server address itself has no
  rediscovery — `serverUrl` is whatever was typed into the onboarding text field,
  persisted verbatim (no QR capture, no mDNS, no cloud relay), so a self-hosted
  household's server that's only reachable on the home LAN will correctly show
  "Offline" from anywhere else. That's expected today, not a bug; a remote-reachable
  self-hosted deployment (reverse proxy, VPN, tunnel) is a household networking choice
  outside this firmware's scope.
- **`timer_scr`/`bedtime_scr` could white-screen and strand the kid — fixed.** Both
  were only ever built inside `wb_do_poll()`'s first-success path (`main.cpp`, gated by
  `g_liveScreensBuilt`/`g_bedtimeScrBuilt`), which only runs once `wb_state_from_json()`
  has actually succeeded at least once. If the device's very first poll after entering
  the app fails — the offline case directly above is the common way this happens —
  that build never runs, and `timer_scr`/`bedtime_scr` stay exactly what
  `lv_obj_create(NULL)` produced at boot: an object with zero children. Settings'
  "Set a timer"/"Bedtime" tiles navigate to them unconditionally either way
  (`wb_go_scr_cb`), so tapping either landed on a genuinely blank screen — no title, no
  content, no back button, confirmed live as "tapped Timer, it white-screened, now it's
  frozen with no way out short of a power cycle." Fixed by giving both a real
  placeholder build in `wb_enter_app()` up front, using `wb_mock_state()` — the exact
  same pattern `home_scr`/`settings_scr` already used for this. `wb_do_poll()`'s first
  real success still fully rebuilds both with live data exactly as before (the two
  `g_...Built` flags are untouched, still start `false`); this only closes the window
  before that first success lands.
- **A real "can't reach the server" screen — direct request, following the two entries
  above.** Every device-initiated action (starting a timer, completing a chore,
  toggling sound/nightlight — anything routed through `wb_http_*`) needs a live request
  to the server; while offline, those just failed silently with zero user feedback,
  reported live as "I tried to start a timer and it doesn't do anything." Three
  approaches were on the table — inline per-action error toasts, disabling
  server-dependent controls up front, or a full-screen blocker with recovery options —
  and the full-screen blocker was the one picked. New `src/ui/offline_screen.{h,cpp}`
  (`wb_build_offline_screen`) — a plain message plus "Try again" (an immediate
  `wb_do_poll()`, not waiting for a possibly 30s-backed-off scheduled one — see the
  offline-backoff entry above), "Change Wi-Fi network" (`wb_show_wifi_picker` — this
  turned out to already work correctly from a live-app context even though it had never
  actually been wired to a button there: `wb_on_wifi_connected` already falls through to
  `wb_enter_app()` when already paired, not just onboarding), and "Go to Settings".
  Force-shown from `wb_mark_poll_failed()`/dismissed from `wb_mark_poll_ok()` in
  `main.cpp`, at the exact same `WB_OFFLINE_AFTER_MISSES` threshold the small "Offline"
  badge already used — one source of truth for "is this device offline."
  **Revised twice more, both direct requests:**
  1. **A direct "Change server address" button**, straight into
     `forget_confirm_screen.h`'s confirm step (`wb_build_forget_confirm_screen`, same
     clean+build+load `settings_screen.cpp`'s 5-tap gesture does) — the
     grown-up-gate-only version above proved too roundabout in practice. Still not a
     silent one-tap unpair: the confirm screen's own "Forget this device?" tap is
     unchanged, and reaching offline_scr at all already requires a real connectivity
     failure (2+ consecutive missed polls), which is a real gate on its own — a kid
     can't get here just by tapping around Settings.
  2. **Re-asserted on every offline poll, not just the first edge into the state** —
     initially it only force-navigated once, so backing out to another screen (e.g. via
     "Go to Settings") while still offline just quietly stayed there forever instead of
     coming back; confirmed live. Now every `wb_mark_poll_failed()` call past the
     threshold re-navigates, with two exemptions so it doesn't fight anyone trying to
     actually fix things: parent-forced locks (quiet time, or bedtime's Sleep/Warn/Wake
     claim — preempting these would hand a kid a way OUT of a lock by taking the device
     offline on purpose) and any screen that's itself part of a recovery flow
     (`wifi_scr`, `onboarding_scr`, `forget_scr`, or `offline_scr` itself — yanking
     someone off the WiFi picker mid-reconnect-attempt would be actively counterproductive).
  Native and esp32-p4 both build clean; verified no crash on real hardware post-flash
  across all three iterations (only the known-benign, already-documented transient
  `H_SDIO_DRV: failed to read registers` retry, not a reboot).
- **Bigger, chunkier buttons across every utility screen — direct request.** Every
  button on `wifi_screen.cpp`, `offline_screen.cpp`, `forget_confirm_screen.cpp`,
  `timer_screen.cpp`, `onboarding_screen.cpp`, `settings_screen.cpp`,
  `control_detail_screen.cpp`, `tasks_screen.cpp`, and `bedtime_screen.cpp`'s close
  button was built at roughly a normal adult-app scale (`&lv_font_montserrat_14`/`16`
  text, ~14-22px padding) — noticeably smaller than the home screen's big tiles, and
  not what a "big, fun, chunky-button" kid device should feel like. No new font was
  baked: this project already had `&lv_font_montserrat_24` compiled in as the
  headline size (`lv_conf.h`), with plenty of flash headroom (23% used), so button
  labels now use that size (bumped to `_32` for a handful of screen titles), with
  roughly double the padding and `LV_RADIUS_CIRCLE` standardized on every pill/chip
  that wasn't already fully rounded. Also bumped: `lv_switch_create`'s default size
  (tiny out of the box — explicit `lv_obj_set_size`), the Nightlight/Sounds color
  swatches (44→60px) and text option chips, and the volume/brightness slider's track
  height + knob padding (`LV_PART_KNOB`) for an easier drag target. Some containers
  needed growing to fit the bigger content without clipping/crowding: the WiFi
  picker's card (460×460 → 620×560) and the onboarding card (420 wide → 560, plus its
  title gained wrap+center since "Set up your Waffled-Bite" at 32px doesn't reliably
  fit one line). **Deliberately left alone**: every secondary/status text element
  (routine badges, "Secured · Strong signal" subtext, "Waiting on a parent's
  approval," the quiet/timer countdown's small caption text) — those stay smaller on
  purpose, for contrast against the now much bigger primary buttons — and Settings'
  "For a grown-up" chip, which stays deliberately small/easy-to-overlook for a kid
  (see the offline-screen entry above for the same reasoning applied to its
  change-server shortcut). Native and esp32-p4 both build clean; verified no crash on
  real hardware post-flash (same known-benign transient SDIO error as above, not a
  reboot).
- **Chore rows sized up to match, direct follow-up.** The home screen's tiles were
  already big; the actual Morning/Afternoon/Evening/Chores task rows
  (`tasks_screen.cpp`'s `wb_make_task_row`) hadn't gotten the same treatment in the
  first pass. Title text 16 -> 24, checkbox 40 -> 56px (its icon glyph 16 -> 24,
  border 2 -> 3px to stay in proportion), row padding/radius bumped, more space
  between rows in the scrollable list (10 -> 14px). The reward badge ("+1") and the
  "Waiting on a parent's approval" status text got a smaller bump (14 -> 16) —
  intentionally still secondary to the row's title/checkbox, same "leave status text
  smaller for contrast" call as the rest of this pass. Native and esp32-p4 both build
  clean; verified no crash on real hardware post-flash.
- **Offline screen gets a mascot — direct request, user-supplied artwork.** A sad,
  unplugged waffle-iron with a broken WiFi symbol, semi-large on the left, with the
  message + action buttons now in a right-hand column instead of centered below —
  same split-row shape as `quiet_screen.cpp`/`timer_screen.cpp`, mirrored so the
  mascot mirrors those screens' icon-on-one-side treatment. The source PNG (opaque
  RGB, no alpha) needed the full-color RGB565 bake, not the A8/tinted-icon path
  every small glyph in `tools/icons/` uses — reused `tools/logo/`'s existing
  `png_to_lvgl_rgb565.py` script directly rather than duplicating it (see
  `tools/mascot/README.md`). Baked at 320×320 (~200KB — flash usage moved from 23%
  to 26%, still plenty of headroom). `right_col` needed an explicit fixed width
  (560px, not `LV_SIZE_CONTENT`) so its button row could still wrap reliably against
  a real pixel value, same reasoning `wifi_screen.cpp`/`onboarding_screen.cpp`'s own
  fixed-size cards already use. Native and esp32-p4 both build clean; verified no
  crash on real hardware post-flash.
- **Logo + mascot: transparent backgrounds, bigger boot screen — direct request,
  follow-up to the mascot entry above.** Both `wb_logo_*`/`wb_offline_mascot_320`
  used to be baked as flat opaque images (RGB565 for the logo, the mascot's own
  source), which drew a visible white/cream box wherever they were placed instead of
  sitting directly on the surrounding screen's background. Neither source PNG has a
  real alpha channel (`sips -g hasAlpha` → no on both) — the background is baked-in
  flat color, so getting a transparent version meant chroma-keying it out, not just
  reading existing alpha data. Both directories' READMEs document the exact
  commands and the tuning story (ffmpeg's `colorkey` filter, `similarity` kept low
  enough to not eat into each mascot's own near-white body — this bit the first
  attempt on the mascot at `similarity=0.12`, confirmed by compositing onto solid
  magenta before settling on `0.02`; the logo's source additionally needed an
  alpha-channel blur pass to smooth a subtle paper-grain texture that showed as
  static in the transparent regions on magenta — checked against the actual app
  background too, where it's imperceptible, before committing to it). Rebaked as
  **ARGB8888** (real per-pixel alpha, not A8's tint-only or RGB565's no-alpha) via a
  new `tools/logo/png_to_lvgl_argb8888.py`, reused by `tools/mascot/` rather than
  duplicated. `wb_logo_96`/`wb_logo_40` are drop-in replacements (same variable
  names, every existing call site — onboarding, WiFi "Connecting…", the home
  screen's clock corner — picks up the transparency for free); new `wb_logo_160`
  is boot-screen-only. `main.cpp`'s boot screen (shown while connecting to WiFi at
  power-on, before onboarding/home) also got the same bigger-everything treatment
  as the rest of the app on request — 96px/font_24 logo+title → 160px/font_32, with
  "Connecting…" given an explicit font_16 (previously unset/default) — it only has
  three elements on it, so it read sparse next to every other screen's now-chunkier
  scale. Flash usage moved from 26% to 31.5% (ARGB8888 is 2x RGB565's bytes/pixel
  and 4x A8's), still well within budget. Native and esp32-p4 both build clean;
  verified no crash on real hardware post-flash.
- **Home screen routine tiles sized up to match — direct follow-up.** The
  Morning/Afternoon/Evening/Chores tiles were the one place on the home screen that
  hadn't gotten the chunky-button-pass treatment. Rebaked `wb_icon_sun`/`sunhigh`/
  `moon`/`broom` at 48px (was 32px — these are single-purpose A8 icons, each used in
  exactly one place, confirmed by grep before deleting the old 32px `.c` files
  rather than leaving them orphaned) from the same `tools/icons/*.svg` sources, no
  new assets needed. `make_routine_tile`'s title text 16→24, `make_badge`'s "X of Y"
  pill text 14→16 (bumped for every caller — the greeting card's stars pill too,
  not just routine tiles, since it's the same "secondary info pill" pattern),
  `make_done_check`'s green checkmark badge 26px→32px, tile padding and progress
  bar height bumped slightly to give the bigger content room. Native and esp32-p4
  both build clean; verified no crash on real hardware post-flash.
- **`wifi_screen.cpp`'s network-row subtitle showed a missing-glyph box — fixed.**
  Reported live from a real-device photo: an empty square between "Secured" and
  "Strong signal". The subtitle format string used a middle dot (`·`, U+00B7,
  `"%s · %s"`) as the separator; this project's `lv_conf.h` only bakes the
  built-in LVGL Montserrat fonts with the Basic Latin (ASCII, `0x20`-`0x7E`)
  range, so anything outside that range has no glyph to draw and LVGL renders a
  placeholder box instead. Swapped for a plain hyphen (`" - "`), which is in
  range. Grepped every `lv_label_set_text`/`snprintf` call across `src/ui/*.cpp`
  and `main.cpp` for other non-ASCII characters in actual label text (as opposed
  to comments, which don't render) — this was the only one. Native and esp32-p4
  both build clean; verified no crash on real hardware post-flash.
- **Morning/Afternoon/Evening icons moved to the tile center and sized up again —
  direct follow-up.** `make_routine_tile`'s icon used to live in `top_row` next to
  the count badge (top-left corner); moved into its own `icon_wrap` flex item
  between `top_row` and `bottom`, given `flex_grow(1)` so it consumes whatever
  vertical space the badge/title/bar don't need, then `CENTER`/`CENTER` aligns the
  icon inside that space — reads as centered regardless of how tall the other
  pieces end up, rather than a fixed pixel offset. `top_row` keeps just the badge,
  now end-aligned since it's the row's only child. Rebaked `wb_icon_sun`/
  `sunhigh`/`moon` at 64px (was 48px, before that 32px — same `tools/icons/*.svg`
  sources each time, confirmed single-purpose by grep before deleting the
  superseded 48px `.c` files); `wb_icon_broom_48` (chores bar) is untouched — the
  request was specifically the three routine tiles, not chores. Native and
  esp32-p4 both build clean; verified no crash on real hardware post-flash.
- **On-screen keyboard covering the focused text field — real regression, fixed
  in two places.** `onboarding_screen.cpp`'s "Vertical alignment is START, not
  CENTER... leaves enough headroom above the keyboard" comment used to be true,
  but the chunky-button pass grew the card's content (bigger logo, `font_32`
  title, bigger fields) enough that it no longer held: reported live via a
  real-device photo, the Server-address field was entirely hidden behind the
  keyboard once it popped up, with no way to see what was typed. The keyboard is
  a `FLOATING` overlay (see the comment on why that flag is required for its
  bottom-docking to actually take effect) — content "under" it in flex-layout
  terms is still there, just invisible, since the keyboard paints on top; a
  fixed vertical offset (or just hoping the layout stays short enough) doesn't
  hold up as content grows. Fixed by computing the overflow fresh on every
  `FOCUSED` event (`ta`'s bottom edge minus the keyboard's top edge, plus a 16px
  margin) and applying it as `lv_obj_set_style_translate_y()` on the card — a
  paint-time transform, not a layout change, so it doesn't fight the flex
  engine. Reset to 0 on defocus/hide. `lv_obj_get_coords()` always reports the
  natural untransformed position, so recomputing on every focus handles
  `server_ta`/`code_ta` needing different amounts of shift without compounding
  a previous offset. `wifi_screen.cpp`'s password field sits inside the same
  kind of fixed-size card and shares the identical risk — not yet confirmed
  broken on real hardware (rough math suggests it currently has enough
  headroom), but fixed the same way defensively, tied to a new small `WbKbCtx`
  freed on `card`'s `LV_EVENT_DELETE` (this screen rebuilds on every picker
  reopen — see the earlier ctx-cleanup entry above — so "never freed" would
  leak one of these per reopen, unlike onboarding's screen which is genuinely
  built once). Native and esp32-p4 both build clean; verified no crash on real
  hardware post-flash.
- **Quiet-time and timer countdown rings sized way up — direct feedback, two
  real-device photos.** Both rings were 260px and read as "way too small" from
  across a room, and 32px (`&lv_font_montserrat_32`) was already the largest font
  baked into this firmware (`lv_conf.h`), so there was no room to grow the
  countdown text further without baking a bigger size. Enabled
  `LV_FONT_MONTSERRAT_48` — a standard LVGL-bundled size, no custom asset/bake
  pipeline needed, just flipping the `lv_conf.h` flag — and used it for both
  rings' countdown numbers. `quiet_screen.cpp`'s ring: 260→480px (arc width
  10→18, `"LEFT"` caption 14→16) — this screen has no top bar competing for the
  600px panel height, so 480 fits with ~60px of natural top/bottom margin from
  the parent's own `CENTER` cross-alignment, no explicit padding needed.
  `timer_screen.cpp`'s ring: 260→440px (arc width 10→16) — capped a bit smaller
  than quiet's since this screen's Home button bar (72px) eats into the same
  600px budget, leaving less headroom (`600 - pad(40) - bar(72) - row_gap(20) =
  468px` available for the ring's row, so 440 leaves a little breathing room
  rather than exactly maxing it out). Native and esp32-p4 both build clean;
  verified no crash on real hardware post-flash.
- **Quiet time's title bumped to a bigger custom-font bake; timer screen's text
  centered — direct follow-up.** `wb_font_newsreader_semibold_32` (the app's warm
  serif, `src/fonts/`) was the only size baked. Bumping the "Quiet time" title to
  match the ring's own `font_48` jump meant baking a genuinely bigger version of
  the custom font, not just picking a bigger built-in Montserrat: ran the exact
  `lv_font_conv` invocation from the 32px file's own header comment with
  `--size 48`, output to a new `src/fonts/wb_font_newsreader_semibold_48.c`, and
  added it to `lv_conf.h`'s `LV_FONT_CUSTOM_DECLARE` (multiple `LV_FONT_DECLARE()`
  calls chain in that macro — `LV_FONT_DECLARE(wb_font_newsreader_semibold_32)
  LV_FONT_DECLARE(wb_font_newsreader_semibold_48)`). No new tooling needed —
  `lv_font_conv` runs fine via `npx` without a local install. "Stay cozy until…"
  bumped 16→24 (plain Montserrat, not the custom serif — the request was
  specifically for the title to use "our custom font size," the subtitle just
  needed to be bigger, staying visibly smaller than the title). Separately,
  `timer_screen.cpp`'s `right_col` (holding "Timer running" + the End-timer
  button) had its cross-axis alignment changed `START`→`CENTER`: since
  `right_col` is `LV_SIZE_CONTENT` width (shrinks to its widest child, the
  title), `START` just pinned every child to that child's left edge — with a
  narrower child (the button) that reads as left-aligned/lopsided rather than
  centered as a block. `CENTER` centers the narrower button under the title
  instead. Native and esp32-p4 both build clean; verified no crash on real
  hardware post-flash.
- **Timer screen's ring and text block brought together — direct follow-up,
  reference photo.** `content_row`'s main-axis alignment was
  `LV_FLEX_ALIGN_SPACE_BETWEEN`, which pushes its two children to the row's
  opposite edges — fine at the ring's old 260px size, but once it grew to 440px
  the ring sat hard against the left edge and `right_col` hard against the
  right, leaving a big empty gap in the middle on this 1024px-wide panel
  (visible in the photo: "Timer running"/"End timer" reading like an
  afterthought far off to the side). Changed to `LV_FLEX_ALIGN_CENTER` with an
  explicit `pad_column(64)` so the ring and `right_col` sit together as one
  centered unit with a fixed, deliberate gap between them, instead of being
  pulled apart by however much space the row happens to have. Native and
  esp32-p4 both build clean; verified no crash on real hardware post-flash.
