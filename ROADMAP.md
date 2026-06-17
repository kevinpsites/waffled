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
- [x] W2c-goals Goals domain, **mock-faithful** (handoff "Home / Family list", "The Kids list", create, detail). Goal-lists membership model: SHARED LISTS / INDIVIDUAL sidebar (members + counts), list header + All/Shared/Each, **adaptive featured hero** (green pooled ring+contrib bars / orange "TOGETHER" each-tracks), more-goals grid; full-screen **create-a-goal** (type cards, list picker, measure config, log method, live preview, feature/milestones/check-in toggles); **goal detail** (milestone track, hours-by-person, recent activity, this-week, streak). Per-screen topbar slots. *(Verified live with Playwright against the mocks.)* Defended deferrals: Edit-goal form (needs PATCH), AI insight cards (6.6), auto-from-calendar log (M5)
- [x] W2c-screens **All rail surfaces real** (parallel build, mock-faithful): **Lists** (multi-list sidebar, sectioned items, quantities, assignees), **Meals** (weekly planner grid + recipe picker + week nav), **Settings/Family** (sub-nav + Family & people CRUD + household settings), **Photos** (memory wall + screensaver + add/detail). Each its own api/client/screen/CSS/tests; built on isolated worktrees + merged. *(Verified live with Playwright against the handoff screenshots.)* Defended deferrals per screen (AI "Nook suggests"/"Plan my week", list sharing, real blob upload → emoji+URL tiles, integration-dependent settings sub-tabs)
- [ ] W3 Secondary surfaces (recipe library / Plan-my-week AI / settings sub-tabs depth); real device pairing (3.3) replaces the dev token
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
- [x] 5.2 Backend Google **Calendar OAuth** ("Connect your calendar") — connect/callback (Auth0-independent), AES-256-GCM encrypted refresh token (`src/crypto.ts`), calendar import + person↔calendar mapping, write-target (★) per person; **Settings → Calendars** UI (grouped by account, search/filter, hide read-only, sync now)
- [x] 5.3 **Inbound** sync (`syncToken`) → upsert events (`src/calendar-sync.ts`); on-demand `POST /api/calendar/sync` + **5-min in-process scheduler** (`startSyncScheduler`); 410 full-resync; cancellations soft-delete; Google-owned vs Nook-owned fields. *(Worker runs in the api process, not a separate service.)*
- [x] 5.4 **Outbound** write-back (Nook event → Google): per-person write-target routing + create-time calendar picker; create/edit/delete push (idempotent, best-effort); `pending_push`/`push_failed` retried on sync
- [x] 5.5 Calendar UI: kiosk/web Today + agenda + month + create/edit/delete with duration + participants. iOS agenda pending (M4.2)
- [x] 5.6 **Realtime + offline (web)**: events replicated over PowerSync (migration 0027); local-first agenda reads + offline writes (`POST /api/powersync/crud`) — kiosk renders from local SQLite, survives API outages, edits/deletes apply instantly and upload on reconnect
- [~] 5.7 Calendar views + detail + **AI cards**: Month / **Week** / **Day** / **Agenda** toggle (week & day are hour-grid views with all-day strips, person filters, lane-packed overlaps + a live "now" line; day answers "a day with >3 events I can't see"), full-screen **event detail/edit** (`/calendar/event/:id` — location/Directions, calendar+sync status, repeats, participants, notes, "where it falls today" timeline). **AI cards real** via the household's provider (shared `src/llm.ts`, `src/calendar-ai.ts`): **"Heads up this week"** digest (agenda) + **per-event insight** (detail) — each computes facts deterministically server-side so they degrade to a useful card when the provider is heuristic/offline. **"Remind me"** surfaces an AI-suggested nudge inline (no delivery yet — kiosk notifications tracked in 6.7)

