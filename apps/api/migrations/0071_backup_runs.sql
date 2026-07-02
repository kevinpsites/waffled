-- Up Migration
-- Operational (not household-scoped) table recording every backup the `backup`
-- sidecar runs, so `/api/health` + `./nook doctor` can surface "last backup: ok/failed,
-- N hours ago". Deliberately NOT added to the `powersync` publication — this is
-- server-side operator data and never syncs to clients.
create table backup_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running',   -- running | success | failed
  kind         text not null default 'database',  -- database | media
  destination  text not null default 'local',     -- local | s3 | local+s3
  file_name    text,
  size_bytes   bigint,
  duration_ms  integer,
  error        text,
  created_at   timestamptz not null default now()
);

-- Health reads "the latest finished run", and we prune old rows by age.
create index ix_backup_runs_finished on backup_runs (finished_at desc nulls last);

-- Down Migration
drop table if exists backup_runs;
