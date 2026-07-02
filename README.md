# Kinnook — Family Hub

A shared family operating system rendered across three surfaces:

- **Counter Kiosk** — always-on tablet (1280×800), full read/write, ambient display. Runs as the web app in fullscreen/PWA mode.
- **iOS app** — native Swift/SwiftUI capture companion. Offline-first (read + write).
- **Web app** — full management/setup dashboard. Static SPA served by Caddy (same build as the kiosk).

One household, one source of truth: calendar (2-way Google sync), chores & stars,
goals & rewards, meals & recipes, lists, photos, and an AI "Add anything" capture bar.

## Repo layout

```
infra/
  compose/     self-hosted runtime (Postgres, PowerSync, api, Caddy)
apps/
  api/         backend (lambda-api); calendar sync runs in-process (5-min scheduler)
  web/         React SPA — also the kiosk layout (same build, fullscreen/PWA mode)
  ios/         native Swift app
docs/          ARCHITECTURE.md, DATA_MODEL.md, TESTING.md, product/ (user docs)
```

## Self-hosting (quickstart)

Kinnook runs as a small Docker Compose stack (Postgres · PowerSync · api · Caddy). Auth
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

`./nook up` runs a **preflight** first (Docker present + running, Compose v2, free ports)
and, once up, prints the exact URL to open. Open the kiosk at `http://localhost:8080`. On
first load you'll get a **setup wizard**: enter a household name + timezone and create
your **admin account** (name, email, password). That's it — you're in.

