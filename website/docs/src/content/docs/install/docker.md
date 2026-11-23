---
title: Docker install
description: Install and run Waffled with Docker Compose — the two containers, the commands, and first run.
---

Waffled is two containers: one `waffled` app and Postgres. This page is the reference for
*what* gets installed and how to operate it; for the shortest path, the
[Quick start](/getting-started/quick-start/) is the three-command version.

## Install

You need Docker with **Compose v2.24 or newer**.

```bash
mkdir waffled && cd waffled
curl -fsSLO https://raw.githubusercontent.com/evan-ribbey/waffled-ng/main/compose.yaml
docker compose up -d
```

Open **`http://localhost:8080`** and complete the [first-run wizard](#first-run). There is no
`.env` to create, no secrets to generate, and no migrate step: the app creates its own keys
on first start and runs migrations before it begins serving.

Prefer to build from source? Clone the repo and run `docker compose up -d --build`.

## The stack

Compose project `waffled`. Startup order: `postgres`, then `waffled`.

| Service | Image | What it does |
|---|---|---|
| **waffled** | `ghcr.io/evan-ribbey/waffled` | The whole app: serves the web/kiosk SPA, `/api/*`, `/auth/*` and uploaded media at `/media/*`, runs migrations on start, and runs background jobs (calendar sync and so on). Health at `/healthz`. |
| **postgres** | `postgres:16` | The app database. Not published to the host. |
| **backup** *(optional)* | `ghcr.io/evan-ribbey/waffled-backup` | Nightly `pg_dump`. Only with `--profile backup`. Local + optional S3, optional media. |

The web app and the kiosk are the **same build**: the kiosk is a fullscreen/PWA layout mode of
the React SPA, not a separate program.

On first start the app writes `LOCAL_JWT_SECRET` and `TOKEN_ENCRYPTION_KEY` to
`/data/secrets.json` in the `waffled_data` volume and reuses them. A value you set in `.env`
always wins.

## Changing settings

Every setting is optional. Copy [`.env.example`](https://github.com/evan-ribbey/waffled-ng/blob/main/.env.example)
to `.env` **in the same folder as `compose.yaml`**, uncomment what you need, then run
`docker compose up -d` again. Settings must live in that file: variables exported in your
shell do not reach the containers. Full list: [Environment variables](/install/environment-variables/).

## Everyday commands

Run these from the folder holding `compose.yaml`.

| Task | Command |
|---|---|
| Start / update | `docker compose up -d` |
| Status | `docker compose ps` |
| Logs | `docker compose logs -f waffled` |
| Stop (keeps data) | `docker compose down` |
| Restart the app | `docker compose restart waffled` |
| Upgrade | `docker compose pull && docker compose up -d` (see [Upgrading](/operations/upgrading/)) |
| Database shell | `docker compose exec postgres psql -U waffled waffled` |
| Admin commands | `docker compose exec -u node waffled node dist/admin.js <command>` |
| Demo data | `docker compose exec -u node -e WAFFLED_ALLOW_DEMO_SEED=1 waffled node dist/seed-demo.js base` (then `meals`, `goals`) |
| Start backups | `docker compose --profile backup up -d` |

The admin commands (reset a password, grant admin, list members, and so on) run *inside* the
container with direct database access. The security model is that shell access to the host
equals trust. Use `-u node` so any files written under `/data` stay owned by the app user. Run
`... dist/admin.js help` for the full list.

## First run

On first load, the app shows a **setup wizard**:

1. Enter a **household name** and **timezone**.
2. Create the **first admin account** (name, email, password, min 8 chars). This account is the
   household owner.

That's it, you're in. Next steps:

- Add the rest of the family: [Users & members](/administration/users/).
- Set up the kitchen tablet: [Kiosk & devices](/administration/kiosk/).
- Turn on optional features: [Modules](/administration/modules/).

## Next

- [Environment variables](/install/environment-variables/): the full config reference.
- [Reverse proxy & TLS](/install/reverse-proxy/): hostnames, HTTPS, other devices.
- [Coming from the old `./waffled` install?](/install/migrating-from-waffled-cli/)
