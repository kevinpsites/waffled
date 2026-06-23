# Nook iPad — Project Roadmap

A living checklist for bringing Nook to iPad as a **full, interactive, web-like native
app**. Check items off as we land them; keep the rationale notes so we don't lose context
about *why* a decision was made or *what's deferred and why it's safe to defer*.

> **Status:** Phases 0–2 done (universal app, single-profile login, Today dashboard).
> Re-scoped 2026-06-23: the iPad is a **full app like the web** — sidebar nav + every page,
> fully interactive — not just a dashboard. The screensaver is now low-priority.

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
4. **Single-profile, no picker (for now).** iPad signs in once and *stays* — one profile,
   no picker, no switching. Normal persistent login (Keychain + 401-refresh). Full
   interactivity does **not** require multi-profile; the shared profile-picker flow stays
   **deferred** (see Backlog) and layers on top without rework.
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
- [ ] (Optional) Pull the top banners over too — "Needs your OK" approvals + "to review/link"
      (the iPhone `ApprovalsBanner` / review card already exist).

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
  - [x] **Calendar** — `KioskCalendarView`: width-filling month grid (event chips per day)
        + side day panel + person filters. (Pending user feedback.)
  - [ ] Tasks/Chores · [ ] Goals · [ ] Family · [ ] Meals · [ ] Lists · [ ] Photos · [ ] Settings
- [ ] Capture sheet + detail sheets sized appropriately for the iPad.

## Phase 4 — Polish & ship

- [ ] iPad app icon / launch screen (universal asset catalog).
- [ ] Orientation behavior (landscape-first on iPad; phone stays portrait).
- [ ] App Store: single universal listing + iPad screenshots; listing copy.
- [ ] Update `apps/ios/README.md` with the iPad experience + how to run it.

## Phase 5 — Family-display / screensaver mode (LOW priority)

Demoted 2026-06-23: a *secondary* idle/display overlay, not core. (The web's own
screensaver isn't fully baked either.) Driven by the same `DisplayConfig`
(`Features/Settings/DisplayKioskSettingsView.swift` already reads/writes it).

- [ ] Idle watcher → screensaver after `screensaverMinutes`; reset to Today after
      `resetHomeMinutes`.
- [ ] Screensaver content: clock + weather + next event; photos slideshow; `off`.
- [ ] Night dimming on the `nightDim` schedule; keep-awake (`isIdleTimerDisabled`).
- [ ] `returnToPicker` — no-op until multi-profile lands.

---

## Backlog — deferred, with enough context to resume

### A. Multi-profile shared kiosk (Netflix-style picker)

Shared-display flow: device rests on a **profile picker**, anyone taps in (optional PIN),
ephemeral session, auto-logs-out on idle. The **web kiosk already does this** — port it.
- Web: `ProfilePicker.tsx`, `PinPad.tsx`, `PairDevice.tsx`, device-secret auth in
  `lib/api/kiosk.ts`, `AuthGate.tsx` picker logic.
- **Missing server-side (either platform):** no device→person binding — `kiosk_devices`
  has no `claimed_person_id` / auto-claim / "skip picker". A device pairs to a *household*,
  then `claim(personId)` mints a per-profile session.
- v1's single-profile login is a clean subset; the picker is additive.

### B. Nice-to-haves

- [ ] Per-card customize / reorder on Today (web has draggable cards + the `Customize` button).
- [ ] Recurrence **creation** on iOS (currently read-only; creation is web-only).

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
