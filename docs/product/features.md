# Feature support matrix

Every Nook feature and whether it's supported on each surface.

- **Web / Kiosk** — the React app (same build powers the desktop browser and the kitchen
  tablet kiosk). **This column is filled in.**
- **Mobile** — the native iOS app. **Left ⬜ for the mobile owner to complete.**
- **Status** — where the feature sits on the [roadmap](./roadmap.md).

Legend: ✅ supported · 🟡 partial · 🚧 planned · ❌ not supported/N-A · ⬜ not yet assessed

---

## Accounts, onboarding & identity

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| First-run **setup wizard** (create household + admin) | ✅ | ⬜ | ✅ Done |
| **Email/password** login (built-in) | ✅ | ⬜ | ✅ Done |
| Rotating refresh tokens + transparent 401-refresh | ✅ | ⬜ | ✅ Done |
| **OIDC SSO** (backend-mediated, invite-gated) | ✅ | ⬜ | ✅ Done |
| Admin-managed OIDC config (Settings, secret encrypted at rest) | ✅ | ⬜ | ✅ Done |
| Disable password login / force SSO (break-glass guard) | ✅ | ⬜ | ✅ Done |
| **Member management** — grant a person a login (email ± password) | ✅ | ⬜ | ✅ Done |
| **Members CRUD** (profiles: name, avatar, color, role) | ✅ | ⬜ | ✅ Done |
| Sign out (revokes refresh) | ✅ | ⬜ | ✅ Done |

## Kiosk & ambient display

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| **Kiosk device pairing** (admin code or "use this device") | ✅ | ❌ N/A | ✅ Done |
| **Profile picker** (Netflix-style; per-profile real session) | ✅ | ❌ N/A | ✅ Done |
| Optional per-person **PIN** (throttled) | ✅ | ❌ N/A | ✅ Done |
| Rail "Switch" + idle return to picker | ✅ | ❌ N/A | ✅ Done |
| Idle **screensaver** auto-start (clock + weather) | ✅ | ⬜ | ✅ Done |
| Screensaver **photo slideshow** + **crossfade** transitions | ✅ | ⬜ | ✅ Done |
| Screensaver settings (source: all/favorites/album, speed, shuffle) | ✅ | ⬜ | ✅ Done |
| **Live weather** on the topbar (Open-Meteo, no key) | ✅ | ⬜ | ✅ Done |
| Single-login mode (no pairing) — default | ✅ | ⬜ | ✅ Done |

## Today dashboard

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| Today cards: agenda · tonight's meal · this week · chores · grocery | ✅ | ⬜ | ✅ Done |
| **Customize** mode — drag to reorder cards | ✅ | ⬜ | ✅ Done |
| Save layout **for me** (per-user) vs **for everyone** (family default) | ✅ | ⬜ | ✅ Done |
| Mobile-specific Today layout (separate config) | ❌ N/A | ⬜ | ✅ Done (backend) |
| "Did these happen?" goal recap queue on Today | ✅ | ⬜ | ✅ Done |

## Calendar & events

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| Native events (create / edit / delete) | ✅ | ⬜ | ✅ Done |
| **Multiple participants** per event (stacked avatars, per-person color) | ✅ | ⬜ | ✅ Done |
| Views: **Month / Week / Day / Agenda** | ✅ | ⬜ | ✅ Done |
| Full-screen **event detail** (location/Directions, repeats, notes, timeline) | ✅ | ⬜ | ✅ Done |
| Per-person filter | ✅ | ⬜ | ✅ Done |
| **Two-way Google Calendar sync** (inbound poll + outbound push) | ✅ | ⬜ | ✅ Done |
| Connect calendars + per-person write-target (Settings → Calendars) | ✅ | ⬜ | ✅ Done |
| **Offline** calendar (PowerSync: local reads + queued writes) | ✅ | ⬜ | ✅ Done |
| AI **"Heads up this week"** digest + **per-event insight** | ✅ | ⬜ | ✅ Done |
| "Counts toward a goal" tag on an event | ✅ | ⬜ | ✅ Done |
| **Recurring events** (rrule expansion, per-occurrence) | 🚧 | ⬜ | 🚧 Planned (Phase 2) |

## Tasks & chores

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| Chores CRUD (assign person, stars/currency) | ✅ | ⬜ | ✅ Done |
| Daily instances + complete → award | ✅ | ⬜ | ✅ Done |
| Family-chores **rings** (Today) + Tasks board | ✅ | ⬜ | ✅ Done |
| **Weekly/custom schedules** (specific weekdays) | ✅ | ⬜ | ✅ Done |
| **Up-for-grabs** claim (unassigned → person) | ✅ | ⬜ | ✅ Done |
| **Drag-to-reassign** chores between columns | ✅ | ⬜ | ✅ Done |
| **Parent-approval** step (awaiting → approve/reject) | ✅ | ⬜ | ✅ Done |
| **Streaks** (🔥N consecutive days) | ✅ | ⬜ | ✅ Done |
| Photo proof of completion | 🚧 | ⬜ | 🚧 Planned (consumes blob upload) |

