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
- [x] 2.3 DB migration tooling (**node-pg-migrate**, SQL files) + first migration: `households`, `persons`, `identities` (+ `set_updated_at` trigger, FKs, partial indexes). `just migrate`; test-first via a Postgres testcontainer
- [ ] 2.4 `backup` service (pg_dump→S3) + `just restore-check` (restore into throwaway PG, assert row counts)

## M3 — Identity & household
- [x] 3.1 First-login provisioning: `POST /api/households` creates household + owner `person` (adult/admin) + `identity`; `GET /api/household` resolves `sub`→household from the DB (identities table is the authority, not the JWT — so onboarding works pre-Auth0). `GET /api/me` echoes the principal. *(Auth0/Google login swaps in at M5; PowerSync gets the `household_id` claim then.)*
- [x] 3.2 Members CRUD (`/api/persons`): list + create + read-one + update + soft-delete, all household-scoped. Reads open to any member; mutations admin-only; owner protected from deletion
- [ ] 3.3 Kiosk device pairing + kid profile tokens

## M4 — Offline foundation (de-risk #1)
- [x] 4.1 Self-hosted `powersync` service + `service.yaml`/`sync-config.yaml` (one `household` bucket scoped by the `household_id` JWT claim); logical-replication publication (4.1a); api as PowerSync token authority — JWKS + `/api/powersync/token` (4.1b); service replicating `households`+`persons`, verified healthy (4.1c). *Client sync E2E lands in 4.2.*
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
**Through M4.1 done** — repo/data-model, compose stack, api (TS + JWT), test harness,
migrations + identity tables, first-login provisioning, members CRUD, and the **PowerSync
offline pillar stood up** (service replicating households+persons, household-scoped sync
rules, api as token authority). Still runnable with **zero external dependencies**: local
HS256 via `mint-token`, schema via `just migrate`, **45 tests green**; PowerSync verified
healthy + replicating via a live compose bring-up. Next: **4.2** (iOS skeleton + PowerSync
Swift SDK → the airplane-mode read/write demo that proves the whole offline loop), or
**3.3** (kiosk pairing), or **2.4** (backups → opens AWS/Terraform). `0.2` (Google console)
stays parallel, not a blocker until M5.
