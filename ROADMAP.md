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

## MW — Web & kiosk (apps/web)
- [x] W1a Web scaffold (Vite + React + TS) + kiosk shell: design system (nook.css) ported, 1280×800 scaling stage, nav rail + topbar (live clock) + AI capture bar
- [x] W1b Kiosk **Today** dashboard: agenda · meals · family chores + grocery (design-faithful; placeholder data until each domain lands)
- [x] W1c Served via Caddy in the stack (web build baked into the caddy image; SPA fallback; `/api` proxied). `just web` for Vite dev
- [x] W2a Responsive layout (fills viewport, reflows 3→2→1 cols) + **working rail navigation** (routes; placeholders for not-yet-built screens)
- [x] W2b Kiosk reads **real** data: `/api/persons` → real family on the Today dashboard (real names/avatars/colors, empty/sign-in states). Dev/kiosk token via localStorage/env; `just seed` for a demo household. *(Verified api→kiosk end-to-end with Playwright.)*
- [x] W2c-grocery Grocery card real + interactive (check off, add, delete; persists via /api/lists/grocery)
- [x] W2c-chores Family-chores rings (Today) + interactive Tasks screen (complete → stars → rings)
- [x] W2c-meals Meal card real (tonight + this week's dinners, from /api/meals/week)
- [x] W2c-agenda Agenda card real (today's events, per-person color) + Calendar month-grid screen
- [x] W2c **All four Today cards live** (agenda · meals · chores · grocery). Kiosk surfaces: Today, Tasks, Calendar real; Goals/Lists/Photos/Settings still placeholders
- [x] W2c-event-create Calendar self-serve: create/edit/delete single events from the kiosk (day-click / New / click an event → modal; PATCH/DELETE) with **multiple participants** (event_participants; date night = Kevin+Kelly, stacked avatars). Recurrence + AI capture still to come
- [ ] W3 Next surfaces (Lists / Meals planning / Recipes / Settings screens); real device pairing (3.3) replaces the dev token
- [ ] W3 Web management dashboard (full SPA: setup, calendar, lists, …) — grows alongside the backend domains

## M3 — Identity & household
- [x] 3.1 First-login provisioning: `POST /api/households` creates household + owner `person` (adult/admin) + `identity`; `GET /api/household` resolves `sub`→household from the DB (identities table is the authority, not the JWT — so onboarding works pre-Auth0). `GET /api/me` echoes the principal. *(Auth0/Google login swaps in at M5; PowerSync gets the `household_id` claim then.)*
- [x] 3.2 Members CRUD (`/api/persons`): list + create + read-one + update + soft-delete, all household-scoped. Reads open to any member; mutations admin-only; owner protected from deletion
- [ ] 3.3 Kiosk device pairing + kid profile tokens

## M4 — Offline foundation (de-risk #1)
- [x] 4.1 Self-hosted `powersync` service + `service.yaml`/`sync-config.yaml` (one `household` bucket scoped by the `household_id` JWT claim); logical-replication publication (4.1a); api as PowerSync token authority — JWKS + `/api/powersync/token` (4.1b); service replicating `households`+`persons`, verified healthy (4.1c). *Client sync E2E lands in 4.2.*
- [ ] 4.2 iOS skeleton (SwiftUI) + Auth0 login + PowerSync Swift SDK syncing `members`; **demo airplane-mode read/write + reconnect**

## M5 — Calendar (de-risk #2, the core tenet)
**Part 1 (Nook-native, no Google) — done:** `events` migration, events api (create + today
agenda + range), kiosk agenda card + Calendar month-grid screen. Part 2 below is the Google sync.
- [x] 5.1 Schema: `events` (timestamptz, rrule, tz, `google_event_id`, `etag`, …) + migration (`0007_events`); native single-events. Recurrence read-model/overrides/participants deferred to recurrence work
- [ ] 5.2 Backend Google **Calendar OAuth** ("Connect your calendar"), store encrypted refresh token, person↔calendar mapping
- [ ] 5.3 Worker **inbound** poll (`syncToken`) → upsert events. Demo: Google event → appears in DB → syncs to iOS
- [ ] 5.4 Worker **outbound** write-back (Nook event → Google) with conflict policy. Demo: Nook event → appears in Google
- [ ] 5.5 Calendar UI: kiosk/web Today + agenda + month; iOS agenda

## M6 — Feature modules (each a vertical slice)
- [~] 6.1 Tasks / chores + stars: real api (chores CRUD inc. edit/delete, daily instances, append-only stars ledger, balances view) + kiosk Family-chores rings (Today) + Tasks screen (complete + **add/edit/delete chores**, assign person + stars). Still to come: rrule beyond daily, up-for-grabs claim flow, photo/approval, streaks
- [~] 6.2 Lists: grocery (real api: lists + list_items, get-or-create, add/check/delete) wired to the kiosk Grocery card (tap to check, type to add, persists) + **meal auto-build** (recipe ingredients → grocery, dedup). Custom lists + cross-card live refresh still to come
- [~] 6.3 Meals / recipes: real api (recipes CRUD, meal_plans + entries, GET week, **structured ingredients**) + kiosk meal card (tonight + this week) + **recipe-detail modal** (View recipe) + **grocery auto-build** (To list). Still to come: recipe steps/cook-mode, AI "plan my week", Meals planning screen, markdown import
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
**Through M4.1 + the kiosk web shell (W1a–c) done** — backend: compose stack, api (TS + JWT),
test harness, migrations + identity tables, first-login provisioning, members CRUD, PowerSync
offline pillar. Frontend: `apps/web` (Vite + React + TS) renders the design-faithful kiosk
**Today** dashboard, served via Caddy in the stack (`just up` → kiosk at :8080, `just web` for
Vite dev). Still runnable with **zero external dependencies**; **45 api tests + 3 web tests
green**. Next: **W2** (kiosk shows the real family from `/api/persons`; needs a kiosk/dev
token), then **3.3** (real device pairing). Other tracks: **4.2** (iOS + airplane-mode demo),
**2.4** (backups → AWS/Terraform). `0.2` (Google console) stays parallel, not a blocker until M5.