## Rewards & economy

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| Stars **earn ledger** (append-only) + balances | ✅ | ⬜ | ✅ Done |
| **Rewards catalog** + redeem → parent-approve → ledger debit | ✅ | ⬜ | ✅ Done |
| Per-kid **balances** + approval queue (Rewards tab) | ✅ | ⬜ | ✅ Done |
| **Multi-currency** (custom currencies, symbols, colors) | ✅ | ⬜ | ✅ Done |
| **Conversions / "Trade"** (e.g. 10 ⭐ → 1 💵) | ✅ | ⬜ | ✅ Done |
| **Saving-toward** a reward — bar/jar progress + inline redeem | ✅ | ⬜ | ✅ Done |
| Milestone reward **payouts** | 🚧 | ⬜ | 🚧 Deferred (design done) |

## Goals

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| Goal types: count / total / habit / checklist | ✅ | ⬜ | ✅ Done |
| Goal **lists** + membership (shared lists / individual) | ✅ | ⬜ | ✅ Done |
| Shared-pool vs each-tracks goals | ✅ | ⬜ | ✅ Done |
| Create / **edit** / delete goals | ✅ | ⬜ | ✅ Done |
| Type-aware **logging** (amount / stepper / once-a-day / tick steps) | ✅ | ⬜ | ✅ Done |
| Backdated logs ("When?" picker) | ✅ | ⬜ | ✅ Done |
| **Goal detail** read-model (milestone track, hours-by-person, streaks, recent) | ✅ | ⬜ | ✅ Done |
| Checklist **named steps** + per-type **milestones** (text) | ✅ | ⬜ | ✅ Done |
| **Person profile** + **Family overview** | ✅ | ⬜ | ✅ Done |
| **Calendar → goal** auto-count recap (single events) | ✅ | ⬜ | ✅ Done (Phase 1) |
| Smart "might count toward a goal" suggestions + learning | ✅ | ⬜ | ✅ Done (Phase B) |
| Recurring-event goal counting | 🚧 | ⬜ | 🚧 Planned (Phase 2) |

## Lists & groceries

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| Custom **multi-lists** (sectioned items, quantities, assignees) | ✅ | ⬜ | ✅ Done |
| Create / rename / delete lists (cascade) | ✅ | ⬜ | ✅ Done |
| **Auto-built grocery board** from the week's dinners | ✅ | ⬜ | ✅ Done |
| **Aisle grouping** + **quantity merge** (By aisle / By meal) | ✅ | ⬜ | ✅ Done |
| **Pantry staples** (kept off the list; Pantry check) | ✅ | ⬜ | ✅ Done |
| Check off / add / delete (persists) | ✅ | ⬜ | ✅ Done |
| **Cross-surface live refresh** (Today ↔ Lists ↔ Rewards) | ✅ | ⬜ | ✅ Done |

## Meals & recipes

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| **Weekly** meal planner grid + recipe picker | ✅ | ⬜ | ✅ Done |
| **Month** meal view + planner | ✅ | ⬜ | ✅ Done |
| Drag-to-swap on week/month grid | ✅ | ⬜ | ✅ Done |
| Full-screen **recipe detail** (hero image, metadata chips, servings scaler) | ✅ | ⬜ | ✅ Done |
| **Recipes library** (search-all, multi-select filters, sort) | ✅ | ⬜ | ✅ Done |
| Create / **edit** / delete recipes in-app (ingredients + steps) | ✅ | ⬜ | ✅ Done |
| **Paste-markdown** recipe import (template/example) | ✅ | ⬜ | ✅ Done |
| Per-recipe **overrides** (substitutions, notes — merge & survive re-import) | ✅ | ⬜ | ✅ Done |
| **Cook mode** (step-by-step, wake-lock, finish → mark cooked) | ✅ | ⬜ | ✅ Done |
| **Grocery auto-build** honoring substitutions | ✅ | ⬜ | ✅ Done |
| AI **Plan my week / month** (library-only, themes, gaps) | ✅ | ⬜ | ✅ Done |
| AI **metadata auto-fill** (cuisine, protein, vegetables, tags) | ✅ | ⬜ | ✅ Done |
| **Conversational recipe AI** ("make it gluten-free", photo → recipe) | 🚧 | ⬜ | 🚧 Planned |

