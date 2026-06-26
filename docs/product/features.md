# Feature support matrix

Every Nook feature and whether it's supported on each surface.

- **Web / Kiosk** — the React app (same build powers the desktop browser and the kitchen
  tablet kiosk).
- **iPhone** — the native iOS app's *personal-planner* experience (`AppRoot` + bottom tab
  bar; one person checking their day).
- **iPad** — the **same** universal app's *family-hub* experience (`KioskRoot` → a left nav
  rail + every page, re-laid-out big; runs on the counter). One binary, one App Store
  listing — the device picks the experience by idiom (`DeviceExperience`).
- **Status** — where the feature sits on the [roadmap](./roadmap.md).

Legend: ✅ supported · 🟡 partial · 🚧 planned · ❌ not supported / N-A

> **iPhone vs iPad.** Most feature screens are *shared* and adapt by size; the iPad adds
> distinct wide layouts (`KioskDashboard`, `KioskCalendarView`, `KioskListsView`, the
> Kanban chores board, the **screensaver**) on top of the same `SyncManager`/`NookAPI`
> data layer. iPad-only items (screensaver, ambient display) read ❌ N/A on iPhone;
> shared-but-web-only admin actions (first-run setup, OIDC config) read ❌ on both.
> Multi-profile kiosk pairing/picker is **deliberately deferred** on mobile (single
> persistent login), so those rows are ❌ N/A on both. See
> [`apps/ios/IPAD_ROADMAP.md`](../../apps/ios/IPAD_ROADMAP.md) for the mobile build plan.

---

## Accounts, onboarding & identity

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| First-run **setup wizard** (create household + admin) | ✅ | ❌ N/A | ❌ N/A | ✅ Done — **web/server-only by design**, not planned for mobile (mobile shows a "finish setup on the web" notice) |
| **Email/password** login (built-in) | ✅ | ✅ | ✅ | ✅ Done |
| Rotating refresh tokens + transparent 401-refresh | ✅ | ✅ | ✅ | ✅ Done (Keychain token store) |
| **OIDC SSO** (backend-mediated, invite-gated) | ✅ | ✅ | ✅ | ✅ Done (`ASWebAuthenticationSession`) |
| Admin-managed OIDC config (Settings, secret encrypted at rest) | ✅ | ❌ N/A | ❌ N/A | ✅ Done — web/server-only admin by design |
| Disable password login / force SSO (break-glass guard) | ✅ | ❌ N/A | ❌ N/A | ✅ Done — web/server-only admin by design |
| **Member management** — grant a person a login (email ± password) + kiosk PIN | ✅ | ✅ | ✅ | ✅ Done |
| **Members CRUD** (profiles: name, avatar, color, role, admin, birthday) | ✅ | ✅ | ✅ | ✅ Done |
| **Role-based permissions** — per-role capability grid (Settings → Family); [model](./permissions.md) | ✅ | ✅ | ✅ | ✅ Done (editable matrix, admin-only) |
| Sign out (revokes refresh) | ✅ | ✅ | ✅ | ✅ Done |

