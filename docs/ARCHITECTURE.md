# Kinnook — Architecture Decision Record

A snapshot of the decisions made during planning, with rationale, so the "why" isn't lost.

## Surfaces

| Surface | Tech | Role | Network |
|---|---|---|---|
| Kiosk | React web app, fullscreen/PWA | always-on ambient display, full read/write | home LAN (+ tailnet) |
| iOS | native Swift/SwiftUI | capture companion, **offline read + write** | anywhere (on tailnet now) |
| Web | React SPA on S3 + CloudFront | management/setup dashboard | anywhere |

Kiosk and web share the same React codebase (kiosk = a layout/PWA mode).

## Data & sync

- **Postgres is the system of record.** The data is relational and aggregation-heavy
  (grocery dedup from meal plans, goal leaderboards, star ledgers) — Postgres fits;
  DynamoDB does not (would force hand-maintained materialized counters + a custom
  realtime layer). This is the pivotal call: **Postgres over Dynamo**, independent of host.
- **PowerSync** provides the iOS offline layer: on-device SQLite mirror, queued offline
  writes, upload via our own API. Chosen for its first-class Swift SDK and because it
  works against any Postgres. Writes go through our `api` (we keep validation + conflict logic).
- **Multi-tenant isolation** keys off `household_id`, carried as an Auth0 JWT claim and
  used by PowerSync sync rules (and optionally Postgres RLS).
- UUID primary keys everywhere (client-generatable so the phone can mint ids offline).

## Calendar (a core tenet)

- **2-way Google Calendar sync, day one.** Not deferrable.
- **Authority:** Google is authoritative for events that originated in Google; Kinnook is
  authoritative for Kinnook-native fields (assignee/color, reward links). Conflict = compare
  `updated`/`etag`; Kinnook-native fields never lost.
- **Freshness:** 2–5 min outbound polling (`syncToken`). No public webhook needed now;
  `watch` push channels are a later upgrade.
- **Topology:** one **hub Google account** (Kevin's for v1) owns secondary calendars for
  the kids (who have no Google identity). Each adult connects their own account; their
  events live in their real calendar and are shared so they surface for everyone.
- Each Kinnook person has one **home calendar** (write-back target) + zero or more
  **subscribed** (read) calendars. Write-back needs a stored token per connected adult.
- Store events as `timestamptz` + `RRULE` + timezone — never the prototype's human strings.
- **The phone never talks to Google.** It syncs to Postgres; the server-side worker owns
  the Google relationship. Reduces a 3-way converge to two pairwise syncs.

## Identity

- **Auth0** issues our JWTs (claims: `household_id`, `person_id`, `role`). Managed via Terraform.
- Adults: **Sign in with Google** + **Sign in with Apple** (Apple required on iOS by App
  Store guideline 4.8 when offering social login).
- Kids (no email/login): profiles under the household, profile-select (+ optional PIN).
- Kiosk: shared **device** session via a pairing flow, not a personal login.
- **Calendar OAuth is separate from login** — incremental "Connect your calendar" grant,
  refresh token stored encrypted by our backend (not hostage to Auth0's token vault).

## Notifications

- Ride **Google/Apple native event reminders** by exporting events to Google — no
  notification system to build for calendar events.
- App-specific nudges (chore reminders, redemption approvals, weekly recap) → **APNs
  directly from our worker** (native iOS, no third-party push service).
- Kiosk banners ("leave by 3:35") are just rendered data, not notifications.

## Hosting & IaC

- **Now:** self-hosted Docker Compose (Postgres, self-hosted PowerSync, api, worker,
  Caddy ingress, nightly pg_dump→S3 backup). Behind **Tailscale** — nothing public,
  CGNAT/dynamic-IP irrelevant. Kiosk on the LAN keeps working during internet outages.
- **Later ("make it real"):** swap is env-var/service-level, not app code —
  hostname (`NOOK_HOSTNAME`), ingress (Caddy → Cloudflare Tunnel/public), DB
  (container → RDS), PowerSync (self-hosted → Cloud). Keep DB/admin on the tailnet forever.
- **IaC:** Terraform for AWS (S3, CloudFront, backup IAM, state) + Auth0. Compose for
  runtime. One `hostname` value per environment, referenced by both. The only
  console-only, non-IaC pieces are the Google OAuth client + consent-screen verification
  and the Apple Sign In / APNs keys — done once, consumed as secrets (see BOOTSTRAP.md).

## Known open details (resolved within their chunks, not blockers)

- PowerSync bucket storage: reuse Postgres vs add MongoDB (depends on version).
- Tailnet TLS method: `tailscale serve` in front of Caddy vs Caddy-Tailscale plugin.
- Full per-module schema (defined as each feature chunk lands).
