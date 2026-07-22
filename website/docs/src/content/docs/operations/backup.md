---
title: Backup & restore
description: Automatic nightly database backups, offsite copies, and restore.
---

Waffled backs up your database automatically. The `backup` service (part of the default
stack) dumps Postgres on a nightly schedule; you can optionally push each dump offsite
to S3-compatible storage and include uploaded media. Every run is recorded so
**Settings → System Health** and `./waffled doctor` show you the last backup at a glance.

> **On by default, zero-config.** A fresh `./waffled up` starts nightly local backups with
> no setup. To be safe against a lost machine, point them at a folder you control
> (`BACKUP_HOST_PATH`) and/or an offsite bucket (`BACKUP_S3_*`) — see below.

## What gets backed up

| | Included | Where |
|---|---|---|
| **Database** (all app data: calendar, chores, goals, meals, lists, people, settings…) | Always | `waffled-<timestamp>.sql.gz` |
| **Uploaded media** (photos, recipe images, chore proofs) | Opt-in — `BACKUP_INCLUDE_MEDIA=true` | `waffled-media-<timestamp>.tar.gz` |

The database dump is plain SQL (gzipped), created with `pg_dump --clean --if-exists`, so a
restore is a simple `gunzip | psql` and works into any role. PowerSync's own bucket storage
(`powersync_storage`) is **not** backed up — it's derived and rebuilds itself automatically.

## Where backups go

By default, dumps land in the `waffled_backups` Docker volume and are pruned after
`BACKUP_RETENTION_DAYS` (14). Two ways to make them more durable:

- **A host folder you choose** (e.g. a mounted drive): set `BACKUP_HOST_PATH=/mnt/backups`
  in `infra/compose/.env`. Compose bind-mounts it as the backup target.
- **Offsite, S3-compatible** (AWS S3, Backblaze B2, Cloudflare R2, self-hosted MinIO): set
  the `BACKUP_S3_*` vars. Each dump is uploaded in addition to the local copy. For S3-side
  retention, use a bucket lifecycle rule (local retention only prunes local files).

:::caution[`BACKUP_HOST_PATH` ownership changes]
The backup scheduler runs as an unprivileged user. On the first start after upgrading from an
older release, a one-shot permissions job recursively changes the configured backup path to
numeric UID/GID `999` (the container's `postgres` user). If `BACKUP_HOST_PATH` is a host folder,
its ownership changes on the host too. Choose a dedicated backup directory and make sure your
host-side backup tooling can still read it.
:::

## Configuration

All optional — set in `infra/compose/.env` (documented in `.env.example`). Defaults shown:

```bash
BACKUP_TIME=02:00               # daily HH:MM (container timezone; set TZ to change)
BACKUP_RETENTION_DAYS=14        # delete local dumps older than this
BACKUP_ON_START=false           # also back up right after the container starts
BACKUP_INCLUDE_MEDIA=false      # also archive uploaded media
BACKUP_HOST_PATH=               # write dumps to a host folder instead of the volume
BACKUP_ENABLED=true             # set false only if you REMOVE the backup service (stops health nagging)

# Offsite copy (leave BACKUP_S3_BUCKET empty for local-only):
BACKUP_S3_BUCKET=s3://my-bucket/waffled
BACKUP_S3_ENDPOINT=             # set for B2/R2/MinIO; empty = real AWS
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ACCESS_KEY_ID=
BACKUP_S3_SECRET_ACCESS_KEY=
```

After changing any of these: `./waffled up` (recreates the `backup` service with the new env).

## Commands

```bash
./waffled backup          # run a backup right now (out of band from the schedule)
./waffled backup list     # list the dumps currently on disk
./waffled backup verify   # restore the newest dump into an isolated test database
./waffled restore <file>  # restore a dump (DESTRUCTIVE — see below)
./waffled doctor          # health report; the "backup" line shows last run + age
```

## Verify before you need it

```bash
./waffled backup verify
./waffled backup verify waffled-20260701-020000.sql.gz
```

`backup verify` is a non-destructive restore drill. It checks the gzip archive, starts a
disposable Postgres container using the same image as your Waffled database, restores the dump
with errors treated as fatal, checks for the Waffled schema, and removes the test container. It
does **not** stop the app or connect to the live database. With no filename, it tests the newest
local database dump.

This command verifies the database dump only. If uploaded-media backups are enabled, also test
that the matching archive can be read:

```bash
docker exec waffled-backup sh -c \
  'tar -tzf /backups/waffled-media-20260701-020000.tar.gz >/dev/null'
```

An offsite backup is useful only if you can retrieve it. Periodically download one database dump
and its matching media archive from the offsite destination, place them in your configured backup
folder, and run the same checks on those copies.

## Restore

```bash
./waffled restore waffled-20260701-020000.sql.gz
```

Restore is destructive — it **overwrites the current database** with the dump. `./waffled
restore`:

1. Confirms (interactive terminals prompt for `restore`; non-interactive shells proceed).
2. Stops `api`, `powersync`, and `caddy` so nothing writes mid-restore.
3. Pipes the dump through `psql --single-transaction` (all-or-nothing).
4. Restarts the stack. The one-shot `migrate` service re-runs on start, so restoring an
   **older** dump automatically catches its schema up to the current migrations.

**PowerSync after a restore:** the restore replaces the publication, so PowerSync drops its
old replication slot and re-replicates from scratch — connected clients re-sync. This is
automatic and expected; the stack returns to healthy on its own (verify with `./waffled doctor`).

## Monitoring

The `backup` health check (in `/api/health`, `./waffled doctor`, and Settings → System Health)
reports the most recent run and turns **degraded** if the last backup failed or the newest
successful one is more than ~48 h old (two missed daily cycles). A failure hint points you at
`./waffled logs backup` — usually disk space or an S3 credential/endpoint problem.

## Recommended: 3-2-1

For real safety, keep **3** copies on **2** kinds of media with **1** offsite: the local
volume/host folder gives you fast local restores; `BACKUP_S3_*` gives you the offsite copy.
Turn on `BACKUP_INCLUDE_MEDIA` if you rely on uploaded photos/recipe images. Periodically do a
`./waffled backup verify` of a recent dump so you know it works before you need it.
