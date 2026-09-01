# Rhythms — the things that should keep happening

**Status:** shipping. Decided 2026-08-13, rescoped and renamed from "Upkeep" 2026-08-18
after checking the original design against real household cases. **Phases 1 and 2 are
built** — migration `0098_rhythms.sql`, the service, `GET /rhythms/attention`, module and
Today-card registration, `POST /rhythms/:id/schedule`, and the `rhythm_id` link pinned
through all three event write paths (see *Implementation sequencing*). **Phase 3 is built
too**: Today card, register, booking, skipping, editing, pausing and retiring on web/kiosk
**and** iPhone/iPad, plus the countdown source and the docs. User-facing docs live at
`website/docs/src/content/docs/features/rhythms.md` and the `CHANGELOG.md` entry is
written. **The 🔁 event marker now ships on iOS too**, so every part of the feature is on
every surface. Per-surface status is the
[feature matrix](../../website/docs/src/content/docs/reference/features.md).

**Phase 4 — the redesign — is in progress.** The register no longer groups by shape. It
groups by urgency (Needs you now / Coming up / Steady, paused named at the bottom), each row
anchored by a countdown over a progress hairline, one verb per row and the rest behind a ⋯
menu. The shapes survive as a first-class choice where you make one, and as the language of
each row, but they are no longer headings. The creation form is an editable sentence with
a consequence card stating what it will do, and its defaults follow the cadence rather than
a fixed number. The Today card is a countdown block: "3 want attention" beside "All 10 →",
each row led by its countdown, and the filled button kept for what is late or out of time.
**All three now ship on web/kiosk, iPhone and iPad, from the same helpers.**

**"Push it out a week" now has its control on every surface** — the row's ⋯ menu
everywhere, plus a swipe on iPhone and iPad — sending today-or-the-due-date-whichever-is-
later plus seven days to `PATCH /api/rhythms/:id`, which takes `nextDueAt` for a completion
rhythm only and refuses it on a scheduling one, whose periods *are* its anchor.

It is deliberately **not on every row**: only a *completion* rhythm that is active, has a
`nextDueAt`, and is banded **Needs-you-now** offers it. A scheduling rhythm has no
`nextDueAt` to move and Skip is its equivalent; a row that isn't asking has nothing to push
away from, and a control that does nothing you can feel teaches people the menu is noise.

**Needs-you-now, and nothing wider.** That band is the server's own `/attention` list plus
a locally-detected overdue date — i.e. exactly "this rhythm is asking". Coming-up used to
count too, and that was the bug: Coming-up is a flat `COMING_UP_DAYS = 14` on both clients,
a fortnight-wide *peek at the horizon* on a page you deliberately opened, deliberately not
a statement about nudging (its own test says so). Gating a verb on it meant any completion
rhythm with a cadence of **a fortnight or shorter was never Steady**, so it offered Push
permanently — including the moment after it was completed, a full cycle from being due,
with nothing to push away from. The band is right for what it does; it was the wrong gate
for this verb, and the verb is what moved.

The list carries `bookedAt` / `bookedAllDay`, and **both clients now read it**: a period
settled with no time is a **skip**, and says so ("Skipped", "skipped this one") rather than
claiming a calendar entry that the act of skipping exists to avoid inventing.
`GET /api/rhythms/:id/completions` — which has existed and been tested since the migration —
takes a `limit` and reports `total` plus `averageIntervalDays`, the latter computed over
every completion rather than over the returned page.

Still to come, and it is now client work only:

- the **iPad list+detail split** — the history panel ("May 24 · 13 weeks later") and the
  real average beside the nominal cadence. iOS has no `completions` call yet; the web
  client has one and no UI using it.
- **nothing renders the booking's time**, so a settled row says "Booked" without saying
  when — `bookedAt` is used only to tell a booking from a skip.
