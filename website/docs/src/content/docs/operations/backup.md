---
title: Backup & restore
description: Optional nightly database backups, offsite copies, and restore.
---

Waffled can back up your database on a nightly schedule. The `backup` service is **optional**
and off by default: you turn it on with a Compose profile. It dumps Postgres every night, can
push each dump offsite to S3-compatible storage, and can include uploaded media. Every run is
recorded so **Settings → System Health** shows you the last backup at a glance.

:::caution[Backups are off until you start them]
A plain `docker compose up -d` does **not** run backups. There is also no automatic backup
before an upgrade. Turn the profile on now, not after something breaks.
:::

## Turn backups on

```bash
docker compose --profile backup up -d
```

Then add `BACKUP_ENABLED=true` to `.env` (beside `compose.yaml`) and run
`docker compose --profile backup up -d` again. That setting tells System Health to expect a
recent backup and warn you if one is missing. Without it, System Health stays quiet about
backups.

To be safe against a lost machine, point them at a folder you control (`BACKUP_HOST_PATH`)
and/or an offsite bucket (`BACKUP_S3_*`); see below.

## What gets backed up

| | Included | Where |
|---|---|---|
| **Database** (all app data: calendar, chores, goals, meals, lists, people, settings…) | Always | `waffled-<timestamp>.sql.gz` |
| **Uploaded media** (photos, recipe images, chore proofs) | Opt-in: `BACKUP_INCLUDE_MEDIA=true` | `waffled-media-<timestamp>.tar.gz` |

The database dump is plain SQL (gzipped), created with `pg_dump --clean --if-exists`, so a
restore works into any role.

> **Back up the secrets volume too.** The `waffled_data` volume holds `/data/secrets.json`
> (`LOCAL_JWT_SECRET` and `TOKEN_ENCRYPTION_KEY`). It is deliberately *not* in the database dump,
> so a dump alone cannot decrypt stored calendar and SSO tokens. If you lose it, you must
> re-link calendars. Copy that file somewhere safe, or set both keys in `.env`.

## Where backups go

By default, dumps land in the `waffled_backups` Docker volume and are pruned after
`BACKUP_RETENTION_DAYS` (14). Two ways to make them more durable:

- **A host folder you choose** (e.g. a mounted drive): set `BACKUP_HOST_PATH=/mnt/backups`
  in `.env`. Compose bind-mounts it as the backup target.
- **Offsite, S3-compatible** (AWS S3, Backblaze B2, Cloudflare R2, self-hosted MinIO): set
  the `BACKUP_S3_*` vars. Each dump is uploaded in addition to the local copy. For S3-side
  retention, use a bucket lifecycle rule (local retention only prunes local files).

:::caution[`BACKUP_HOST_PATH` ownership changes]
The backup scheduler runs as an unprivileged user. On start, the backup container changes the
ownership of the backup path to the `postgres` user (UID/GID `999`). If `BACKUP_HOST_PATH` is a
host folder, its ownership changes on the host too. Choose a dedicated backup directory and make
sure your host-side backup tooling can still read it.
:::

## Configuration

All optional; set in `.env` (documented in `.env.example`). Defaults shown:

```bash
BACKUP_ENABLED=true             # off unless set: tells System Health to expect backups
BACKUP_TIME=02:00               # daily HH:MM (container timezone; set TZ to change)
BACKUP_RETENTION_DAYS=14        # delete local dumps older than this
BACKUP_ON_START=false           # also back up right after the container starts
BACKUP_INCLUDE_MEDIA=false      # also archive uploaded media
BACKUP_HOST_PATH=               # write dumps to a host folder instead of the volume

# Offsite copy (leave BACKUP_S3_BUCKET empty for local-only):
BACKUP_S3_BUCKET=s3://my-bucket/waffled
BACKUP_S3_ENDPOINT=             # set for B2/R2/MinIO; empty = real AWS
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ACCESS_KEY_ID=
BACKUP_S3_SECRET_ACCESS_KEY=
```

After changing any of these: `docker compose --profile backup up -d` (recreates the `backup`
service with the new env).

## Commands

```bash
# run a backup right now (out of band from the schedule)
docker compose exec -u postgres backup waffled-backup

# list the dumps currently on disk
docker compose exec backup ls -lh /backups
```

Check offsite copies the same way you would any backup: periodically download one database dump
and its matching media archive from the offsite destination and confirm they open
(`gunzip -t waffled-*.sql.gz`).

## Restore

Restore is destructive: it **overwrites the current database** with the dump.

```bash
docker compose stop waffled
docker compose run --rm --no-deps backup restore waffled-20260701-020000.sql.gz
docker compose start waffled
```

A bare filename is looked up in the backup folder. Keep `--no-deps`: without it, Compose
starts the `waffled` app again as a dependency, and restore **refuses to run while any other
session is connected to the database**. The restore itself runs the dump through
`psql --single-transaction` (all-or-nothing).

When the app starts again it applies any migrations the dump is missing, so restoring an
**older** dump automatically catches its schema up to the current version.

## Monitoring

With `BACKUP_ENABLED=true`, the `backup` health check (in `/api/health` and Settings → System
Health) reports the most recent run and turns **degraded** if the last backup failed or the
newest successful one is more than ~48 h old (two missed daily cycles). A failure hint points
you at `docker compose logs backup`, usually disk space or an S3 credential/endpoint problem.

## Recommended: 3-2-1

For real safety, keep **3** copies on **2** kinds of media with **1** offsite: the local
volume/host folder gives you fast local restores; `BACKUP_S3_*` gives you the offsite copy.
Turn on `BACKUP_INCLUDE_MEDIA` if you rely on uploaded photos/recipe images.
