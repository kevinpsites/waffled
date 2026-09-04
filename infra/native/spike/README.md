# Native macOS spike — the whole Waffled stack on one Mac, no Docker

**Throwaway.** This is Phase 1 of `docs/product/native-mac-plan.md`: a bash script that runs
Postgres 16, the API, PowerSync and Caddy as plain processes on an Apple-silicon Mac so we
could *learn* whether bundled Postgres and PowerSync-outside-Docker work before writing the
real Go runtime (Phase 2). Nothing here is meant to ship. It reuses the repo verbatim:
`infra/compose/caddy/Caddyfile`, `infra/compose/postgres/init/00-init.sql`,
`infra/compose/powersync/*.yaml`, the `apps/api` esbuild bundle + `node-pg-migrate`
migrations, and the `apps/web` Vite build.

## Verdict (2026-09-04, macOS 15.6 / M-series, Node 24.19.0)

**Both unknowns are answered yes.** The full stack — including PowerSync end-to-end
replication into a browser — runs natively, reaches green **6.0 s** after `up` on an empty
data dir (initdb + 92 migrations included) and **5.3 s** on relaunch. Steady-state RSS is
about **340 MB** for all four services. Everything the plan flagged as "prove first" worked on
the first path tried; the gotchas below are real but all small.

## How to run

```sh
# Node 24 must be first on PATH (the script prepends /opt/homebrew/opt/node@24/bin).
infra/native/spike/spike.sh fetch    # ~2-5 min: Postgres + Caddy into the cache,
                                     # clone+build powersync-service, npm ci+build api & web
infra/native/spike/spike.sh up       # postgres → init sql → migrate → api → powersync → caddy
infra/native/spike/spike.sh status   # pids, health, RSS
infra/native/spike/spike.sh logs powersync [lines]
infra/native/spike/spike.sh down
infra/native/spike/spike.sh reset    # wipes ONLY the data dir below, asks y/N
```

| What | Where |
|---|---|
| Data dir (PGDATA, media, logs, pids, `config.env`, generated `Caddyfile`) | `~/Library/Application Support/WaffledSpike/` |
| Binary cache (Postgres, Caddy, `powersync-service` clone) | `~/Library/Caches/WaffledSpike/` |
| Ports (defaults) | Caddy **8090** (web + `/api` + `/media`), PowerSync-via-Caddy **8091**; loopback-only: api 3001, PowerSync 8092, Postgres 5433 |

Every port is overridable (`SPIKE_HTTP_PORT`, `SPIKE_POWERSYNC_PORT`, `SPIKE_API_PORT`,
`SPIKE_PS_INTERNAL_PORT`, `SPIKE_PG_PORT`); `up` refuses to start on a port something else
already owns and prints the owner. On the dev Mac the live Docker stack already publishes
`0.0.0.0:8090` (its PowerSync-via-Caddy port), so the verified runs used
`SPIKE_HTTP_PORT=8095 SPIKE_POWERSYNC_PORT=8096`.

`config.env` (mode 0600) carries the same four secrets `./waffled up` generates, generated
the same way (`openssl rand -base64 48`, `-base64 32`, RSA-2048 PEM base64'd on one line,
and a *hex* Postgres password because it is interpolated into `postgres://` URLs).

## What was verified

All of the following passed on a fresh data dir (`reset` → `up` → browser), then again after
`down` → `up`:

- `curl localhost:8095/healthz` → 200, `localhost:8095/api/health` → 401 without a token and
  **200 `{"status":"ok"}`** with the admin session (it is `adminRoute`-guarded — see gotchas),
  `localhost:8092/probes/liveness` → `{"ready":true,"started":true}`, and the same through
  Caddy on `:8096`.
