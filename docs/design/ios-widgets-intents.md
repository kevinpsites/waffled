# iOS Widgets, Siri / App Intents & Shortcuts — staged plan

**Status:** planned 🚧 · spike doc for the [roadmap](../product/roadmap.md) entry
"iOS widgets, Siri & Shortcuts (iPhone)".

Bring Waffled onto the iPhone's *glanceable + quick-add* surfaces: Home/Lock-Screen
**widgets**, **App Intents** (the modern Siri/Shortcuts API), and iOS 18 **Controls**
(Control Center / Action Button / Lock Screen). The goal is a **personal iPhone**
experience — the widget *is you*, because the device is signed in as one person — plus
voice quick-add that also shines on the family iPad at the table.

This is a **future** doc; nothing here is built yet. It captures the design decisions and
the verified feasibility so a later implementation doesn't re-litigate them.

## The four surfaces (and what each is good for)

| Surface | What it is | Best for | Hard constraint |
| --- | --- | --- | --- |
| **Widgets** (WidgetKit) | Glanceable tiles; lightly interactive since iOS 17 | "My day", grocery, a goal nudge | Reads a *snapshot* on a rationed timeline; **no text input, ever** |
| **App Intents** | Typed actions/queries the system runs | Mark done, add item, log a goal | Runs in an extension → needs data + auth reach |
| **Siri / voice** | App Intents surfaced by voice + App Shortcuts | Hands-free capture & completion | Phrases must be predictable; params need disambiguation |
| **Controls** (iOS 18) | Control Center / Action Button / Lock-Screen buttons | One-tap "quick add" / "capture" | Fires an intent; no UI of its own |

## The one fact that shapes everything: offline vs. REST

Only **calendar events + people** are mirrored offline. Everything else is a network call.

- **PowerSync (offline SQLite mirror)** — schema at
  `apps/ios/Sources/Waffled/Sync/SyncSchema.swift`. Mirrored tables: `households`,
  `persons`, `events`, `event_participants`, `event_occurrences` only. The DB is opened
  with a bare `dbFilename: "waffled.sqlite"` (`Sync/SyncManager.swift:145`) — i.e. in the
  **app sandbox**, where an extension can't reach it.