- the **auto-schedule day pickers are web-only**: the weekday chips, the "last of that
  weekday" monthly option and the raw-RRULE escape hatch have no iOS equivalent, so the
  weekday there comes from the start date. The rhythm behaves the same either way; it is
  the editor that is short.

Where "trash out weekly", "air filter every 3 months", "change the car's oil", "book a
temple visit", "take a self-care day once a quarter", and "family outing on the third
weekend of the month" live.

## What a rhythm is

A rhythm is a **standing intention with a cadence** — something that should keep happening,
and a place to go to confirm that it actually will. It is not a task list and not a habit
tracker. The unit of value is *"is this handled for this period?"*, asked of a whole
household at once.

The rename from "Upkeep" was not cosmetic. The original design covered exactly two of the
eight real cases above (air filter, oil change) — the maintenance minority — and "upkeep"
is the wrong word for booking a temple visit or a self-care day.

## Why this isn't chores

Chores are a kid-facing economy: reward currency and amount, an approval flow, optional
photo proof, an assignee, and they feed the star/allowance ledger. A rhythm has none of
that. Nobody earns a star for changing the furnace filter, and burying a quarterly item in
a daily chore board is noise 89 days out of 90.

More decisively, **chores cannot express these schedules at all today.**
`ensureTodayInstances` (`apps/api/src/modules/chores/chores.service.ts`) materializes
instances only for `FREQ=DAILY`, or `FREQ=WEEKLY` where today's weekday appears in the
rrule's `BYDAY` — matched by SQL substring. There is no `MONTHLY` and no `INTERVAL`. "Every
3 months" is unschedulable in the current model.

## Why this isn't goals or habits

This is the sharper of the two boundaries, and it's the one that decides the whole model.

**Goals and habits are about follow-through.** You set them because you want to actually do
the thing, and the value is in the record of whether you did — `goal_logs`, streaks, a
target you're measured against.

**Rhythms are about the opportunity existing.** The point of a temple visit rhythm is that
a time gets set aside and shows up on the calendar, so the chance to go is there. Whether
you went is deliberately *not* tracked. Marking it off would turn it into a goal, and then
missing one reads as failure rather than as a week that got away.

This is expressible in the existing schema, which is why it's worth being explicit about
not doing it: `goals` already carries `habit_period`, `habit_target_per_period`,
`tracking_mode = 'each_tracks'`, and `category = 'spiritual'`, and `0033_event_goal` gives
events a `goal_id` with an idempotent confirm-after recap (`event_goal_logs`, unique on
`(event_id, occurrence_date, goal_id)`). "Temple visit, 1×/month, each of us tracks
separately" is buildable today as a habit goal. **We are choosing not to**, because the
recap asks "did you go?" and that is precisely the question a rhythm doesn't ask.

If someone *does* want the follow-through record for a given item, the right answer is to
make it a goal as well — the two can coexist on one event, since `events` can carry both a
`goal_id` and a `rhythm_id`.

## The load-bearing decision: what satisfies a period

The original plan's single decision was *completion-anchored, not calendar-anchored*, with
calendar anchoring deliberately deferred out of v1. Of the eight real cases, **two are
completion-anchored** (air filter, car oil) and **six are calendar-anchored or
booking-shaped** (trash, family outing, two temple visits, self-care day, family chore
day). So that deferral is the one thing this rewrite reverses. Both anchors ship together,
discriminated by a single column: what closes out a period.

On that last one: "family chore day" is **scheduling a day to do chores together**, not a
chore. The chores module owns individual assignable tasks with rewards and approval; the
rhythm owns the recurring decision to set aside an afternoon for them. Settled 2026-08-18.

- **`satisfied_by = 'completion'`** — you did the thing. *Completion-anchored*: the next due
  date is measured from when you **actually** did it, so doing it two weeks late shifts
  everything two weeks. Air filter, car oil, toothbrush heads, smoke-detector batteries.
  These are the items where a calendar grid is actively wrong.

