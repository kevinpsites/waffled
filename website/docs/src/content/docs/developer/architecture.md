---
title: Architecture
description: How Waffled is put together — the surfaces, the stack, and the data flow.
---

A tour of how Waffled is built, for anyone who wants to contribute, extend it, or just understand
what's running. The short version: **one Postgres database is authoritative, the api is the
contract, and the web app (and its kiosk mode) consumes it** over plain REST.

## The surfaces

| Surface | What it is | Tech |
|---|---|---|
| **Counter Kiosk** | Always-on kitchen tablet | The web build in fullscreen/PWA mode |
| **Web / PWA** | Full management dashboard, also installable on a phone | React + Vite SPA served by the `waffled` app |

The **Kiosk and Web are the same build** — the kiosk is a layout/PWA mode of the React SPA, not a
separate program. The native iOS and Mac apps and the PowerSync offline layer were removed in 0.16.

## The stack

Two containers ([Docker install](/install/docker/) has the service-by-service table):

```
          HTTP :8080
 client ─────────────▶ ┌──────────────────────────┐   DATABASE_URL   ┌────────────┐
                       │ waffled                  │ ───────────────▶ │  Postgres  │
                       │ web SPA · /api · /auth · │                  └────────────┘
                       │ /media · schedulers      │                        ▲
                       └──────────────────────────┘                        │
                               (optional) backup ── nightly pg_dump ───────┘
```

- **waffled** (lambda-api / TypeScript, bundled with esbuild to `dist/`) is the whole app.
  On start it creates or loads its secrets (`/data/secrets.json`), applies migrations, then
  serves the built web SPA (with SPA fallback), `/api/*`, `/auth/*` and uploaded media at
  `/media/*`, and runs the background jobs. Forwarded headers are honoured only when
  `TRUST_PROXY` is set.
- **Postgres 16** is the source of truth. It is not published to the host.
- **backup** (optional profile) dumps Postgres nightly (see [Backup & restore](/operations/backup/)).

Put your own reverse proxy in front if you want a hostname or HTTPS; see
[Reverse proxy & TLS](/install/reverse-proxy/).

## Repo layout

Waffled is a monorepo, but **not** npm workspaces — `apps/api` and `apps/web` each own their
`package.json` and lockfile.

| Path | What's there |
|---|---|
| `apps/api` | The backend — `src/` (routes, platform, modules), `migrations/`, `scripts/`, `test/` |
| `apps/web` | React + Vite web app / kiosk — `src/` (incl. `src/kiosk/`) |
| `compose.yaml` | The two-container stack (plus the optional `backup` profile) |
| `Dockerfile` | Builds the single `waffled` image (web SPA + api) |
| `infra/backup` | The optional backup image |
| `scripts/` | `release.sh` (maintainers), `smoke-compose.sh` (CI) |
| `website/` | This docs site (Astro Starlight) |
| `docs/` | Design/product docs — `ARCHITECTURE.md`, `DATA_MODEL.md`, roadmap |

## Data flow & multi-tenancy

Everything is scoped to a **household**. A JWT carries a `household_id` claim; the resolution
chain is `sub → identity → person → household`, and that DB mapping — not the token alone — is
authoritative.

- **api:** a single global auth gate resolves the tenant from the JWT, then per-route
  [guards](/concepts/permissions/) re-assert it (`tenantRoute` / `adminRoute` / `capRoute`, and
  `moduleRoutes(key)` for optional [modules](/administration/modules/)). These are wrapper
  guards rather than middleware, so a handler receives the resolved tenant as a typed
  argument — a preference, not a limitation of the framework. API-key **scopes** are the exception: they are checked centrally in the
  gate against a path-prefix catalog, which is fail-closed — a path in no resource is
  refused to keys outright.

## No offline layer

Every client reads and writes through the REST API (chores, rewards, goals, calendar, lists,
meals, pantry, photos), kept fresh by an in-app refresh bus. There is no local database mirror
to configure: a new [module](/concepts/extensibility/) only needs routes and a migration.

## AI, pluggably

The capture bar and meal/recipe/calendar AI run through **one provider interface** — Anthropic,
any OpenAI-compatible endpoint, or a local Ollama, chosen per household. Keys live only in the
server env; the client degrades to a deterministic on-device heuristic when no provider is set. See [AI providers](/administration/ai-providers/).

## Where to go next

- Run it locally → [Local development](/developer/local-development/)
- The schema & migrations → [Database & migrations](/developer/database/)
- Add a feature → [Building a module](/concepts/extensibility/)
