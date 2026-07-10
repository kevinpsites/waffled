---
title: Feature matrix
description: Every Waffled feature and whether it's supported on each surface.
---

Every Waffled feature and whether it's supported on each surface.

- **Web / Kiosk** — the React app (same build powers the desktop browser and the kitchen
  tablet kiosk).
- **iPhone** — the native iOS app's *personal-planner* experience (`AppRoot` + bottom tab
  bar; one person checking their day).
- **iPad** — the **same** universal app's *family-hub* experience (`KioskRoot` → a left nav
  rail + every page, re-laid-out big; runs on the counter). One binary, one App Store
  listing — the device picks the experience by idiom (`DeviceExperience`).
- **Status** — where the feature sits on the [roadmap](https://github.com/kevinpsites/waffled/blob/main/docs/product/roadmap.md).

Legend: ✅ supported · 🟡 partial · 🚧 planned · ❌ not supported / N-A

> **iPhone vs iPad.** Most feature screens are *shared* and adapt by size; the iPad adds
> distinct wide layouts (`KioskDashboard`, `KioskCalendarView`, `KioskListsView`, the
> Kanban chores board, the **screensaver**) on top of the same `SyncManager`/`WaffledAPI`
> data layer. iPad-only items (screensaver, ambient display) read ❌ N/A on iPhone;
> shared-but-web-only admin actions (first-run setup, OIDC config) read ❌ on both.
> The **shared-kiosk profile picker** (pairing + per-profile PIN) now ships on **iPad** as
> an opt-in (single persistent login stays the default); it's ❌ N/A on iPhone, which is
> never a kiosk. See
> [`apps/ios/IPAD_ROADMAP.md`](https://github.com/kevinpsites/waffled/blob/main/apps/ios/IPAD_ROADMAP.md) for the mobile build plan.

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
| **Role-based permissions** — per-role capability grid (Settings → Family); [model](/concepts/permissions/) | ✅ | ✅ | ✅ | ✅ Done (editable matrix, admin-only) |
| Sign out (revokes refresh) | ✅ | ✅ | ✅ | ✅ Done |

## Kiosk & ambient display

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **Kiosk device pairing** (admin code or "use this device") | ✅ | ❌ N/A | ✅ | ✅ Done — iPad: admin one-tap *promote* + pair-by-code (opt-in; iPhone never a kiosk) |
| **Profile picker** (Netflix-style; per-profile real session) | ✅ | ❌ N/A | ✅ | ✅ Done — `KioskProfilePickerView`; device-token model, claim mints a per-person session |
| Optional per-person **PIN** to open a profile (throttled) | ✅ | ❌ N/A | ✅ | ✅ Done — `KioskPinPad` (4–8 digits, "N tries left" on 401, lockout countdown on 429) |
| "Switch profile" + idle return to picker | ✅ | ❌ N/A | ✅ | ✅ Done — tap the rail avatar (swap badge) or Settings → Display & Kiosk "Switch profile"; `returnToPicker` also drops to the picker on screensaver wake |
| **Exit kiosk mode** on the device (un-pair this iPad) | ✅ | ❌ N/A | ✅ | ✅ Done — picker gear → "Exit shared kiosk" (no sign-in needed) or parent Settings → "Stop sharing"; local-only, returns to normal login |
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
| Agenda **dims past events** | ✅ | ✅ | — | ✅ Done — the Calendar agenda **and** the Today dashboard's agenda card fade already-ended events (web + iPhone) |
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
| **Countdowns** — "N days until X" from three sources (flag an event · standalone item · auto member birthdays); Today card + month-grid badge; household "N sleeps" toggle | ✅ | ✅ | ✅ | ✅ Done — iOS reads the merged `GET /api/countdowns` for a **Today card** (iPhone `CountdownsCard` + iPad kiosk card; emoji · title · date · N-days/sleeps · standalone × remove · + Add) and **month-grid badges** (iPhone + `KioskCalendarView`); the event editor's **"⏳ Show a countdown"** toggle rides the full `is_countdown` offline path (PowerSync schema + local/REST writes); the **"N sleeps"** toggle is in Settings → Calendars |

## Tasks & chores

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Chores CRUD (assign person, stars/currency) | ✅ | ✅ | ✅ | ✅ Done |
| Daily instances + complete → award | ✅ | ✅ | ✅ | ✅ Done |
| Family-chores **rings** (Today) + Tasks board | ✅ | ✅ | ✅ | ✅ Done (iPad = wrapping Kanban) |
| **Weekly/custom schedules** (specific weekdays) | ✅ | ✅ | ✅ | ✅ Done |
| **One-off / carry-over task** (single day, stays until done) | ✅ | ✅ | ✅ | ✅ Done ("Just once" repeat + due date in create/edit; unfinished one-offs roll forward, **overdue · since …** badge; `rollover` toggle) |
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
| **Reward shop** (kid-facing per-person view) — wallet hero, redeem + celebration | ✅ | ✅ | ✅ | ✅ Done — iOS redesigned to match web: purple wallet hero ("{NAME}'S {CURRENCY}" + "N to go for {saving-toward}"), gradient-thumb tiles with cost badges + locked/affordable states, a **Redeem** confirm sheet and a **confetti Celebration** ("{title} unlocked! 🎉") |
| **Rewards tab = the shop** — person tabs on top select whose shop/balance to view | ✅ | ✅ | ✅ | ✅ Done — iOS Rewards tab shows a pinned **person-tab strip** + the selected person's shop inline (was a family-balances list you tapped into); toolbar/iPad-header: Award · Manage rewards · Approvals |
| **Reward categories** (treats/screen/adventures/toys/privileges) → filterable shop | ✅ | ✅ | ✅ | ✅ Done — iOS **displays + filters** by `reward.category` (chips + "{emoji} {label} · N you can get" sections; mig 0073) **and sets** it (a category chip-picker in the reward editor, threaded through create/updateReward) |
| Per-kid **balances** + approval queue (Rewards tab) | ✅ | ✅ | ✅ | ✅ Done |
| **Multi-currency** (custom currencies, symbols, colors) | ✅ | ✅ | ✅ | ✅ Done |
| **Conversions / "Trade"** (e.g. 10 ⭐ → 1 💵) | ✅ | ✅ | ✅ | ✅ Done |
| **Saving-toward** a reward — bar/jar progress + inline redeem | ✅ | ✅ | ✅ | ✅ Done |
| **Spot-award stars** — parent hands out ad-hoc stars (untied to a chore) + optional reason | ✅ | ✅ | ✅ | ✅ Done — gated on `reward.grant`; mobile: **Award** on the person profile **and** a person-picker Award sheet on the Rewards page → `POST /api/persons/:id/award`; the ledger row reads "spot award — {reason}" (person-overview surfaces `ledger_entries.note`) |
| **Capability gating** — `reward.manage` / `reward.approve` / `reward.grant`; anyone may redeem for self | ✅ | ✅ | ✅ | ✅ Done |
| Milestone reward **payouts** | 🚧 | 🚧 | 🚧 | 🚧 Deferred (design done) |

## Goals

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Goal types: count / total / habit / checklist | ✅ | ✅ | ✅ | ✅ Done |
| Goal **lists** + membership (shared lists / individual) | ✅ | ✅ | ✅ | ✅ Done |
| Shared-pool vs each-tracks goals | ✅ | ✅ | ✅ | ✅ Done |
| **Goal tiers** — Spotlight (one hero per list) / Featured band / More (A–Z), with a Spotlight-Featured-Normal picker on the create/edit form | ✅ | 🟡 | 🟡 | 🟡 Web done; iPhone/iPad pending (drag-reorder + Today-card pinning on roadmap) |
| **How a group activity counts** — shared/each toggle + a measure-aware counting follow-up under "How do you measure it?" (total: full / split · count: each / once) with real-name worked examples | ✅ | ✅ | ✅ | ✅ Done (web + iOS) |
| **Checklist tick-off** — complete a checklist by ticking its named steps (in the goal detail + the Log sheet) | ✅ | ✅ | ✅ | ✅ Done (was iPhone-blocked; now shipped) |
| **Type-aware Log sheet** — count stepper, total amount, habit one-tap, checklist ticking; unit shown correctly | ✅ | ✅ | ✅ | ✅ Done (web + iOS) |
| Create / **edit** / delete goals | ✅ | ✅ | ✅ | ✅ Done |
| **Edit / remove a logged entry** (amount, who took part, note, date; shared entries removed whole + re-split) | ✅ | ✅ | ✅ | ✅ Done (web + iOS) |
| Type-aware **logging** (amount / stepper / once-a-day / tick steps) | ✅ | ✅ | ✅ | ✅ Done |
| Backdated logs ("When?" picker) | ✅ | ✅ | ✅ | ✅ Done |
| **Goal detail** read-model (milestone track, hours-by-person, streaks, recent) | ✅ | ✅ | ✅ | ✅ Done |
| Checklist **named steps** + per-type **milestones** (text) | ✅ | ✅ | ✅ | ✅ Done |
| **Person profile** + **Family overview** | ✅ | ✅ | ✅ | ✅ Done (iPad = `KioskFamilyView` grid) |
| **Calendar → goal** auto-count recap (single events) | ✅ | ✅ | ✅ | ✅ Done (Phase 1) |
| Smart "might count toward a goal" suggestions + learning | ✅ | ✅ | ✅ | ✅ Done (Phase B) |
| Recurring-event goal counting | ✅ | ✅ | ✅ | ✅ Done |
| **Capability gating** — `goal.manage` for others' / shared goals; own progress stays open | ✅ | ✅ | ✅ | ✅ Done |
| **Apple Health → goals** auto-fill (steps / flights / exercise / energy / mindful / rings / mood), habit daily thresholds, "set a goal from your Health data" picker, gap catch-up | ❌ N/A | ✅ | ❌ N/A | ✅ Done (iPhone; iPad/web display the synced number) |

## Lists & groceries

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Custom **multi-lists** (sectioned items, quantities, assignees) | ✅ | ✅ | ✅ | ✅ Done (iPad = master/detail) |
| Create / rename / delete lists (cascade) | ✅ | ✅ | ✅ | ✅ Done — mobile: **swipe** a list → **Edit** (rename/emoji, `PATCH /api/lists/:id`) + **Delete**; **Delete list** also in the list-detail ⋯ menu |
| **List templates** — save a list as a reusable template, apply → a fresh unchecked copy, manage (delete) | ✅ | ✅ | ✅ | ✅ Done — mobile: one New-list modal (name + emoji + Create) with an "Or start from a template" picker (**select-then-Create**, name pre-fills from the template); long-press a template to delete |
| **Auto-built grocery board** from the week's dinners | ✅ | ✅ | ✅ | ✅ Done |
| **Aisle grouping** + **quantity merge** (By aisle / By meal) | ✅ | ✅ | ✅ | ✅ Done |
| **Pantry staples** (kept off the list; Pantry check) | ✅ | ✅ | ✅ | ✅ Done |
| Check off / add / delete (persists) | ✅ | ✅ | ✅ | ✅ Done |
| **Item attribution** — "added by {name}" / "🍽 from meal plan" | ✅ | ✅ | ✅ | ✅ Done |
| **Re-aisle** a grocery item (move it to another aisle section from its editor) | ✅ | ✅ | ✅ | ✅ Done — mobile: section chips + an **Auto** chip (clear the override → classify by name) in the item Details editor |
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
| **Never-cooked "🆕 New" tag + filter** (recipes you haven't tried) | ✅ | ✅ | ✅ | ✅ Done — mobile: "New" library toggle (`cookedCount == 0`), 🆕 card badge, tappable 🆕 New chip on the detail → library filtered to New |
| Create / **edit** recipes in-app (all metadata + ingredients + steps) | ✅ | ✅ | ✅ | ✅ Done (full editor — shared iPhone/iPad; **per-step ingredient amounts**; **ingredient sections** with dividers + cross-section drag-drop; delete is web-only) |
| **Paste-markdown** recipe import (template/example) | ✅ | ✅ | ✅ | ✅ Done (paste → parse → fills the editor for review, then save) |
| Per-recipe **overrides** (substitutions, notes) | ✅ | ✅ | ✅ | ✅ Done — mobile now edits **ingredient substitutions** (⇄ per row → `overrides.subs`, feeds the substitution-aware grocery build) alongside per-step + recipe notes |
| **Cook mode** (step-by-step, wake-lock, finish → mark cooked) | ✅ | ✅ | ✅ | ✅ Done (mobile: left-aligned full-width large type) |
| Cook-mode **recipe overview** (jump to any step + ingredients) | ✅ | ✅ | ✅ | ✅ Done (mobile; large sheet) |
| **Per-step timers** — set in the editor; floating dock in cook mode | ✅ | ✅ | ✅ | ✅ Done (mobile: bottom-right dock, live tick, tap → jump to step, looping alarm + local-notif fallback) |
| **On-the-spot cook timer** — add a timer to a step that never had one, mid-cook | ✅ | ✅ | ✅ | ✅ Done — mobile: "⏱ Add timer" on timer-less steps, minute/second **wheel pickers** (flick to a value), ephemeral for the session |
| Open recipe **full-screen** from Today | ✅ | ✅ | ✅ | ✅ Done (iPad opens full-screen, not a page-sheet) |
| **Grocery auto-build** honoring substitutions | ✅ | ✅ | ✅ | ✅ Done |
| AI **Plan my week / month** (library-only, themes, gaps) | ✅ | ✅ | ✅ | ✅ Done |
| **Try New Recipe** — nudge the AI week toward novelty / list specific dishes to try | ✅ | ✅ | ✅ | ✅ Done — mobile: "Try something new" toggle + "Dishes to try" chips in the Plan-my-week sheet (sent on the initial full draft) |
| AI **metadata auto-fill** (cuisine, protein, vegetables, tags) | ✅ | ✅ | ✅ | ✅ Done (debounced "✨ Thinking…" in the editor; fills empty fields / suggestion chips) |
| **AI recipe import** — **photo → recipe** and **describe-it** (speech/free-form → recipe) | ✅ | 🚧 | 🚧 | ✅ Done (web) — in "New recipe": read photos of a physical recipe with a vision model, or dictate/type a loose description; both prefill the editor for review before saving. Source photos auto-delete after a short window. Photo needs a vision provider (Claude / OpenAI / vision Ollama); describe works with any. iOS parity (camera + Apple-Speech) planned |
| **Conversational recipe edits** ("make it gluten-free", "double it") | 🚧 | 🚧 | 🚧 | 🚧 Planned |

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
| Instant on-device parse, then **upgrade to LLM** with a provider tag | ✅ | ✅ | ✅ | ✅ Done (instant guess + "improving…"; **pick** the other take on a kind-disagreement; **recurrence backfill** when a weak LLM drops it) |
| **Heuristic fallback** (offline / no provider / provider defers) | ✅ | ✅ | ✅ | ✅ Done (on-device `CaptureHeuristic` — capture works with no server; ported from web `parse.ts`, kept in sync) |
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

## Modules & extensibility

See [Extensibility & modules](/concepts/extensibility/) for the pattern model (A = built-in toggle
module · B = external integration via API keys · C = in-process plugins, deliberately not
built). The on/off flag is **server-side + shared** (`households.settings.modules`); each
client renders its own native UI, so a module with no iOS screen simply doesn't appear there.

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **Pluggable optional modules** — registry + per-household enable flag; gates Today cards / nav / routes | ✅ | ✅ | ✅ | ✅ Done — iOS now gates the **Chores/Goals/Meals/Lists** nav (phone hub tiles + Meals tab; iPad rail), their Today cards, and the **Rewards** sub-toggle on the shared flag (Today + Calendar never gated) |
| **Settings → Modules** tab (toggle optional modules on/off) | ✅ | ✅ | ✅ | ✅ Done — iOS `ModulesSettingsView` (admin-gated toggles + Rewards sub-toggle + "coming soon" rows); toggling updates nav/Today live |
| **Pantry / on-hand inventory** module — items + quantities + locations (fridge/freezer/pantry) | ✅ | ✅ | ✅ | ✅ Done — iOS `PantryView` (list grouped by location, add by hand, edit/used-up/delete) |
| Pantry: quantity **stepper** + tap-to-type amount, **"used up"** state | ✅ | ✅ | ✅ | ✅ Done — iOS: ± stepper on rows/detail/scan (stepping below 1 marks used up) |
| Pantry: **drag items between locations**; **Today card** (whole-card tap, mark-used) | ✅ | 🟡 | 🟡 | ✅ Done (web); mobile: **Pantry Today card now ships** (use-soon + running-low, "N on hand · M soon", taps into Pantry — iPhone card + iPad `kioskPantryCard`, module-gated); change location from the editor (**no drag** yet) |
| Pantry: **redesigned list** (location sidebar + counts, search, sort), **item detail** sheet | ✅ | 🟡 | 🟡 | ✅ Done — iOS matches the web: sidebar (chips on iPhone) of All/Use-soon/Running-low + locations, search, Expiring/A–Z/Recent sort, card grid + item detail |
| Pantry: **Open Food Facts** integration — barcode lookup (cached), nutrition + allergen snapshots, **"may contain" traces**, **dietary flags** (vegan/vegetarian/palm-oil-free), **replace photo** | ✅ | ✅ | ✅ | ✅ Done — iOS scan/type → `GET /api/pantry/lookup` → Found sheet → add (nutrition + allergen + traces snapshot ride onto the item; replace-photo on detail); **dietary flags** (Vegan / Vegetarian / Palm-oil-free) now render as green chips on the item detail |
| Pantry: **allergen warnings** — household avoid-list ∪ per-person allergens, colored letter badges + persistent key, red-ring on avoided, "affects X" | ✅ | ✅ | ✅ | ✅ Done — iOS **colored allergen badges** (G/D/S…, red ring when avoided) on cards + a legend; "Contains" / "⚠ Affects {people}" + "may contain" traces on the detail; the **household avoid-list** is now editable in **Settings → Pantry** (chip multi-select) |
| Pantry: **running-low threshold** (household default + per-item), **per-location icons** | ✅ | ✅ | ✅ | ✅ Done — iOS **Low** badge off the threshold + **per-location icons** in the sidebar; **Settings → Pantry** now edits the household running-low default, the **locations** (add/rename/remove/reorder), and their **per-location icons** (`PUT /api/pantry/config`); only the *per-item* threshold override stays web-only |
| Pantry: **item age** — added/bought date (distinct from expiry), household-customizable "old" threshold, "Been a while" group + "Oldest" sort, age chip | ✅ | ✅ | ✅ | ✅ Done — iOS: 🕰️ age chip on old rows + a "{age} ago" chip on the detail's **Added** row, a **Been a while** sidebar/chip filter, an **Oldest** sort, and a backdatable "Added / bought" date in the editor. Reads the household `staleMonths` from the server; the **"old" threshold is now editable** in **Settings → Pantry** |
| Pantry: **barcode camera scanner** — point at a barcode | ✅ | ✅ | ✅ | ✅ Done — iOS **native AVFoundation scanner** (EAN/UPC/Code128…) + a "Type instead" fallback for the simulator/denied camera; **no HTTPS constraint** (web uses zxing, needs a secure context) |
| Pantry ↔ meals: **Cook from your pantry** — recipes makeable now (staple-aware), on-hand **proteins as "mains"** → filtered recipe library, leftovers ("It's a meal"), **Plan my week** seeded with soon-to-expire, per-item **Plan it in** | ✅ | ✅ | ✅ | ✅ Done — iOS `CookFromPantryCard` in the Pantry surface (meals-gated) opens a self-contained modal with all five sections: Plan-my-week banner → seeded `PlanWeekSheet`; **Tonight · no cooking** leftovers with **Ate it** (consume) + **Plan** into a slot (planned-state derived from `/api/meals/week`); **You have everything** (`/api/pantry/cookable` `ready`) → recipe detail / Cook Mode; **You have the main** proteins → protein-filtered library + near-makeable recipes + **+ List** grocery add; **Use up soon** chips |
| Pantry ↔ meals: **cook → decrement** — marking a recipe cooked opens a "Used from your pantry" confirm sheet (Used some / Used it up / Didn't use; staples skipped) that decrements or uses-up stock; leftovers get **"Ate it"**; cooking flips today's planned slot to cooked | ✅ | ✅ | ✅ | ✅ Done — iOS: marking a recipe cooked (button or Cook Mode finish) fetches `/api/pantry/for-recipe` and, when it matches on-hand items, shows a `CookConfirmSheet` (server-suggested defaults) that POSTs `/api/pantry/consume`. Plan-slot flip is the server's free side-effect of `markCooked`. Leftovers **"Ate it"** ships in the Cook-from-pantry surface |
| **Family Night** module — recurring family gathering (default Mon) with a customizable agenda of "parts" that **auto-rotate** among members (override per week); **Today card** with per-part person pickers; admin agenda/day/time editor; optional weekly **calendar event** (auto-routes to owner's ★ default → Google when connected) | ✅ | ✅ | ✅ | ✅ Done — iOS ships the module (opt-in in Settings → Modules): a **Today card** (iPhone `FamilyNightCard` + iPad `kioskFamilyNightCard`) showing the next gathering's date + per-part **person-picker** (overrides this week's rotation via `POST /occurrence`), and a **Settings → Family Night** admin editor (weekday · time · "show on the calendar" schedule/unschedule · agenda parts CRUD). Entirely REST off `/api/family-night`. Phase 2 (web): history, recipe/goal links, idea bank |
| **Public API keys + scopes** — `waffled_…` key, `x-api-key`, `<resource>:read\|write` scopes | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web; build #3) — external-integration surface (pattern B), admin-issued |
| **Settings → API Keys** tab (generate / scope / reveal-once / revoke) | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web; admin-gated) |

## Settings

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **Family & people** (CRUD + grant login/PIN + **permissions grid**) | ✅ | ✅ | ✅ | ✅ Done |
| **Calendars** (connect Google, write-targets, sync now) | ✅ | ✅ | ✅ | ✅ Done |
| **Chores & rewards** (currencies, conversions, proof retention) | ✅ | ✅ | ✅ | ✅ Done |
| **Meals** (meal calendar & meal times) | ✅ | ✅ | ✅ | ✅ Done |
| **AI & capture** (provider/model selection) | ✅ | ✅ | ✅ | ✅ Done |
| **Display & Kiosk** (screensaver, photo source, idle, night-dim, preview) | ✅ | ✅ | ✅ | ✅ Done |
| **Modules** (toggle optional modules; see Modules & extensibility) | ✅ | ✅ | ✅ | ✅ Done (web + iOS) |
| **API Keys** (per-user keys + scopes for external integrations) | ✅ | ❌ N/A | ❌ N/A | ✅ Done (web; admin-gated) |
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
| Self-host via **Docker Compose** (`./waffled up`) | ✅ | — | — | ✅ Done |
| In-container **migrations** (one-shot) | ✅ | — | — | ✅ Done |
| **GHCR** multi-arch images (amd64 + arm64) | ✅ | — | — | ✅ Done |
| Optional **S3 backup** | 🚧 | — | — | 🚧 Parked (Phase 4) |
| Public ingress / auto-TLS beyond LAN | 🟡 | — | — | 🟡 Configurable (7.3) |
| Restore drills | 🚧 | — | — | 🚧 Planned (7.4) |

## Observability & operations

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Structured **JSON logging** + per-request access log | ✅ | — | — | ✅ Done |
| Deep **`GET /api/health`** (db, migrations, jobs, calendar backlog, storage) | ✅ | — | — | ✅ Done |
| **Settings → System Health** admin panel (live, polls /api/health) | ✅ | ⬜ | ⬜ | ✅ Done |
| **`./waffled doctor`** CLI health report (in-container, no token) | ✅ | — | — | ✅ Done |
| Background-**job run registry** (last-run / duration / error per scheduler) | ✅ | — | — | ✅ Done |
| Build **provenance** (git sha + build time on /healthz + /api/health) | ✅ | — | — | ✅ Done |
| **OpenTelemetry** traces+metrics (OTLP, **off by default**) | ✅ | — | — | ✅ Done |
| All-local **Grafana/OTEL stack** (`./waffled observability up`, profile) | ✅ | — | — | ✅ Done |

> **PowerSync scope note.** Offline-first currently covers the **calendar/events** domain
> on every surface (local-first reads + queued writes). The iOS app mirrors
> persons/events/event_participants/households locally. Other domains (chores, lists,
> rewards, goals, meals, photos) are REST-backed and need connectivity, kept in sync by
> the in-app live-refresh bus while online. Bringing **chores** into PowerSync is the
> prerequisite for offline chores *and* iOS chore reminders.

---

## Mobile backlog (planned, not yet built)

Tracked in [`apps/ios/IPAD_ROADMAP.md`](https://github.com/kevinpsites/waffled/blob/main/apps/ios/IPAD_ROADMAP.md). Highlights:

- **Chore reminders** on iOS — blocked on chores landing in PowerSync.
- **Recurring-event reminders** — the local scheduler doesn't expand recurrences yet.
- ~~**Multi-profile kiosk** (profile picker + per-person PIN) on iPad~~ — **shipped** as an
  opt-in shared-kiosk mode (single-login stays the default). See IPAD_ROADMAP Phase 6.
- ~~iPad Today per-card customize (drag/hide)~~ — intentionally not planned; the fixed
  three-group dashboard (recap banners · Today · goals) is the right shape for the wall display.
- **Household-wide** screensaver motion (currently a per-device toggle; would need the
  server display config + web to carry a `photoMotion` field).
- **Remote push** (APNs) for reminders when the app is closed.

See [roadmap status](https://github.com/kevinpsites/waffled/blob/main/docs/product/roadmap.md) for the cross-surface planned/partial items in context.
