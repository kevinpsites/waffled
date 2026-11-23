# Simplify the stack: one image + Postgres, `docker compose up -d`

Date: 2026-11-22 · Status: draft for approval

## Intent

This fork should install like a typical r/selfhosted project: grab a `compose.yaml`, run
`docker compose up -d`, open the port, and the app works. Today the stack is seven
containers, needs four generated secrets, and is driven by a 1,400-line `./waffled` bash
CLI. The Mac app, its Go supervisor, and the native iOS app add surfaces the fork does
not want to maintain. The product is the web app, used in a browser or installed as a PWA.

This is the first of three efforts. A later, separate effort will simplify the UI
("de-Clauding"); it is out of scope here.

## Goals

- `docker compose up -d` from a fresh clone (or a downloaded `compose.yaml`) brings up a
  working instance with **no `.env` file and no helper script**.
- Two always-on containers: `waffled` (api + web app + media) and `postgres`.
- Backups available as an opt-in compose profile.
- Remove: the Mac app, the Go native runtime, the iOS app, PowerSync, Caddy, the
  `./waffled` / `./waffled-demo` CLIs, the OCI Terraform guide.
- Existing data in Postgres and the media volume survives the switch.

## Non-goals

- UI simplification (next effort).
- Built-in HTTPS. Users put their own reverse proxy (Traefik, Nginx Proxy Manager,
  Caddy, Cloudflare Tunnel) in front, as with most self-hosted apps.
- Offline calendar editing in the web app (lost with PowerSync; the PWA service worker
  for app-shell caching stays).
- Keeping compatibility with the upstream App Store iOS app.
- Changing the Waffled-Bite firmware (it only uses the REST API and keeps working).

## Anti-goals (fail even if it "works")

- A required `.env`, a required setup command, or "run this script first".
- An all-in-one image that bundles Postgres.
- Silently weakening security: rate limiting and OAuth/OIDC callbacks must stay correct
  without Caddy rewriting headers.
- Losing a user's existing database or uploaded photos on upgrade.

## Approaches considered

- **A. One `waffled` image + Postgres (chosen).** The Node api also serves the built SPA
  and `/media`, runs migrations at startup, and generates its own secrets on first boot.
  Two services, one port. Matches r/selfhosted norms.
- **B. Keep Caddy in front (three containers).** Built-in auto-HTTPS, but an extra
  container and a routing layer that has already caused bugs (the Outlook callback was
  never routed through Caddy).
- **C. Single container including Postgres.** Simplest to start, but awkward Postgres
  upgrades/backups and against Docker conventions.

The user picked A.

## Design

### Target `compose.yaml` (repo root)

```yaml
name: waffled
services:
  waffled:
    image: ghcr.io/evan-ribbey/waffled:${WAFFLED_VERSION:-latest}
    build: .
    ports: ["${HTTP_PORT:-8080}:3000"]
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-waffled}:${POSTGRES_PASSWORD:-waffled}@postgres:5432/${POSTGRES_DB:-waffled}
      TZ: ${TZ:-UTC}
    volumes:
      - waffled_data:/data
      - waffled_media:/data/media
    depends_on: { postgres: { condition: service_healthy } }
    restart: unless-stopped
  postgres:
    image: postgres:16
    command: ["postgres", "-c", "wal_level=logical"]   # transitional, see Migration path
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-waffled}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-waffled}
      POSTGRES_DB: ${POSTGRES_DB:-waffled}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"], interval: 5s, retries: 10 }
    restart: unless-stopped
  backup:
    profiles: ["backup"]
    # existing backup image, pointed at the same DB + a backups volume
volumes: { waffled_data: {}, waffled_media: {}, pgdata: {} }
```

- Postgres is **not** published to the host; it is only reachable on the compose network,
  so a fixed default password is acceptable. Every value is overridable from an optional
  `.env`; the compose file comments how.
- **Volume names are deliberately the old ones** (my call). Pinning `name: waffled` and
  keeping the keys `pgdata` and `waffled_media` yields `waffled_pgdata` and
  `waffled_waffled_media`, exactly what the old stack created, so an existing install's data
  is found in place. Only the new `waffled_data` volume (secrets) is new.
- Optional integrations (Google/Microsoft calendar, LLM keys, SMTP-less OIDC, etc.) stay
  as optional env vars, documented in a commented `.env.example`. None are required.
- `wal_level=logical` and the `powersync_storage` database are no longer needed.

### The `waffled` image (root `Dockerfile`)

Multi-stage: build the web app (`apps/web`) → build the api (`apps/api`) → runtime image
containing the api `dist/`, `migrations/`, and the SPA at a known path.

On start the container:

1. Ensures `/data` and `/data/media` exist and are writable by the app user (replaces the
   `volume-permissions` container; entrypoint runs as root, fixes ownership, drops to `node`).
2. Loads or creates `/data/secrets.json` holding `LOCAL_JWT_SECRET` and
   `TOKEN_ENCRYPTION_KEY`. Values set in the environment always win. Created once, never
   rotated automatically (rotating `TOKEN_ENCRYPTION_KEY` would orphan stored OAuth tokens).
   Stored on the app volume, not in Postgres, so a DB dump alone does not carry the key that
   decrypts the tokens inside it.
3. Runs migrations (existing `migrate.ts`, which already takes an advisory lock).
4. Starts the HTTP server and schedulers.

### Serving the web app and media from the api

`platform/http-server.ts` gains a static layer in front of the lambda-api dispatch:

- `/api/*` and `/auth/*` → existing routes (this also fixes the unrouted
  `/auth/microsoft/calendar/callback`).
