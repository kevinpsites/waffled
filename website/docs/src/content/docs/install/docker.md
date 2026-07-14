---
title: Docker install
description: Install and run Waffled with Docker Compose — the stack, the CLI, and first run.
---

Waffled is a Docker Compose stack driven by a small `./waffled` wrapper script. This page is the
reference for *what* gets installed and how the pieces fit; for the shortest path, the
[Quick start](/getting-started/quick-start/) is the two-command version.

## Install in three commands

```bash
git clone https://github.com/kevinpsites/waffled.git waffled && cd waffled
./waffled setup   # recommended if a tablet/phone/other computer will connect
./waffled up      # preflight → create .env → pull images → migrate → start
```

Open the address it prints — **`http://localhost:8080`** by default — and complete the
[first-run wizard](#first-run).

## What `./waffled up` does on first run

1. **Creates `infra/compose/.env`** from `.env.example`, generating `LOCAL_JWT_SECRET`,
   `TOKEN_ENCRYPTION_KEY`, `POWERSYNC_JWT_PRIVATE_KEY`, and `POSTGRES_PASSWORD` for you
   (via `openssl`). Missing values in an existing `.env` are filled without changing custom values.
2. **Pulls the prebuilt multi-arch images** (`api`, `caddy`, `backup`) from GHCR, pinned to
   `WAFFLED_VERSION`, plus stock Postgres and PowerSync. Prefer source? `./waffled up --build`.
3. **Runs a one-shot `migrate` service** to apply the schema — including the PowerSync
   replication publication — *before* api and PowerSync start.
4. **Starts everything**, prints a health table, and tells you which URL to open.

## The stack

Compose project `waffled`. Startup order: `postgres → api → powersync → caddy → backup`.

| Service | Image | What it does |
|---|---|---|
| **postgres** | `postgres:16` | The app database. Runs with logical replication enabled (`wal_level=logical`) so PowerSync can mirror it. |
| **migrate** | `waffled-api` | One-shot; applies migrations then exits. Idempotent — re-runs safely on every `up`/upgrade. |
| **api** | `waffled-api` | The Node/TypeScript backend. Serves `/api/*`, mints PowerSync tokens, writes media, runs background jobs. Health at `/healthz`. |
| **powersync** | `journeyapps/powersync-service` | The offline-sync engine. Replicates the app DB to per-household buckets; iOS + the kiosk calendar sync against it. |
| **caddy** | `waffled-caddy` | Reverse proxy **and** web server — the React SPA is baked into this image. Proxies `/api/*` → api, serves `/media/*`, SPA fallback. |
| **backup** | `waffled-backup` | Nightly `pg_dump` sidecar (on by default). Local + optional S3, optional media. Records every run for the health check. |
| **lgtm** *(optional)* | `grafana/otel-lgtm` | All-in-one Grafana/Prometheus/Tempo/Loki. Only with `./waffled observability up`. |

The web app and the kiosk are the **same build** served by Caddy — the kiosk is a fullscreen/PWA
layout mode of the React SPA, not a separate program.

## The `./waffled` CLI

`./waffled` wraps `docker compose` against `infra/compose/`. The commands you'll actually use:

| Command | What it does |
|---|---|
| `./waffled up [--build] [svc]` | Start (or update) the stack. Pulls images by default; `--build` builds from source. |
| `./waffled setup` | Interactive: how will devices reach this server? (localhost / LAN IP / hostname). |
| `./waffled status` | Per-container up/health table. |
| `./waffled down` | Stop the stack (keeps volumes). |
| `./waffled restart [svc]` | Restart all, or one service. |
| `./waffled logs [svc]` | Follow logs (`postgres` / `api` / `powersync` / `caddy` / `backup`). |
| `./waffled upgrade` | One-command update — see [Upgrading](/operations/upgrading/). |
| `./waffled backup [list]` | Back up now / list dumps. See [Backup & restore](/operations/backup/). |
| `./waffled restore <file>` | Restore a dump (**destructive**). |
| `./waffled doctor` | Deep per-component health report; non-zero exit if degraded. |
| `./waffled psql` | Open a psql shell on the database. |
| `./waffled admin <cmd>` | Break-glass operator commands (reset a password, grant admin…). |
| `./waffled migrate` | Re-apply migrations from the host. |
| `./waffled observability up\|down` | Bring the optional Grafana stack up/down. |

`./waffled admin` and `./waffled restore` run *inside* the containers with direct DB access — the
security model is that physical/SSH access to the host equals trust.

## First run

On first load, the app shows a **setup wizard**:

1. Enter a **household name** and **timezone**.
2. Create the **first admin account** (name, email, password — min 8 chars). This account is the
   household owner.

That's it — you're in. Next steps:

- Add the rest of the family → [Users & members](/administration/users/).
- Set up the kitchen tablet → [Kiosk & devices](/administration/kiosk/).
- Turn on optional features → [Modules](/administration/modules/).

## Image source

By default `./waffled up` **pulls** the prebuilt images pinned to `WAFFLED_VERSION` in
`infra/compose/.env`. Alternatives:

- **Build from source** (dev / bleeding-edge): `./waffled up --build` — stamps the current git SHA
  into `/healthz`.
- **Pin a custom registry/tag**: set `WAFFLED_API_IMAGE` / `WAFFLED_CADDY_IMAGE` /
  `WAFFLED_BACKUP_IMAGE` in `.env` (these override `WAFFLED_VERSION`).

Images are published to GHCR by CI on every `vX.Y.Z` release tag. See
[Upgrading](/operations/upgrading/) for how versioning works.

## Next

- [Environment variables](/install/environment-variables/) — the full config reference.
- [Reverse proxy & TLS](/install/reverse-proxy/) — access from other devices, hostnames, HTTPS.
