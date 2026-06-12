-- Up Migration
-- Calendar — Google connection (roadmap 5.2). A household connects one or more
-- Google accounts (calendar_accounts, each holding the encrypted refresh token);
-- every account exposes one or more calendars (calendars), which map to a Nook
-- person for color/ownership. The inbound poll (5.3) fills calendars.sync_token;
-- events.calendar_id — staged FK-less in 0007 — now references calendars.
-- calendar_oauth_states ties a browser OAuth round-trip back to the household that
-- started it (Google's redirect to the callback carries no Authorization header).

create table calendar_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  person_id uuid references persons(id),            -- who connected it (default color owner)
  google_sub text not null,                          -- Google account id (openid sub)
  email text,
  scope text,                                        -- granted scopes (space-delimited)
  refresh_token_encrypted text not null,             -- AES-256-GCM at rest, see src/crypto.ts
  access_token_encrypted text,                       -- short-lived cache (optional)
  access_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (household_id, google_sub)
);

create table calendars (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  account_id uuid not null references calendar_accounts(id),
  person_id uuid references persons(id),             -- color/owner mapping (nook-owned)
  google_calendar_id text not null,                  -- "primary" or the calendar's id
  summary text,
  description text,
  timezone text,
  access_role text,                                  -- owner | writer | reader | freeBusyReader
  color_hex text,
  is_primary boolean not null default false,
  selected boolean not null default true,            -- whether Nook syncs this calendar
  sync_token text,                                   -- incremental inbound cursor (5.3)
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (account_id, google_calendar_id)
);

create index ix_calendars_household on calendars (household_id) where deleted_at is null;

-- events.calendar_id was staged in 0007 with no FK; wire it up now that the
-- target table exists. All existing events are local-only (calendar_id null).
alter table events
  add constraint fk_events_calendar foreign key (calendar_id) references calendars(id);

-- Short-lived state for the OAuth redirect. The callback is public (no auth header),
-- so the state — minted at connect time — is the only thing tying it to a household.
create table calendar_oauth_states (
  state text primary key,
  household_id uuid not null references households(id),
  person_id uuid references persons(id),
  redirect_to text,
  created_at timestamptz not null default now()
);

create trigger trg_calendar_accounts_updated before update on calendar_accounts
  for each row execute function set_updated_at();
create trigger trg_calendars_updated before update on calendars
  for each row execute function set_updated_at();

-- Down Migration

alter table events drop constraint if exists fk_events_calendar;
drop table if exists calendar_oauth_states;
drop table if exists calendars cascade;
drop table if exists calendar_accounts cascade;