## Kiosk & ambient display

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **Kiosk device pairing** (admin code or "use this device") | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web); mobile is single-login (deferred) |
| **Profile picker** (Netflix-style; per-profile real session) | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web); mobile deferred |
| Optional per-person **PIN** to open a profile (throttled) | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web); mobile deferred |
| Rail "Switch" + idle return to picker | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web); mobile deferred |
| Idle **screensaver** auto-start (after N min of no touch) | ✅ | ❌ N/A | ✅ | ✅ Done |
| Screensaver **photo slideshow** + **crossfade** transitions | ✅ | 🟡 | ✅ | ✅ Done (iPhone via manual "Play"; iPad idle + manual) |
| Screensaver chrome: clock · date · **weather** · **next event** · album | ✅ | 🟡 | ✅ | ✅ Done (iPhone bare "Play" omits chrome) |
| Screensaver settings (source all/favorites/album, speed, shuffle) | ✅ | ✅ | ✅ | ✅ Done (Display & Kiosk) |
| **Live "Preview"** of the screensaver from settings | ✅ | ✅ | ✅ | ✅ Done |
| **Night dimming** on a schedule (overnight) | ✅ | ❌ N/A | ✅ | ✅ Done |
| Keep-awake while displaying (`isIdleTimerDisabled`) | ✅ | ❌ N/A | ✅ | ✅ Done |
| **Slow-zoom (Ken-Burns)** toggle | ❌ | 🟡 | ✅ | ✅ Done (iOS-only; device-local `@AppStorage`) |
| **Live weather** (Open-Meteo, no key) | ✅ | ✅ | ✅ | ✅ Done (Today + screensaver) |
| Branded **cold-start cover** while the first sync lands | ✅ | 🟡 | ✅ | ✅ Done (iPad nest + pulse; iPhone uses the auth splash) |
| Single-login mode (no pairing) — default | ✅ | ✅ | ✅ | ✅ Done |

