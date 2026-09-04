# Waffled for Mac — native server runtime plan

Authoritative plan for shipping Waffled as a **downloadable Mac app that runs the family
server natively, with no Docker**. Companion to `roadmap.md` (Planned → "Waffled for Mac").
Grounded in the current stack as of `a506c352` (v0.14.3).

The one-line architecture decision:

> **Waffled Server is the product. Waffled.app on macOS is one way of running it. Docker
> Compose stays the Linux/NAS/VPS way of running it.** Same API, same database, same
> migrations, same PowerSync, same web app — only the packaging and process supervision differ.

---

## 1. Goal and non-goals

**Goal (this wrap-up).** A non-technical person downloads `Waffled.dmg`, drags it to
Applications, opens it, and is inside a working Waffled household in under five minutes.
Relaunching the app re-opens the *existing* server; it never creates a second one. The main
UI is the **web app**, exactly like Plex. The Mac app itself is a **menu-bar icon** that shows
the server is running and, when clicked, offers a small menu whose main action opens the web UI.

**Non-goals (deliberately parked).**

- Windows and Linux desktop builds. Same runtime design, different wrapper — see §9. Nothing
  in this plan may make Windows *harder*, but nothing is built for it now.
- A native SwiftUI Waffled UI on the Mac. The iOS app stays the native client; the Mac app is a
  server manager only.
- Mac App Store distribution. Postgres needs shared memory and a real filesystem, which the
  App Store sandbox forbids. We ship a notarized Developer-ID app outside the store, as Plex does.
- Replacing Docker Compose. Compose remains the supported path for Linux, NAS, Raspberry Pi,
  VPS, and the public demo box.

---

## 2. The five-minute experience

```text
1. Download Waffled.dmg → drag to Applications → open.
2. Gatekeeper: "Waffled is from an identified developer" (notarized; one click).
3. First launch, menu-bar icon appears (grey → spinning → green):
     - creates ~/Library/Application Support/Waffled/
     - generates secrets (same four the CLI generates today)
     - initdb + starts Postgres (wal_level=logical, powersync_storage db, pgcrypto)
     - runs migrations
     - starts API, PowerSync, Caddy
     - health-checks all four
     - opens http://localhost:<port>/ in the default browser
4. The web app's existing first-run/setup creates the household + first adult (unchanged).
5. Menu-bar icon is green. Menu:
     ● Waffled is running            (status line, greyed)
       Open Waffled                  (opens the web UI)
       ─────────
       Server address: kevins-mac-mini.local:8080   (click = copy)
       Start at login                (toggle)
       Back up now
       Check for updates…
       ─────────
       Quit Waffled                  (stops the server — says so in the confirm)
6. Relaunch later → the same data dir is found → "re-open existing server" → green in seconds.
```

Everything in step 3 is what `./waffled up` already does with Compose; the Mac app does it
with bundled binaries and launchd instead of images and a Docker network.

---

## 3. Architecture

```text
                       Waffled Server (one codebase)
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
     Docker Compose (Linux)                  Waffled.app (macOS)
     infra/compose/*                         apps/mac/* + infra/native/*
              │                                       │
     images + compose network             runtime supervisor + launchd
              │                                       │
   ┌──────┬───┴────┬─────────┐            ┌──────┬────┴───┬─────────┐
   │      │        │         │            │      │        │         │
  API   Postgres PowerSync  Caddy        API   Postgres PowerSync  Caddy
  (node) (pg16)   (node)    (go)        (node)  (pg16)   (node)    (go)
```

Two new pieces, both small:

1. **Runtime supervisor** (`waffled-runtime`, lives under `infra/native/` for the spike and
   becomes a proper package afterwards). Owns: the data directory layout, secret generation,
   ordered start (postgres → migrate → api → powersync → caddy), health gates, ordered stop,
   log files, `status` as JSON, backup/restore, and Bonjour advertisement. It is a **CLI first**
   (`waffled-runtime start|stop|status|backup|restore|doctor`) so support can say "open
   Terminal and run `waffled-runtime status`". The menu-bar app shells out to it; nothing the
   GUI does is unavailable from the CLI.
2. **Menu-bar app** (`apps/mac/`, SwiftUI `MenuBarExtra`, `LSUIElement=true` so there is no
   Dock icon, macOS 13+). Bundles the runtime and the four service binaries inside
   `Waffled.app/Contents/Resources/runtime/`. Responsibilities: start the runtime on launch,
   poll `status`, render the icon + menu, open the browser, register itself as a login item
   via `SMAppService`, and drive updates with Sparkle.

