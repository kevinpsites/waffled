# Waffled — Architecture Decision Record

A snapshot of the key architecture decisions and their rationale, so the "why" isn't lost.
Updated for the **self-hosted** model that shipped: the original cloud plan (Terraform/AWS,
Auth0, a separate `worker` service) was superseded by the self-host pivot — see the
"Dropped" section of the [product roadmap](./product/roadmap.md) for what changed and why.

## Surfaces

| Surface | Tech | Role | Network |
|---|---|---|---|
| Kiosk | React web app, fullscreen/PWA | always-on ambient display, full read/write | home LAN (+ tailnet) |
| Web / PWA | React SPA (served by the `waffled` app) | management/setup dashboard, phone capture | anywhere via ingress |

Kiosk and web share the same React codebase (kiosk = a layout/PWA mode); the `waffled`
image bakes in the built SPA and the api serves it (and `/media`) directly.

## Data

- **Postgres is the system of record.** The data is relational and aggregation-heavy
  (grocery dedup from meal plans, goal leaderboards, star ledgers) — Postgres fits; a
  key-value store (DynamoDB) does not (would force hand-maintained materialized counters +
  a custom realtime layer). This is the pivotal call: **Postgres over key-value**,
  independent of host.
- **No offline sync layer.** PowerSync and the native iOS/Mac apps were removed in 0.16;
  every client reads and writes through the REST API.
- **Multi-tenant isolation** keys off `household_id`, carried as a JWT claim and enforced
  by the `api` (optionally Postgres RLS).
- UUID primary keys everywhere (client-generatable).

## Calendar (a core tenet)

- **2-way Google Calendar sync, day one.** Not deferrable.
- **Authority:** Google is authoritative for events that originated in Google; Waffled is
  authoritative for Waffled-native fields (assignee/color, reward links). Conflict = compare
  `updated`/`etag`; Waffled-native fields never lost.
- **Freshness:** ~5-min outbound polling (`syncToken`), run by an **in-process scheduler in
  the `api`** — no separate worker. No public webhook needed; `watch` push channels are a
  later upgrade.
- **Topology:** one **hub Google account** owns secondary calendars for the kids (who have
  no Google identity). Each adult connects their own account; their events live in their real
  calendar and are shared so they surface for everyone.
- Each Waffled person has one **home calendar** (write-back target) + zero or more
  **subscribed** (read) calendars. Write-back needs a stored token per connected adult.
- Store events as `timestamptz` + `RRULE` + timezone — never the prototype's human strings.
- **Clients never talk to Google.** The `api` owns the Google
  relationship (in-process). Only two parties converge: Postgres and Google.

## Identity

- **Built-in auth issues the JWTs** — email/password with rotating refresh tokens, signed
  locally (HS256, `LOCAL_JWT_SECRET`). Claims (`household_id`, `person_id`, `role`) come
  straight from the `persons` / `identities` tables at mint time, so the `api` authorizes
  from the token. No external identity provider is required.
- **Optional SSO** — backend-mediated **OIDC** (invite-gated, admin-configured) for adults
  who want it. An external RS256/JWKS issuer (e.g. Auth0) can alternatively validate tokens
  if `AUTH0_DOMAIN` is set — an advanced, rarely-needed mode; built-in auth + in-app OIDC
  covers SSO for almost everyone.
- Kids (no email/login): profiles under the household, profile-select (+ optional PIN).
- Kiosk: shared **device** session via a pairing flow, not a personal login.
- **Calendar OAuth is separate from login** — an incremental "Connect your calendar" grant;
  the refresh token is stored **encrypted by our backend** (AES-GCM), independent of the
  login mechanism.

## Notifications

- Ride **native calendar reminders** by exporting events to Google — no notification system
  to build for calendar events.
- Remote push (web-push) for cross-device nudges is a planned follow-on, deferred on a
  self-host key/relay decision.
- Kiosk banners ("leave by 3:35") are just rendered data, not notifications.

## Hosting

- **Self-hosted Docker Compose, two containers:** the single `waffled` image (serves the
  SPA, `/api`, `/auth` and `/media`, runs migrations and the schedulers on start) and
  Postgres, plus an optional nightly **pg_dump backup service** (`--profile backup`, local,
  with an optional off-site copy). Secrets live in `/data/secrets.json` unless the
  environment sets them. Can run entirely behind **Tailscale** — nothing public — and the
  kiosk on the LAN keeps working during internet outages.
- **Public ingress is the operator's choice**, not app code: any reverse proxy or a
  Cloudflare Tunnel in front of port 8080, with `PUBLIC_BASE_URL` set and `TRUST_PROXY=true`
  (forwarded headers are ignored otherwise). Keep the DB/admin on the tailnet.
- The only console-only setup is the **Google OAuth client** (for Calendar) — walkthrough in
  the [Google Calendar admin guide](https://waffled.app/administration/google-calendar/).
  There is no Terraform / AWS / Auth0 infrastructure to provision.

## Known open details

- Tailnet TLS method: `tailscale serve` in front of the app vs a proxy with the Tailscale plugin.
- Per-module schema grows as each feature lands.