- `/media/*` → files under `MEDIA_DIR`, long-lived immutable cache headers, path-traversal safe.
- Anything else → the SPA file if it exists, else `index.html` (SPA fallback).
- `sw.js` and `index.html` served `no-cache`; hashed assets immutable.
- `/healthz` stays a cheap liveness endpoint for the compose healthcheck.

### Forwarded headers without Caddy

Today the api trusts `X-Forwarded-For` / `-Proto` / `-Host` blindly because Caddy rewrote
them. Exposed directly, that lets a client spoof its address past the rate limiter.

- New env `TRUST_PROXY` (default off). Off: client address = socket address; proto/host
  from the request. On (or a list of proxy CIDRs): honour the forwarded headers.
- The existing `PUBLIC_BASE_URL` env overrides the derived origin for OAuth/OIDC redirect
  URIs; documented as the thing to set when behind a reverse proxy.

### Removing PowerSync

- API: delete `modules/powersync/*`, the `/api/powersync/*` and `/api/auth/keys` routes,
  the PowerSync env vars and the RSA key. Add a new migration that drops the PowerSync
  publication, drops any PowerSync logical replication slots (`pg_drop_replication_slot`),
  and reverts `REPLICA IDENTITY FULL` (fix-forward; never edit applied migrations). It must
  be a no-op on a fresh database.
- Postgres 16 refuses to boot with a logical slot present and `wal_level` below `logical`,
  so 0.16.x keeps `wal_level=logical` in compose; the release after drops the flag (my call).
  The orphaned `powersync_storage` database is left alone (cannot be dropped inside a
  migration transaction); the migration guide shows the optional `DROP DATABASE`.
- Web: delete `lib/powersync/*` and the sync-health/watchdog UI; events, persons and
  households read through the existing REST endpoints and the `bus.ts` refetch pattern.
  Writes that went through `events-local` go through the REST event endpoints.
- Remove `infra/compose/powersync/`.

### Removed outright

`apps/ios`, `apps/mac`, `apps/runtime`, `infra/native`, `infra/terraform`,
`infra/compose/caddy`, `waffled`, `waffled-demo`, `tests/waffled.test.sh`,
`.github/workflows/native-runtime.yml`, root `wrangler.jsonc` (stale), and API tests that
only test removed pieces (compose-network, compose-secrets, waffled-upgrade, waffled-wait,
powersync-*, container-users where it targets the old images). Docs pages for the Mac app,
iOS app, native install and Oracle Terraform are removed or rewritten.

### Operator tasks after the change

- Admin CLI: `docker compose exec waffled node dist/admin.js <command>` (documented).
- Demo data: `docker compose exec waffled node dist/seed-demo.js` (replaces `./waffled-demo`).
- Upgrade: `docker compose pull && docker compose up -d` (migrations run on start).
- Backups: `docker compose --profile backup up -d`. Restore: the backup image gains a
  `restore <file>` command (`docker compose --profile backup run --rm backup restore <file>`)
  that refuses to run while the `waffled` container is up. No automatic backup before
  upgrades (user decision). `BACKUP_ENABLED` defaults to `false`, so System Health only
  warns about backups when the profile is on.
- Update check: `UPDATE_CHECK_REPO` defaults to `evan-ribbey/waffled-ng`. This change ships
  as **0.16.0** (user decision).
- The `observability` (Grafana LGTM) profile is dropped; OTel env vars still work for anyone
  pointing at their own collector (my call).

### Dev workflow and release

- `docker compose up -d --build` builds from source.
- The release version bump moves from `./waffled release` to a small dev-only
  `scripts/release.sh` (bump `apps/api` + `apps/web` package versions, date the changelog,
  commit, tag). Root `CLAUDE.md` is updated: no `:8080`/`:8081` question, no `./waffled`.
- `publish-images.yml` publishes one `waffled` image (multi-arch) plus the backup image to
  the fork's GHCR namespace.

### Migration path for an existing install

A **documented manual switch** (user decision), kept short by the matching volume names:

1. `./waffled down` (old stack).
2. Put the new `compose.yaml` where the old one was, and copy these from the old
   `infra/compose/.env` into a `.env` beside it: `POSTGRES_USER`, `POSTGRES_PASSWORD`,
   `POSTGRES_DB`, `LOCAL_JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`. Env values beat
   `/data/secrets.json`, so sessions and stored calendar tokens keep working.
3. `docker compose up -d`. Migrations clean up PowerSync.
4. Optional: `DROP DATABASE powersync_storage;`, remove the old Caddy/PowerSync volumes.

The guide lives on the docs site. It warns that without the old `TOKEN_ENCRYPTION_KEY`,
calendar connections must be re-linked. No automated upgrade tests beyond the PowerSync
cleanup migration (on a DB that has a slot and publication) and the env-beats-secrets rule.

## Testing

TDD per repo rules. Integration tests (testcontainers) for: static SPA serving and fallback,
media serving and traversal rejection, secret bootstrap (create, reuse, env override),
migrate-on-start, `TRUST_PROXY` on/off behaviour for rate limiting and OIDC origin, the
PowerSync-drop migration, and the Microsoft callback reachable on the single port. A smoke
test in CI runs `docker compose up -d` on a clean runner and checks `/healthz` and `/`.

## Left to the builder

Exact entrypoint mechanics, Node base version for the runtime stage, static-serving
implementation (hand-rolled vs a small library), the order of removal commits, and how the
web events screens are rewired onto REST, as long as behaviour matches today minus offline.
