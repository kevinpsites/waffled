---
title: Quick start
description: Install Waffled with two containers and one command, then open it in your browser.
---

Waffled runs as two Docker containers, the `waffled` app and Postgres, started from a single
`compose.yaml`. Auth is built in; no Auth0 or external identity provider is required. You can
attach your own SSO later (optional).

## Requirements

- **Docker** with the **Compose v2.24 or newer** plugin (`docker compose`, not the legacy
  `docker-compose`). ~2 GB RAM is comfortable.
- That's it: no host toolchain, no `.env`, no API keys, no domain.

New to self-hosting? Install **Docker Desktop**, open it, and wait until it says Docker is
running. Then open **Terminal** on macOS/Linux, or **Git Bash/WSL** on Windows.

## Install

```bash
mkdir waffled && cd waffled
curl -fsSLO https://raw.githubusercontent.com/evan-ribbey/waffled-ng/main/compose.yaml
docker compose up -d
```

That's the whole install. On first start the app creates its own signing and encryption keys,
applies the database schema, and begins serving. Open **http://localhost:8080** and check it
worked with:

```bash
docker compose ps
```

Both `waffled` and `postgres` should show as running (healthy). If the browser doesn't open
the app, look at `docker compose logs waffled` and the
[troubleshooting guide](/operations/troubleshooting/). Do not delete Docker volumes to retry;
`docker compose down` safely stops the app without deleting data.

> **Coming from the old `./waffled` install?** Follow
> [Migrating from the ./waffled CLI](/install/migrating-from-waffled-cli/) instead; your data
> comes along.

## First-run setup

On first load you get a **setup wizard**:

1. Enter a **household name** + **timezone**.
2. Create your **admin account** (name, email, password — min 8 chars).

That's it — you're in. The admin account is the household owner.

![The Waffled Today dashboard after setup, showing the family calendar, chores, dinner, pantry and countdowns](/screenshots/today.png)

## Adding family members

**Settings → Family & People → Add a person** creates a profile (name, avatar, color).
To let someone sign in, open their card and use the **Login** section:

- Give them an **email** (+ optional password). With a password they sign in with the form.
- **Email-only** members can sign in via SSO once OIDC is configured (invite-gated).

The owner login is protected; removing a login revokes that person's sessions.

## Optional: AI "Add anything" + meal/recipe AI

Set one of these in `.env` beside `compose.yaml`, then run `docker compose up -d` (keys live only on the server):

- `ANTHROPIC_API_KEY` — Claude
- `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) — OpenAI-compatible
- `OLLAMA_HOST` — a local model (e.g. `llama3.1:8b`)

Then choose the active provider/model per household in **Settings → AI & Capture**. With
nothing set, capture still works via an on-device heuristic.

> Note: small local models (e.g. `llama3.2:3b`) are loose; a 7–8B model or hosted Claude
> is meaningfully more reliable for parsing and recipe AI.

## Optional: two-way calendar sync (Google or Outlook)

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALENDAR_REDIRECT_URI` in the
env — or `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and `MS_CALENDAR_REDIRECT_URI` for
[Outlook / Microsoft 365](/administration/outlook-calendar/) — then connect per person in
**Settings → Calendars**. A household can mix both. Waffled pulls events on a ~5-minute poll
and pushes Waffled-authored events back.

Want a calendar on the wall without any of that? **Settings → Calendars → Calendar feeds**
subscribes to any published `.ics` / `webcal://` link (a school schedule, a sports team) with
no sign-in at all — read-only, refreshed every 15 minutes.

## Optional: single sign-on (OIDC)

Backend-mediated OIDC (auth-code + PKCE) against any OpenID-Connect provider (Authentik,
Keycloak, Google, …), configured in **Settings → Login & security** (admin only). It's
**invite-gated**: a person can sign in via SSO only if the provider's *verified email*
matches a family member's login email.

1. Ensure `TOKEN_ENCRYPTION_KEY` is set (the client secret is encrypted at rest).
2. Enter the **Issuer URL** and click **Test** (validates the discovery document).
3. Enter **Client ID** + **Client secret** from an OIDC app at your provider.
4. Register the redirect URI at the provider: `https://your.host/api/auth/oidc/callback`
   (or `http://localhost:8080/...` locally).
5. Toggle **Single sign-on** on → **Save**. Optionally disable password login to force SSO
   (guarded so you can't lock yourself out; `AUTH_FORCE_PASSWORD=1` is a break-glass override).

## Accessing it from other devices

On the same network, open `http://<host-ip>:8080` on the tablet or phone. (Reserve a static IP
for the host in your router so bookmarks don't drift.) For a hostname or HTTPS, put a reverse
proxy in front and set `PUBLIC_BASE_URL` and `TRUST_PROXY=true` in `.env`; see
[Reverse proxy & TLS](/install/reverse-proxy/). Installing the web app to a phone's home
screen is covered in [Phone & PWA](/features/mobile/).

## Health, backups, and upgrades

- **Check it's healthy:** `docker compose ps`, or **Settings → System Health** in the app.
- **Backups** are opt-in: `docker compose --profile backup up -d` and `BACKUP_ENABLED=true`
  in `.env`. See [Backup & restore](/operations/backup/) to point them at a folder or S3, and
  to restore.
- **Upgrading:** `docker compose pull && docker compose up -d`. Migrations run on start. The
  app also flags **"Update available"** in Settings → System Health when you're behind. Full
  details: the [upgrading guide](/operations/upgrading/). **Stuck?**
  [Troubleshooting](/operations/troubleshooting/).

## Kiosk mode (the always-on tablet)

Open `http://<host>:8080` on the tablet in fullscreen/PWA mode. Pair the device once in
**Settings → Display & Kiosk** to get a Netflix-style **profile picker** (tapping a
profile mints a real, person-scoped session with optional **PIN**). Single-login (no
pairing) is the default. The kiosk drops into an ambient **screensaver** after an idle
timeout (clock + weather, or a photo slideshow).
