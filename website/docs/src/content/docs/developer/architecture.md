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

The **Mac menu-bar app** isn't a fourth surface. It runs the server on a Mac and opens the web
app; it has no UI of its own for household data.

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

## Two ways to run the same server

The server above runs in one of two ways, from the same pieces: the same api build, the same
migrations, the same PowerSync config and the same web build behind the same Caddyfile.

- **Docker Compose** — the stack above, driven by `./waffled`. This is how it runs on Linux, a
  NAS, a VPS, or a Mac with Docker.
- **Native on a Mac** — [Waffled for Mac](/install/mac/) runs the same services (Postgres, the
  one-shot migration, api, PowerSync, Caddy) as ordinary processes, with no Docker. A Go supervisor,
  `waffled-runtime` (`apps/runtime`), starts them in dependency order behind health checks,
  restarts what crashes, and runs the nightly backup. The binaries it runs (Postgres, Node,
  Caddy, PowerSync) ship inside the app, built by `infra/native/bundle/`, so nothing is needed
  from Homebrew, a system Node, or Docker. Data lives in `~/Library/Application Support/Waffled`.
  The menu-bar app (`apps/mac`) is a thin SwiftUI wrapper that shells out to `waffled-runtime`,
  and everything it does is also a `waffled-runtime` command in Terminal.

Natively there is no private Compose network: the services reach each other over loopback, on
ports picked on first run and then kept, and Caddy is what other devices on the network reach.

## Repo layout

Waffled is a monorepo, but **not** npm workspaces — `apps/api` and `apps/web` each own their
`package.json` and lockfile.

| Path | What's there |
|---|---|
| `apps/api` | The backend — `src/` (routes, platform, modules), `migrations/`, `scripts/`, `test/` |
| `apps/web` | React + Vite web app / kiosk — `src/` (incl. `src/kiosk/`) |
| `apps/ios` | SwiftUI universal app (XcodeGen) — see [iOS development](/developer/ios/) |
| `apps/mac` | The Mac menu-bar app (SwiftUI, XcodeGen) that drives `waffled-runtime` |
| `apps/runtime` | `waffled-runtime`, the Go supervisor that runs the server natively on a Mac |
| `infra/compose` | The Docker stack — `docker-compose.yml`, `caddy/`, `powersync/`, `backup/` |
| `infra/native` | `bundle/` builds the self-contained runtime directory the Mac app ships |
| `website/` | This docs site (Astro Starlight) |
| `docs/` | Design/product docs — `ARCHITECTURE.md`, `DATA_MODEL.md`, roadmap |
| `./waffled` | The operator CLI wrapping `docker compose` |

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
- The Mac app and runtime → [Working on the Mac app and runtime](/developer/local-development/#working-on-the-mac-app-and-runtime)
