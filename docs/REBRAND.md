# Rebrand tracker — → Waffled (waffled.app)

History: **Nook → Kinnook** (display only, 2026-07-02) → **Kinnook/Nook → Waffled**
(full shift incl. server-side, 2026-07-02). This file stays the single source of truth so
any future rename is a mechanical sweep, not archaeology.

---

## ✅ DONE — full Waffled rebrand (display + server-side), 2026-07-02

**Web (`apps/web`)** — UI copy, `index.html`/manifest/SW cache, new waffle-icon favicons +
logo (`public/{logo,icon-512,icon-192,apple-touch-icon,favicon-32,favicon-16}.png`),
localStorage keys `nook.*`→`waffled.*`, DOM events `nook:*`→`waffled:*`, CSS prefix
`nk-`→`wf-`, `styles/nook.css`→`waffled.css`, `NookConnector`→`WaffledConnector`,
`@waffled/web`. Typecheck ✓, 210 tests ✓.

**API (`apps/api`)** — JWT issuer `waffled-local`, audience `waffled-api`, local-secret
default, household claim `https://waffled.app/household_id`, service/telemetry name
`waffled-api`, `@waffled/api`, all test signers. Typecheck ✓, build ✓, JWT tests ✓.

**Infra + CLI** — CLI `nook`→`waffled`, `nook-demo`→`waffled-demo` (git mv); compose project
`waffled`; containers `waffled-*`; local images `waffled-*:local` + `WAFFLED_*_IMAGE`;
volumes `waffled_media`/`waffled_backups`; `.env.example` db defaults `waffled`;
`LOCAL_JWT_SECRET`/`OTEL_SERVICE_NAME` compose defaults; backup sidecar names/filenames.
`docker compose config` ✓.

**Docs + site (`website/`, root `*.md`, `docs/**`)** — prose, all CLI/container/volume/env
command refs, `wrangler.jsonc`→`waffled-docs`, astro title/logo/favicon, GHCR image
basenames `waffled-*`. Astro build ✓.

**Live-stack migration (2026-07-02)** — non-destructive: dumped `nook` db → copied volumes
to `waffled_*` → fresh `waffled` stack → restored. DB/user renamed `nook`→`waffled`. All 5
services healthy; data intact (3 households / 13 persons / 469 events / 4 accounts); JWT +
`TOKEN_ENCRYPTION_KEY` verified live (Google secret still decrypts). Old `nook_*` volumes +
`infra/compose/.env.nook.bak` retained as rollback.

---

## ✅ DONE — final server-internal sweep, 2026-07-04 (pre-release, no back-compat needed)

Since nothing has shipped, the previously-deferred internal identifiers were changed outright
(no dual-prefix / no JWKS-flush concern):
- **GitHub repo slug** `kevinpsites/nook` → **`kevinpsites/waffled`** (repo renamed on GitHub).
  Git remote re-pointed; `UPDATE_CHECK_REPO` compose default + `.env.example`; OFF `USER_AGENT`
  URL (`off.ts`); README/CHANGELOG/ROADMAP/website doc links (also fixed a stray `kevinsites/`
  → `kevinpsites/`). GitHub auto-redirects the old slug, so no clone breakage.
- **`nook_` API-key prefix → `waffled_`** (`api-keys.ts` `mintKey`). Safe: keys verify by
  `key_hash`, prefix is display-only. Verified live: minted key = `waffled_…`.
- **PowerSync issuer/KID** `nook` / `nook-powersync-1` → **`waffled` / `waffled-powersync-1`**
  (`powersync.ts`). `service.yaml` only pins `audience: ['powersync']` (no issuer/KID check),
  so consistent rename is non-breaking. Verified live: JWKS serves `waffled-powersync-1`; a
  minted sync token carries `kid=waffled-powersync-1, iss=waffled` and the sync service accepts it.
- **OTEL metric names** `nook.job.*` / `nook.http.requests` → **`waffled.*`** (`telemetry.ts`).
- **Misc**: `health.ts` media-volume hint (`waffled_media`), migration comments (0052/0061),
  `@nook/api|web` lockfile `name` fields, `oidc.ts` deep-link comments, and all affected
  integration tests (api-keys `/^waffled_/`, powersync `issuer: 'waffled'`, oidc `waffled://`).

Verified: typecheck ✓, 33 affected integration tests ✓, api rebuilt (`waffled-powersync-1` +
`waffled.job.*` + `waffled.http.requests` in container `dist/server.js`, no `nook` symbols left),
all 5 services healthy, fresh backup emits `waffled-*.sql.gz`.

## ⏸️ Still deferred (intentional)

- **iOS app (`apps/ios`)** — owned by a separate agent. The `Sources/Nook/`→`Sources/Waffled`
  rename lives on the unmerged `ios/mobile` branch, so on `main` the iOS tree + a few web
  comments cross-referencing iOS paths (`apps/web/src/lib/api/kiosk.ts`, `capture/parse.ts`)
  still say `Sources/Nook`/`NookAPI` — accurate for `main` today; they flip when that branch
  merges. The server already emits `waffled://auth/callback` (it echoes whatever scheme the
  native app sends), so iOS's `waffled://` and the server are aligned.

---

## Cleanup once satisfied with the migration
- Remove old rollback volumes: `docker volume rm nook_pgdata nook_nook_media nook_nook_backups nook_caddy_data nook_caddy_config nook_lgtm_data`
- Remove `infra/compose/.env.nook.bak`
- Re-seed / re-migrate the `waffled-demo` stack (old `nook-demo` volumes untouched).
