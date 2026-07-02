# Quick start

Nook runs as a small Docker Compose stack — **Postgres · PowerSync · api · Caddy**. Auth
is built in; no Auth0 or external identity provider is required. You can attach your own
SSO later (optional).

## Requirements

- **Docker** with the **Compose v2** plugin (`docker compose`, not the legacy
  `docker-compose`). ~4 GB RAM is comfortable.
- That's it — no host toolchain (Node, etc.). Migrations and builds run in containers.
- `./nook up` runs a **preflight** first and tells you (with fix links) if Docker is
  missing, the daemon is off, Compose v2 isn't installed, or a required port is busy.

## Install

```bash
git clone <this-repo> nook && cd nook
./nook up    # checks prereqs, creates .env (generated secrets), builds, migrates, starts
```

That single command is the whole install. On first run, `./nook up`:

1. Creates `infra/compose/.env` from `.env.example`, generating `LOCAL_JWT_SECRET`,
   `TOKEN_ENCRYPTION_KEY`, and `POSTGRES_PASSWORD` for you (an existing `.env` is left alone).
2. Builds the `api` + `caddy` images and pulls Postgres + PowerSync.
3. Runs a one-shot **migrate** service to apply the database schema (so PowerSync's
   replication publication exists before it starts).
4. Starts everything, prints a health table, and tells you **which URL to open**.

Open the kiosk/web app at the URL it prints — **http://localhost:8080** by default.

> **Going to use it from a tablet, phone, or another computer?** (Nook's whole point is
> an always-on tablet + the iOS app.) Run **`./nook setup`** *before* `./nook up` — it
> asks one question ("how will devices reach this server?"), auto-detects your machine's
> LAN IP, and writes the address settings so sync works off-device. Skipping this is the
> #1 cause of "everything shows Offline on the tablet" (a `localhost` sync URL other
> devices can't reach). See [Accessing it from other devices](#accessing-it-from-other-devices).

## First-run setup

On first load you get a **setup wizard**:

1. Enter a **household name** + **timezone**.
2. Create your **admin account** (name, email, password — min 8 chars).

That's it — you're in. The admin account is the household owner.

## Adding family members

**Settings → Family & people → Add a person** creates a profile (name, avatar, color).
To let someone sign in, open their card and use the **Login** section:

- Give them an **email** (+ optional password). With a password they sign in with the form.
- **Email-only** members can sign in via SSO once OIDC is configured (invite-gated).

The owner login is protected; removing a login revokes that person's sessions.

## Optional: AI "Add anything" + meal/recipe AI

Set one of these in `infra/compose/.env` (keys live only on the server):

- `ANTHROPIC_API_KEY` — Claude
- `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) — OpenAI-compatible
- `OLLAMA_HOST` — a local model (e.g. `llama3.1:8b`)

Then choose the active provider/model per household in **Settings → AI & capture**. With
nothing set, capture still works via an on-device heuristic.

> Note: small local models (e.g. `llama3.2:3b`) are loose; a 7–8B model or hosted Claude
> is meaningfully more reliable for parsing and recipe AI.

## Optional: two-way Google Calendar sync

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALENDAR_REDIRECT_URI` in the
env, then connect per person in **Settings → Calendars** ("Connect your calendar"). Nook
pulls events on a ~5-minute poll and pushes Nook-authored events back.

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

The easiest path is **`./nook setup`** — it asks how devices will reach the server and
writes the address settings for you:

- **Just this computer (localhost)** — the default; nothing to do.
- **Other devices on my network** — a tablet/phone/laptop on your LAN. `setup` detects
  this machine's IP and sets `POWERSYNC_PUBLIC_URL` + `PUBLIC_BASE_URL` to it, so the
  kiosk and iOS app can sync. Open `http://<ip>:8080` on the device. *(Reserve a static
  IP for this machine in your router so the address doesn't drift.)*
- **A hostname with automatic HTTPS** — `setup` sets `CADDY_SITE_ADDRESS` (Caddy
  auto-TLS) + `PUBLIC_BASE_URL`. Enable the `443` mapping in
  `infra/compose/docker-compose.yml`, point DNS at the machine, and (for remote sync)
  expose/proxy PowerSync's port with TLS too.

Prefer to edit by hand? The same three vars in `infra/compose/.env` do it:
`POWERSYNC_PUBLIC_URL` (the sync endpoint clients connect to — the common trap),
`PUBLIC_BASE_URL` (public origin for calendar/OIDC redirects), and `CADDY_SITE_ADDRESS`
(hostname for auto-TLS). Run `./nook up` after changing them.

## Health, backups, and upgrades

- **Check it's healthy:** `./nook doctor` (db, migrations, jobs, calendar, storage,
  backup) — or **Settings → System Health** in the app. Both show the same report.
- **Backups** run nightly out of the box; see [BACKUP.md](../BACKUP.md) to point them at
  a folder or S3, and to restore.
- **Upgrading:** [UPGRADING.md](../UPGRADING.md). **Stuck?**
  [TROUBLESHOOTING.md](../TROUBLESHOOTING.md).

## Pre-built images (optional)

The stack builds `api` + `caddy` from source by default. To pull from GHCR instead, set
the overrides in `infra/compose/.env` and pull:

```bash
NOOK_API_IMAGE=ghcr.io/<owner>/nook-api:latest
NOOK_CADDY_IMAGE=ghcr.io/<owner>/nook-caddy:latest
NOOK_BACKUP_IMAGE=ghcr.io/<owner>/nook-backup:latest
```

Images are multi-arch (amd64 + arm64), so they run on x86 or an ARM SBC (e.g. Raspberry
Pi). They're published by `.github/workflows/publish-images.yml` when you cut a release
tag (`git tag v0.1.0 && git push origin v0.1.0`).

## Kiosk mode (the always-on tablet)

Open `http://<host>:8080` on the tablet in fullscreen/PWA mode. Pair the device once in
**Settings → Display & Kiosk** to get a Netflix-style **profile picker** (tapping a
profile mints a real, person-scoped session with optional **PIN**). Single-login (no
pairing) is the default. The kiosk drops into an ambient **screensaver** after an idle
timeout (clock + weather, or a photo slideshow).
