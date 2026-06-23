# Nook iPad — Project Roadmap

A living checklist for bringing Nook to iPad as a **family display / kiosk**. Check
items off as we land them; keep the rationale notes so we don't lose context about
*why* a decision was made or *what's deferred and why it's safe to defer*.

> **Status:** Planning. No iPad code written yet. `apps/ios` is still iPhone-only.

---

## The vision (two products, one app)

- **iPhone** = the *personal planner* — the native app we already have. An individual
  checks their day, captures events, manages their stuff. **Untouched by this work.**
- **iPad** = the *family display / kiosk* — a wall- or counter-mounted hub, viewed from
  across the room, that looks closer to the web dashboard: big agenda, tonight's meal,
  chores, goals, plus a screensaver (clock / weather / photos).

Both ship in **one universal app** — same bundle ID (`com.kevinsites.nook`), one App Store
listing, one download. The device picks the right experience at runtime by size class /
idiom. We are **not** shipping a second app.

---

## Decisions locked in (don't relitigate without a reason)

1. **Universal app, not a separate target.** Flip `TARGETED_DEVICE_FAMILY` to `"1,2"`.
   One binary, one listing. iPad layouts live behind size-class / idiom checks inside the
   same app.
2. **Native SwiftUI, not a WKWebView wrap of the web kiosk.** Rationale: the user's core
   pain is that the web kiosk renders *too small* on the iPad's dense display (it's
   px-pinned, tuned for a 1280×800 counter tablet at arm's length, with no root font-size
   or scale factor to turn — fixing it cleanly means converting ~500+ px values *in the
   web app*, which also leaks into every web user). Native gives us exact sizing control
   (size classes + Dynamic Type) for at-a-distance reading — the one thing we most need.
3. **Reuse the existing iOS data layer.** `SyncManager` (PowerSync), `NookAPI`, the design
   tokens in `DesignSystem/Theme.swift` (already ported 1:1 from the web), and the existing
   `DisplayConfig` read/write (`Features/Settings/DisplayKioskSettingsView.swift`) all carry
   over. The iPad work is **screens**, not a new data/sync/auth stack.
4. **v1 is single-profile, no picker.** iPad signs in once and *stays* — one profile, no
   profile-picker round-trip, no switching. This is just a **normal persistent login**
   (refresh-token persistence + Keychain token store + 401-refresh already exist). **Zero
   new server work for v1.** The shared multi-profile picker / PIN / device-pairing is
   explicitly **deferred** (see Backlog) and layers on top without rework.
5. **v1 is kiosk-only.** "iPad as a personal planner" (a signed-in individual using the
   iPad like a big iPhone, with adaptive planner screens) is **deferred** (see Backlog).

---

## Phase 0 — Make the app run on iPad at all

Goal: the existing app launches on an iPad simulator as a universal binary, even if it
just looks like a big phone for now. Establishes the target + adaptivity scaffolding.

- [x] `project.yml`: set `TARGETED_DEVICE_FAMILY: "1,2"` (was `"1"`).
- [x] `project.yml`: iPad orientations via `UISupportedInterfaceOrientations~ipad`
      (landscape + portrait); phone stays portrait-only.
- [x] `UIRequiresFullScreen`: **Decided — leave unset for now** (iPad multitasking stays
      enabled). Revisit and lock to full-screen when we ship a dedicated kiosk mode, so a
      wall display can't be shrunk into a Stage Manager split.
- [x] `xcodegen generate` + build for iPad sim (iPad Pro 13-inch M4) — **BUILD SUCCEEDED**,
      runs and renders the kiosk fork (verified with a dev token + screenshot).
- [x] Idiom helper: `DeviceExperience` (`App/DeviceExperience.swift`) — `.planner` (iPhone)
      vs `.kiosk` (iPad), branched on `userInterfaceIdiom`. First adaptive code in the tree.