- **REST-only** (via `Sync/WaffledAPI.swift`, Bearer JWT): **chores/chore_instances,
  goals, lists/grocery, meals, pantry, countdowns, family night.** The code says so
  outright (`DashboardModel.swift`: "Events come from PowerSync; these three domains
  aren't synced tables, so they load over the API.")

**Consequence — two implementation patterns, and every idea picks one:**

- **Read-only widgets → the snapshot pattern.** The *app* writes a small snapshot (JSON or
  a tiny SQLite) into a shared **App Group** on each refresh/sync; the widget just reads
  that snapshot. **No token, no network, no PowerSync engine in the extension.** This is the
  cleanest path and how every glanceable tile should read its data. It also sidesteps the
  1-hour access-token expiry entirely for reads.
- **Mutating / query intents → shared Keychain.** "Mark done", "add milk", "log a book"
  hit REST, so the extension needs the Bearer token via a shared **keychain-access-group**.
  This is unavoidable for *writes*.

The line in the sand: **a tile is free to display but costs credentials the moment it
becomes interactive.** Agenda (offline) is free; grocery check-off (writes REST) is a real
step up.

## What exists today (the plumbing gap)

`apps/ios/project.yml`:

- **Bundle id** `app.waffled`; **deployment target iOS 18.0**; **universal**
  (`TARGETED_DEVICE_FAMILY "1,2"`).
- **Exactly two targets** — `Waffled` and `WaffledTests`. **No extension of any kind.**
- Entitlements declare **only HealthKit**. **No App Group. No Keychain access group. No
  Siri/Intents entitlement.**
- Custom URL scheme **`waffled://`** exists (`app.waffled.oauth`) — reusable for widget →
  app **deep links**.
- **Zero** existing `WidgetKit` / `AppIntents` / `Intents` code anywhere.

Auth (`Sync/AuthTokens.swift`): HS256 access JWT (~1h) + rotating refresh (~60d) in the
**Keychain** (service `app.waffled.auth`, accessibility
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — reachable by a background extension
after first unlock). **No `kSecAttrAccessGroup` is set**, so a *different-bundle* extension
can't read the tokens as-is.

## Foundation (build once, gates everything)

1. **New WidgetKit + AppIntents extension target** in `project.yml`, then `xcodegen
   generate` (same drill as any new capability).
2. **App Group** entitlement on **both** app + extension — the snapshot channel.
3. **Shared Keychain access group** on both — only needed once we do *mutating* intents /
   interactive widgets.
4. The **app writes a `widget-snapshot`** into the App Group on foreground, on PowerSync
   change, and on pull-to-refresh. The snapshot should also carry the **enabled-module set**
   (`WaffledModule`: chores, goals, meals, lists, pantry, familyNight, quotes — see
   `SyncManager.swift:839`) so the widget gallery/config only offers tiles the household has
   turned on.

> **Design note — don't run PowerSync in the widget.** Even for offline events, prefer the
> app-writes-snapshot approach over relocating `waffled.sqlite` into the App Group and
> running a sync engine in the extension. Relocation is possible but heavier; the snapshot
> keeps the extension dumb and reliable.

## The personal iPhone board — tile by tile

The device is signed in as one person, so **no per-person picker is needed** — each tile
binds to the signed-in identity. (Configurable-per-person via `AppIntentConfiguration` was
considered and **deliberately dropped**; it only mattered for a shared/kiosk device, which
this design is explicitly *not* about.)

### 1. Agenda — "my day" · 🟢 offline, effortless

Reads events from the snapshot (which comes from PowerSync) — **no network, no token**,
correct even as midnight rolls over (it's computed from a date). Ship this **first** as the
proving ground for the App Group pipe with zero auth risk. Home widget + Lock-Screen
accessory (`.accessoryRectangular` / `.accessoryCircular`).

### 2. Grocery — glance + check-off + quick-add · 🟢 (needs shared token for writes)

The "both" tile. Three behaviours, resolving three different ways:

- **Display** — snapshot of `GET /api/lists/grocery` (`lists.routes.ts:157`). iOS already
  has `groceryItems()` / `GroceryItemDTO {id, checked}` (`WaffledAPI.swift:643`).
- **Check-off (inline, no app launch)** — an **iOS 17 interactive** `AppIntent` button per
  row → `PATCH /api/list-items/:id {checked:true}` (`lists.routes.ts:179`, a **toggle**,
  records `checked_at`/`checked_by`; minimal payload `{"checked":true}`). iOS
  `patchListItem(id:…:checked:)` (`WaffledAPI.swift:2145`). Optimistic toggle → call
  `reloadTimelines` immediately so the box ticks *now*, then reconcile.
- **Quick-add** — **widgets can't take text input**, so "add" is a `+` that either
  **deep-links** (`waffled://`) into the app's grocery add field (one tap, then type), or is
  handed to **voice / a Control**. Add endpoint: `POST /api/lists/grocery/items {name,
  quantity?, category?}` (`lists.routes.ts:163`), iOS `addGroceryItem(name:quantity:section:)`.

Set expectations clearly: **"quick add" is never inline typing in a widget** — nothing on
iOS can do that. The text-free add paths are voice and Controls; the widget's `+` is a
hand-off.

### 3. Goal nudge — type-aware · 🟢 server-ready (one small client change)

The novel tile. Its whole job is to **read the goal's type and render the right affordance**:

| `goal_type` (`goals.service.ts:10`) | Widget affordance | Action |
| --- | --- | --- |
| `count` / `total` | **`+` increment button** | `POST /api/goals/:id/log {amount:1}` |
| `habit` | **done/not-done checkmark** | same `log` (server auto-clamps to 1 + dedupes same-day, `goals.service.ts:634,645`) |
| `checklist` | checkmark per step | `PATCH /api/goals/:id/steps/:stepId {done}` |
| **health-sourced** (`health_metric != null`, migration `0075`) | **progress ring only — no button** | display only; HealthKit auto-fills it |

The log endpoint (`goals.routes.ts:145`) takes `{amount, personIds?, personId?, note?,
loggedOn?}`; **self-scoped logging needs no extra capability** (attributing to *another*
person needs `goal.manage`). Since the device is the signed-in person, `{"amount":1}` is
the whole payload. iOS already has `logGoalProgress(goalId:amount:personIds:note:loggedOn:)`
(`WaffledAPI.swift:2356`).

> **Gap to close first.** Progress is not stored on a goal — it's `SUM(amount)` over the
> append-only `goal_logs` table, computed per read. The server *sends* the derived
> done-state (`loggedTodayBy`, `periodDone`, `stepDone`/`stepTotal`) on the **goals list**,
> but iOS's list `Goal` struct (`WaffledAPI.swift:2228`) **doesn't decode them** — only
> `GoalDetail` surfaces steps. For a **habit checkmark** to show the right on/off state, the
> list DTO must be extended to carry the done-state. The data is already on the wire; it's a
> small client-side add.

### Not on the board

- **Today summary tile** (chores done/total + stars + tonight's dinner + grocery count) is
  feasible via snapshot and was discussed, but the personal-iPhone direction favours the
  three focused tiles above. Kept as an easy later add — all its data is already in REST
  endpoints the app loads for the Today screen (`DashboardModel`).
- **Chores check-off widget** — possible (`chore-instances` REST), but **photo-proof and
  approval chores can't complete from a widget** (no camera, no review UI). Those must
  **deep-link into the app, not fake-complete** — a forced-correctness detail that ties into
  the shipped one-off/rollover chores work. Deferred to keep the first cut honest.

## Voice & Controls — quick-add, hands-free

Voice shines most on the **family iPad at the table** ("Hey Siri, tell Waffled we're out of
milk" with hands covered in flour), and works identically on the personal iPhone (files as
you). Two intents, by design:

- **Focused "Add \<x\> to the grocery list"** — the reliable 90% case; Siri won't fumble it.
  Straight to `POST /api/lists/grocery/items`.
- **Freeform "Capture \<anything\>"** — the powerhouse, but note **`/api/capture` is
  parse-only**. It returns `{intent, via, fallback}` (`capture.ts:414`) — a parsed intent
  (`event | task | grocery | meal | list | unsupported`), **no created records, no
  server-generated speakable string**. So the voice round-trip is a **3-step compose**:
  1. `POST /api/capture {text}` → parse the intent,
  2. commit via the matching REST call (`addGroceryItem` / `createChore` / meal/list add —
     the iOS "capture commits" already exist),
  3. **synthesize the spoken confirmation client-side** — iOS *already* has
     `CaptureSummary` (`Sync/Capture.swift:70`) that turns an intent into human text
     ("2 lbs milk → grocery list"). Reuse/extend it for Siri read-back.

> **Capture can't create goals.** The parser routes goals to `unsupported`
> (`capture.ts:102,119`). So **"log a goal by voice" is a *dedicated* goal-log App Intent**
> hitting `POST /api/goals/:id/log` — not the capture route. Arguably cleaner anyway.

**iOS 18 Controls** — since the deployment target is 18.0, a one-tap **"Quick add" /
"Capture" Control** (Control Center / Action Button / Lock Screen) is cheap once the intents
exist, and matches the "quick add" theme better than any widget can. Ship **App Shortcuts**
(fixed phrases) so Siri works with zero user setup.

## Staged delivery

### Tier 0 — Foundation + Agenda (prove the pipe) · offline, no token

Extension target + App Group + snapshot writer; ship the **offline Agenda** widget (Home +
Lock-Screen accessory). Validates the whole App Group snapshot channel with **zero auth
risk**. No REST, no Keychain sharing yet.

### Tier 1 — Grocery (first interactive tile)

Add the **shared Keychain access group**. Grocery widget: snapshot display + **inline
check-off** (interactive `AppIntent` → `PATCH /list-items/:id`) + a `+` **deep-link** to the
app's add field. Optimistic UI + immediate `reloadTimelines`.

### Tier 2 — Goal nudge

Extend the goals **list DTO** to carry done-state. Type-aware widget: `+` for count/total,
checkmark for habit, **ring-only** for health-sourced goals. Writes via `POST
/goals/:id/log`.

### Tier 3 — Voice + Controls

Focused **"add to grocery"** intent + freeform **"capture"** intent (parse → commit → speak
via `CaptureSummary`) + a dedicated **"log a goal"** intent. Add the **iOS 18 Control** and
**App Shortcuts** phrases. Wire the same intents on the iPad so the table-side "add to the
list" reflex works.

### Later / optional

- **Today summary** widget (snapshot of the Dashboard domains).
- **Chores** widget (with deep-link, not fake-complete, for photo-proof/approval chores).
- **Cook Mode timer as a Live Activity / Dynamic Island** — cook mode already has per-step
  timers; surfacing the running timer on the Lock Screen is genuinely useful, but the most
  involved piece.
- **StandBy** (phone-as-mini-kiosk on a charger) — reuses the same snapshot; parked because
  this design intentionally targets the *personal* phone, not a shared display.

## Cross-cutting (all tiers)

- **Auth in the extension.** Reads use the snapshot (no token). Mutating intents read the
  Bearer via the shared Keychain group; the ~1h access token will often be **expired** when
  the extension wakes, so an intent must handle refresh (or, cleaner, **hand off the write
  to the app** via a background task rather than re-implementing `/api/auth` refresh in the
  extension).
- **Freshness budget.** iOS rations widget timeline refreshes (~40–70/day). Family data
  changes on human timescales, so snapshot-first + `reloadTimelines`-after-mutation is
  plenty. **Never** call REST on every timeline tick — that's the classic
  stale/spinny/battery complaint.
- **Lock-Screen privacy.** Chore/dinner data is low-stakes, but a countdown ("2 sleeps until
  …") can be sensitive on a lock screen. Respect the existing per-card visibility settings
  when choosing what a Lock-Screen accessory shows.
- **Module gating.** The snapshot carries the enabled-module set so the widget gallery and
  configuration reflect what the household actually has on (a chores-off household offers no
  chores widget).
- **XcodeGen.** The extension target, App Group, Keychain group, and Siri entitlement all go
  in `project.yml`, then `xcodegen generate` — the `.xcodeproj` is generated/gitignored.
- **App Store.** A Siri/Intents capability and any new usage strings ship with the App
  Store review; App Shortcuts need a stable `AppShortcutsProvider`.
