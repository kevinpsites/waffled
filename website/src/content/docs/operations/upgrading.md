---
title: Upgrading
description: Move a self-hosted Kinnook to a newer version safely.
---

How to move a self-hosted Kinnook to a newer version safely. Kinnook runs via `docker
compose`, driven by the root `./nook` CLI. There are two ways to run it, and the
upgrade steps differ slightly — pick the one that matches your setup.

> **⚠️ NEVER wipe your Docker volumes.** `pgdata` (Postgres) and `nook_media`
> (uploaded blobs) are irreplaceable. The database also holds the *encrypted*
> Google OIDC / calendar refresh tokens — a wiped DB loses connected-calendar auth
> that **cannot** be recovered, only re-consented. Upgrades never require deleting a
> volume; if a guide anywhere tells you to `docker volume rm` or `down -v`, stop.

## 0. Before every upgrade

1. **Back up first.** `./nook backup` (or `./nook backup && ./nook backup list` to
   confirm the dump landed). This is your rollback path — see
   [Backup & restore](/operations/backup/). Do this *before* pulling any new code or images.
2. **Read the release notes / `CHANGELOG.md`** for the version you're moving to.
   Note any env vars you're expected to add and any one-time steps called out.

Migrations run **automatically** on start (a one-shot `migrate` service runs before
`api` comes up) and are idempotent, so you normally don't run them by hand.

## Which mode am I in?

| Mode | How you know | How you upgrade |
|---|---|---|
| **Build-from-source** (default) | `NOOK_*_IMAGE` are unset in `infra/compose/.env` — `./nook up` builds images locally | `git pull`, then `./nook up` |
| **Published images (GHCR)** | `NOOK_API_IMAGE` / `NOOK_CADDY_IMAGE` / `NOOK_BACKUP_IMAGE` are set to `ghcr.io/...` tags | bump the tags, `docker compose pull`, then `./nook up` |

Releases are published to GHCR on every `v*` git tag.

## Build-from-source upgrade

```bash
./nook backup            # step 0 — always
git pull                 # fetch the new source
./nook up                # rebuild images + run migrations + start
```

`./nook up` rebuilds the local images, runs the one-shot `migrate` service
(applying any new DB migrations), and starts the stack.

## Published-image (GHCR) upgrade

1. `./nook backup` (step 0).
2. In `infra/compose/.env`, bump the image tags to the version you want (or confirm
   they point where you expect):

   ```bash
   NOOK_API_IMAGE=ghcr.io/<owner>/nook-api:vX.Y.Z
   NOOK_CADDY_IMAGE=ghcr.io/<owner>/nook-caddy:vX.Y.Z
   NOOK_BACKUP_IMAGE=ghcr.io/<owner>/nook-backup:vX.Y.Z
   ```

3. Pull the new images, then start:

   ```bash
   docker compose -f infra/compose/docker-compose.yml pull
   ./nook up
   ```

   Migrations run automatically on start, same as build-from-source.

## Verifying the upgrade

```bash
./nook doctor            # deep health report — see below
./nook status            # services up / healthy
```

`./nook doctor` should come back **all green**. Specifically check:

- **Migrations:** applied count == available count. If the report flags "schema
  behind", migrations are pending — run `./nook migrate` (or just `./nook up`).
- **Version:** the reported git sha / build time matches the release you upgraded
  to (build provenance is surfaced on the health report).
- **Every component** (db, jobs, calendar, storage, backup) reads healthy. `doctor`
  exits non-zero if anything is degraded/down.

You can also open **Settings → System Health** (same data) or hit `GET /healthz`
(public, shallow: db ping + version).

## Rolling back

Migrations are **forward-only** — there is no down-migration. To go back to an
earlier version you must also restore the database as it was *before* the upgrade:

1. Revert code/images to the previous version (`git checkout <prev tag>` for
   build-from-source, or restore the old `NOOK_*_IMAGE` tags + `docker compose
   pull` for GHCR).
2. **Restore the pre-upgrade backup you took in step 0:**

   ```bash
   ./nook restore nook-<pre-upgrade-timestamp>.sql.gz
   ```

   This is destructive (overwrites the current DB) — details in
   [Backup & restore](/operations/backup/). This is exactly why step 0 is non-negotiable: if you
   skipped the backup, you cannot cleanly roll back a schema change.

3. `./nook doctor` to confirm the rolled-back stack is healthy.

## Something broke?

See [Troubleshooting](/operations/troubleshooting/). Start with `./nook doctor`.