## Today dashboard

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Today cards: agenda · tonight's meal · this week · chores · grocery | ✅ | ✅ | ✅ | ✅ Done (iPad = distinct 3-column `KioskDashboard`) |
| **Customize** mode — drag to reorder cards | ✅ | ✅ | 🟡 | ✅ Done (iPhone reorder+hide; iPad uses layout presets) |
| iPad Today **layout presets** (Balanced / Agenda / Meals / **Goal-focused**) | 🟡 | ❌ N/A | ✅ | ✅ Done (iPad-only; Goal-focused features a goal big + tonight's dinner) |
| Save layout **for me** (per-user) vs **for everyone** (family default) | ✅ | ✅ | 🟡 | ✅ Done (iPad layout is device-local) |
| Mobile-specific Today layout (separate `{order,hidden}` config) | ❌ N/A | ✅ | ✅ | ✅ Done |
| "Did these happen?" goal recap queue on Today | ✅ | ✅ | ✅ | ✅ Done (iPad banner opens `ReviewEventsView`) |
| "Needs your OK" approvals banner on Today | ✅ | ✅ | ✅ | ✅ Done (iPad banner opens `ApprovalsView`) |

## Calendar & events

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Native events (create / edit / delete) | ✅ | ✅ | ✅ | ✅ Done |
| **Multiple participants** per event (stacked avatars, per-person color) | ✅ | ✅ | ✅ | ✅ Done |
| Views: **Month / Week / Day / Agenda** | ✅ | ✅ | ✅ | ✅ Done (iPad = `KioskCalendarView` grids) |
| **Current-time "now" line** on the time grid (Week/Day) | ✅ | ✅ | ✅ | ✅ Done (live red rule; iPhone Day + iPad Week/Day) |
| Month cells show **event titles** (tap a day for times) | ✅ | ✅ | ✅ | ✅ Done |
| Agenda **dims past events** | ✅ | ✅ | — | ✅ Done (iPhone agenda) |
| Full-screen **event detail** (location/Directions, repeats, notes, timeline) | ✅ | ✅ | ✅ | ✅ Done (iPad detail is two-column) |
| Per-person filter | ✅ | ✅ | ✅ | ✅ Done |
| **Two-way Google Calendar sync** (inbound poll + outbound push) | ✅ | ✅ | ✅ | ✅ Done (sync runs server-side; connect in Settings → Calendars) |
| Connect calendars + per-person write-target (Settings → Calendars) | ✅ | ✅ | ✅ | ✅ Done |
| **Offline** calendar (PowerSync: local reads + queued writes) | ✅ | ✅ | ✅ | ✅ Done |
| AI **"Heads up this week"** digest + **per-event insight** | ✅ | ✅ | ✅ | ✅ Done |
| "Counts toward a goal" tag on an event | ✅ | ✅ | ✅ | ✅ Done |
| **Recurring events** — rrule **expansion / read** | ✅ | ✅ | ✅ | ✅ Done |
| **Recurring events** — **creation** (Daily/Weekdays/Weekly+days/Monthly/Custom) | ✅ | ✅ | ✅ | ✅ Done (repeat picker in the editor) |
| **Recurring events** — per-occurrence **edit scope** (this / following / all) | ✅ | ✅ | ✅ | ✅ Done (scope chooser on edit + delete) |
| **Recurring events** — **end condition** (never / on a date / after N) | ✅ | ✅ | ✅ | ✅ Done (UNTIL date + COUNT) |
| **Recurring events** — monthly **nth-weekday ordinal** (first…fifth / last) | ✅ | ✅ | ✅ | ✅ Done (mobile offers any ordinal) |

## Tasks & chores

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Chores CRUD (assign person, stars/currency) | ✅ | ✅ | ✅ | ✅ Done |
| Daily instances + complete → award | ✅ | ✅ | ✅ | ✅ Done |
| Family-chores **rings** (Today) + Tasks board | ✅ | ✅ | ✅ | ✅ Done (iPad = wrapping Kanban) |
| **Weekly/custom schedules** (specific weekdays) | ✅ | ✅ | ✅ | ✅ Done |
| **One-off / carry-over task** (single day, stays until done) | 🚧 | 🚧 | 🚧 | 🚧 Planned (today every chore defaults to daily; Today is `due_on = today`, no overdue carry) |
| **Up-for-grabs** claim (unassigned → person) | ✅ | ✅ | ✅ | ✅ Done |
| **Drag-to-reassign** chores between columns | ✅ | ✅ | ✅ | ✅ Done |
| **Parent-approval** step (awaiting → approve/reject) | ✅ | ✅ | ✅ | ✅ Done |
| **Streaks** (🔥N consecutive days) | ✅ | ✅ | ✅ | ✅ Done |
| **Photo proof** — per-chore "Requires a photo"; camera/library on complete | ✅ | ✅ | ✅ | ✅ Done |
| Photo-proof **review** (tap thumbnail → large photo → Approve/Not-yet) | ✅ | ✅ | ✅ | ✅ Done |
| Proof **retention** — auto-delete after N days (default 3, admin setting) | ✅ | ✅ | ✅ | ✅ Done |
| Stored-proof **review & delete** gallery (view / delete / clear all) | ✅ | ✅ | ✅ | ✅ Done |
| **Capability gating** — `chore.manage` / `chore.approve`; anyone may add for self/up-for-grabs | ✅ | ✅ | ✅ | ✅ Done |

## Rewards & economy

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Stars **earn ledger** (append-only) + balances | ✅ | ✅ | ✅ | ✅ Done |
| **Rewards catalog** + redeem → parent-approve → ledger debit | ✅ | ✅ | ✅ | ✅ Done |
| Per-kid **balances** + approval queue (Rewards tab) | ✅ | ✅ | ✅ | ✅ Done |
| **Multi-currency** (custom currencies, symbols, colors) | ✅ | ✅ | ✅ | ✅ Done |
| **Conversions / "Trade"** (e.g. 10 ⭐ → 1 💵) | ✅ | ✅ | ✅ | ✅ Done |
| **Saving-toward** a reward — bar/jar progress + inline redeem | ✅ | ✅ | ✅ | ✅ Done |
| **Capability gating** — `reward.manage` / `reward.approve`; anyone may redeem for self | ✅ | ✅ | ✅ | ✅ Done |
| Milestone reward **payouts** | 🚧 | 🚧 | 🚧 | 🚧 Deferred (design done) |

## Goals

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Goal types: count / total / habit / checklist | ✅ | ✅ | ✅ | ✅ Done |
| Goal **lists** + membership (shared lists / individual) | ✅ | ✅ | ✅ | ✅ Done |
| Shared-pool vs each-tracks goals | ✅ | ✅ | ✅ | ✅ Done |
| Create / **edit** / delete goals | ✅ | ✅ | ✅ | ✅ Done |
| Type-aware **logging** (amount / stepper / once-a-day / tick steps) | ✅ | ✅ | ✅ | ✅ Done |
| Backdated logs ("When?" picker) | ✅ | ✅ | ✅ | ✅ Done |
| **Goal detail** read-model (milestone track, hours-by-person, streaks, recent) | ✅ | ✅ | ✅ | ✅ Done |
| Checklist **named steps** + per-type **milestones** (text) | ✅ | ✅ | ✅ | ✅ Done |
| **Person profile** + **Family overview** | ✅ | ✅ | ✅ | ✅ Done (iPad = `KioskFamilyView` grid) |
| **Calendar → goal** auto-count recap (single events) | ✅ | ✅ | ✅ | ✅ Done (Phase 1) |
| Smart "might count toward a goal" suggestions + learning | ✅ | ✅ | ✅ | ✅ Done (Phase B) |
| Recurring-event goal counting | ✅ | ✅ | ✅ | ✅ Done |
| **Capability gating** — `goal.manage` for others' / shared goals; own progress stays open | ✅ | ✅ | ✅ | ✅ Done |

## Lists & groceries

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Custom **multi-lists** (sectioned items, quantities, assignees) | ✅ | ✅ | ✅ | ✅ Done (iPad = master/detail) |
| Create / rename / delete lists (cascade) | ✅ | ✅ | ✅ | ✅ Done |
| **Auto-built grocery board** from the week's dinners | ✅ | ✅ | ✅ | ✅ Done |
| **Aisle grouping** + **quantity merge** (By aisle / By meal) | ✅ | ✅ | ✅ | ✅ Done |
| **Pantry staples** (kept off the list; Pantry check) | ✅ | ✅ | ✅ | ✅ Done |
| Check off / add / delete (persists) | ✅ | ✅ | ✅ | ✅ Done |
| **Item attribution** — "added by {name}" / "🍽 from meal plan" | ✅ | ✅ | ✅ | ✅ Done |
| **Cross-surface live refresh** (Today ↔ Lists ↔ Rewards) | ✅ | ✅ | ✅ | ✅ Done (in-app refresh bus) |

## Meals & recipes

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **Weekly** meal planner grid + recipe picker | ✅ | ✅ | ✅ | ✅ Done |
| **Month** meal view + planner | ✅ | ✅ | ✅ | ✅ Done |
| Drag-to-swap on week/month grid | ✅ | ✅ | ✅ | ✅ Done |
| Full-screen **recipe detail** (hero image, metadata chips, servings scaler) | ✅ | ✅ | ✅ | ✅ Done |
| **Total time** on the card (prep + cook); prep/cook split on the detail | ✅ | ✅ | ✅ | ✅ Done (mobile) |
| **Recipes library** (search-all, multi-select filters, sort) | ✅ | ✅ | ✅ | ✅ Done |
| Create / **edit** recipes in-app (all metadata + ingredients + steps) | ✅ | ✅ | ✅ | ✅ Done (full editor — shared iPhone/iPad; **per-step ingredient amounts**; delete is web-only) |
| **Paste-markdown** recipe import (template/example) | ✅ | ❌ | ❌ | 🟡 Web-only |
| Per-recipe **overrides** (substitutions, notes) | ✅ | 🟡 | 🟡 | ✅ Done (notes; full overrides on web) |
| **Cook mode** (step-by-step, wake-lock, finish → mark cooked) | ✅ | ✅ | ✅ | ✅ Done (centered, large type; scrolls long steps) |
| Cook-mode **recipe overview** (jump to any step + ingredients) | ✅ | ✅ | ✅ | ✅ Done (mobile; large sheet) |
| Open recipe **full-screen** from Today | ✅ | ✅ | ✅ | ✅ Done (iPad opens full-screen, not a page-sheet) |
| **Grocery auto-build** honoring substitutions | ✅ | ✅ | ✅ | ✅ Done |
| AI **Plan my week / month** (library-only, themes, gaps) | ✅ | ✅ | ✅ | ✅ Done |
| AI **metadata auto-fill** (cuisine, protein, vegetables, tags) | ✅ | ✅ | ✅ | ✅ Done (debounced "✨ Thinking…" in the editor; fills empty fields / suggestion chips) |
| **Conversational recipe AI** ("make it gluten-free", photo → recipe) | 🚧 | 🚧 | 🚧 | 🚧 Planned |

## Photos & memories

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Family **wall** (aspect-preserving grid) | ✅ | ✅ | ✅ | ✅ Done |
| **Upload** photos (downscaled, JPEG, 10 MB cap, capability URLs) | ✅ | ✅ | ✅ | ✅ Done (native `PHPicker`) |
| **Multi-upload** with per-photo caption/album/favorite | ✅ | ✅ | ✅ | ✅ Done |
| Drag-and-drop upload zone | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web); mobile uses the native picker |
| **Albums** (filter chips; derived from a photo's album field) | ✅ | ✅ | ✅ | ✅ Done |
| **Edit** a photo (caption, album, **date**, favorite) | ✅ | ✅ | ✅ | ✅ Done (date edit PATCHes `takenAt`; save stays in read mode showing the change) |
| **Multi-select** → bulk move-to-album / delete | ✅ | ✅ | ✅ | ✅ Done (Select mode → tap tiles → Move / Delete bar) |
| Per-tile delete with confirmation (touch-friendly) | ✅ | ✅ | ✅ | ✅ Done |
| **Set an album as the screensaver** source | ✅ | ✅ | ✅ | ✅ Done |
| Photo-only **"Play"** slideshow (no clock/weather chrome) | ✅ | ✅ | ✅ | ✅ Done |
| Recipe **hero images** (same upload pipeline) | ✅ | ✅ | ✅ | ✅ Done |
| **Shared album** import (Google Photos / iCloud) | 🚧 | 🚧 | 🚧 | 🚧 Planned |

## AI capture ("Add anything")

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Natural-language capture → event / task / grocery / meal | ✅ | ✅ | ✅ | ✅ Done |
| Capture parses **event recurrence** + edit Repeats/Ends in the preview | ✅ | ✅ | ✅ | ✅ Done ("lunch every Thursday for a month" → RRULE) |
| **Pluggable provider** (Anthropic / OpenAI-compatible / Ollama), per household | ✅ | ✅ | ✅ | ✅ Done |
| Instant on-device parse, then **upgrade to LLM** with a provider tag | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web); mobile parses server-side |
| **Heuristic fallback** (offline / no provider / provider defers) | ✅ | 🟡 | 🟡 | ✅ Done (server-side; mobile capture needs connectivity) |
| Household-local "now" + family names for resolution | ✅ | ✅ | ✅ | ✅ Done |
| Server-side **fuzzy person resolution** (nicknames/aliases) | 🚧 | 🚧 | 🚧 | 🚧 Planned (6.6-names) |