- **`satisfied_by = 'scheduling'`** — a calendar event exists for the period. We never ask
  whether it happened. Trash night, the third-weekend family outing, the temple visit, the
  quarterly self-care day.

Within `'scheduling'`, one more bit decides whether a human is needed:

- **`auto_schedule = true`** — the rrule fully determines the datetime, so we create the
  recurring event once and the rhythm stays satisfied. Trash every Tuesday; family outing on
  `FREQ=MONTHLY;BYDAY=3SA`. (Both already expressible — the web recurrence UI builds
  `FREQ=MONTHLY;BYDAY=3SA` today, with tests in `apps/web/src/kiosk/components/recurrence.test.ts`.)

  **`createRhythm` books that series itself**, at 6pm resolved against the household
  timezone in Postgres, on the first slot the rule allows at or after `starts_on`
  (`firstSlotOnOrAfter`). The anchor and the rule are separate answers to separate
  questions and nothing makes them agree, so a Wednesday anchor under `BYDAY=MO` would
  otherwise start the master on a day its own rule excludes — which reads as the day
  picker having been ignored. This was missed first time round, and the gap was not
  subtle: the toggle inserted a row and booked nothing, so a brand-new rhythm's opening
  move was to appear in the register offering *"Put it back on the calendar"* — for
  something never on it. It routes through `scheduleRhythm` rather than calling
  `createEvent` again, because the events write path can blank `rhythm_id` and a second
  booking path is how the two drift apart. A failed booking warns instead of 500ing: the
  rhythm is valid, and "not on the calendar yet" is a state the register already explains.

  **`scheduleRhythm` reuses the rhythm's `rrule` only when no live recurring event is
  left.** Passing it unconditionally meant booking a period on a rhythm whose series was
  perfectly healthy — one occurrence cancelled — created a SECOND series beside the first
  and doubled every future occurrence, permanently, while every satisfaction assertion
  stayed green (satisfaction only asks whether SOME occurrence lands in the period, so it
  is structurally blind to duplicates). The list and the attention feed now carry
  `hasSeries`, because an empty period alone cannot tell "the series is gone" from "the
  series is alive and this one is missing" — different sentences, different buttons.
- **`auto_schedule = false`** — the cadence is known but *when* is an open decision every
  period. The period surfaces as **needs scheduling** until someone picks a slot. Temple
  visit, self-care day.

That third state — **needs scheduling** — is what the original design had no way to express.
Its state machine was two-state (due → done); the real one is three-state:
**needs scheduling → scheduled → the period rolls over.**

## Why rhythms must generate real events (not calendar chips)

The original plan surfaced items as a *read-only* all-day chip overlaid on the calendar,
with the entity itself REST-only. That design cannot ever have reminders, on any platform.

iOS reminders come from `apps/ios/Sources/Waffled/Sync/NotificationManager.swift`, which
schedules local notifications **exclusively off the synced `events` PowerSync mirror**
(identifiers `waffled.evt.<id>`, a 64-pending cap, reconciled on every events change). There
is no APNs key, no server-side reminder scheduler, and **no web/kiosk reminder path at all
today**. A REST-only entity drawn as a chip would sit behind exactly the wall that chore
reminders are already stuck behind.

An event row inherits that entire path for free. So: a scheduling-shape rhythm **is** an
`events` row carrying a `rhythm_id` back-reference — which also means it gets real
recurrence, Google sync, visibility, participants, and the existing editor at no cost.

This is the same seam the goal bridge already uses (`events.goal_id` + `0033_event_goal`),
so it's a proven shape in this codebase rather than a new one.

## Schema sketch

