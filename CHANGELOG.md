# Changelog

All notable changes to **Nook** (the self-hosted family hub) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
  RELEASING: no version has been tagged yet. Everything that has shipped so far
  lives under [Unreleased] below. To cut the first release:

    1. Rename `## [Unreleased]` to `## [0.1.0] - YYYY-MM-DD` (today's date).
    2. Add a fresh, empty `## [Unreleased]` section above it (with the empty
       category headings) for the next cycle.
    3. Commit, then `git tag v0.1.0 && git push origin v0.1.0`.
       The tag triggers .github/workflows/publish-images.yml, which builds and
       pushes the multi-arch nook-api / nook-caddy images to GHCR
       (semver + `latest` tags).
    4. Paste this section into the GitHub Release notes.

  See "Release process" at the bottom for the full workflow and the
  commit-prefix -> category mapping.
-->

## [Unreleased]

Everything below is the initial feature surface, targeted for the first tag
(**v0.1.0**). It covers the web/kiosk app, the native iOS/iPadOS app, and the
self-hosted server + tooling. Grouped by Keep a Changelog category; most-significant
user-facing features first within each.

### Added

#### Platform & deployment
- **Self-hosted, zero-dependency deployment.** `git clone` + `./nook up` brings up
  the whole stack (Postgres, API, PowerSync, Caddy) via Docker Compose — no host
  toolchain and no manual steps. First run auto-generates `infra/compose/.env` with
  fresh secrets.
- **Guided setup.** `./nook up` now runs a **preflight** (Docker present + running,
  Compose v2, free ports) with fix-it messages, and prints the exact URL to open when
  it's up. `./nook setup` configures how devices reach the server (localhost / auto-
  detected LAN IP / hostname) and writes the address vars — avoiding the "shows Offline
  on the tablet" `localhost`-sync-URL trap.
- **In-container migrations** as a one-shot compose service (the API and PowerSync
  gate on it), so the schema and PowerSync publication exist before anything starts;
  idempotent on every `up`.
- **GHCR multi-arch images** (`nook-api`, `nook-caddy`, amd64 + arm64) published on a
  `v*` release tag; point `NOOK_API_IMAGE` / `NOOK_CADDY_IMAGE` at the tags and
  `docker compose pull` to run without a local build.
- **Operator CLI** (`./nook admin …`) for break-glass and recovery without the UI:
  reset-password, list/make/revoke-admin, password-login on/off, clear-calendar-error,
  prune-sessions, regenerate-powersync-key, list/delete-household, add-member,
  list-accounts. Runs in-container (host access is the authorization).

#### Accounts, identity & auth
- **First-run setup wizard** (web/server) — create the household + admin account in
  one step; locks once initialized.
- **Built-in email/password login** with rotating single-use refresh tokens and
  transparent 401-refresh (scrypt password hashing, HS256 access JWTs).
- **OIDC SSO** — backend-mediated auth-code + PKCE flow, admin-configured in Settings
  (client secret encrypted at rest), invite-gated (a verified email must match an
  existing member). Optional "disable password login / force SSO" with a break-glass
  env override.
- **Member management** — grant any family profile a login (email ± password) from
  Settings; removing a login revokes sessions.
- **Multi-household accounts** — one human can belong to several households and switch
  between them without re-logging-in (account-scoped tokens; Settings → Households
  switcher; admin-gated additional-household creation).
- **Role-based permissions** — per-role capability grid (adult/teen/kid) for
  `chore.manage`, `chore.approve`, `reward.manage`, `reward.approve`, `goal.manage`;
  editable per household by an admin; `is_admin` stays the superuser. Enforced
  server-side and reflected as render-if-capable gating in the UI (no show-then-403).

#### Kiosk & ambient display
- **Kiosk device pairing** — pair an iPad/tablet to the household via an admin code or
  a one-tap "use this device" promote; a **Netflix-style profile picker** mints a real
  per-person session on tap.
- **Optional per-person PIN** to open a profile (throttled, lockout countdown), plus
  "switch profile", idle return to the picker, and "exit kiosk mode" on the device.
  Single-login (no pairing) stays the default.
- **Idle screensaver** — photo slideshow with crossfade, clock/date/weather/next-event
  chrome, night dimming on a schedule, keep-awake, and a live "Preview" from settings.
  Source selectable (all / favorites / a specific album), speed, and shuffle.

#### Today dashboard
- **Customizable Today dashboard** — cards for agenda, tonight's meal, this week,
  chores, and grocery. Drag-to-reorder in Customize mode, save **for me** (per-user)
  or **for everyone** (family default). iPad uses distinct layout presets
  (Balanced / Agenda / Meals / Goal-focused).
- **Recap and approval banners on Today** — "Did these happen?" goal recap queue and
  "Needs your OK" approvals surface where the family sees them.

