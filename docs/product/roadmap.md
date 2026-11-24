# Roadmap status

A product-level view of what's **done**, **partial**, and **planned** — the **canonical,
living roadmap**. For the original milestone-by-milestone engineering plan and commit-level
rationale, see the [engineering plan](../engineering-plan.md).

Legend: ✅ done · 🟡 partial / in progress · 🚧 planned · ⛔ dropped (superseded)

## The big picture

> **Feature surface complete + self-host packaging shipped + extensibility layer opened.**
> A fresh `docker compose up -d` (two containers) comes up with real auth (built-in password / OIDC) and
> runs with zero external dependencies. Every feature domain (Today, Calendar, Chores,
> Rewards, Goals, Lists, Meals, Photos, AI capture) is built and usable on the Web/Kiosk,
> with a **pluggable optional-module framework** (first module: Pantry) and a **public,
> scoped API** for external integrations now layered on top.

> **0.16 simplified the stack.** The Mac app, the iOS app, the PowerSync offline layer, Caddy,
> Bonjour discovery and the `./waffled` CLI were removed (see **Removed in 0.16** at the bottom).
> Older entries below that mention iOS, iPhone/iPad, PowerSync or the Mac app record what shipped
> before then; the web/kiosk behaviour they describe is still current.

## Done ✅

