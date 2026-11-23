---
title: Requirements
description: What you need to run a self-hosted Waffled.
---

The bar to run Waffled is deliberately low: no host toolchain, no cloud account, no
generated secrets to manage.

## Host

- **Docker** with the **Compose v2.24 or newer** plugin (`docker compose`, *not* the legacy
  `docker-compose`). This is the only hard requirement. Check with `docker compose version`.
- **An always-on machine.** Waffled is a hub: the value is that the kitchen tablet and the
  family's phones can reach it whenever. An old laptop, a mini-PC/NUC, a home server, a
  Mac, or a Raspberry Pi all work.
- **~2 GB RAM** is comfortable for two containers (the app and Postgres).

## Architecture

The published images are **multi-arch (`amd64` + `arm64`)**, so Waffled runs on:

- A regular x86 machine or server.
- An ARM single-board computer, such as a Raspberry Pi (64-bit OS), or an Apple silicon Mac
  running Docker Desktop.

You don't pick an image for your arch; Docker pulls the right one automatically.

## Ports

| Port | Service | Notes |
|---|---|---|
| `8080` | The `waffled` app (web, kiosk, API) | The address you open. Change it with `HTTP_PORT` in `.env`. |

Postgres is **not** published to the host; it is only reachable on the Docker network. If
`8080` is already in use, set `HTTP_PORT` to something else.

## Storage

Persistent state lives in **named Docker volumes**. Size depends on your photos and how long
you keep backups:

- `waffled_pgdata`: the Postgres database. **Never wipe.**
- `waffled_waffled_media`: uploaded photos, recipe images, chore proofs. **Never wipe.**
- `waffled_waffled_data`: the app's generated secrets (`/data/secrets.json`). **Never wipe.**
- `waffled_waffled_backups`: database dumps, only when you enable the backup profile (can
  point at a host folder or S3 instead).

> **Never `docker volume rm` or `docker compose down -v`.** The database holds *encrypted*
> Google/Outlook/OIDC tokens that can't be recovered without the key in `waffled_data`; losing
> either one means re-linking. See [Backup & restore](/operations/backup/).

## What you don't need

- **No Node or build toolchain on the host.** The image ships ready to run.
- **No external identity provider.** Email/password auth is built in; SSO is optional.
- **No AI subscription.** The capture bar works with an on-device heuristic; AI providers are
  opt-in.
- **No paid cloud anything.** Google / Outlook calendar sync and offsite S3 backups are optional.

Ready? Go to the [Docker install](/install/docker/).
