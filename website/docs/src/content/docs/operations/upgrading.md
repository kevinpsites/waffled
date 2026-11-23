---
title: Upgrading
description: Move a self-hosted Waffled to a newer version safely.
---

Moving a self-hosted Waffled to a newer version is two commands. This page covers what they
do, how versioning works, and how to roll back.

> **⚠️ NEVER wipe your Docker volumes.** `waffled_pgdata` (Postgres), `waffled_waffled_media`
> (uploaded blobs) and `waffled_waffled_data` (generated secrets) are irreplaceable. The
> database also holds *encrypted* Google/Outlook/OIDC tokens; a wiped DB or lost key loses
> connected-calendar auth that **cannot** be recovered, only re-consented. Upgrades never
> require deleting a volume; if a guide anywhere tells you to `docker volume rm` or `down -v`,
> stop.

## The upgrade

From the folder holding `compose.yaml`:

```bash
docker compose pull && docker compose up -d
```

1. `pull` fetches the newer `waffled` image (and `waffled-backup`, if you use it).
2. `up -d` recreates the containers on the new image. On start, the app applies any new
   database migrations before it serves traffic. Migrations are **idempotent**: only the ones
   you don't have yet are applied, so it is safe to re-run.

If a migration can't get a table lock because the previous version is still using that
table, it retries for about a minute, then stops with a message naming the blocking
sessions. See [Upgrade stuck on migrate](/operations/troubleshooting/#upgrade-stuck-on-migrate).

**There is no automatic backup before an upgrade.** If you want a rollback point, take one
first (see [Before you upgrade](#before-you-upgrade)).

If a newer `compose.yaml` shipped with the release (it is in the repo), download it again
before pulling, and check [`CHANGELOG.md`](https://github.com/evan-ribbey/waffled-ng/blob/main/CHANGELOG.md)
for new settings:

```bash
curl -fsSLO https://raw.githubusercontent.com/evan-ribbey/waffled-ng/main/compose.yaml
```

### You'll be told when there's an update

Waffled checks GitHub for new releases and shows **Settings → System Health → "Update
available — vX.Y.Z"** when you're behind (on by default; toggle per household there, or
disable outbound checks entirely with `UPDATE_CHECK_ENABLED=false`). It checks
`UPDATE_CHECK_REPO`, which defaults to `evan-ribbey/waffled-ng`.

## Before you upgrade

1. **Read the release notes / `CHANGELOG.md`** for the version you're moving to; note any new
   env vars or one-time steps a release calls out.
2. **Take a backup** if you want a rollback point:
   `docker compose exec -u postgres backup waffled-backup` (needs
   `docker compose --profile backup up -d` first). See [Backup & restore](/operations/backup/).

## How versioning works

The compose file pulls `ghcr.io/evan-ribbey/waffled:${WAFFLED_VERSION:-latest}`.

- **Track the latest release:** leave `WAFFLED_VERSION` unset, then
  `docker compose pull && docker compose up -d`.
- **Pin a specific release:** set `WAFFLED_VERSION=0.16.0` in `.env`, then run the same
  commands. Change the pin to move forward or back.
- **Run bleeding-edge from source:** `git pull && docker compose up -d --build` builds the
  image locally.

Images are published to GHCR by `.github/workflows/publish-images.yml` on every `v*` git
tag (built per-arch on native runners, then merged into one multi-arch manifest).

## Verifying the upgrade

```bash
docker compose ps
docker compose logs --tail 50 waffled
```

`waffled` should report **healthy**. Then open **Settings → System Health** in the app and
check:

- **Migrations:** applied count equals available count.
- **Version:** the reported version and build match the release you moved to.
- **Every component** (db, jobs, calendar, storage, backup) reads healthy.

You can also hit `GET /healthz` (public, shallow: db ping + version).

## Rolling back

Migrations are **forward-only**; there is no down-migration. To go back to an earlier version
you must also restore the database as it was *before* the upgrade:

1. Set `WAFFLED_VERSION` back to the previous release in `.env` and stop the app:
   `docker compose stop waffled`.
2. **Restore your pre-upgrade backup**:

   ```bash
   docker compose run --rm --no-deps backup restore <file>
   ```

   This is destructive (overwrites the current DB); details in
   [Backup & restore](/operations/backup/).
3. `docker compose up -d`, then check System Health.

Without a pre-upgrade backup you can't cleanly roll back a schema change.

## Switching from the old `./waffled` install

See [Migrating from the ./waffled CLI](/install/migrating-from-waffled-cli/).

## Something broke?

See [Troubleshooting](/operations/troubleshooting/).
