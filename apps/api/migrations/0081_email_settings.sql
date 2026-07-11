-- Up Migration
-- Outbound email (SMTP). Mirrors Immich's model: transport config is stored in the
-- DB per household and edited from an admin Settings UI (not env vars), so each
-- self-hosted household brings its own SMTP/Gmail App Password. The password is
-- encrypted at rest (platform/crypto.ts, AES-256-GCM, TOKEN_ENCRYPTION_KEY) — the
-- same isolation the Google refresh tokens get — so it never sits in the frequently
-- read households.settings JSONB.

create table household_email_settings (
  household_id     uuid primary key references households(id) on delete cascade,
  enabled          boolean     not null default false,      -- master on/off for outbound mail
  host             text,                                     -- e.g. smtp.gmail.com
  port             integer     not null default 587,         -- 587 STARTTLS / 465 implicit TLS
  secure           boolean     not null default false,       -- implicit TLS (port 465)
  ignore_cert      boolean     not null default false,       -- tls.rejectUnauthorized = false
  username         text,                                     -- full Gmail address
  password_enc     text,                                     -- encryptSecret(app password)
  from_name        text,
  from_address     text,
  -- Weekly-digest preferences (non-secret). digest_dow is ISO (1=Mon … 7=Sun);
  -- digest_hour is the household-local hour to send.
  digest_enabled   boolean     not null default false,
  digest_dow       integer     not null default 1,
  digest_hour      integer     not null default 7,
  digest_sections  jsonb       not null default '["calendar","meals","grocery","chores"]'::jsonb,
  updated_at       timestamptz not null default now()
);

-- Append-only send log: idempotency (don't double-send a weekly digest if the
-- container restarts mid-week), audit, and something tests can assert on. The
-- partial unique index makes a per-household dedupe key (e.g. 'weekly_digest:2026-W28')
-- enforce at-most-once delivery per week.
create table email_deliveries (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  kind          text not null,                 -- 'test' | 'weekly_digest'
  to_address    text not null,
  subject       text not null,
  dedupe_key    text,
  status        text not null,                 -- 'sent' | 'failed'
  error         text,
  created_at    timestamptz not null default now()
);

create index email_deliveries_household_created on email_deliveries(household_id, created_at desc);
create unique index email_deliveries_dedupe
  on email_deliveries(household_id, dedupe_key) where dedupe_key is not null;

-- Down Migration
drop table if exists email_deliveries;
drop table if exists household_email_settings;
