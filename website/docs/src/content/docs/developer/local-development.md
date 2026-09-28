---
title: Local development
description: Run Waffled locally for development.
---

Waffled is a monorepo, but it is **not** an npm-workspaces monorepo — there is no
root `package.json`. Each app manages its own dependencies: `apps/api` and
`apps/web` each have their own `package.json` + `package-lock.json`, and you run
`npm` **inside each directory**. The iOS app lives in `apps/ios` (see
[iOS development](/developer/ios/)); the Mac menu-bar app and its Go runtime live in
`apps/mac` and `apps/runtime` (see [below](#working-on-the-mac-app-and-runtime)).

## Requirements

- **Docker** — the full stack runs as a Docker Compose stack.
- **Node 24** — the contributor default for running `apps/api` and `apps/web`
  directly. The production API image remains on Node 20.

## Two ways to develop

### 1. Full stack in Docker (the `./waffled` CLI)

The `./waffled` bash CLI at the repo root drives the whole Compose stack
(Postgres · PowerSync · api · Caddy). This is the fastest way to get a working
backend to develop against. See [Docker install](/install/docker/) for the full
stack details and [Environment variables](/install/environment-variables/) for
configuration.

```bash
./waffled up              # pull prebuilt GHCR images and start the stack
./waffled up --build      # build from source instead (stamps the git SHA)
./waffled down            # stop the stack
./waffled restart [svc]   # restart everything, or one service
./waffled logs [svc]      # tail logs (all services, or one)
./waffled status          # show service status
```

Web development with hot-module reload runs the Vite dev server directly against
the stack:

```bash
./waffled web             # Vite dev server with HMR at http://localhost:5173
```

Other useful verbs:

```bash
./waffled token [sub]     # mint a dev JWT inside the waffled-api container (default sub: dev|demo)
./waffled migrate         # apply migrations from the host
./waffled psql            # open a psql shell against the stack Postgres
./waffled doctor          # run health / diagnostic checks
./waffled admin <cmd>     # run an admin subcommand
```

`./waffled token` mints a development JWT by executing inside the running
`waffled-api` container, so it always uses the container's auth config.

### 2. Run an app directly

You can run either app on the host for a tighter edit loop. The API still needs
a reachable Postgres — the easiest path is to `./waffled up` the stack and run
the host API against it (point `DATABASE_URL` at the Compose Postgres on
`localhost:5432`).

**API** (`cd apps/api`):

```bash
npm run dev        # tsx watch src/server.ts — hot reload
npm run build      # esbuild bundle → dist/
npm start          # node dist/server.js
npm run token      # mint a dev JWT from the host
```

`npm run dev` needs a Postgres reachable via `DATABASE_URL`. `npm run token`
mints a JWT from the host and requires **local-auth mode** — that is,
`AUTH0_DOMAIN` unset — with the signing secret matching `LOCAL_JWT_SECRET`.

**Web** (`cd apps/web`):

```bash
npm run dev        # vite dev server
npm run build      # tsc -b && vite build
```

The **web app and the kiosk are the same build** — the kiosk is a layout / PWA
mode of the web app, not a separate bundle.

## Pointing the iOS simulator at your local stack

Launch the iOS app with these simulator child-environment variables so it talks
to your local API:

```bash
SIMCTL_CHILD_WAFFLED_API_URL=http://localhost:3000
SIMCTL_CHILD_WAFFLED_DEV_TOKEN=$TOKEN
```

Mint `$TOKEN` with `./waffled token`. Full build and run instructions are in
[iOS development](/developer/ios/).

## Working on the Mac app and runtime

[Waffled for Mac](/install/mac/) is two pieces: `apps/runtime` (`waffled-runtime`, the Go
supervisor that runs the server natively) and `apps/mac` (the SwiftUI menu-bar app that shells
out to it). You need Go (the version in `apps/runtime/go.mod`), Xcode, and XcodeGen.

```bash
# Runtime — hermetic unit tests (no bundle, no Docker)
(cd apps/runtime && go test ./...)

# Mac app — regenerate the project after adding or removing files, then test on the host Mac
(cd apps/mac && xcodegen generate && \
  xcodebuild test -project Waffled.xcodeproj -scheme Waffled -destination 'platform=macOS')
```

Always pass `-project Waffled.xcodeproj`: `apps/ios` has a scheme with the same name. To run
the app against a runtime you are changing, or to build a whole `Waffled.app` with a runtime
bundle inside it, follow **dev mode** in
[`apps/mac/README.md`](https://github.com/kevinpsites/waffled/blob/main/apps/mac/README.md).
The runtime's integration tests, which boot a real stack from a built bundle, are covered in
[`apps/runtime/README.md`](https://github.com/kevinpsites/waffled/blob/main/apps/runtime/README.md).

## See also

- [Architecture](/developer/architecture/) — how the pieces fit together
- [Database & migrations](/developer/database/) — schema and migration workflow
- [Docker install](/install/docker/) — the Compose stack in detail
- [Environment variables](/install/environment-variables/) — all configuration
- [Contributing](/developer/contributing/) — tests, commits, and PRs
