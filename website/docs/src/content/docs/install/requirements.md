---
title: Requirements
description: What you need to run a self-hosted Waffled.
---

Waffled runs as a small Docker Compose stack. The bar to run it is deliberately low — no host
toolchain, no cloud account.

## Host

- **Docker** with the **Compose v2** plugin (`docker compose`, *not* the legacy
  `docker-compose`). This is the only hard requirement. `./waffled up` runs a **preflight** that
  fails clearly (with fix links) if Docker is missing, the daemon is off, or Compose v2 isn't
  installed.
- **An always-on machine.** Waffled is a hub — the value is that the kitchen tablet and the iOS
  app can reach it whenever. An old laptop, a mini-PC/NUC, a home server, or a Raspberry Pi all
  work.
- **~4 GB RAM** is comfortable (Postgres + PowerSync + api + Caddy). It runs in less, but give it
  room if you also enable the optional observability stack.
- **`openssl`** (recommended, usually already present). On first run Waffled uses it to generate
  your secrets automatically. Without it, you set those secrets by hand.
- **`git`** to clone the repo and to `./waffled upgrade` later.

## Architecture

The published images are **multi-arch (`amd64` + `arm64`)**, so Waffled runs on:

- A regular x86 machine or server.
- An ARM single-board computer — a Raspberry Pi (64-bit OS) is a common, tidy home for it.

You don't pick an image for your arch — Docker pulls the right one automatically.

## Ports

Defaults (all overridable in `infra/compose/.env`):

| Port | Service | Notes |
|---|---|---|
| `8080` | Caddy (web / kiosk) | The address you open. `HTTP_PORT`. |
| `3000` | api | Loopback-only diagnostics; clients use Caddy `/api/*`. `API_PORT`. |
| `8090` | Caddy → PowerSync | Offline-sync endpoint clients connect to. `POWERSYNC_PORT`. |
| `5432` | Postgres | Loopback-only local tools. `POSTGRES_PORT`. |
| `443` | Caddy (HTTPS) | **Commented out by default** — enable for hostname/TLS. |

The preflight warns (doesn't block) if `8080` / `3000` / `8090` / `5432` are already busy on a
cold start. Change any of them in `.env` if they collide with something else you run.

## Storage

Persistent state lives in **named Docker volumes** — there's no minimum stated, size depends on
your photos and how long you keep backups:

- `pgdata` — the Postgres database. **Never wipe.**
- `waffled_media` — uploaded photos, recipe images, chore proofs. **Never wipe.**
- `waffled_backups` — nightly database dumps (default target; can point at a host folder or S3).
- `caddy_data` / `caddy_config` — Caddy state, including any TLS certificates.

> **⚠️ Never `docker volume rm` or `docker compose down -v`.** `pgdata` and `waffled_media` are
> irreplaceable, and the database holds *encrypted* Google/OIDC refresh tokens that can't be
> recovered — only re-consented. See [Backup & restore](/operations/backup/).

## What you don't need

- **No Node / Xcode / build toolchain on the host** — migrations and image builds happen in
  containers.
- **No external identity provider.** Email/password auth is built in; SSO is optional.
- **No AI subscription.** The capture bar works with an on-device heuristic; AI providers are
  opt-in.
- **No paid cloud anything.** Google Calendar sync and offsite S3 backups are optional.

Ready? → [Docker install](/install/docker/).