- **Trackers — tap-to-log items.** A module (`trackers`, default **on**) for things like a
  medicine dose: every tap is kept, each tracker shows "Last time: MM/DD h:mm AM/PM" in the
  household timezone, and an optional "Ask who" ties an entry to a member. A Today card logs
  with one tap and an Undo toast; Tasks → Trackers manages them (adults/admins) and holds the
  history (anyone can fix a time or delete an entry). Not included: dose / "too soon"
  warnings, reminders, charts. How to use it:
  [docs → Trackers](https://docs.waffled.app/features/trackers/).
- **iPhone calendar: Month → Week → Day** — the phone Calendar tab rebuilt from the design
  handoff: a full-height month grid with ISO week numbers and up to four titles a day, a
  horizontal week card rail (tap an event to edit it), and a pushed Day timeline with overlap
  lanes, switched from the header's view menu or a pinch. Planned meals and thaw reminders
  get their own amber / faint styling, and week cards close on that night's dinner. Agenda
  stays, in the same menu. The
  decisions behind it: [ios-calendar-redesign.md](ios-calendar-redesign.md).

- **Per-person calendar columns (web/kiosk + iPad)** — a **People** view beside
  Month/Week/Day/Agenda that splits one day into a column per family member (the layout the
  dispencer17 fork had). "Whose column" resolves to **`events.person_id`** — the assignee
  that already drives the event's color, not `owner_person_id`, which `0074` added for
  personal-calendar visibility — **plus every participant**, so a shared event shows up for
  everyone it involves rather than only its owner. Bucketing is column-driven (each person
  is asked "is this yours?"), which ignores the external participants `0009` allows without
  inventing a column for them; anything nobody claims lands in a leading **Everyone**
  column instead of vanishing. Lanes are packed per column, so an event shown in three
  columns still spans full width where nothing else overlaps it. No schema or API work was
  needed: participants already ride both the REST payload and the PowerSync replica, so the
  view works offline like the others. On iOS it's **iPad-only**, as the original sizing
  predicted — it was briefly on iPhone too, but four members already truncate titles to
  "Dinn…", so the phone keeps its person filter instead (its views are now Month → Week →
  Day, plus Agenda). The iPad reuses the
  same `CalTimeGrid` the Week view uses, generalised so a column can be a person instead of
  a date; the person filter chips are hidden in People mode, since the columns already are
  that split.

- **Calendar color control (web/kiosk + iPhone/iPad)** — a household **Event style** (solid
  color blocks, the default, or the softer tint), a **family color** for events that involve
  everyone (instead of borrowing the owner's color), and a ninth **custom** swatch that opens
  a free hex picker wherever a person's color is chosen. On the web, chips carry their color
  as a CSS custom property, so solid↔tinted is one root attribute; iOS mirrors the same rules
  in `EventPalette`/`EventChipPaint`, resolved once per data change on `SyncManager`. Every
  chip carries the ink (black or white) that keeps its title readable on its own color, in
  both themes — one shared luminance rule, so web and iOS agree. Every calendar surface
  follows on both device experiences (month, week, day, agenda, the Today card in *both* the
  iPhone and iPad trees, and event detail). Server-side `#RRGGBB` validation on every route
  that writes a color, with a member's pre-existing value kept so it can't block their save;
  iOS also lets a non-admin set their own color from **Settings → Households**.
- **Sync watchdog (web)** — the kiosk supervises its own PowerSync engine. A stall (online
  and signed in, but not connected+synced for 3 min) triggers an escalating self-heal —
  reconnect, then rebuild the client, then wipe and re-download the local replica — backing
  off from 2 min to a 16 min ceiling, and never wiping while local writes are still queued.
  The calendar hooks ask `isReplicaTrusted()` before letting the replica outrank REST, so a
  wedged engine can no longer render a blank calendar; a stalled-sync strip and a **Live
  Sync (this browser)** card in System Health (starting · live · stalled · failed-with-error
  · off, plus manual restart / reset) make the state legible. Ported from the downstream
  fork, which hit exactly this failure in production. **Web only** — iOS keeps its existing
  PowerSync status handling.
- **Dark mode (web/kiosk + iPhone/iPad)** — a warm dark theme alongside light, chosen from
  **Settings → Appearance** (Light / Dark / Match system), saved per device and applied instantly,
  on every surface. Built on a consolidated design-token layer (web: one canonical `:root` + a
  `[data-theme="dark"]` override; iOS: dark-aware `Color(light:dark:)` tokens re-resolved by UIKit
  on the appearance change), with a shared palette and semantic success/danger/warn/info tokens so
  the two platforms read identically with the lights off.
- **Self-host packaging** — two containers from one `compose.yaml` (`docker compose up -d`; a
  multi-arch `waffled` GHCR image plus Postgres, `--build` for source), secrets generated on
  first start, migrations on start, and `docker compose pull && docker compose up -d` to upgrade.
  Optional backups (`--profile backup`) with a `restore` command.
- **Observability** — structured JSON logging, a deep `/api/health` + **Settings → System
  Health** panel, baked build provenance, and **OpenTelemetry** (off by default, pointed at your
  own collector). Restore drills still to come (7.4).
- **Operator CLI** — Immich-style break-glass commands
  (`docker compose exec -u node waffled node dist/admin.js <command>`: reset a member's
  password, list members, grant/revoke admin, toggle password login, clear a stuck calendar,
  prune sessions) that run in-container with no login required.
- **Identity** — built-in email/password auth (rotating refresh), backend-mediated **OIDC
  SSO** (invite-gated, admin-configured), member management (grant logins), **role-based
  permissions** (per-role capability grid for managing/approving chores, rewards & goals —
  see the [permission model](./permissions.md): *gate what touches currency or someone
  else's record; attribute collaborative actions; leave the rest open*).
- **Kiosk** — device pairing, profile picker, optional PINs, idle screensaver.
- **Today** — live cards + customizable per-user / family layouts.
- **Calendar** — native events, Month/Week/Day/Agenda, create/edit/delete, participants,
  **recurring events** (RRULE picker, per-occurrence/this-and-following/all edits),
  **two-way Google Calendar sync** and **two-way Outlook / Microsoft 365 sync** (recurrences
  expanded on inbound), **read-only ICS calendar feeds**, offline calendar (PowerSync), AI
  heads-up + per-event insight.
- **Chores & stars** — full loop: CRUD, weekly/custom schedules, **one-off + carry-over
  tasks** ("Just once" repeat + due date, unfinished one-offs roll forward with an
  **overdue · since …** badge, per-chore `rollover` toggle), up-for-grabs claim,
  drag-to-reassign, parent approval, **photo-proof on completion**, streaks, append-only
  stars ledger.
- **Rewards & economy** — catalog → redeem → approve → debit, multi-currency, conversions
  ("Trade"), saving-toward jar/bar.
- **Goals** — types (count/total/habit/checklist), shared vs each-tracks, create/edit/
  detail read-model, person + family overview, **calendar → goal** auto-count (single
  and recurring events) with learned suggestions and **per-goal ignored words**, **swappable data views** on the goal-detail
  page (heatmaps, year grid, pace-to-target, year ring, by-person bars, collection grid,
  consistency calendar) matched to goal type + timeframe. The Log sheet's **note chips
  now suggest a goal's own most-logged notes** (scoped per participant, blended with the
  defaults) instead of a fixed list — **Tier 1**; smarter ranking is Tier 2 under *Planned*.
- **Lists & groceries** — multi-lists, auto-built aisle board, quantity merge, pantry
  staples, live cross-surface refresh **plus cross-device refresh** (foreground + ~20s poll,
  since lists aren't on PowerSync), **item attribution** ("added by …" / from a meal plan
  or recipe), **add any recipe's ingredients from its page** — now with a **pick-specific
  picker** (add all or just what you need) — (no meal-plan entry needed; these survive the
  weekly rebuild), **assign a store to an item + a By-store board view** (free-text
  quick-select over your previously-used stores), **"Unscheduled" sections + week-rail
  rows** for off-plan recipes in the grocery board's by-meal view, and **Share list** — hand
  any list to a phone as grouped plain text via copy / share sheet / QR, with the store and
  assignee noted per item.
- **Meal Builder** — build one meal out of several recipes and treat it as one
  thing: name a plate, add recipes under Main / Sides / Dessert, meal-level servings,
  **a cook per dish**, and an optional "keep in library" that makes it reusable (saved
  meals are first-class in the recipe library, with a `Meal · N` badge, a 🍽️ Meals filter
  and search across the plate name *and* its dish titles). Schedule it to a night (one
  slot, one calendar event, feeds the weekly grocery rebuild) **or** put just its shopping
  on the list without scheduling — and take that back off again. The grocery board groups
  a plate's items under the plate; cook mode takes the whole plate, tabbed across its
  dishes with one shared timer dock, each dish keeping its own step and every timer
  naming the pan that's beeping (on mobile, a jump leaves a "back to step N" pill).
  Shipped on web, iPhone and iPad — add a dish by tapping the role's ＋, and drag a dish
  between roles once it's on the plate.
- **Meals & recipes** — week/month planners, recipe library, in-app editor (with
  **ingredient sections** + dividers and cross-section drag-drop), paste-markdown
  import **and share-as-markdown export** (a Share action compiles a recipe to the
  blessed Markdown format for the native share sheet / clipboard / `.md` download),
  overrides, cook mode, **per-step timers** (set in the editor; a floating
  cook-mode dock that ticks live, jumps to the step on tap, and rings a looping
  alarm + local-notification fallback), substitution-aware grocery build with a
  **per-week grocery board** (switch weeks to shop ahead — each week's meal items are
  their own list, typed items + staples stay global), AI
  plan-week/month (with a no-AI **shuffle** fallback that fills empty slots from
  your library, skipping recently-planned/cooked dishes), AI metadata auto-fill.
- **Photos** — wall (masonry), real blob upload (single + multi), albums, edit, multi-
  select bulk move/delete, screensaver + per-album screensaver source, crossfade
  slideshow, recipe hero images.
- **AI capture** — pluggable provider (Claude / OpenAI-compatible / Ollama), instant
  heuristic → LLM upgrade, offline fallback. The "Add anything" bar now **creates** across
  the app: events, tasks/chores, grocery, meals, custom lists, countdowns (incl. holidays by
  name), **family members** (admin-only), **goals**, **pantry items**, and **rewards** — each
  gated on the relevant module/permission and confirmed in an editable preview before it
  commits. The full "Add anything → Do anything" plan (mutate / settings / query / multi-action
  tiers) is in [`capture-expansion.md`](./capture-expansion.md), with the build plan in
  [`capture-tier2-plan.md`](./capture-tier2-plan.md); the create tier (Tier 1) is done, and the
  **mutate tier (Tier 2) is done on every surface (web, kiosk, iPhone, iPad)** — completing/reassigning
  chores, logging goal progress, rescheduling/cancelling an event (one occurrence, never the series),
  checking off/removing a list item, and redeeming a reward, via a parse → resolve-candidate → commit
  flow with module-owned resolvers. On iOS the same on-device parser mirror detects the verb and the
  sheet shows a pick-one candidate list before committing.
- **Weather** — Open-Meteo on the topbar (no key).
- **Extensibility — optional modules + public API** — a **pluggable optional-module
  framework** (registry + per-household `settings.modules` toggle, a **Settings → Modules**
  tab; Today cards / nav / routes gate on it), the first module — **Pantry / on-hand
  inventory** (items with quantities + locations, quantity stepper, "used up", drag between
  locations, a Today card) — and **per-user API keys + scopes** (`waffled_…` key via `x-api-key`,
  `<resource>:read|write` over the unchanged capability matrix, **Settings → API Keys** tab).
  Web today; the module flag is server-shared so iOS can grow native cards later. The two
  supported patterns (built-in toggle module · external integration via API keys) and the one
  we don't build (in-process plugins) are written up in
  [`extensibility.md`](./extensibility.md).
- **Rhythms — the things that should keep happening.** A new optional module (`rhythms`,
  default **off**) for the standing intentions with a cadence: "trash out weekly", "air
  filter every 3 months", "book a temple visit each quarter", "a self-care day every other
  month", "family outing on the third weekend". Deliberately *not* chores (no reward, no
  approval, no photo proof — and `ensureTodayInstances` can't express these schedules
  anyway: only `FREQ=DAILY` and `FREQ=WEEKLY`+`BYDAY`, matched by SQL substring, so there is
  no `MONTHLY` and no `INTERVAL`) and deliberately *not* goals: goals are about
  **follow-through**, while a rhythm is about the **opportunity existing** — getting a time
  set aside is the whole outcome, and whether it happened is never asked. One `rhythms` row
  (mig `0098_rhythms.sql`) carries the cadence, a `person_id` assignee and a `satisfied_by`
  discriminator: `'completion'` items are completion-anchored (due N months after you
  *actually* last did it, so being late shifts the next one), `'scheduling'` items are
  satisfied when a calendar event exists for the period. The three-state machine — **needs
  scheduling → scheduled → the period rolls over** — is served by one window query,
  `GET /api/rhythms/attention`, which is also the contract a future weekly-plan module reads.
  Booking a period creates a **real `events` row** carrying `rhythm_id` (mirroring
  `events.goal_id` from `0033_event_goal`) rather than a read-only chip, so it inherits
  recurrence, Google/Outlook sync, visibility, participants, the existing editor and local
  reminders for free; those events wear a 🔁 marker in every calendar view, on
  Today's agenda card and on the event detail, on every surface.
  A **Today card** (silent on quiet days) and a **register
  screen** cover completing, booking, skipping, editing, pausing and retiring — on all three
  surfaces — and completion-shape rhythms join
  countdowns as a fourth source ("18 days until the air filter"). `leadTime` is clamped
  so a runway can never outlive its cycle — to the whole cadence on a scheduling rhythm
  (whose feed closes when its window does) and to half of it on a completion rhythm (whose
  feed never closes on its own) — and the shape/anchor fields
  are immutable after creation because re-anchoring would re-interpret existing skips. REST-only
  by design (the booked events sync; the register doesn't).
  A **booking window** (`book_within`, mig `0099`) splits the two jobs `every` was doing —
  how often, and how wide a span a booking may land in — so *"date night, in the first week
  of the month"* is sayable at all: the period keeps the grid and the skips, the window says
  how much of it counts, and null (every rhythm predating the column) means the whole
  period. It is the one part of *when* that is editable in place, since it moves no boundary
  and re-keys no skip; it is refused alongside auto-schedule, whose rule already picks the
  day. The **event editor links an existing event to a rhythm** ("Keeps a rhythm"), so an
  outing planned in the Calendar screen settles the period instead of leaving the rhythm
  asking for something already booked. Design and schema:
  [Rhythms plan](./rhythms-plan.md); how to use it:
  [docs → Rhythms](https://docs.waffled.app/features/rhythms/). Per-surface status lives in
  the [feature matrix](../../website/docs/src/content/docs/reference/features.md).
  **One piece of UI shape is deliberately still open** — not a missing capability, and
  recorded in the plan doc under *Still open*: a **browsable completion history** — today the
  record and the real average appear when you edit a rhythm, which is where you already go to
  ask about one, but it is not a record you can page through.

- **Weekly Planning** — a guided session that walks the family through deciding the week
  ahead in ten steps (loose ends · calendar · horizon scan · family night · connection ·
  goals · meals · tasks · kids · recap). New optional `weeklyPlanning` module (default
  **off**), `planning_sessions` / `planning_session_steps` tables, and a server-owned step
  catalog so web and iOS can't drift on the shape of the session. **Shipped:** the
  module shell — Settings → Modules panel (session day/time, per-step opt-out), the
  `/planning` screen with its lobby, the step chrome (counter → agenda sheet, the one
  question, progress hair, skip/affirm footer), the saved record, plus a step-in-the-URL
  scheme, planning any later week, and both exits (leave for now / start the week over) —
  **and all ten steps** — Loose ends, Calendar, Horizon scan, Family night, Connection,
  Goals, Meals, Tasks, Kids, Recap — built in parallel behind a per-step file seam (see the
  plan doc's "Building the steps in parallel"), five at a time in two waves that merged with
  no conflicts, then a validation pass that fixed ten reported defects across five of them.
  **iOS parity shipped too** — the session shell (lobby, chrome, agenda sheet, the
  parked-note handoff with each step's lent verb, "leave for now" as a per-device pause,
  the saved record, the settings panel) and all ten step bodies, reachable from the Family hub,
  Settings, the iPad display's Today card, and a Planning page the iPad can pin to its rail. Built the same way
  the web steps were — a registry naming all ten keys and ten stub files on day one, so
  each step could be written against its own files and nothing shared; six agents in two
  waves, integrating with two compile errors between them, both in the wiring rather than
  the steps. The port also turned up three defects in shipped code: `step.number` is a
  CATALOG index and neither client's counter may use it (the server's own comment said the
  opposite), the progress hair was positional on web and settled-based on iOS, and iOS had
  never decoded `periodDone`/`stepDone`/`stepTotal` at all — so every iOS surface had been
  showing habit goals their LIFETIME count instead of this period's. The architectural
  point held: the session stores almost nothing — two tables
  (`planning_sessions`, `planning_session_steps`) plus `planning_parked_items` — and every
  decision lands in the module that owns it. Step 1 is the one exception and it stores nothing
  either: it *routes* items to later steps, recorded in the session's own jsonb — and the
  step it routes to now opens with the note, a shell-level handoff every step (and the iOS
  pass) inherits rather than implements. A later validation round added two things worth
  naming: the **finished week now reads the week back** on both clients — the saved record
  opens with step 10's own read-back (the seven days, what the session changed grouped by
  module, the last call, what was left alone) instead of a tick-list of step names, which
  survives underneath as the record of what was skipped on purpose — and **which of your
  lists step 1 asks about is now a household choice**, made IN the step by whoever is
  running the session (an opt-out map where absent means relevant, so a long-lived
  "someday" list stops coming up every session while overdue chores and late rhythms
  still always count; goals are the Goals step's, not step 1's). It is gated by a new `planning.manage` capability that
  every adult holds by default rather than by admin — running a session is not an admin
  act — with the same switches still in Settings → Modules → Weekly Planning. Design:
  `Weekly Planning v4` canvas; plan: `docs/product/weekly-planning-plan.md`.

## Partial / in progress 🟡

- **Waffled-Bites (kid companion device)** — the pairing system and the parent-facing
  control panel (Family → tap a kid → Waffled-Bite: quiet time, night light, wake-up
  light schedule, alarm, sound machine, screen brightness) are done on **web and iOS**
  (iPhone + iPad) — new optional `waffledBites` module, `waffled_bite_devices`/
  `waffled_bite_pairing_codes` tables, device polls `GET /api/waffled-bites/device/state`
  (no WebSockets). The on-device firmware (ESP32-P4 + LVGL 9.2,
  `apps/waffled-bite-firmware`) is also feature-complete — every screen (home, routines,
  quiet time, timer, bedtime, wake-light lock, settings, pairing, forget-device) is wired
  to the real API. Real-hardware bring-up on the target board (ELECROW CrowPanel
  Advanced 7") is underway, including an on-device WiFi-provisioning UI (scan, pick a
  network, enter the password on the built-in keyboard — no more hardcoded
  credentials), a fix for an intermittent WiFi-chip crash-loop found during bring-up,
  and the real "Waffled Buddy" mock's icons/colors/typography, verified on real
  hardware. Tap-to-complete on the device's own task list handles chores needing a
  parent's OK (shows "Waiting on a parent's approval" rather than silently reverting)
  and photo-required chores (hidden from the device's list entirely — no camera-capture
  flow yet, so those are completed from a parent's phone/web instead). **Pending:** device
  audio (see below), OTA updates, TLS certificate validation for `https://` server
  addresses, and on-device photo capture — see `apps/waffled-bite-firmware/README.md` for
  the full list of open items.
- **Offline scope (Web/Kiosk)** — there is no offline sync layer: every domain is REST plus
  the same-tab refresh bus, with a **cross-device refresh** (on focus + ~20s poll) for lists
  and the calendar so a family member's edit lands without a manual reload. Working offline
  beyond the PWA's cached shell is not supported.
- **Kiosk PWA** (7.1) — service worker + cached last-known state, to fully survive backend
  blips.
- **Public ingress** (7.3) — configurable (Caddy auto-TLS / Cloudflare Tunnel), operator's
  choice.

## Planned 🚧

- **Chore due-dates on the calendar.** The last piece of "the calendar as the all-in-one
  dated view": overlay `chore_instances.due_on` onto the calendar as read-only all-day chips,
  tapping through to the chore rather than the event editor. Deliberately chips, not
  time-grid blocks — a chore's `due_time` is a soft target, not an appointment. The other two
  sources are already handled and should **not** be built again: scheduling-shape rhythms
  *are* events, so they render natively with real recurrence, Google sync and visibility,
  and completion-shape rhythms flow in as a `source: 'rhythm'` countdown (month-grid badge +
  week/day chip). `list_items` stays out — it has no due column and lists shouldn't become a
  half-built task manager. One seam to settle first: chores have no visibility concept under
  `0074_calendar_visibility` (simplest rule: treat them as `family`). See
  [Rhythms plan](./rhythms-plan.md#how-this-lands-on-the-calendar).

- **Smarter goal-note suggestions (Tier 2).** Tier 1 shipped (see **Done**): the Log
  sheet's "What did you do?" chips now suggest the notes actually logged against that
  goal, scoped per participant, blended with the defaults. Tier 2 makes the ranking
  cleverer — weight by recency as well as raw frequency (a note used weekly should beat
  one used once months ago), merge near-duplicates beyond today's exact case/whitespace
  match ("family walk" vs "Family walk after dinner"), and consider surfacing a member's
  cross-goal favourites when a specific goal has little history of its own.

- **Today board v2 — a zone layout instead of a card order.** Today's board is a flat,
  reorderable list of cards in fixed columns; you choose the order and nothing else. v2
  replaces that with a **recursive zone tree** — split a zone, drop cards into it, and get
  a FancyZones-style layout the household actually designs: **live drag and resize with
  auto-save**, **layout presets** to start from, **density modes**, **hide-empty-cards**,
  a full-width band, and per-card "quiet" settings (e.g. cap a card at N items so a long
  list doesn't swallow the screen), with today's flat order migrated in automatically.
  This is a deliberate decision rather than a straight port: it **changes the
  `/api/today-layout` contract** every surface reads, and it is a big merge. Prior art in the
  [dispencer17 fork](fork-evaluation-dispencer17.md) (`zone-layout.ts`, `today-presets.ts`,
  `today-card-slot.tsx`).

- **Week calendar card on the Today board.** A whole-week view sitting on Today itself,
  rather than a trip to the Calendar page: a **people filter** to narrow it to one person,
  an **in-progress pulse** on whatever is happening right now, and a **"Separated days"**
  option for households that read the week as columns rather than one continuous list.
  Depends on the zone layout above — a week card wants real width and height, which the
  current fixed-column board can't give it. Also from the
  [dispencer17 fork](fork-evaluation-dispencer17.md).

- **List sharing (access, not a handoff).** Let a household invite specific people to a
  list, choose whether they can view or edit it, and revoke access later. Distinct from the
  shipped **Share list**, which is a one-way copy of the text to a phone and grants nobody
  any access.

- **Share list: a link-backed QR for long lists.** *Enhancement to the shipped
  [Share list](/features/lists/) handoff.* Today the QR encodes the list **text
  itself**, which is the feature's best property — the phone needs no app, no account,
  and no round-trip to the server. But a QR's capacity is fixed, so a long list pushes
  the code to a high version until its modules are too small for a camera to read. A
  measured 45-item list is 1,137 bytes → version 28, 129×129 modules; drawn at 320px
  that is 2.5 CSS px per module, under the ~3 a phone needs. The shipped behaviour is
  therefore honest rather than clever: draw the code as large and as low-density as it
  can be, and when the list still won't fit, say so and point at Copy / Share (which
  have no length limit) instead of rendering a code that cannot work.
  The enhancement: for lists past that threshold, have the QR encode a **short link**
  to a read-only shared view of the list instead of its text, so the code stays small
  and scannable at any length. That is a real feature, not a tweak — it needs a share
  endpoint, an unguessable token, an expiry/revocation policy, and a decision about
  whether the phone must be on the same LAN as the server (a self-hosted box usually
  isn't reachable from cellular). Worth pairing with **List sharing** above, since both
  want the same "a link that shows one list, to someone who isn't signed in" primitive.
  (Share list itself now covers **every** list, not just groceries — grouping by aisle on
  the grocery board and by section elsewhere — so the enhancement applies household-wide.)

- **Waffled-Bite DIY hardware setup guide.** A real, consumer-facing walkthrough for
  buying the board yourself ([ELECROW CrowPanel Advanced 7", ESP32-P4](https://www.amazon.com/dp/B0G34WGWJR))
  and flashing it with the open firmware (`apps/waffled-bite-firmware`) via PlatformIO —
  today there's no pre-flashed device or build service, so this is source-only and
  undocumented for anyone outside the project. `apps/waffled-bite-firmware/README.md`
  covers the engineering bring-up log; this would be the "buy this, plug in this cable,
  run this command" doc on the docs site, paired with the existing pairing walkthrough
  in [`waffled-bites.md`](../../website/docs/src/content/docs/features/waffled-bites.md).

- **Waffled-Bite audio — finish what the speaker can't do yet.** Phases 1 and 1b have
  **shipped**: white noise, ocean, rain, box fan and heartbeat play on the device's own
  speaker, from both the Sounds tile and a parent's panel, with a live volume slider and no
  pops — and the **morning alarm now rings**, with five synthesised wake tones, its own
  volume, and a pause/resume that hands the sound machine back afterwards. What's left is
  the **sampled
  sounds** (`forest`/`lullaby`/birdsong, shown disabled until real recordings exist). Plan:
  [`waffled-bites-audio-plan.md`](waffled-bites-audio-plan.md). Everything is **synthesised**
  on the device itself — no audio files, no streaming, so a kid's room stays
  quiet-not-silent and the alarm still goes off even if the home server reboots at 2am.
  Phase 2 adds the sounds that need real recordings, downloaded once from the server and
  cached on the device.

  **Working on real hardware.** Signed off: 22.05 kHz mono; the sound machine plays
  straight through quiet time and bedtime; the alarm gets its own volume and **pauses** the
  sound machine for 20 seconds rather than sounding over it; no playback resume after a
  reboot; and the hardware is the speaker that shipped with the board.

- **QR-code pairing for Waffled-Bites.** The device has a screen but no camera (the
  ELECROW board has none), so a QR flow only works one direction: the device renders a
  QR code — LVGL already ships a QR widget, just currently disabled (`LV_USE_QRCODE 0`
  in `apps/waffled-bite-firmware/src/lv_conf.h`) — that a parent scans with their phone
  to jump straight to a "confirm pairing" screen, replacing today's type-a-6-digit-code-
  on-the-device-keyboard step. Doesn't extend to Wi-Fi setup the same way: the device
  (not the phone) is the one that needs the SSID/password, and it has no camera to scan
  a code itself, so that stays the on-device network picker it is today.

- **Recurring-edit scope — chore scopes shipped; two calendar gaps remain.**
  Repeating chores now offer **this chore / this-and-following / whole series** on web.
  Occurrence snapshots keep completed and awaiting-approval history
  immutable; a settled occurrence can anchor a following edit or delete without itself
  changing. Remaining calendar work:
  1. **Fix a calendar edit bug:** under "this" / "this-and-following", the editor still lets you
     change **assignee, goal link, and the countdown flag**, but the server silently drops them
     (master-only / absent from `OVERRIDE_FIELDS`), a save the UI implies but never
     persists. Either store them as per-occurrence overrides
     or disable those fields for non-"all" scope.
  2. **Decide** whether calendar "all" should keep retroactively rewriting the recent past (it re-materializes
     the past ~3 months today) or leave already-passed occurrences untouched, the way delete already
     is deliberately guarded against wiping history.

- **Goal tier polish (following the Spotlight redesign).** The Spotlight / Pinned / More
  hierarchy shipped (one Spotlight hero per list, a Pinned band, then A–Z rows). One piece is
  still deferred: **manual drag-to-reorder for the Pinned band** — needs a `sort_order` column +
  a reorder endpoint + drag gestures on web (today the Pinned band is A–Z like More). Internally
  the Pinned tier is still the `is_featured` column; a clean rename to `is_pinned` is optional cleanup.

- **Pantry ↔ meal-planning loop.** The pantry redesign + Open Food Facts integration
  (cached barcode lookup/scanner, nutrition + colored allergen badges, household∪per-person
  allergen warnings incl. "may contain" traces, dietary flags, running-low thresholds,
  location icons, replace-photo) shipped, plus the first meal tie-ins: deterministic
  **"Cook from your pantry"** (recipes makeable now, staple-aware) + per-item **"Plan it in"**
  + **"Plan my week"** seeded with soon-to-expire items. **The loop is now closed:** marking a
  recipe cooked opens a "Used from your pantry" confirm sheet (matched items, each pre-set to
  Used some / Used it up / Didn't use; staples skipped) that decrements or uses-up on-hand
  stock; leftover items get an "Ate it" action; cooking also flips today's planned slot to
  cooked. We deliberately confirm rather than subtract exact amounts (units don't reconcile
  cleanly). Putting the shopping away also got out of the way of itself: the "Where" picker
  creates a **section on the fly** (`POST /api/pantry/locations`), and scanned amounts take
  **fractions** (½ a bag).
  **The grocery half now landed too:** the board badges any row the pantry covers
  (🥫 + the matched item and its own amount) and the recipe "Add to grocery" picker starts
  those ingredients unchecked. It **flags, never filters** — matching is presence-only, so
  we can say you have chicken but not that you have enough, and an extra item in the cart
  beats a second trip. Matched at read time rather than stamped during the weekly rebuild,
  so it can't go stale when you cook or scan. **Later:** true unit/quantity *comparison* for genuinely countable items
  (eggs, limes, cans — `lists/quantity.ts` already parses the amounts, and bulk goods like
  rice/pasta/flour are staples that never reach the list anyway, so this is a smaller job
  than it looks); vegetable-based "mains" + recipe filter.

- **Assign & show a cook per *slot*.** Half of this shipped with the
  Meal Builder: a plate assigns **a cook per dish** (`meal_recipes.cook_person_id`) with a
  cook badge on each dish row, which is the right grain for a multi-dish meal. What's still
  missing is the single-recipe case — `meal_plan_entries.cook_person_id` and the API's `cook`
  DTO exist (the demo seed even populates cooks), but **no UI assigns it**, so that data is
  still running ahead of the product. Left to build: a **"who's cooking?" picker** when
  planning or editing a plain recipe slot, wired to the existing `planMeal(…, cookPersonId:)`
  / `/api/meals/plan`, and the same cook badge on the planner grid, the Today "meals" card and
  the recipe detail. The phone only *displays* that cook today (`WeekPlannerView`) and web
  ignores it entirely; re-planning should preserve it. Un-gated (collaborative/attribution,
  like list authorship — no capability needed to volunteer or reassign a cook).

- **Scheduled plates should reference the library plate, not snapshot it (copy-on-write).**
  Scheduling a saved plate today **copies** it (`POST /api/meals/:id/schedule` →
  `copyMeal`), so the night points at a private duplicate. Recipe edits still flow through —
  the copy holds `meal_recipes.recipe_id` references and the grocery rebuild reads
  ingredients live — but **editing the saved plate itself never reaches nights already
  scheduled from it**: add a fourth side to "BBQ Sunday" and last Sunday, and next Sunday,
  keep the three they had. That leaves two mental models for one slot, which is the real
  problem: a scheduled *recipe* is a reference, a scheduled *plate* is a snapshot. The fix is
  to schedule by reference and copy only when someone edits **that night** (swap a side,
  change the cook, adjust servings) — the behavior people expect by default, while still
  protecting the template from a one-Tuesday tweak. Two costs to accept up front: editing a
  plate then also changes **past** nights still using it verbatim (and a grocery rebuild on an
  old week would follow), and the weekly-planning undo receipt's `mealId` check gets weaker,
  because re-picking the same library plate would no longer write a fresh `meal_id` — it
  stays correct, just no longer belt-and-braces. Bounding it to future weeks needs a
  "has this night been touched" flag; one rule is better than two.

- **Multi-household identity** — one email/account that belongs to many households (separate
  profile + role per household, switch after login). Design spike written + product decisions
  aligned: [`docs/design/multi-household-identity.md`](../design/multi-household-identity.md).
  Global `accounts` table over the existing per-household `persons`, concentrated in one tenant
  resolver; invite-and-accept to join, land on last-active household, admin-gated household
  creation (open self-serve onboarding deferred to a sell-time lift). Phased P1–P4.
  **P1 (schema + backfill) and P2 (account-aware auth module) shipped** — backend now
  authenticates the account, lands on the last-active household, supports `/api/auth/switch`,
  invite-and-accept, OIDC match-by-account, and admin-gated additional-household creation,
  with zero UX change for single-household accounts. **P3 web client shipped** — a
  Settings → Households switcher + pending-invite accept (appears only for multi-household
  accounts). **P4 operator CLI shipped** — `reset-password`/`prune-sessions` act across all of
  an account's households, plus `add-member` (attach an existing account to a household) and
  `list-accounts`. The only remaining server-side item is the optional, deferred cleanup of the
  legacy `credentials` table (login still verifies against it; `accounts` mirrors it).
- **Notifications tail** — kiosk "due soon" local banner (table not built yet); remote push
  (web-push) is blocked on a self-host key/relay decision.
- **Recurring-chore rollover** — the shipped `rollover` flag defaults on for *one-offs*;
  opt-in carry-forward for **recurring** chores still needs collapse-duplicates-to-one +
  streak handling before it can ship.
- **More optional modules** (on the new framework) — **Family Night SHIPPED (web) 2026-07-01**
  (generic customizable auto-rotating agenda + Today card + optional weekly calendar event);
  next up a **daily quote/snippet** card (the cleanest "built-in card also writable via the
  public API" demo), and API-key follow-ups: per-user (non-admin) issuance, an OpenAPI/published
  contract, and a CORS posture for cross-origin integrations.
- **Conversational recipe AI** — **photo → recipe and describe-it (speech/free-form → recipe)
  SHIPPED** in the "New recipe" editor: photos of a physical recipe are read by a
  vision model, and a rambly spoken/typed description is organized into ingredients + steps;
  both prefill the editor for review before saving, and source photos auto-delete after a
  short window. Still planned: **instruction-driven edits**
  ("make it vegetarian", "double it").
- **API-key scopes declared per route, not by path prefix.** Findings, measurements and
  the plan in [`api-key-scopes-plan.md`](./api-key-scopes-plan.md). Today `API_SCOPES` maps a
  path *prefix* to a resource and one global gate enforces it (`scopeForRequest` +
  `enforceApiKeyScope`), which has two costs. It is **fragile**: the scope lives far from
  the route, and a hyphenated sibling silently belongs to nobody — `/api/chore-instances`
  is not under `/api/chores`, `/api/pantry-staples` reads like pantry but is a lists route,
  and a bare `startsWith` would have made `/api/households/invites` readable with
  `family:read`. And it is **coarse**: a whole prefix gets one resource, so a surface that
  writes across modules (Weekly Planning hands out chores, features goals, adds events,
  fills the meal plan) has *no* correct scope — one `weeklyPlanning` scope would be a
  skeleton key past `chores:write` and the rest, which is why the prefix sits in
  `UNSCOPED_YET` instead. Declared per route, each route asks for the downstream scope it
  actually needs and both problems go. lambda-api supports this directly — method-based
  middleware (`api.post(path, requireScope('chores:write'), handler)`) and path-scoped
  `api.use`; earlier comments in `route-guards.ts` and `api-keys.ts` claimed otherwise and
  were simply wrong.
  **The trap to design around:** today's model is fail-*closed* by construction — a route
  absent from the catalog is 403, which is why the 29 planning routes were never an
  exposure. Naive per-route middleware inverts that: forget the guard and the route is
  wide open to any key. Global middleware runs *before* route middleware and `finally()`
  can't alter an already-generated response, so a global default-deny cannot be cleared by
  a later route guard. The fix is therefore a **typed registrar** wrapping
  `api.get/post/...` where a scope — or an explicit `sessionOnly` marker — is a *required*
  argument, so omission is a compile error and fail-closed survives the move. Retires the
  `scope catalog covers the route table` guard in `api-keys.integration.test.ts` and both
  deny buckets in `api-keys.ts`, which exist only because the declaration is remote from
  the route. ~135 routes, mechanical but wide.
- **Shared album import** for Photos (Google Photos / iCloud).
- **Server-side fuzzy person resolution** for capture (nicknames/aliases).
- **Milestone reward payouts** — deferred by design (needs idempotency + attribution rules).
- **Goal weekly check-in (Sunday recap)** — the goal-editor mock shows a "🔔 Weekly check-in"
  toggle, but there's no backend for it (it's a decorative, unpersisted toggle in the web
  editor). Needs a persisted per-goal
  flag + the actual Sunday recap surface on the kiosk before the toggle should reappear.
- **Soft "kids' list additions need an OK" toggle** — floated, *not committed*. Attribution
  already covers the real need; a per-role lists matrix is more machinery than a family hub
  wants. Recorded so the rationale isn't lost (see [permission model](./permissions.md)).
- **Optional S3 backup** (Phase 4) — parked.
- **Restore drills** (7.4) — pairs with the parked S3 backup.

## Removed in 0.16 ⛔ (the two-container simplification)

Waffled now runs as `docker compose up -d`: one `waffled` image plus Postgres. The following were
shipped earlier and removed, or planned and dropped, with the native clients and offline layer:

- **Waffled for Mac** (native menu-bar app and the `waffled-runtime` Go supervisor) and the
  planned follow-ons: Mac Settings redesign items, Mac observability, **Waffled for Windows**.
  Run Docker Desktop on a Mac instead.
- **iOS app** (iPhone planner and iPad family hub), including **offline-first calendar**, local
  notifications, native sign-in, **Apple Health → goals** (and its follow-ons), **iOS widgets,
  Siri & Shortcuts**, and **Bonjour "find your Waffled server"**. The web app and installable PWA
  replace it; goals are logged in Waffled.
- **iOS-only planned work**: the multi-household iOS switcher, App Store verification and the iOS halves of the planned items below.
- **PowerSync** offline sync and the sync-health/watchdog UI. Every client reads and writes
  through REST.
- **Caddy**, the `./waffled` CLI, `./waffled-demo` and the `:8081` demo stack, the Oracle Cloud
  Terraform recipe, and the observability (Grafana) compose profile. Use `compose.yaml`,
  `docker compose exec -u node -e WAFFLED_ALLOW_DEMO_SEED=1 waffled node dist/seed-demo.js base|meals|goals`, your own reverse proxy and your
  own OpenTelemetry collector.

## Dropped ⛔ (superseded by the self-host pivot, 2026-06-20)

The original cloud plan (Terraform/AWS, Auth0, GCP project provisioning, a separate
`worker` service) was abandoned in favor of the self-hosted Docker Compose model:

- Terraform AWS/Auth0/GCP stacks → replaced by Docker Compose + built-in auth + OIDC.
- Separate `worker` service → calendar sync runs in-process (5-min scheduler) in the api.
- Auth0 RS256 → HS256 local JWT (`LOCAL_JWT_SECRET`); PowerSync token exchange unchanged.

> `README.md` has been updated to the self-host model (repo layout, "stack in one breath",
> and SSO panel label). The old `BOOTSTRAP.md` (Auth0/AWS/Terraform-era console setup) has
> been **removed**; the still-relevant Google OAuth-client walkthrough lives in the **Google
> Calendar** admin guide on the docs site. The **self-host model in
> the [quick start](../../website/docs/src/content/docs/getting-started/quick-start.md)** and the `Self-hosted (Immich-style)` section of the
> [engineering plan](../engineering-plan.md) are the current source of truth.
