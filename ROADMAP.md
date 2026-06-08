# Roadmap

Bite-sized, committable chunks. Each line is roughly one PR — independently committable,
ideally demoable, and not dependent on later chunks. Tackle one at a time.

**Sequencing logic:** lay the foundation, then **de-risk the two scary pillars early**
(offline sync + Google calendar) before building features. Features come last as vertical
slices so each one is shippable on its own.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## M0 — Repo & bootstrap
- [x] 0.1 Repo skeleton + README + ARCHITECTURE + BOOTSTRAP + ROADMAP + .gitignore
- [ ] 0.2 Work through `BOOTSTRAP.md` (console) → collect secrets into secrets store *(human, parallel)*

## M1 — Infrastructure as code
- [x] 1.0 **Data model design** — `docs/DATA_MODEL.md` (all domains, ERD, sync/conflict, decisions)
- [ ] 1.1 Terraform **bootstrap** stack: encrypted state S3 bucket + DynamoDB lock table
- [ ] 1.2 Terraform **AWS**: web bucket + CloudFront (OAC), backups bucket (versioned + lifecycle), scoped backup IAM
- [ ] 1.3 Terraform **Auth0**: provider, native-iOS app, web SPA, API/audience, Google + Apple connections, `household_id` action
- [ ] 1.4 *(optional)* Terraform **GCP**: project + enable Calendar API

## M2 — Backend skeleton & local stack
- [x] 2.1 `docker-compose.yml`: Postgres (logical replication) + Caddy + `.env.example` + `justfile` (up/down/logs)
- [x] 2.2 `api` (lambda-api, **TypeScript** → esbuild bundle): `/healthz` + JWT middleware (local HS256 now, Auth0 RS256 on swap; extracts `household_id` → `req.tenant`); multi-stage Dockerfile; behind Caddy; `mint-token` dev CLI
- [x] 2.2t **Test harness** (Vitest + Testcontainers; wiremock for external HTTP) + retrofit 2.2 tests. See `docs/TESTING.md`. **Test-first from here on.**
- [ ] 2.3 DB migration tooling + first migration: `households`, `members`, `persons`
- [ ] 2.4 `backup` service (pg_dump→S3) + `just restore-check` (restore into throwaway PG, assert row counts)

## M3 — Identity & household
- [ ] 3.1 Login (Google/Apple via Auth0) → first-login provisioning (create household + owner); verify `household_id` claim end-to-end
- [ ] 3.2 Members CRUD: add kid profiles, colors, avatars, roles
- [ ] 3.3 Kiosk device pairing + kid profile tokens

## M4 — Offline foundation (de-risk #1)
- [ ] 4.1 Add self-hosted `powersync` service; `config.yaml` + `sync-rules.yaml` (household bucket); enable replication
- [ ] 4.2 iOS skeleton (SwiftUI) + Auth0 login + PowerSync Swift SDK syncing `members`; **demo airplane-mode read/write + reconnect**

## M5 — Calendar (de-risk #2, the core tenet)
- [ ] 5.1 Schema: `events` (timestamptz, rrule, tz, `google_event_id`, `etag`, calendar mapping) + migration
- [ ] 5.2 Backend Google **Calendar OAuth** ("Connect your calendar"), store encrypted refresh token, person↔calendar mapping
- [ ] 5.3 Worker **inbound** poll (`syncToken`) → upsert events. Demo: Google event → appears in DB → syncs to iOS
- [ ] 5.4 Worker **outbound** write-back (Nook event → Google) with conflict policy. Demo: Nook event → appears in Google
- [ ] 5.5 Calendar UI: kiosk/web Today + agenda + month; iOS agenda

## M6 — Feature modules (each a vertical slice)
- [ ] 6.1 Tasks / chores + stars (recurring generation, "up for grabs")
- [ ] 6.2 Lists: grocery + custom lists
- [ ] 6.3 Meals / recipes + AI "plan my week" + auto-built grocery
- [ ] 6.4 Goals + rewards (ledgers, leaderboards, parent-approval redemption)
- [ ] 6.5 Photos / memories + kiosk screensaver
- [ ] 6.6 AI "Add anything" intent parsing (Claude) → route to event/task/list/goal
- [ ] 6.7 Notifications: ride Google reminders + APNs nudges

## M7 — Harden & "make it real"
- [ ] 7.1 Kiosk PWA: service worker + cached last-known state (survive backend blips)
- [ ] 7.2 Submit Google + Apple production verification
- [ ] 7.3 Public ingress (Cloudflare Tunnel/VPS) when onboarding non-household users; DB stays on tailnet
- [ ] 7.4 Observability (logs/metrics/health) + scheduled restore drills

---

### Current focus
**M0, chunk 1.0 (data model), 2.1 (compose), 2.2 (api + test harness) done.** Everything so
far runs with **zero external dependencies** — local HS256 auth via `mint-token`, no
Auth0/Google needed until M5, and the Auth0 path is already proven against a wiremock JWKS.
Next: `2.3` (migrations + `households`/`persons`/`identities`), **test-first** per
`docs/TESTING.md`. `0.2` (Google console) stays parallel and is not a blocker until M5.