- [x] Entry fork: `RootView` in `NookApp.swift` chooses `AppRoot` (iPhone) vs `KioskRoot`
      (iPad, `Features/Kiosk/KioskRoot.swift`). iPhone path is byte-for-byte unchanged.

> **Phase 0 complete.** Universal binary boots into the kiosk fork on iPad; iPhone planner
> untouched. `KioskRoot` is a placeholder — Phase 1/2/3 fill it in.

## Phase 1 — Single-profile auth path

Goal: the iPad signs in once and stays logged in as one profile, no picker.

- [x] Persistent-login path confirmed: `Session.bootstrap()` → `AppConfig.hasUsableToken`
      (`AuthTokens.isSignedIn`) sends a stored Keychain session straight to `.authed`, so
      the iPad stays signed in across relaunches. Reused as-is — nothing rebuilt.
- [x] Kiosk-appropriate sign-in: `LoginView` (`Features/Auth/AuthGate.swift`) now scales up
      and caps to a centered column on iPad (`isKiosk` / `columnWidth`), with display-specific
      copy ("Set up your Nook display"). Verified on the iPad sim. iPhone login unchanged
      (guarded by `isKiosk`; the column cap is wider than phone content).
- [x] No profile picker, no PIN, no "Switch profile" in v1 — none exists in the kiosk path;
      the signed-in profile *is* the device's identity.
- [x] Token-expiry is graceful: the `.nookAuthExpired` path flips `Session.phase` to `.login`,
      which on iPad shows the same kiosk login (not a dead screen).
      **Note / follow-up:** refresh-token lifetime is server-side — confirm it's long enough
      for an always-on display so a wall device isn't forced to re-login often. (Auth0 swaps
      in at Phase 4; revisit token TTLs then.)

> **Phase 1 complete.** iPad signs in once and stays (single profile, no picker), with a
> display-sized login that also covers re-auth after expiry.

## Phase 2 — The family-hub dashboard (the main screen)

Goal: a wall-sized, native dashboard sized for across-the-room reading — the "looks like
web" payoff. Native equivalent of the web `Today` dashboard.

- [ ] `KioskRoot` / `KioskDashboard` view — landscape, multi-column, big type/spacing.
- [ ] Cards, sized large and reusing existing data from `SyncManager`:
  - [ ] Agenda (this week / upcoming) — scrollable fill card.
  - [ ] Tonight's meal + this week's dinners.
  - [ ] Chores due (family-wide).
  - [ ] Goals.
  - [ ] (Optional) grocery / lists.
- [ ] Header: date + time (serif, large) + weather, in household timezone — mirror the web
      `Topbar`.
- [ ] Sizing pass: tune type scale, card sizes, and spacing for *distance* viewing — this
      is the whole reason we went native; don't ship phone-sized cards.
- [ ] Reuse `DesignSystem/Theme.swift` tokens; introduce iPad-scale constants where the
      phone values are too small (a kiosk type/spacing scale).

## Phase 3 — Screensaver / idle / display behavior

Goal: native equivalent of the web screensaver layer, driven by the **same** `DisplayConfig`
the iOS settings already manage. Server already serves it; we just render it.

- [ ] Read `DisplayConfig` (`screensaverMinutes`, `content` = photos/clock/off,
      `resetHomeMinutes`, `nightDim {enabled,start,end}`, `returnToPicker`). The model +
      API call already exist in the iOS app (`NookAPI.DisplayConfig`).
- [ ] Idle watcher: after `screensaverMinutes`, show screensaver; after `resetHomeMinutes`,
      reset to the dashboard.
- [ ] Screensaver content:
  - [ ] Clock + weather + next event overlay.
  - [ ] Photos slideshow (cycle), with the clock overlaid.
  - [ ] `off` = no screensaver.
- [ ] Night dimming: dim overlay on the `nightDim` schedule (handle overnight wrap).
- [ ] Keep-awake: prevent the iPad from sleeping while in kiosk mode
      (`UIApplication.isIdleTimerDisabled`) — the native, reliable equivalent of the web's
      `navigator.wakeLock`.