## Photos & memories

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| Family **wall** (aspect-preserving masonry) | ✅ | ⬜ | ✅ Done |
| **Upload** photos (downscaled, JPEG/WebP, 10 MB cap, capability URLs) | ✅ | ⬜ | ✅ Done |
| **Multi-upload** (up to 10) with per-photo caption/album/favorite | ✅ | ⬜ | ✅ Done |
| Drag-and-drop upload zone | ✅ | ⬜ | ✅ Done |
| **Albums** (filter chips; derived from a photo's album field) | ✅ | ⬜ | ✅ Done |
| **Edit** a photo (caption, album, date, favorite) | ✅ | ⬜ | ✅ Done |
| **Multi-select** → bulk move-to-album / delete (with confirm) | ✅ | ⬜ | ✅ Done |
| Per-tile delete with confirmation (touch-friendly) | ✅ | ⬜ | ✅ Done |
| **Set an album as the screensaver** source | ✅ | ⬜ | ✅ Done |
| Photo-only **"Play"** slideshow (no clock/weather chrome) | ✅ | ⬜ | ✅ Done |
| Recipe **hero images** (same upload pipeline) | ✅ | ⬜ | ✅ Done |
| **Shared album** import (Google Photos / iCloud) | 🚧 | ⬜ | 🚧 Planned |

## AI capture ("Add anything")

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| Natural-language capture → event / task / grocery / meal | ✅ | ⬜ | ✅ Done |
| **Pluggable provider** (Anthropic / OpenAI-compatible / Ollama), per household | ✅ | ⬜ | ✅ Done |
| Instant on-device parse, then **upgrade to LLM** with a provider tag | ✅ | ⬜ | ✅ Done |
| **Heuristic fallback** (offline / no provider / provider defers) | ✅ | ⬜ | ✅ Done |
| Household-local "now" + family names for resolution | ✅ | ⬜ | ✅ Done |
| Server-side **fuzzy person resolution** (nicknames/aliases) | 🚧 | ⬜ | 🚧 Planned (6.6-names) |

## Notifications

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| **Kiosk "due soon"** reminder banner (local, while open) | 🚧 | ❌ N/A | 🚧 Planned (table not built) |
| iOS **local** event reminders (offline, from local mirror) | ❌ N/A | ⬜ | ✅ Done (mobile) |
| Snooze / View notification actions | ❌ N/A | ⬜ | ✅ Done (mobile) |
| Chore reminders | ❌ N/A | ⬜ | 🚧 Planned (needs chores in sync) |
| Recurring-event reminders | ❌ N/A | ⬜ | 🚧 Planned |
| **Remote push (APNs / web-push)** | 🚧 | ⬜ | 🚧 Planned (blocked on key/relay) |

## Settings

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| **Family & people** (CRUD + grant login) | ✅ | ⬜ | ✅ Done |
| **Calendars** (connect Google, write-targets, sync now) | ✅ | ⬜ | ✅ Done |
| **Chores & rewards** (currencies, conversions) | ✅ | ⬜ | ✅ Done |
| **AI & capture** (provider/model selection) | ✅ | ⬜ | ✅ Done |
| **Display & Kiosk** (pairing, screensaver, idle) | ✅ | ⬜ | ✅ Done |
| **Login & security** (OIDC, password toggle) | ✅ | ⬜ | ✅ Done |
| Household settings (name, timezone, location) | ✅ | ⬜ | ✅ Done |

## Sync, offline & platform

| Feature | Web / Kiosk | Mobile | Status |
| --- | :---: | :---: | --- |
| **PowerSync** offline mirror to local SQLite | 🟡 (calendar) | ⬜ | ✅ Done |
| Offline writes queued + drained on reconnect | 🟡 (calendar) | ⬜ | ✅ Done |
| Kiosk **PWA** + cached last-known state | 🚧 | ❌ N/A | 🟡 Partial (7.1) |
| Self-host via **Docker Compose** (`./nook up`) | ✅ | — | ✅ Done |
| In-container **migrations** (one-shot) | ✅ | — | ✅ Done |
| **GHCR** multi-arch images (amd64 + arm64) | ✅ | — | ✅ Done |
| Optional **S3 backup** | 🚧 | — | 🚧 Parked (Phase 4) |
| Public ingress / auto-TLS beyond LAN | 🟡 | — | 🟡 Configurable (7.3) |
| Observability + restore drills | 🚧 | — | 🚧 Planned (7.4) |

> **PowerSync scope note.** On the Web/Kiosk, offline-first currently covers the
> **calendar/events** domain (local-first reads + queued writes). Other domains
> (chores, lists, rewards, goals, meals, photos) are REST-backed and require connectivity,
> kept in sync across surfaces by the in-app live-refresh bus while online. The iOS app
> mirrors persons/events/households/event_participants locally; assessing its full domain
> coverage is left to the mobile owner.

---

See [roadmap status](./roadmap.md) for the planned/partial items above in context.
