# Nook iPad — Project Roadmap

A living checklist for bringing Nook to iPad as a **full, interactive, web-like native
app**. Check items off as we land them; keep the rationale notes so we don't lose context
about *why* a decision was made or *what's deferred and why it's safe to defer*.

> **Status (updated 2026-07-02):** Phases 0–3 done — universal app, single-profile login,
> Today dashboard, and the **full nav rail + every page**, all interactive. Phase 5
> (**screensaver**) shipped. **Phase 4 branding shipped** — the **Kinnook** app icon + a
> cold-launch **bouncing-logo splash** on the cream canvas (product renamed Nook → Kinnook
> across the UI). The multi-profile picker, top-bar capture, and the two iPad-Today banners
> shipped too. **Remaining: App Store submission.**
>
> **Since the 06-25 status (iPad + iPhone):** Calendar **Countdowns** (Today card + month
> badges); the **Pantry** module to web parity (item age, cook→decrement, Cook-from-pantry,
> dietary chips, and a **Settings → Pantry** editor — locations, per-location icons,
> thresholds, allergen avoid-list); the **Family Night** module (Today card + agenda
> editor); a **customizable nav rail** — a per-device picker (Today + Calendar pinned,
> choose up to 5 more) with the rest falling into a new **"More"** hub; and a Settings
> reorg into **Account · Family · System** tiers (mirroring web) — "Accounts" renamed
> **Households**, **Display & Kiosk** split into "This iPad" (device-local) vs "Family
> displays" (household-wide), and the Family list ordered to match Settings → Modules.
>
> Cross-cutting features that landed alongside the iPad work (both iPhone + iPad): role-based
> **permission gating** + the **permissions matrix editor**, **chore photo-proof**
> (capture · review · retention · stored-photo gallery), and the full **photo slideshow /
> screensaver**. See [`docs/product/features.md`](../../docs/product/features.md) for the
> per-surface (iPhone / iPad) support matrix.

---

## The vision (two products, one app)

- **iPhone** = the *personal planner* — the native app we already have. An individual
  checks their day, captures events, manages their stuff. **Untouched by this work.**
- **iPad** = the **web app, native and sized up** — a left **nav rail** + every page
  (Today, Calendar, Tasks/Chores, Goals, Family, Meals, Lists, Photos, Settings), fully
  interactive, with rich web-parity widgets. It can sit on a counter as a family hub, but
  it is a *real app you navigate*, not a passive display. Mirrors `apps/web/src/kiosk/`
  (`KioskLayout` rail + `Topbar` + routed pages), re-laid-out big for the iPad.

Both ship in **one universal app** — same bundle ID (`com.kevinsites.nook`), one App Store
listing, one download. The device picks the right experience at runtime by idiom. We are
**not** shipping a second app.

---

## Decisions locked in (don't relitigate without a reason)

1. **Universal app, not a separate target.** `TARGETED_DEVICE_FAMILY "1,2"`. One binary,
   one listing. iPad layouts live behind idiom checks inside the same app.
2. **Native SwiftUI, not a WKWebView wrap.** The web kiosk renders *too small* on the iPad
   (px-pinned, no scale factor); native gives exact sizing control for the iPad. Confirmed
   on-device: sizing looks good.
3. **Reuse the existing iOS data layer + feature views.** `SyncManager` (PowerSync),
   `NookAPI`, `Theme.swift` tokens — and the existing phone feature views (`CalendarView`,
   `MealsView`, chores/goals/lists/etc. via `HubDestination`) become the iPad's pages,
   progressively re-laid-out to match the web. The iPad work is **navigation + screens**,
   not a new data/sync/auth stack.
4. **Single-profile login is the default; the shared profile picker is opt-in.** Out of
   the box an iPad signs in once and *stays* — one profile, normal persistent login
   (Keychain + 401-refresh). An admin can opt this iPad into a **shared family kiosk**
   (profile picker + optional PIN) — shipped as a clean additive layer (see Phase 6), it
   never changes the default single-login behavior unless turned on.