#### Calendar & events
- **Native events** — create/edit/delete with multiple participants (per-person
  color, stacked avatars), across Month / Week / Day / Agenda views, with a live
  "now" line on the time grids and a full-screen event detail (location/Directions,
  repeats, notes, timeline).
- **Recurring events** — RRULE creation (Daily / Weekdays / Weekly+days / Monthly
  nth-weekday / Custom), per-occurrence edit scope (this / following / all), and end
  conditions (never / on a date / after N).
- **Two-way Google Calendar sync** — per-household OAuth, inbound poll + outbound
  push (idempotent, retried), per-person write-target, managed in Settings → Calendars.
- **Offline calendar** via PowerSync — local-first reads and queued writes that drain
  on reconnect (on web and iOS).
- **AI calendar cards** — a "Heads up this week" digest and per-event insight, computed
  deterministically server-side so they degrade gracefully with no provider.
- **Countdowns** — "N days until X" merged from three sources (flag an event, a
  standalone item, or member birthdays); Today card + month-grid badge + household
  "N sleeps" toggle.

#### Tasks & chores
- **Chores** — CRUD with assignee and stars/currency, daily instances, complete →
  award, family-chore rings on Today, and a Tasks/Kanban board.
- **Weekly/custom schedules**, **one-off / carry-over tasks** (roll forward until
  done, with an "overdue · since …" badge), **up-for-grabs** claim, and
  **drag-to-reassign** between columns.
- **Parent-approval step** (awaiting → approve/reject before award) and **streaks**
  (🔥 N consecutive days).
- **Photo proof** — per-chore "requires a photo"; capture on complete, a review modal
  (large photo + Approve/Not-yet), auto-delete retention (default 3 days), and a
  stored-proof review/delete gallery.

#### Rewards & economy
- **Stars earn ledger** (append-only) + per-person balances.
- **Rewards catalog** — redeem → parent-approve → ledger debit (balance-guarded).
- **Multi-currency** economy (custom currencies, symbols, colors) with
  **conversions/"Trade"** between currencies.
- **Saving-toward a reward** — pin one reward and see bar/jar progress with "X to go"
  and inline redeem.

#### Goals
- **Goals** — count / total / habit / checklist types, goal **lists** with membership
  (shared vs individual), shared-pool vs each-tracks, create/edit/delete, type-aware
  logging, and backdated logs.
- **Goal detail read-model** — milestone track, hours-by-person, streaks, recent
  activity; named checklist steps and per-type milestones (text).
- **Person profile + family overview** — per-member goals, progress, streaks, and
  balances.
- **Calendar → goal auto-counting** — tag an event "counts toward a goal"; when it
  ends, an editable recap ("Did Soccer happen?") logs progress idempotently. Includes
  recurring-event counting and **smart suggestions** ("might count toward a goal") that
  learn per family.

#### Lists & groceries
- **Custom multi-lists** — sectioned items, quantities, per-item assignees;
  create/rename/delete with cascade.
- **Auto-built grocery board** from the week's dinners — aisle grouping, quantity
  merge, By-aisle / By-meal views, pantry-staples kept off the list, and per-item
  **attribution** ("added by {name}" / "🍽 from meal plan").
- **Re-aisle** any grocery item (section chips + Auto).
- **Cross-surface live refresh** so Today ↔ Lists ↔ Rewards stay in sync without reloads.

#### Meals & recipes
- **Weekly and month meal planners** with a recipe picker and drag-to-swap.
- **Recipes library** (search-all-metadata, multi-select filters, sort) and a
  full-screen **recipe detail** (hero image, metadata chips, servings scaler,
  total/prep/cook time).
- **In-app recipe editor** — author or fully edit recipes (metadata, dietary,
  vegetables, tags, ingredient rows with sections, per-step ingredients and amounts).
- **Paste-markdown import** — paste a recipe (or LLM-generated markdown) → parse →
  review → save. (A `just import-recipes` CLI exists as a dev/seed tool.)
- **Per-recipe overrides** — substitutions and notes that survive re-import and feed
  the substitution-aware grocery build.
- **Cook mode** — step-by-step, wake-lock, recipe overview to jump to any step,
  **per-step timers** (floating dock, alarm), and finish → mark cooked.
- **AI meal features** — "Plan my week / month" (library-only, themes, gaps) and
  metadata auto-fill (cuisine, protein, grounded vegetables, tags).

#### Photos & memories
- **Family wall** — aspect-preserving grid, upload (downscaled JPEG, 10 MB cap,
  capability URLs), multi-upload with caption/album/favorite, drag-and-drop upload
  zone (web), albums, edit (caption/album/date/favorite), multi-select bulk
  move/delete, and per-tile delete.
