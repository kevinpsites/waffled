# Rebrand tracker — Nook → Kinnook

Status: **display name + assets** are being changed to **Kinnook** now. **Technical
identifiers** (CLI, container/image/volume/db names, env vars, package names, JWT claims,
storage keys, CSS prefixes, iOS module, repo name) are **deferred** to the full shift so
we don't break the running stack or invalidate sessions before the repo rename.

> The name may change again — this file is the single source of truth for what's been
> touched and what still needs to move, so a future rename (to Kinnook or anything else)
> is a mechanical sweep, not archaeology.

---

## ✅ Changing NOW (user-facing brand + assets) — DONE 2026-07-02

**Web app (`apps/web`)**
- [x] `index.html` — `<title>`, `apple-mobile-web-app-title`, icon/favicon links, theme-color (#F5EFE1)
- [x] `public/manifest.webmanifest` — `name`, `short_name`, icons
- [x] New icon assets from the logo: `public/{logo.png, icon-512.png, icon-192.png, apple-touch-icon.png, favicon-32.png, favicon-16.png}` (removed the old `icon.svg`)
- [x] In-app logo image on the auth/setup screen (`kiosk/AuthGate.tsx` `AuthShell` → `<img class="auth-logo-img" src="/logo.png">`, styled in `styles/auth.css`)
- [x] UI copy strings "Nook" → "Kinnook": `Settings.tsx`, `AuthGate.tsx`, `Lists.tsx`,
      `ProfilePicker.tsx`, `EventDetail.tsx`, `onboarding/GettingStarted.tsx`,
      `components/PlanWeek.tsx`, `components/PlanMonth.tsx`, `components/EventModal.tsx`, `Photos.tsx`, `styles/lists.css`
- [x] Test assertions: `Settings.test.tsx` ("Kinnook — Family Hub"), `Lists.test.tsx` ("Kinnook suggests:")

**Docs site (`website/`)**
- [x] `astro.config.mjs` — `title` "Kinnook" + Starlight `logo` (`src/assets/kinnook-logo.png`) + `favicon: /favicon.png`
- [x] Favicon assets (`public/favicon.png`, `public/icon.png`; removed `favicon.svg`)
- [x] Content prose "Nook" → "Kinnook" (index.mdx + all `src/content/docs/**`)

**Repo docs / prose (brand mentions only; code/commands left as-is)**
- [x] `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md`, `BOOTSTRAP.md`, `SECURITY.md`,
      `CONTRIBUTING.md`, `docs/**/*.md`, `website/README.md` — lookaround-safe sweep
      (`perl -pe 's{(?<![/\w])Nook(?![\w])}{Kinnook}g'`) that skipped `Sources/Nook/` + `NookAPI`
- [ ] **NOT swept:** `docs/handoff/*.js` (frozen design-mock prototypes, not shipped — still say "Nook")

---

## ⏸️ NOT touching yet — the full technical shift (do at repo rename)

These break the running stack / sessions / builds if changed piecemeal. Rename all
together when the repo is renamed.

**CLI & tooling**
- [ ] `./nook` script — filename, help header, and every `docker exec nook-*` inside it
      (+ `nook-demo`, `justfile`)

**Docker (`infra/compose/docker-compose.yml` + `./nook`)**
- [ ] Container names: `nook-postgres`, `nook-api`, `nook-powersync`, `nook-caddy`,
      `nook-backup`, `nook-migrate`, `nook-lgtm` (+ `nook-demo-*`)
- [ ] Image names: `nook-api`, `nook-caddy`, `nook-backup` (`image:` + `${NOOK_*_IMAGE:-nook-*:local}` defaults)
- [ ] Volume names: `nook_media`, `nook_backups` (`pgdata`, `caddy_*`, `lgtm_data` are generic)
- [ ] GHCR image paths `ghcr.io/<owner>/nook-*` (also tied to the repo name)

**Env vars**
- [ ] `NOOK_API_IMAGE`, `NOOK_CADDY_IMAGE`, `NOOK_BACKUP_IMAGE` (in compose, `.env.example`,
      README, docs) — (`POSTGRES_*`, `POWERSYNC_*`, `LOCAL_JWT_SECRET`, `BACKUP_*`, `OTEL_*` are generic, keep)

**Database**
- [ ] `POSTGRES_DB=nook`, `POSTGRES_USER=nook` (renaming needs a data migration / recreate)

**Packages**
- [ ] `@nook/api`, `@nook/web` (package.json `name` fields)

**Auth / JWT (changing invalidates existing tokens — coordinate a flush)**
- [ ] JWT issuer `nook-local`, audience `nook-api` (`apps/api` signing + validation,
      `scripts/mint-token.ts`, tests, iOS token config)

**Web storage / events (changing logs everyone out)**
- [ ] `localStorage` keys `nook.access`, `nook.token`; custom event `nook:auth-changed`;
      kiosk identity `kiosk:<personId>` (unaffected); any other `nook.*` keys

**Code identifiers & styles**
- [ ] `NookConnector` (web PowerSync class), `NookAPI` (iOS), other `Nook*` types/classes
- [ ] CSS class prefix `nk-*` (e.g. `nk-serif`) and any `.nook-*` classes
- [ ] `OTEL_SERVICE_NAME` default `nook-api`

**iOS native app (`apps/ios`) — its own Xcode job**
- [ ] `Sources/Nook/` directory + `Nook` Swift module, `Nook.app`, display name,
      bundle id `com.kevinsites.nook`, `project.yml` → re-run `xcodegen`; file-path
      comments referencing `apps/ios/Sources/Nook/...` in web/api

**Repo & external**
- [ ] GitHub repo `kevinpsites/nook` → new slug (updates `<owner>/nook` links, GHCR paths,
      git remote, `publish-images.yml`, docs links, `UPDATE_CHECK_REPO`)
- [ ] Local working dir `~/dev/nook`

---

_Update the checkboxes above as each area is completed._