5. **iPad is a full interactive app**, navigable to every page — the web experience, native.
   The **family-display / screensaver** mode is a *secondary, low-priority* overlay
   (Phase 5), not the point. (Was originally scoped kiosk-display-first; re-scoped
   2026-06-23 per on-device review.)

---

## Phase 0 — Make the app run on iPad at all ✅

- [x] `project.yml`: `TARGETED_DEVICE_FAMILY: "1,2"` (was `"1"`).
- [x] `project.yml`: iPad orientations via `UISupportedInterfaceOrientations~ipad`
      (landscape + portrait); phone stays portrait-only.
- [x] `UIRequiresFullScreen` left unset (iPad multitasking stays enabled).
- [x] `xcodegen generate` + build for iPad sim — BUILD SUCCEEDED, verified on device.
- [x] Idiom helper: `DeviceExperience` (`App/DeviceExperience.swift`) — `.planner` (iPhone)
      vs `.kiosk` (iPad).
- [x] Entry fork: `RootView` in `NookApp.swift` → `AppRoot` (iPhone) vs `KioskRoot` (iPad).
      iPhone path byte-for-byte unchanged.

## Phase 1 — Single-profile auth path ✅

- [x] Persistent login reused as-is (`Session.bootstrap` / `hasUsableToken` → `.authed`).
- [x] iPad-sized sign-in: `LoginView` scales up + caps to a centered column (`isKiosk` /
      `columnWidth`); iPhone login unchanged.
- [x] No picker / PIN / switch — the signed-in profile is the device's identity.
- [x] Token-expiry routes back to the same login (not a dead screen).
      Follow-up: confirm refresh-token TTL is long enough for an always-on device (Auth0 era).

## Phase 2 — Today dashboard + web-parity widgets

The Today *home* of the full app. First cut done; now expanding the widgets to match the
web (per the on-device review — see the web `Today` screenshot reference).

**Done (first cut):**
- [x] `KioskDashboard` (`Features/Kiosk/KioskDashboard.swift`) — landscape, 3-column,
      big type; hosted by `KioskRoot`. Live data verified on device.
- [x] Agenda — "This week" via `Agenda.upcoming`, grouped by day.
- [x] Tonight's dinner (basic), Chores (aggregate), Goals (featured), Grocery (count).
- [x] Header: greeting + date + live clock + weather. `KioskCard` surface.

**Web-parity expansion (the on-device asks) — done, verified on iPad sim:**
- [x] **Family Chores → per-person rows** with progress-ring avatar + name + done/total +
      stars (Kevin 0/3 ★1, Kelly 0/1 ★3, Wally 4/7 ★9, Lottie 0/2 ★2). Card → Chores page.
- [x] **Tonight's dinner → "View recipe" + "Cook Mode" buttons** (when a recipe is attached).
      Cook Mode jumps straight in via the new additive `RecipeDetailView.autoCook` flag.
- [x] **Grocery → real named list with checkboxes** (via `groceryBoard()`), optimistic
      check-off (`patchListItem`); card / "+N more" → Lists page.
- [x] **"This week's dinners" card** — planned-dinner rows (Tue · Wed …); card → Meals page.
- [x] Backed by `KioskTodayModel`; agenda rows → event detail sheet, "This week" → Calendar.
- [x] **Top banners** — "Needs your OK" approvals (→ `ApprovalsView`) + "N to review · M to
      link" goal recap (→ `ReviewEventsView`), pinned atop `KioskDashboard`, capability-gated
      and hidden when empty.

> **Phase 2 web-parity done.** The iPad Today closely mirrors the web (3 columns: agenda ·
> tonight + week dinners · per-person chores + grocery list), each widget linked to its page.
> (Dropped the standalone Goals card to match the web Today; Goals is its own rail page.)

## Phase 3 — Navigation shell + all pages (PRIORITY)

Make the iPad a *real app you navigate*, like the web. This is the main re-scoped work.

