# Trackers: tap-to-log items ("Tylenol — last time 11/23 2:15 PM")

Date: 2026-11-23 · Status: draft for approval · Size: small feature

## Intent

Some things a family needs to log, not schedule: a Tylenol dose, a feeding, an inhaler
puff. You tap the item when it happens, as often as needed. Every tap is kept, and the item
always answers "when was the last time?". This is a log, not a chore. There are no stars,
streaks, approvals or daily resets.

## Goals

- A tracker has a name and an optional emoji. Tapping it records an entry with the current
  time, as many times as needed, and the full history is kept.
- The tracker shows `Last time: MM/DD h:mm` (household timezone) below its name.
- An optional per-tracker **"Ask who"** setting, off by default. When it's on, a tap opens
  a household-member picker, and the entry is linked to the chosen person. Then
  "Last time" also shows the name, and the history can be read per person.
- Quick taps from a **Trackers card on Today** (kiosk-friendly tiles). Managing trackers
  and their full history happens on a **Trackers tab on the Tasks page**.

## Non-goals (v1)

- Dose or "too soon" warnings and minimum gaps. These can be added later as a per-tracker
  field without changing the model.
- Reminders, notifications, charts, the capture bar ("gave Tylenol") and Waffled-Bite.

## Anti-goals

- Touching the chores, rhythms or goals models or their screens.
- Losing an entry silently: undo and delete are explicit, and edits keep the entry.

## Approaches (user picked A)

- **A. A new, small Trackers feature (chosen).** Two tables, its own routes and module
  toggle. The model matches the behaviour, and nothing else is affected.
- B. Relax Rhythms to allow "no schedule". Rhythms enforce an interval, a due date and a
  countdown at the database level, every rhythm screen would need a special case, and the
  module is off by default.
- C. A repeatable flag on chores. This fights daily instances, stars, approval and proof.

## Design

**Data** (migration `0108_trackers.sql`):
- `trackers`
  - Columns: id, household_id, title, emoji, `ask_person` bool (default false),
    sort_order, archived_at, created_at, updated_at.
- `tracker_entries`
  - Columns: id, household_id, tracker_id (cascade), `occurred_at` timestamptz (default
    now()), `person_id` (nullable; "for whom"), `logged_by` (person who tapped), note,
    created_at.
  - Uses the composite (household_id, person_id) FK pattern from 0104.
  - Index on (tracker_id, occurred_at desc).

**API**, under the new module key `trackers` (default **on**, toggle in Settings → Modules):
- `GET /api/trackers`: list with each tracker's latest entry (time plus person).
- `POST/PATCH/DELETE /api/trackers/:id`: create, rename, change emoji, toggle ask_person,
  reorder, archive.
- `POST /api/trackers/:id/entries`: log an entry, taking an optional `person_id` and
  `occurred_at`.
  - Returns 422 when `ask_person` is on and no `person_id` is given.
  - The person must belong to the household.
- `GET /api/trackers/:id/entries?person_id=&before=`: paged history, newest first.
- `PATCH/DELETE /api/tracker-entries/:id`: fix the time, person or note, or remove the
  entry.

**Permissions** (my call):
- Any signed-in member, kids included, can log, edit and delete entries. This matches
  the photo-wall openness.
- Creating, editing and archiving trackers requires an adult or an admin.

**Web**:
- **Today: "Trackers" card**, a grid of large tiles showing emoji, name and
  "Last time: 11/23 2:15 PM" (plus "· Emma" when a person is attached).
  - A tap logs the entry immediately, or opens the person picker first when "Ask who" is
    on.
  - After logging, a short **Undo** toast appears.
  - The card is module-gated and can be hidden in Customize, the same way as the
    Rhythms card.
- **Tasks page: "Trackers" tab** beside Chores and Rewards.
  - The tracker list has add, edit and archive.
  - Selecting a tracker shows its history, with a per-person filter when ask_person is
    on, and inline edit and delete for each entry.
  - The Tasks page is reachable when chores **or** trackers is on.
- Cross-device refresh uses a new `trackers` bus topic, with the existing `useLiveRefresh`
  pattern.
- Uses existing design-system pieces (`.modal-card`, `.field`, `Avatar`, the person
  picker already used for chore assignment). No new primitives unless nothing fits.

**Docs and changelog**: a features-reference row, a short how-to page under the docs site's
features, an `[Unreleased]` → Added entry, and a roadmap note.

## Testing

TDD. API integration tests (testcontainers) cover:
- CRUD
- logging with and without ask_person (422 path)
- cross-household person rejected
- latest-entry in the list
- history paging and person filter
- entry edit and delete
- the permission split
- the module-off 404

Web component tests cover:
- card tap logs
- picker on ask_person
- undo
- "Last time" formatting in household timezone
- tab gating

## Left to the builder

Tile layout details, paging size, toast duration, and exact copy beyond the strings above.
