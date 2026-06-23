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
> **⛔ SUPERSEDED by the self-hosted pivot (2026-06-20) — see the "Self-hosted (Immich-style)" section below.**
> Nook is now `git clone` + `./nook up` Docker Compose, not Terraform/AWS/Auth0. The
> cloud IaC milestone below is abandoned; kept for history. (Backups moved to Phase 4
> S3 backup; identity moved to built-in auth + OIDC.)
- [x] 1.0 **Data model design** — `docs/DATA_MODEL.md` (all domains, ERD, sync/conflict, decisions)
- [ ] ~~1.1 Terraform **bootstrap** stack: encrypted state S3 bucket + DynamoDB lock table~~ *(dropped — no AWS)*
- [ ] ~~1.2 Terraform **AWS**: web bucket + CloudFront (OAC), backups bucket (versioned + lifecycle), scoped backup IAM~~ *(dropped — Caddy serves the SPA; backups → Phase 4)*
- [ ] ~~1.3 Terraform **Auth0**: provider, native-iOS app, web SPA, API/audience, Google + Apple connections, `household_id` action~~ *(dropped — built-in auth + OIDC instead)*
- [ ] ~~1.4 *(optional)* Terraform **GCP**: project + enable Calendar API~~ *(dropped — operator registers their own Google OAuth client)*