## M6 — Feature modules (each a vertical slice)
- [~] 6.1 Tasks / chores + stars: real api (chores CRUD inc. edit/delete, daily instances, append-only stars ledger, balances view) + kiosk Family-chores rings (Today) + Tasks screen (complete + **add/edit/delete chores**, assign person + stars). **Stars "spend" loop done** (migration 0023: `rewards` catalog + `reward_redemptions`; redeem→parent-approve→ledger debit, balance guard; `/api/rewards`, `/api/redemptions`, `/api/balances`; kiosk Tasks **Rewards tab**: per-kid balances, approval queue, catalog with redeem). **Weekly/custom schedules done** (rrule `FREQ=WEEKLY;BYDAY=…`, instances materialize on matching weekdays; ChoreModal "Repeats: Every day / Certain days" + day chips). **Up-for-grabs claim done** (unassigned instances; `POST /api/chore-instances/:id/claim` with single-claim guard; Tasks "Up for grabs" claim → person picker). **Parent-approval step done** (migration 0024 `requires_approval`; complete→`awaiting` (no stars)→parent approve→`done`+award or reject→pending; ChoreModal "Needs a parent's OK" toggle; Tasks ⏳ awaiting state + Approve/Reject). **Streaks done** (per-chore consecutive-day streak in the instance payload; 🔥N badge). Still to come: photo proof. **Rewards page polished** (matched the 30px screen gutter — the panel had 0 horizontal padding — proper empty-state card + inline CTA, mobile layout). **Next — multi-currency economy**: the ledger is already currency-agnostic (`ledger_entries.currency`, `v_person_balances` per currency; chores/rewards carry `currency`), but write paths hardcode `'stars'` and there's no catalog. Add a per-household **`currencies`** table (key, label, emoji/symbol, color, spendable) seeded with a default Stars ★; thread `currency` through chore-create + reward-create; render from the catalog instead of the hardcoded `<Star/>`; balances become per-currency. Whole-number amounts only (no fractional money/time for now). `persons.reward_style` (stars/stickers/jar/levels) can drive per-kid theming later
- [~] 6.2 Lists: custom multi-lists screen + **auto-built grocery board** (mock-faithful: aisle-grouped, summed quantities, per-meal color dots, "this week's dinners" rail, pantry-staples "Pantry check", By aisle/By meal). Migration 0018 pantry_staples; grocery rebuild from the week's dinners. (sidebar, sectioned items, quantities, per-item assignees, create/rename/delete) + grocery (real api: lists + list_items, get-or-create, add/check/delete) wired to the kiosk Grocery card (tap to check, type to add, persists) + **meal auto-build** (recipe ingredients → grocery). Shared aisle classifier (`src/aisles.ts`, used by importer + live board; re-files uncategorized items at read time), **quantity-merge** (two recipes' limes → "2", no silent skip), staples kept off the list, By-meal "Other items" catch-all (nothing vanishes), board auto-opens as the primary Lists view. **Cross-surface live refresh done** (`lib/api/bus.ts` — mutations `emit(topic)`, hooks `useRefetchOn`; grocery/meals/chores/rewards kept in sync across the Today cards, Lists board, and Rewards panel without manual reloads).
- [~] 6.3 Meals / recipes: weekly planner + **Markdown recipe import** (migrations 0017–0022: ingredient aisle + recipe_steps + per-step ingredients + rich frontmatter metadata + user notes + overrides; `just import-recipes <folder> [--recursive]` parses frontmatter/sectioned-ingredients/steps + assigns grocery aisle & staple hints; idempotent update-by-title) + real api (recipes CRUD, meal_plans + entries, GET week, **structured ingredients + steps**). Kiosk: weekly planner grid, **full-screen recipe detail** (hero, clickable metadata chips, per-step ingredients, servings scaler, mark-cooked), **Recipes library** (search-all-metadata, multi-select filters, sort), **in-app Customize** (metadata/dietary/tag overrides, per-ingredient substitution, per-step notes — all merged over the markdown source & survive re-import), **Cook mode** (full-screen step-by-step, per-step ingredients, wake-lock, finish→mark-cooked), grocery auto-build honoring substitutions. **AI "plan my week" done** — `POST /api/meals/plan-week` suggests a dinner for each empty night via the household's chosen LLM (shared `src/llm.ts`: provider toggle + keys reused from capture), drawing on the recipe library + dietary notes; kiosk "Plan my week ✨" modal reviews + accepts each (or all)
- [~] 6.4 Goals + rewards: real api (migrations 0010 + 0011 — goal_lists + **goal_list_members** membership, goals, goal_participants, goal_logs, **goal_milestones**; count/total/habit/checklist; shared_total vs each_tracks; append-only logs → derived progress; **goal-lists CRUD**, **detail read-model** with hours-by-person/recent-activity/streak/this-week; **Edit-goal** via PATCH /api/goals/:id) + mock-faithful kiosk Goals (home/create/**edit**/detail — see W2c-goals). **Reward redemption + per-person balances done** (see 6.1 — stars ledger reused). **Person + family overview done** (`src/overview.ts`: `/api/persons/:id/overview` — their goals with per-person progress, whole-person **balance across the 5 life categories** using `goals.category`, a *local* heuristic insight + suggestions, stars ledger, reward redemptions; `/api/family/overview` — glanceable per-member goals/avg-progress/streak/stars). Kiosk: **PersonProfile** (`/person/:id`, modeled on the "Person / Wally" mock, extended with chores/stars/rewards) + **FamilyOverview** (`/family`), reached from a "Family" button on Goals. Still to come: AI suggestion cards upgraded via Claude (6.6), auto-from-calendar logging (M5)
- [~] 6.5 Photos / memories: **done** — `photos` table + family wall (emoji/URL tiles), "new memory" banner, full-screen **screensaver**, add-photos + photo detail. Real blob upload (device library) still to come
- [x] 6.6 AI "Add anything" intent parsing → route to event/task/grocery/meal. **Pluggable LLM provider behind one interface** (`src/capture.ts`): credentials live only in the server env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` + `OPENAI_BASE_URL` / `OLLAMA_HOST`), the **active provider + model is chosen per household** in **Settings → AI & capture** (stored in `households.settings.ai`; the UI only enables providers whose key/host the server reports present, and never sees the keys). `POST /api/capture` parses with the chosen model (forced JSON-schema/tool output, temp 0, few-shot, household-local "now" + family names for resolution; server converts the model's naive local datetime to the household tz); `GET/PUT /api/capture/config` read/flip the selection. The kiosk shows an **instant on-device parse, then upgrades to the LLM** with a "via Claude/OpenAI/local LLM" tag, and **falls back to the on-device heuristic** whenever the provider defers, errors, or you're offline. Heuristic (no-LLM) path also hardened (possessive names, quoted titles, "to X's chore list" destinations, weekday recurrence). *(Verified end-to-end against a local Ollama: laundry/Kelly, quoted-title/Lottie, Soccer-Tue-4pm/Wally all parse correctly.)* Note: small local models (llama3.2:3b) need the few-shot prompt to behave; a 7–8B model or hosted Claude is more reliable
- [ ] 6.7 Notifications: ride Google reminders + APNs nudges. **Kiosk notifications (local-only, buildable now)** — an in-kiosk "due soon" surface so reminders work without APNs/web-push: a `reminders` table + endpoint, a kiosk banner/toast when a reminder time passes (fires while the kiosk is open), seeded by the calendar's **"Remind me"** (today an AI-suggested nudge only — see 5.7). A later step adds web-push (service worker + VAPID + scheduler) so reminders fire when the kiosk is closed
- [x] 6.8 Live weather on the kiosk topbar — `src/weather.ts` geocodes the Settings location + fetches current conditions from **Open-Meteo** (no API key), WMO code→label/emoji (day/night aware), geocode + 10-min forecast caching; topbar shows emoji + °F, hides when no location. `GET /api/weather`

## M7 — Harden & "make it real"
- [~] 7.1 Kiosk PWA: service worker + cached last-known state (survive backend blips)
- [ ] 7.2 Submit Google + Apple production verification
- [ ] 7.3 Public ingress (Cloudflare Tunnel/VPS) when onboarding non-household users; DB stays on tailnet
- [ ] 7.4 Observability (logs/metrics/health) + scheduled restore drills

---

### Current focus
**Feature surface complete for a single self-hosted household on the dev token.** Every M6
domain is built and mock-faithful: Today (4 live cards), Tasks/chores (full stars loop —
rewards catalog → redeem → parent-approve → ledger debit, weekly schedules, up-for-grabs claim,
parent-approval, streaks), Lists/grocery (auto-built aisle board, quantity-merge, by-meal),
Meals/recipes (markdown import, recipe detail, library, in-app overrides, cook mode,
substitution-aware grocery build), Goals + rewards (membership model, edit, detail read-model,
person + family overview), Photos, Calendar (native events + month grid + create/edit/delete),
and a cross-surface live-refresh bus. Still **zero external dependencies**.

**What's left splits two ways:**
- **Needs a 3rd party** (can't do local-only): Terraform/AWS/Auth0/GCP (1.x), Google
  console secrets (0.2), real device pairing (3.3), iOS app (4.2), Google Calendar sync
  (5.2–5.5), APNs notifications (6.7), public ingress + store verification (7.2–7.3).
- **Local-only, buildable now**: **6.6 capture-bar parser** *(in progress — local heuristic)*,
  **7.1 kiosk PWA/offline cache** *(in progress)*, real photo/chore-proof upload (6.5 tail),
  meals "plan my week" (local auto-fill), **2.4 backup/restore-check** (local target).

Other deferred polish folded into done items: AI "Nook suggests" cards (→6.6-ai), list-sharing
UI, settings sub-tab depth, event recurrence/overrides, auto-from-calendar goal logging (M5).
