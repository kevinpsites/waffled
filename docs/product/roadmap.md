# Roadmap status

A product-level view of what's **done**, **partial**, and **planned** — the **canonical,
living roadmap**. For the original milestone-by-milestone engineering plan and commit-level
rationale, see the [engineering plan](../engineering-plan.md).

Legend: ✅ done · 🟡 partial / in progress · 🚧 planned · ⛔ dropped (superseded)

## The big picture

> **Feature surface complete + self-host packaging shipped + extensibility layer opened.**
> A fresh `git clone` + `./waffled up` comes up with real auth (built-in password / OIDC) and
> runs with zero external dependencies. Every feature domain (Today, Calendar, Chores,
> Rewards, Goals, Lists, Meals, Photos, AI capture) is built and usable on the Web/Kiosk,
> with a **pluggable optional-module framework** (first module: Pantry) and a **public,
> scoped API** for external integrations now layered on top.

## Done ✅

- **Dark mode (web/kiosk + iPhone/iPad)** — a warm dark theme alongside light, chosen from
  **Settings → Appearance** (Light / Dark / Match system), saved per device and applied instantly,
  on every surface. Built on a consolidated design-token layer (web: one canonical `:root` + a
  `[data-theme="dark"]` override; iOS: dark-aware `Color(light:dark:)` tokens re-resolved by UIKit
  on the appearance change), with a shared palette and semantic success/danger/warn/info tokens so
  the two platforms read identically with the lights off.
- **Self-host packaging** — one-command `./waffled up` (pulls multi-arch GHCR images by
  default; `--build` for source), in-container migrations, and one-command `./waffled
  upgrade` (repo fast-forward + version bump + DB snapshot + pull + migrate).
- **Observability** — structured JSON logging, a deep `/api/health` + **Settings → System
  Health** panel, **`./waffled doctor`**, baked build provenance, and **OpenTelemetry**
  (off by default) with an all-local **`./waffled observability up`** Grafana stack. Restore
  drills still to come (7.4).
- **Operator CLI** — Immich-style **`./waffled admin`** break-glass commands (reset a member's
  password, list members, grant/revoke admin, toggle password login, clear a stuck calendar,
  prune sessions, regenerate the PowerSync key) that run in-container with no login required.
