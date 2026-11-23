---
title: Local development
description: Run Waffled locally for development.
---

Waffled is a monorepo, but it is **not** an npm-workspaces monorepo — there is no
root `package.json`. Each app manages its own dependencies: `apps/api` and
`apps/web` each have their own `package.json` + `package-lock.json`, and you run
`npm` **inside each directory**.

## Requirements

- **Docker** with Compose v2.24+ — the full stack runs as a two-container Compose stack.
- **Node 24** — the contributor default for running `apps/api` and `apps/web` directly.

## Two ways to develop

### 1. Full stack in Docker

The root `compose.yaml` runs the whole stack: the `waffled` app (api + the built web app) and
Postgres. This is the fastest way to get a working backend to develop against. See
[Docker install](/install/docker/) for the stack details and
[Environment variables](/install/environment-variables/) for configuration.

```bash
docker compose up -d --build   # build the waffled image from source and start the stack
docker compose logs -f waffled # tail the app logs
docker compose ps              # service status
docker compose down            # stop the stack (keeps volumes)
```

Other useful commands:

```bash
docker compose exec postgres psql -U waffled waffled          # psql shell on the database
docker compose exec -u node waffled node dist/admin.js <cmd>  # admin subcommands
docker compose exec -u node waffled node dist/seed-demo.js    # load demo data
```

### 2. Run an app directly

You can run either app on the host for a tighter edit loop. The API needs a reachable
Postgres. The compose Postgres is deliberately not published, so add a local
`compose.override.yaml` (it is picked up automatically) that publishes it:

```yaml
services:
  postgres:
    ports: ["5432:5432"]
```

Then `docker compose up -d postgres` and point `DATABASE_URL` at
`postgres://waffled:waffled@localhost:5432/waffled`.

**API** (`cd apps/api`):

```bash
npm run dev        # tsx watch src/server.ts — hot reload on :3000
npm run build      # esbuild bundle → dist/
npm start          # node dist/server.js
npm run token      # mint a dev JWT from the host
```

`npm run token` mints a JWT from the host and requires **local-auth mode** — that is,
`AUTH0_DOMAIN` unset — with the signing secret matching `LOCAL_JWT_SECRET`.

**Web** (`cd apps/web`):

```bash
npm run dev        # vite dev server with HMR at http://localhost:5173 (proxies /api, /auth, /media to :3000)
npm run build      # tsc -b && vite build
```

The **web app and the kiosk are the same build** — the kiosk is a layout / PWA
mode of the web app, not a separate bundle.

## See also

- [Architecture](/developer/architecture/) — how the pieces fit together
- [Database & migrations](/developer/database/) — schema and migration workflow
- [Docker install](/install/docker/) — the Compose stack in detail
- [Environment variables](/install/environment-variables/) — all configuration
- [Contributing](/developer/contributing/) — tests, commits, and PRs