## Notifications

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **Kiosk "due soon"** reminder banner (local, while open) | 🚧 | ❌ N/A | ❌ N/A | 🚧 Planned (web; table not built) |
| iOS **local** event reminders (offline, from local mirror) | ❌ N/A | ✅ | ✅ | ✅ Done (mobile) |
| Snooze / View notification actions | ❌ N/A | ✅ | ✅ | ✅ Done (mobile) |
| Reminder settings (lead time, all-day hour, my-events-only) | ❌ N/A | ✅ | ✅ | ✅ Done (mobile) |
| Chore reminders | ❌ N/A | 🚧 | 🚧 | 🚧 Planned (needs chores in PowerSync) |
| Recurring-event reminders | ❌ N/A | 🚧 | 🚧 | 🚧 Planned (no recurrence in scheduler yet) |
| **Remote push (APNs / web-push)** | 🚧 | 🚧 | 🚧 | 🚧 Planned (blocked on key/relay) |

## Settings

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **Family & people** (CRUD + grant login/PIN + **permissions grid**) | ✅ | ✅ | ✅ | ✅ Done |
| **Calendars** (connect Google, write-targets, sync now) | ✅ | ✅ | ✅ | ✅ Done |
| **Chores & rewards** (currencies, conversions, proof retention) | ✅ | ✅ | ✅ | ✅ Done |
| **Meals** (meal calendar & meal times) | ✅ | ✅ | ✅ | ✅ Done |
| **AI & capture** (provider/model selection) | ✅ | ✅ | ✅ | ✅ Done |
| **Display & Kiosk** (screensaver, photo source, idle, night-dim, preview) | ✅ | ✅ | ✅ | ✅ Done |
| **Notifications** (reminders) | ❌ N/A | ✅ | ✅ | ✅ Done (mobile) |
| **Login & security** (OIDC config, password toggle) | ✅ | 🟡 | 🟡 | ✅ Done (web); mobile shows accounts/sign-in, OIDC config is web-only |
| Household settings (name, week start, timezone, location) | ✅ | ✅ | ✅ | ✅ Done |
| **About** (version, editable server address + switch warning) | — | ✅ | ✅ | ✅ Done (mobile) |
| **Lists** settings | 🚧 | 🚧 | 🚧 | 🚧 Planned ("Soon") |

