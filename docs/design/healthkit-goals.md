# Apple Health → Goals (iPhone) — staged plan

**Status:** planned 🚧 · spike doc for the [roadmap](../product/roadmap.md) entry
"Apple Health → goals (iPhone)".

Let an iPhone user link a goal to an Apple Health / Apple Watch metric so progress
fills itself instead of being hand-logged: steps, flights climbed, exercise minutes,
activity rings, mindful minutes, and mood. This reuses the existing goals stack almost
wholesale — the work is an iOS HealthKit bridge plus one small server seam.

## The one hard constraint

**HealthKit exists only on iPhone.** There is no HealthKit framework on iPad, and none
on web/kiosk. Apple Watch is *not* a separate integration — Watch steps, rings, and
workouts sync into the iPhone's HealthKit store automatically, so Watch data comes for
free the moment the iPhone reads it. The direction is always **iPhone reads → syncs the
number up → iPad/web display it.** iPad/kiosk/web can show "Jerry: 7,340 / 10,000 steps"
but can never read health data themselves.

A second consequence: HealthKit data belongs to **the one human who owns that iPhone**, so
a health link is inherently **personal**. It attaches to *this person tracking on their own
device* (a `goal_participant`), never to a household-wide shared goal. Restrict health
links to `each_tracks` / personal goals; don't offer them on `shared_total` goals.

## Why the data model is already ~90% ready

No schema change is required to *start* (Tier 0–1 add one nullable column + one dedupe
table). The seams already exist:

| Health data | Existing goal shape | HealthKit type |
| --- | --- | --- |
| Steps | `count`/`total`, `unit='steps'`, `target_value=10000` | `HKQuantityType.stepCount` |
| Flights of stairs | `count`/`total`, `unit='flights'` | `flightsClimbed` |
| Exercise minutes | `total`, `unit='min'` | `appleExerciseTime` |
| Active energy | `total`, `unit='cal'` | `activeEnergyBurned` |
| Close activity rings | `habit` (daily met / not-met) | `HKActivitySummary` |
| Mindful minutes | `total` or `habit` | `mindfulSession` |
| **Record my mood** | `habit` — auto-checks when an entry exists that day | `HKStateOfMind` *(iOS 17+)* |
| Workouts / sleep | `count` / `total` hours | `HKWorkout` / `sleepAnalysis` |

Key facts that make this cheap (verified against the code):

- **`goals`** already carries `goal_type` (count/total/habit/checklist), `unit`,
  `target_value`, `habit_period`, `habit_target_per_period`
  (`apps/api/migrations/0010_goals.sql`).
- **`goal_logs`** is append-only, progress is `SUM(amount)`, and it already has a
  free-text **`source`** column plus `ref_type`/`ref_id`.
- **`logProgress()` already accepts `{ source, refType, refId, at }`**
  (`apps/api/src/modules/goals/goals.service.ts:598`) — auto-logging a HealthKit sample is
  the existing path with `source='auto_healthkit'`, `refId=<sample/day>`, `at=<sample date>`.
- **Habits already dedupe to one log per person per day**
  (`goals.service.ts:623-648`) — so ring / mood / "did I exercise" auto-checks are
  **idempotent for free**; re-syncing the same day silently skips.
- The **only** double-count risk is numeric `total`/`count` goals (steps), and there is a
  proven precedent for exactly that: the calendar→goal path pairs an `auto_from_calendar`
  opt-in column (`migration 0031`) with an `event_goal_logs` idempotency table
  (`migration 0033`). HealthKit mirrors it 1:1.
- Goals are **REST-only on iOS** (not in the PowerSync schema), so a health sync is a REST
  push on foreground/background — not a PowerSync CRUD op. iOS write path already exists:
  `logGoalProgress(goalId:amount:personIds:note:loggedOn:)` →
  `POST /api/goals/:id/log` (`WaffledAPI.swift:2340`).

## Staged delivery

### Tier 0 — Read & suggest (prove the plumbing) · iOS-only, no server change

Goal: validate the permission UX and read accuracy on a real device before committing to
any auto-log machinery.

- **project.yml:** add the `com.apple.developer.healthkit` entitlement and
  `NSHealthShareUsageDescription` to Info.plist; `xcodegen generate`.
- **`HealthKitBridge`** (`apps/ios/.../Features/Goals/HealthKitBridge.swift`, an actor /
  `@Observable`): request *read* authorization for a curated set (stepCount,
  flightsClimbed, appleExerciseTime, activeEnergyBurned, `HKActivitySummary`,
  mindfulSession, and `HKStateOfMind` on iOS 17+). Expose `todaySum(_ type)`,
  `todayActivitySummary()`, `todayMoodCount()`.
