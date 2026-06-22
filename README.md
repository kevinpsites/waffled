# Nook — Family Hub

A shared family operating system rendered across three surfaces:

- **Counter Kiosk** — always-on tablet (1280×800), full read/write, ambient display. Runs as the web app in fullscreen/PWA mode.
- **iOS app** — native Swift/SwiftUI capture companion. Offline-first (read + write).
- **Web app** — full management/setup dashboard. Static SPA on S3 + CloudFront.

One household, one source of truth: calendar (2-way Google sync), chores & stars,
goals & rewards, meals & recipes, lists, photos, and an AI "Add anything" capture bar.

## Repo layout

```
infra/
  terraform/   AWS + Auth0 as code
  compose/     self-hosted runtime (Postgres, PowerSync, api, worker, Caddy, backup)
apps/
  api/         backend (lambda-api), shares image with worker
  worker/      calendar sync, cron, recurring chores, recap, APNs
  web/         React SPA (also the kiosk layout)
  kiosk/        kiosk PWA shell (thin wrapper over web)
ios/           native Swift app
packages/      shared types + design tokens
docs/          ARCHITECTURE.md (decision record)
```

## Self-hosting (quickstart)

Nook runs as a small Docker Compose stack (Postgres · PowerSync · api · Caddy). Auth
is **built in** — no Auth0 or external identity provider required. You can optionally
attach your own SSO later (see below).

```bash
git clone <this-repo> nook && cd nook
./nook up    # creates .env (with generated secrets), builds images, migrates, starts the stack
```

That single command is the whole install — no host toolchain, no separate migrate
step. On first run `./nook up`:

1. creates `infra/compose/.env` from `.env.example`, generating `LOCAL_JWT_SECRET`,
   `TOKEN_ENCRYPTION_KEY`, and `POSTGRES_PASSWORD` for you (existing `.env` left alone),
2. builds the `api` + `caddy` images and pulls Postgres + PowerSync,
3. runs the one-shot **migrate** service to apply the database schema (so PowerSync's
   replication publication exists before it starts), then
4. starts everything and prints a health table.

Open the kiosk at `http://localhost:8080`. On first load you'll get a **setup wizard**:
enter a household name + timezone and create your **admin account** (name, email,
password). That's it — you're in.

### `.env`

`./nook up` writes a working `infra/compose/.env` for you; you only edit it to enable
optional integrations or to run somewhere other than `localhost`. The required values
are the three generated secrets plus the `POSTGRES_*` settings. Optional (leave blank
to skip): `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_HOST` for the AI capture
bar, and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALENDAR_REDIRECT_URI`
for 2-way Google Calendar sync. See the comments in `.env.example` for the full list
(session lifetimes, ports, published-image overrides).

### Pre-built images (optional)

The compose stack builds `api` + `caddy` from source by default (tagged
`nook-api:local` / `nook-caddy:local`). To skip the local build and run from the
registry instead, point the image overrides at the published GHCR tags and pull:

```bash
# in infra/compose/.env
NOOK_API_IMAGE=ghcr.io/<owner>/nook-api:latest
NOOK_CADDY_IMAGE=ghcr.io/<owner>/nook-caddy:latest
```

```bash
docker compose -f infra/compose/docker-compose.yml --env-file infra/compose/.env pull
./nook up
```

Both images are multi-arch (amd64 + arm64), so they run on a regular x86 box or an
ARM SBC (e.g. a Raspberry Pi). They're published by the
`.github/workflows/publish-images.yml` GitHub Action on every push to `main` and on
`v*` tags — no extra setup beyond the repo's default `GITHUB_TOKEN`.

> For anything other than `localhost`, set `PUBLIC_BASE_URL=https://your.host` so
> redirect URLs (calendar + OIDC callbacks) are generated correctly.

### Adding family members

Settings → **Family & people** → *Add a person* creates a profile. To let someone
sign in, open their card and use the **Login** section: give them an email (+ optional
password). Email-only members can sign in via SSO once OIDC is configured.

### Single sign-on (OIDC) — optional

Nook supports backend-mediated OIDC (auth-code + PKCE) against any OpenID-Connect
provider (Authentik, Keycloak, Google, …). It's **invite-gated**: a person can only
sign in via SSO if the provider's *verified email* already matches a family member's
login email. Configure it in **Settings → Accounts & security** (admin only):

1. Ensure `TOKEN_ENCRYPTION_KEY` is set (the client secret is encrypted at rest).
2. **Issuer URL** — your provider's discovery base, e.g.
   `https://accounts.google.com` or `https://auth.example.com/application/o/nook/`.
   Click **Test** to confirm Nook can reach its discovery document.
3. **Client ID** + **Client secret** from an OIDC app you register at the provider.
4. Register this **redirect URI** at the provider:
   `https://your.host/api/auth/oidc/callback` (use `http://localhost:8080/...` locally).
5. Toggle **Single sign-on** on → **Save SSO settings**. Optionally turn off password
   login to force SSO (only allowed once OIDC is saved, so you can't lock yourself out;
   set `AUTH_FORCE_PASSWORD=1` in the env as a break-glass override).

**Reusing your Google Calendar OAuth client for sign-in:** yes — a single Google Cloud
"Web application" OAuth client works for both. Add the OIDC callback above to that
client's *Authorized redirect URIs* (alongside the calendar one), set the issuer to
`https://accounts.google.com`, and reuse the same client ID/secret. The sign-in scopes
(`openid email profile`) are non-sensitive, so no extra Google verification is needed.

## Start here

1. Read `docs/ARCHITECTURE.md` — the decisions and why.
2. Work `BOOTSTRAP.md` — one-time console setup (Google, Apple, Auth0, AWS) that produces the secrets IaC consumes.
3. Follow `ROADMAP.md` — bite-sized, committable chunks, in order.

## The stack in one breath

Self-hosted Docker Compose now (portable to managed later via env swap) · Postgres
system-of-record · PowerSync for iOS offline · Auth0 for identity (Google + Apple) ·
Google Calendar authoritative for Google-origin events, Nook authoritative for native
fields · 2–5 min calendar polling · Tailscale ingress now, public ingress when we
onboard non-household users · Terraform + Compose, everything in this repo.
