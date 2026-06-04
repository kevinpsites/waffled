-- Runs once, on first cluster initialization (empty data dir), as the superuser
-- against the default database. Re-runs only on a fresh volume (just nuke).

\set ON_ERROR_STOP on

-- gen_random_uuid() for client-generatable UUID PKs (see DATA_MODEL conventions).
-- Built into Postgres 13+; pgcrypto ensures availability + extra crypto helpers.
create extension if not exists pgcrypto;

-- Dedicated database for PowerSync bucket storage (used from chunk 4.1).
select 'create database powersync_storage'
 where not exists (select 1 from pg_database where datname = 'powersync_storage')\gexec

-- The logical-replication publication for PowerSync is created in chunk 4.1,
-- once the synced tables exist. wal_level=logical is already set in compose.
