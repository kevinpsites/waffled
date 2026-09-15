# Upgrading without the repo — simpler `./waffled upgrade`

**Status (2026-09-15): Stage 1a in progress** on branch `worktree-upgrade-simplification`.
Stage 1b waits for the release that ships 1a. Stage 2 is unstarted.

Goal: an operator upgrade that downloads images and a few kilobytes of config, like Immich's
`docker compose pull && docker compose up -d` — instead of fast-forwarding a monorepo.

---

## 1. Why `upgrade` pulls the repo today

An operator runs the published GHCR images. Of the repo they clone (134 MB of history,
~1,800 files), the running stack reads **about 136 KB**: `./waffled` plus `infra/compose/*`.
v0.14.0 → v0.15.1 moved 757 files through that checkout that no operator executes.

The `git pull --ff-only` exists for three separate reasons:

1. **Config is bind-mounted from the checkout.** `./caddy/Caddyfile` → caddy,
   `./powersync/` (`service.yaml` + `sync-config.yaml`) → the stock PowerSync image,
   `./postgres/init/` → postgres (first boot only). `sync-config.yaml` selects from tables a
   migration *inside the api image* creates, so the checkout and the image tag must agree.
2. **Discovering the target version.** `upgrade` reads `WAFFLED_VERSION` out of the
   checkout's `.env.example`.
3. **Updating `./waffled` itself** — its `.env` bridges (`ensure_env`, the PowerSync URL,
   the Google callback) are why `maybe_reexec_upgrade` exists after the 0.7 → 0.8 break.

## 2. The correctness bug in the pull

`git pull` fetches **`main`**, not a release. Between a merge and its tag, `main` carries a
compose file, Caddyfile, and script that are newer than the images `.env.example` still
names. v0.13.1's compose/Caddyfile/`./waffled` changes landed on `main` on 2026-08-12; the
tag came 2026-08-19. An upgrade that week ran the new script (which clears a pinned
PowerSync URL) against the old api that still needed it. The "matched pair" the upgrade
docs promise only holds on a tag.

## 3. What Immich does differently

Install is two release assets (`docker-compose.yml`, `example.env`); there is no clone.
Their compose mounts **only data** (`${UPLOAD_LOCATION}:/data`, the DB data dir,
`/etc/localtime`) — no config files; even their Postgres tuning is a custom image. The
version is a floating major tag (`IMMICH_VERSION=v3`), so `pull && up -d` follows every 3.x
release; a compose change is called out as a breaking change and re-downloaded by hand.

We keep an **exact** pin rather than a floating tag: migrations are forward-only and
`upgrade` snapshots the DB first, so "move to X" should stay an explicit step.

## 4. Constraints

- **The config files stay in the repo.** The native Mac bundle copies `caddy/Caddyfile`,
  `postgres/init/00-init.sql`, and `powersync/*.yaml` verbatim (`infra/native/bundle/build.sh`
  `build_config`, `verify` diffs them). Baking them into images is additive — the repo copy
  stays canonical and the images `COPY` it.
- **The OCI box mounts the Caddyfile on purpose.** `docker-compose.oci.yml` (untracked,
  written by cloud-init) replaces caddy's volume list and mounts the repo `Caddyfile` as
  `Caddyfile.base` under its own `Caddyfile.oci`. Mounting over a baked file still works, so
  that box keeps working, but it keeps needing the checkout until its front block moves to
  an env-driven import.
- **A new compose must never run against an image that predates baked config.** A caddy
  image ≤ 0.15.1 has no Waffled Caddyfile; without the mount it silently serves Caddy's
  default site. Hence the two-release rollout in Stage 1.
- **New GHCR packages start private.** `waffled-powersync` must be made public after its
  first publish, before any compose file references it.
- **`00-init.sql` can't become a normal migration.** `CREATE DATABASE` can't run in a
  transaction and `node-pg-migrate` wraps each migration in one. It stays mounted until
  Stage 2 gives it a non-transactional pre-step.
- Maintainer paths (`up --build`, `release`, `web`, iOS) keep needing the checkout. This
  plan decouples the **operator** path only.

## 5. Stages

### Stage 1a — images carry their config; upgrade targets releases (this PR)

- [ ] **`upgrade` moves to the latest *release tag*, not `main`.** The target comes from
      the GitHub releases API (`UPDATE_CHECK_REPO`, the same call as the in-app update
      notifier). A GitHub Release is only created after its images are published, so the
      target can never name a missing image. `--version X.Y.Z` pins a specific release;
      moving backwards is refused (forward-only migrations). The checkout fast-forwards to
      the tag (or checks it out on a detached HEAD); a checkout already ahead of the release
      is left alone with a warning.
- [ ] **The caddy image bakes the Caddyfile** (`COPY` into `/etc/caddy/Caddyfile`). The
      compose mount stays for now and shadows it with identical content.
- [ ] **Publish `waffled-powersync`** — `FROM journeyapps/powersync-service:<pinned>` +
      the two YAMLs. Built and published for every release; the compose file keeps the stock
      image until 1b. A test holds the Dockerfile's base tag equal to the compose tag.

### Stage 1b — drop the config mounts (after the 1a release is published)

- [ ] Make `ghcr.io/kevinpsites/waffled-powersync` public.
- [ ] Remove the `./caddy/Caddyfile` mount; switch powersync to
      `${WAFFLED_POWERSYNC_IMAGE:-ghcr.io/kevinpsites/waffled-powersync:${WAFFLED_VERSION}}`
      and remove the `./powersync` mount.
- [ ] `up` / `upgrade` refuse a `WAFFLED_VERSION` older than the 1a release when no image
      override is set, naming `./waffled upgrade` as the fix.
- [ ] After 1b, `upgrade` needs the checkout only for the compose file and `./waffled`.

### Stage 2 — install and upgrade without git

- [ ] Move `00-init.sql` (pgcrypto + `powersync_storage`) into a non-transactional step of
      the `migrate` one-shot; drop the postgres init mount.
- [ ] Attach `docker-compose.yml` and `waffled` to each GitHub Release (the release job
      already attaches `example.env`).
- [ ] `upgrade` without a git checkout downloads those two assets for the target tag and
      hands off to the new script (the existing re-exec).
- [ ] `./waffled migrate` → `docker compose run --rm migrate` (the last operator command
      that runs app source on the host).
- [ ] Install docs become "download two files, run `./waffled up`"; `git clone` stays
      documented for contributors.