- **Identity** — built-in email/password auth (rotating refresh), backend-mediated **OIDC
  SSO** (invite-gated, admin-configured), member management (grant logins), **role-based
  permissions** (per-role capability grid for managing/approving chores, rewards & goals —
  see the [permission model](./permissions.md): *gate what touches currency or someone
  else's record; attribute collaborative actions; leave the rest open*).
- **Kiosk** — device pairing, profile picker, optional PINs, idle screensaver.
- **Today** — live cards + customizable per-user / family layouts.
- **Calendar** — native events, Month/Week/Day/Agenda, create/edit/delete, participants,
  **recurring events** (RRULE picker, per-occurrence/this-and-following/all edits),
  **two-way Google Calendar sync** (recurrences expanded on inbound), offline calendar
  (PowerSync), AI heads-up + per-event insight.
- **Chores & stars** — full loop: CRUD, weekly/custom schedules, **one-off + carry-over
  tasks** ("Just once" repeat + due date, unfinished one-offs roll forward with an
  **overdue · since …** badge, per-chore `rollover` toggle), up-for-grabs claim,
  drag-to-reassign, parent approval, **photo-proof on completion**, streaks, append-only
  stars ledger.
- **Rewards & economy** — catalog → redeem → approve → debit, multi-currency, conversions
  ("Trade"), saving-toward jar/bar.
- **Goals** — types (count/total/habit/checklist), shared vs each-tracks, create/edit/
  detail read-model, person + family overview, **calendar → goal** auto-count (single
  and recurring events) with learned suggestions, **swappable data views** on the goal-detail
  page (heatmaps, year grid, pace-to-target, year ring, by-person bars, collection grid,
  consistency calendar) matched to goal type + timeframe.
- **Apple Health → goals (iPhone)** — link a goal to an Apple Health / Apple Watch metric
  (steps, flights climbed, exercise minutes, active energy, **distance** — walking + running,
  cycling, swimming, wheelchair; fractional, mi/km per device region — **workouts by type** —
  running / cycling / swimming / yoga / strength training, or any workout — plus **mindful
  minutes**, **activity rings** — Move/Exercise/Stand or all three — and **mood**, iOS 17+) and
  its progress auto-fills: numeric goals accumulate each day's total, a **habit** counts a day
  whenever it clears a daily threshold ("2,000 steps a day, 5×/week"), and rings/mood count a
  day when the ring closes or a mood is logged. Ring/mood links also work on a **count** goal —
  each met day adds one, so "close my Exercise ring 15× this month" or "log my mood 20 days"
  accumulate toward the target (open days add nothing; a later correction self-adjusts).
  **Workout metrics read your actual `HKWorkout` sessions** (a different query shape from the
  cumulative totals) and pick the measure that fits the goal — **minutes** on a total, **sessions**
  on a count, and for a habit either "any workout counts the day" or an at-least-N-minutes bar.
  The **"Track from Apple Health" picker** is grouped by goal shape (adds-up metrics for
  total/count vs qualifying-day habits, rings first), searchable, and shows your
  live value per metric so you pick something real. Opening the app **catches up every missed
  day** since the last sync (bounded at the goal's creation date, so it never back-fills from
  before the goal existed). Opt-in per goal in the editor's **Extras** (next to calendar
  auto-count), plus a **Settings → Permissions** screen for managing device access. iPhone-only
  by nature (HealthKit); iPad/web just display the synced number. *(Tiers 0–2 of the
  [staged plan](../design/healthkit-goals.md); background sync + a rewards tie-in remain — see
  below.)*
- **Lists & groceries** — multi-lists, auto-built aisle board, quantity merge, pantry
  staples, live cross-surface refresh, **item attribution** ("added by …" / from a meal plan
  or recipe), **add any recipe's ingredients from its page** (no meal-plan entry needed —
  these survive the weekly rebuild), and **"Unscheduled" sections + week-rail rows** for
  off-plan recipes in the grocery board's by-meal view.
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
- **iOS** (mobile) — a **universal app**: the iPhone *personal planner* and the iPad
  *family hub* (nav rail + every page) in one binary. Near-complete feature parity with the
  Web/Kiosk — Today, Calendar (incl. **recurring events** — create, per-occurrence edit/
  delete scope, end condition, and a live "now" line on the time grids), Chores (incl.
  **photo-proof**), Rewards, Goals, Lists, Meals, Photos, AI capture, **role-based permission
  gating** + the permissions matrix editor, native sign-in (password + OIDC), offline-first
  calendar over PowerSync, and local event notifications (Snooze/View). The iPad also has the
  **family-display screensaver** (idle
  photo slideshow · clock · weather · next event · night-dim). The newer modules reached
  parity too — **Pantry** (Open Food Facts lookup, cook→decrement, Cook-from-pantry, and a
  Settings → Pantry editor), **Calendar Countdowns**, and **Family Night** — plus a
  **customizable iPad nav rail** (a per-device pick + a "More" overflow hub) and a
  three-tier **Settings** reorg (Account · Family · System). The **July 2026 family-hub batch**
  reached iOS parity too — **list templates** (+ swipe/detail list edit & delete), **on-the-spot
  cook timer**, **Try New Recipe**, the **never-cooked 🆕 tag**, and **spot-award stars** (person
  profile + Rewards page) — plus **owner-first family ordering** and a **kid-facing Reward Shop
  redesign** (wallet hero · category chips/sections off `reward.category` · redeem + confetti
  celebration) whose **tab now shows the shop with person tabs on top** (web-style; iPhone + iPad).
  Reward **categories** are settable on iOS (editor chip-picker), and the **Countdown tweaks**
  `birthdayHorizonDays` control shipped in Settings → Calendars — so the July-batch iOS parity is
  now **complete**. Per-surface (iPhone / iPad)
  status — and the remaining mobile gaps — live in the [feature matrix](./features.md).

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
  credentials) and a fix for an intermittent WiFi-chip crash-loop found during
  bring-up. **Pending:** OTA updates, TLS certificate validation for `https://` server
  addresses, and custom icon assets — see `apps/waffled-bite-firmware/README.md` for
  the full list of open items.
