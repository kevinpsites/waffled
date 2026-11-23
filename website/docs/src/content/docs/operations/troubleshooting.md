---
title: Troubleshooting
description: Symptom → diagnosis → fix for common self-hosted Waffled issues.
---

Practical fixes for a self-hosted Waffled. Each entry is **symptom → diagnosis → fix**.

## Start with System Health and the logs

**Settings → System Health** (and `GET /api/health`, admin) is a deep health report: db,
migrations, jobs, calendar, storage, backup. It almost always tells you which component is
unhappy before you start guessing. For a quick liveness check without auth, `GET /healthz`
(public: db ping + version).

Then check the containers and their logs:

```bash
docker compose ps
docker compose logs --tail 100 waffled     # or: postgres, backup
```

## Quick index

| Symptom | Jump to |
|---|---|
| DB check down / can't connect | [Postgres unreachable](#postgres-unreachable) |
| "schema behind" / migrations pending | [Migrations pending](#migrations-pending) |
| Upgrade stuck on migrations / `lock timeout` | [Upgrade stuck on migrate](#upgrade-stuck-on-migrate) |
| Calendars stale / sync failing / `push_failed` | [Calendar sync](#calendar-sync-failing-google-or-outlook) |
| A subscribed ICS feed shows an error or never updates | [Calendar feeds](#calendar-feed-ics-not-updating) |
| Photo/recipe uploads fail / storage degraded | [Media uploads failing](#media-uploads-failing) |
| Backup health degraded / stale | [Backups failing](#backups-failing-or-stale) |
| Can't reach the app / TLS errors | [Can't reach the app](#cant-reach-the-app--tls) |
| Locked out / forgot admin password | [Locked out](#locked-out--forgot-admin-password) |

---

### Postgres unreachable

**Symptom:** the System Health db check is **down**, the app won't start or 500s
everywhere, or `/healthz` fails.

**Diagnose:** `docker compose ps` and `docker compose logs postgres`. Is the `postgres`
container up and **healthy**? Common causes: container still starting, out of disk,
or a bad shutdown.

**Fix:** wait for the health check to pass; if it's crash-looping, read the postgres
logs. `docker compose restart postgres waffled`. **Never** `docker volume
rm waffled_pgdata`, which destroys all data (see the never-wipe warning in the
[upgrading guide](/operations/upgrading/)). If the volume is genuinely corrupt, restore from a
backup (see [Backup & restore](/operations/backup/)).

### Migrations pending

**Symptom:** the health report flags **"schema behind"** (applied migration count <
available count); new features missing or erroring after an upgrade.

**Diagnose:** `docker compose logs waffled` shows whether migrations ran or failed on start.

**Fix:** the app applies migrations every time it starts, so fix what the log shows and
restart:

```bash
docker compose up -d      # or: docker compose restart waffled
```

### Upgrade stuck on migrate

**Symptom:** after `docker compose up -d` the `waffled` container keeps restarting or sits
unhealthy, and its log shows
`lock timeout: … was not granted within 10000ms; gave up after 4 attempt(s)` followed by a
list of **Blocking sessions**.

**Diagnose:** a migration needs a table lock that another database session is holding,
usually the previous version of the app still running while the new one applies the schema.
`docker compose logs waffled` shows the retries and each blocker's pid, user, application,
state and query.

**Fix:** stop the app so nothing holds the tables, then bring it back up:

```bash
docker compose stop waffled
docker compose up -d        # migrations run alone, then the app serves
```

If the blocker is something else, such as a `psql` session left inside a transaction, end it
or terminate it by pid with `select pg_terminate_backend(<pid>);`. On a very busy database you
can give each lock longer with `MIGRATE_LOCK_TIMEOUT=30s` in `.env` (`0` waits indefinitely).

### Calendar sync failing (Google or Outlook)

**Symptom:** calendars stale / not updating; health `calendar` degraded; jobs log
`push_failed` or `invalid_grant`.

**Diagnose:** an `invalid_grant` from Google means the stored refresh token was
**expired or revoked** — the connected account's authorization is no longer valid.

**Fix:** reconnect the account in **Settings → Calendars** (re-runs the Google
consent flow and stores a fresh token).

> **Heads-up on repeated failures:** if your Google OAuth app is still in
> **"Testing"** on the consent screen, Google **expires refresh tokens after 7
> days**, so sync will keep breaking weekly. Publish the OAuth consent screen (move
> it out of Testing) to stop this from recurring.

**Outlook / Microsoft 365** fails the same way but for different reasons: the Azure
**client secret has an expiry date** and sync stops dead when it lapses, and sign-in
errors carry an `AADSTS` code. See
[Outlook troubleshooting](/administration/outlook-calendar/#troubleshooting) for the
specific codes. Note Waffled rotates Microsoft refresh tokens automatically — there is
nothing to maintain there.

### Calendar feed (ICS) not updating

**Symptom:** a subscribed feed shows a ⚠ error, or its events never appear.

**Diagnose:** each feed row in **Settings → Calendars → Calendar feeds** shows its
last-synced time and the last error verbatim (an HTTP status from the publisher, or a
parse failure). One bad feed never blocks the others.

**Fix:** check the URL still resolves and is *published* (many calendar apps expire or
rotate a published link). Press the row's **↻** to retry immediately rather than waiting
for the 15-minute poll. Remember feed events are read-only: to change one, change it at
the source.

### Media uploads failing

**Symptom:** photo / recipe-image / chore-proof uploads fail; health `storage`
degraded; images 404 or won't save.

**Diagnose:** the `waffled_media` volume isn't writable, or `MEDIA_DIR` points
somewhere the api can't write. `docker compose logs waffled` will show the write error.

**Fix:** confirm the `waffled_media` volume is mounted and writable and that
`MEDIA_DIR` is correct; check host disk space. **Do not** delete or recreate
`waffled_media` — uploaded blobs live there and are irreplaceable.

### Backups failing or stale

**Symptom:** health **`backup`** line is **degraded** (last backup failed, or newest
success is older than ~48 h). If it says automatic backups are off, you haven't started
the backup profile yet; see [Backup & restore](/operations/backup/).

**Diagnose:** `docker compose logs backup`. Usual causes: out of disk space, or bad
`BACKUP_S3_*` credentials / endpoint when offsite copy is enabled.

**Fix:** free disk space, or fix the S3 creds/endpoint in `.env`, then
`docker compose --profile backup up -d` to recreate the backup service. Run
`docker compose exec -u postgres backup waffled-backup` to confirm a manual run succeeds.
Full config in [Backup & restore](/operations/backup/).

### Can't reach the app / TLS

**Symptom:** browser can't connect, or TLS/certificate errors.

**Diagnose:** `docker compose ps` (is `waffled` healthy, and is the port published?), then
`docker compose logs waffled`. The app itself speaks plain HTTP; any TLS comes from your own
reverse proxy.

**Fix:**

- **Direct access is plain HTTP** on the mapped port: use `http://<host>:8080`, not
  `https://`. Don't expect a valid cert there.
- **Port already in use:** set `HTTP_PORT` in `.env` and run `docker compose up -d`.
- **Behind a reverse proxy:** check the proxy's own logs, and that `PUBLIC_BASE_URL` and
  `TRUST_PROXY` are set; see [Reverse proxy & TLS](/install/reverse-proxy/).
- **Sign-in or calendar redirects land on the wrong address:** set `PUBLIC_BASE_URL` to the
  origin you actually use.

### Locked out / forgot admin password

**Symptom:** no one can sign in as an admin.

**Fix (break-glass, from the host):**

```bash
A="docker compose exec -u node waffled node dist/admin.js"
$A list-members                      # see who exists
$A reset-password --email you@example.com
$A make-admin --email you@example.com
$A prune-sessions                    # invalidate active sessions if needed
$A help                              # the full command list
```

---

## Where to look, at a glance

| Tool | What it gives you |
|---|---|
| **Settings → System Health** | deep per-component health, in the UI |
| `docker compose ps` | which services are up / healthy |
| `docker compose logs <svc>` | logs for `waffled` / `postgres` / `backup` |
| `GET /healthz` | public shallow check (db ping + version) |
| `GET /api/health` | admin deep report (per component) |

Tune log verbosity with `LOG_LEVEL` / `LOG_FORMAT` in `.env`. To export traces to your own
collector, set `OTEL_EXPORTER_OTLP_ENDPOINT` (off by default).