## Sync, offline & platform

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **PowerSync** offline mirror to local SQLite | 🟡 (calendar) | ✅ | ✅ | ✅ Done (persons · events · participants · households) |
| Offline writes queued + drained on reconnect | 🟡 (calendar) | ✅ | ✅ | ✅ Done (events domain) |
| Other domains (chores/rewards/goals/lists/meals/photos) | REST | REST | REST | 🟡 REST-only, kept fresh by the in-app refresh bus while online |
| Offline status + pending-uploads + last-synced indicators | ✅ | ✅ | ✅ | ✅ Done |
| Kiosk **PWA** + cached last-known state | 🚧 | ❌ N/A | ❌ N/A | 🟡 Web partial (7.1); mobile is a native app |
| Self-host via **Docker Compose** (`./nook up`) | ✅ | — | — | ✅ Done |
| In-container **migrations** (one-shot) | ✅ | — | — | ✅ Done |
| **GHCR** multi-arch images (amd64 + arm64) | ✅ | — | — | ✅ Done |
| Optional **S3 backup** | 🚧 | — | — | 🚧 Parked (Phase 4) |
| Public ingress / auto-TLS beyond LAN | 🟡 | — | — | 🟡 Configurable (7.3) |
| Observability + restore drills | 🚧 | — | — | 🚧 Planned (7.4) |