## M2 — Backend skeleton & local stack
- [x] 2.1 `docker-compose.yml`: Postgres (logical replication) + Caddy + `.env.example` + `justfile` (up/down/logs)
- [x] 2.2 `api` (lambda-api, **TypeScript** → esbuild bundle): `/healthz` + JWT middleware (local HS256 — *the pivot kept HS256 and dropped the planned Auth0 RS256 swap*; extracts `household_id` → `req.tenant`); multi-stage Dockerfile; behind Caddy; `mint-token` dev CLI
- [x] 2.2t **Test harness** (Vitest + Testcontainers; wiremock for external HTTP) + retrofit 2.2 tests. See `docs/TESTING.md`. **Test-first from here on.**
- [x] 2.3 DB migration tooling (**node-pg-migrate**, SQL files) + first migration: `households`, `persons`, `identities` (+ `set_updated_at` trigger, FKs, partial indexes). `just migrate`; test-first via a Postgres testcontainer
- [ ] 2.4 `backup` service (pg_dump→S3) + restore-check (restore into throwaway PG, assert row counts) — *now tracked as **Phase 4 — optional S3 backup** in the self-host section*

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
- [x] 3.1 First-login provisioning: `POST /api/households` creates household + owner `person` (adult/admin) + `identity`; `GET /api/household` resolves `sub`→household from the DB (identities table is the authority, not the JWT — so onboarding works pre-Auth0). `GET /api/me` echoes the principal. *(Real login landed via built-in auth + OIDC — see the self-host section — not the originally-planned Auth0/Google swap.)*
- [x] 3.2 Members CRUD (`/api/persons`): list + create + read-one + update + soft-delete, all household-scoped. Reads open to any member; mutations admin-only; owner protected from deletion
- [x] 3.3 **Kiosk device pairing + kid profile tokens** (DONE 2026-06-22). A tablet is paired once to a household (`kiosk_devices`, migration 0043) and rests on a Netflix-style **profile picker**; tapping a profile mints a *real* person-scoped session (server-enforced attribution + role gates — a kid's token can't approve chores or spend others' stars). The device token (`kind:'device'`) is allowed only on `/api/kiosk/*`; it has no identity row so `requireTenant` rejects it everywhere else. Claiming lazily ensures/resurrects a `kiosk` identity (`kiosk:<personId>`) so the existing sub→identity→person path is unchanged. Optional per-person **PIN** (scrypt, throttled). Pairing via an admin code or a "use this device" promote (Settings → Display & Kiosk). Rail "Switch" + 2-min idle return to the picker. Single-login (no pairing) stays the untouched default. 16 API integration tests + Playwright E2E (pair→pick→PIN→switch). iOS unaffected.

## M4 — Offline foundation (de-risk #1)
- [x] 4.1 Self-hosted `powersync` service + `service.yaml`/`sync-config.yaml` (one `household` bucket scoped by the `household_id` JWT claim); logical-replication publication (4.1a); api as PowerSync token authority — JWKS + `/api/powersync/token` (4.1b); service replicating `households`+`persons`, verified healthy (4.1c). *Client sync E2E lands in 4.2.*
- [x] 4.2 iOS skeleton (SwiftUI) + PowerSync Swift SDK sync; **airplane-mode read/write + reconnect demonstrated**. `apps/ios` XcodeGen project (SwiftUI + SwiftData-for-local + PowerSync), Nook design system ported, 5-tab nav. PowerSync client mirrors `persons`/`events`/`households`/`event_participants` to on-device SQLite (schema + connector mirror the web client); `fetchCredentials` exchanges the session token at `/api/powersync/token`; `uploadData` drains queued writes to `/api/powersync/crud`. **Verified E2E on the iPhone 17 Pro sim against the live stack:** family renders from local SQLite, an event created on-device round-tripped to Postgres, offline read kept working with the backend stopped, an offline write queued and then **drained on reconnect**. Auth via local HS256 dev token (Auth0 login split out to 4.2.1). *Tooling note: pinned to a locally-patched PowerSync 1.14.3 — the released SDK's `weak let` doesn't compile under Xcode 26.1 / Swift 6.2; revert once upstream fixes it.*
- [x] ~~4.2.1 iOS **Auth0 login** (Sign in with Apple + Google)~~ **DONE differently — native auth, not Auth0.** The iOS app now signs in with the **built-in login + OIDC** flow (Keychain token store, 401-refresh, `ASWebAuthenticationSession` SSO) — same `/api/auth/*` endpoints as web, minted HS256 JWT keeps the `household_id` claim so PowerSync rules are unchanged. (Merged via `ios/mobile`.)

## M5 — Calendar (de-risk #2, the core tenet)
**Part 1 (Nook-native, no Google) — done:** `events` migration, events api (create + today
agenda + range), kiosk agenda card + Calendar month-grid screen. Part 2 below is the Google sync.
- [x] 5.1 Schema: `events` (timestamptz, rrule, tz, `google_event_id`, `etag`, …) + migration (`0007_events`); native single-events. Recurrence read-model/overrides/participants deferred to recurrence work
- [x] 5.2 Backend Google **Calendar OAuth** ("Connect your calendar") — connect/callback (Auth0-independent), AES-256-GCM encrypted refresh token (`src/crypto.ts`), calendar import + person↔calendar mapping, write-target (★) per person; **Settings → Calendars** UI (grouped by account, search/filter, hide read-only, sync now)
- [x] 5.3 **Inbound** sync (`syncToken`) → upsert events (`src/calendar-sync.ts`); on-demand `POST /api/calendar/sync` + **5-min in-process scheduler** (`startSyncScheduler`); 410 full-resync; cancellations soft-delete; Google-owned vs Nook-owned fields. *(Worker runs in the api process, not a separate service.)*
- [x] 5.4 **Outbound** write-back (Nook event → Google): per-person write-target routing + create-time calendar picker; create/edit/delete push (idempotent, best-effort); `pending_push`/`push_failed` retried on sync
- [x] 5.5 Calendar UI: kiosk/web Today + agenda + month + create/edit/delete with duration + participants. **iOS shipped** (M4.2): agenda/month/day views + event detail + create/edit/delete + per-person filter, local-first over PowerSync
- [x] 5.6 **Realtime + offline (web)**: events replicated over PowerSync (migration 0027); local-first agenda reads + offline writes (`POST /api/powersync/crud`) — kiosk renders from local SQLite, survives API outages, edits/deletes apply instantly and upload on reconnect
- [~] 5.7 Calendar views + detail + **AI cards**: Month / **Week** / **Day** / **Agenda** toggle (week & day are hour-grid views with all-day strips, person filters, lane-packed overlaps + a live "now" line; day answers "a day with >3 events I can't see"), full-screen **event detail/edit** (`/calendar/event/:id` — location/Directions, calendar+sync status, repeats, participants, notes, "where it falls today" timeline). **AI cards real** via the household's provider (shared `src/llm.ts`, `src/calendar-ai.ts`): **"Heads up this week"** digest (agenda) + **per-event insight** (detail) — each computes facts deterministically server-side so they degrade to a useful card when the provider is heuristic/offline. **"Remind me"** surfaces an AI-suggested nudge inline (no delivery yet — kiosk notifications tracked in 6.7)

## M6 — Feature modules (each a vertical slice)
- [~] 6.1 Tasks / chores + stars: real api (chores CRUD inc. edit/delete, daily instances, append-only stars ledger, balances view) + kiosk Family-chores rings (Today) + Tasks screen (complete + **add/edit/delete chores**, assign person + stars). **Stars "spend" loop done** (migration 0023: `rewards` catalog + `reward_redemptions`; redeem→parent-approve→ledger debit, balance guard; `/api/rewards`, `/api/redemptions`, `/api/balances`; kiosk Tasks **Rewards tab**: per-kid balances, approval queue, catalog with redeem). **Weekly/custom schedules done** (rrule `FREQ=WEEKLY;BYDAY=…`, instances materialize on matching weekdays; ChoreModal "Repeats: Every day / Certain days" + day chips). **Up-for-grabs claim done** (unassigned instances; `POST /api/chore-instances/:id/claim` with single-claim guard; Tasks "Up for grabs" claim → person picker). **Parent-approval step done** (migration 0024 `requires_approval`; complete→`awaiting` (no stars)→parent approve→`done`+award or reject→pending; ChoreModal "Needs a parent's OK" toggle; Tasks ⏳ awaiting state + Approve/Reject). **Streaks done** (per-chore consecutive-day streak in the instance payload; 🔥N badge). Still to come: photo proof. **Rewards page polished** (matched the 30px screen gutter — the panel had 0 horizontal padding — proper empty-state card + inline CTA, mobile layout). **Multi-currency economy — phase A done** (migration 0028 `currencies` table: key/label/symbol/color/is_default/spendable, seeded with a default Stars ⭐ per household; `/api/currencies` CRUD admin-gated). Chores + rewards record a `currency` (default = household default) instead of hardcoded `'stars'`; `/api/balances` + person/family overview return per-currency balances + the catalog. Kiosk: **Settings → Chores & rewards** manages currencies; Rewards tab shows per-currency chips + currency picker; ChoreModal currency picker; Person profile renders per-currency balances + symbols on the ledger/redemptions (and the Rewards balance chips now link there). Whole numbers only. Today rings + Tasks chips read the catalog symbol too (rename reflects everywhere). **Phase B done — tiers/conversions** (migration 0029 `currency_conversions`: from/to currency + from/to amount): Settings → Chores & rewards manages conversions (10 ⭐ → 1 💵); a "⇄ Trade" modal on the Rewards tab applies one, writing two ledger entries (debit/credit, reason 'conversion') in a transaction with a balance guard — anyone can convert their own balance instantly (per decision). `/api/conversions` CRUD (admin) + `/api/conversions/:id/apply` (any member). **Per-kid reward presentation done** (see 6.4): a kid pins one reward as what they're "saving toward" and sees bar/jar progress + "X to go" + inline redeem on their profile; currencies render equal (no priority); the four mock "reward styles" are one ledger + presentation (jar = saving-toward viz). `persons.reward_style` stays **dormant** (settable, unread) — currency = denomination, style = presentation; it's the home for sticker-book/XP-levels styles if those get built (both deferred)
- [~] 6.2 Lists: custom multi-lists screen + **auto-built grocery board** (mock-faithful: aisle-grouped, summed quantities, per-meal color dots, "this week's dinners" rail, pantry-staples "Pantry check", By aisle/By meal). Migration 0018 pantry_staples; grocery rebuild from the week's dinners. (sidebar, sectioned items, quantities, per-item assignees, create/rename/delete) + grocery (real api: lists + list_items, get-or-create, add/check/delete) wired to the kiosk Grocery card (tap to check, type to add, persists) + **meal auto-build** (recipe ingredients → grocery). Shared aisle classifier (`src/aisles.ts`, used by importer + live board; re-files uncategorized items at read time), **quantity-merge** (two recipes' limes → "2", no silent skip), staples kept off the list, By-meal "Other items" catch-all (nothing vanishes), board auto-opens as the primary Lists view. **Cross-surface live refresh done** (`lib/api/bus.ts` — mutations `emit(topic)`, hooks `useRefetchOn`; grocery/meals/chores/rewards kept in sync across the Today cards, Lists board, and Rewards panel without manual reloads). **List delete/rename + cascade done** — soft-deleting a list cascades to its items in a transaction (no orphans); rename via the edit modal; deleting a goal *group* detaches its goals (`goal_list_id → null`) rather than destroying them.
- [~] 6.3 Meals / recipes: weekly planner + **Markdown recipe import** (migrations 0017–0022: ingredient aisle + recipe_steps + per-step ingredients + rich frontmatter metadata + user notes + overrides; `just import-recipes <folder> [--recursive]` parses frontmatter/sectioned-ingredients/steps + assigns grocery aisle & staple hints; idempotent update-by-title) + real api (recipes CRUD, meal_plans + entries, GET week, **structured ingredients + steps**). Kiosk: weekly planner grid, **full-screen recipe detail** (hero, clickable metadata chips, per-step ingredients, servings scaler, mark-cooked), **Recipes library** (search-all-metadata, multi-select filters, sort), **in-app Customize** (metadata/dietary/tag overrides, per-ingredient substitution, per-step notes — all merged over the markdown source & survive re-import), **Cook mode** (full-screen step-by-step, per-step ingredients, wake-lock, finish→mark-cooked), grocery auto-build honoring substitutions. **AI "plan my week" done** — `POST /api/meals/plan-week` suggests a dinner for each empty night via the household's chosen LLM (shared `src/llm.ts`: provider toggle + keys reused from capture), drawing on the recipe library + dietary notes; kiosk "Plan my week ✨" modal reviews + accepts each (or all)
  - [x] 6.3-ai-fill **AI metadata auto-fill — done.** `POST /api/recipes/suggest-metadata` infers a recipe's taxonomy (cuisine/meal type/protein/base/effort/cook method/flavor), dietary, the **vegetables present in the ingredient list** (grounded — never invented), and a few tags from the title + ingredients + steps via the household's chosen LLM; reuses the library's existing values as preferred vocabulary so filters stay consistent; 501s with no provider. Editor surfaces it quietly: a debounced background call shows a **✨ Thinking…** indicator, then renders each suggestion **inline per field** (empty fields only) as a ghost value with ✓ keep / × dismiss, plus ghost chips for dietary/vegetable/tag and a **Keep all / Dismiss** header — never overwrites what you typed.
  - [ ] 6.3-ai **Conversational recipe AI** — beyond the auto-fill above, instruction-driven edits on a recipe: "make this gluten-free", "scale to N servings", "swap X for Y", "make it healthier / spicier", "write or expand the steps". Reuse the pluggable LLM layer + the editor's review pattern (propose → inline keep/dismiss, never auto-apply). **Stretch: photo → recipe** — draft a full recipe (ingredients + steps) from a photo of a recipe card or dish; needs a vision-capable provider + real blob upload (6.5). Note: provider quality matters — the local 8B is loose (e.g. put "vegetarian" in the protein field), so a stronger/hosted model is meaningfully crisper here.
  - [x] 6.3-edit **Create / edit / delete recipes in-app — done.** A unified full **RecipeEditor** (new + edit, `/meals/recipe/new` & `/meals/recipe/:id/edit`) authors a recipe from scratch or fully edits one — title/emoji, all metadata + dietary/vegetables/tags chips, ingredient rows (amount/unit/name/prep/section, reorder/remove) and step rows (instruction + per-step ingredients, reorder/remove). Reached from a **＋ New recipe** button in the library and the **✏️ Edit** action on a recipe; the old override-only CustomizeModal is **retired**. Backend: `POST /api/recipes` and `PATCH /api/recipes/:id` broadened to all fields **+ full-replace of ingredients/steps in a transaction**, new `DELETE /api/recipes/:id` (soft-delete + cascade), and `POST /api/recipes/parse-markdown`. **Edit model — detach on deep edit:** a structural edit flips an imported recipe's `source_type` to `manual` so the dev/seed importer never overwrites it; light override-style tweaks still merge non-destructively (legacy). **Paste-markdown** path: the blessed Markdown format (shared parser, used by both the in-app paste endpoint and the dev-only `import-recipes` CLI) with **Use template** / **See example** helpers, documented in `docs/RECIPE_FORMAT.md` — paste a recipe (or have an LLM generate one) → parse → review → save. The `import-recipes` CLI stays a **dev/seed tool only**, not a user feature.
