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
| First-run **setup wizard** (create household + admin) | ✅ | ❌ | ❌ | ✅ Done (web-only; mobile shows a "finish setup on the web" notice) |
| **Email/password** login (built-in) | ✅ | ✅ | ✅ | ✅ Done |
| Rotating refresh tokens + transparent 401-refresh | ✅ | ✅ | ✅ | ✅ Done (Keychain token store) |
| **OIDC SSO** (backend-mediated, invite-gated) | ✅ | ✅ | ✅ | ✅ Done (`ASWebAuthenticationSession`) |
| Admin-managed OIDC config (Settings, secret encrypted at rest) | ✅ | ❌ | ❌ | ✅ Done (web-only admin) |
| Disable password login / force SSO (break-glass guard) | ✅ | ❌ | ❌ | ✅ Done (web-only admin) |
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
| Single-login mode (no pairing) — default | ✅ | ✅ | ✅ | ✅ Done |

## Today dashboard

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Today cards: agenda · tonight's meal · this week · chores · grocery | ✅ | ✅ | ✅ | ✅ Done (iPad = distinct 3-column `KioskDashboard`) |
| **Customize** mode — drag to reorder cards | ✅ | ✅ | 🟡 | ✅ Done (iPhone reorder+hide; iPad uses layout presets) |
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
| Full-screen **event detail** (location/Directions, repeats, notes, timeline) | ✅ | ✅ | ✅ | ✅ Done (iPad detail is two-column) |
| Per-person filter | ✅ | ✅ | ✅ | ✅ Done |
| **Two-way Google Calendar sync** (inbound poll + outbound push) | ✅ | ✅ | ✅ | ✅ Done (sync runs server-side; connect in Settings → Calendars) |
| Connect calendars + per-person write-target (Settings → Calendars) | ✅ | ✅ | ✅ | ✅ Done |
| **Offline** calendar (PowerSync: local reads + queued writes) | ✅ | ✅ | ✅ | ✅ Done |
| AI **"Heads up this week"** digest + **per-event insight** | ✅ | ✅ | ✅ | ✅ Done |
| "Counts toward a goal" tag on an event | ✅ | ✅ | ✅ | ✅ Done |
| **Recurring events** — rrule **expansion / read** | ✅ | ✅ | ✅ | ✅ Done |
| **Recurring events** — **creation** | ✅ | 🚧 | 🚧 | 🟡 Read-only on mobile (no repeat picker yet) |
| **Recurring events** — per-occurrence **edit scope** (this / following / all) | ✅ | 🚧 | 🚧 | 🟡 Mobile edits/deletes hit whole series |

## Tasks & chores

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Chores CRUD (assign person, stars/currency) | ✅ | ✅ | ✅ | ✅ Done |
| Daily instances + complete → award | ✅ | ✅ | ✅ | ✅ Done |
| Family-chores **rings** (Today) + Tasks board | ✅ | ✅ | ✅ | ✅ Done (iPad = wrapping Kanban) |
| **Weekly/custom schedules** (specific weekdays) | ✅ | ✅ | ✅ | ✅ Done |
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
| **Recipes library** (search-all, multi-select filters, sort) | ✅ | ✅ | ✅ | ✅ Done |
| Create / **edit** / delete recipes in-app (ingredients + steps) | ✅ | ✅ | ✅ | ✅ Done (lighter metadata editor on mobile) |
| **Paste-markdown** recipe import (template/example) | ✅ | ❌ | ❌ | 🟡 Web-only |
| Per-recipe **overrides** (substitutions, notes) | ✅ | 🟡 | 🟡 | ✅ Done (notes; full overrides on web) |
| **Cook mode** (step-by-step, wake-lock, finish → mark cooked) | ✅ | ✅ | ✅ | ✅ Done |
| **Grocery auto-build** honoring substitutions | ✅ | ✅ | ✅ | ✅ Done |
| AI **Plan my week / month** (library-only, themes, gaps) | ✅ | ✅ | ✅ | ✅ Done |
| AI **metadata auto-fill** (cuisine, protein, vegetables, tags) | ✅ | ❌ | ❌ | 🟡 Web-only (manual metadata editor on mobile) |
| **Conversational recipe AI** ("make it gluten-free", photo → recipe) | 🚧 | 🚧 | 🚧 | 🚧 Planned |

## Photos & memories

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Family **wall** (aspect-preserving grid) | ✅ | ✅ | ✅ | ✅ Done |
| **Upload** photos (downscaled, JPEG, 10 MB cap, capability URLs) | ✅ | ✅ | ✅ | ✅ Done (native `PHPicker`) |
| **Multi-upload** with per-photo caption/album/favorite | ✅ | ✅ | ✅ | ✅ Done |
| Drag-and-drop upload zone | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web); mobile uses the native picker |
| **Albums** (filter chips; derived from a photo's album field) | ✅ | ✅ | ✅ | ✅ Done |
| **Edit** a photo (caption, album, favorite) | ✅ | ✅ | ✅ | ✅ Done |
| Edit a photo's **date** | ✅ | 🚧 | 🚧 | 🚧 Planned (mobile) |
| **Multi-select** → bulk move-to-album / delete | ✅ | 🚧 | 🚧 | 🚧 Planned (mobile; per-tile delete works) |
| Per-tile delete with confirmation (touch-friendly) | ✅ | ✅ | ✅ | ✅ Done |
| **Set an album as the screensaver** source | ✅ | ✅ | ✅ | ✅ Done |
| Photo-only **"Play"** slideshow (no clock/weather chrome) | ✅ | ✅ | ✅ | ✅ Done |
| Recipe **hero images** (same upload pipeline) | ✅ | ✅ | ✅ | ✅ Done |
| **Shared album** import (Google Photos / iCloud) | 🚧 | 🚧 | 🚧 | 🚧 Planned |

## AI capture ("Add anything")

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Natural-language capture → event / task / grocery / meal | ✅ | ✅ | ✅ | ✅ Done |
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

- **Recurring-event creation + edit scope** on iOS — the editor has no repeat picker, so
  creation is web-only; edits/deletes always hit the whole series (no this / this-and-following
  scope chooser). The server already accepts `rrule` on create and `scope`+`occurrenceStart`
  on PATCH/DELETE — this is a pure client build.
- **Photos** — multi-select bulk move/delete, and editing a photo's date.
- **Chore reminders** on iOS — blocked on chores landing in PowerSync.
- **Recurring-event reminders** — the local scheduler doesn't expand recurrences yet.
- **Recipe import** (paste-markdown) and **AI metadata auto-fill** on iOS.
- **Multi-profile kiosk** (profile picker + per-person PIN) on iPad — deliberately deferred;
  layers on top of single-login without rework (needs a server device→person binding).
- **iPad Today per-card customize** (drag/hide) to match the iPhone + web.
- **Household-wide** screensaver motion (currently a per-device toggle; would need the
  server display config + web to carry a `photoMotion` field).
- **Remote push** (APNs) for reminders when the app is closed.

See [roadmap status](./roadmap.md) for the cross-surface planned/partial items in context.
