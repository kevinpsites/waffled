# Upkeep — recurring household maintenance

**Status:** planned (design agreed, not built). Decided 2026-08-13.

Where "take the trash out every week", "replace the air filter every 3 months", and
"change the toothbrush heads" live. This is the plan; nothing here ships yet.

## Why this isn't chores

Chores are a kid-facing economy: they carry a reward currency and amount, an approval
flow, optional photo proof, an assignee, and they feed the star/allowance ledger. Household
upkeep has none of that. It's infrastructure — nobody earns a star for changing the furnace
filter, and burying a quarterly task in a daily chore board is noise 89 days out of 90.

More decisively, **chores cannot express these schedules at all today.**
`ensureTodayInstances` (`apps/api/src/modules/chores/chores.service.ts`) materializes
instances only for `FREQ=DAILY`, or `FREQ=WEEKLY` where today's weekday appears in the
rrule's `BYDAY` — matched by SQL substring. There is no `MONTHLY` and no `INTERVAL`. "Every
3 months" is unschedulable in the current model.

## The load-bearing decision: completion-anchored, not calendar-anchored

Two different things sound like "every 3 months":

- **Calendar-anchored** — Jan 1, Apr 1, Jul 1, regardless of what you did. An rrule
  expresses this. Trash night is this shape.
- **Completion-anchored** — due three months after you *actually last did it*. Do it two
  weeks late and the next one shifts two weeks. Filters, toothbrush heads, water filters,
  smoke-detector batteries are all this shape.

**Decision: completion-anchored is the model.** `chore_instances` materializes one row per
`due_on` date on a calendar grid, which structurally cannot represent "N months after the
last completion" — so this is a different scheduler, not a bigger rrule, and it gets its own
entity rather than being bolted onto chores.

A per-item calendar-anchored option can be added later (an `anchor` column, `'completion' |
'calendar'`) without disturbing the model. It is deliberately **not** in v1.

## Schema sketch

Two tables. Note what's absent: no per-day materialization, no reward columns, no approval,
no photo proof.

```sql
create table upkeep_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  title text not null,
  emoji text,
  -- The interval, completion-anchored. Days keeps it one unit; "3 months" is stored
  -- as an interval so month-length arithmetic stays Postgres's problem.
  every interval not null,
  -- How far ahead it starts showing up on Today/Calendar. Default a week: a quarterly
  -- item that appears 90 days early is just clutter.
  lead_time interval not null default '7 days',
  last_completed_at timestamptz,
  -- Derived: last_completed_at + every (or a seeded start for a never-done item).
  -- Stored, not computed, so the due-window query is a plain index scan.
  next_due_at timestamptz not null,
  notes text,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

-- The history — "filter last changed Mar 12" is the whole point, and chores'
-- completed instances don't give it cleanly.
create table upkeep_completions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  upkeep_item_id uuid not null references upkeep_items(id) on delete cascade,
  person_id uuid references persons(id),   -- who did it (nullable: nobody claimed it)
  completed_at timestamptz not null default now(),
  notes text
);
```

Completing = insert a completion row, set `last_completed_at`, recompute
`next_due_at = completed_at + every`. One transaction, no materialization pass, no nightly
job. An item is **due** when `now() >= next_due_at - lead_time`, and **overdue** when
`now() >= next_due_at`.

## Countdown reuse

The agreed shape is that Upkeep reads as "N days until Y" through the existing countdown
presentation. Before building, **read `apps/api/src/modules/countdowns/countdowns.ts`** and
establish whether its aggregator is source-pluggable or hardwired to events — countdowns
already merge three sources (flagged event / standalone item / member birthday), which is
encouraging, but that has not been verified for this plan. That answer decides whether
Upkeep is an *addition* to the aggregator or a *refactor* of it, and it is the single
biggest unknown in the estimate below.

## Module registration

Upkeep is an optional module, off by default. The touch points:

- `ModuleKey` union + the `MODULES` catalog in `apps/api/src/platform/modules.ts`
  (`status: 'available'`, `defaultOn: false`)