- On a compatible goal's detail, show a **suggestion chip**: "Apple Health: 7,340 steps
  today — Log it" → the *existing* `logGoalProgress(amount:)`. Purely a manual tap; no
  stored link, no background, nothing persisted about health.

Deliverable: it feels real on device; the permission sheet and numbers are correct.
Limitation: matching a goal to a metric is a simple heuristic/hardcode here — the real
link lands in Tier 1.

### Tier 1 — Linked auto-log (the sweet spot)

Goal: "connect their step data to their goal to help them" — progress moves on its own,
and every surface (iPhone/iPad/web) sees the aggregated number, never the raw health data.

**Server**
- Migration: add nullable **`health_metric text`** to `goals` (enum-ish:
  `steps | flights | exercise_minutes | active_energy | move_ring | exercise_ring |
  stand_ring | rings_all | mindful_minutes | mood`), mirroring `auto_from_calendar`.
- Migration: **`health_goal_logs`** idempotency table (mirror `event_goal_logs`), unique on
  `(goal_id, person_id, metric, day)` → the `goal_logs.id` it produced. Lets a re-sync
  **replace** the day's number instead of appending.
- Endpoint `POST /api/goals/:id/health-sync` `{ metric, day, value }` — the server picks the
  counting by `goal_type` (**SHIPPED**):
  - **total / count** → upsert the day's raw total via the dedup table (`source='auto_healthkit'`);
    it **accumulates** toward `target_value` ("1,000,000 steps this year").
  - **habit** → a **daily threshold** (`goals.health_daily_target`, migration `0075`): the day's
    total counts as **one completion** (`amount=1`) when it clears the threshold — "2,000 steps a
    day, 5 days a week" — paired with the existing `habit_target_per_period` cadence. Below the
    threshold the day doesn't count, and a previously-counted day that no longer qualifies is undone.
    The habit's `count(distinct date)` progress means a manual + auto completion on the same day is
    still one day.

**iOS**
- Goal editor gains **"Link to Apple Health → \<metric\>"** (only for compatible goal
  types); requests that metric's read permission.
- On app foreground (+ optional `enableBackgroundDelivery` / `HKObserverQuery`), for each
  linked goal, query today's value and POST `health-sync`. Manual quick-log stays allowed;
  health owns only the health portion of the day.
- Goal card shows an **"Auto from Apple Health"** badge.

**v1 metric set:** steps, flights, exercise minutes, activity rings (all stable pre-iOS-17).
**Fast-follow:** mood + mindful minutes.

### Tier 2 — First-class health goals + metric discovery

- **"Set a goal from your Health data" picker (iPhone).** A goal-creation entry point that
  lists *the metrics Waffled supports* with the user's **current live value** beside each
  ("Steps 7,340 today · Flights 12 · Exercise 45 min · Rings 2/3 · Mood logged 2×"), then
  pre-fills goal_type + unit + a suggested target. This answers "let the user see what's
  there." **Privacy note:** HealthKit can't enumerate everything in Health and deliberately
  hides *denied* vs *empty* (a denied read returns empty), so this shows only supported
  metrics after a permission request — never "everything Apple Health has."
- **Full health goal type:** manual entry disabled when linked; rings auto-fill the visual;
  streaks computed from health; mood/mindful habits auto-check; richer badges.
- **Later / optional:** a rewards tie-in ("hit your step goal → earn a marble"). Goals don't
  touch `ledger_entries` today, so this is a deliberate follow-on, not part of Tier 1–2.
- **Out of scope:** writing back *into* HealthKit (e.g. logging a Waffled workout to Health).
  The read-only pull is ~95% of the value; write-back is a clean later phase.

## Cross-cutting (all tiers)

- **App Store / privacy:** needs the HealthKit entitlement, `NSHealthShareUsageDescription`
  (+ an Update string only if we ever write back), **per-metric** consent, a privacy-policy
  line, and no health data in analytics/ads. Sending health-*derived* numbers to the
  self-hosted server is allowed **with disclosure**. Handle "permission denied" gracefully
  (fall back to manual logging).
- **Mood is iOS 17+** (`HKStateOfMind`); on older iOS the "log my mood" goal is just a plain
  manual habit.
- **XcodeGen:** entitlement + Info.plist keys go in `project.yml`, then `xcodegen generate`
  (same drill as any new capability).