- Playwright (Chromium, `apps/web`'s own `@playwright/test` install) loads
  `http://localhost:8095`, gets the **first-run Setup wizard**, creates a household + admin
  through it, lands on Today, and Settings → System Health shows **Live Sync (this browser):
  `state: live`** with a `last synced` timestamp — i.e. PowerSync is connected, not "Offline".
  `GET /api/powersync/token` returns `powerSyncUrl: http://localhost:8096` (derived from the
  request host + `POWERSYNC_PORT`), so clients are pointed at the Caddy-fronted port exactly
  as with compose. Screenshots: `$CLAUDE_JOB_DIR/tmp/spike-0{1..5}-*.png` (not committed).
- PowerSync's log shows the real thing: `Created replication slot powersync_1_cb34`,
  the five published tables replicated, then `Sync stream started … powersync-js/1.54.0
  powersync-web`, `New checkpoint: 6 | buckets: 1`, `operations_synced: 6`. Postgres shows
  the `walsender … START_REPLICATION` backend.
- System Health on the same page: Database ok (pool 8), Migrations `applied: 92`, Media
  Storage `dir: ~/Library/Application Support/WaffledSpike/media, writable: true`.
- iOS simulator (stretch): see the last section.

## Findings

### Postgres — `@embedded-postgres/darwin-arm64` worked first time

- **Source that worked:** npm package `@embedded-postgres/darwin-arm64@16.14.0-beta.17`
  (`npm pack` → 48.5 MB tgz → **131 MB** unpacked). It is a repack of **EDB's** build:
  `codesign` shows `Authority=Developer ID Application: EnterpriseDB Corporation
  (26QKX55P9K)`, hardened runtime (`flags=0x10000(runtime)`), on **every** binary and dylib,
  and every Mach-O is a **universal** x86_64+arm64 fat binary (so an arm64-only slice would be
  roughly half the size). `initdb`, `pg_ctl -w start`, logical replication, `pgcrypto` and
  scram auth all just worked. No Gatekeeper prompt, no quarantine xattr (npm/tar don't set
  one; only `com.apple.provenance` is present), no dyld surprises *after* the next point.
- **Gotcha 1 — the tarball has no symlinks.** `native/lib` ships `libicui18n.68.2.dylib` etc.
  but `postgres` links `@loader_path/../lib/libicui18n.dylib`; the package's `postinstall`
  (`scripts/hydrate-symlinks.js`, driven by `native/pg-symlinks.json`) recreates the 17
  symlinks. `npm pack` + `tar` skips postinstall, so the script runs it by hand. Forget it and
  `postgres --version` dies at dyld time.
- **Gotcha 2 — no `psql`, no `pg_dump`, no `pg_isready`.** `bin/` is exactly `initdb`,
  `pg_ctl`, `postgres`. Same for the zonky jar (`embedded-postgres-binaries-darwin-arm64v8
  16.15.0`, 59 MB jar / 298 MB unpacked, identical EDB signature, also just those three).
  Consequences: (a) `00-init.sql` is run by a 50-line `sql.mjs` over the api's own `pg`
  driver that understands `\set` (ignored) and `\gexec` — enough for that file; the `CREATE
  DATABASE waffled` the `postgres:16` entrypoint does implicitly is one extra statement.
  (b) Readiness comes from `pg_ctl -w` (libpq `PQping`), which is fine. (c) **Backups need
  `pg_dump`, which neither npm nor zonky provides** — Phase 2 must take it from EDB's full
  "binaries" zip (same signer, same 16.x) or build it; see recommendations.
- `libicudata.68.2.dylib` alone is 55 MB (of 108 MB in `lib/`); `share/` is 5 MB. 37 dylibs.
- PGDATA after initdb + migrations: **74 MB**.
- `postgresql.conf` additions: `listen_addresses='127.0.0.1'`, `port=5433`,
  `unix_socket_directories=<PGDATA>` (keeps the socket out of `/tmp`, where a Homebrew
  Postgres on the same port number would collide), `wal_level=logical`,
  `max_replication_slots=10`, `max_wal_senders=10`, `password_encryption=scram-sha-256`.
  `pg_hba.conf` is scram-only for local, 127.0.0.1, ::1 and `replication`.
- Postgres RSS at steady state: postmaster 8 MB + 5 auxiliary workers ~12 MB + 8 idle
  PowerSync storage backends ~50 MB + walsender 7 MB + api backends ≈ **80-90 MB total**
  (`status` reports ~85 MB; it spikes to ~180 MB right after migrations while shared buffers
  fill).

### PowerSync — path (a), build from the `v1.22.0` tag, worked

- `git clone --depth 1 --branch v1.22.0 powersync-ja/powersync-service` (**22 MB** checkout),
  `pnpm install --frozen-lockfile`, `pnpm build:production` (the same targets the image's
  `service/Dockerfile` builds), then `node service/lib/entry.js start -r unified` with the
  repo's `service.yaml` + `sync-config.yaml` copied verbatim next to each other and only the
  `PS_*` env values changed (`PS_PORT=8092`, both URIs → `127.0.0.1:5433`,
  `PS_JWKS_URL=http://127.0.0.1:3001/api/auth/keys`). Path (b) (own entry over the npm
  packages) was never needed.
- **Build time: 27 s** for install + build on a warm pnpm store (the first `pnpm install`
  fetch is a few minutes on a cold store). **node_modules: 621 MB** with dev deps; the image
  prunes to `--prod --ignore-scripts` = **292 MB** (measured in `waffled-powersync`,
  363 pnpm packages, and that still includes the MongoDB/MySQL/MSSQL/Convex modules the
  Dockerfile compiles in). `service/lib` itself is tiny.
- **Gotcha 3 — `pnpm@9` refuses the lockfile.** The repo pins `"packageManager":
  "pnpm@11.0.9"`; `npx pnpm@9 install --frozen-lockfile` fails with
  `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH … "overrides" configuration doesn't match the value
  found in the lockfile`. `npx pnpm@11.0.9` (or corepack) works. Node 24.19 vs the image's
  24.15 made no difference.
- **One native dep, prebuilt:** `@napi-rs/snappy` resolved to its `darwin-arm64` prebuild;
  nothing compiled. No node-gyp, no Xcode toolchain needed.
- Runtime: `--max-old-space-size=1000` as in compose. RSS **~170 MB** steady (after a
  330 MB peak during the initial snapshot); `probes/liveness` answers within ~2 s of spawn.
- It creates its replication slot and bucket storage schema in `powersync_storage` on first
  start with zero manual steps beyond what `00-init.sql` + migration 0003 (the `powersync`
  publication) already do.

### Caddy — official release tarball, nothing to report

- `caddy_2.11.4_mac_arm64.tar.gz` from the GitHub release (**45 MB** thin arm64 binary,
  `Signature=adhoc, linker-signed` — i.e. **unsigned for notarization purposes**; Phase 3 has
  to sign it with our Developer ID). `curl` sets no quarantine xattr, so it ran without a
  Gatekeeper prompt; a browser download of the same file would prompt.
- The compose `Caddyfile` is used unmodified except for four `sed`s at `up` time:
  `api:3000` → `127.0.0.1:3001`, `powersync:8080` → `127.0.0.1:8092`, `root * /srv` →
  the web `dist/`, `root * /data/media` → the spike media dir. Listener addresses stay
  env-driven (`CADDY_SITE_ADDRESS=:8095`, `POWERSYNC_CADDY_ADDRESS=:8096`).
  `XDG_DATA_HOME`/`XDG_CONFIG_HOME` point into the data dir so Caddy's autosave/certs don't
  land in `~/.local`.
- **Gotcha 4 — paths with spaces.** `~/Library/Application Support/...` broke the first
  generated Caddyfile (`parsing caddyfile tokens for 'root': too many arguments`). The root
  paths must be double-quoted. Phase 2's default data dir has the same space in it.
- **Pre-existing quirk, not the spike's:** `GET /healthz` on Caddy returns the SPA's
  `index.html` (200), not `"ok"` — Caddy orders `handle` before `respond`, so the catch-all
  `handle { file_server }` wins. The Docker stack on `:8080` does exactly the same; the compose
  healthcheck only looks at the status code so nobody noticed. Harmless, but Phase 2's health
  gate should not assert on the body (or move `respond /healthz` into a `handle /healthz`).
- RSS **~40-48 MB**.

### API, migrations, web — verbatim, as expected

- `npm ci` + `npm run build` (esbuild) in `apps/api` → `dist/` **15 MB** (sourcemaps
  included; `server.js` alone ~3 MB), `node_modules` 243 MB but **unused at runtime** —
  the bundle is self-contained (only `@opentelemetry/*` and the S3 SDK are external and
  never loaded). Migrations ran via `npm run migrate` (`node-pg-migrate up`, table
  `pgmigrations`, 92 applied) in ~1.5 s; `node dist/migrate.js` — what compose runs — is the
  same runner and is what Phase 2 should call, since it needs no `node_modules`.
- `apps/web` `npm ci` + `npm run build` → `dist/` **10 MB**, served by Caddy with the SPA
  fallback + immutable asset caching from the same Caddyfile.
- Env mirrors the compose `api` service exactly (`PORT`, `DATABASE_URL`, `STORAGE_DRIVER=
  local`, `MEDIA_DIR`, `MEDIA_BASE_URL=/media`, `POWERSYNC_PORT=<public sync port>`, empty
  `POWERSYNC_PUBLIC_URL`, the three secrets) plus `BACKUP_ENABLED=false` (no backup sidecar,
  so System Health says "disabled by operator" instead of "stale") and
  `UPDATE_CHECK_ENABLED=false`.
- **Gotcha 5 — the api binds `0.0.0.0`.** `server.listen(config.port)` has no host option;
  inside Docker the private network hid that. Natively `:3001` is reachable from the LAN
  (only the port, still bearer-guarded). One-line, test-covered change for Phase 2:
  `server.listen(port, process.env.HOST ?? '127.0.0.1')` with compose keeping `0.0.0.0`.
- **Gotcha 6 — `/api/health` is admin-only** (`adminRoute`), so a naive "curl it" health
  gate sees 401. The runtime's gate should use `/healthz` on the api (unauthenticated, 200)
  and treat 401 on `/api/health` as "proxy path works".
- api RSS **~70-80 MB**.

### Numbers

| | |
|---|---|
| **Cold start, empty data dir** (`up` → all health checks green: initdb, init sql, 92 migrations, api, PowerSync, Caddy) | **6.0 s** |
| **Relaunch** with existing data dir | **5.3 s** |
| `fetch` (warm npm/pnpm caches, incl. api + web builds) | ~3 min; powersync-service install+build 27 s |
| Postgres 16.14 (EDB via npm, universal) | 48.5 MB tgz / **131 MB** on disk (lib 108 MB, of which ICU data 55 MB) |
| Caddy 2.11.4 (arm64) | **45 MB** |
| powersync-service v1.22.0 | 22 MB source, **621 MB** node_modules dev / **292 MB** prod-pruned |
| api bundle / web build | **15 MB** / **10 MB** |
| Node 24.19.0 official darwin-arm64 tarball (what Phase 2 must bundle — see below) | 52 MB download |
| Whole cache dir (`~/Library/Caches/WaffledSpike`, incl. the zonky comparison) | 884 MB |
| Data dir after first run | 74 MB |

RSS at steady state, one browser client connected (`ps -o rss`):

| Process | RSS |
|---|---|
| postgres (postmaster + workers + backends) | ~85 MB (peak ~180 MB during migrations) |
| api (`node dist/server.js`) | ~75 MB |
| powersync (`node service/lib/entry.js start -r unified`) | ~170 MB (peak ~330 MB on first snapshot) |
| caddy | ~45 MB |
| **Total** | **~375 MB** (peaks ~630 MB) |

### What did NOT work / was not done — with the exact error

- `npx pnpm@9 install --frozen-lockfile` → `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed
  with the frozen installation. The current "overrides" configuration doesn't match the value
  found in the lockfile`. Fixed by using the pinned `pnpm@11.0.9`.
- First Caddy start → `Error: adapting config using caddyfile: parsing caddyfile tokens for
  'handle_path': parsing caddyfile tokens for 'root': too many arguments; should only be a
  matcher and a path`. Fixed by quoting the root paths (space in `Application Support`).
- Spec ports 8090/8091 could not be used on this Mac: `lsof` shows `com.docker … TCP *:8090
  (LISTEN)` (the live compose stack's PowerSync port). Ran on 8095/8096 via the env
  overrides; the script defaults remain 8090/8091.
- No `pg_dump`/`psql` in either embedded-Postgres source (see Postgres gotcha 2). Not worked
  around; recorded for Phase 2.
- `/healthz` on Caddy answers with the SPA instead of `ok` (pre-existing; see Caddy above).

## Recommendations for Phase 2 (Go runtime)

1. **Postgres: use EDB's binaries, arm64-only, and take `pg_dump`/`pg_restore`/`psql` from
   EDB's full "binaries" zip** (same signer as the npm/zonky repacks, which are just EDB with
   most of `bin/` deleted). Ship `initdb`, `pg_ctl`, `postgres`, `pg_dump`, `pg_restore`,
   `pg_isready`, `psql` + `lib/` + `share/`. Thin the universal binaries with `lipo -thin
   arm64` (halves ~130 MB) and drop unneeded `share/extension` files. Re-sign everything with
   our Developer ID at packaging time — EDB's signature does not survive our bundle's
   notarization anyway. Do the `pg-symlinks.json` symlink hydration at package time, not at
   first run.
2. **Postgres bring-up in Go** is exactly what `spike.sh` does: `initdb -U <user>
   --pwfile --auth=scram-sha-256`, append the conf block, write `pg_hba.conf`, `pg_ctl -w
   start`, then `CREATE DATABASE` + `00-init.sql` over `pgx` (keep the `\gexec` handling or
   just inline the two statements — that file only creates `pgcrypto` and
   `powersync_storage`). Use `unix_socket_directories=<datadir>`.
3. **PowerSync: bundle the built `powersync-service` tree**, prod-pruned (`pnpm install --prod
   --ignore-scripts` after build, ~290 MB; could be cut further by dropping the mongo/mysql/
   mssql/convex modules from `service/package.json` before building — they're only needed for
   other backends). Run it with the bundled Node as `node service/lib/entry.js start -r
   unified` and the compose YAML files verbatim. Build it in CI at the tag, once, with
   `pnpm@<packageManager>`; never at install time on the user's Mac. `@napi-rs/snappy` needs
   its `darwin-arm64` (and `darwin-x64` for a universal app) prebuild present.
4. **Node: bundle the official nodejs.org `node-v24.x-darwin-arm64` tarball**, not Homebrew's.
   Homebrew's `node` is a 49 KB stub dynamically linked to `@rpath/libnode.137.dylib` and a
   dozen `/opt/homebrew/opt/*` dylibs — it does not relocate. The official binary is one
   static executable (~120 MB) that signs and notarizes cleanly.
5. **Caddy** is the easy one: official release tarball, sign it ourselves (it ships ad-hoc
   signed). Keep the compose `Caddyfile` byte-identical and template the four values
   (`api` upstream, `powersync` upstream, web root, media root) via env, the way
   `CADDY_SITE_ADDRESS` already is — then compose and native share one file with no `sed`.
   Quote paths. Set `XDG_DATA_HOME`/`XDG_CONFIG_HOME` into the data dir.
6. **Health gates:** api `GET /healthz` (200, no auth), PowerSync `GET /probes/liveness`
   (`ready:true`), Caddy `GET /healthz` (status only — body is the SPA), Postgres via
   `pg_ctl -w` / `pg_isready`. `/api/health` needs an admin token; leave it to System Health.
7. **Bind the api to loopback** (`HOST` env, default `127.0.0.1` natively, `0.0.0.0` in
   compose) — small api change with a test, before beta. Postgres and PowerSync already bind
   `127.0.0.1` through config.
8. **Ordering + timing:** postgres (≈0.3 s to accept connections) → init sql (≈0.2 s) →
   migrate (≈1.5 s) → api (≈1 s to `/healthz`) → powersync (≈2 s to liveness) → caddy
   (<0.5 s). The 60-second Phase 2 exit criterion has a 10× margin; the whole thing is
   I/O-bound on first `initdb`.
9. **Port collisions are real** on dev Macs (Docker's compose publishes 8080/8090; Homebrew
   Postgres takes 5432): keep the "pick the next free port, record it in `runtime.json`"
   design, and print the owner (`lsof -nP -iTCP:<port> -sTCP:LISTEN`) in the error.
10. **Secrets:** generating them in Go with `crypto/rand` + `x509.MarshalPKCS1PrivateKey`
    → PEM → base64 is equivalent to the `openssl` lines; keep the hex Postgres password rule.
11. **Memory budget:** ~400 MB steady, ~650 MB peak for the four services; PowerSync's
    `--max-old-space-size=1000` cap from compose is a sensible ceiling to keep.

## iOS simulator (stretch) — syncs end to end

Built `apps/ios` in the worktree (`xcodegen generate` + `xcodebuild … -destination
'platform=iOS Simulator,name=iPhone 17 Pro'`, `Vendor/` symlinked from the main checkout) and
launched it on a **fresh** iPhone 17 Pro simulator (iOS 26.1) with the launch-env hooks
`WAFFLED_API_URL=http://<Mac LAN IP>:8095` and a `WAFFLED_DEV_TOKEN` from `POST
/api/auth/login` against the spike:

- The app landed on Today for "Spike Household"; the api log shows the whole mobile boot
  (`/api/household`, `/api/today-layout/mobile`, … all 200 over the LAN IP) and
  `GET /api/powersync/token` → 200.
- PowerSync's log shows `Sync stream started … user_agent: powersync-swift/1.14.3 iOS/26.1`
  followed by `New checkpoint: 6 | buckets: 1`.
- Then an event was created through the REST API (as the web app would) and **6 s later the
  simulator's Today card showed "Synced natively via PowerSync · 5:00 PM"**, with the log
  showing the checkpoint advance `6 → 7` pushed to the iOS client's stream. That is the
  Phase 1 exit criterion ("the iOS simulator syncs against it") met natively.
- Gotcha 7: on a simulator that had previously signed in to another Waffled server, the
  Keychain session from that server is presented to the spike first (different
  `LOCAL_JWT_SECRET` → 401s, `POST /api/auth/refresh` → 401 → the app signs out and shows
  Login). Not a spike problem — the same happens between any two servers — but it is why the
  verification used a clean simulator. A Mac app that hands out a *new* server on the same
  LAN should expect phones to re-authenticate once.

Screenshots (not committed): `$CLAUDE_JOB_DIR/tmp/spike-ios-03-fresh-sim.png` (Today after
boot) and `spike-ios-04-after-event.png` (the event that arrived through PowerSync).
