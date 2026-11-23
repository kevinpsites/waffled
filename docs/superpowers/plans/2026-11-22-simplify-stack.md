# Simplify the Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker compose up -d` from a fresh clone runs Waffled as two containers (`waffled` + `postgres`) with no `.env` and no helper script; Mac app, Go runtime, iOS app, PowerSync, Caddy and the `./waffled` CLIs are gone.

**Architecture:** The api's Node HTTP server also serves the built SPA and `/media`. A new `start.ts` entrypoint loads/creates secrets in `/data/secrets.json`, runs migrations, then boots the existing `server.ts`. The web app reads events only through REST. One root `Dockerfile` builds web + api.

**Tech Stack:** Node 20 (api runtime) / Node 24 (web build), TypeScript, lambda-api, node-pg-migrate, Vite/React, Vitest + `@testcontainers/postgresql`, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-22-simplify-stack-design.md`

## Global Constraints

- Image: `ghcr.io/evan-ribbey/waffled`. Compose project `name: waffled`; volume keys `pgdata`, `waffled_media`, `waffled_data` (so old `waffled_pgdata` / `waffled_waffled_media` are reused).
- Postgres defaults `waffled`/`waffled`/`waffled`, each overridable via `POSTGRES_USER|PASSWORD|DB`; Postgres port never published. Compose keeps `-c wal_level=logical` for 0.16.x.
- Host port `${HTTP_PORT:-8080}` → container `3000`.
- Secrets file `/data/secrets.json` holds `LOCAL_JWT_SECRET` (base64 of 48 random bytes) and `TOKEN_ENCRYPTION_KEY` (base64 of 32 random bytes). Env values always win; never rotated.
- `TRUST_PROXY` default off. `PUBLIC_BASE_URL` (existing) overrides the OAuth origin.
- `BACKUP_ENABLED` default `false`. `UPDATE_CHECK_REPO` default `evan-ribbey/waffled-remix`. Release version 0.16.0 (cut later by `scripts/release.sh`, not in this branch).
- Next migration number: `0107`. Never edit applied migrations.
- Repo rules: TDD (failing test first), integration tests preferred, comments ≤6 lines and no history narration, no backticks in SQL comments inside JS template literals, one commit per task, CHANGELOG `[Unreleased]` entry, docs in the same PR.

## Review Focus

1. **Path traversal on `/media` and the SPA** (`/media/../secrets.json`, encoded `%2e%2e`): must 404, never read outside the root. Test in Task 2.
2. **Fresh DB with no PowerSync objects:** migration 0107 must be a no-op (no publication, no slots). Test in Task 4.
3. **Unwritable or corrupt `/data/secrets.json`:** startup must fail loudly with a clear message, not silently mint new keys over a corrupt file. Test in Task 1.
4. **Spoofed `X-Forwarded-For` with `TRUST_PROXY` unset:** rate-limit bucket keys on the socket address. Test in Task 3.
5. **Deep link refresh** (`/meals/recipe/123/cook`) and unknown `/api/nope`: SPA fallback serves `index.html` for the first, JSON 404 for the second (never `index.html` for `/api/*` or `/auth/*`). Test in Task 2.

---

### Task 1: Secrets bootstrap and `start.ts` entrypoint

**Files:**
- Create: `apps/api/src/platform/secrets.ts`, `apps/api/src/start.ts`
- Modify: `apps/api/esbuild.config.mjs` (add `start: 'src/start.ts'`), `apps/api/src/platform/config.ts:29-60` (drop `POWERSYNC_JWT_PRIVATE_KEY` from `assertProductionSecrets`; message no longer mentions `./waffled`)
- Test: `apps/api/test/secrets.unit.test.ts`, update `apps/api/test/production-secrets.test.ts`

**Interfaces:**
- Produces: `loadOrCreateSecrets(dataDir: string, env: NodeJS.ProcessEnv): void` — sets missing `env.LOCAL_JWT_SECRET` / `env.TOKEN_ENCRYPTION_KEY` from (or into) `${dataDir}/secrets.json` (mode 0600). `dist/start.js`: `loadOrCreateSecrets(process.env.DATA_DIR ?? '/data', process.env)` → `runMigrations(DATABASE_URL)` (existing `src/migrate.ts`) → `await import('./server')`. Config must not be imported before secrets are set (dynamic import only).

- [ ] **Step 1: Write failing tests** in `secrets.unit.test.ts` (tmp dir per test):
  - `creates secrets.json with both keys when absent`: after call, file exists, `Buffer.from(env.TOKEN_ENCRYPTION_KEY,'base64').length === 32`, `env.LOCAL_JWT_SECRET.length >= 32`, file mode `& 0o777 === 0o600`.
  - `reuses existing file`: two calls with fresh env objects yield identical values.
  - `env wins over file`: env preset `LOCAL_JWT_SECRET='x'.repeat(40)` stays; file unchanged for that key.
  - `corrupt file throws`: file contents `{not json` → throws `/secrets\.json/`; file not overwritten.
  - `unwritable dir throws` with a message naming the path.
- [ ] **Step 2:** `cd apps/api && npx vitest run test/secrets.unit.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `secrets.ts` with `node:crypto.randomBytes`; write via temp file + rename.
- [ ] **Step 4:** Update `production-secrets.test.ts`: remove PowerSync-key cases; assert a valid prod env without `POWERSYNC_JWT_PRIVATE_KEY` passes. Run → FAIL, then edit `config.ts`, run → PASS.
- [ ] **Step 5:** Add `start.ts` + esbuild entry; `npm run build && ls dist/start.js`.
- [ ] **Step 6:** `npx vitest run test/secrets.unit.test.ts test/production-secrets.test.ts && npm run typecheck` → PASS.
- [ ] **Step 7:** Commit `feat(api): generate secrets on first boot and migrate on start`.

### Task 2: Serve the SPA and media from the api server

**Files:**
- Create: `apps/api/src/platform/static.ts`
- Modify: `apps/api/src/platform/http-server.ts` (`createHttpServer(api, opts?: { webRoot?: string; mediaRoot?: string })`; static layer runs before body buffering for GET/HEAD)
- Modify: `apps/api/src/server.ts` (pass `webRoot: process.env.WEB_ROOT ?? '/app/web'`, `mediaRoot: config.media dir`)
- Test: `apps/api/test/static-serving.integration.test.ts`

**Interfaces:**
- Produces: `serveStatic(req, res, opts): Promise<boolean>` (true = handled). Routing: `/api/*`, `/auth/*`, `/healthz` → never static. `/media/<path>` → file under `mediaRoot`, `Cache-Control: public, max-age=31536000, immutable`, 404 if missing. Else: existing file under `webRoot` → served (`/assets/*` immutable; `index.html`, `sw.js`, `asset-manifest.json` → `Cache-Control: no-cache`), otherwise `index.html`. Correct `content-type` for html/js/css/json/svg/png/jpg/webp/woff2/webmanifest.

- [ ] **Step 1: Write failing tests** — start `createHttpServer(fakeApi, { webRoot, mediaRoot })` on port 0 with tmp dirs (`index.html`, `assets/app.abc.js`, `sw.js`, `media/h1/a.jpg`); `fakeApi.run` returns `{statusCode: 404, body: '{"error":"NotFound"}'}`:
  - `GET /` → 200 html, `cache-control: no-cache`.
  - `GET /meals/recipe/123/cook` → 200, body equals index.html.
  - `GET /assets/app.abc.js` → 200 `text/javascript`, immutable.
  - `GET /sw.js` → no-cache.
  - `GET /media/h1/a.jpg` → 200 `image/jpeg`, immutable; `GET /media/h1/missing.jpg` → 404.
  - `GET /media/../secrets.json`, `/media/%2e%2e/secrets.json`, `/%2e%2e/secrets.json` → 404 / index.html, never file contents (place a `secrets.json` beside the roots).
  - `GET /api/nope` and `GET /auth/microsoft/calendar/callback` → reach `fakeApi` (JSON body), not index.html.
  - `HEAD /` → 200, empty body.
- [ ] **Step 2:** `npx vitest run test/static-serving.integration.test.ts` → FAIL.
- [ ] **Step 3:** Implement with `node:fs/promises` + `path.resolve` and a `startsWith(root + sep)` containment check after `decodeURIComponent`.
- [ ] **Step 4:** Run → PASS; also `npx vitest run test/http-server.test.ts` (unchanged behaviour) → PASS.
- [ ] **Step 5:** Commit `feat(api): serve the web app and media from the api`.

### Task 3: `TRUST_PROXY` for forwarded headers

**Files:**
- Modify: `apps/api/src/platform/http-server.ts:42-51` (`clientAddress(req, trustProxy: boolean)`), `apps/api/src/platform/config.ts` (`trustProxy: env('TRUST_PROXY') === 'true'`), `apps/api/src/modules/auth/oidc.ts:155-165` (use `x-forwarded-proto/host` only when `config.trustProxy`; `PUBLIC_BASE_URL` still wins)
- Test: update `apps/api/test/proxy-client-address.test.ts`, `apps/api/test/rate-limit.integration.test.ts`, `apps/api/test/oidc.integration.test.ts`

- [ ] **Step 1: Failing tests:**
  - `ignores X-Forwarded-For when TRUST_PROXY unset`: two requests with different spoofed XFF from the same socket share one login rate-limit bucket (third attempt → 429 with the existing limit config used in that file).
  - `honours X-Forwarded-For when TRUST_PROXY=true` (existing expectation, now gated).
  - OIDC: with TRUST_PROXY unset and headers `x-forwarded-host: evil.example`, redirect origin uses the `Host` header; with `PUBLIC_BASE_URL=https://w.example` it uses that.
- [ ] **Step 2:** Run those files → FAIL.
- [ ] **Step 3:** Implement; replace the Caddy comment in `clientAddress` with a one-line why.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `fix(api): only trust forwarded headers when TRUST_PROXY is set`.

### Task 4: Remove PowerSync from the api + cleanup migration

**Files:**
- Create: `apps/api/migrations/0107_drop_powersync.sql`
- Delete: `apps/api/src/modules/powersync/`, `apps/api/test/powersync-{auth,crud,replication}.integration.test.ts`
- Modify: `apps/api/src/app.ts` (route registration, `/api/auth/keys` public path), `apps/api/src/modules/api-keys/api-keys.ts` (powersync prefixes in scope lists), `apps/api/src/migrate.ts` (any PowerSync references), `apps/api/package.json` (drop now-unused deps, e.g. `jose` only if unused elsewhere — check with grep)
- Test: `apps/api/test/drop-powersync-migration.integration.test.ts`; `apps/api/test/api-keys.integration.test.ts` meta-test stays green

**Interfaces:** 0107 Up: `drop publication if exists powersync;` drop every slot from `pg_replication_slots` where `slot_type = 'logical'` and `slot_name like 'powersync%'` and not `active`; `alter table ... replica identity default` for `events`, `event_participants`, `event_occurrences`. Down: comment-only no-op (re-creating PowerSync objects is not supported).

- [ ] **Step 1: Failing test:** fresh DB, run migrations to 0106, create a logical slot `powersync_1_test` via `pg_create_logical_replication_slot('powersync_1_test','pgoutput')` (container started with `-c wal_level=logical`), then run all migrations → `pg_publication` has no `powersync`, `pg_replication_slots` has no `powersync%`, `pg_class.relreplident` for the three tables is `'d'`. Second case: fresh DB through 0107 with no slot → succeeds.
- [ ] **Step 2:** Run → FAIL (migration missing).
- [ ] **Step 3:** Write 0107; delete module + tests; fix imports.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run check:migrations` → PASS (testcontainers needs Docker; shared PG must start with `wal_level=logical` only for this test — if the global container lacks it, this test starts its own `PostgreSqlContainer` with that command).
- [ ] **Step 5:** Commit `refactor(api): remove PowerSync and drop its replication objects`.

### Task 5: Remove PowerSync from the web app

**Files:**
- Delete: `apps/web/src/lib/powersync/`, `apps/web/src/kiosk/components/SyncHealthBanner.{tsx,test.tsx}`
- Modify: `apps/web/src/lib/api/events.ts` (REST-only; keep every exported hook/function name and signature), `apps/web/src/lib/api/auth.ts`, `apps/web/src/main.tsx`, `apps/web/src/lib/pwa.ts`, `apps/web/src/kiosk/{EventDetail,Settings}.tsx`, `apps/web/src/kiosk/components/{CaptureBar,EventModal,cal-utils}.tsx|ts`, `apps/web/src/kiosk/planning/steps/ConnectionStep.tsx`, `apps/web/vite.config.ts` (drop `optimizeDeps` exclude; dev proxy target → `http://localhost:3000`, keep forwarded-header injection), `apps/web/package.json` (remove `@powersync/*`)
- Test: update `apps/web/src/lib/api/events.fallback.test.tsx` → rename `events.test.tsx` asserting REST reads; update `EventModal.rhythm.test.tsx`, `ConnectionStep.test.tsx`, `Settings.test.tsx`, `pwa.offline-grace.test.tsx`

- [ ] **Step 1:** Rewrite `events.test.tsx` to assert: agenda/day/range hooks call `GET /api/events?...` and refetch on the `events` bus topic; create/update/delete call `POST/PATCH/DELETE /api/events[/:id]` then publish `events`. Run → FAIL (still reads local DB).
- [ ] **Step 2:** Make `events.ts` REST-only; replace `events-local` create/update/delete call sites with the REST functions.
- [ ] **Step 3:** Remove sync-health UI from Settings and banners; drop PowerSync connect/disconnect from `main.tsx` and `auth.ts`.
- [ ] **Step 4:** `cd apps/web && npm install && npm test && npm run build` → PASS; `grep -ri powersync src` → no hits.
- [ ] **Step 5:** Commit `refactor(web): read and write events through the REST API only`.

### Task 6: One image, root `compose.yaml`, backup restore

**Files:**
- Create: `Dockerfile` (repo root), `docker/entrypoint.sh`, `compose.yaml`, `.env.example` (all optional, commented), `.dockerignore`, `infra/backup/restore.sh`
- Move: `infra/compose/backup/` → `infra/backup/`
- Delete: `infra/compose/` (docker-compose*.yml, caddy/, powersync/, postgres/init — fold any needed init SQL into migrations or drop if PowerSync-only), `apps/api/Dockerfile`
- Modify: `apps/api/src/modules/health/health.ts:144` (`BACKUP_ENABLED` default `'false'`), `infra/backup/entrypoint.sh` (dispatch `restore <file>` → `restore.sh`)
- Test: `apps/api/test/health.integration.test.ts` (backup check `enabled:false` by default); `scripts/smoke-compose.sh`

**Interfaces:** Dockerfile stages: `web` (node:24-alpine, `apps/web` → `dist`), `api` (node:20-alpine, `npm ci && npm run build`), runtime (node:20-alpine + `su-exec`): `/app/dist`, `/app/migrations`, `/app/web`; `ENV WEB_ROOT=/app/web DATA_DIR=/data MEDIA_DIR=/data/media PORT=3000 NODE_ENV=production`; `ENTRYPOINT ["/entrypoint.sh"]`, `CMD ["node","dist/start.js"]`; `HEALTHCHECK` via `wget -qO- http://127.0.0.1:3000/healthz`. `entrypoint.sh`: as root, `mkdir -p /data/media && chown -R node:node /data` only when owner ≠ node, then `exec su-exec node "$@"`. `restore.sh <file>`: refuses (exit 1, clear message) if `pg_isready` ok and a `waffled` app session is connected (`pg_stat_activity` where `application_name <> 'waffled-backup'` and datname = target); accepts `.sql.gz` and `.dump`. Compose exactly as in the spec's "Target compose.yaml", plus the `backup` service (profile `backup`, volume `waffled_backups:/backups`, `BACKUP_ENABLED=true` passed to `waffled` only via docs).

- [ ] **Step 1:** Failing test: health report backup section `enabled === false` with no env. Run → FAIL; change default; → PASS.
- [ ] **Step 2:** Write `scripts/smoke-compose.sh`: `docker compose -p waffled-smoke up -d --build`, poll `http://localhost:${HTTP_PORT:-18080}/healthz` up to 120s, assert `GET /` contains `<div id="root"`, assert `docker compose -p waffled-smoke ps --services --status running` is exactly `postgres` and `waffled`, then `down -v`. Run before Dockerfile exists → FAIL.
- [ ] **Step 3:** Write Dockerfile, entrypoint, compose, `.env.example`, move backup, add restore.
- [ ] **Step 4:** `HTTP_PORT=18080 scripts/smoke-compose.sh` → PASS. Also verify a restart reuses secrets: `docker compose -p waffled-smoke restart waffled` then login session still valid (manual check noted in PR).
- [ ] **Step 5:** Commit `feat: single waffled image and two-service compose`.

### Task 7: Delete Mac, runtime, iOS, native, Terraform, CLIs; rewrite CI

**Files:**
- Delete: `apps/ios/`, `apps/mac/`, `apps/runtime/`, `infra/native/`, `infra/terraform/`, `waffled`, `waffled-demo`, `tests/`, `justfile` (if it only wraps removed things), root `wrangler.jsonc`, `.github/workflows/native-runtime.yml`, `apps/api/test/{compose-network,compose-secrets,container-users,waffled-upgrade,waffled-wait}.test.ts`, `apps/api/test/api.e2e.test.ts` + `vitest.e2e.config.ts` (superseded by the smoke script)
- Modify: `.github/workflows/ci.yml` (drop `cli-tests`; add `compose-smoke` job running `scripts/smoke-compose.sh` on PRs touching `Dockerfile`, `compose.yaml`, `apps/**`, `infra/backup/**`); `.github/workflows/publish-images.yml` (build `ghcr.io/evan-ribbey/waffled` from root `Dockerfile` and `ghcr.io/evan-ribbey/waffled-backup` from `infra/backup`, multi-arch, keep the CHANGELOG-to-release job); `.gitignore` (drop iOS/mac entries)
- Test: CI config is exercised by Task 6's smoke script locally.

- [ ] **Step 1:** `git rm` the listed paths; `grep -rn "apps/ios\|apps/mac\|apps/runtime\|infra/native\|\./waffled\b\|waffled-demo\|powersync" --exclude-dir=node_modules --exclude-dir=.git . | grep -v CHANGELOG.md | grep -v docs/superpowers` → list remaining references for Task 9 (docs) and fix any in code/config now.
- [ ] **Step 2:** Rewrite workflows; `npx --yes actionlint .github/workflows/*.yml` (or `docker run rhysd/actionlint`) → no errors.
- [ ] **Step 3:** `cd apps/api && npm test && npm run typecheck`; `cd apps/web && npm test && npm run build` → PASS.
- [ ] **Step 4:** Commit `chore: remove Mac app, native runtime, iOS app and the waffled CLI`.

### Task 8: Fork identity and dev-only release script

**Files:**
- Create: `scripts/release.sh`
- Modify: `apps/api/src/modules/updates/updates.ts:30` (default `'evan-ribbey/waffled-remix'` when env unset), any hard-coded `kevinpsites/waffled` outside CHANGELOG history (grep)
- Test: `apps/api/test/updates.integration.test.ts` (default repo used when env unset)

**Interfaces:** `scripts/release.sh X.Y.Z`: requires clean tree on `main` and ≥1 entry under `## [Unreleased]`; sets `version` in `apps/api/package.json`, `apps/web/package.json` (+ their lockfiles via `npm version --no-git-tag-version`); rewrites `## [Unreleased]` → `## [Unreleased]\n\n## [X.Y.Z] - YYYY-MM-DD` and adds the compare link; commits `release: vX.Y.Z`; tags `vX.Y.Z`; prints the push command (does not push).

- [ ] **Step 1:** Failing test: with `UPDATE_CHECK_REPO` unset, the update check requests `https://api.github.com/repos/evan-ribbey/waffled-remix/releases/latest` (stub server via the file's existing override). Run → FAIL; implement → PASS.
- [ ] **Step 2:** Write `release.sh`; dry-run in a throwaway clone: `git clone . /tmp/rel && cd /tmp/rel && scripts/release.sh 9.9.9` → versions bumped, changelog dated, tag exists.
- [ ] **Step 3:** Commit `chore: point update check at the fork and add release script`.

### Task 9: Docs, CLAUDE.md, CHANGELOG

**Files:**
- Modify: `README.md` (quick start = clone/download `compose.yaml`, `docker compose up -d`, open `:8080`; reverse proxy + `TRUST_PROXY` + `PUBLIC_BASE_URL` section; admin/demo/backup/restore commands), `CLAUDE.md` (remove `:8080`/`:8081` question and `./waffled release`; release = `scripts/release.sh`; drop references to apps/ios and apps/mac CLAUDE.md files), `apps/web/CLAUDE.md` if it references removed stacks, `CHANGELOG.md` `[Unreleased]` (Changed: **Two-container install**; Removed: **Mac app, iOS app, PowerSync offline sync, `./waffled` CLI**; Fixed: **Outlook calendar callback reachable**; Security: **Forwarded headers trusted only with `TRUST_PROXY`**), `docs/product/roadmap.md` (move Mac/iOS/Bonjour/Windows items to Removed), `website/docs/astro.config.mjs` sidebar + `website/docs/src/content/docs/**` (rewrite install pages; delete Mac, iOS, native, Oracle Terraform pages; update `reference/features.md` surfaces to Web/PWA), `CONTRIBUTING.md`, `ARCHITECTURE.md`
- Create: `website/docs/src/content/docs/install/migrating-from-waffled-cli.md` (the four-step switch from the spec, including the optional `DROP DATABASE powersync_storage;` and the `TOKEN_ENCRYPTION_KEY` warning)

- [ ] **Step 1:** Write the docs; re-run the Task 7 grep → only CHANGELOG history and `docs/superpowers` hits remain.
- [ ] **Step 2:** `cd website/docs && npm ci && npm run build` → PASS (no broken sidebar slugs).
- [ ] **Step 3:** Full verification: `cd apps/api && npm test && npm run typecheck`; `cd apps/web && npm test && npm run build`; `HTTP_PORT=18080 scripts/smoke-compose.sh` → all PASS.
- [ ] **Step 4:** Commit `docs: two-container install, migration guide, and removed surfaces`.
