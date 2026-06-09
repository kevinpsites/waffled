-- Up Migration
-- Calendar: event participants (DATA_MODEL §2). events.person_id stays the
-- color/owner; this table is the broader "who's involved" set — so an event can
-- include multiple people (e.g. a date: Kevin + Kelly). external_* covers
-- non-family attendees later (Google sync).

create table event_participants (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  event_id uuid not null references events(id),
  person_id uuid references persons(id),             -- null when external
  external_email text,
  external_name text,
  role text,                                         -- driver | attendee | organizer
  rsvp text,                                         -- needsAction | accepted | declined | tentative
  is_organizer boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index uq_part_person on event_participants (event_id, person_id)
  where person_id is not null;
create unique index uq_part_email on event_participants (event_id, external_email)
  where external_email is not null;
create index ix_event_participants on event_participants (household_id, event_id)
  where deleted_at is null;

create trigger trg_event_participants_updated before update on event_participants
  for each row execute function set_updated_at();

-- Down Migration

drop table if exists event_participants cascade;
