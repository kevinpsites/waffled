-- Up Migration
-- Personal vs family calendars. A calendar is either visible to the whole household
-- (family — shows on the shared kiosk) or only to its owner (personal — shows on the
-- owner's own app/profile, never on the shared kiosk). `calendars.visibility` is the
-- source of truth; it is denormalized onto `events` + `event_occurrences` so clients —
-- which sync those read-model rows but NOT the calendars table — can filter locally
-- with `visibility = 'family' OR owner_person_id = <viewer>`. The denormalized copy is
-- kept in step by the inbound Google sync, event authoring, and the calendar toggle
-- (see calendar-sync.service.ts / calendars.ts).

alter table calendars
  add column visibility text not null default 'family'
    check (visibility in ('family', 'personal'));

alter table events
  add column visibility text not null default 'family'
    check (visibility in ('family', 'personal')),
  add column owner_person_id uuid references persons(id);

alter table event_occurrences
  add column visibility text not null default 'family'
    check (visibility in ('family', 'personal')),
  add column owner_person_id uuid;                    -- denormalized (FK-less, like person_id)

-- Backfill the denormalized copy from each event's calendar. Local events
-- (calendar_id null) stay family / owner null. Existing calendars all default to
-- 'family', so nothing disappears from any kiosk on upgrade — the smart per-calendar
-- default (primary → family, others → personal) applies only to newly synced calendars.
update events e
   set visibility = c.visibility,
       owner_person_id = c.person_id
  from calendars c
 where e.calendar_id = c.id;

-- Occurrences inherit from their master event (stamped just above).
update event_occurrences o
   set visibility = e.visibility,
       owner_person_id = e.owner_person_id
  from events e
 where o.event_id = e.id;

-- Fast lookup for the personal filter on the back-end read paths.
create index ix_events_personal on events (owner_person_id)
  where visibility = 'personal' and deleted_at is null;
create index ix_occ_personal on event_occurrences (owner_person_id)
  where visibility = 'personal' and deleted_at is null;

-- Down Migration

drop index if exists ix_occ_personal;
drop index if exists ix_events_personal;
alter table event_occurrences drop column if exists owner_person_id;
alter table event_occurrences drop column if exists visibility;
alter table events drop column if exists owner_person_id;
alter table events drop column if exists visibility;
alter table calendars drop column if exists visibility;