- **Offline scope (Web/Kiosk)** — PowerSync covers the **calendar** domain; other domains
  are REST + live-refresh bus.
- **Kiosk PWA** (7.1) — service worker + cached last-known state, to fully survive backend
  blips.
- **Public ingress** (7.3) — configurable (Caddy auto-TLS / Cloudflare Tunnel), operator's
  choice.

## Planned 🚧

- **List sharing.** Let a household invite specific people to a list, choose whether
  they can view or edit it, and revoke access later.

- **Recurring-edit scope — give chores the calendar's model, and close two calendar gaps.**
  Calendar events already ship the full **this event / this-and-following / all events** picker
  (per-occurrence `event_overrides`, a new master via a series split for "following", `exdate`
  cancel tombstones for deletes). **Repeating chores have no scope choice at all** — editing a
  chore always rewrites the whole template, and it's inconsistent about the past: title / emoji /
  due-time / rrule are read live from the template so they **rewrite past occurrences too**, while
  reward / assignee / approval / photo only touch *future* unfinished instances, and delete removes
  the entire series **including completed history**. Same dialog, three different rules. The work:
  1. **Port the calendar's this / this-and-following / whole-series model to chores** — a
     per-instance override, a "this and following" split, and a scope dialog in `ChoreEditSheet`
     (today `ChoreEditorTarget` only has `.new`/`.edit`, and the PATCH always hits the template).
     Decide whether chore title/time should be snapshotted like reward already is, so past
     occurrences stop silently changing.
  2. **Fix a calendar edit bug:** under "this" / "this-and-following", the iOS sheet still lets you
     change **assignee, goal link, and the countdown flag**, but the server silently drops them
     (they're master-only / absent from `OVERRIDE_FIELDS`) — a save the UI implies but never
     persists. Either store them as per-occurrence overrides or disable those fields for non-"all"
     scope. (Also clean up the stale `CalendarView.swift` comment claiming iOS has no scope dialog —
     it does.)
  3. **Decide** whether "all" should keep retroactively rewriting the recent past (it re-materializes
     the past ~3 months today) or leave already-passed occurrences untouched, the way delete already
     is deliberately guarded against wiping history.

- **Goal tier polish (following the Spotlight redesign).** The Spotlight / Pinned / More
  hierarchy shipped (one Spotlight hero per list, a Pinned band, then A–Z rows). One piece is
  still deferred: **manual drag-to-reorder for the Pinned band** — needs a `sort_order` column +
  a reorder endpoint + drag gestures on web & iOS (today the Pinned band is A–Z like More). (The
  three tiers, the tier picker, one-tap pin/unpin, the Today→Spotlight default, and the iPhone
  Today card's "pin a specific goal" chooser all shipped on web + iOS. Internally the Pinned tier
  is still the `is_featured` column; a clean rename to `is_pinned` is optional cleanup.)

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
  cleanly). **Later:** true unit/quantity reconciliation; vegetable-based "mains" + recipe filter.