- the **hand-mirrored** copy in `apps/web/src/lib/modules.ts`
- `moduleRoutes('upkeep')` for the route guards
- a Today card gated in `moduleAllows()` on iOS and `cardAvailable` on web, exactly as
  pantry/goals do — plus both layout card enums (`TODAY_CARDS`,
  `MOBILE_TODAY_CARDS`), the same checklist the new `lists` card just went through

## Surfaces

- **Today card** — only items inside their lead-time window, overdue first. Tap to
  complete. Empty when nothing is due, which is most days, so it should hide rather than
  render an empty card (same rule as the Lists card).
- **Calendar** — an all-day chip on `next_due_at` (see below).
- **A management screen** — the full list with "last done" dates and the ability to
  complete something early ("I did the filter today" resets the clock).

## How this lands on the calendar (item 3)

With Upkeep built, the calendar's dated set is exactly three sources: `events` (the only one
with real recurrence and Google sync), `chore_instances.due_on`, and `upkeep_items.next_due_at`.
`list_items` has **no due column** and should keep it that way — lists shouldn't become a
half-built task manager.

So the calendar becomes events **plus a read-only overlay** of dated non-events, rendered as
compact all-day chips at the top of a day rather than blocks in the time grid — a chore's
`due_time` is a soft target, not an appointment, and placing it in the grid implies a
precision that isn't there. Tapping a chip deep-links to the chore/upkeep detail rather than
opening the event editor.

Two seams to resolve before building:

1. **Visibility.** `0074_calendar_visibility` filters events as `visibility = 'family' OR
   owner_person_id = <viewer>`. Chores and upkeep have no visibility concept. Simplest
   coherent rule: treat both as `family` — always shown — since a chore is already on a
   shared board.
2. **Offline asymmetry.** On iOS, events arrive via PowerSync while chores are REST-only
   (`SyncSchema.swift` syncs households, persons, events, event_participants,
   event_occurrences — nothing else). A phone with no connection renders events fine and
   silently drops the overlay. Either surface that state in the UI, or add chores to the
   sync schema — which is a larger piece of work that also unblocks the chore reminders
   currently blocked for the same reason. See the PowerSync sizing note below.

Because Upkeep makes this a ≥2-source overlay from day one, the merge should take a list of
sources rather than special-casing chores.

## Rough sizing

| Piece | Estimate |
|---|---|
| Schema + service + routes (TDD, testcontainer integration tests) | 2–3 days |
| Module registration + Today card (web + iPhone) | 1–2 days |
| Management screen (web + iOS) | 2–3 days |
| Countdown integration | 0.5–2 days, depending entirely on the aggregator question above |
| Calendar overlay (item 3), both platforms | 2–3 days |

## Related: PowerSync sizing for chores and lists

Measured against the real household DB (2026-08-13, 15 MB total), since the calendar
overlay's offline story depends on it:

| table | rows | avg row | client cost |
|---|---|---|---|
| `events` (already synced) | 488 | 342 B | ~167 KB |
| `chore_instances` | 734 | 147 B | ~108 KB |
| `list_items` | 271 | 185 B | ~50 KB |

Storage is not the constraint — adding chores and lists costs ~160 KB per client, less than
one recipe photo. Three things that are:

1. **Per-domain plumbing is ~780 hand-written lines**, measured from events:
   `events-local.ts` (377), `Events.swift` (200), `powersync-crud.ts` (201) — plus a
   `data:` line in `sync-config.yaml`, a table in both client schemas, and a migration.
2. **`REPLICA IDENTITY FULL` is mandatory** (see `0027_events_replication.sql`), so every
   UPDATE logs the entire old row to the WAL. `chore_instances` is updated on every
   check-off, so that's where the real server cost sits.
3. **`chore_instances` grows without bound** — those 734 rows accumulated over 66 days from
   24 active chores (~11/day, ~4,000/year). Sync it with a **window**
   (`due_on > now() - 90 days`) from day one; retrofitting the window later forces a re-sync.

Note that Upkeep, by design, has none of problem 3: one row per item, not one per day.

Order if this is pursued: **lists first** (~3–4 days, pure CRUD, highest daily payoff — a
grocery list in a shop with bad signal), then **chores** (~1–1.5 weeks, mostly reconciling
the reward/approval/photo side effects, which are server transactions rather than row
writes). Recipes should stay REST-only; they're read-mostly and a cache fits better.
