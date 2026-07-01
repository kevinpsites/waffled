-- Up Migration
-- Calendar countdowns — "N days until X" to build anticipation (vacation, birthday, trip).
-- Two stored sources here; the third (member birthdays) is derived at read time from
-- persons.birthday. (1) Any calendar event can be flagged as a countdown. (2) Standalone
-- countdowns are lightweight named dates that aren't full calendar events.

alter table events add column is_countdown boolean not null default false;

create table countdowns (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title text not null,
  date date not null,
  emoji text,
  color text,
  created_by uuid references persons(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_countdowns_household on countdowns (household_id, date) where deleted_at is null;

-- Down Migration

drop table if exists countdowns;
alter table events drop column if exists is_countdown;