- **Set an album as the screensaver source** and a photo-only "Play" slideshow.
- Recipe **hero images** use the same upload pipeline.

#### AI capture ("Add anything")
- **Natural-language capture** → event / task / grocery / meal, including parsed
  event recurrence.
- **Pluggable provider** per household (Anthropic / OpenAI-compatible / Ollama) with
  server-only credentials; the UI only offers providers whose key/host the server
  reports present.
- **Instant on-device parse, then upgrade to the LLM** with a provider tag, and a
  **heuristic fallback** so capture works offline / with no provider.

#### Optional modules
- **Module framework** — per-household enable flags in `households.settings.modules`
  gate Today cards, nav, and routes; a **Settings → Modules** tab toggles them
  (Chores/Goals/Meals/Lists/Rewards, plus Pantry and Family Night).
- **Pantry / on-hand inventory** — items with quantities and locations
  (fridge/freezer/pantry), quantity stepper + "used up", drag between locations,
  redesigned list (sidebar, search, sort), and an item-detail sheet.
- **Pantry Open Food Facts integration** — barcode lookup (cached) and camera scanner,
  nutrition + allergen snapshots ("may contain" traces, dietary flags), household ∪
  per-person **allergen warnings** with colored badges, running-low thresholds,
  per-location icons, and item age.
- **Pantry ↔ meals** — "Cook from your pantry" (makeable now, on-hand proteins as
  mains, leftovers, Plan-my-week seeded with soon-to-expire) and the **cook → deplete**
  loop (a "Used from your pantry" confirm sheet decrements/uses-up stock).
- **Family Night** — a recurring family gathering (default Monday) with a fully generic,
  customizable agenda of "parts" that auto-rotate among members (overridable per week),
  a Today card with per-part person pickers, an admin agenda/day/time editor, and an
  optional weekly calendar event.
- **Public API keys + scopes** — issue `nook_…` keys (`x-api-key`) with
  `<resource>:read|write` scopes for external integrations, managed in a
  Settings → API Keys tab (generate / scope / reveal-once / revoke); layered over the
  in-route capability matrix, with sensitive paths never exposed.

#### Notifications (iOS)
- **iOS local event reminders** driven off the on-device events mirror (fire offline /
  when closed, 64-pending cap), with Snooze / View actions and per-user settings
  (lead time, all-day hour, my-events-only).

#### Weather
- **Live weather** on the kiosk topbar and Today/screensaver via Open-Meteo (no API key).

#### iOS / iPadOS app
- **Universal native app** — one binary that adapts by idiom: an iPhone
  *personal-planner* experience and an iPad *family-hub* experience (left nav rail,
  wide layouts, the counter screensaver) over a shared SyncManager/NookAPI data layer.
- **Native auth** — email/password + OIDC SSO (Keychain token store, 401-refresh,
  `ASWebAuthenticationSession`), and About settings (version + editable server address).
- **Offline-first calendar** via the PowerSync Swift SDK (persons/events/participants/
  households mirrored to on-device SQLite; queued writes drain on reconnect).
- **Native media** — `PHPicker` upload, a Photos tab (gallery / add / detail / edit),
  and the iPad screensaver (slideshow + Ken-Burns toggle).
- **iPad shared-kiosk mode** — profile picker + per-person PIN as an opt-in.
- **Chore photo-proof**, capability-based permission gating, and a role permissions
  matrix editor (admin).
- Shared iOS design-system primitives (loading, badges, tiles, CTAs, field cards) for
  UI consistency across screens.

#### Observability & operations
- **Structured JSON logging** + per-request access log with a request id.
- **Deep `GET /api/health`** (db + pool, migrations, scheduler snapshots, calendar push
  backlog + stale calendars, media writability, build sha) and an enriched public
  `/healthz`.
- **Settings → System Health** admin panel (live, polls `/api/health`) with actionable
  hints, and **`./nook doctor`** for an in-container health report.
- **Background job run registry** (last-run / duration / error / run count per
  scheduler) and baked **build provenance** (git sha + build time).
- **OpenTelemetry** traces + metrics (OTLP, off by default) and an all-local
  Grafana/OTEL stack via `./nook observability up`.
- **Automatic backups (local + offsite) & restore.** A `backup` sidecar dumps the
  database nightly (`BACKUP_TIME`) into the `nook_backups` volume — on by default,
  zero-config — pruned after `BACKUP_RETENTION_DAYS`. Optional offsite copy to any
  S3-compatible store (`BACKUP_S3_*` — AWS S3 / Backblaze B2 / Cloudflare R2 / MinIO),
  optional media archive (`BACKUP_INCLUDE_MEDIA`), and a custom target folder
  (`BACKUP_HOST_PATH`). `./nook backup [list]` runs one on demand; `./nook restore
  <file>` does a confirmed, app-stopped, single-transaction restore. Each run is recorded
  in `backup_runs` and surfaced by the `backup` health check (degraded when a run failed
  or the last success is >48 h old). See the Backup & restore docs.
