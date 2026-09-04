# Runtime bundle — `infra/native/bundle/`

The self-contained `runtime/` directory that **Waffled for Mac** ships inside
`Waffled.app/Contents/Resources/runtime/` and that the Go supervisor (`waffled-runtime`,
Phase 2 of `docs/product/native-mac-plan.md`) drives. It holds the four service binaries
(Postgres 16, Node 24, Caddy 2, the built PowerSync service), the api and web builds, the
compose config files, and a `manifest.json` with a sha256 for every file. **Nothing in it
depends on Homebrew, a system Node, or Docker at run time** — `verify` proves that by
running every entry point with an empty environment and `PATH=/usr/bin:/bin`.

`build.sh` here is the product-quality successor to the Phase 1 spike
(`infra/native/spike/`, branch `native-spike`); the spike's README is where the "why" behind
each choice was learned. Nothing under `out/` or in the cache is ever committed.

## Layout

```text
runtime/
  manifest.json          schema 1 — versions, sha256/size/mode of every file, every symlink,
                         arch, builtAt, gitSha, gitDirty (see "Manifest" below)
  bin/node               official nodejs.org binary — one static executable (116 MB)
  bin/caddy              official release binary (45 MB)
  bin/postgres/          PG 16.14, arm64 only
    bin/                 postgres, initdb, pg_ctl (EDB) + pg_dump, pg_restore, pg_isready, psql (theseus)
    lib/                 37 dylibs + 17 relative symlinks (libpq.dylib → libpq.5.dylib …), lib/postgresql/ extensions
    share/               timezone data, extension SQL, …
  api/
    dist/                esbuild bundle: server.js, migrate.js, health-cli.js, admin.js, mint-token.js, seed-demo.js (+ .map)
    migrations/          the .sql files — dist/migrate.js resolves them at ../migrations relative to itself
    package.json         name/version only; there is NO node_modules and none is needed
  powersync/             powersync-service monorepo at v1.22.0, built, prod-pruned; entry: service/lib/entry.js
  web/                   apps/web Vite build (index.html + assets/)
  config/                copied VERBATIM from infra/compose — {$VAR} placeholders and the compose
    Caddyfile            upstream names (api:3000, powersync:8080, /srv, /data/media) are left as-is;
    00-init.sql          the runtime rewrites/templating them at start, exactly like the spike did
    powersync/service.yaml
    powersync/sync-config.yaml
  licenses/              node, caddy, postgres (EDB repack + PostgreSQL COPYRIGHT), powersync-service (FSL-1.1-ALv2)
```

Two deliberate departures from the layout sketched in the task:

- **`api/dist/` is kept as a directory (not flattened to `api/server.js`)** because the bundled
  `dist/migrate.js` locates the migrations at `../migrations` relative to its own file, exactly
  as the Docker image lays it out (`/app/dist` + `/app/migrations`). No `node-pg-migrate` CLI
  or `node_modules` is shipped: `node api/dist/migrate.js` *is* the migration runner (it
  bundles `runMigrations`). Two dist entries are dropped on purpose: `lambda.js` (AWS handler)
  and `otel.js` (its `--require` preload needs the `@opentelemetry/*` node_modules the image
  stages; the bundle has none, so **the runtime must never set `NODE_OPTIONS=--require=…otel.js`**).
- **`licenses/`** was added: five upstream licence files, 180 KB, because we redistribute them.

## Building

```sh
infra/native/bundle/build.sh fetch                 # populate ~/Library/Caches/WaffledBundle (see network cost)
infra/native/bundle/build.sh build [outdir]        # assemble runtime/ (default ./out/runtime); builds api + web
infra/native/bundle/build.sh verify <outdir>       # manifest check + smoke test — THE test for this script
infra/native/bundle/build.sh clean [--all]         # rm ./out (and the cache with --all)
```

- Build host: Apple-silicon macOS with the Xcode command-line tools (`lipo`, `codesign`,
  `xxd`, `rsync`, `curl`, `shasum`, `tar` — all in the base system + CLT). **No Node, npm or
  pnpm needs to be installed**: `fetch` downloads the bundled Node first and then uses *that*
  Node (and its npm/npx) for everything — symlink hydration, `npx pnpm@11.0.9`, `npm ci`,
  `npm run build` for api and web, and the manifest.