```sql
-- Up Migration
create table rhythms (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  title text not null,
  emoji text,
  notes text,

  -- WHO it's for. Null = the whole household. The original design had no assignee at
  -- all, and half the real cases need one: "my self-care day" is not "our self-care day",
  -- and a temple visit gets scheduled per person.
  person_id uuid references persons(id) on delete set null,

  -- What closes out a period. See "the load-bearing decision" above.
  satisfied_by text not null check (satisfied_by in ('completion','scheduling')),

  -- Cadence, for BOTH shapes. Stored as an interval so month-length arithmetic stays
  -- Postgres's problem. For 'completion' it is measured from last_completed_at; for
  -- 'scheduling' it is the width of a period.
  every interval not null,

  -- scheduling only: the anchor that makes "which period are we in?" answerable.
  -- Period N is [starts_on + N*every, starts_on + (N+1)*every). An rrule alone cannot
  -- define this — RFC5545 generates occurrences only relative to a DTSTART — and both
  -- `/rhythms/attention` and rhythm_skips.period_start need a well-defined boundary.
  -- The grid is DERIVED from this anchor on read (generate_series stepping by `every`,
  -- which tiles true calendar periods) rather than cached in a column. A cached "current
  -- period" would need advancing by something, and nothing here runs on a timer.
  starts_on date,

  -- scheduling only: can we pick the datetime ourselves, or does a human have to?
  auto_schedule boolean not null default false,
  -- Required only when auto_schedule = true: the RFC5545 rule handed straight to the
  -- event we create ('FREQ=MONTHLY;BYDAY=3SA'). Deliberately NOT the source of period
  -- boundaries — `every` + `starts_on` own that, so period math never needs rrule
  -- expansion in SQL. A booking-shape rhythm ("once a quarter, time TBD") needs no rrule
  -- at all.
  rrule text,

  -- The runway: how much warning you want. One semantic, two readings — for 'completion'
  -- it's "show it before it's due"; for 'scheduling' it's "start reminding me to book it".
  -- Both are "surface it this long before the deadline", so the column stays single.
  --   completion → surfaces when now() >= next_due_at - lead_time
  --   scheduling → surfaces when now() >= period_end - lead_time, i.e. lead_time is your
  --                booking runway. NOT measured from period_start: a quarterly item that
  --                nagged from day one would nag for 90 days, which trains you to ignore
  --                it. Default 14d gives a fortnight to find a slot.
  lead_time interval not null default '14 days',

  -- completion only. Denormalised so the "what's due" query is a plain index scan.
  last_completed_at timestamptz,
  next_due_at       timestamptz,

  is_active  boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rhythms_shape_is_coherent check (
    (satisfied_by = 'completion'
       and next_due_at is not null
       and starts_on is null
       and rrule is null and auto_schedule = false)
    or
    (satisfied_by = 'scheduling'
       and starts_on is not null
       and next_due_at is null and last_completed_at is null
       and (auto_schedule = false or rrule is not null))
  )
);

-- The back-reference. Mirrors events.goal_id (0033); an event can carry both, so a rhythm
-- and a goal may share one calendar entry without either owning it.
alter table events add column rhythm_id uuid references rhythms(id) on delete set null;
create index ix_events_rhythm on events (rhythm_id) where rhythm_id is not null;

-- The history, for completion-shape rhythms only. "Filter last changed Mar 12" is the
-- whole point, and chores' completed instances don't give it cleanly.
create table rhythm_completions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  rhythm_id    uuid not null references rhythms(id) on delete cascade,
  person_id    uuid references persons(id),  -- who did it (nullable: nobody claimed it)
  completed_at timestamptz not null default now(),
  notes        text
);

-- "Skip this quarter" for scheduling-shape rhythms — the only per-period state we store.
-- Without it, a deliberately-skipped period nags forever.
create table rhythm_skips (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  rhythm_id    uuid not null references rhythms(id) on delete cascade,
  period_start date not null,
  skipped_by   uuid references persons(id),
  created_at   timestamptz not null default now(),
  unique (rhythm_id, period_start)
);
```

