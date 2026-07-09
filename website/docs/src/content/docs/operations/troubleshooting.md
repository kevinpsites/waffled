---
title: Troubleshooting
description: Symptom → diagnosis → fix for common self-hosted Waffled issues.
---

Practical fixes for a self-hosted Waffled. Each entry is **symptom → diagnosis → fix**.

## Run `./waffled doctor` first

`./waffled doctor` is a deep, in-container health report (db, migrations, jobs,
calendar, storage, backup) and **exits non-zero when anything is degraded or down**.
It almost always tells you which component is unhappy before you start guessing. The
same data is in **Settings → System Health** and `GET /api/health` (admin). For a
quick liveness check without auth, `GET /healthz` (public: db ping + version).

Then dig into logs for the flagged service: `./waffled logs <svc>` (`postgres`, `api`,
`powersync`, `caddy`, `backup`).

## Quick index

| Symptom | Jump to |
|---|---|
| DB check down / can't connect | [Postgres unreachable](#postgres-unreachable) |
| "schema behind" / migrations pending | [Migrations pending](#migrations-pending) |
| All clients show an **Offline** banner | [PowerSync offline](#powersync-offline-banner) |
| Calendars stale / sync failing / `push_failed` | [Google Calendar sync](#google-calendar-sync-failing) |
| Photo/recipe uploads fail / storage degraded | [Media uploads failing](#media-uploads-failing) |
| Backup health degraded / stale | [Backups failing](#backups-failing-or-stale) |
| Can't reach the app / TLS errors | [Can't reach the app](#cant-reach-the-app--tls) |
| Locked out / forgot admin password | [Locked out](#locked-out--forgot-admin-password) |

---

### Postgres unreachable

**Symptom:** `./waffled doctor` db check is **down**; api won't start or 500s
everywhere; `/healthz` fails.

**Diagnose:** `./waffled logs postgres` and `./waffled status` — is the `postgres`
container up and **healthy**? Common causes: container still starting, out of disk,
or a bad shutdown.

**Fix:** wait for the health check to pass; if it's crash-looping, read the postgres
logs. `./waffled restart postgres` (then `api`, `powersync`). **Never** `docker volume
rm pgdata` — that destroys all data (see the never-wipe warning in the
[upgrading guide](/operations/upgrading/)). If the volume is genuinely corrupt, restore from a
backup (see [Backup & restore](/operations/backup/)).

### Migrations pending

**Symptom:** health report flags **"schema behind"** (applied migration count <
available count); new features missing or erroring after an upgrade.

**Diagnose:** `./waffled doctor` shows applied vs available migration counts.

**Fix:**

```bash
./waffled migrate      # re-run migrations (idempotent); or ./waffled up
```

Migrations normally auto-run on `up` via the one-shot `migrate` service; run
`./waffled migrate` directly if you only need to apply them without a full restart.

### PowerSync "Offline" banner

**Symptom:** **every** client (iOS + kiosk web) shows an **Offline** banner; logs
show `PSYNC_S2101` signature failures.

**Diagnose (this is almost always it):** `POWERSYNC_JWT_PRIVATE_KEY` is empty in
`infra/compose/.env`. When it's empty, the api generates a fresh signing key **on
every restart** — PowerSync then rejects the api-issued JWTs (`PSYNC_S2101`) and all
clients drop offline. Check `./waffled logs powersync` for the signature error and
grep the env for an empty key.

**Fix:** set a **stable** value:

```bash
# in infra/compose/.env — set once, never rotate
POWERSYNC_JWT_PRIVATE_KEY=<stable base64 key>
```

Then restart PowerSync to pick it up and re-validate:

```bash
./waffled restart powersync     # unstick waffled-powersync
```

**Also check `POWERSYNC_PUBLIC_URL`** — it must be the address clients actually use
to reach PowerSync (e.g. your LAN IP / hostname, not `localhost`). A mismatch also
manifests as clients that can't sync.

### Google Calendar sync failing

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

### Media uploads failing

**Symptom:** photo / recipe-image / chore-proof uploads fail; health `storage`
degraded; images 404 or won't save.

**Diagnose:** the `waffled_media` volume isn't writable, or `MEDIA_DIR` points
somewhere the api can't write. `./waffled logs api` will show the write error.

**Fix:** confirm the `waffled_media` volume is mounted and writable and that
`MEDIA_DIR` is correct; check host disk space. **Do not** delete or recreate
`waffled_media` — uploaded blobs live there and are irreplaceable.

### Backups failing or stale

**Symptom:** health **`backup`** line is **degraded** (last backup failed, or newest
success is older than ~48 h).

**Diagnose:** `./waffled logs backup`. Usual causes: out of disk space, or bad
`BACKUP_S3_*` credentials / endpoint when offsite copy is enabled.

**Fix:** free disk space, or fix the S3 creds/endpoint in `infra/compose/.env`, then
`./waffled up` to recreate the backup service. Run `./waffled backup` to confirm a manual
run succeeds. Full config in [Backup & restore](/operations/backup/).

### Can't reach the app / TLS

**Symptom:** browser can't connect, or TLS/certificate errors.

**Diagnose:** this is the **Caddy** layer. `./waffled logs caddy`.

**Fix:**

- **Local access is plain HTTP** on the mapped port — use `http://<host>:<port>`, not
  `https://`. Don't expect a valid cert locally.
- **For a real hostname:** set `CADDY_SITE_ADDRESS` to your domain in
  `infra/compose/.env` and enable the **443** port mapping so Caddy can serve HTTPS
  (and, for public domains, provision a cert). Then `./waffled up`.

### Locked out / forgot admin password

**Symptom:** no one can sign in as an admin.

**Fix (break-glass, from the host):**

```bash
./waffled admin reset-password        # reset a member's password
./waffled admin make-admin            # grant admin to a member
./waffled admin list-members          # see who exists
./waffled admin prune-sessions        # invalidate active sessions if needed
```

---

## Where to look, at a glance

| Tool | What it gives you |
|---|---|
| `./waffled doctor` | deep per-component health; non-zero exit when degraded/down |
| `./waffled status` | which services are up / healthy |
| `./waffled logs <svc>` | logs for `postgres` / `api` / `powersync` / `caddy` / `backup` |
| **Settings → System Health** | same report as `doctor`, in the UI |
| `GET /healthz` | public shallow check (db ping + version) |
| `GET /api/health` | admin deep report (per component) |

Tune log verbosity with `LOG_LEVEL` / `LOG_FORMAT` in `infra/compose/.env`. For
metrics/traces, `./waffled observability up` brings up local Grafana (optional
`observability` profile); set `OTEL_EXPORTER_OTLP_ENDPOINT` to export traces (off by
default).
