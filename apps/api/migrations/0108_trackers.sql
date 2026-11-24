-- Up Migration
-- Trackers: tap-to-log items (e.g. "Tylenol") with a timestamped entry per tap.
-- Composite FKs keep every reference inside one household (see 0104).

create table trackers (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  emoji text,
  ask_person boolean not null default false,
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id)
);

create table tracker_entries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  tracker_id uuid not null,
  occurred_at timestamptz not null default now(),
  person_id uuid,
  logged_by uuid,
  note text,
  created_at timestamptz not null default now(),
  foreign key (household_id, tracker_id) references trackers (household_id, id) on delete cascade,
  foreign key (household_id, person_id) references persons (household_id, id) on delete set null (person_id),
  foreign key (household_id, logged_by) references persons (household_id, id) on delete set null (logged_by)
);

create index tracker_entries_tracker_occurred_idx on tracker_entries (tracker_id, occurred_at desc);

-- Down Migration
drop table if exists tracker_entries;
drop table if exists trackers;
