# Quick start

Nook runs as a small Docker Compose stack — **Postgres · PowerSync · api · Caddy**. Auth
is built in; no Auth0 or external identity provider is required. You can attach your own
SSO later (optional).

## Requirements

- Docker + Docker Compose
- That's it — no host toolchain (Node, etc.). Migrations and builds run in containers.

## Install

```bash
git clone <this-repo> nook && cd nook
./nook up    # creates .env (with generated secrets), builds images, migrates, starts the stack
```

That single command is the whole install. On first run, `./nook up`:

1. Creates `infra/compose/.env` from `.env.example`, generating `LOCAL_JWT_SECRET`,
   `TOKEN_ENCRYPTION_KEY`, and `POSTGRES_PASSWORD` for you (an existing `.env` is left alone).
2. Builds the `api` + `caddy` images and pulls Postgres + PowerSync.
3. Runs a one-shot **migrate** service to apply the database schema (so PowerSync's
   replication publication exists before it starts).
4. Starts everything and prints a health table.

Open the kiosk/web app at **http://localhost:8080**.

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

## Running somewhere other than localhost

Set `PUBLIC_BASE_URL=https://your.host` so calendar/OIDC redirect URLs are generated
correctly. For exposing beyond the LAN, Caddy can do auto-TLS (`CADDY_SITE_ADDRESS`) or
put a Cloudflare Tunnel in front.

## Pre-built images (optional)

The stack builds `api` + `caddy` from source by default. To pull from GHCR instead, set
the overrides in `infra/compose/.env` and pull:

```bash
NOOK_API_IMAGE=ghcr.io/<owner>/nook-api:latest
NOOK_CADDY_IMAGE=ghcr.io/<owner>/nook-caddy:latest
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