> **Using it from a tablet or the iOS app?** Run `./nook setup` before `./nook up` — one
> question (localhost / your LAN IP / a hostname), auto-detects your IP, and writes the
> address settings so off-device sync works (a `localhost` sync URL is the usual "shows
> Offline on the tablet" trap).

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
`.github/workflows/publish-images.yml` GitHub Action **when you cut a release** —
`git tag v0.1.0 && git push origin v0.1.0` — which builds the `v0.1.0` / `0.1` /
`latest` tags (or trigger it manually from the Actions tab for an `sha-…` test build).
No extra setup beyond the repo's default `GITHUB_TOKEN`.

> For anything other than `localhost`, set `PUBLIC_BASE_URL=https://your.host` so
> redirect URLs (calendar + OIDC callbacks) are generated correctly.

### Adding family members

Settings → **Family & people** → *Add a person* creates a profile. To let someone
sign in, open their card and use the **Login** section: give them an email (+ optional
password). Email-only members can sign in via SSO once OIDC is configured.

### Single sign-on (OIDC) — optional

Kinnook supports backend-mediated OIDC (auth-code + PKCE) against any OpenID-Connect
provider (Authentik, Keycloak, Google, …). It's **invite-gated**: a person can only
sign in via SSO if the provider's *verified email* already matches a family member's
login email. Configure it in **Settings → Login & security** (admin only):

1. Ensure `TOKEN_ENCRYPTION_KEY` is set (the client secret is encrypted at rest).
2. **Issuer URL** — your provider's discovery base, e.g.
   `https://accounts.google.com` or `https://auth.example.com/application/o/nook/`.
   Click **Test** to confirm Kinnook can reach its discovery document.
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

**iOS app (native SSO):** the same SSO config drives the mobile app — there's
**nothing extra to register at the provider**. The flow is backend-mediated, so Google
(or any IdP) only ever sees your backend's `/api/auth/oidc/callback`, never the app's
`nook://auth/callback` deep link (the backend appends the one-time handoff code to that
deep link itself; the app intercepts it via `ASWebAuthenticationSession`). The "Sign in
with …" button appears in the app automatically whenever `GET /api/auth/status` reports
OIDC is ready. Two things to get right:
- The redirect URI Kinnook sends to the IdP is derived from the host the request arrives
  on, so the address your **device** uses to reach the API must have a matching
  `/api/auth/oidc/callback` in the provider's *Authorized redirect URIs*. The simulator
  reaches `localhost:8080` (already covered); a physical phone reaches your LAN IP or
  public host. **Set `PUBLIC_BASE_URL`** to pin one stable callback regardless of how the
  device connects, then register just that one.
- Point the app at the right server on the login screen's **Server address** field if it
  isn't the default.

### Operator commands (`./nook admin`)

Break-glass / recovery commands for when the web UI can't help — e.g. the only admin
is locked out, SSO is misconfigured, or a Google token died. They run **inside the api
container** (`docker exec nook-api node dist/admin.js …`), so they reach the database
and the encryption key directly with **no login or admin token required** — physical/SSH
access to the host *is* the authorization. Auth writes go through the same scrypt hashing
and credential→identity wiring the API uses, so there's one source of truth.

```bash
./nook admin help                      # list every command
./nook admin list-members              # people, login email, admin/owner, password/SSO
```

| Command | What it does |
| --- | --- |
| `list-members` | List everyone with their login email, admin/owner status, and whether they have a password and/or SSO identity. |
| `reset-password --email <e> [--password <pw>]` | Set a member's password by login email (the headline use case: locked-out admin, no SSO). Generates a strong one and prints it if `--password` is omitted, and revokes their active sessions **across all of their households**. |
| `add-member --email <e> --household-id <uuid> [--member-type adult\|teen\|kid] [--admin]` | Attach an **existing** account to another household directly — the break-glass alternative to the web Households → invite-and-accept flow. The account must already exist (the human has signed in at least once); idempotent if they're already a member. |
| `list-accounts` | List each human (account) and every household they belong to, with an owner/admin/member marker. |
| `make-admin (--email <e> \| --person <uuid>)` | Grant admin. |
| `revoke-admin (--email <e> \| --person <uuid>)` | Revoke admin (the household owner can't be demoted). |
| `password-login <on\|off>` | Enable/disable email+password login (the DB toggle mirrored in Settings → Login & security). |
| `clear-calendar-error (--email <e> \| --all)` | Clear a stuck Google account's "sync failing" flag. (The token itself is fixed by **Reconnect** in Settings → Calendars — a browser OAuth step the CLI can't do.) |
| `prune-sessions [--email <e>]` | Revoke refresh tokens for one member (**across all of their households**), or everyone — forces re-login. |
| `regenerate-powersync-key` | Print a fresh `POWERSYNC_JWT_PRIVATE_KEY` (RSA-2048) to paste into `.env`, then `./nook restart api powersync`. |
| `list-households` | List every household with its member + login counts, created date, and id. |
| `delete-household --id <uuid> [--force]` | Permanently delete a household and **all** of its data (handy for clearing test debris). Refuses a household that has logins unless you add `--force`. |

Destructive commands (`reset-password`, `clear-calendar-error`, `prune-sessions`,
`delete-household`) prompt for a `y` confirmation; pass `--yes` to run them
non-interactively (e.g. over plain SSH).

> **Hard lockout, no admin at all?** If password login is off and SSO is broken, set
> `AUTH_FORCE_PASSWORD=1` in the api env and restart — that forces the password form
> back on regardless of the DB toggle — then `./nook admin reset-password …` to get in.

## Start here

1. Run it — the [Self-hosting quickstart](#self-hosting-quickstart) above (`./nook up`).
2. Read `docs/ARCHITECTURE.md` — the decisions and why.
3. Read the docs site (built from `website/`, Astro Starlight) — the user-facing docs and the feature matrix (source: `website/src/content/docs/reference/features.md`).
4. Follow `ROADMAP.md` — bite-sized, committable chunks, in order.

> Only setting up Google Calendar sync or OIDC? `BOOTSTRAP.md` has the Google Cloud
> OAuth-client walkthrough (skip its Auth0/AWS/Terraform framing — those were dropped
> with the self-host pivot).

## The stack in one breath

Self-hosted Docker Compose · Postgres system-of-record · PowerSync for iOS (and the
kiosk's calendar) offline · **built-in email/password auth + optional OIDC SSO** (no
Auth0) · Google Calendar authoritative for Google-origin events, Kinnook authoritative for
native fields · ~5-min in-process calendar sync (no separate worker) · Caddy serves the
SPA + `/media` and can do public ingress (auto-TLS or a Cloudflare Tunnel) · everything
in this one repo.

## License

Kinnook is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). See
[LICENSE](LICENSE). In short: you're free to self-host, study, modify, and share it — but
if you run a modified version as a network service, you must make your source available to
its users under the same license.
