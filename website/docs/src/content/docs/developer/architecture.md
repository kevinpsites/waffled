---
title: Architecture
description: How Waffled is put together — the surfaces, the stack, and the data flow.
---

A tour of how Waffled is built, for anyone who wants to contribute, extend it, or just understand
what's running. The short version: **one Postgres database is authoritative, the api is the
contract, and three independent clients consume it** — one of them offline-first.

## The three surfaces

| Surface | What it is | Tech |
|---|---|---|
| **Counter Kiosk** | Always-on kitchen tablet | The web build in fullscreen/PWA mode |
| **Web** | Full management dashboard | React + Vite SPA served by Caddy |
| **iOS** | Native capture companion / iPad kiosk | SwiftUI universal app + PowerSync |

The **Kiosk and Web are the same build** — the kiosk is a layout/PWA mode of the React SPA, not a
separate program. **iOS** is a separate native client that talks to the same api and, for the
calendar, syncs the same data offline.

## The stack

A small Docker Compose stack ([Docker install](/install/docker/) has the service-by-service
table):

```
        ┌──────────┐     /api/*      ┌─────────┐
 client │  Caddy   │ ───────────────▶│   api   │──┐
 ─────▶ │ (proxy + │                 │(lambda- │  │  DATABASE_URL
        │  web SPA)│◀── /media/* ────│   api)  │  ▼
        └──────────┘                 └─────────┘ ┌────────────┐
             ▲                            ▲      │  Postgres  │
             │ sync (JWT)                 │ JWKS │ (wal_level │
        ┌──────────┐  logical replication │      │ =logical)  │
 client │PowerSync │◀─────────────────────┼──────└────────────┘
 ─────▶ │ service  │                      │           ▲
        └──────────┘                      └── backup ─┘ nightly pg_dump
```

- **Caddy** terminates HTTP(S), serves the baked-in web SPA, proxies `/api/*` to the api, and
  serves uploaded media at `/media/*`.
- **api** (lambda-api / TypeScript, bundled with esbuild to `dist/`, on Node 20) is the whole
  backend: REST routes, auth, media writes, background jobs, and minting PowerSync tokens. Two
  entrypoints share one routes app — `server.ts` (container) and `lambda.ts` (AWS Lambda).
- **Postgres 16** is the source of truth, run with logical replication so PowerSync can mirror it.
- **PowerSync** replicates the DB into per-household buckets and serves them to offline clients;
  it validates client tokens against the api's JWKS.
- **backup** dumps Postgres nightly (see [Backup & restore](/operations/backup/)).

## Repo layout

Waffled is a monorepo, but **not** npm workspaces — `apps/api` and `apps/web` each own their
`package.json` and lockfile.

| Path | What's there |
|---|---|
| `apps/api` | The backend — `src/` (routes, platform, modules), `migrations/`, `scripts/`, `test/` |
| `apps/web` | React + Vite web app / kiosk — `src/` (incl. `src/kiosk/`) |
| `apps/ios` | SwiftUI universal app (XcodeGen) — see [iOS development](/developer/ios/) |
| `infra/compose` | The Docker stack — `docker-compose.yml`, `caddy/`, `powersync/`, `backup/` |
| `website/` | This docs site (Astro Starlight) |
| `docs/` | Design/product docs — `ARCHITECTURE.md`, `DATA_MODEL.md`, roadmap |
| `./waffled` | The operator CLI wrapping `docker compose` |

## Data flow & multi-tenancy

Everything is scoped to a **household**. A JWT carries a `household_id` claim; the resolution
chain is `sub → identity → person → household`, and that DB mapping — not the token alone — is
authoritative.

- **api:** a single global auth gate resolves the tenant from the JWT, then per-route
  [guards](/concepts/permissions/) re-assert it (`tenantRoute` / `adminRoute` / `capRoute`, and
  `moduleRoutes(key)` for optional [modules](/administration/modules/)). lambda-api has no
  per-route middleware, so authorization is wrapper guards, not path middleware.
- **PowerSync:** the sync rules define **one bucket per household** — parameters read
  `request.jwt() ->> 'household_id'`, and every data query is `WHERE household_id = … AND
  deleted_at IS NULL`. A client only ever receives its own household's rows.

## Offline-first (where it matters)

Only the **calendar/events** domain is truly offline: PowerSync mirrors it to on-device SQLite
(the browser and the iOS app), and writes queue locally and replay on reconnect. Everything else
(chores, rewards, goals, lists, meals, pantry, photos) is **online REST**, kept fresh by an
in-app refresh bus. A new [module](/concepts/extensibility/) that must work offline on iOS has to
add its tables to the PowerSync sync rules; otherwise it's REST-only.

## AI, pluggably

The capture bar and meal/recipe/calendar AI run through **one provider interface** — Anthropic,
any OpenAI-compatible endpoint, or a local Ollama, chosen per household. Keys live only in the
server env; the client degrades to a deterministic on-device heuristic when no provider is set or
you're offline. See [AI providers](/administration/ai-providers/).

## Where to go next

- Run it locally → [Local development](/developer/local-development/)
- The schema & migrations → [Database & migrations](/developer/database/)
- Add a feature → [Building a module](/concepts/extensibility/)
- The native app → [iOS development](/developer/ios/)
