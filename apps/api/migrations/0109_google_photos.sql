-- Up Migration
-- Google Photos import. Google no longer lets apps read a user's albums, so photos
-- arrive through the Photos Picker API: each pick session copies the chosen photos
-- into one named Waffled album (photos.memory). See docs/product/google-photos-plan.md.

create table google_photos_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  person_id uuid,
  google_sub text not null,
  email text,
  scope text,
  refresh_token_encrypted text not null,
  access_token_encrypted text,
  access_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, google_sub),
  foreign key (household_id, person_id) references persons (household_id, id)
);

create table google_photos_oauth_states (
  state text primary key,
  household_id uuid not null references households(id),
  person_id uuid,
  redirect_to text,
  created_at timestamptz not null default now(),
  foreign key (household_id, person_id) references persons (household_id, id)
);

create table google_photos_imports (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  account_id uuid references google_photos_accounts(id) on delete set null,
  person_id uuid,
  album text not null,
  session_id text not null,
  picker_uri text not null,
  expire_time timestamptz,
  status text not null default 'picking'
    check (status in ('picking', 'importing', 'done', 'failed', 'expired')),
  imported_count integer not null default 0,
  skipped_count integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, person_id) references persons (household_id, id)
);

create index ix_google_photos_imports_household on google_photos_imports (household_id, created_at desc);

-- Where a photo came from. external_id is the provider's media id, so a photo picked
-- twice into the same household is imported once.
alter table photos add column source text not null default 'upload';
alter table photos add column external_id text;
create unique index ux_photos_household_external
  on photos (household_id, source, external_id) where external_id is not null;

create trigger trg_google_photos_accounts_updated before update on google_photos_accounts
  for each row execute function set_updated_at();
create trigger trg_google_photos_imports_updated before update on google_photos_imports
  for each row execute function set_updated_at();

-- Down Migration

drop index if exists ux_photos_household_external;
alter table photos drop column if exists external_id;
alter table photos drop column if exists source;
drop table if exists google_photos_imports;
drop table if exists google_photos_oauth_states;
drop table if exists google_photos_accounts;
