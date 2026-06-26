# Roadmap status

A product-level view of what's **done**, **partial**, and **planned**. This is distilled
from the engineering plan in [`../../ROADMAP.md`](../../ROADMAP.md) — see that file for the
full, commit-level history and rationale.

Legend: ✅ done · 🟡 partial / in progress · 🚧 planned · ⛔ dropped (superseded)

## The big picture

> **Feature surface complete + self-host packaging shipped.** A fresh `git clone` +
> `./nook up` comes up with real auth (built-in password / OIDC) and runs with zero
> external dependencies. Every feature domain (Today, Calendar, Chores, Rewards, Goals,
> Lists, Meals, Photos, AI capture) is built and usable on the Web/Kiosk.

## Done ✅

- **Self-host packaging** — one-command `./nook up`, in-container migrations, multi-arch
  GHCR images, build-from-source default.
- **Observability** — structured JSON logging, a deep `/api/health` + **Settings → System
  Health** panel, **`./nook doctor`**, baked build provenance, and **OpenTelemetry**
  (off by default) with an all-local **`./nook observability up`** Grafana stack. Restore
  drills still to come (7.4).
- **Operator CLI** — Immich-style **`./nook admin`** break-glass commands (reset a member's
  password, list members, grant/revoke admin, toggle password login, clear a stuck calendar,
  prune sessions, regenerate the PowerSync key) that run in-container with no login required.
- **Identity** — built-in email/password auth (rotating refresh), backend-mediated **OIDC
  SSO** (invite-gated, admin-configured), member management (grant logins), **role-based
  permissions** (per-role capability grid for managing/approving chores, rewards & goals —
  see the [permission model](./permissions.md): *gate what touches currency or someone
  else's record; attribute collaborative actions; leave the rest open*).
- **Kiosk** — device pairing, profile picker, optional PINs, idle screensaver.
- **Today** — live cards + customizable per-user / family layouts.
- **Calendar** — native events, Month/Week/Day/Agenda, create/edit/delete, participants,
  **recurring events** (RRULE picker, per-occurrence/this-and-following/all edits),
  **two-way Google Calendar sync** (recurrences expanded on inbound), offline calendar
  (PowerSync), AI heads-up + per-event insight.
- **Chores & stars** — full loop: CRUD, weekly/custom schedules, up-for-grabs claim,
  drag-to-reassign, parent approval, **photo-proof on completion**, streaks, append-only
  stars ledger.
- **Rewards & economy** — catalog → redeem → approve → debit, multi-currency, conversions
  ("Trade"), saving-toward jar/bar.
- **Goals** — types (count/total/habit/checklist), shared vs each-tracks, create/edit/
  detail read-model, person + family overview, **calendar → goal** auto-count (single
  and recurring events) with learned suggestions.
- **Lists & groceries** — multi-lists, auto-built aisle board, quantity merge, pantry
  staples, live cross-surface refresh, **item attribution** ("added by …" / "from meal plan").
- **Meals & recipes** — week/month planners, recipe library, in-app editor, paste-markdown
  import, overrides, cook mode, substitution-aware grocery build, AI plan-week/month, AI
  metadata auto-fill.
- **Photos** — wall (masonry), real blob upload (single + multi), albums, edit, multi-
  select bulk move/delete, screensaver + per-album screensaver source, crossfade
  slideshow, recipe hero images.
- **AI capture** — pluggable provider (Claude / OpenAI-compatible / Ollama), instant
  heuristic → LLM upgrade, offline fallback.
- **Weather** — Open-Meteo on the topbar (no key).
- **iOS** (mobile) — native sign-in (password + OIDC), offline-first calendar over
  PowerSync, local event notifications (Snooze/View). *Full mobile coverage is tracked by
  the mobile owner.*

## Partial / in progress 🟡

- **Offline scope (Web/Kiosk)** — PowerSync covers the **calendar** domain; other domains
  are REST + live-refresh bus.
- **Kiosk PWA** (7.1) — service worker + cached last-known state, to fully survive backend
  blips.
- **Public ingress** (7.3) — configurable (Caddy auto-TLS / Cloudflare Tunnel), operator's
  choice.

## Planned 🚧

- **Multi-household identity** — one email/account that belongs to many households (separate
  profile + role per household, switch after login). Design spike written + product decisions
  aligned: [`docs/design/multi-household-identity.md`](../design/multi-household-identity.md).
  Global `accounts` table over the existing per-household `persons`, concentrated in one tenant
  resolver; invite-and-accept to join, land on last-active household, admin-gated household
  creation (open self-serve onboarding deferred to a sell-time lift). Phased P1–P4; not started.
- **Notifications tail** — kiosk "due soon" local banner (table not built yet); remote push
  (APNs / web-push) is blocked on a self-host key/relay decision. Recurring-event reminders
  on iOS (only single events fire today) ride along here.
- **Conversational recipe AI** — instruction-driven edits + photo → recipe (needs a vision
  provider).
- **Shared album import** for Photos (Google Photos / iCloud).
- **Server-side fuzzy person resolution** for capture (nicknames/aliases).
- **Milestone reward payouts** — deferred by design (needs idempotency + attribution rules).
- **Soft "kids' list additions need an OK" toggle** — floated, *not committed*. Attribution
  already covers the real need; a per-role lists matrix is more machinery than a family hub
  wants. Recorded so the rationale isn't lost (see [permission model](./permissions.md)).
- **Optional S3 backup** (Phase 4) — parked.
- **Restore drills** (7.4) — pairs with the parked S3 backup.
- **App store verification** (7.2) — Apple/Google production review.

## Dropped ⛔ (superseded by the self-host pivot, 2026-06-20)

The original cloud plan (Terraform/AWS, Auth0, GCP project provisioning, a separate
`worker` service) was abandoned in favor of the self-hosted Docker Compose model:

- Terraform AWS/Auth0/GCP stacks → replaced by Docker Compose + built-in auth + OIDC.
- Separate `worker` service → calendar sync runs in-process (5-min scheduler) in the api.
- Auth0 RS256 → HS256 local JWT (`LOCAL_JWT_SECRET`); PowerSync token exchange unchanged.

> `README.md` has been updated to the self-host model (repo layout, "stack in one breath",
> and SSO panel label). `BOOTSTRAP.md` still carries the old Auth0/AWS/Terraform framing
> around its Google Cloud OAuth steps — kept for the OAuth-client walkthrough, but ignore
> the cloud scaffolding. The **self-host model in [`quick-start.md`](./quick-start.md)** and
> the `Self-hosted (Immich-style)` section of `ROADMAP.md` are the current source of truth.
