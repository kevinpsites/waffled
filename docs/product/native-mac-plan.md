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
1. Download Waffled-<version>.dmg → drag to Applications → open.
2. Gatekeeper: notarized and stapled, so the ordinary first-launch question and no warning.
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
   Dock icon, macOS 14+ — `MenuBarExtra` needs 13, `@Observable` needs 14). Bundles the
   runtime and the four service binaries inside
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
- **Bonjour.** The runtime advertises `_waffled._tcp` on the public Caddy port with the
  household name as the instance name (or "Waffled on \<computer\>" before setup, or when
  there is more than one household), and a TXT record carrying `txtvers`, `name`, `url`,
  `port`, `version` and `setup`. An install with no household yet advertises `setup=1`, so
  a phone that finds it can say "finish setup on your Mac". The iOS app grows a "Find your
  Waffled server" first-run screen (needs `NSBonjourServices` +
  `NSLocalNetworkUsageDescription`; see the iOS capability-gate notes).
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
| **PowerSync** | `journeyapps/powersync-service:1.22.0`, `start -r unified`, Postgres storage | The image is a pnpm monorepo run under Node 24. Its entrypoint package (`@powersync/service-image`) is private, but every dependency it wires up is published on npm, and the entry file is ~40 lines. Two viable paths: (a) build the `service` package from the `powersync-service` repo at tag `v1.22.0`; (b) write our own 40-line entry over the published `@powersync/service-*` packages. One native dep (`@napi-rs/snappy`, has darwin-arm64 + x64 prebuilds). License is FSL-1.1-ALv2: bundling it in a self-hosted product is the same posture as redistributing the image; not a competing sync service. | Medium — **proven in Phase 1** (path (a): build from the tag with pnpm 11, run under the bundled Node) |
| **Postgres** | `postgres:16` image, `wal_level=logical`, init SQL creates `powersync_storage` + `pgcrypto` | Bundle PG 16 binaries (`embedded-postgres` npm / zonky-style tarballs, or EDB's). Runtime does `initdb`, writes `postgresql.conf` (logical WAL, listen 127.0.0.1, scram auth), runs `00-init.sql`, `pg_ctl start`. Every binary and dylib must be signed for notarization. Major-version upgrades (16→17) become **our** problem: `pg_upgrade` or dump/restore inside the updater. | **High — the whole risk** |
| **Backups** | `waffled-backup` sidecar, `pg_dump` nightly, `backup_runs` table feeds health | `pg_dump` from the bundle — the npm/zonky Postgres repacks ship no client tools, so the bundle takes `pg_dump`/`pg_restore`/`pg_isready`/`psql` from the theseus-rs `postgresql-binaries` release (12 MB) — scheduled by a launchd agent; write the same `backup_runs` row so System Health keeps working. Restore keeps the PowerSync-slot rebuild the CLI does today. | Low–Medium |
| **Supervision** | Compose `depends_on` + healthchecks + `restart: unless-stopped` | launchd restarts a process but has **no ordering**; the runtime supervisor owns the dependency graph and health gates. | Medium |
| **Observability** | optional `lgtm` profile | Not bundled. Logs to files; System Health is the UI. | n/a |

---

## 5. Risks

### What Docker was protecting us from (and the native mitigation)

- **Network isolation.** Postgres/API/PowerSync are only reachable on the Compose network
  today. Natively they land on localhost where every process on the Mac can reach them.
  → Bind all three to `127.0.0.1`, keep `scram-sha-256` (never `trust`) on Postgres, expose
  only Caddy on `0.0.0.0`. **Known gap (Phase 2 finding):** the PowerSync service hardcodes
  `0.0.0.0` in its listen call — no config key, no `PS_*` variable — so its internal port is
  reachable from the LAN. Every request still needs an RS256 token minted by the api, so it is a
  missing layer of defence, not an open door. Options: patch the listen host in our build of the
  service, or front it with a packet filter rule; decide in Phase 3.
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
- **Lid-close sleep cannot be prevented from user space.** A MacBook is not a server.
  *(done — PR #197)* → The first-run window's welcome step says so plainly on a portable and
  recommends a Mac mini or a desktop, then lets the person carry on. Detection is
  `Hardware.isPortable`: an internal battery (IOKit power sources) **or** "MacBook" in
  `hw.model`, because Apple Silicon laptops report models like `Mac14,7` with no MacBook in
  the string at all.
- **Time Machine restoring a live PGDATA corrupts it.** *(done — PR #186)* → The runtime
  sets the `com.apple.metadata:com_apple_backup_excludeItem` xattr on `postgres/` (through
  `tmutil addexclusion`, which needs no admin rights) when the **data directory** is
  created, so installs predating this are repaired on their next start; `doctor` re-asks
  tmutil itself rather than trusting the memo. `backups/` *is* backed up. Same for iCloud
  Drive: `doctor` warns when the data dir sits under Desktop/Documents/iCloud.
- **Rollback means restore, not reverse migrations.** *(done — PR #186, and PR #193 across
  two bundle versions)* → `start` takes a `pg_dump` snapshot before migrating, but only when
  migrations are genuinely pending, and a failed api health gate restores it automatically
  and refuses to come up, naming the file. A snapshot that cannot be taken stops the start
  rather than proceeding without a way back. Snapshots are named
  `pre-migrate-<from>-to-<to>-<stamp>.dump` for the crossing they mark, and there is exactly
  **one** per schema change — an earlier draft of this bullet reserved a second retention
  prefix for the updater, which the one-unit decision in §6 makes unnecessary: swapping the
  app and changing the schema are the same event. The whole loop is now tested across two
  genuinely different bundles, including the half the runtime cannot do for anyone —
  re-installing the previous version and starting on the restored data. And an older bundle
  now **refuses** data a newer one has already migrated (the state after a rollback if
  someone re-installs before the restore, or after a partial failure), naming the newest
  snapshot it could actually restore and the two ways out, rather than serving a schema its
  code does not know.
- **Postgres major upgrades** are now ours. → Pin PG 16 for the whole 1.x line; build the
  dump/restore upgrader before ever bumping.
- **Architectures.** arm64 first (the only Mac we can test on today); x86_64 via a universal
  build once the pipeline exists. Postgres/Node/Caddy all ship both.
- **Uninstall.** Dragging the app to the Trash orphans ~/Library/Application Support/Waffled.
  → Menu has "Reveal data folder"; docs explain removal. Never auto-delete.
  *(runtime half done — PR #200: `waffled-runtime uninstall [--delete-data] [--dry-run] [--json]
  [--yes]` removes the launchd backup agent, leftover pidfiles, the Bonjour registration and
  the out-of-root Postgres socket directory, keeps the data unless asked, and prints the whole
  kept-vs-removed inventory. The app's "Remove Waffled…" follows.)*
- **Port collisions** (§3). **Gatekeeper/notarization** *(done — PR #201)* → Confirmed as
  written: every binary in the bundle needs its own hardened-runtime signature, and
  `--deep` is not the way to get one — it rewrites the same Mach-O files the runtime's
  manifest hashes, so signing is per-file and the manifest is written after. 124 binaries,
  one entitlement (node's `allow-jit`), the app sealed last. See §7 Phase 3 item 5.

---

## 6. Decisions

**Made**

- Server first, GUI second. No Swift is written until Phase 1 proves the runtime.
- Web UI is the product UI. The Mac app is a menu-bar manager only, no windows beyond the
  first-run/error one. (Shipped as a window rather than a sheet: an `LSUIElement` app has no
  window scene to present a sheet *from*.)
- Go for the supervisor/CLI; bash only for the Phase 1 spike.
- Compose is untouched. The native runtime reuses `Caddyfile`, `00-init.sql`, the API bundle,
  the web build, and the migration set verbatim. Any change needed to share them (e.g. a
  Caddyfile upstream host from env) is made in a way Compose also uses.
- Login item + auto-login guidance before daemon mode.
- Developer-ID + notarization, outside the App Store.
- PG 16 pinned for the life of the 1.x line.

**Open (decide during Phase 1/2)**

- ~~PowerSync path (a) build from tag vs (b) own entry over npm packages.~~ **Resolved: (a).** The spike built from the `v1.22.0` tag on the first try; (b) was never needed.
- Whether the default public port stays 8080 or moves to something less collision-prone.
- ~~Sparkle vs a home-grown updater, and whether the *runtime* updates independently of the
  app.~~ **Resolved: Sparkle, and one unit.** The app is updated whole, Plex-style: Sparkle
  swaps `Waffled.app` with the runtime bundle inside it, relaunches, and the menu-bar app
  starts the *new* runtime against the *existing* data directory — so **a `start` from a
  newer bundle IS the update**, and the runtime needs no `update` subcommand, no binary-swap
  step and no second copy of the old bundle on disk. That splits rollback in two: the
  runtime protects the data (snapshot → migrate → health gate → restore), and a person
  recovers availability by re-installing the previous DMG, which now starts cleanly on the
  restored data or refuses with instructions. Proven end to end in PR #193.
- ~~Whether to bind Bonjour advertisement into the runtime (Go, cross-platform later) or the
  Swift app (`NWListener` is trivial).~~ **Resolved: the runtime**, by supervising
  `/usr/bin/dns-sd -R` as one more child rather than linking a responder. It registers
  through the system mDNSResponder (a second responder on 5353 is the classic macOS flake),
  keeps `go.mod` stdlib-only, deregisters when killed, and means the server advertises
  itself whether it was started by the app, by launchd or from Terminal.

---

## 7. Phases and steps

Each phase has an exit criterion. Nothing in a later phase starts until the previous exit
criterion is met — the whole point is to find out early if Postgres or PowerSync refuse.

### Phase 0 — This document *(done — PR #175)*

- Plan in `docs/product/native-mac-plan.md`; roadmap entry under Planned.

### Phase 1 — Native spike: the whole stack on one Mac, no Docker *(done — PR #176)*

*(Spike retired in PR #194; findings kept at `docs/product/native-mac-spike-findings.md`.)*

**Result: both risks answered yes.** Postgres 16 ran from `@embedded-postgres/darwin-arm64`
(EDB's signed universal binaries; hydrate its dylib symlinks, and it ships no `pg_dump`/`psql`),
PowerSync ran from the `v1.22.0` tag under plain Node, the web first-run wizard created a
household with live sync, and an iPhone simulator on the LAN synced through it. Cold start 6 s
from an empty data dir. Two corrections the spike itself needed: Homebrew's Node is a stub that
cannot be relocated (bundle the nodejs.org build), and `initdb` must use `en_US.UTF-8`, not
`C`, to match the `postgres:16` image's collation so Docker → Mac restores keep sort order.

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

1. *(done — PR #178 bundle, PR #182 runtime)* The bundle build script under
   `infra/native/bundle/` assembles a 662 MB self-contained arm64 runtime with a per-file
   checksum manifest. `waffled-runtime` lives in `apps/runtime/` (Go): `start|stop|status
   --json|logs|doctor`, data dir layout from §3, ordered supervision with health gates,
   `runtime.json`, next-free-port selection, manifest verification before start. Cold start
   under 20 s against the 60 s criterion; warm restart about 2 s.
2. *(done — PR #190)* Bonjour advertisement. Once Caddy is answering, the runtime
   registers `_waffled._tcp` on the public port by supervising `/usr/bin/dns-sd -R` as one
   more child — through the system mDNSResponder, so nothing new binds 5353 and `go.mod`
   stays stdlib-only — and withdraws it first on the way down. The instance name is the
   household's when there is exactly one, else "Waffled on \<computer\>", and an install
   with no household yet advertises `setup=1` so a phone can offer to finish setup instead
   of a sign-in; that flips to the household's name, without a restart, the moment the
   wizard creates one. `status --json` grows an additive `bonjour` block and `doctor`
   browses for our own registration, which is how a household learns that the firewall or
   the Local Network privacy prompt is what is hiding the server. A failed advertisement is
   never fatal: it is advisory, absent from the services array, and a household that cannot
   be discovered still has a completely working server.
3. *(done — PR #186)* `backup|restore`, the nightly schedule and `backup_runs`.
   `waffled-runtime backup` takes a custom-format `pg_dump` into `backups/` with a JSON
   sidecar recording the migration level, keeps the last 14, and writes the same
   `backup_runs` rows the Compose sidecar does so Settings → System Health keeps working
   (which is why `BACKUP_ENABLED` is now `true` natively — on `false` the api
   short-circuits that check and would hide them). It works with the server stopped by
   starting Postgres alone, because a launchd *user agent* is the only schedule available
   without an admin prompt and the Macs this matters on are the ones nobody is sitting at.
   `restore` stops the whole stack — restart supervision would otherwise fight it —
   rebuilds PowerSync's slot and storage, and refuses a dump newer than the bundle before
   stopping anything. Compose's plain `.sql.gz` dumps restore too, which is the
   Docker-to-Mac path. `backup --install-schedule` generates and loads the launchd agent.
4. *(done — PR #189)* Integration test: spins the whole stack from an empty data dir on CI
   (macOS runner) and hits the same health endpoints as Phase 1. `.github/workflows/native-runtime.yml`
   runs `apps/runtime`'s Go checks on every PR, plus a `macos-15` job that builds the real
   bundle (`build.sh fetch|build|verify`) and runs the `-tags integration` suite against it.
5. *(done — PR #193)* The update path, across two bundle versions. A `start` from a newer
   bundle is the update (§6), so the runtime's half is the data: snapshot named for the
   crossing → migrate → api health gate → automatic restore, then a **downgrade guard** that
   refuses to open data a newer build has already migrated and says how to get out of it —
   re-install the newer version, or restore the newest snapshot this build can actually
   serve. `status --json` grows `bundle.version`, `bundle.previousVersion` and
   `bundle.versionChangedAt` — direction-neutral, because re-installing an older build is the
   documented recovery here, so `status` derives "updated from" / "rolled back from" /
   "changed from" by comparing the two versions. The whole loop is tested against two
   real bundles over one data directory, including re-installing the previous version onto
   rolled-back data — the half a person does, which nothing had exercised before.
6. **Exit criterion, done.** `waffled-runtime start` on a fresh Mac user account reaches
   green in under 60s and `stop`/`start` re-opens the same data. Cold start is **17.1 s**
   via the CLI (14.9 s in-process) and warm restart **2.3 s**, both against the 60 s
   criterion (`apps/runtime/README.md` timings table); `TestRestartReopensTheSameData`
   proves stop/start re-opens the same data. **Phase 2 complete (2026-09-09).**

### Phase 3 — Menu-bar app

Done. The app exists, carries its own runtime, drives a real server from it, walks a
household through its first run, updates itself, and is now signed with a Developer ID,
notarized and shipped as a DMG anyone can download. CI assembles the `.app` and boots it on
every change; a release is `./waffled release X.Y.Z` followed by
`apps/mac/Scripts/release-mac.sh X.Y.Z` on the signing Mac.

1. `apps/mac/` SwiftUI `MenuBarExtra`, XcodeGen project like iOS, bundles the runtime and
   binaries under `Resources/runtime/`. *(done — PR #195 the app, PR #196 the embedding)* →
   The XcodeGen project, the `status --json` client and the app landed first; the
   **embedding** followed: `waffled-runtime` is now built into the bundle (and into its
   manifest) by `infra/native/bundle/build.sh`, `apps/mac/Scripts/build-app.sh` assembles a
   671 MB `Waffled.app` with that bundle cloned into `Contents/Resources/runtime`, and CI
   boot-tests the assembled app with **no dev-mode environment variables** — it finds the
   runtime it carries, verifies it against its manifest and brings a real server up from an
   empty data directory. Signing is not a prerequisite for embedding after all: it is a
   later pass over the same tree (item 5), which is why the manifest is written last.
2. Icon states (stopped / starting / running / error), the menu from §2, "Open Waffled".
   *(done — PR #195; the first-run window is item 3)* → The Waffled mark itself — the closed
   waffle iron from the logo, drawn in CoreGraphics as a template image (a menu-bar image is
   monochrome, so state cannot be colour): outlined stopped, its six holes cooking one at a
   time while `starting`, solid running, slashed when it needs a person. The §2 menu is
   there including the address-copy, backup, `Start Waffled` and the quit-stops-the-server
   confirmation. On launch it starts a stopped server **once** — the first poll that answers
   spends the attempt, so a server stopped from Terminal later is left alone — and opens the
   web app in the browser once per process (the rule was narrowed in item 3). A `stop` that
   refuses during quit keeps the app alive to say so rather than exiting on a server that is
   still running.
3. First-run window (welcome → starting → "your server is ready, opening…") and the MacBook
   warning. *(done — PR #197)* → The runtime answers the question — `status --json` gained
   an additive `initialized`, a stat of `postgres/PG_VERSION`, so the app never stats a
   layout the runtime owns — and the window appears only when the first poll that *answers*
   says false. The welcome step **holds** the auto-start open rather than spending it: the
   button is what starts a first run, `Start Waffled` in the menu counts as the same click,
   and closing that step quits without creating anything. Everything the window draws is a
   pure `FirstRunPresentation`, so the four steps, the service ticks and the copy are tested
   without a window.
   - **The relaunch rule.** The browser now opens once per process and only when someone is
     waiting for it: the end of a first run, or a click on `Start Waffled`. "Any start this
     app made" included the login item's start at every boot, which would have opened a
     browser window on every reboot — the opposite of §2 step 6.
   - **Portable detection.** `Hardware.isPortable` is a pure function over two readings:
     an internal battery from IOKit power sources, **or** "MacBook" in `hw.model`. The
     battery is the load-bearing half — Apple Silicon laptops report `Mac14,7` and friends,
     with no MacBook in the string.
4. Login item via `SMAppService`. *(done — PR #195)* → Wired to `SMAppService.mainApp`, and
   it works in an **unsigned** build: measured on macOS 15.7, an ad-hoc-signed `LSUIElement`
   app registers from a `DerivedData` path, contrary to the common assumption. The status is
   re-read on every poll, since System Settings can change it behind the app's back; a failed
   attempt annotates the label and leaves the toggle usable, and only `requiresApproval`
   (which becomes a button that opens Login Items) and `notFound` stop being a toggle.
5. Signing + notarization pipeline (every embedded binary), DMG build, Sparkle appcast.
   *(done — PR #201)* → One local command, `apps/mac/Scripts/release-mac.sh X.Y.Z`, because
   the certificate, the notarytool profile and the Sparkle key all live in one login
   Keychain and none of them belong in CI (which stays ad hoc). It asserts the version
   against `project.yml`, builds the bundle and the app, signs, notarizes, staples,
   packages and uploads. `./waffled release` now bumps `apps/mac/project.yml` too, and says
   to run this afterwards.
   - **The order is the whole design.** Sparkle's nested code first (`Downloader.xpc`,
     `Installer.xpc`, `Updater.app`, `Autoupdate`, then the framework) — measured, not
     assumed: a Developer ID `xcodebuild` signs `Sparkle.framework` itself and leaves all
     four of those `Signature=adhoc`, which notarization rejects. Then every Mach-O in the
     embedded runtime, found by **magic bytes rather than extension** (124 of them in the
     0.14.3 bundle: Postgres ships extensions as `.dylib`, PowerSync's native prebuilds are
     `.node`, and node/caddy/waffled-runtime are bare names). Then the **manifest**, because
     signing rewrote the bytes it records hashes for. Then the app, shallow, never `--deep`
     — `--deep` would re-sign those 124 files as a side effect and undo the manifest.
   - **Entitlements: one, and it was measured.** With the whole tree signed and no
     entitlements anywhere, exactly one child died —
     `node: Fatal process out of memory: Failed to reserve virtual memory for CodeRange`.
     V8 needs `com.apple.security.cs.allow-jit`; Postgres, Caddy and the supervisor need
     nothing. That is the policy going forward (`apps/mac/CLAUDE.md`): the smallest set, one
     plist per binary that needs one, and a bundled dylib that fails library validation gets
     **re-signed by us**, never `disable-library-validation`.
   - Measured on an M1 Max: bundle 37 s, app 38 s, Sparkle 1 s, 124 binaries 5 s (parallel;
     ~10 minutes serially — `--timestamp` is a network round trip apiece), manifest + verify
     16 s, app signature 11 s. The two notarization round trips dominate.
6. Updater: the Sparkle appcast, swapping `Waffled.app` and relaunching. The **data** half —
   snapshot → migrate → health gate → restore on failure, plus the downgrade guard — is done
   in the runtime (Phase 2 item 5), because a `start` from the newer bundle is the update.
   *(done — PR #199)* → Sparkle 2 via SPM, pinned exactly, with the EdDSA public key, the
   `releases/latest/download/appcast.xml` feed, a daily check and `SUAutomaticallyUpdate:
   false` in the plist; `Check for updates…` drives the real updater.
   - **The rule that makes it an update: stop before the relaunch.** macOS keeps a running
     process's mapped binaries alive after the files under them are replaced, so a swap over
     a live server leaves the household on the old runtime — and the relaunched app, finding
     it `running`, stands its one auto-start down and never migrates anything. The delegate
     postpones Sparkle's relaunch until `stop` succeeds; a `stop` that refuses holds the
     relaunch, slashes the icon and says why, exactly as a refused stop during quit does.
     Everything after that is the ordinary auto-start, which is the update. A held update
     keeps Sparkle's install handler and turns the menu item into `Install the update now`,
     because a postponed session leaves `checkForUpdates` a no-op until the app relaunches.
     And an install that aborts *after* the stop (a bad signature, an authorisation someone
     declined) leaves the household with no server and no update, so the app starts back the
     one it stopped and says why.
   - **Quit obeys the same rule, and has to.** Once Sparkle's installer has extracted and
     validated the new app it listens for this process to exit and finishes the swap whenever
     that happens, for any reason at all (`Autoupdate/AppInstaller.m` — `startInstallation`
     arms it as soon as validation passes, well before the app is asked to postpone
     anything), and Sparkle exposes no way to cancel it. So a refused stop with an update
     armed is the one case where `Quit anyway (server keeps running)` cannot be offered: the
     item reads `Quit — stop the server first (an update will install on quit)` and is
     disabled, with `Install the update now` as the retry and `waffled-runtime stop` in
     Terminal as the way out. **The alert's `Install on Quit` button is handled the same
     way**: it ends the cycle with no error and leaves the app holding no install block at
     all, while Sparkle stays armed — so the gate is keyed on the flow's own latched
     `armed`, set on the earliest news of a prepared installer and never cleared by a cycle
     ending, an abort or an error. It clears in one place only, once our stop has succeeded
     and the app has been handed over. The whole thing is a table in
     `apps/mac/Sources/UpdateFlow.swift`.
   - **Known edge, documented rather than detected (item 5's call).** Dragging a newer DMG
     over a running install has the same stale-server problem with nobody to stop the
     server first — the swapped app keeps talking to the runtime already in memory until
     the next stop/start. The app **cannot** see it: `status --json` runs as its own
     process, so `versions.waffled` and `bundle.version` both come from the manifest of the
     bundle **on disk**, which after the drag is the new one. They would equal the app's own
     `CFBundleShortVersionString` in exactly the case worth catching. The running server's
     version does exist — `rtstate.BundleVersion`, "the Waffled version this data was last
     STARTED with" — but it is not in the contract, and `bundle.previousVersion` is not a
     substitute (it is written only by a start that *crossed* versions). Detecting this
     would mean adding a field to `status --json`, so it stays a docs line: the Mac install
     page says **quit Waffled before replacing it**, and `Check for updates…` — which does
     the stop itself — is the path that avoids the question.
   - `WAFFLED_APPCAST_URL` overrides the feed for a test run — a seam, not a boundary; the
     EdDSA key is what an update has to satisfy. `Scripts/make-appcast.sh` signs a directory
     of releases into the feed, and `release-mac.sh` (item 5) is what calls it.
7. **Exit criterion:** a fresh Mac, no dev tools, download → household created in under
   five minutes, timed by someone who didn't build it. *(the pipeline half is done — PR #201)*
   → The whole thing was run once for real: `release-mac.sh 0.14.3 --no-upload` produced a
   **303 MB `Waffled-0.14.3.dmg`**, notarization **Accepted** for the app and for the DMG,
   `spctl -a -vv -t install` on the DMG reads **`source=Notarized Developer ID`**, and the
   app mounted out of it — Gatekeeper-quarantined, on a scratch data directory — boots
   Postgres, node, Caddy and PowerSync to `running` and answers `/healthz` 200 under the
   hardened runtime. What is left of this item is the part no script can do: a person who
   did not build it, on a Mac that has never had Xcode, holding a stopwatch.

### Phase 4 — iOS discovery and docs

1. iOS "Find your Waffled server" via Bonjour, with manual address as fallback.
2. Docs site: "Waffled for Mac" how-to (install, where data lives, backups, uninstall,
   Mac mini auto-login), features reference, roadmap → Done, README download link.
   *(done — PR #201, with item 5: the release that made the app downloadable is the release
   that needed the docs)* → `website/docs/…/install/mac.md`, a line in the feature matrix,
   and the roadmap entry moved to Done.

### Later (not this wrap-up)

- Daemon mode (boot without login). Universal (x86_64) build. Windows (§9). LAN TLS.

---

## 8. Effort, honestly

- Phase 1: a day or two, most of it fighting PowerSync's build and Postgres binaries.
- Phase 2: about a week for the supervisor + tests.
- Phase 3: one to two weeks, half of which is signing/notarization/Sparkle plumbing, not UI.
- Phase 4: a few days.

The two unknowns that could have blown this up were both in Phase 1, which is why it went
first and was throwaway. Both came back yes.

---

## 9. Windows (parked; recorded so Phase 2 doesn't foreclose it)

Same runtime, different wrapper. Postgres, Node, and Caddy all have official Windows builds
and the Go supervisor cross-compiles. What differs: supervision is a Windows Service (which
runs at boot without login, better than macOS), packaging is an MSI (WiX/Inno) with an
Authenticode certificate (expect SmartScreen warnings until reputation builds), Defender
Firewall prompts for the inbound port, Postgres refuses to run as Administrator, antivirus
scans PGDATA unless excluded, and mDNS advertising needs a library (or Bonjour for Windows'
own `dns-sd.exe`) since Windows only resolves `.local` natively — the runtime already has
the seam for it: `internal/bonjour`'s non-darwin `Tool()` returns `""` and advertising is
skipped rather than failed. Cross-compiling the supervisor itself still needs Windows
equivalents for three POSIX calls it uses today (`Flock`, `Setsid`/`Setpgid`, `Statfs`);
Linux builds clean. The tray app can be tiny if the manager UI is a localhost web page
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
