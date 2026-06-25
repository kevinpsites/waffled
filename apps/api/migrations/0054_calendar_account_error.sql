-- Up Migration
-- Persist the last sync error per Google calendar account so the UI can attribute
-- a failure to the right account row ("⚠ Problem syncing — Reconnect") instead of
-- only a transient banner. Set when a token refresh / sync fails (e.g. invalid_grant
-- when Google's refresh token expires or is revoked); cleared on a successful sync
-- or on reconnect.

alter table calendar_accounts add column if not exists last_sync_error text;
alter table calendar_accounts add column if not exists last_sync_error_at timestamptz;

-- Down Migration

alter table calendar_accounts drop column if exists last_sync_error;
alter table calendar_accounts drop column if exists last_sync_error_at;
