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
  rail + every page, re-laid-out big; runs on the counter). One binary, one
  [App Store listing](https://apps.apple.com/app/waffled/id6787621452) — the device picks
  the experience by idiom (`DeviceExperience`).
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
| **Dark mode** + Settings → Appearance (Light / Dark / Match system) | ✅ | ✅ | ✅ | ✅ Done — web/kiosk **and** iPhone/iPad share one warm-dark palette (`apps/ios/DARK_MODE.md`) |
| **Email/password** login (built-in) | ✅ | ✅ | ✅ | ✅ Done |
| Rotating refresh tokens + transparent 401-refresh | ✅ | ✅ | ✅ | ✅ Done (Keychain token store) |
| **OIDC SSO** (backend-mediated, invite-gated) | ✅ | ✅ | ✅ | ✅ Done (`ASWebAuthenticationSession`) |
| Admin-managed OIDC config (Settings, secret encrypted at rest) | ✅ | ❌ N/A | ❌ N/A | ✅ Done — web/server-only admin by design |
| Disable password login / force SSO (break-glass guard) | ✅ | ✅ | ✅ | ✅ Done — config is web/server-only admin by design; every client's login screen honors it (an SSO-only server hides the email/password form on web **and** iPhone/iPad) |
| **Member management** — grant a person a login (email ± password) + kiosk PIN | ✅ | ✅ | ✅ | ✅ Done |
| **Members CRUD** (profiles: name, avatar, color, role, admin, birthday) | ✅ | ✅ | ✅ | ✅ Done |
| **Custom member color** — a ninth swatch opens a free hex picker | ✅ | ✅ | ✅ | ✅ Done — any `#RRGGBB` value, validated server-side, and a solid chip picks black or white text so even a pale color stays readable. Web: member editor + My Profile. iPhone/iPad: member editor, plus **Settings → Households** so a non-admin can set their own color |
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
| Idle **screensaver** auto-start (after N min of no touch) | ✅ | ❌ N/A | ✅ | ✅ Done — holds off while a text field is focused (keyboard up), and resigns first responder if it does start, so it never drops over the keyboard mid-typing |
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
| **Customize** mode — drag to reorder + **× to hide** cards (hidden collect in a tray to add back) | ✅ | ✅ | 🟡 | ✅ Done (web + iPhone reorder + hide; a hidden card stays hidden even for module cards; iPad uses layout presets) |
| iPad Today **layout presets** (Balanced / Agenda / Meals / **Goal-focused**) | 🟡 | ❌ N/A | ✅ | ✅ Done (iPad-only; Goal-focused features a goal big + tonight's dinner) |
| Save layout **for me** (per-user, incl. which cards are hidden) vs **for everyone** (family default) | ✅ | ✅ | 🟡 | ✅ Done (iPad layout is device-local) |
| **Goals card** on Today — a chosen goal's progress with a **My spotlight / Family spotlight / specific goal** picker (grouped by list) | ✅ | ✅ | 🟡 | ✅ Done (web + iPhone; iPad Goal-focused preset shows a goal big) |
| **Lists card** on Today — pin one custom list (hardware run, packing list) with tap-to-tick-off and a picker on the card | ✅ | ✅ | ❌ | ✅ Done (web/kiosk + iPhone). Which list is pinned is stored **per device** (`waffled.todayListPick` in localStorage / `@AppStorage`), like the pinned Today goal — so the layout keeps ONE `lists` card key and no `list:<uuid>` key ever needs server-side validation or reaping. The auto-built grocery list is excluded (it has its own card); a pinned list that's since been deleted falls back to the first remaining one. **iPad kiosk is out** — `KioskDashboard` uses fixed layout presets, not the card-key layout, so it needs its own design pass |
| Mobile-specific Today layout (separate `{order,hidden}` config) | ❌ N/A | ✅ | ✅ | ✅ Done |
| **Rhythms card** on Today — a countdown block: *"3 want attention"* + *"All 10 →"*, each row led by its countdown (*7 days late · every 3 months*), the filled button kept for what is late or out of time; **I did it** on a completion rhythm, and booking / skipping on a scheduling one (web: **Book** + **Skip**; iOS: **Book a time** with Skip in the row menu, since the row is wider) | ✅ | ✅ | ✅ | ✅ Done on web and iOS — renders **nothing** on a quiet day rather than an empty card (same rule as Tonight with no dinner planned), since a quarterly register is silent most mornings. Module-gated and default-off, so it is injected into the board rather than living in saved layouts; the label still appears in Customize so it can be hidden and brought back. The register total in the header costs a second request, so it is only asked for on days the card actually renders (on iOS this falls out of SwiftUI installing no lifecycle modifier on an `EmptyView`). On a narrow kiosk column the header drops the count via `ViewThatFits` rather than truncating the card's own name |
| "Did these happen?" goal recap queue on Today | ✅ | ✅ | ✅ | ✅ Done (iPad banner opens `ReviewEventsView`) |
| "Needs your OK" approvals banner on Today | ✅ | ✅ | ✅ | ✅ Done (iPad banner opens `ApprovalsView`) |

## Calendar & events

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Native events (create / edit / delete) | ✅ | ✅ | ✅ | ✅ Done |
| **Multiple participants** per event (stacked avatars, per-person color) | ✅ | ✅ | ✅ | ✅ Done |
| Views: **Month / Week / Day / Agenda** | ✅ | ✅ | ✅ | ✅ Done (iPad = `KioskCalendarView` grids) |
| **People view** — one day, a column per family member | ✅ | ❌ | ✅ | ✅ Done (web/kiosk + iPad) — an event shows in its **owner's** column (`events.person_id`) *and* in every **participant's**, so a shared event reads from each person's lane; unclaimed events collect in a leading **Everyone** column. Same time grid as Week (`CalTimeGrid` generalised so a column can be a person), lanes packed per column. No schema/API change — participants already ride REST *and* PowerSync, so it works offline. **iPhone is out by design** — a phone splits into columns too narrow to read; use the person filter chips on Agenda/Month/Day instead |
| **Current-time "now" line** on the time grid (Week/Day) | ✅ | ✅ | ✅ | ✅ Done (live red rule; iPhone Day + iPad Week/Day) |
| Month cells show **event titles** (tap a day for times) | ✅ | ✅ | ✅ | ✅ Done |
| Agenda **dims past events** | ✅ | ✅ | — | ✅ Done — the Calendar agenda **and** the Today dashboard's agenda card fade already-ended events (web + iPhone) |
| Full-screen **event detail** (location/Directions, repeats, notes, timeline) | ✅ | ✅ | ✅ | ✅ Done (iPad detail is two-column) |
| Per-person filter | ✅ | ✅ | ✅ | ✅ Done |
| **Event style** — solid color blocks (default) or the softer tint, per household | ✅ | ✅ | ✅ | ✅ Done — set in **Settings → Family & People → Event style**; applies to every chip with a background (month cells, week/day blocks, all-day pills) on web, iPhone and iPad. Accent bars and month dots take the color but not the style |
| **Family color** for whole-family events (instead of the owner's color) | ✅ | ✅ | ✅ | ✅ Done — an event whose people cover every member paints in **Settings → Family & People → Family color**, on every calendar surface and the Today dashboard. A one-person household never qualifies. Member avatars keep the owner's color |
| **Two-way Google Calendar sync** (inbound poll + outbound push) | ✅ | ✅ | ✅ | ✅ Done (sync runs server-side; connect in Settings → Calendars) |
| **Two-way Outlook / Microsoft 365 sync** (same engine, via Graph) | ✅ | ✅ | ✅ | ✅ Done — sync runs server-side, so synced events appear on every surface. Connect an account from **Settings → Calendars** on web, iPhone or iPad; needs a free Azure app registration |
| **Calendar feeds (ICS)** — subscribe to any published .ics/webcal URL | ✅ | ✅ | ✅ | ✅ Done — read-only, no OAuth, polled every 15 min. Add and manage feeds from **Settings → Calendars** on any surface. Feed events can't be edited anywhere: the apps hide Edit/Delete and the API refuses the write (including quick-add and offline queues) |
| Connect calendars + per-person write-target (Settings → Calendars) | ✅ | ✅ | ✅ | ✅ Done |
| **Offline** calendar (PowerSync: local reads + queued writes) | ✅ | ✅ | ✅ | ✅ Done |
| AI **"Heads up this week"** digest + **per-event insight** | ✅ | ✅ | ✅ | ✅ Done |
| "Counts toward a goal" tag on an event | ✅ | ✅ | ✅ | ✅ Done |
| **🔁 rhythm marker** on an event that keeps a rhythm | ✅ | ✅ | ✅ | ✅ Done — a scheduling-shape rhythm books an ordinary event and points it back at itself (`events.rhythm_id`), so there is no separate entity to draw: just a glyph before the title in Month / Week / Day / Agenda / People **and** on Today's agenda card, plus a "This slot keeps a rhythm" line on the event detail. Deliberately not follow-through language — no "done", no streak |
| **Recurring events** — rrule **expansion / read** | ✅ | ✅ | ✅ | ✅ Done |
| **Recurring events** — **creation** (Daily/Weekdays/Weekly+days/Monthly/Custom) | ✅ | ✅ | ✅ | ✅ Done (repeat picker in the editor) |
| **Recurring events** — per-occurrence **edit scope** (this / following / all) | ✅ | ✅ | ✅ | ✅ Done (scope chooser on edit + delete) |
| **Recurring events** — **end condition** (never / on a date / after N) | ✅ | ✅ | ✅ | ✅ Done (UNTIL date + COUNT) |
| **Recurring events** — monthly **nth-weekday ordinal** (first…fifth / last) | ✅ | ✅ | ✅ | ✅ Done (mobile offers any ordinal) |
| **Countdowns** — "N days until X" from four sources (flag an event · standalone item · auto member birthdays · a completion-shape rhythm's next due date); Today card + month-grid badge; household "N sleeps" toggle | ✅ | ✅ | ✅ | ✅ Done — iOS reads the merged `GET /api/countdowns` for a **Today card** (iPhone `CountdownsCard` + iPad kiosk card; emoji · title · date · N-days/sleeps · standalone × remove · + Add; **tap a standalone row to rename/move/remove**) and **month-grid badges** plus **all-day rows in the iPhone/iPad calendar** (agenda / day / month-detail — a countdown-only day appears in the agenda too; tap to edit: standalone → the editor, event-source → its event); the event editor's **"⏳ Show a countdown"** toggle rides the full `is_countdown` offline path (PowerSync schema + local/REST writes); the **"N sleeps"** toggle is in Settings → Calendars. Web: the Today card countdowns are **tappable** (an event countdown opens its event, a standalone/birthday one opens the calendar day), countdowns render as **all-day chips** in the calendar **day/week** views (on top of the month badge), and **tapping a countdown on the calendar edits it** — a standalone one opens a rename/move/remove editor, an event one opens its event (rename + "Show a countdown" toggle) |

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
| **Goal tiers** — Spotlight (one hero per list) / Pinned band / More (A–Z), Spotlight-Pinned-Normal picker, one-tap pin/unpin, Today card → Spotlight | ✅ | ✅ | ✅ | ✅ Done (web + iOS); **Today card also pins a specific goal** (My/Family spotlight or a chosen goal). Only Pinned-band drag-reorder remains on roadmap |
| **How a group activity counts** — shared/each toggle + a measure-aware counting follow-up under "How do you measure it?" (total: full / split · count: each / once) with real-name worked examples | ✅ | ✅ | ✅ | ✅ Done (web + iOS) |
| **Checklist tick-off** — complete a checklist by ticking its named steps (in the goal detail + the Log sheet) | ✅ | ✅ | ✅ | ✅ Done (was iPhone-blocked; now shipped) |
| **Type-aware Log sheet** — count stepper, total amount, habit one-tap, checklist ticking; unit shown correctly | ✅ | ✅ | ✅ | ✅ Done (web + iOS) |
| **Hours + minutes for time goals** — a goal measured in hours takes separate hour/minute fields (no manual "10 min → 0.17"); the server folds them to decimal hours and durations read back as "2h 10m" | ✅ | ✅ | ✅ | ✅ Done (web + iOS) |
| **Smart note suggestions on the Log sheet** — the "What did you do?" chips are no longer a fixed list: each goal suggests the notes you've actually logged against it, most-used first, and scoped per person (the notes where that member took part, not merely who tapped Log). Falls back to the familiar defaults and tops up with them until a goal has enough of its own history | ✅ | ✅ | ✅ | ✅ Done (Tier 1). Smarter recency/frequency weighting + near-duplicate merging is Tier 2 (roadmap) |
| Create / **edit** / delete goals | ✅ | ✅ | ✅ | ✅ Done |
| **Edit / remove a logged entry** (amount, who took part, note, date; shared entries removed whole + re-split). An entry written by a checklist tick, a calendar confirm or an Apple Health sync is note-only — its amount/date/people stay owned by that source | ✅ | ✅ | ✅ | ✅ Done (web + iOS) |
| Type-aware **logging** (amount / stepper / once-a-day / tick steps) | ✅ | ✅ | ✅ | ✅ Done |
| Backdated logs ("When?" picker) | ✅ | ✅ | ✅ | ✅ Done |
| **Goal detail** read-model (milestone track, hours-by-person, streaks, recent) | ✅ | ✅ | ✅ | ✅ Done |
| **Goal-detail data views** — swappable progress visualizations (Week/Month heatmap, Year contribution grid, Pace-to-target, Year ring, By-person bars, plus Count's collection grid and Habit's consistency calendar) matched to the goal's type + timeframe, remembers your last pick per goal, tap a day/month for who logged what; the Week/Month heatmaps page back and forth via ‹ › **and (iOS) a horizontal swipe**, clamped so you can't page past the current period | ✅ | ✅ | ✅ | ✅ Done (web + iOS) |
| Checklist **named steps** + per-type **milestones** (text) | ✅ | ✅ | ✅ | ✅ Done |
| **Person profile** + **Family overview** | ✅ | ✅ | ✅ | ✅ Done (iPad = `KioskFamilyView` grid) |
| **Calendar → goal** auto-count recap (single events) | ✅ | ✅ | ✅ | ✅ Done (Phase 1) — a confirmed recap is dated to **the event's own day**, not the day you answered it, so catching up later doesn't move your progress |
| Smart "might count toward a goal" suggestions + learning | ✅ | ✅ | ✅ | ✅ Done (Phase B) |
| Recurring-event goal counting | ✅ | ✅ | ✅ | ✅ Done |
| **Capability gating** — `goal.manage` for others' / shared goals; own progress stays open | ✅ | ✅ | ✅ | ✅ Done |
| **Apple Health → goals** auto-fill (steps / flights / exercise / energy / distance — walk + run, cycling, swimming, wheelchair / **workouts by type** — running, cycling, swimming, yoga, strength or any / mindful / rings / mood), habit daily thresholds, grouped + searchable "Track from Apple Health" picker, gap catch-up | ❌ N/A | ✅ | ❌ N/A | ✅ Done (iPhone; iPad/web display the synced number). Distance is fractional in mi/km per device region; workout metrics count minutes on a total, sessions on a count, and any-workout or N-minute days on a habit |

## Rhythms

The things that should keep happening — the air filter, trash night, a temple visit each
quarter. Deliberately **not** goals: goals are about follow-through, a rhythm is about the
**opportunity existing**, so a scheduling-shape rhythm never asks whether it happened. See
[Rhythms](/features/rhythms/).

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **Rhythms module** (`rhythms`, default **OFF** — opt-in in Settings → Modules) | ✅ | ✅ | ✅ | ✅ Done — gates the nav entry, the routes, the Today card and the rhythm countdown source |
| Create a rhythm — **said as a sentence**: title · emoji · cadence · what closes out a period · assignee, with anchor and notes behind *More options* | ✅ | ✅ | ✅ | ✅ Done on every surface — *🌬 Air filter · every 3 months, counted when I mark it done, on Kevin*, and underneath it a card naming the two dates that are the whole promise: when the first one lands, and when it starts asking. Both derived through the same clamp the server applies, never from the typed runway, so the form cannot promise a nudge on a day nothing will happen. The shape is the **"counted when"** clause rather than an opening picker — the most abstract question there is, asked in the vocabulary of the schema, used to come first. Web lays the sentence out with `<br />`; iOS uses rows of a `VStack` and a two-line menu button for "counted when", because both answers need their consequence spelled out and a wheel has nowhere to put one |
| **Two shapes** — `completion` ("you do it") vs `scheduling` ("it gets scheduled") | ✅ | ✅ | ✅ | ✅ Done — completion is **completion-anchored** (the clock restarts from when you *actually* did it, so being late shifts the next one instead of stacking misses); scheduling is closed by a calendar event existing for the period |
| **Auto-schedule** a scheduling rhythm (the cadence fully determines when → one recurring event, created once) | ✅ | ✅ | ✅ | ✅ Done on every surface, editor included. The series is booked **when the rhythm is created** (6pm in the household's timezone, on the first day the rule allows at or after the start date — so an anchor and a chosen weekday that disagree don't produce a master on a day its own rule excludes), so it is on the calendar from the outset rather than waiting to be put there. Weekly rhythms pick the day with the calendar's own weekday chips (single-select everywhere: a rule firing twice a period would assert something the cadence never said, and one booking settles it either way); monthly rhythms pick same-date / same-weekday / last-weekday; **Advanced** is the raw-RRULE escape hatch behind a disclosure. Leaving the chips alone follows the start date, which is the default rather than the only option. A **monthly nth-weekday** rhythm has its periods anchored on the **first of the month** by both editors, and this is load-bearing rather than tidiness: `starts_on` anchors the grid *and* seeds the series, and third Saturdays wander over the 15th to the 21st — anchored on the 19th, one period holds two occurrences and the next holds none, and a period with none can never be satisfied, so the register asks forever while the series sits on the calendar in plain sight. The server walks the rule across the first twelve periods on create and **refuses** one that skips a period, naming the empty period and the fix; only emptiness is refused, since a rule firing more than once a period over-books but always settles it |
| **Nudge runway** (`leadTime`) — "warn me before it's due" / "how many days' warning before the booking window closes" | ✅ | ✅ | ✅ | ✅ Done — clamped server-side to at most **half the cadence**, or to the **booking window** where there is one (the window is the span it is meant to ask in, so halving that would go quiet mid-window) (a runway longer than the cycle never closes, so the item would never go quiet); the editor states the runway you'll actually get in days. It **follows the cadence** — half the cycle, capped at a fortnight — until a number is typed, rather than defaulting to a flat 14 that the server then trimmed without saying so. A typed number is still sent as typed, with the clamp admitted next to it in both numbers |
| **Book a period** → a real calendar event carrying `rhythm_id` | ✅ | ✅ | ✅ | ✅ Done — date + time + all-day only; title and assignee come from the rhythm. The event is ordinary, so it inherits recurrence, colors, participants, visibility, reminders and Google/Outlook sync for free. The picker is clamped to the period's **booking window** — a booking outside it satisfies the wrong period, or, where the window is narrower than the period, none at all |
| **Booking window** (`bookWithin`) — a span narrower than the cadence that a booking must land in | ✅ | ✅ | ✅ | ✅ Done — *"date night, in the first week of the month"* is a monthly cadence with a 7-day window inside it, and before this it could not be said at all: `every` was both how often and how wide a span a booking could land in, and the only phase control was a runway measured back from the period's end and capped at half the cycle — so a monthly rhythm could not be asked about before mid-month, nor a quarterly one before mid-quarter. The period keeps the grid (how often, and what `rhythm_skips` is keyed on); the window says how much of it counts, measured from the period's **start**. Null means the whole period, which is what every rhythm predating the column has, so none of them change. Head-anchored with no separate offset — `starts_on` already phases the grid, so "the last week of the month" is an anchor on the 25th with a 7-day window. Satisfaction, the runway, the claimed-period check on `POST /:id/schedule`, the picker's bounds and every "how long have I got" line on both clients follow the **window** bound. Refused alongside auto-schedule, in the CHECK constraint and with a sentence at the door: they answer the same question and the rule wins, and allowing both lets the rule generate its occurrence outside the window, making every period unsatisfiable |
| **Link an existing event to a rhythm** — settle a period from the event editor | ✅ | ✅ | ✅ | ✅ Done — `events.rhythm_id` was writable end to end from the start and no client ever set it, so a family outing planned in the Calendar screen left the rhythm asking you to book the thing already on the calendar. Both event editors now carry a **"Keeps a rhythm"** picker listing the household's active **scheduling** rhythms (a completion rhythm closes its period on "I did it", so an event pointing at one would settle nothing). Unlinking is an **explicit null**: every write path treats an absent `rhythm_id` as "leave it alone" so a client predating the column cannot blank a link by omission — the web's local-first path therefore carries the column on both its insert and its update, and iOS leaves the field off the wire entirely unless the picker changed it |
| **Skip a period** | ✅ | ✅ | ✅ | ✅ Done — sends one period quiet without inventing a calendar entry for something that isn't happening. A skip settles the period the same way a booking does, so the list reports it as satisfied with **no booked time** — which is how a row tells "on the calendar at 2pm" apart from "not happening this quarter" |
| **When a booked period is booked** — the time on a settled row | ✅ | 🟡 | 🟡 | 🟡 Server done — the list carries `bookedAt` / `bookedAllDay`, taken from the earliest thing on the calendar for that period, whether that is a one-off booking or an occurrence of an auto-scheduled series (`all_day` read off the occurrence, since an override can move one instance without touching the series). No surface renders the time yet |
| **Push a completion rhythm out** ("push it out a week") | ✅ | ✅ | ✅ | ✅ Done — in the row's ⋯ menu on every surface, and on a leading swipe on iOS (the design's own gesture; the menu carries it too, because a swipe is invisible until you try it). The new date is **today or the due date, whichever is later, plus a week**: counted from a date already missed, "a week" on something six days late would bring it back tomorrow. It moves the clock without recording a completion, and it is one period's reprieve rather than a permanent shift — the next completion re-anchors from when you actually did it. Offered only while the rhythm is actually asking (Needs you now / Coming up): there is nothing to defer on a Steady row. `PATCH /api/rhythms/:id` takes `nextDueAt` for the completion shape only and refuses it on a scheduling rhythm, whose periods *are* its anchor and whose skips are keyed on them — **Skip a period** is that shape's version of this |
| **Completion history + the real average** | ✅ | ✅ | ✅ | ✅ Done — `GET /api/rhythms/:id/completions` returns a page (50 by default, 200 ceiling) newest-first, plus `total` and `averageIntervalDays`. The average is taken over **every** completion rather than over the page: derived from the most recent 50 it would be a *recent* average wearing the wrong label, and that only becomes visible to someone with years of history. Null from fewer than two — one date is not an interval, and neither client fills that in with a number of its own. Editing a rhythm you mark done shows it: *Done 6 times · about every 123 days, against every 3 months*, over its recent dates. Stating it **against the nominal cadence** is the point — a rhythm set to 3 months that really runs at 5 is the cadence telling you it is wrong. Never requested for a scheduling rhythm, which has no completions by design |
| **Mark a completion rhythm done** (any time, not just when due), and **backdate one** | ✅ | ✅ | ✅ | ✅ Done — "I did this today" resets the clock; **Mark done on another day** (web, in the row's ⋯ menu) / **Log it for another day** (iOS) records the date it actually happened (never a future one), which is the date the clock restarts from. Once done, the button reads **Done today ✓** rather than offering itself again, and a second press on the same day doesn't record a second completion |
| **Register screen** — grouped by urgency, with current-period state per rhythm | ✅ | ✅ | ✅ | ✅ Done on web and iOS — **Needs you now / Coming up / Steady**, each heading carrying its own count, paused named in a line at the bottom. Every row is anchored by a countdown (*6 days late*, *3 months*, **Booked**) over a hairline for how much of the cycle is spent, soonest-first inside each group; the countdown takes its colour from the band, so a booking window closing tomorrow reads as urgently as one already late. Its subtitle **leads with the cadence** and never restates that countdown — *Every week · not on the calendar yet · Jerry*. "Needs you now" is the same `/attention` list the Today card reads, so the two can never disagree about one rhythm. The shapes are no longer named as headings — they show up in that subtitle and in the row's verb (**I did it** vs **Book a time**). A rhythm that books its own series distinguishes the two ways its period comes up empty: with the series alive and one occurrence missing it reads *nothing on the calendar this time* and offers the ordinary **Book a time**, since one event in one period is exactly what a hand-booked row is missing too; with no recurrence left at all it reads *the series needs putting back* and offers **Put it back**. Without that split, two identically-worded rows sprouted two different buttons — and the wrong one created a *second* series beside the live one, doubling every future occurrence. A verb appears only where there is one worth pressing: Steady rows get none, because a page of buttons for things with nothing to do reads as a page of chores. Skipping a period and booking one whose runway hasn't opened both live in the ⋯ menu — the second is the case `/attention` structurally cannot report, so quietening a row must not remove it. The per-row nudge setting is gone from both surfaces: repeated on every row it was noise, and it lives in the editor where the number is chosen |
| **Edit / pause / retire a rhythm** | ✅ | ✅ | ✅ | ✅ Done — edit covers title · emoji · notes · assignee · nudge runway, plus the **cadence on a rhythm you mark done**; **Pause** stops a rhythm asking without losing anything, and **Retire** removes it while keeping its completion history. `satisfiedBy`, `startsOn`, `autoSchedule` and `rrule` are deliberately not editable — and neither is the cadence **on a scheduling rhythm**, whose periods are generated from it: re-anchoring a live rhythm would re-interpret existing skips (keyed on `period_start`) and point bookings at periods that no longer exist. Both clients render the cadence as a fixed token there, the way they already render the shape, rather than offering a control the server will refuse. A rhythm you mark done has no period grid and nothing keyed on one, so changing its cadence just moves the next due date. The **booking window** is the one part of *when* that is editable in place on a scheduling rhythm: it moves no boundary and re-keys no skip, and the worst it does is put a period back to asking, which is visible and undone by widening it again |
| **Completion rhythms as countdowns** ("18 days until the air filter") | ✅ | ✅ | ✅ | ✅ Done — a fourth countdown source, module-gated. Scheduling rhythms need nothing here: they're events, so the per-event `is_countdown` toggle already works |
| **Offline** | ❌ | ❌ | ❌ | 🟡 REST-only by design — the register and Today card need a connection (same as chores). The **events** a rhythm books are fully offline like any other event |

## Lists & groceries

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| Custom **multi-lists** (sectioned items, quantities, assignees) | ✅ | ✅ | ✅ | ✅ Done (iPad = master/detail) |
| Create / rename / delete lists (cascade) | ✅ | ✅ | ✅ | ✅ Done — mobile: **swipe** a list → **Edit** (rename/emoji, `PATCH /api/lists/:id`) + **Delete**; the list-detail ⋯ menu's **Edit list** opens that same name+emoji editor (so the icon is editable from inside the list), and **Delete list** is there too |
| **List templates** — save a list as a reusable template, apply → a fresh unchecked copy, manage (delete) | ✅ | ✅ | ✅ | ✅ Done — mobile: one New-list modal (name + emoji + Create) with an "Or start from a template" picker (**select-then-Create**, name pre-fills from the template); long-press a template to delete |
| **Auto-built grocery board** from the week's dinners | ✅ | ✅ | ✅ | ✅ Done |
| **Share list** — hand any list to a phone (text / share sheet / QR) | ✅ | ✅ | ✅ | ✅ Done — grocery board + custom lists, identical text on every surface. Web/kiosk add a **QR** the phone camera grabs (no app, no account; a list too long to encode legibly falls back to Copy / Share). iOS uses the **system share sheet** instead — the QR exists to get a list *onto* a phone, and the app already is one |
| **Copy as Markdown** — the same list as a `- [ ]` checklist for Notes / Obsidian / an issue tracker | ✅ | ✅ | ✅ | ✅ Done — a second copy target beside Share, never a replacement: same items (unchecked only), same walking order, same store/assignee notes, with `##` section headings. The plain-text share and the QR payload are byte-for-byte unchanged. Web: a button in the Share list dialog; iOS: the list's ⋯ menu, and behind the share icon on the grocery board |
| **Add a recipe's ingredients to the grocery list from its page** — no meal-plan entry needed (one-off dinners, sides, snacks); quantities merged, items linked back to the recipe | ✅ | ✅ | ✅ | ✅ Done — web: cart icon in the recipe actions (plus the on-hand banner button); mobile: "Add to grocery list" in the recipe ⋯ menu + the banner button |
| **Choose which ingredients to add** — "Add to grocery" opens a picker to add all or just the ones you need, instead of always adding everything. Ingredients start checked **except** the ones your pantry actually has; pantry staples stay checked but are flagged "likely on hand" to steer what you uncheck | ✅ | ✅ | ✅ | ✅ Done — web + iOS; `POST /api/lists/grocery/from-recipe/:id` takes an optional `ingredientIds` subset (both clients always send one; omitting it keeps the older add-all-non-staples behavior). Pantry pre-uncheck works on **web + iPhone/iPad**, driven by `inPantry` on each ingredient in `GET /api/recipes/:id`; the sheet says how many it unchecked so nothing happens silently, and the button reads "Nothing to add" when the pantry covers the whole recipe |
| **"You already have this" on the grocery board** — a row matching something on your pantry shelves gets a 🥫 badge naming the matched item and its amount ("Chicken breast: 3"). Flags only — matched rows are never filtered off the list | ✅ | ✅ | ✅ | ✅ Done — web + iOS. `GET /api/lists/grocery/board` returns `pantry: {name, amount, unit} \| null` per row, matched at read time (a stamped flag would go stale the moment you cook or scan) and `null` throughout when the `pantry` module is off — which the clients read as "we don't know", never as "you have none". Matching is presence-only, so the badge reports the pantry item's own amount rather than judging sufficiency. On a **fuzzy** match the badge leads with the matched item's name ("Frozen peas · 2 bags"), since that's the half that can change your mind; on an exact one the name is already the row's, so only the amount shows. The badge sits **under** the item name on every surface — as a trailing chip it starved the name column and wrapped it mid-word. It also rides the **iPad kiosk Today grocery card**, which is fed by the same board endpoint, so the shelf nudge is there on the screen the household actually walks past |
| **Assign a store to a grocery item + group by store** — tag items with where you'll buy them (Costco, Walmart, …) and switch the board to a **By store** view; the store field is a free-text quick-select backed by your previously-used stores | ✅ | ✅ | ✅ | ✅ Done — web + iOS; migration 0090 adds `list_items.store`, `GET /api/lists/stores` returns the household's stores (most-used first), merged with in-use values so "Costco" typed once comes back as a chip |
| **Remove an off-plan recipe from the grocery list** — undo the above; the recipe drops out of the by-meal "Unscheduled" shelf, keeping any items it shares with another recipe | ✅ | ✅ | ✅ | ✅ Done — web: **Remove** on the by-meal Unscheduled section, or an **×** on the "This week's meals" Unscheduled rail; mobile: long-press the section → **Remove from list** (`DELETE /api/lists/grocery/from-recipe/:id`) |
| **Unscheduled recipe sections in By-meal view** — off-plan recipes group under their own "Unscheduled" header with their own dot color, instead of lumping into "Other items"; they're also listed in the "This week's meals" card below a divider, completing the dot-color legend | ✅ | ✅ | ✅ | ✅ Done |
| **Aisle grouping** + **quantity merge** (By aisle / By meal) | ✅ | ✅ | ✅ | ✅ Done |
| **Pantry staples** (kept off the list; Pantry check) | ✅ | ✅ | ✅ | ✅ Done |
| Check off / add / delete (persists) | ✅ | ✅ | ✅ | ✅ Done |
| **Item attribution** — "added by {name}" / "🍽 from meal plan" | ✅ | ✅ | ✅ | ✅ Done |
| **Re-aisle** a grocery item (move it to another aisle section from its editor) | ✅ | ✅ | ✅ | ✅ Done — mobile: section chips + an **Auto** chip (clear the override → classify by name) in the item Details editor |
| **Move an item to another section** — refile without opening the full editor: **drag** a row across sections (web drag-and-drop; iPhone/iPad native press-and-drag via `.onMove`, so swipe-to-delete still works); the Details editor also sets the section | ✅ | ✅ | ✅ | ✅ Done — PATCHes the item's category |
| **Item priority** — set an item's urgency on a **1–5 scale** (1 = not urgent · 3 = normal · 5 = urgent) from its editor; High/Urgent items show a row flag. Setting a priority doesn't reorder the list; a web **Sort: manual ⇄ By priority** toggle flattens it highest-first on demand | ✅ | ✅ | ✅ | ✅ Done — web + iOS; API stores `priority` (1–5, default 3, mig 0084 + 0085) and returns manual order (priority sort is a client-side opt-in) |
| **Completed section** on a custom list — checked items tuck into a collapsible "Completed" group (with an undo grace window) instead of lingering in place. Checked items **auto-clear ~24h** after check-off (per-list `auto_clear_checked`, default 24h; grocery is exempt — its checked = in-cart), and a **Clear** button sweeps the section on demand. A list's item count reflects only **unchecked** items | ✅ | ✅ | ✅ | ✅ Done — web + iOS; auto-clear runs lazily on load (no cron), scoped to `list_type='custom'` |
| **Bulk-edit items** — enter Select mode, pick multiple items, and set their **section / assignee / priority** (including into a **new section**) for the whole selection; changes stage and apply on **Done** (`PATCH /api/list-items/bulk`, household-scoped, patches only the fields you set) | ✅ | ✅ | ✅ | ✅ Done — web + iOS |
| **Collapsible sections** on a custom list — collapse/expand each section from its header | ✅ | ✅ | ✅ | ✅ Done — web now matches iOS |
| **Sticky add section** — the add bar's section picker keeps its choice across quick adds, so a run of items lands in the same section; the picker can also **create a new section** inline (even on a list with none yet) | ✅ | ✅ | ✅ | ✅ Done — web now matches iOS |
| **Cross-surface live refresh** (Today ↔ Lists ↔ Rewards) | ✅ | ✅ | ✅ | ✅ Done (in-app refresh bus) |
| **Cross-device list refresh** — a family member's edit on another device shows up without a manual reload | ✅ | ✅ | ✅ | ✅ Done — lists aren't on PowerSync (only the calendar is), so both clients refetch a list on app/tab foreground and poll ~20s while it's on screen (silent; iOS skips while editing/multi-selecting). Not instant push — up to ~20s |

## Meals & recipes

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **Weekly** meal planner grid + recipe picker | ✅ | ✅ | ✅ | ✅ Done |
| **Month** meal view + planner | ✅ | ✅ | ✅ | ✅ Done |
| Drag-to-swap on week/month grid | ✅ | ✅ | ✅ | ✅ Done |
| Full-screen **recipe detail** (hero image, metadata chips, servings scaler) | ✅ | ✅ | ✅ | ✅ Done — mobile now renders **uploaded photos** in the hero **and** the library cards (via the cached, URL-resolving image loader), not just the emoji placeholder |
| **Total time** on the card (prep + cook); prep/cook split on the detail | ✅ | ✅ | ✅ | ✅ Done (mobile) |
| **Recipes library** (search-all, multi-select filters, sort) | ✅ | ✅ | ✅ | ✅ Done |
| **Never-cooked "🆕 New" tag + filter** (recipes you haven't tried) | ✅ | ✅ | ✅ | ✅ Done — mobile: "New" library toggle (`cookedCount == 0`), 🆕 card badge, tappable 🆕 New chip on the detail → library filtered to New |
| **Recently viewed** — a shortcut strip back to recipes you just had open | ✅ | ✅ | ✅ | ✅ Done — per-**person** by default with an **Everyone** switch for the household's combined history (migration 0096 `recipe_views`, `POST /api/recipes/:id/view`, `GET /api/recipes/recent?scope=me\|household`). One row per person+recipe whose timestamp moves, so a recipe opened fifty times stays one entry; deleted recipes drop out; the scope choice is remembered per device. Hidden entirely until there's history |
| Create / **edit** recipes in-app (all metadata + ingredients + steps) | ✅ | ✅ | ✅ | ✅ Done (full editor — shared iPhone/iPad; **per-step ingredient amounts**; **ingredient sections** with dividers + cross-section drag-drop; **remove the photo** via a trash button next to the image field — clears the stored blob, not just the link; delete is web-only) |
| **Paste-markdown** recipe import (template/example) | ✅ | ✅ | ✅ | ✅ Done (paste → parse → fills the editor for review, then save) |
| **Share a recipe** as a Markdown file (the inverse of paste-markdown import) | ✅ | ✅ | ✅ | ✅ Done — a **Share** action on the recipe detail compiles the recipe into the blessed Markdown format (`GET /api/recipes/:id/markdown`) and hands it to the platform share options: iOS native share sheet with a `.md` file (Messages / Mail / Save to Files); web `navigator.share`, falling back to copy-to-clipboard + `.md` download. Round-trips back through paste-markdown import |
| Per-recipe **overrides** (substitutions, notes) | ✅ | ✅ | ✅ | ✅ Done — mobile now edits **ingredient substitutions** (⇄ per row → `overrides.subs`, feeds the substitution-aware grocery build) alongside per-step + recipe notes |
| **Cook mode** (step-by-step, wake-lock, finish → mark cooked) | ✅ | ✅ | ✅ | ✅ Done (mobile: left-aligned full-width large type) |
| Cook-mode **recipe overview** (jump to any step + ingredients) | ✅ | ✅ | ✅ | ✅ Done (mobile; large sheet) |
| **Per-step timers** — set in the editor; floating dock in cook mode | ✅ | ✅ | ✅ | ✅ Done (mobile: bottom-right dock, live tick, tap → jump to step, looping alarm + local-notif fallback) |
| **On-the-spot cook timer** — add a timer to a step that never had one, mid-cook | ✅ | ✅ | ✅ | ✅ Done — mobile: "⏱ Add timer" on timer-less steps, minute/second **wheel pickers** (flick to a value), ephemeral for the session |
| Open recipe **full-screen** from Today | ✅ | ✅ | ✅ | ✅ Done (iPad opens full-screen, not a page-sheet) |
| **Grocery auto-build** honoring substitutions | ✅ | ✅ | ✅ | ✅ Done |
| **Shop a future week** — switch the grocery board between weeks (‹ ›, with "This week") to see and build next week's list ahead of time | ✅ | ✅ | ✅ | ✅ Done — each week's meal-derived items are their own list (`?weekStart=` on `/api/lists/grocery/board` + `/rebuild`), so building or checking off one week never clobbers another; off-plan recipe adds land on the viewed week. Manually-typed items + pantry staples stay on one global running list shown on every week. Web: week nav in the grocery header; iOS/iPad: week switcher above the list. Existing installs backfill onto the current week (honoring first-day-of-week + timezone) |
| **Refresh keeps your cart · Start over clears it** — Refresh rebuilds a week's auto items but leaves checked-off items checked; a separate Start over un-checks that week's list | ✅ | ✅ | ✅ | ✅ Done — `POST /api/lists/grocery/clear-checks?weekStart=` un-checks a week's items (per-week, so it never touches another week); both buttons sit in the meals rail |
| AI **Plan my week / month** (library-only, themes, gaps) | ✅ | ✅ | ✅ | ✅ Done |
| **Shuffle my week / month** — no-AI fallback for Plan my week & month | ✅ | ✅ | ✅ | ✅ Done — when no LLM provider is configured, `Plan my week` and `Plan my month` fill the empty dinner slots with random library recipes instead of erroring: skip recipes already planned in that window or cooked in the last ~14 days, leave filled slots untouched, degrade gracefully when the library is small, and return `via:"shuffle"`. Transparent to every client |
| **Try New Recipe** — nudge the AI week toward novelty / list specific dishes to try | ✅ | ✅ | ✅ | ✅ Done — mobile: "Try something new" toggle + "Dishes to try" chips in the Plan-my-week sheet (sent on the initial full draft) |
| AI **metadata auto-fill** (cuisine, protein, vegetables, tags) | ✅ | ✅ | ✅ | ✅ Done (debounced "✨ Thinking…" in the editor; fills empty fields / suggestion chips) |
| **AI recipe import** — **photo → recipe** and **describe-it** (speech/free-form → recipe) | ✅ | ✅ | ✅ | ✅ Done (web + iOS) — in "New recipe": read photos of a physical recipe with a vision model, or dictate/type a loose description; both prefill the editor for review before saving. Source photos auto-delete after a short window. Photo needs a vision provider (Claude / OpenAI / vision Ollama); describe works with any. iOS uses the device camera / photo library and on-device Apple Speech dictation; the two import buttons appear only when the household's provider supports them |
| **Meal Builder** — build one meal out of several recipes (a "plate") | ✅ | ✅ | ✅ | ✅ Done — name it, add recipes under **Main / Sides / Dessert**, set meal-level servings, assign **a cook per dish**. Saved meals are first-class in the recipe library (a `Meal · N` badge, a 🍽️ **Meals** filter, search spans the meal's name *and* its dish titles); adding a saved meal to a plate flattens it into its dishes. Adding a dish is a tap through the recipe/meal picker on every platform; a dish already on the plate can be **dragged between roles** (on iPhone/iPad via a press-and-hold over one flat run of rows — a `List` reorders only within a section and refuses `.dropDestination`) |
| Meal Builder — **schedule a meal** to a night, or **add it to the list** without scheduling | ✅ | ✅ | ✅ | ✅ Done — scheduling fills that day+slot (`meal_plan_entries.meal_id`), goes on the calendar as one event and feeds the weekly grocery rebuild; "Add plate to list" only shops for it (`source='recipe'` rows the rebuild never wipes) and can be **taken back off** again — rows the week's own plan still needs survive. On mobile a planned plate opens from the week grid, the month grid, the Tonight card and the grocery recap, and **dragging** one to another night keeps its dishes |
| Meal Builder — **the meal's shopping, grouped as one meal** | ✅ | ✅ | ✅ | ✅ Done — the grocery board's by-meal view groups a plate's items under the plate (badged **Unscheduled** when it isn't on a night), one dot per row in the plate's colour, one row per item however many dishes want it. A plate whose items are all claimed by an earlier meal keeps its heading and says where they went |
| **Cook a whole meal** in cook mode (tabbed across its dishes) | ✅ | ✅ | ✅ | ✅ Done — tabs across every dish with one shared timer dock, so timers started on one dish keep running while you read another (each dish keeps its own step). Timers are keyed by **(dish, step)**, so the dock, the alarm and the lock screen all name the pan that's beeping. On iPhone/iPad, jumping to a timer's step leaves a **"Back to step N · <dish>"** pill that restores where it pulled you from (stays until used or dismissed). Reachable from the meal itself — a **Cook meal** button on the plate — and from the Tonight card |
| **Which ingredients are still to buy** (not just how many) | ✅ | ✅ | ✅ | ✅ Done — the recipe detail's on-hand banner and every dish on a plate expand "N to buy" into the ingredient names (`toBuyNames`). With the Pantry module on these are the *unmatched* ones specifically, which no client could derive from the ingredient list alone; with it off, no on-hand claim is made at all |
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
| Natural-language capture → event / task / grocery / meal / list | ✅ | ✅ | ✅ | ✅ Done |
| Capture a **countdown** ("12 days until Disney", "countdown for the beach party on Aug 25", "countdown for Thanksgiving") | ✅ | ✅ | ✅ | ✅ Done (always-on; resolves the target day — incl. holidays by name — editable in the preview; any detected emoji is carried through) |
| Capture a **family member** ("add my son Max", "add a family member named Robin") | ✅ | ✅ | ✅ | ✅ Done (admin-only; infers adult / teen / kid, editable in the preview; non-admins get a friendly "ask an adult" note) |
| Capture a **goal** ("set a goal to read 20 books this year", "I want to get in shape") | ✅ | ✅ | ✅ | ✅ Done (infers count / total / habit / checklist + target, unit, deadline — all editable; gated on the Goals module) |
| Capture a **pantry item** ("add milk to the pantry", "put 2 cans of beans in the fridge") | ✅ | ✅ | ✅ | ✅ Done (distinguished from grocery by an explicit pantry / fridge / freezer target; offered only when the Pantry module is on) |
| Capture a **reward** ("add a reward: ice cream night for 50 stars") | ✅ | ✅ | ✅ | ✅ Done (parses the star/point cost, editable; needs Rewards enabled **and** the `reward.manage` capability — kids see "ask a parent") |
| **Do things**, not just add ("mark the trash chore done", "give the dishes to Wally", "log 20 min on my reading goal", "move soccer to Thursday 4pm", "cross off milk", "redeem movie night") | ✅ | ✅ | ✅ | ✅ Done (Tier 2 mutate verbs, all surfaces). Resolves the thing by description (pick-one when ambiguous), server-only, destructive actions confirm. Verbs: **complete / reassign a chore**, **log goal progress**, **reschedule / cancel an event** (one occurrence, never the whole series), **check off / remove a list item**, and **redeem a reward**. **Best with an AI provider** — without one the on-device parser handles common phrasings only (the preview flags it). Not every verb works on every kind yet |
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
| Pantry: quantity **stepper** + tap-to-type amount, **fractional amounts** (½ a bag), **"used up"** state | ✅ | ✅ | ✅ | ✅ Done — iOS: ± stepper on rows/detail/scan (stepping below 1 marks used up); the **scan sheet's amount is typeable** with one-tap **¼ ½ ¾** shortcuts, and fractions add up across re-scans without float noise |
| Pantry: **drag items between locations**; **Today card** (whole-card tap, mark-used) | ✅ | 🟡 | 🟡 | ✅ Done (web); mobile: **Pantry Today card now ships** (use-soon + running-low, "N on hand · M soon", taps into Pantry — iPhone card + iPad `kioskPantryCard`, module-gated); change location from the editor (**no drag** yet) |
| Pantry: **redesigned list** (location sidebar + counts, search, sort), **item detail** sheet | ✅ | 🟡 | 🟡 | ✅ Done — iOS matches the web: sidebar (chips on iPhone) of All/Use-soon/Running-low + locations, search, Expiring/A–Z/Recent sort, card grid + item detail |
| Pantry: **Open Food Facts** integration — barcode lookup (cached), nutrition + allergen snapshots, **"may contain" traces**, **dietary flags** (vegan/vegetarian/palm-oil-free), **replace photo** | ✅ | ✅ | ✅ | ✅ Done — iOS scan/type → `GET /api/pantry/lookup` → Found sheet → add (nutrition + allergen + traces snapshot ride onto the item; replace-photo on detail); **dietary flags** (Vegan / Vegetarian / Palm-oil-free) now render as green chips on the item detail |
| Pantry: **allergen warnings** — household avoid-list ∪ per-person allergens, colored letter badges + persistent key, red-ring on avoided, "affects X" | ✅ | ✅ | ✅ | ✅ Done — iOS **colored allergen badges** (G/D/S…, red ring when avoided) on cards + a legend; "Contains" / "⚠ Affects {people}" + "may contain" traces on the detail **and on the scan confirm sheet**, so a barcode warns before you put it away; the **household avoid-list** is now editable in **Settings → Pantry** (chip multi-select) |
| Pantry: **running-low threshold** (household default + per-item), **per-location icons** | ✅ | ✅ | ✅ | ✅ Done — iOS **Low** badge off the threshold + **per-location icons** in the sidebar; **Settings → Pantry** now edits the household running-low default, the **locations** (add/rename/remove/reorder), and their **per-location icons** (`PUT /api/pantry/config`); a **＋ New** option in the add + scan sheets' "Where" picker also creates a section on the fly (`POST /api/pantry/locations`); only the *per-item* threshold override stays web-only |
| Pantry: **item age** — added/bought date (distinct from expiry), household-customizable "old" threshold, "Been a while" group + "Oldest" sort, age chip | ✅ | ✅ | ✅ | ✅ Done — iOS: 🕰️ age chip on old rows + a "{age} ago" chip on the detail's **Added** row, a **Been a while** sidebar/chip filter, an **Oldest** sort, and a backdatable "Added / bought" date in the editor. Reads the household `staleMonths` from the server; the **"old" threshold is now editable** in **Settings → Pantry** |
| Pantry: **barcode camera scanner** — point at a barcode | ✅ | ✅ | ✅ | ✅ Done — iOS **native AVFoundation scanner** (EAN/UPC/Code128…) + a "Type instead" fallback for the simulator/denied camera; **no HTTPS constraint** (web uses zxing, needs a secure context) |
| Pantry ↔ meals: **Cook from your pantry** — recipes makeable now (staple-aware), on-hand **proteins as "mains"** → filtered recipe library, leftovers ("It's a meal"), **Plan my week** seeded with soon-to-expire, per-item **Plan it in** | ✅ | ✅ | ✅ | ✅ Done — iOS `CookFromPantryCard` in the Pantry surface (meals-gated) opens a self-contained modal with all five sections: Plan-my-week banner → seeded `PlanWeekSheet`; **Tonight · no cooking** leftovers with **Ate it** (consume) + **Plan** into a slot (planned-state derived from `/api/meals/week`); **You have everything** (`/api/pantry/cookable` `ready`) → recipe detail / Cook Mode; **You have the main** proteins → protein-filtered library + near-makeable recipes + **+ List** grocery add; **Use up soon** chips |
| Pantry ↔ meals: **cook → decrement** — marking a recipe cooked opens a "Used from your pantry" confirm sheet (Used some / Used it up / Didn't use; staples skipped) that decrements or uses-up stock; leftovers get **"Ate it"**; cooking flips today's planned slot to cooked | ✅ | ✅ | ✅ | ✅ Done — iOS: marking a recipe cooked (button or Cook Mode finish) fetches `/api/pantry/for-recipe` and, when it matches on-hand items, shows a `CookConfirmSheet` (server-suggested defaults) that POSTs `/api/pantry/consume`. Plan-slot flip is the server's free side-effect of `markCooked`. Leftovers **"Ate it"** ships in the Cook-from-pantry surface |
| **Rhythms** module — the standing intentions that should keep happening (air filter every 3 months, trash weekly, a quarterly temple visit), with a Today card, a register, period booking into real calendar events and a 🔁 marker on the events that keep one. See [Rhythms](#rhythms) above | ✅ | ✅ | ✅ | ✅ Done — opt-in in Settings → Modules. Everything ships on all three surfaces |
| **Family Night** module — recurring family gathering (default Mon) with a customizable agenda of "parts" that **auto-rotate** among members (override per week); **Today card** with per-part person pickers; admin agenda/day/time editor; optional weekly **calendar event** (auto-routes to owner's ★ default → Google when connected) | ✅ | ✅ | ✅ | ✅ Done — iOS ships the module (opt-in in Settings → Modules): a **Today card** (iPhone `FamilyNightCard` + iPad `kioskFamilyNightCard`) showing the next gathering's date + per-part **person-picker** (overrides this week's rotation via `POST /occurrence`), and a **Settings → Family Night** admin editor (weekday · time · "show on the calendar" schedule/unschedule · agenda parts CRUD). Entirely REST off `/api/family-night`. Phase 2 (web): history, recipe/goal links, idea bank |
| **Waffled-Bites** module — pair a kid's companion touchscreen device (Family → kid → Waffled-Bite) and control it live: quiet-time countdown (start/pause/+5/end), night light (color + brightness), per-day wake-up light schedule (yellow "almost time" warning + green go-time), morning alarm, sound machine, screen brightness, tap-to-complete on the device's own task list (approval-required chores show "Waiting on a parent's approval" after tapping; photo-required chores are hidden from the device's list entirely — completed from a parent's phone/web instead, no camera-capture flow yet), and a device-side timer/bedtime preview | ✅ | ✅ | ✅ | 🟡 Partial — pairing + parent control panel done on **web and iOS** (iPhone + iPad); the on-device app (ESP32-P4 + LVGL) is real-hardware-verified with the real "Waffled Buddy" mock's icons/colors/typography — the sound machine plays on the device's speaker (white/ocean/rain/fan/heartbeat, synthesised on-device so it survives a server outage); the morning alarm rings too (five synthesised wake tones, its own volume, and it pauses the sound machine for 20s rather than sounding over it); the sleep timer fades the sound out when it runs out and writes that back so the panel agrees; remaining gaps are the sampled sounds (forest/lullaby/birdsong), OTA updates, TLS cert validation, and on-device photo capture |
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
| Household settings (name, week start, timezone, location) | ✅ | ✅ | ✅ | ✅ Done — **week start** (Sunday or Monday) sets the day every household week is cut on, everywhere: the meal planner's weekly + monthly grids and the "Plan my week/month" review, the calendar's month/week grids (plus the agenda mini-month and its "whose week is busy" summary), the goal heatmaps (week/month/consistency/year), the "This week / Next week" pickers that schedule a recipe or a saved meal, and the grocery list's own weeks — which is why a mis-cut planner week used to leave one unshopped |
| **Event style + Family color** (how the calendar is colored) | ✅ | ✅ | ✅ | ✅ Done — admin-gated (Settings → Family & People) on every surface |
| **About** (version, editable server address + switch warning) | — | ✅ | ✅ | ✅ Done (mobile) |
| **Lists** settings | 🚧 | 🚧 | 🚧 | 🚧 Planned ("Soon") |

## Sync, offline & platform

| Feature | Web / Kiosk | iPhone | iPad | Status |
| --- | :---: | :---: | :---: | --- |
| **PowerSync** offline mirror to local SQLite | 🟡 (calendar) | ✅ | ✅ | ✅ Done (persons · events · participants · households) |
| Offline writes queued + drained on reconnect | 🟡 (calendar) | ✅ | ✅ | ✅ Done (events domain) |
| Other domains (chores/rewards/goals/lists/meals/photos) | REST | REST | REST | 🟡 REST-only, kept fresh by the in-app refresh bus while online |
| Offline status + pending-uploads + last-synced indicators | ✅ | ✅ | ✅ | ✅ Done |
| **Sync watchdog** — detects a wedged sync engine and self-heals it | ✅ | ⬜ | ⬜ | ✅ Done (web) — **not planned for iOS**, which keeps its existing PowerSync status handling. A stall (online + signed in but not synced for 3 min) triggers a soft reconnect, then a client rebuild, then a replica wipe + re-download, with backoff from 2 min to 16 min. The wipe is skipped whenever local writes might still be queued — including when a wedged client can't report its queue — and is tried at most once per stall (re-armed by a fully successful sync), so a long outage can't wipe the replica repeatedly. An engine that crashes on boot is retried on the same backoff, rebuild-only |
| **Replica-trust fallback** — the calendar reads over the network when the local copy can't be trusted | ✅ | ⬜ | ⬜ | ✅ Done (web calendar) — **not planned for iOS**. A stalled or never-fully-synced local copy can no longer outrank a good server response, so a wedged engine never renders an empty calendar |
| **Live Sync (this browser)** card in System Health | ✅ | ⬜ | ⬜ | ✅ Done — web admin surface (like the System Health panel itself). Distinguishes starting · live · connecting · stalled · failed (with the error) · off, counts watchdog restarts, and offers manual **Restart sync** / **Reset local copy** |
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
>
> The **replica-trust fallback** applies to the web calendar, because that's the only web
> surface that reads from the local copy today. As other domains join PowerSync, they
> should adopt the same rule: never let an untrusted local copy outrank a good server
> response.

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