- Env: `WAFFLED_BUNDLE_CACHE` (default `~/Library/Caches/WaffledBundle`),
  `WAFFLED_BUNDLE_SEED` (default `~/Library/Caches/WaffledSpike` — when the Phase 1 spike's
  cache exists its EDB tgz, Caddy tarball and built `powersync-service` clone are copied instead
  of downloaded), `WAFFLED_BUNDLE_NO_NETWORK=1` (die instead of downloading),
  `WAFFLED_BUNDLE_NPM_CI=1` (force `npm ci` for api/web even if `node_modules` exists), and
  `WAFFLED_{NODE,PG_NPM,PG_CLIENT,CADDY,POWERSYNC}_VERSION` to override a pin.
- Pins live at the top of `build.sh`: Node **24.19.0** (major must match `.nvmrc`), Postgres
  **`@embedded-postgres/darwin-arm64@16.14.0-beta.17`** (server) + **theseus 16.14.0** (client
  tools), Caddy **2.11.4**, PowerSync **v1.22.0** (= the compose image tag), pnpm **11.0.9**.
- Every download is checksum-verified against the publisher's file: nodejs.org
  `SHASUMS256.txt`, Caddy's `caddy_<v>_checksums.txt` (SHA-512), theseus' `.tar.gz.sha256`.
  The EDB tgz has no publisher checksum (npm's integrity is implied by `npm pack`).
- `fetch` is idempotent; the PowerSync step is stamped (`.waffled-prod-pruned`) and skipped on
  re-runs. `build` always starts from an empty outdir and always rebuilds api + web from the
  checked-out source (so the bundle's `waffledVersion` is whatever the tree says).

**How CI will do it** (Phase 3 packaging job, macOS arm64 runner): `build.sh fetch && build.sh
build "$RUNNER_TEMP/runtime" && build.sh verify "$RUNNER_TEMP/runtime"`, with
`WAFFLED_BUNDLE_CACHE` under `actions/cache` keyed on the pins. Then codesign every Mach-O in
the tree with the Developer ID (Postgres dylibs and Caddy included — EDB's signature does not
survive our notarization and Caddy ships ad-hoc signed), embed under
`Resources/runtime/`, and notarize. Signing changes the bytes, so **the manifest must be
written after signing** — CI should re-run `node manifest.mjs write` (or `build.sh` grows a
`sign` step) after codesign and `verify` once more.

## Components, sources, sizes (measured build, 2026-09-04, `a506c352`)

| Component | Source | Version | In bundle | Notes |
|---|---|---|---|---|
| Node | `https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz` | 24.19.0 | **116 MB** | One static binary. Homebrew's node is a 49 KB stub linked to `/opt/homebrew/...` dylibs — never bundle it. |
| Postgres server | npm `@embedded-postgres/darwin-arm64@16.14.0-beta.17` (EDB's build, Developer ID signed, universal) | 16.14 | **69 MB** (bin 10, lib 54, share 5) | 131 MB unpacked → 69 MB after `lipo -thin arm64` on 112 fat Mach-O files. ICU data alone is 27 MB (was 55). 17 lib symlinks recreated from the package's `pg-symlinks.json`. |
| Postgres client tools | `https://github.com/theseus-rs/postgresql-binaries/releases/download/16.14.0/postgresql-16.14.0-aarch64-apple-darwin.tar.gz` | 16.14.0 | (in the 69 MB, ~1.5 MB) | `pg_dump`, `pg_restore`, `pg_isready`, `psql` — the npm repack ships none of them, EDB's full zip is ~300 MB. theseus is a complete arm64 build of the *same minor*; its tools link `@loader_path/../lib/libpq.5.dylib` (+ `libcrypto.3.dylib`), which EDB's `lib/` provides, so they drop into the same `bin/`. Ad-hoc signed (re-signed in Phase 3 anyway). |
| Caddy | `https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_mac_arm64.tar.gz` | 2.11.4 | **45 MB** | Ad-hoc signed upstream. |
| api | `apps/api` (esbuild, `npm run build`) | 0.14.3 | **11 MB** | dist 10 MB incl. sourcemaps (server.js ≈ 3 MB), 92 migrations 0.4 MB. |
| web | `apps/web` (Vite, `npm run build`) | 0.14.3 | **10 MB** | |
| PowerSync | `https://github.com/powersync-ja/powersync-service` @ `v1.22.0`, `pnpm build:production`, then `pnpm install --prod --ignore-scripts --filter '@powersync/service-image...'` | 1.22.0 | **402 MB** (node_modules 381 MB, 1,321 symlinks) | Dev node_modules **619 MB** → prod-pruned **383 MB** (the compose image measures 292 MB on Linux; the darwin-arm64 native prebuilds — rolldown 19 MB, esbuild 10, lightningcss 9, snappy, zstd — account for most of the difference). |
| config | `infra/compose/{caddy/Caddyfile, postgres/init/00-init.sql, powersync/*.yaml}` | — | 16 KB | byte-identical; `verify` diffs them against the repo. |
| licenses | upstream | — | 180 KB | |
| manifest.json | generated | schema 1 | **8.5 MB** | 36,456 files + 1,338 symlinks (35k of them are PowerSync's node_modules). |
| **Total** | | | **662 MB** (677,392 KiB) | |

What weighs what: PowerSync 61 %, Node 18 %, Postgres 10 %, Caddy 7 %, ours 3 %.

### Network cost

**This build** (on the dev Mac, spike cache present): **61.4 MiB downloaded** — Node tarball
52,234,372 B + `SHASUMS256.txt` 3 KB; theseus tarball 12,101,670 B + `.sha256` 113 B; Caddy
`checksums.txt` 6.8 KB. Reused from the spike cache without network: the EDB tgz (50.8 MB),
the Caddy tarball (16.4 MB), the `powersync-service` clone (21 MB). The dev+prod pnpm installs
and `npm ci` for api/web were served from the local pnpm store / npm cache (`downloaded 0`).

**Cold build** (CI, empty caches): Node 52 MB + EDB tgz 51 MB (`npm pack`) + theseus 12 MB +
Caddy 16 MB + PowerSync clone ~22 MB + PowerSync dev `pnpm install` (619 MB unpacked, roughly
150-200 MB compressed) + `npm ci` for api and web (243 MB + ~400 MB unpacked). Budget ≈ 0.5-1 GB
and ~5 minutes; the PowerSync `tsc -b` build itself is 23 s on an M-series Mac.

### The verify run that produced the table above

```text
verifying /Users/kevinsites/.claude/jobs/2b0cdbaf/tmp/runtime
── manifest
✓ manifest ok — 36456 files + 1338 symlinks, 580 MB, arm64/darwin, built 2026-09-04T23:48:42.438Z from a506c3526 (dirty)
  node 24.19.0 · postgres 16.14 (+4 client tools 16.14.0) · caddy 2.11.4 · powersync 1.22.0 · api 0.14.3 · web 0.14.3
── binaries (env -i, PATH=/usr/bin:/bin)
✓ node --version v24.19.0
✓ caddy version v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=
✓ postgres/bin/postgres --version postgres (PostgreSQL) 16.14
✓ postgres/bin/initdb --version initdb (PostgreSQL) 16.14
✓ postgres/bin/pg_ctl --version pg_ctl (PostgreSQL) 16.14
✓ postgres/bin/pg_dump --version pg_dump (PostgreSQL) 16.14
✓ postgres/bin/pg_restore --version pg_restore (PostgreSQL) 16.14
✓ postgres/bin/pg_isready --version pg_isready (PostgreSQL) 16.14
✓ postgres/bin/psql --version psql (PostgreSQL) 16.14
✓ all Mach-O files under bin/ are single-arch
── api (bundled node, no node_modules)
✓ api server.js loads, refuses without secrets /Users/kevinsites/.claude/jobs/2b0cdbaf/tmp/runtime/api/dist/server.js:26
✓ api migrate.js fails on missing DATABASE_URL migrate: DATABASE_URL is not set
✓ api health-cli.js loads {"status":"down","version":{"pkg":"0.14.3","sha":"dev","buildTime":null},"generatedAt":"20
✓ api/migrations present
✓ api migrations present (≥ 90 .sql files) 92
── powersync
✓ powersync entry.js --help info: Successfully registered Module Core.
✓ powersync native addon @napi-rs/snappy-darwin-arm64 loads ok
── web + config
✓ web/index.html present
✓ config/Caddyfile present
✓ config/00-init.sql present
✓ config/powersync/service.yaml present
✓ config/powersync/sync-config.yaml present
✓ config/ is byte-identical to infra/compose
── sizes
  116M	bin/node
   69M	bin/postgres
   45M	bin/caddy
   11M	api
  402M	powersync
   10M	web
   16K	config
  180K	licenses
  8.5M	manifest.json
  662M	total

✓ verify: 24 checks passed
```

What the smoke test asserts, and why those particular commands:

- Every check runs `env -i PATH=/usr/bin:/bin HOME=<tmp>` from the runtime dir — no Homebrew,
  no nvm, no repo `node_modules`. A `dyld: Library not loaded` or `Cannot find module` anywhere
  fails the check even if the exit code looked right.
- `NODE_ENV=production bin/node api/dist/server.js` with no secrets must exit 1 with `Invalid
  production secrets` — that error is thrown *after* every module in the bundle has resolved,
  so it proves the api is self-contained without opening a port. (`bin/node api/dist/server.js`
  *without* `NODE_ENV=production` would happily listen on :3000 with DB-free routes — the
  runtime must always set `NODE_ENV=production`.) `bin/node api/dist/migrate.js` must exit 1
  with `DATABASE_URL is not set`.
- `bin/node powersync/service/lib/entry.js --help` must list `start [options]`, and the one
  native addon (`@napi-rs/snappy-darwin-arm64`, used by mongodb) must `require()` — it is the
  only thing in the tree that could be the wrong architecture.
- `lipo -archs` on every Mach-O under `bin/` must report a single arch.
- The manifest check is exhaustive: missing, extra, or changed files; missing, extra, or
  retargeted symlinks; the owner-exec bit; and that `arch`/`platform` match the machine. It was
  negative-tested (appended a byte to `config/Caddyfile`, added `api/extra.txt`, removed
  `bin/postgres/lib/libpq.dylib` → `✗ manifest: 3 problem(s)`, exit 1; restored → clean).

## Manifest (`manifest.json`, schema 1)

```json
{
  "schema": 1, "name": "waffled-runtime", "arch": "arm64", "platform": "darwin",
  "builtAt": "2026-09-04T23:48:42.438Z", "gitSha": "a506c352…", "gitDirty": false, "waffledVersion": "0.14.3",
  "components": {
    "node":      { "version": "24.19.0", "path": "bin/node", "source": "https://nodejs.org/dist/…" },
    "postgres":  { "version": "16.14", "path": "bin/postgres", "source": "npm:@embedded-postgres/darwin-arm64@16.14.0-beta.17 (EDB build, thinned to arm64)",
                   "clientTools": { "tools": "pg_dump pg_restore pg_isready psql", "version": "16.14.0", "source": "https://github.com/theseus-rs/…" } },
    "caddy":     { "version": "2.11.4", "path": "bin/caddy", "source": "…" },
    "api":       { "version": "0.14.3", "path": "api", "serve": "api/dist/server.js", "migrate": "api/dist/migrate.js", "migrations": "api/migrations" },
    "powersync": { "version": "1.22.0", "path": "powersync", "entry": "powersync/service/lib/entry.js", "source": "https://github.com/powersync-ja/powersync-service@v1.22.0" },
    "web":       { "version": "0.14.3", "path": "web" },
    "config":    { "path": "config", "source": "infra/compose (verbatim)" }
  },
  "fileCount": 36456, "symlinkCount": 1338, "totalBytes": 580000000,
  "files":    { "api/dist/server.js": { "sha256": "…", "size": 3012345, "mode": "644" }, "…": {} },
  "symlinks": { "bin/postgres/lib/libpq.dylib": "libpq.5.dylib", "powersync/service/node_modules/@powersync/service-core": "../../../packages/service-core", "…": "" }
}
```

Paths are POSIX, relative to the runtime root, sorted; `manifest.json` itself is not listed.
`mode` is the octal permission bits; only the owner-exec bit is load-bearing at verify time.
Symlinks are recorded as link targets and never followed. `manifest.mjs verify <dir>` is the
reference implementation (~60 lines) for the Go port.

## Contract for `waffled-runtime` (Phase 2, task 4) — what the layout means at run time

1. **Refuse to start unless the manifest verifies** (same algorithm as `manifest.mjs verify`:
   set equality on files and symlinks, sha256 per file, exec bit, `arch == runtime.GOARCH`,
   `platform == darwin`). Hash the tree once per install (cache by `builtAt` + `gitSha`), not on
   every launch — 36k files / 580 MB takes a few seconds.
2. **Preserve symlinks** whenever the tree is copied, moved or verified. Postgres will not load
   (`dyld: Library not loaded: @loader_path/../lib/libicui18n.dylib`) without the 17 in
   `bin/postgres/lib`, and PowerSync will not resolve a single import without pnpm's 1,321.
   All targets are relative, so the tree relocates as a whole.
3. **Postgres:** `bin/postgres/bin/{initdb,pg_ctl,postgres}` for bring-up exactly as the spike
   (`initdb -U <user> --pwfile … --auth=scram-sha-256 --encoding=UTF8 --locale=C`, append the
   conf block, write `pg_hba.conf`, `pg_ctl -w -t 60 start`); `pg_isready -h 127.0.0.1 -p <port>`
   for the health gate (or keep `pg_ctl -w`); `pg_dump`/`pg_restore` for backup/restore
   (`backup_runs` rows as the compose sidecar writes them); `psql` is there for `doctor`/support
   and could run `00-init.sql` directly (`psql -v ON_ERROR_STOP=1 -f config/00-init.sql` — it
   understands `\set` and `\gexec`, so the spike's `sql.mjs` workaround is no longer needed;
   `CREATE DATABASE <POSTGRES_DB>` still has to be issued first, as the `postgres:16` entrypoint
   does implicitly). Set `unix_socket_directories=<PGDATA>` and `listen_addresses='127.0.0.1'`.
   Binaries find their `lib/` and `share/` via `@loader_path` / compiled-in relative paths —
   no `DYLD_*` or `PGSHAREDIR` env needed, as long as `bin/`, `lib/`, `share/` stay siblings.
4. **api:** `bin/node api/dist/migrate.js` (env `DATABASE_URL`), then `bin/node
   api/dist/server.js` with the compose `api` env (`NODE_ENV=production`, `PORT`,
   `DATABASE_URL`, `STORAGE_DRIVER=local`, `MEDIA_DIR`, `MEDIA_BASE_URL=/media`,
   `POWERSYNC_PORT=<public sync port>`, the three secrets, `BACKUP_ENABLED=false`,
   `UPDATE_CHECK_ENABLED=false`) **plus `GIT_SHA`/`BUILD_TIME` from the manifest** so `/healthz`
   and System Health report provenance (the image sets these at build; natively `health-cli`
   shows `"sha":"dev"` until the runtime passes them). Never set `NODE_OPTIONS=--require`
   (`otel.js` is not shipped). cwd is irrelevant; paths are resolved from `__dirname`.
   Health gate: `GET /healthz` (200, unauthenticated) — `/api/health` is admin-only (401).
   The api still binds `0.0.0.0` (spike gotcha 5) until the `HOST` change lands.
5. **PowerSync:** `bin/node --max-old-space-size=1000 powersync/service/lib/entry.js start -r
   unified` with `POWERSYNC_CONFIG_PATH=<dir>/service.yaml`, `PS_PORT`, `PS_DATA_SOURCE_URI`,
   `PS_STORAGE_SOURCE_URI`, `PS_JWKS_URL` — the compose `powersync` service verbatim.
   `service.yaml` references `sync-config.yaml` by relative path, so copy **both** files from
   `config/powersync/` into the data dir (or point `POWERSYNC_CONFIG_PATH` at
   `config/powersync/service.yaml` inside the bundle, which is read-only and fine). Health:
   `GET /probes/liveness` → `{"ready":true,…}` (~2 s after spawn). It also writes a
   `.probes/` directory in its cwd (the image pre-creates `/app/.probes`) — run it with cwd in
   the data dir, not inside the read-only bundle.
6. **Caddy:** `bin/caddy run --config <generated Caddyfile> --adapter caddyfile`, with
   `XDG_DATA_HOME`/`XDG_CONFIG_HOME` pointed into the data dir. The bundled
   `config/Caddyfile` is the compose one; the runtime substitutes `api:3000` →
   `127.0.0.1:<api port>`, `powersync:8080` → `127.0.0.1:<ps port>`, `root * /srv` → the
   bundle's `web/`, `root * /data/media` → the media dir, and sets `CADDY_SITE_ADDRESS` /
   `POWERSYNC_CADDY_ADDRESS`. **Quote the root paths** — the default data dir
   (`~/Library/Application Support/Waffled`) has a space (spike gotcha 4). Health: `GET
   /healthz` status only — the body is the SPA (pre-existing quirk).
7. **Read-only bundle.** Nothing writes into `runtime/` (an app bundle is read-only after
   signing). Everything mutable — PGDATA, media, logs, pids, `.probes`, Caddy state, generated
   Caddyfile — lives in the data dir.
8. **Versions come from the manifest**, not from running `--version` at start; `status --json`
   should surface `components.*.version` and `waffledVersion`.

## Gotchas carried over from the spike (all handled by `build.sh`)

- **No symlinks in the EDB npm tarball** → `postgres` dies at dyld time. Recreated at build from
  `pg-symlinks.json` (relative), never at first run.
- **No `psql`/`pg_dump`/`pg_isready` in the npm or zonky repacks** → taken from theseus (above).
- **Homebrew's node does not relocate** → official tarball, verified against `SHASUMS256.txt`.
- **`pnpm@9` refuses the lockfile** (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`) → `npx pnpm@11.0.9`.
- **`@napi-rs/snappy`** must be the darwin-arm64 prebuild → `--ignore-scripts` is fine (prebuilt),
  and `verify` loads the `.node` file.
- Caddy ships **ad-hoc signed**; EDB binaries carry EDB's Developer ID — both get re-signed by
  us in Phase 3, which is also why the manifest has to be regenerated after signing.

New gotchas found while writing this script:

- **pnpm aborts without a TTY** when a previous install used a different filter/prod setting
  (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`) → run pnpm with `CI=true` and `rm -rf`
  every `node_modules` before each install, as the Dockerfile does.
- **`tsc -b` trusts a stale `tsconfig.tsbuildinfo`** and reports `Done` without emitting when a
  package's `lib/` was deleted → `*.tsbuildinfo` are removed before `build:production`.
- **`pnpm deploy --legacy`** re-resolves the dependency graph (needs registry metadata, cannot run
  `--offline`, and would drift from the lockfile) → not used; `pnpm install --prod --filter
  '@powersync/service-image...'` keeps the lockfile authoritative.
- **`lipo -thin` keeps the arm64 slice's signature valid** (signatures are per-slice), so thinned
  EDB binaries still run under the hardened runtime with no re-sign needed for local testing.
- `xattr -c` is applied to everything under `bin/` so a `com.apple.provenance`/quarantine flag
  from a browser download can never leak into the bundle.

## Stubs / TODOs

- **None of the task's "may stub" items were stubbed** — the pg client tools were resolved via
  theseus (12 MB) instead of the ~300 MB EDB zip.
- **Size (662 MB).** The two levers, in order: (1) build PowerSync **without the MongoDB,
  MySQL, MSSQL and Convex modules** — remove them from `service/package.json` +
  `service/src/util/modules.ts` before `build:production`; `node-sql-parser` (87 MB, mysql) and
  `@azure/*` (~35 MB, mssql) alone are 30 % of node_modules — expected to land around 230 MB.
  Deliberately *not* done here because it forks upstream source; needs its own PR with the spike's
  end-to-end sync test re-run. (2) Drop api sourcemaps (−7 MB) — cheap but they make production
  stack traces readable; keep for now.
- **Postgres could come entirely from theseus** (a complete arm64 PG 16.14 in 40 MB, no lipo, no
  symlink hydration, all tools). Not switched because the spike verified EDB's build end to end
  (logical replication, pgcrypto, scram) and this task only adds client tools; worth a
  spike-level check before Phase 3 since it would also remove the mixed-signer question.
- **Signing / notarization** is Phase 3; `build.sh` has no `sign` step yet (see "How CI will do
  it" for the ordering constraint with the manifest).
- **Universal (x86_64) bundle** — out of scope (plan §7 "Later"); `ARCH` is a constant, the
  theseus and Node sources both publish x86_64 artifacts, EDB's are universal already.
- `manifest.json` is 8.5 MB because PowerSync has 35k files. Acceptable; if it ever matters,
  hash `powersync/node_modules` as one Merkle root instead.