**Note what is deliberately absent: a per-period satisfaction table.** The goal bridge
materializes `event_goal_logs` because double-counting a log is a real hazard there. Here the
question is "does an event with this `rhythm_id` fall inside the period?" — idempotent by nature — so satisfaction is **derived from
`events`**, not dual-written. That avoids the drift that a materialized copy would invite
when an event is edited, moved, or deleted, and it means an event that gets rescheduled
*within* its period needs no reconciliation at all.

Both the boundary and the satisfaction are derived, and neither needs an rrule expanded in
SQL: `every` + `starts_on` own the grid via `generate_series`, and `events` owns the answer.

Completing a `'completion'` rhythm is one transaction: insert a completion row, set
`last_completed_at`, recompute `next_due_at = completed_at + every`. No materialization
pass, no nightly job. It is **due** when `now() >= next_due_at - lead_time` and **overdue**
when `now() >= next_due_at`.

## The one endpoint everything reads

Both surfaces below, plus the weekly planner, ask the same question — *what needs attention
in this window?* — so it should be one route rather than three near-identical queries:

```
GET /rhythms/attention?from=<date>&to=<date>[&personId=<id>]
```

returning a merged, sorted list of:

- `{ kind: 'due',    rhythm, dueAt, overdue }`            — completion-shape, inside lead time
- `{ kind: 'unscheduled', rhythm, periodStart, periodEnd }` — scheduling-shape, no event with
  this `rhythm_id` in the period, not skipped, and `now() >= periodEnd - lead_time`

**v1 is REST-only.** The `rhythms` table itself is not added to PowerSync (settled
2026-08-18). Scheduling-shape rhythms are unaffected offline — they *are* events, which
already sync — so the only offline gap is a completion-shape Today card going blank, which
is the same gap chores already have. Revisit alongside the chores-on-PowerSync work rather
than paying the ~780 lines of per-domain plumbing (see the sizing note) for one card.

Today passes a one-day window, the weekly planner passes a week.

An `auto_schedule = true` rhythm is normally absent — its recurring event already exists,
which *is* the satisfied state. But it must be checked, not assumed: if someone deletes the
generated event (or its recurrence runs out), the rhythm is silently unsatisfied. Since
satisfaction is derived, the same period query catches this for free and the rhythm
resurfaces as `kind: 'unscheduled'` — with the offer to regenerate the event rather than
pick a time by hand. Do not shortcut this by trusting a "generated" flag on the row; the
whole reason the register exists is to notice when the calendar and the intention disagree.

### The built contract (what phase-3 surfaces code against)

Written down verbatim because four workers building against it in parallel is exactly
where a guessed field name turns into a merge conflict. All routes are gated by the
`rhythms` module and 403 while it is off; a reference to another household's rhythm
answers 404, matching every other household-scoped reference here.

```
GET  /api/rhythms                     → { rhythms: RhythmWithPeriod[] }
GET  /api/rhythms/attention?to[&from] → { items: AttentionItem[] }   `to` required, YYYY-MM-DD; `from` optional
POST /api/rhythms                     → 201 { rhythm }
PATCH  /api/rhythms/:id               → { rhythm }     title/emoji/notes/personId/every/leadTime/isActive
DELETE /api/rhythms/:id               → 204            soft, so completion history survives
POST /api/rhythms/:id/schedule        → 201 { event }    books a period; body { startsAt, endsAt?, allDay?, title? }
POST /api/rhythms/:id/complete        → { rhythm }       body { completedAt?, notes? }
GET  /api/rhythms/:id/completions     → { completions: [{ id, personId, completedAt, notes }] }
POST /api/rhythms/:id/skip            → { ok: true }     body { periodStart }  (YYYY-MM-DD)

Rhythm        { id, title, emoji, notes, personId, satisfiedBy: 'completion'|'scheduling',
                every, startsOn, autoSchedule, rrule, leadTime, lastCompletedAt,
                nextDueAt, isActive }
RhythmWithPeriod
              = Rhythm & { currentPeriodStart, currentPeriodEnd, satisfied }
                (period bounds are null for the completion shape — it has no grid)
AttentionItem { kind: 'due',         rhythm, dueAt, overdue }
              | { kind: 'unscheduled', rhythm, periodStart, periodEnd }
```

