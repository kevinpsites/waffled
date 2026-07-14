---
title: Upgrading
description: Move a self-hosted Waffled to a newer version safely.
---

Moving a self-hosted Waffled to a newer version is a single command: **`./waffled
upgrade`**. This page covers what it does, how versioning works, and how to roll back.

> **⚠️ NEVER wipe your Docker volumes.** `pgdata` (Postgres) and `waffled_media`
> (uploaded blobs) are irreplaceable. The database also holds the *encrypted*
> Google OIDC / calendar refresh tokens — a wiped DB loses connected-calendar auth
> that **cannot** be recovered, only re-consented. Upgrades never require deleting a
> volume; if a guide anywhere tells you to `docker volume rm` or `down -v`, stop.

## The one-command upgrade

```bash
./waffled upgrade
```

That does the whole thing, in order:

1. **Fast-forwards the repo** (`git pull --ff-only`). The tagged repo and the images
   are a *matched pair* — the compose file, configs, and `./waffled` script must agree
   with the image you're about to run — so the code is updated first. If the pull can't
   fast-forward (local changes or diverged history), the upgrade **stops before changing
   images**; resolve the repository state and re-run.
2. **Takes a database backup** (via the running backup sidecar) as your rollback point,
   *before* changing the version pin or images. If the backup service is unavailable or
   the backup fails, the upgrade stops.
3. **Bumps `WAFFLED_VERSION` in your `.env`** to match the version this checkout points
   at. This is the step that used to be manual: `./waffled` only writes `.env` on first
   run, so an existing `.env` kept its *old* version and a plain `./waffled up` would
   re-pull the old image.
4. **Pulls the new images and restarts** the stack. The one-shot **migrate** service
   reruns automatically (the image tag changed) and applies any new migrations before
   `api` comes up.
5. **Prints a health table** so you can see everything came back healthy.

Migrations are **idempotent** — only the ones you don't have yet are applied, and it's
safe to re-run `upgrade`.

If you have independently created and verified a rollback point, you can explicitly bypass
the automatic snapshot with `./waffled upgrade --skip-backup`. This is intentionally opt-in:
without a matching pre-upgrade database backup, a forward-only migration cannot be cleanly
rolled back.

:::caution[Google Calendar callback changes]
The API diagnostic port is loopback-only in current releases. Upgrades automatically move the
exact old localhost callback from port `3000` to Caddy on port `8080`. A custom callback that
still uses `:3000` is left untouched and produces a warning: update it to your public Caddy origin
plus `/auth/google/calendar/callback`, then register that exact URL in Google Cloud before
reconnecting Calendar.
:::

### You'll be told when there's an update

Waffled checks GitHub for new releases and shows **Settings → System Health → "Update
available — vX.Y.Z"** when you're behind (on by default; toggle per household there, or
disable outbound checks entirely with `UPDATE_CHECK_ENABLED=false`). That notice names
the `./waffled upgrade` command, so you don't have to watch the repo.

## Before you upgrade

`./waffled upgrade` already snapshots the DB for you, but it's still worth:

1. **Reading the release notes / `CHANGELOG.md`** for the version you're moving to — note
   any new env vars or one-time steps a release calls out.
2. **Confirming a good backup** if you want belt-and-suspenders: `./waffled backup && ./waffled
   backup list`. See [Backup & restore](/operations/backup/).

## How versioning works

`./waffled up` **pulls prebuilt multi-arch images from GHCR by default**, pinned to
`WAFFLED_VERSION` in `infra/compose/.env` (the single version knob). `./waffled upgrade`
just moves that pin forward and pulls. A few variations:

- **Pin to a specific release** instead of "latest on this branch": check out the tag
  first, then upgrade — `git checkout v0.2.0 && ./waffled upgrade`. (`upgrade` reads the
  target version from the checkout's `.env.example`, so the tag you're on decides it.)
- **Run bleeding-edge from source** instead of published images: `./waffled up --build`
  after a `git pull` builds the images locally and stamps the current git SHA.
- **Point at a custom registry/tag**: an explicit `WAFFLED_API_IMAGE` /
  `WAFFLED_CADDY_IMAGE` / `WAFFLED_BACKUP_IMAGE` in `.env` overrides the
  `WAFFLED_VERSION` default entirely.

Images are published to GHCR by `.github/workflows/publish-images.yml` on every `v*` git
tag (built per-arch on native runners, then merged into one multi-arch manifest).

## Verifying the upgrade

```bash
./waffled doctor            # deep health report
./waffled status            # services up / healthy
```

`./waffled doctor` should come back **all green**. Specifically check:

- **Migrations:** applied count == available count. If it flags "schema behind",
  migrations are pending — run `./waffled migrate` (or just `./waffled up`).
- **Version:** the reported version / git sha / build time matches the release you moved
  to (build provenance is on the health report).
- **Every component** (db, jobs, calendar, storage, backup) reads healthy. `doctor` exits
  non-zero if anything is degraded/down.

You can also open **Settings → System Health** (same data) or hit `GET /healthz` (public,
shallow: db ping + version).

## Rolling back

Migrations are **forward-only** — there is no down-migration. To go back to an earlier
version you must also restore the database as it was *before* the upgrade:

1. Revert the code/images to the previous version: `git checkout <prev tag>` and set
   `WAFFLED_VERSION` back (or restore your old `WAFFLED_*_IMAGE` tags), then `./waffled up`.
2. **Restore the pre-upgrade snapshot** (`upgrade` took one automatically — find it with
   `./waffled backup list`):

   ```bash
   ./waffled restore waffled-<pre-upgrade-timestamp>.sql.gz
   ```

   This is destructive (overwrites the current DB) — details in
   [Backup & restore](/operations/backup/). This is exactly why the automatic pre-upgrade
   backup matters: without it you can't cleanly roll back a schema change.
3. `./waffled doctor` to confirm the rolled-back stack is healthy.

## Something broke?

See [Troubleshooting](/operations/troubleshooting/). Start with `./waffled doctor`.