> **PowerSync scope note.** Offline-first currently covers the **calendar/events** domain
> on every surface (local-first reads + queued writes). The iOS app mirrors
> persons/events/event_participants/households locally. Other domains (chores, lists,
> rewards, goals, meals, photos) are REST-backed and need connectivity, kept in sync by
> the in-app live-refresh bus while online. Bringing **chores** into PowerSync is the
> prerequisite for offline chores *and* iOS chore reminders.

---

## Mobile backlog (planned, not yet built)

Tracked in [`apps/ios/IPAD_ROADMAP.md`](../../apps/ios/IPAD_ROADMAP.md). Highlights:

- **Chore reminders** on iOS — blocked on chores landing in PowerSync.
- **Recurring-event reminders** — the local scheduler doesn't expand recurrences yet.
- **Recipe import** (paste-markdown) on iOS — the hand editor + AI metadata auto-fill ship; only the paste-a-block importer is still web-only.
- **Multi-profile kiosk** (profile picker + per-person PIN) on iPad — deliberately deferred;
  layers on top of single-login without rework (needs a server device→person binding).
- ~~iPad Today per-card customize (drag/hide)~~ — intentionally not planned; the fixed
  three-group dashboard (recap banners · Today · goals) is the right shape for the wall display.
- **Household-wide** screensaver motion (currently a per-device toggle; would need the
  server display config + web to carry a `photoMotion` field).
- **Remote push** (APNs) for reminders when the app is closed.

See [roadmap status](./roadmap.md) for the cross-surface planned/partial items in context.