Three behaviours worth knowing before designing against them. `leadTime` comes back clamped
to at most half of `every` — ask for 14 days on a weekly rhythm and you get `3 days
12:00:00`, because a runway longer than the cycle never closes and the item would never
leave the list; `PATCH` re-clamps against the *new* cadence for the same reason. `/schedule`
fills title and assignee from the rhythm, so a booking UI needs a time picker and nothing
else; the friction this shape exists to remove is retyping. And `PATCH` deliberately can't
change `satisfiedBy`, `startsOn`, `autoSchedule` or `rrule` — nor `every` **on a scheduling
rhythm**, whose periods are `generate_series(starts_on, …, every)`, so a new cadence
re-reads every boundary just as a new anchor would. Re-anchoring a live rhythm silently
re-interprets its existing skips (keyed on `period_start`) and points its bookings at
periods that no longer exist. Retire it and make a new one.

`every` stays editable on a *completion* rhythm — it has no grid and nothing keyed on one,
so changing it just moves the next due date. The split is by shape, exactly like
`nextDueAt`. Restating the same cadence is not a change and is not refused, since both
clients send the whole form back on save; and both render the cadence as a fixed token when
editing a scheduling rhythm, the way they already render the shape.

`/complete` is **idempotent per day**, judged on the household's clock. A repeat on the
same date updates the existing completion instead of appending another. This was not a
theory: the demo database ended up holding four rows for one air-filter change, three of
them inside 1.5 seconds, because the row's detail line ("Last done X · Next due Y")
recomputes to the *byte-identical* string when you complete the same rhythm twice in a day
— so the button looked dead and got pressed again. Both clients now settle to
"Done today ✓", and the server no longer takes the extra presses at face value.
`completedAt` backdates a completion, which the clients use for "Log it for another day";
the clock re-anchors to that instant, so a future date is refused client-side.

## Feeding the weekly plan module

The stated reason this module exists at all is: *"I want it to come up in a future weekly
plan module, so this should be scheduled out and I have the opportunity to do it."*

**Assumption flagged:** that module does not exist yet — no roadmap entry, no branch as of
2026-08-18. So this plan does not design it; it only guarantees the data it will need. The
contract is the `kind: 'unscheduled'` rows above, over a week-long window: the planner shows
"3 rhythms need a time this week", and picking a slot creates an ordinary event carrying
`rhythm_id`. If the weekly planner lands first, this endpoint is the thing to build against.

## Countdown reuse — question resolved

The original plan called this "the single biggest unknown in the estimate". It isn't one.

`apps/api/src/modules/countdowns/countdowns.ts` is a **hardcoded three-source union** —
`CountdownSource = 'standalone' | 'event' | 'birthday'` — where `listCountdowns` runs a query
per source and appends into one `out` array before sorting. Adding rhythms is a fourth union
member plus one query. It is an **addition, not a refactor**; budget the low end.