**Language for the supervisor.** Go. Single static binary, cross-compiles to Windows later,
trivially notarizable, no runtime of its own. Rejected: bash (the existing 1,300-line
`waffled` script is bash-3.2-constrained and cannot run on Windows), Node (fine technically,
but then the supervisor of Node is Node, and it can't be a login-item-friendly single binary),
Swift (locks the runtime to macOS, which contradicts the whole point). The *spike* in Phase 1
uses bash because it is throwaway and the point is to learn, not to build.

### Data directory

```text
~/Library/Application Support/Waffled/
  config.env          # the same variables as infra/compose/.env (secrets generated once)
  postgres/           # PGDATA — excluded from Time Machine (see §5)
  media/              # uploaded blobs (today's waffled_media volume)
  backups/            # pg_dump output; nightly via launchd, plus "Back up now"
  logs/               # one file per service, rotated
  runtime.json        # ports, version, last-migrated version, install id
```

### Ports and networking

- One public port (default **8080**, same as Compose) served by Caddy: web SPA, `/api/*`,
  `/media/*`, and PowerSync on a second Caddy site (default **8081**) — same Caddyfile.
- API (`3000`), Postgres (`5432`), and PowerSync (`8082` internal) bind **127.0.0.1 only**.
  This is the native replacement for Compose's private network (§5).
- Port collisions (Homebrew Postgres on 5432, another app on 8080) are detected at first
  start; the runtime picks the next free port and records it in `runtime.json`. The public
  port is stable after first run because other devices depend on it.
- **Bonjour.** The runtime advertises `_waffled._tcp` with the household name in the TXT
  record. The iOS app grows a "Find your Waffled server" first-run screen (needs
  `NSBonjourServices` + `NSLocalNetworkUsageDescription`; see the iOS capability-gate notes).
  Note: this does **not** give us `waffled.local`. Devices will see the Mac's own hostname
  (`kevins-mac-mini.local`). Discovery makes that irrelevant for the iOS app; the menu shows
  the address for everything else.
- No TLS on the LAN in this wrap-up. Same posture as `./waffled up` today. Tailscale/hostname
  mode keeps working because the Caddyfile is unchanged.

---

## 4. Per-service complexity (what actually has to change)

| Service | Today (Compose) | Native macOS | Complexity |
|---|---|---|---|
| **API** | `waffled-api` image, esbuild bundle, `node dist/server.js` | Same bundle + a pinned Node binary in the app. Pure-JS deps (`pg`, `lambda-api`, `node-pg-migrate`…), no native modules, no subprocesses. | Low |
| **Web** | Baked into the Caddy image at `/srv` | Same `apps/web/dist`, served by Caddy from `Resources/runtime/web/` | Low |
| **Migrations** | one-shot `migrate` container (`node-pg-migrate up`) | Runtime runs the same command before starting the API | Low |
| **Caddy** | `waffled-caddy` image (caddy:2 + web build) | Official static darwin binary + the **same Caddyfile** (`api:3000` → `127.0.0.1:3000` via env) | Low |
| **PowerSync** | `journeyapps/powersync-service:1.22.0`, `start -r unified`, Postgres storage | The image is a pnpm monorepo run under Node 24. Its entrypoint package (`@powersync/service-image`) is private, but every dependency it wires up is published on npm, and the entry file is ~40 lines. Two viable paths: (a) build the `service` package from the `powersync-service` repo at tag `v1.22.0`; (b) write our own 40-line entry over the published `@powersync/service-*` packages. One native dep (`@napi-rs/snappy`, has darwin-arm64 + x64 prebuilds). License is FSL-1.1-ALv2: bundling it in a self-hosted product is the same posture as redistributing the image; not a competing sync service. | **Medium — prove first** |
| **Postgres** | `postgres:16` image, `wal_level=logical`, init SQL creates `powersync_storage` + `pgcrypto` | Bundle PG 16 binaries (`embedded-postgres` npm / zonky-style tarballs, or EDB's). Runtime does `initdb`, writes `postgresql.conf` (logical WAL, listen 127.0.0.1, scram auth), runs `00-init.sql`, `pg_ctl start`. Every binary and dylib must be signed for notarization. Major-version upgrades (16→17) become **our** problem: `pg_upgrade` or dump/restore inside the updater. | **High — the whole risk** |
| **Backups** | `waffled-backup` sidecar, `pg_dump` nightly, `backup_runs` table feeds health | `pg_dump` from the bundled PG, scheduled by a launchd agent; write the same `backup_runs` row so System Health keeps working. Restore keeps the PowerSync-slot rebuild the CLI does today. | Low–Medium |
| **Supervision** | Compose `depends_on` + healthchecks + `restart: unless-stopped` | launchd restarts a process but has **no ordering**; the runtime supervisor owns the dependency graph and health gates. | Medium |
| **Observability** | optional `lgtm` profile | Not bundled. Logs to files; System Health is the UI. | n/a |

---

## 5. Risks

### What Docker was protecting us from (and the native mitigation)

- **Network isolation.** Postgres/API/PowerSync are only reachable on the Compose network
  today. Natively they land on localhost where every process on the Mac can reach them.
  → Bind all three to `127.0.0.1`, keep `scram-sha-256` (never `trust`) on Postgres, expose
  only Caddy on `0.0.0.0`.
- **User isolation.** Containers run as a dedicated non-root user with three volumes. Natively
  the API runs as the logged-in user with their whole home directory. A media path-traversal
  bug goes from "read a blob" to "read ~/Documents". → Hardening pass on every file-path
  handler in the API before beta (`/media`, uploads, backup/restore paths); add a
  path-confinement test.
- **Version pinning.** Images freeze Postgres/Node/Caddy. → Bundle everything; never depend on
  Homebrew or a system Node. The runtime refuses to start against binaries it didn't ship.
- **Ordered start + health gates.** → The supervisor (§3). Reimplemented, not lost.
- **Secrets.** `.env` in a Docker context is visible to `docker inspect` anyway. Natively
  `config.env` is `0600` in Application Support, covered by FileVault. Keychain is not worth
  it for a server process (unlockable only after login; complicates the daemon story).

### New native risks

- **Boot without login needs a daemon**, which needs an admin prompt to install. A login item
  (`SMAppService.loginItem`) runs only after someone signs in. → Ship the login item first and
  document "Mac mini: enable auto-login"; daemon mode is a later opt-in.
- **Lid-close sleep cannot be prevented from user space.** A MacBook is not a server. → Detect
  the model on first run and say so plainly; recommend Mac mini/desktop.
- **Time Machine restoring a live PGDATA corrupts it.** → Runtime sets the
  `com.apple.metadata:com_apple_backup_excludeItem` xattr on `postgres/` and relies on
  `backups/` (which *is* backed up). Same for iCloud Drive: never put the data dir under
  Desktop/Documents.
- **Rollback means restore, not reverse migrations.** → Updater takes a `pg_dump` snapshot
  before migrating; a failed health check restores it and re-launches the previous runtime.
  Cheap at family scale.
- **Postgres major upgrades** are now ours. → Pin PG 16 for the whole 1.x line; build the
  dump/restore upgrader before ever bumping.
- **Architectures.** arm64 first (the only Mac we can test on today); x86_64 via a universal
  build once the pipeline exists. Postgres/Node/Caddy all ship both.
- **Uninstall.** Dragging the app to the Trash orphans ~/Library/Application Support/Waffled.
  → Menu has "Reveal data folder"; docs explain removal. Never auto-delete.
- **Port collisions** (§3) and **Gatekeeper/notarization** (every binary in the bundle needs a
  hardened-runtime signature; `codesign --deep` is not enough for Postgres's dylibs).

---

## 6. Decisions

**Made**

- Server first, GUI second. No Swift is written until Phase 1 proves the runtime.
- Web UI is the product UI. The Mac app is a menu-bar manager only, no windows beyond a
  first-run/error sheet.
- Go for the supervisor/CLI; bash only for the Phase 1 spike.
- Compose is untouched. The native runtime reuses `Caddyfile`, `00-init.sql`, the API bundle,
  the web build, and the migration set verbatim. Any change needed to share them (e.g. a
  Caddyfile upstream host from env) is made in a way Compose also uses.
- Login item + auto-login guidance before daemon mode.
- Developer-ID + notarization, outside the App Store.
- PG 16 pinned for the life of the 1.x line.

**Open (decide during Phase 1/2)**

- PowerSync path (a) build from tag vs (b) own entry over npm packages. Spike answers this.
- Whether the default public port stays 8080 or moves to something less collision-prone.
- Sparkle vs a home-grown updater. Sparkle for the app bundle is the obvious choice; the
  question is whether the *runtime* updates independently of the app (Plex does not; keep it
  one unit unless a reason appears).
- Whether to bind Bonjour advertisement into the runtime (Go, cross-platform later) or the
  Swift app (`NWListener` is trivial). Leaning runtime.

---

## 7. Phases and steps

Each phase has an exit criterion. Nothing in a later phase starts until the previous exit
criterion is met — the whole point is to find out early if Postgres or PowerSync refuse.

### Phase 0 — This document *(done with this PR)*

- Plan in `docs/product/native-mac-plan.md`; roadmap entry under Planned.

### Phase 1 — Native spike: the whole stack on one Mac, no Docker *(delegated; small)*

Throwaway bash under `infra/native/spike/`. Purpose: **learn**, not build.

1. Fetch pinned binaries into a cache: Postgres 16 (arm64), Caddy 2, and use the repo's
   Node 24 (`.nvmrc`). Postgres via the `embedded-postgres` npm binaries or an EDB tarball —
   whichever gets `initdb`/`postgres`/`pg_dump` running first; record which.
2. PowerSync natively: clone `powersync-ja/powersync-service` at `v1.22.0`, `pnpm install`,
   build, run `node service/lib/entry.js start -r unified` with the repo's
   `infra/compose/powersync/service.yaml` + `sync-config.yaml` (URIs pointed at
   `127.0.0.1`). If that fails, try the own-entry route (b). Record which worked and why.
3. `spike.sh up`: data dir under `$HOME/Library/Application Support/WaffledSpike/`,
   generate the four secrets exactly as `waffled` does, `initdb`, `postgresql.conf`
   (logical WAL, loopback), `00-init.sql`, migrations, API, PowerSync, Caddy (same Caddyfile,
   upstream hosts rewritten to loopback), in order, with health waits.
4. `spike.sh status|down|logs`.
5. **Exit criterion:** `curl localhost:8080/healthz` and `/api/health` are green, the
   PowerSync liveness probe is green, the web app loads in a browser, a household can be
   created, and the **iOS simulator syncs against it** (PowerSync end-to-end). A `README.md`
   in `infra/native/spike/` records: what worked, what didn't, binary sizes, cold-start time,
   RAM, and every gotcha hit.

### Phase 2 — Runtime supervisor (Go)

1. `waffled-runtime` with `start|stop|status --json|backup|restore|doctor|logs`, data dir
   layout from §3, ordered supervision with health gates, log rotation, `runtime.json`.
2. Bonjour advertisement.
3. Backup schedule via a generated launchd plist; `backup_runs` rows.
4. Integration test: spins the whole stack from an empty data dir on CI (macOS runner) and
   hits the same health endpoints as Phase 1.
5. **Exit criterion:** `waffled-runtime start` on a fresh Mac user account reaches green in
   under 60s and `stop`/`start` re-opens the same data.

### Phase 3 — Menu-bar app

1. `apps/mac/` SwiftUI `MenuBarExtra`, XcodeGen project like iOS, bundles the runtime and
   binaries under `Resources/runtime/`.
2. Icon states (stopped / starting / running / error), the menu from §2, "Open Waffled".
3. First-run sheet (welcome → starting → "your server is ready, opening…") and the MacBook
   warning.
4. Login item via `SMAppService`.
5. Signing + notarization pipeline (every embedded binary), DMG build, Sparkle appcast.
6. Updater flow: snapshot → stop → swap runtime → migrate → health → start, with restore on
   failure.
7. **Exit criterion:** a fresh Mac, no dev tools, download → household created in under
   five minutes, timed by someone who didn't build it.

### Phase 4 — iOS discovery and docs

1. iOS "Find your Waffled server" via Bonjour, with manual address as fallback.
2. Docs site: "Waffled for Mac" how-to (install, where data lives, backups, uninstall,
   Mac mini auto-login), features reference, roadmap → Done, README download link.

### Later (not this wrap-up)

- Daemon mode (boot without login). Universal (x86_64) build. Windows (§9). LAN TLS.

---

## 8. Effort, honestly

- Phase 1: a day or two, most of it fighting PowerSync's build and Postgres binaries.
- Phase 2: about a week for the supervisor + tests.
- Phase 3: one to two weeks, half of which is signing/notarization/Sparkle plumbing, not UI.
- Phase 4: a few days.

The unknowns that could blow this up are both in Phase 1, which is why it goes first and
is throwaway.

---

## 9. Windows (parked; recorded so Phase 2 doesn't foreclose it)

Same runtime, different wrapper. Postgres, Node, and Caddy all have official Windows builds
and the Go supervisor cross-compiles. What differs: supervision is a Windows Service (which
runs at boot without login, better than macOS), packaging is an MSI (WiX/Inno) with an
Authenticode certificate (expect SmartScreen warnings until reputation builds), Defender
Firewall prompts for the inbound port, Postgres refuses to run as Administrator, antivirus
scans PGDATA unless excluded, and mDNS advertising needs a library since Windows only
resolves `.local` natively. The tray app can be tiny if the manager UI is a localhost web page
served by the runtime — worth considering for the Mac too if the SwiftUI menu grows.

---

## 10. References

- `infra/compose/docker-compose.yml` — the service graph the runtime reproduces.
- `infra/compose/caddy/Caddyfile`, `infra/compose/postgres/init/00-init.sql`,
  `infra/compose/powersync/*.yaml` — reused verbatim by the native runtime.
- `waffled` (repo root) — `ensure_env` is the secret-generation contract; `backup`/`restore`
  are the behaviours the runtime must keep (PowerSync slot rebuild on restore).
- `apps/api/src/modules/powersync/powersync.ts` — how the API derives the public PowerSync
  URL (`POWERSYNC_PUBLIC_URL` wins when set).
- PowerSync service source: `github.com/powersync-ja/powersync-service` (FSL-1.1-ALv2).