- [~] 6.4 Goals + rewards: real api (migrations 0010 + 0011 — goal_lists + **goal_list_members** membership, goals, goal_participants, goal_logs, **goal_milestones**; count/total/habit/checklist; shared_total vs each_tracks; append-only logs → derived progress; **goal-lists CRUD**, **detail read-model** with hours-by-person/recent-activity/streak/this-week; **Edit-goal** via PATCH /api/goals/:id) + mock-faithful kiosk Goals (home/create/**edit**/detail — see W2c-goals). **Reward redemption + per-person balances done** (see 6.1 — stars ledger reused). **Person + family overview done** (`src/overview.ts`: `/api/persons/:id/overview` — their goals with per-person progress, whole-person **balance across the 5 life categories** using `goals.category`, a *local* heuristic insight + suggestions, stars ledger, reward redemptions; `/api/family/overview` — glanceable per-member goals/avg-progress/streak/stars). Kiosk: **PersonProfile** (`/person/:id`, modeled on the "Person / Wally" mock, extended with chores/stars/rewards) + **FamilyOverview** (`/family`), reached from a "Family" button on Goals. **Goals mechanics overhaul done** — logging style derived from goal type (total=amount, count=stepper, habit=once/day, checklist=tick steps; the enter-vs-tap fork retired); create-form validation (name + ≥1 person + per-type measurement); per-cadence habit once-a-day guard (`loggedTodayBy`); detail ring-fill fix + type-aware/hidden log button; optimistic checklist toggles; selected list persisted in `?list=`; back-nav returns to prior page. **Milestones/checklist rethink done** (see backlog): `goal_steps` real named steps (migration 0030) + per-type milestone thresholds (units/streak-days/percent), text-only. **Saving-toward + streaks done** — kids pin one shop reward (`persons.saving_toward_reward_id`, migration 0032) shown as bar **or jar** with "X to go" + inline redeem; weekly activity streak (a day counts for a chore OR a goal) on the profile; best-goal-streak on the individual goals list; currencies rendered equal (no default priority). **`auto_from_calendar` opt-in** added (migration 0031) — preference only until the calendar→goal bridge (backlog) lands. Still to come: AI suggestion cards upgraded via Claude (6.6), auto-from-calendar logging (the bridge — backlog), milestone reward payouts (deferred — backlog)
- [~] 6.5 Photos / memories: **done** — `photos` table + family wall (emoji/URL tiles), "new memory" banner, full-screen **screensaver**, add-photos + photo detail. Real blob upload (device library) still to come
- [x] 6.6 AI "Add anything" intent parsing → route to event/task/grocery/meal. **Pluggable LLM provider behind one interface** (`src/capture.ts`): credentials live only in the server env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` + `OPENAI_BASE_URL` / `OLLAMA_HOST`), the **active provider + model is chosen per household** in **Settings → AI & capture** (stored in `households.settings.ai`; the UI only enables providers whose key/host the server reports present, and never sees the keys). `POST /api/capture` parses with the chosen model (forced JSON-schema/tool output, temp 0, few-shot, household-local "now" + family names for resolution; server converts the model's naive local datetime to the household tz); `GET/PUT /api/capture/config` read/flip the selection. The kiosk shows an **instant on-device parse, then upgrades to the LLM** with a "via Claude/OpenAI/local LLM" tag, and **falls back to the on-device heuristic** whenever the provider defers, errors, or you're offline. Heuristic (no-LLM) path also hardened (possessive names, quoted titles, "to X's chore list" destinations, weekday recurrence). *(Verified end-to-end against a local Ollama: laundry/Kelly, quoted-title/Lottie, Soccer-Tue-4pm/Wally all parse correctly.)* Note: small local models (llama3.2:3b) need the few-shot prompt to behave; a 7–8B model or hosted Claude is more reliable
  - [ ] **6.6-names — server-side fuzzy person resolution** (backend, on `main`): the parser only resolves an assignee when the text matches a roster name closely, so nicknames/variants are dropped — e.g. "add soccer for **Walter** today at 3" (member is **Wally**) came back `kind: task, personName: null`, while "**Wally**" parses as an event with the person attached. Resolve `personName` against the household roster **server-side after parse**: fuzzy/alias match (Levenshtein + common nicknames: Walter→Wally, Walt; Katherine→Kelly; etc.), prefer a confident single match, else leave null. Keeps clients dumb (they already commit whatever `personName` comes back) and helps every surface (kiosk + iOS). Pairs with the model-quality note above — a stronger model also helps, but post-parse roster matching is deterministic and cheap. *(iOS side already fixed on the `ios/scaffold` worktree: `commitEvent` now writes the `event_participants` row, not just `person_id`, so a resolved person actually attaches as a participant.)*
- [ ] 6.7 Notifications: ride Google reminders + APNs nudges. **Kiosk notifications (local-only, buildable now)** — an in-kiosk "due soon" surface so reminders work without APNs/web-push: a `reminders` table + endpoint, a kiosk banner/toast when a reminder time passes (fires while the kiosk is open), seeded by the calendar's **"Remind me"** (today an AI-suggested nudge only — see 5.7). A later step adds web-push (service worker + VAPID + scheduler) so reminders fire when the kiosk is closed
  - [x] 6.7-ios **iOS local notifications (event reminders)** — on-device `UNUserNotificationCenter` reminders driven entirely from the local PowerSync `events` mirror, so they fire even when the app is closed/offline. No server/APNs/Apple key (the iOS analog of the kiosk-local reminders above). `NotificationManager` (@MainActor @Observable) reconciles a soonest-first horizon against upcoming events on each events change / foreground / sign-in; iOS caps pending local notifications at **64** so it schedules ≤58 and surfaces `droppedToCap` (never silent). Stable `nook.evt.<id>` identifiers so re-syncs replace (not duplicate); edit/delete → drops out. Time-interval trigger at `starts_at − leadTime`, all-day → a configurable morning hour in the household tz; tap deep-links to the event on the Calendar tab. Per-user Settings (UserDefaults): master toggle, lead time (default **15 min**), all-day time (default **8:00**), scope (default **"my events only"**). Cleared on sign-out. Self-contained, **zero backend changes**. *(verified firing on device)*
    - [ ] 6.7.1 **Chore reminders** — extend the iOS scheduler to chores. Needs chores on-device first: add `chores`/`chore_instances` to the PowerSync sync rules (REST-only today, not in `SyncSchema`) or schedule off a REST snapshot, then due-time triggers + parent-approval nudges
    - [x] 6.7.2 **Snooze + View actions** — `UNNotificationCategory` (`EVENT_REMINDER`) on each reminder: **Snooze 10 min** re-delivers under a separate `nook.snz.` namespace (reconcile won't cancel it); **View** deep-links to the event. A chore-oriented **Done** action lands with 6.7.1. Client-side only.
    - [ ] 6.7.3 **Recurring-event reminders** — per-occurrence expansion so reminders fire for repeats (reminders/recap are gated to `rrule is null` today; depends on recurring-events, Phase 2)
    - [ ] 6.7.4 **Remote push (APNs)** — server→Apple→device for cross-actor nudges the phone can't know locally (redemption approved, chore assigned to you, weekly recap). Worker signs HTTP/2 + JWT to `api.push.apple.com`; app registers a device token stored per-device. **Blocked on a self-host key decision** — APNs ties to our bundle id + `.p8` key, so a self-hoster's worker can't push to our App Store app without it (needs a hosted push-relay we operate, or a per-deployment key). *(indefinite — no committed timeline)*
    - **Notification actions — design principle (informs 6.7.1/6.7.4)** — inline actions are reserved for the *single obvious one-tap verb*; anything needing a quantity, a choice, or context **deep-links into the app**. Both paths route through the **existing `SyncManager` logic** — the notification handler *triggers* existing code, it never reimplements approval gating / reward math / offline queueing (one source of truth). Per type: **event** → Snooze + View (no "done"); **chore** (6.7.1) → **Done** + Snooze (Done → *awaiting* when approval-gated, no stars yet); **habit/checklist goal** → **Log it** ✓; **count/total goal** → View → log sheet (don't fake a quantity inline); **parent approval** (chore done / redemption requested) → **Approve / Reject**. Keep to ~2 collapsed actions; resist novelty buttons. **Delivery split:** *self-knowable* reminders (your events, your own chores) fire **locally** (6.7-ios); *cross-actor* nudges (someone **else** approved/assigned/requested) only reach a **closed phone** promptly via **APNs (6.7.4)** — until then they surface on the always-on **kiosk** and as an in-app pending list (opportunistically a local notif on next sync, not real-time). The inline *actions* work on either delivery path, so action design is **not** blocked on APNs. **Offline + mutation:** an inline Done/Log tapped offline must queue — clean once the domain is in PowerSync (e.g. chores via 6.7.1, an optimistic local write that uploads on reconnect); for REST-only domains, prefer deep-link (where the retry/error UX lives) until they're synced.
- [x] 6.8 Live weather on the kiosk topbar — `src/weather.ts` geocodes the Settings location + fetches current conditions from **Open-Meteo** (no API key), WMO code→label/emoji (day/night aware), geocode + 10-min forecast caching; topbar shows emoji + °F, hides when no location. `GET /api/weather`

## M7 — Harden & "make it real"
- [~] 7.1 Kiosk PWA: service worker + cached last-known state (survive backend blips)
- [ ] 7.2 Submit Google + Apple production verification
- [ ] 7.3 Public ingress when exposing the stack beyond the LAN — Caddy auto-TLS via `CADDY_SITE_ADDRESS` + `PUBLIC_BASE_URL` (or a Cloudflare Tunnel in front). *(Self-host reframe: no tailnet assumption; the operator chooses how to expose it.)*
- [ ] 7.4 Observability (logs/metrics/health) + scheduled restore drills

---

### Current focus
**Feature surface complete + self-host packaging shipped — a fresh `git clone` + `./nook up`
comes up with real auth (built-in password / OIDC) and runs.** Every M6
domain is built and mock-faithful: Today (4 live cards), Tasks/chores (full stars loop —
rewards catalog → redeem → parent-approve → ledger debit, weekly schedules, up-for-grabs claim,
parent-approval, streaks), Lists/grocery (auto-built aisle board, quantity-merge, by-meal),
Meals/recipes (markdown import, recipe detail, library, in-app overrides, cook mode,
substitution-aware grocery build), Goals + rewards (membership model, edit, detail read-model,
person + family overview), Photos, Calendar (native events + month grid + create/edit/delete),
and a cross-surface live-refresh bus. Still **zero external dependencies**.

**What's left** *(reconciled to the self-host pivot — the old Terraform/AWS/Auth0/GCP
infra milestone is abandoned, not pending; identity shipped via built-in auth + OIDC,
backups moved to Phase 4)*:
- **Self-host infra:** **Phase 4 — optional S3 backup** (the only remaining packaging
  piece; supersedes 2.4) — *parked*.
- **Needs a 3rd party / hardware:** APNs/web-push delivery for notifications
  (6.7 tail), Apple/Google **store verification** (7.2), public ingress when going
  beyond the LAN (7.3).
  *(DONE: Google Calendar sync 5.2–5.6; built-in auth + OIDC + iOS native login; **kiosk device pairing + kid profile tokens (3.3)**.)*
- **Local-only, buildable now:** **6.7 kiosk reminders** (local "due soon" banner +
  `reminders` table — table not built yet), **calendar → goal Phase 2** (recurring
  events; Phase 1 shipped), real photo / chore-proof **blob upload** (6.5 tail),
  **6.6-names** server-side fuzzy person resolution, **7.4** observability + restore
  drills, milestone reward **payouts** (deferred by design — see backlog).

Other deferred polish folded into done items: AI "Nook suggests" cards (→6.6-ai), list-sharing
UI, settings sub-tab depth, event recurrence/overrides, auto-from-calendar goal logging (M5).

---

## Backlog — designed, not yet built

### Tech debt — route auth as middleware (not yet built)
Almost every API route opens with the same two lines —
`const tenant = await requireTenant(req)` then (for writes) `requireAdmin(tenant)` —
copied across chores, rewards, currencies, goals, lists, meals, kiosk, persons, etc.
Fold this into reusable lambda-api middleware: one that resolves + attaches the tenant
(short-circuiting 401 when absent) and one that asserts admin (403 otherwise), so routes
just declare their requirement instead of re-deriving it. Keep `requireTenant`/
`requireAdmin` as the underlying helpers the middleware calls (and for the few
dual-auth/device routes that don't fit the common shape). Mechanical, broad, well-tested
surface — a good standalone pass. *(raised 2026-06-22)*

### Calendar → goal auto-counting (the "auto-from-calendar" bridge) — PHASE 1 SHIPPED 2026-06-18
The bidirectional Google Calendar **sync already exists and works** (inbound pull +
outbound push, per-household OAuth, 5-min poll). The goal side has the **opt-in toggle**
(`goals.auto_from_calendar`, migration 0031) and `goal_logs.source` reserves
`'auto_calendar'` — but nothing links events to goals or writes the log yet.
Events are stored as **one master row + `rrule`, expanded on read** (no instance rows),
which is what makes recurrence its own phase.

**Model — two links + a confirmation record:**
1. `goals.auto_from_calendar` = the goal *accepts* calendar contributions (gate). ✅ exists.
2. `events.goal_id` (nullable FK) = "this event counts toward [goal]" — explicit per-event
   tag (decided; no keyword matching). Phase 1 = single events.
3. Confirmation/idempotency row per **(event_id, occurrence_date, goal_id)** with
   `status` pending/logged/skipped + `goal_log_id`; unique key so nothing double-counts
   on sync re-runs. (occurrence_date carried now for Phase 2; single events use start date.)

**Flow — confirm-after with an EDITABLE PREVIEW (decided):** an event is a *plan, not a
fact*. When a linked, non-cancelled occurrence has ended, surface a recap modeled on the
**AI capture intent-suggestion** UX: "Did Soccer happen?" + a preview of exactly what will
be recorded (goal · amount · who), pre-filled, **editable** (change amount, add/remove
people) → ✓ Log / Skip. Only writes `goal_log` (`source='auto_calendar'`,
`ref_type='event'`) on confirm. Surfaced in **both** places (decided): a "Did these happen?"
queue on **Today** (primary) and on the relevant **goal detail / person profile**.

**Amount mapping:** Total(time unit) → event **duration**; Count → **+1**; Habit →
**mark-done** (respect once/day). Attribution default = event participants ∩ goal
participants (via existing split/each-tracks), editable in the recap.

**Phase 1 — SHIPPED** (migration 0033 `events.goal_id` + `event_goal_logs`; module
`goals/goal-calendar.ts`; `GoalRecap` on Today + goal detail; "Counts toward" picker in
the event modal, round-tripped through REST **and** the PowerSync CRUD path). Covers
Total-time / Count / Habit single events. Verified end-to-end (Playwright on the kiosk) +
`test/goal-calendar.integration.test.ts` (6 cases).

**Definition of done — resolve or EXPLICITLY defer each before marking complete:**
- [x] Idempotency — never double-count. Confirm claims the `(event_id, occurrence_date,
      goal_id)` slot via `insert … on conflict do nothing returning`; a 2nd confirm gets
      `status:'duplicate'` and writes no log. *(Phase 1)*
- [x] Attribution editable in recap; default = event ∩ goal participants, fallback to all
      goal participants when the intersection is empty; who-chips editable at confirm. *(Phase 1)*
- [x] Filter cancelled — recap excludes `events.status = 'cancelled'` (and `deleted_at`,
      which Google cancellations also set). Tentative/declined intentionally KEPT (a
      tentative event that happened should still be confirmable). *(Phase 1)*
- [x] Edge cases: all-day / no-`ends_at` / zero-duration → `suggestedAmount` 0 for Total
      (person fills it in); Count/Habit always suggest 1; multi-day uses the start date as
      the occurrence. *(Phase 1)*
- [x] Habit once-a-day — two linked events the same day both resolve the recap, but
      `logProgress`'s habit dup-guard means only one progress row is written. *(Phase 1)*
- [~] Recap offline behavior — events render from the local DB, but the recap **queue +
      confirm/skip are REST** (server computes the queue, writes the log). The kiosk is the
      always-on home hub so this is fine in practice; a fully-offline confirm-queue is a
      documented follow-up (would need `event_goal_logs` replicated + a CRUD path). *(Phase 1 → follow-up)*
- [ ] Recurring events — per-occurrence tag + confirmation (recap is gated to `rrule is
      null` today). `occurrence_date` is already carried for this. *(Phase 2)*
- [ ] Non-time Total units (miles/pages) — per-association amount or unsupported  *(Phase 2)*
- [ ] Edit/cancel/delete after a confirmed log — clawback vs keep (lean: keep)   *(Phase 2)*
- [ ] Backfill on enable — forward-only vs sweep past events (lean: forward-only) *(Phase 2)*

**Phase B — smart suggestions + per-family learning (SHIPPED 2026-06-19):** untagged
events that look like a goal are suggested (Today drawer "Might count toward a goal" +
event modal + event detail). Layered match: learned **memory** (`goal_match_memory`,
per-token→goal weights from human links +3 / LLM hits +1) → keyword/concept matcher →
LLM fallback (`completeJson`, per-household provider, once per event via `event_llm_seen`).
Checklist scheduling (migration 0034, `events.goal_step_id`) also shipped. **Auto-link
(SHIPPED, modal only):** when memory score ≥ `AUTO_LINK_THRESHOLD` (9 ≈ confirmed ~2×) the
create modal **pre-selects** the goal ("we've learned this · change it"); the recap is
still the safety net so an unwanted auto-link never logs progress.
- [ ] **Auto-link in the background** — extend auto-link to events created outside the
      modal (Google sync, capture bar): set goal_id at create when memory is confident,
      show "auto-linked · undo", recap confirms. *(deferred — modal-only for now)*
- [ ] **⚠️ No background LLM without an explicit opt-in.** The suggestions LLM fallback runs
      only on user-initiated surfaces today (drawer open / modal). Any background sweep
      (e.g. classifying synced events on a schedule) MUST be gated behind a per-household
      opt-in before it ships. *(constraint, per user 2026-06-19)*

### Milestones / checklist rethink — ✅ DONE (migration 0030)
"Milestones" did double duty: threshold reward moments AND the "checklist" measure
type both ran on `goal_milestones`. Split & shipped:
- **checklist** is now real named steps (`goal_steps`: label, sort_order, done_at,
  done_by), decoupled from the rewards toggle, logged by ticking steps. Progress =
  steps done / total. Measure type renamed "Milestones" → "Checklist".
- **reward milestones** are now a per-type threshold marker, threshold expressed in
  each type's natural axis: Total/Count → X units; Habit → X **streak days**;
  Checklist → **percent** complete. Milestones are **text-only** (label + free-text
  reward). Real payouts remain deferred — see below.

### Milestone reward payouts — DEFERRED (needs a dedicated, careful pass)
Milestones currently pay nothing (cosmetic). Before wiring real payouts, resolve:
- **Rewards aren't always currency.** Many are *experiential* ("at 250 hours we go
  camping / movie night") and must NOT touch the ledger. So the model needs an
  optional structured payout (currency + amount) *alongside* the free-text reward —
  text-only milestones never pay.
- **Idempotency** — pay on FIRST crossing, never double-pay (logProgress runs every
  log). Needs an awards record (`goal_milestone_awards` or a ledger ref) to dedupe.
- **Attribution on shared goals** — who gets the bonus when a *shared pool* crosses a
  threshold? Logger / split / all participants? (Same ambiguity as shared logging.)
- **Per-type "reached"** trigger must evaluate crossing per type (cumulative / streak
  / %), including the streak calc.
- **Clawback policy** — if a log is deleted and progress drops back below, revoke the
  payout or keep it earned? (Lean: keep earned.)
- Reuses the existing `ledger_entries` + `currencies` economy (a second earn source
  alongside chores), reason e.g. `goal_milestone`.

### UX feedback pass — Jun 2026
A round of in-app user feedback. **Quick fixes SHIPPED 2026-06-19:** nav labels no
longer underlined + the Nook "N" links home; Today calendar title sans-serif (was
serif) and "Family Chores" title-cased; Today chore rows link to `/tasks` and the
"This week's dinners" header links to `/meals`; Today cards fill but no longer
overflow the 3-col kiosk (the height-bound breakpoint now actually constrains —
columns shrink, the grocery/agenda lists scroll internally); long recipe titles
clamp in the meal-plan grid instead of bleeding; Cook Mode → back no longer loops
(exit `replace:`es the cook entry); goal-create **name field** is now the visual
anchor (coral label + large accented input); goal titles display **title-cased via
CSS** (`text-transform: capitalize`, stored as typed); **goal logs can be backdated**
("When?" picker in the LogModal → `loggedOn` lands the entry at noon on that local
day; habit dedupe keys off the chosen day) so a forgotten day can be caught up
without breaking a streak.

**Drag-and-drop chore reassignment — SHIPPED 2026-06-19:** drag a chore card by its
grip handle (⠿) between columns on the Tasks board to reassign it — up-for-grabs →
a person, person → person, or back to up-for-grabs (unassign). Pointer-events based
(not HTML5 `draggable`) so it works with both a mouse and the kiosk touchscreen;
floating ghost + drop-target highlight during the drag; optimistic move reconciled
by the `chores` refetch bus. Uses the existing `POST /api/chore-instances/:id/assign`
(personId or null). Tasks board only — the Today chores widget is a read-only
per-person summary (no columns), so DnD doesn't apply there; the non-drag fallback
is editing a chore's person in the ChoreModal.

**Rearrange Today cards — SHIPPED 2026-06-19:** the Today dashboard is now a
data-driven board of cards (agenda, tonight, week, chores, grocery) in a fixed
3-column grid. A "Customize" mode reveals a drag bar per card; drag (pointer
events — mouse + touch) to reorder within and between columns, with a floating
ghost + insertion line, then **Save for me** (per-person override) or **Save for
everyone** (family default, admin-only). Two tiers stored as jsonb
(`persons.today_layout` + `households.today_layout`, migration 0038); resolution
is `user ?? family ?? built-in default`, always normalized to 3 columns with every
card present (`reconcileLayout`, unit-tested). API: `GET/PUT/DELETE
/api/today-layout` (`modules/layout/today-layout.ts`). A `dev|kelly` identity was
seeded so per-user behavior is testable. Note: the kiosk is single-identity today
(only Kevin had a login), so per-user only differentiates once others get logins —
the family tier is what the shared kiosk shows.

**Deferred (bigger features, captured for the next pass):**
- **Pantry-add UX** — adding while viewing the Pantry list silently routes to
  Groceries instead of staples; staples are managed in Settings. Left as-is pending
  a clearer repro from the user; revisit the add-bar destination affordance then.

**Month meal view + planner — SHIPPED 2026-06-20:** Week/Month toggle on the Meals
screen; dinner-only month grid (`/api/meals/week?days=42`). "Plan my month" drafts a
rotation: the LLM picks from the recipe library only (never invents), the pool is
topped up from the library so a rich library yields a varied/unique month, and it's
laid across the chosen nights honoring repeat-gap, weekday themes (metadata-derived,
with a reserve pass so themed nights aren't starved), quick-weeknights, and
leftovers. Already-planned nights show in the review (editable). Drag-to-swap on the
month grid, week grid, and planner review (optimistic, pointer events). "Eating out"
+ "Leftovers" are always-available picker options. `POST /api/meals/plan-month`.

## Self-hosted (Immich-style) — auth, onboarding, deployment — Phases 1–3 DONE, Phase 4 parked
**This section is the current spine of the project** (replaces M0–M1's cloud/Auth0 plan).
Status: Phase 1 built-in auth · Phase 2 OIDC · member management · Phase 3 packaging +
GHCR — all **shipped**; iOS native login/OIDC **merged**. Only **Phase 4 (optional S3
backup)** remains, and it's parked.

**Pivot (2026-06-20):** drop the Terraform/Auth0/cloud-zero path. Ship a self-hosted
app you `git clone` + `docker compose up` and run; the operator chooses auth (built-in
password or OIDC) and opts into S3 backup via env. The whole app gates on a JWT
(`sub → identities → person → household`), so this is an **issuer + onboarding +
packaging** layer in front — features are unchanged. Decisions: OIDC =
**backend-mediated** (we run the code flow, mint our own session); sessions =
**short access + rotating refresh**; images = **GHCR publish + build-from-source
fallback**.

**Built-in auth — SHIPPED (backend) 2026-06-20** (`modules/auth/auth.ts`, migration
0040 `credentials` + `refresh_tokens`):
- `GET  /api/auth/status` → `{ initialized, methods:["password"] }`
- `POST /api/auth/setup` (one-time, locks once initialized) → `{ accessToken,
  refreshToken, expiresIn, person, household }`. Body `{ household:{name,timezone},
  admin:{name,email,password} }` (password ≥ 8).
- `POST /api/auth/login` `{email,password}` → `{ accessToken, refreshToken, expiresIn }`
- `POST /api/auth/refresh` `{refreshToken}` → new pair (**rotating, single-use**)
- `POST /api/auth/logout` `{refreshToken}` → revoke
- Passwords: Node `scrypt` (no dep). Access = HS256 JWT signed with `LOCAL_JWT_SECRET`
  (issuer `nook-local`, aud `nook-api`) so `requireAuth` + the PowerSync token
  exchange validate it unchanged. Refresh = opaque, sha256-at-rest. TTLs env-tunable:
  `ACCESS_TOKEN_TTL_SECONDS` (default **3600 / 1h**), `REFRESH_TOKEN_TTL_DAYS`
  (default **60**). Password users reuse `identities` (provider=`password`,
  subject=credential id). Verified: 5 integration tests + live.

### Mobile app login contract (replaces the hard-coded token)
The iOS app authenticates with the **same endpoints** — token-based, JSON, no
web-cookie assumptions:
1. **Login:** `POST /api/auth/login {email,password}` → store `accessToken` +
   `refreshToken` in the iOS Keychain.
2. **Every request:** `Authorization: Bearer <accessToken>` (same header the
   hard-coded token used). Also feeds the existing `GET /api/powersync/token`
   exchange — PowerSync unchanged.
3. **On 401:** `POST /api/auth/refresh {refreshToken}` → **replace BOTH** stored
   tokens with the response, retry once. If refresh 401s → send back to Login.
4. **Logout:** `POST /api/auth/logout {refreshToken}` then clear Keychain.
- **Offline:** the access token is only needed online; offline reads come from the
  local PowerSync SQLite, and reconnect after up to `REFRESH_TOKEN_TTL_DAYS` is
  covered by the refresh token — so a 1h access TTL is safe for mobile.
- **Token compatibility:** access tokens are HS256 over `LOCAL_JWT_SECRET` (issuer
  `nook-local`, aud `nook-api`). Point the app's env at the **same** `LOCAL_JWT_SECRET`
  the server uses (supersedes 4.2.1's Auth0 plan).

**Phase 1b — SHIPPED 2026-06-20** (`apps/web`): `AuthGate` (loading/authed/login/
setup), first-run **Setup wizard** + **Login screen**, `client.ts` session mgmt
(access + rotating refresh in localStorage, bearer on every call, transparent 401
refresh-retry), legacy `nook.token` still honored. **Sign out** in Settings (nav
footer + real About panel; tap-to-confirm) — `authApi.logout()` revokes refresh +
clears session + fires `nook:auth-changed`. Verified live + 95 web tests green.

### Phase 2 — OIDC, backend-mediated, **Settings-managed** (Immich-style) — SHIPPED 2026-06-20
**Verified live against real Google discovery** (test/enable/status/secret-safe
readback; `/start` → real authorize URL with S256 PKCE; login SSO button → Google;
Settings round-trip) + 4 integration tests vs an in-process stub IdP (full
code→token→JWKS-verify→invite-link→handoff-exchange + not-invited reject). Files:
`modules/auth/oidc.ts`, migration 0041; web `AuthGate` `/auth/callback`, Settings
**Login & security** panel. **Mobile** reuses the same flow: open `…/api/auth/oidc/
start?redirect=<app-deep-link>` in an in-app browser → backend redirects to
`<deep-link>/auth/callback?code=…` → `POST /api/auth/oidc/exchange {code}` →
store the returned access+refresh (identical to the password path from there).

Config is **DB-backed and edited by an admin in Settings**, not env (the operator
attaches their IdP *after* first-run setup and chooses whether passwords stay on).
We run the auth-code + PKCE flow server-side and mint our **own** session, so every
downstream feature is unchanged — OIDC is just another way to reach `mintAccess` +
`issueRefresh`. No new deps: `jwks-rsa` + `jsonwebtoken` (already used by the Auth0
path) verify the IdP's ID token; `crypto.ts` (AES-GCM, needs `TOKEN_ENCRYPTION_KEY`)
encrypts the client secret at rest. Mirrors the Google-calendar OAuth pattern
(one-time `*_oauth_states` row → public callback → code exchange).

- **Provisioning = invite-gated.** The ID token's *verified* email must match an
  existing person (by `identities.email` or `credentials.email`); first OIDC login
  links a new `identities` row (provider `oidc`, namespaced subject). Unknown emails
  are rejected. (Today only the setup admin has an email on file; Phase 4 member-mgmt
  adds emails to others to invite them to SSO.)
- **Password toggle.** Operator can disable password login once OIDC is enabled &
  validated (lockout-guarded; **break-glass** `AUTH_FORCE_PASSWORD=1` always shows it).

Schema (migration 0041): `auth_config` (singleton: oidc_enabled, issuer_url,
client_id, client_secret_enc, scopes, button_label, password_login_enabled),
`oidc_login_states` (state, code_verifier, nonce, redirect_to, created_at — one-time,
TTL), `auth_handoffs` (code → person_id, subject — one-time, so tokens never ride the
redirect URL).

Endpoints:
- `GET  /api/auth/status` → now `{ initialized, methods, oidc?:{buttonLabel} }`
  (`password` unless disabled; `oidc` when enabled).
- `GET  /api/auth/oidc/start?redirect=` (public) → 302 to IdP authorize (state+PKCE+nonce).
- `GET  /api/auth/oidc/callback` (public) → exchange code, verify ID token (JWKS from
  discovery), resolve invite-gated, mint session → 302 `…/auth/callback?code=<handoff>`.
- `POST /api/auth/oidc/exchange {code}` (public) → `{ accessToken, refreshToken, expiresIn }`.
- `GET  /api/auth/config` (admin) → config **sans secret** (+ `secretSet`).
- `PUT  /api/auth/config` (admin) → set issuer/clientId/clientSecret/buttonLabel/scopes/toggles.
- `POST /api/auth/config/test` (admin) → fetch `.well-known/openid-configuration`, validate.

Web: Login screen renders password form and/or "Sign in with <label>" per `status`;
new SPA route `/auth/callback` exchanges the handoff code → `setSession` → home;
Settings adds an admin **Login & security** panel (OIDC fields + Test + Save, password
toggle). **Mobile** later reuses `oidc/start` + a deep-link `oidc/callback` → `exchange`.

### Member management — SHIPPED 2026-06-20
An admin gives a family **profile** a **login** from the existing PersonModal
(Settings → Family). A login is a `credentials` row — email always, password
optional (migration 0042 made `password_hash` nullable): set a password and they
sign in with the form; set email only and the **invite-gated OIDC** matches them.
Setting a password also creates a `password` identity (subject = credential id) so
sub→identity→person resolves. Owner login is protected; removing a login revokes
sessions. Routes: `PUT/DELETE /api/persons/:id/login` (admin); member list now
carries `loginEmail` + `hasPassword`. 6 integration tests + verified live (admin
grants a login → that member signs in). This is what makes invite-gating useful
beyond the setup admin.

### Phase 3 — packaging: clone → `docker compose up` → fresh run — DONE 2026-06-22
A clean clone comes up fully working with **no host toolchain** and **no manual
steps**. Shipped:
- **In-container migrations.** `scripts/migrate-cli.ts` → bundled `dist/migrate.js`
  (esbuild entry); the `.sql` migrations ship in the api image
  (`COPY migrations`). A compose **one-shot `migrate` service** reuses the api image
  (`command: node dist/migrate.js`), runs after Postgres is healthy, and both `api`
  and `powersync` gate on it via `service_completed_successfully` — so the schema
  *and* the PowerSync publication (migration 0003) exist before they start.
  Idempotent (already-applied migrations skip), so it's safe on every `up`. Verified
  the bundled runner against the live DB (`__dirname`-relative dir resolution; CJS
  `import.meta` pitfall avoided by passing the dir explicitly).
- **Registry-ready images.** `api`/`caddy`/`migrate` carry `image:` names
  (`${NOOK_API_IMAGE:-nook-api:local}` / `${NOOK_CADDY_IMAGE:-nook-caddy:local}`)
  alongside `build:`, so the same compose file builds-from-source today and
  `docker compose pull`s from GHCR when the overrides point at published tags.
- **GHCR publish workflow.** `.github/workflows/publish-images.yml` builds both
  `nook-api` and `nook-caddy` **multi-arch (amd64 + arm64)** and pushes them to
  `ghcr.io/<owner>/…` **on a `v*` release tag** (or manual dispatch) — *not* every
  push to main, to conserve Actions minutes (matrix build, Buildx + QEMU, gha layer
  cache, repo-default `GITHUB_TOKEN` — no extra secrets). Release tags publish
  `version` / `major.minor` / `latest`; a manual run publishes an `sha-…` tag only.
  Set `NOOK_API_IMAGE` / `NOOK_CADDY_IMAGE` to the published tags + `docker compose
  pull` to run without a local build.
- **One-command fresh run.** `./nook up` auto-creates `infra/compose/.env` from the
  example with generated secrets (`LOCAL_JWT_SECRET` / `TOKEN_ENCRYPTION_KEY` /
  `POSTGRES_PASSWORD`) and migrations run automatically — no separate `./nook migrate`.
- **`.env.example` rewritten** for self-host (required vs optional, sessions, image
  overrides, `PUBLIC_BASE_URL`) and the api now passes through the auth TTLs +
  `AUTH_FORCE_PASSWORD` + `PUBLIC_BASE_URL`. README quickstart collapsed to clone + up.

Build-from-source stays the zero-config default; pulling published images is a pure
env change (`NOOK_*_IMAGE` → the GHCR tags).

**Next:** Phase 4 optional S3 backup.