Note that scheduling-shape rhythms need nothing here at all — they're events, so an
`is_countdown` flag already works on them. Only completion-shape rhythms ("N days until the
filter is due") need the new source.

## Module registration

Rhythms is an optional module, off by default. The touch points:

- `ModuleKey` union + the `MODULES` catalog in `apps/api/src/platform/modules.ts`
  (`status: 'available'`, `defaultOn: false`)
- the **hand-mirrored** copy in `apps/web/src/lib/modules.ts`
- `moduleRoutes('rhythms')` for the route guards
- a Today card gated in `moduleAllows()` on iOS and `cardAvailable` on web, exactly as
  pantry/goals do — plus both layout card enums (`TODAY_CARDS`, `MOBILE_TODAY_CARDS`), the
  same checklist the `lists` card went through

One module, not two, despite spanning maintenance and booking. Splitting would double that
registration path — five hand-edited sites plus two mirrored catalogs — for what is a single
habit of mind: the place you look to confirm the recurring things are handled.

## Surfaces

- **Today card** — items inside their lead-time window, overdue first, and periods that
  need scheduling. Tap to complete (maintenance) or to pick a time (booking). Empty most
  days, so it hides rather than rendering an empty card — same rule as the Lists card.
- **A management screen** — the full list with "last done" dates, next due, whether this
  period is handled, and the ability to complete early ("I did the filter today" resets the
  clock) or skip a period.
- **Calendar** — mostly free. See below.

## How this lands on the calendar

**This is materially smaller than the original plan assumed.** Because scheduling-shape
rhythms *are* events, they render natively — real recurrence, Google sync, visibility,
participants, the existing editor, and local notifications — with no *placement* code at
all. **Built:** they carry a small `🔁` marker beside the title in every calendar view and
on Today's agenda, plus a pill in the event detail — on web, kiosk, iPhone and iPad. That
much overlay is deliberate: without it a booked rhythm is indistinguishable from any other
event, and the whole point of the register is being able to see that the calendar and the
intention agree.

On iOS the marker needed the link replicated first: `events.rhythm_id` had to join the
PowerSync client schema and both branches of the agenda UNION — an occurrence inherits the
link from its master, and an auto-scheduled rhythm renders *only* as occurrences.

That leaves the read-only overlay covering only two sources: `chore_instances.due_on` and
completion-shape `rhythms.next_due_at`. **The rhythms half is already done** — a
completion-shape rhythm's due date flows in as a `source: 'rhythm'` countdown, so it renders
as a month-grid badge and a week/day chip for free. Only `chore_instances.due_on` is left of
this item; don't build the rhythm side twice. Rendered as compact all-day chips at the top of a
day rather than blocks in the time grid — a chore's `due_time` is a soft target, not an
appointment, and placing it in the grid implies a precision that isn't there. Tapping a chip
deep-links to the chore/rhythm detail rather than opening the event editor. `list_items` has
**no due column** and should keep it that way; lists shouldn't become a half-built task
manager.

Two seams to resolve before building:

1. **Visibility.** `0074_calendar_visibility` filters events as `visibility = 'family' OR
   owner_person_id = <viewer>`. Chores and completion-shape rhythms have no visibility
   concept. Simplest coherent rule: treat both as `family`. Note that a *scheduling*-shape
   rhythm needs no rule — it's an event, so it already has one, and `rhythms.person_id`
   should seed the event's `owner_person_id` so "my self-care day" can be private.
2. **Offline asymmetry.** On iOS, events arrive via PowerSync while chores are REST-only
   (`SyncSchema.swift` syncs households, persons, events, event_participants,
   event_occurrences — nothing else). A phone with no connection renders events fine and
   silently drops the chip overlay. Either surface that state in the UI, or add chores to
   the sync schema — a larger piece of work that also unblocks the chore reminders currently
   blocked for the same reason. See the PowerSync sizing note below. Again, scheduling-shape
   rhythms are unaffected; they sync already.

## The one thing that still has no reminder path

A scheduling-shape rhythm gets reminders for free **once it's on the calendar**. The nag
that matters more — *"the temple visit still isn't booked and the quarter ends Sunday"* — is
not an event, so it cannot use the local-notification path.

For v1 that lives on the Today card and in the weekly planner, with **no push**. Making it
push would need the server-side notification work (APNs key + a scheduler, and web push
separately) that is already the blocker for chore reminders — it should be costed there, as
one piece of platform work benefiting several modules, rather than smuggled into this one.
Do not let the plan imply otherwise.

## Rough sizing

Supersedes the original 8–13 day table, which was scoped to the maintenance-only design.

| Piece | Estimate | Status |
|---|---|---|
| Schema + service + `/rhythms/attention` (TDD, testcontainer integration tests) | 3–4 days | done |
| Event generation + `events.rhythm_id` round-trip (incl. PowerSync touch points) | 2–3 days | done |
| Module registration + Today card (web + iPhone) | 1–2 days | done |
| Management screen (web + iOS) | 2–3 days | done |
| Countdown integration (a union member + a query) | 0.5 day | done |
| Calendar chip overlay, both platforms | 1.5–2 days | web done, iOS open |

Roughly **10–15 days**. It buys more than the original scope: the booking flow and assignees
are new, while the calendar overlay and countdown pieces both shrank.

Sequencing note: the event round-trip is the risky piece, not the schema. `events` has
**three write paths** (REST, PowerSync CRUD, Google sync) and a rhythm-created event must
behave correctly through all of them — an event losing its `rhythm_id` on a sync round-trip
would silently un-satisfy a period. Build that second, with integration tests, before any UI.

## Implementation sequencing

Everything lands on **one branch, one PR, one commit per piece**, per the repo's batch rule.

**Phase 1 — the contract (serial).** Migration `0098_rhythms.sql` (three tables +
`events.rhythm_id` + partial index; `-- Up Migration` first), failing integration test
first against the `goals.integration.test.ts` harness — testcontainer Postgres,
`runMigrations`, real routes. Then the service (create / update / complete / skip /
advance-period) and `GET /rhythms/attention`.

**Module registration belongs in phase 1, not the fan-out.** `ModuleKey` + `MODULES`, the
hand-mirrored `apps/web/src/lib/modules.ts`, `moduleRoutes('rhythms')`, and *both* card
enums (`TODAY_CARDS`, `MOBILE_TODAY_CARDS`) are touched by web-card and iOS-card work
alike. Two parallel workers each adding `rhythms` to those files conflict on the same
lines, guaranteed. Land it once, up front.

**Phase 2 — the event round-trip (serial, and the risky part).** `events.rhythm_id`
surviving all three write paths (REST, PowerSync CRUD, Google sync), plus `auto_schedule`
event generation and the booking flow. Integration tests per write path, because an event
silently losing its `rhythm_id` un-satisfies a period with no error anywhere.

**Phase 3 — parallelizable, only once phases 1–2 are pushed.** Disjoint file sets:

| Worker | Scope |
|---|---|
| 1 | Web Today card + web management screen |
| 2 | Countdowns 4th source + web calendar chip overlay |
| 3 | Docs — `features.md`, roadmap Planned→Done, a how-to page, `CHANGELOG.md` |
| 4 | iOS Today card + management screen — **both** `TodayView` *and* `KioskDashboard` |

Three constraints that break naive fan-out:

1. **A fresh worktree branches off `origin/main`**, which has no `rhythms` schema. Phase-3
   workers must re-base onto the pushed implementation branch as their *first* action, or
   their work neither compiles nor merges.
2. **iOS builds and Playwright must never overlap** — the Simulator dies under load. Web
   verification and iOS verification go in different waves regardless of isolation.
3. **A symlinked `node_modules` uses the main checkout's installed versions**, which drift
   from the branch lockfile (this hid a React 18-vs-19 bug on PR #147). Install against the
   branch lockfile rather than symlinking.

Exactly one worker owns each shared file — `CHANGELOG.md` is worker 3's alone — since
separate trees remove *edit* collisions but not *merge* conflicts.

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

Rhythms, by design, has none of problem 3: one row per item, not one per day. And it dodges
problem 1 for its scheduling shape entirely, since those ride the `events` plumbing that
already exists.

Order if this is pursued: **lists first** (~3–4 days, pure CRUD, highest daily payoff — a
grocery list in a shop with bad signal), then **chores** (~1–1.5 weeks, mostly reconciling
the reward/approval/photo side effects, which are server transactions rather than row
writes). Recipes should stay REST-only; they're read-mostly and a cache fits better.