- [x] **Nav rail** — `KioskShell` (`Features/Kiosk/KioskShell.swift`): a fixed, always-visible
      left rail (Today, Calendar, Chores, Goals, Family, Meals, Lists, Photos, Settings;
      Settings pinned bottom). Used a fixed `HStack` rail (web-faithful, always visible)
      rather than a collapsible `NavigationSplitView`. `NOOK_KIOSK_PAGE` launch hook drives
      it headlessly for testing.
- [x] **Route each item to a working page**, reusing existing feature views — self-contained
      (`CalendarView`, `MealsView`, `FamilyView`) render directly; inner hub views
      (`GoalsView`, `ListsIndexView`, `SettingsView`) get a host `NavigationStack` + the shared
      `HubRoute` destination. **Verified interactive** on iPad sim: Today, Calendar, Chores,
      Meals, Goals, Settings (Family/Lists/Photos use the same proven wiring).
- [ ] **Top bar** — date/time + weather + the "Add anything" capture bar (web `Topbar`),
      so capture works from anywhere. (Today has its own header; other pages keep their own
      for now.)
- [ ] Then progressively **web-ify each page** for the iPad (multi-column where the web is,
      bigger type/spacing) instead of a stretched phone column. Track per-page below as we go:
  - [x] **Calendar** — `KioskCalendarView` (done, accepted): Month (grid + side day panel),
        Week & Day (time-grids with overlap lanes), and Agenda (upcoming list + mini-month +
        "heads up" AI digest + "whose week is busy" bars); person filters. Event detail +
        editor open as large `.page` modals on iPad (shared `KioskSheetPresentation`); detail
        is two-column. Test hooks: `NOOK_CAL_MODE`, `NOOK_KIOSK_OPEN_EVENT/EDIT`.
  - [x] **Chores** — `ChoresView` adaptive: iPad shows a wrapping Kanban (Up for grabs + one
        column per person; min-width columns, capped height + internal scroll), reusing all
        row logic (tick/claim/edit/drag-reassign). Compact approvals card on iPad.
  - [x] **Rewards** — own rail item (web combines Chores+Rewards; iPad splits them). Reachable;
        interior still phone layout.
  - [x] **Meals** — `WeekPlannerView` adaptive: iPad = 7-day grid of compact meal columns
        (drag-to-swap kept); `RecipesLibraryView` = adaptive multi-column gallery on iPad.
  - [x] **Lists** — `KioskListsView`: master/detail (lists sidebar + selected list's full
        detail incl. the grocery aisle/meal board). Reuses `ListDetailView`.
  - [x] **Goals** — featured hero kept; "More goals" now a multi-column grid on iPad.
  - [x] **Family** — `KioskFamilyView`: per-person overview grid (role, stars, chores
        progress, today's events) → person spotlight. Drops the rail-redundant hub tiles.
  - [x] **Photos** — `PhotosView` adaptive grid (2-col iPhone / wider iPad), album filter
        chips, upload (`PHPicker`), photo detail + edit (caption / album / **date** / favorite),
        per-tile delete, **multi-select** bulk move-to-album / delete, and the manual
        **"Play"** slideshow.
  - [x] **Settings** — every panel built and reachable (Family & people incl. the
        permissions grid, Calendars, Chores & Rewards incl. proof retention, Meals, AI,
        Display & Kiosk, Notifications, About). Only the **Lists** row is still "Soon".
- [x] Rail shows the signed-in person's avatar (`KioskShell.currentMember`).
- [ ] Capture sheet + detail sheets sized appropriately for the iPad.

## Phase 4 — Polish & ship

- [ ] iPad app icon / launch screen (universal asset catalog).
- [ ] Orientation behavior (landscape-first on iPad; phone stays portrait).
- [ ] App Store: single universal listing + iPad screenshots; listing copy.
- [ ] Update `apps/ios/README.md` with the iPad experience + how to run it.

## Phase 5 — Family-display / screensaver mode ✅ (shipped 2026-06-25)

Was demoted 2026-06-23, then built on request. `KioskScreensaverHost` + `ScreensaverView`,
driven by the same `DisplayConfig` (`Features/Settings/DisplayKioskSettingsView.swift`).

- [x] Idle watcher → screensaver after `screensaverMinutes`. A pass-through gesture
      recognizer on the window resets the idle clock on any touch without consuming it.
- [x] Screensaver content: clock + date + **weather** + **next event** + album overlay;
      photo **slideshow** with **crossfade** + slow **Ken-Burns**; `clock` and `off` modes.
- [x] Photo selection honors the config (source all/favorites/album, per-photo interval,
      shuffle) via `NookAPI.screensaverPhotos`. Decoded-image cache + prefetch keep the
      crossfade flash-free.
- [x] Night dimming on the `nightDim` schedule; keep-awake (`isIdleTimerDisabled`).
- [x] Manual **"Play"** (bare, chrome-free) from the Photos tab; **"Preview"** from
      Display & Kiosk settings.
- [x] **Slow-zoom (Ken-Burns) toggle** — device-local `@AppStorage` (the server display
      config whitelists fields, so a motion flag wouldn't persist there).
- [ ] Idle **reset-to-Today** after `resetHomeMinutes` (config exists; not wired yet).
- [x] `returnToPicker` — wired (Phase 6): on a shared kiosk, waking the screensaver drops
      the current person back to the profile picker.

---

## Phase 6 — Shared family kiosk (profile picker + PIN) ✅

Opt-in: an admin turns one iPad into a shared family display where everyone taps their own
face (optional PIN) to act as themselves. The default single-login behavior is untouched
unless enabled. Ports the web kiosk's device-token model — no server changes.

- [x] **Device identity layer** — `KioskDevice.swift`: long-lived `deviceSecret` in the
      Keychain, exchanged by `KioskDeviceAuth` (actor) for short-lived device access
      tokens (`POST /api/kiosk/device/token`), with a `deviceFetch` 401-refresh path in
      `NookAPI`. Separate from the per-person `AuthTokens` session.
- [x] **`NookAPI` kiosk calls** — `pairDevice` (code), `promoteDevice` (admin one-tap),
      `kioskProfiles`, `claimProfile` (returns the per-person session; throws
      `KioskClaimError.wrongPin(triesLeft:)` / `.lockedOut(retryAfter:)`), `setKioskDeviceLabel`,
      `kioskHeartbeat`.
- [x] **`KioskMode`** (`@Observable`, app-root env) — the state machine. "Show the picker"
      = paired AND no per-person session (`isShared && !AuthTokens.isSignedIn`). `KioskGate`
      wraps `AuthGate`; a paired-but-unclaimed iPad shows the picker instead of login.
- [x] **Profile picker + PIN pad** — `KioskProfilePickerView` (avatar/color grid, 🔒 on
      PIN'd profiles, 60s poll + heartbeat) and `KioskPinPad` (4–8-digit keypad,
      "N tries left" on 401, lockout countdown on 429). Matches `ProfilePicker.tsx` / `PinPad.tsx`.
- [x] **Session swap** — claim → `Session.enterClaimedSession` adopts the per-person tokens →
      `SyncManager.reauthenticate()` re-scopes PowerSync → the kiosk shell boots as that person.
- [x] **Enable + manage** — opt-in from **Settings → Display & Kiosk** (admin one-tap
      *promote*, or *pair with a code*; "Switch profile" / "Stop sharing" once shared) and a
      **"Set up this iPad as a shared kiosk"** link on the iPad login screen (code entry for
      a fresh device).
- [x] **Idle return-to-picker** — waking the screensaver with `returnToPicker` on drops the
      current person back to the picker (keeps the device paired).
- [x] **Tap-to-switch** — on a shared kiosk the signed-in person's avatar at the bottom of
      the rail (`KioskShell.currentUserChip`) is a button (swap badge) that returns to the
      picker in one tap — the discoverable twin of Settings → "Switch profile". Plain
      indicator (no behavior change) on a normal single-login iPad.
- [x] **Revoked-device self-heal** — if an admin unpairs the kiosk from elsewhere, the dead
      device token (401) forgets the local pairing and falls back to login (mirrors web
      `clearKioskDevice`) instead of a stuck "No profiles" picker.
- [x] **Escape hatch on the picker** — a discreet gear (bottom-right) opens
      `KioskPickerEscapeSheet`: check/fix the **server address** (mints a fresh device token
      and retries in place) or **exit shared kiosk** (forgets the pairing locally → back to
      sign-in). Without it, a device pointed at a bad server or remotely unpaired was stranded
      on the picker with no on-device recovery.
- [x] **Claim decode fix** — the claim response's embedded `person` object omits `hasPin`
      (only the picker *list* includes it). `KioskProfile.hasPin` was a required `Bool`, so
      the present-but-incomplete `person` threw a `DecodingError` that `KioskMode.claim`
      reported as a bogus **"Couldn't reach the server"** — every profile tap failed. Made
      `hasPin` tolerant of absence (`decodeIfPresent ?? false`); proven against the real
      payload. Also: `claimProfile` now passes `retryOn401: false` so a wrong-PIN 401 isn't
      silently re-submitted (which burned two attempts per tap and raced the lockout).
- Verified end-to-end against the running server (promote → device token → profiles →
  claim → wrong-PIN `triesLeft`) and on the iPad simulator (picker + PIN pad + login entry
  point). iPhone is unaffected — the gate is a no-op off the iPad idiom.
- ⚠️ The picker/PIN/device-token code must stay in sync with `apps/web/src/kiosk/*` +
  `apps/web/src/lib/api/kiosk.ts`; each file carries a KEEP-IN-SYNC header.

---

## Backlog — deferred, with enough context to resume

### A. Multi-profile shared kiosk (Netflix-style picker) ✅ — see Phase 6

Shipped — promoted out of the backlog. (Original note kept below for context.)

Shared-display flow: device rests on a **profile picker**, anyone taps in (optional PIN),
ephemeral session, auto-logs-out on idle. The **web kiosk already does this** — port it.
- Web: `ProfilePicker.tsx`, `PinPad.tsx`, `PairDevice.tsx`, device-secret auth in
  `lib/api/kiosk.ts`, `AuthGate.tsx` picker logic.
- v1's single-profile login is a clean subset; the picker is additive.

### B. Nice-to-haves & known gaps

- [x] **iPad Today banners** — "Needs your OK" approvals + goal-recap review banners on
      `KioskDashboard` (open `ApprovalsView` / `ReviewEventsView`).
- [ ] Per-card customize / reorder on **iPad** Today (iPhone + web have draggable cards;
      iPad currently uses fixed layout presets).
- [x] **Recurring events** — full picker in `EventEditSheet` (Daily / Weekdays / Weekly +
      day chips / Monthly / Custom "every N"), per-occurrence scope chooser on edit + delete
      (this / following / all), an end condition (never / on a date / after N), and any
      monthly ordinal (first…fifth / last). `Recurrence.swift` ports web's `recurrence.ts`
      (covered by `RecurrenceTests`); recurring writes route through REST so the server
      materializes occurrences.
- [x] **Calendar polish** — live red "now" line on the time grids (iPad Week/Day +
      iPhone Day); month cells show event titles (not times); iPhone agenda dims past events.
- [x] **Recipe from Today** opens full-screen (not a cramped iPad page-sheet); Cook Mode
      uses large centered type that scrolls long steps.
- [x] **Photos:** multi-select bulk move-to-album / delete (Select mode → tap tiles →
      Move / Delete bar; loops the per-photo REST endpoints). Editing a photo's **date**
      PATCHes `taken_at` and the edit sheet now returns to read mode showing the change.
- [x] **Goal-focused Today preset** (iPad) — a fourth dashboard layout beside Balanced /
      Agenda / Meals that features a goal big (progress ring · per-person bars · one-tap
      **Log progress** via the shared `GoalLogSheet`), with a picker to pin any goal (the
      green Goals-page hero treatment). The goal column also surfaces **tonight's dinner**
      (falling back to the week's dinners) in its headroom.
- [x] **In-app recipe editor** (iPhone + iPad) — full create/edit: emoji/title/servings/
      prep/cook, the metadata Details with **AI auto-fill** ("✨ Thinking…", fills empty
      fields / suggestion chips), ingredient rows, method steps with **per-step ingredient
      amounts**, and notes. **Paste-markdown import** (paste → parse → fills the form for
      review). Title auto-focus + Return-to-add-row keyboard flow. Reached from the library
      "New" pill and the recipe-detail ⋯ menu (the old tags modal is gone).
- [x] **Recipe time** — the library card shows the **combined total** (prep + cook); the
      detail page splits it into 🔪 prep + 🔥 cook.
- [x] **On-device capture heuristic + instant→LLM flow** — `CaptureHeuristic.swift` (a port
      of web `parse.ts`, kept in sync, byte-parity test suite) parses the "Add anything…" bar
      locally. `CaptureSheet` shows the on-device guess **instantly** with an "improving…"
      tag while the LLM runs in the background, then upgrades; on a **kind-disagreement** with
      a confident guess it keeps the local one and offers the LLM's take as a one-tap pick;
      and it **backfills a recurrence** the (deterministic) heuristic found when a weak LLM
      drops it. With no server reachable, capture still works fully on-device.
- [x] **Screensaver vs modals** — the idle screensaver no longer starts while a sheet /
      full-screen cover is open (it presents above the app tree, so it rendered *under* the
      modal); the idle clock holds until the modal is dismissed.
- [x] **Calendar swipe** — swipe left/right on the grid to step month / week / day on
      both iPhone and iPad (simultaneous gesture; vertical time-grid scroll still works).
- [x] **Chore photo proof confirm** — a freshly-taken/picked proof shows a "Use this
      photo / Retake" preview before it uploads, so an accidental library tap can't submit.
- [x] **Capture sheet** opens tall and focuses the field instantly — the LLM warm-up +
      list/currency loads moved off the critical path (they used to freeze it ~10s).
- [x] **Family Chores** card person rows (iPad) open the Chores page too, not just the header.
- [ ] **Chore reminders** (local notifications) — blocked on chores landing in PowerSync
      (the scheduler reads off the synced mirror; chores are REST-only today).
- [ ] **Recurring-event reminders** — `NotificationManager` doesn't expand recurrences yet.
- [ ] **Recipe import** (paste-markdown) and **AI metadata auto-fill** on iOS (web-only).
- [ ] **Remote push** (APNs) so reminders fire with the app closed (blocked on key/relay).
- [ ] **Household-wide screensaver motion** — the Ken-Burns toggle is per-device
      (`@AppStorage`) because the server `sanitizeDisplay` drops unknown fields; making it
      household-wide needs `photoMotion` added to the API + web.
- [ ] **Settings → Lists** panel (currently a "Soon" row).

---

## Reference — current state

- Root nav today: custom bottom tab bar in `App/AppRoot.swift` (iPhone); iPad forks to
  `KioskRoot` → `KioskDashboard`. No `NavigationSplitView` yet (Phase 3 adds it).
- Existing reusable feature views: `Features/Calendar/CalendarView`, `Features/Meals/*`,
  `Features/Family/*` + `HubDestination` (chores/goals/rewards/lists/photos/settings),
  `Features/Today/TodayView` (the iPhone dashboard, mirrors the web `Today`).
- Data layer: `SyncManager` (PowerSync), `NookAPI`, `DashboardModel`, `Theme.swift` tokens.
- Web app we're mirroring: `apps/web/src/kiosk/` — `KioskLayout` (rail + topbar + outlet),
  `nav.ts` (the rail items), `Today.tsx` (the dashboard), per-feature pages.
- On-device LAN testing: see memory `ipad-on-device-lan` (set app "Server address" to the
  Mac's LAN IP).