- [ ] `returnToPicker` is a **no-op in v1** (no picker yet) — wire it when multi-profile lands.

## Phase 4 — Polish & ship

- [ ] iPad app icon / launch screen check (universal asset catalog).
- [ ] Real-device test on an actual iPad mounted/at distance — verify legibility.
- [ ] Orientation lock behavior (landscape kiosk vs phone portrait).
- [ ] App Store: confirm the single universal listing shows iPad screenshots; update
      listing copy to mention the family-display use.
- [ ] Update `apps/ios/README.md` to document the iPad kiosk mode + how to run it on the sim.

---

## Backlog — deferred, with enough context to resume

These were **intentionally** deferred to keep v1 small. Each layers on top of v1 without
throwing it away.

### A. Multi-profile shared kiosk (Netflix-style picker)

The shared-display flow: device rests on a **profile picker**, anyone taps in (optional
PIN), gets an ephemeral session, auto-logs-out on idle. This is what the **web kiosk already
does** — port the model, don't reinvent it.

- The web has: `ProfilePicker.tsx`, `PinPad.tsx`, `PairDevice.tsx`, device-secret auth in
  `lib/api/kiosk.ts`, and `AuthGate.tsx` picker-vs-app logic.
- **Missing even on the server** (would need building for *either* platform): there is **no
  device→person binding** — `kiosk_devices` has no `claimed_person_id`, no auto-claim
  endpoint, no "skip picker" setting. A device pairs to a *household*, then `claim(personId)`
  mints a per-profile session.
- iPad work when we pick this up: native profile picker + PIN pad, device-pairing flow
  (pairing code entry + device naming), device-secret auth layer, ephemeral session
  handling, and wiring `returnToPicker` (Phase 3) to drop back to the picker on wake.
- v1's single-profile login is a clean subset — adding the picker is additive.

### B. iPad as a personal planner

Let the iPad *also* run as one person's signed-in planner (a big-iPhone experience),
chosen at setup, not just a shared display.

- Needs adaptive iPad layouts for the *planner* screens (Today, Calendar, Chores, Goals,
  etc.) — `NavigationSplitView` sidebar + detail rather than the phone's bottom tab bar.
- Today every planner screen is single-column phone-shaped; this is the larger layout
  effort we deliberately scoped out of v1.
- The Phase 0 idiom fork + size-class scaffolding is the hook this hangs off of.

### C. Nice-to-haves

- [ ] Per-card customization / reorder on the kiosk dashboard (web `Today` has draggable
      cards).
- [ ] Recurrence **creation** on iOS (currently read-only on iOS; creation is web-only).
- [ ] Guided in-app "set this iPad up as your family display" onboarding.

---

## Reference — current state (as of planning)

- `apps/ios/project.yml`: `TARGETED_DEVICE_FAMILY: "1"`, portrait-only, deployment iOS 18.
- Root nav: custom bottom tab bar in `Sources/Nook/App/AppRoot.swift` (not `TabView`);
  tabs: today / calendar / meals / family.
- **Zero** adaptive/size-class code anywhere in `Sources/`.
- Data layer ready to reuse: `SyncManager` (PowerSync), `NookAPI`, `DesignSystem/Theme.swift`.
- `DisplayConfig` already read/written by `Features/Settings/DisplayKioskSettingsView.swift`
  (today it *remote-controls* the web kiosk; the iPad will *be* a display that consumes it).
- Web kiosk (the experience we're nativizing): `apps/web/src/kiosk/` — `KioskDisplay.tsx`,
  `KioskLayout.tsx`, `Today.tsx`, `components/Screensaver.tsx`, `ProfilePicker.tsx`,
  `PinPad.tsx`; config shape in `apps/web/src/lib/api/kiosk.ts`.