- **Assign & show a cook per meal (web + iPad + iPhone).** The `meal_plan_entries.cook_person_id`
  column and the API's `cook` DTO already exist — and the demo seed even populates cooks (Jerry,
  Kramer) — but **no UI actually assigns it**, so the data is running ahead of the product. Build
  the real feature on all three surfaces: a **"who's cooking?" picker** when planning/editing a
  meal (pick a household member, or leave it to the whole family) wired to the existing
  `planMeal(…, cookPersonId:)` / `/api/meals/plan`, and a consistent **cook badge** (👩‍🍳 +
  avatar/name) on the planner grid, the Today "meals" card, and the recipe detail. Today the phone
  only *displays* the cook (`WeekPlannerView`) and web ignores `cook_person_id` entirely; re-planning
  should preserve the existing cook. Keep it un-gated (collaborative/attribution-style, like list
  authorship — no capability needed to volunteer or reassign a cook).

- **Apple Health → goals — remaining follow-ons (iPhone).** Tiers 0–2 shipped (see **Done** —
  the full metric set incl. rings/mindful/mood, the **four distance metrics** (walk + run,
  cycling, swimming, wheelchair — fractional, mi/km per device region), **workout-type metrics**
  (`HKWorkout` by activity; minutes / sessions / workout-day habits), habit thresholds,
  ring/mood **count** goals ("close the ring 15×"), the grouped + searchable "Track from Apple
  Health" picker, and gap catch-up). What's left is deliberately deferred:
  - **Graduated ring goals ("I hit 75% of my Move ring").** Apple's `HKActivitySummary`
    exposes each ring's **value *and* the user's personal goal**, not just closed/not — so the
    ring is really a numerator/denominator we currently collapse to a boolean at 100%. We could
    expose a **numeric "ring %"** metric (`value / goal × 100`) that a habit counts at a
    threshold you set (default 100 = fully closed, e.g. ≥75% for an easier bar, or ≥150% to
    require overachievement). **Where we landed:** don't build the full per-ring % set — most
    of it is redundant (the Exercise ring's value *is* our Exercise-minutes metric; the Move
    ring's value *is* Active energy). The one non-redundant, compelling case is a **"Move ring %"**
    habit that rides your *personalized, auto-adjusting* calorie goal ("hit 80% of my Move goal,
    whatever it is this month") — hard to express otherwise. So this is scoped to *maybe just
    Move ring %*, a fast-follow only if graduated goals are wanted. Wrinkles to handle if we do:
    % can exceed 100 (don't cap the UI), the denominator moves with the user's Watch goal, and
    "all rings %" is ambiguous (three denominators) so it'd be per-ring only.
  - **Background sync** (`enableBackgroundDelivery` / `HKObserverQuery`) to keep the family iPad
    fresh on days the phone-owner never opens the app — a *freshness* nicety, not correctness,
    since the next app-open already reconciles.
  - A **rewards tie-in** ("hit your step goal → earn a marble"), which waits on goals touching
    the currency ledger; and **write-back** into HealthKit (out of scope — the read-only pull is
    ~95% of the value).

  Full plan in [`docs/design/healthkit-goals.md`](../design/healthkit-goals.md).

- **iOS widgets, Siri & Shortcuts (iPhone).** Bring Waffled onto the iPhone's *glanceable +
  quick-add* surfaces — Home/Lock-Screen **widgets**, **App Intents** (Siri/Shortcuts), and iOS 18
  **Controls** — as a **personal** experience (the device is signed in as one person, so the widget
  *is you*; no per-person picker). Planned tiles: an **offline Agenda** ("my day", reads the
  PowerSync events with no network/token), a **Grocery** tile (snapshot display + iOS 17 inline
  check-off via `PATCH /list-items/:id` + a `+` deep-link to add), and a **type-aware Goal nudge**
  (`+` for count/total, checkmark for habit, ring-only for health-sourced goals → `POST
  /goals/:id/log`). Plus **voice quick-add** (a reliable "add to grocery" intent + a freeform
  "capture" intent that parses via `/api/capture` then commits + speaks a client-built summary), which
  also shines on the family iPad at the table. The **key plumbing**: today there's no extension
  target, App Group, or shared Keychain — reads use an app-written **App Group snapshot** (no token),
  writes need a **shared Keychain access group**. Staged **Tier 0** (foundation + Agenda) → **Tier 1**
  (Grocery) → **Tier 2** (Goal nudge) → **Tier 3** (voice + Controls); full plan in
  [`docs/design/ios-widgets-intents.md`](../design/ios-widgets-intents.md). Needs a Siri/Intents
  capability + App Group + Keychain-access-group (App Store review).

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
- **Multi-household identity — iOS switcher** (P3 iOS, *mobile owner*) — **SHIPPED.** Settings →
  Accounts now surfaces the account's memberships + pending invites (from `GET /api/household`):
  a **"Your households"** switcher (shown only when >1) that calls **`POST /api/auth/switch`**,
  and an **"Invitations"** card whose **Accept** calls **`POST /api/auth/invites/:id/accept`**.
  Single-membership accounts see no change. The iOS-specific touch point — re-exchanging the
  PowerSync token after a switch — reuses the kiosk's `enterClaimedSession` + `reauthenticate`
  path, but with **`clearLocal: true`** so the previous household's rows can't linger in the
  shared SQLite mirror (and the switch is blocked while writes are still queued). DTOs decode
  defensively (`decodeIfPresent`) and were validated against the live payloads.
- **Notifications tail** — kiosk "due soon" local banner (table not built yet); remote push
  (APNs / web-push) is blocked on a self-host key/relay decision. Recurring-event reminders
  on iOS (only single events fire today) ride along here.
- **Recurring-chore rollover** — the shipped `rollover` flag defaults on for *one-offs*;
  opt-in carry-forward for **recurring** chores still needs collapse-duplicates-to-one +
  streak handling before it can ship.
- **More optional modules** (on the new framework) — **Family Night SHIPPED (web) 2026-07-01**
  (generic customizable auto-rotating agenda + Today card + optional weekly calendar event);
  next up a **daily quote/snippet** card (the cleanest "built-in card also writable via the
  public API" demo). Plus **iOS native
  module cards** (the toggle is already server-shared; Pantry et al. need Swift screens), and
  API-key follow-ups: per-user (non-admin) issuance, an OpenAPI/published contract, and a CORS
  posture for cross-origin integrations.
- **Conversational recipe AI** — **photo → recipe and describe-it (speech/free-form → recipe)
  SHIPPED (web + iOS)** in the "New recipe" editor: photos of a physical recipe are read by a
  vision model, and a rambly spoken/typed description is organized into ingredients + steps;
  both prefill the editor for review before saving, and source photos auto-delete after a
  short window. iOS reached parity using the native camera / photo library and on-device
  Apple-Speech dictation against the same `/api/recipes/ingest/*` endpoints, with the two
  import buttons gated on the household's provider. Still planned: **instruction-driven edits**
  ("make it vegetarian", "double it").
- **Shared album import** for Photos (Google Photos / iCloud).
- **Server-side fuzzy person resolution** for capture (nicknames/aliases).
- **Milestone reward payouts** — deferred by design (needs idempotency + attribution rules).
- **Goal weekly check-in (Sunday recap)** — the goal-editor mock shows a "🔔 Weekly check-in"
  toggle, but there's no backend for it (it's a decorative, unpersisted toggle in the web
  editor and is intentionally omitted from the iOS goal editor). Needs a persisted per-goal
  flag + the actual Sunday recap surface on the kiosk before the toggle should reappear.
- **Soft "kids' list additions need an OK" toggle** — floated, *not committed*. Attribution
  already covers the real need; a per-role lists matrix is more machinery than a family hub
  wants. Recorded so the rationale isn't lost (see [permission model](./permissions.md)).
- **Optional S3 backup** (Phase 4) — parked.
- **Restore drills** (7.4) — pairs with the parked S3 backup.
- **App store verification** (7.2) — Apple/Google production review.

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
> [`quick-start.md`](./quick-start.md)** and the `Self-hosted (Immich-style)` section of the
> [engineering plan](../engineering-plan.md) are the current source of truth.