- **CI runs the test suites.** GitHub Actions runs the api (Testcontainers) + web
  (vitest) suites and typechecks on every PR and push to `main`.
- **In-app update notifier.** Settings → System Health shows whether a newer GitHub
  release is available (`UPDATE_CHECK_REPO`, cached 6 h), with an admin toggle and an
  `UPDATE_CHECK_ENABLED` operator kill-switch (no outbound call when off).
- **Healthchecks on every default service** — added caddy + lgtm, so `docker compose ps`
  (and `./nook status`) is all-green.
- **Release automation.** A version tag (`v*`) now cuts a GitHub Release (auto notes +
  `example.env`) and publishes all three images (api, caddy, backup) to GHCR.

### Changed
- **Licensed under AGPL-3.0** (`LICENSE`); added `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, and upgrading/troubleshooting guides.
- **Documentation site** — user/operator docs now live in a searchable Astro Starlight
  site under `website/` (moved out of `docs/`; engineering docs stay in `docs/`), deployed
  to GitHub Pages by `.github/workflows/docs.yml`.
- **Route authorization refactored** into composable per-route guard wrappers
  (`tenantRoute` / `adminRoute` / `capRoute`), replacing ~135 routes' copied
  `requireTenant` + inline capability boilerplate (net −160 lines); handlers now
  receive the resolved tenant, and guards stash `householdId` for the access log.
- **Onboarding state moved server-side** — the post-setup "Getting started" checklist
  is tracked in `households.settings.onboarding`, so it follows the household across the
  admin's devices instead of living in one browser's localStorage.

### Removed
- **Cloud/Terraform/Auth0/AWS plan dropped** in favor of the self-hosted (Immich-style)
  Docker Compose + built-in-auth/OIDC direction (2026-06-20 pivot).
- **Legacy `credentials` auth table dropped** (superseded by the accounts model); no
  unused auth table ships at GA.

### Security
- OIDC client secret and Google Calendar refresh tokens are **encrypted at rest**
  (AES-256-GCM).
- Refresh tokens are **opaque, single-use (rotating), and stored sha256-hashed**;
  passwords use scrypt.
- Media is served via **unguessable per-household capability URLs** (Caddy serves the
  blobs directly; the API is out of the read path).
- API keys are stored **sha256-at-rest**, revealed once, and scoped; only paths in the
  scope catalog are reachable by key auth (auth/kiosk/permissions/key-mgmt/PowerSync are
  never exposed).

### Deprecated
- _Nothing yet._

---

## Release process

This project keeps a **rolling `[Unreleased]` section** that is updated as PRs land, and
cuts versioned releases by tagging.

**As work lands:** add a bullet under the right category in `[Unreleased]`. A changelog
is for users and operators, not a commit log — **synthesize** related commits into one
feature-level entry, grouped by product area, and **omit pure-internal churn** (docs,
tests, tooling, and refactors with no user-visible effect).

**To cut a release:**
1. Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`.
2. Add a fresh, empty `## [Unreleased]` section above it (with the category headings).
3. Commit, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
   The `v*` tag triggers [`.github/workflows/publish-images.yml`](.github/workflows/publish-images.yml),
   which builds and pushes the multi-arch `nook-api` / `nook-caddy` images to GHCR
   (semver + `major.minor` + `latest` tags).
4. Paste the released section into the GitHub Release notes for the tag.

**Versioning** follows [SemVer](https://semver.org/): breaking API/data-model or
self-host changes bump **MAJOR**, backward-compatible features bump **MINOR**, and
fixes bump **PATCH**. Pre-1.0, expect **MINOR** to carry the weight of feature work.

**Commit prefix → changelog category** (this repo uses conventional-commit-ish
`type(scope): summary`):

| Commit prefix                      | Changelog category                           |
| ---------------------------------- | -------------------------------------------- |
| `feat`                             | **Added**                                    |
| `fix`                              | **Fixed**                                     |
| `refactor` / `perf` / `chore`\*    | **Changed** *(only if user/operator-facing)* |
| `docs` / `test` / internal `chore` | *omit* (internal churn)                       |
| _(removals / deletions)_           | **Removed**                                   |
| _(security-relevant changes)_      | **Security**                                  |
| _(soon-to-be-removed features)_    | **Deprecated**                                |

\* Most `chore`/`refactor`/`test`/`docs` commits are omitted; include one only when a
user or operator would notice the result.

[Unreleased]: https://github.com/kevinsites/nook/compare/HEAD
<!-- On first release, replace the line above with:
[Unreleased]: https://github.com/<owner>/nook/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<owner>/nook/releases/tag/v0.1.0
-->
