---
title: Environment variables
description: Every environment variable Waffled reads, what it does, and its default.
---

All configuration lives in **`infra/compose/.env`** (created from `.env.example` on first run).
Change a value, then `./waffled up` to apply it. Defaults below come from the compose file and
the api's config; "auto" means `./waffled` generates it for you on first run.

> **Secrets are generated for you.** `LOCAL_JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, and
> `POSTGRES_PASSWORD` are auto-filled on first run (if `openssl` is present). You only set the
> ones for features you turn on.

## Core / required

| Variable | Purpose | Default |
|---|---|---|
| `POSTGRES_USER` | Database user | set in `.env` |
| `POSTGRES_PASSWORD` | Database password | auto |
| `POSTGRES_DB` | Database name | set in `.env` |
| `POSTGRES_PORT` | Host port for Postgres | `5432` |
| `DATABASE_URL` | Built by compose (`postgres://…@postgres:5432/…`) for api/migrate/backup | derived |
| `LOCAL_JWT_SECRET` | HS256 secret for built-in auth + dev tokens | auto |
| `TOKEN_ENCRYPTION_KEY` | AES key that encrypts Google **and** OIDC secrets at rest | auto |
| `POWERSYNC_JWT_PRIVATE_KEY` | Stable RS256 key that signs PowerSync tokens. **Set this** — empty means a new key every restart, which drops all clients offline | empty ⚠️ |
| `POWERSYNC_JWT_KID` | Key ID for the PowerSync signing key | `waffled-powersync-1` |
| `HTTP_PORT` / `API_PORT` / `POWERSYNC_PORT` | Host ports (Caddy / api / PowerSync) | `8080` / `3000` / `8090` |
| `NODE_ENV` | Node environment | `production` |

> ⚠️ **`POWERSYNC_JWT_PRIVATE_KEY` is the one to not skip.** If it's empty the api regenerates its
> signing key on every restart, PowerSync rejects the tokens (`PSYNC_S2101`), and *every* client
> shows "Offline." Set a stable value once and never rotate it. See
> [Troubleshooting](/operations/troubleshooting/#powersync-offline-banner).

## URLs & access (set by `./waffled setup`)

| Variable | Purpose | Default |
|---|---|---|
| `POWERSYNC_PUBLIC_URL` | The sync URL clients connect to — **must be reachable by the device** (LAN IP / hostname, not `localhost`) | `http://localhost:8090` |
| `PUBLIC_BASE_URL` | Public origin for OIDC + Google redirect URLs; empty = derived from request | empty |
| `CADDY_SITE_ADDRESS` | `:80` (plain HTTP) or a hostname (triggers Caddy auto-TLS) | `:80` |

See [Reverse proxy & TLS](/install/reverse-proxy/) for the full remote-access story.

## Auth & sessions

| Variable | Purpose | Default |
|---|---|---|
| `ACCESS_TOKEN_TTL_SECONDS` | Access-token lifetime | `3600` (1h) |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh-token lifetime | `60` |
| `AUTH_FORCE_PASSWORD` | Break-glass: always show the password form, even in SSO-only mode (`=1`) | unset |
| `OIDC_NATIVE_REDIRECT_URI` | Exact native-app callback accepted by the OIDC redirect allowlist | `waffled://auth/callback` |
| `LOCAL_JWT_ISSUER` / `LOCAL_JWT_AUDIENCE` | Local JWT issuer / audience | `waffled-local` / `waffled-api` |
| `HOUSEHOLD_CLAIM` | Token claim carrying the household id | `https://waffled.app/household_id` |
| `KIOSK_PIN_MAX_ATTEMPTS` | Kiosk PIN attempts before lockout | `5` |
| `KIOSK_PIN_LOCKOUT_SECONDS` | Kiosk PIN lockout window | `30` |

**OIDC/SSO is configured in-app** (Settings → Login & security), *not* via env — the encrypted
client secret lives in the database. See [Authentication & SSO](/administration/authentication/).

### Auth0 mode (optional, advanced)

Setting `AUTH0_DOMAIN` switches the whole app from local HS256 to Auth0 RS256 validation. Most
self-hosters never touch these (built-in auth + in-app OIDC covers SSO).

| Variable | Default |
|---|---|
| `AUTH0_DOMAIN` | unset (→ local mode) |
| `AUTH0_AUDIENCE` | unset |
| `AUTH0_ISSUER` | derived `https://$DOMAIN/` |
| `AUTH0_JWKS_URI` | derived `.well-known/jwks.json` |

## AI providers (optional)

Set any subset; choose the active provider/model **per household** in Settings → AI & capture.
Keys never leave the server. See [AI providers](/administration/ai-providers/).

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) key | null |
| `ANTHROPIC_MODEL` | Anthropic model | `claude-haiku-4-5-20251001` |
| `OPENAI_API_KEY` | OpenAI key | null |
| `OPENAI_MODEL` | OpenAI model | `gpt-4o-mini` |
| `OPENAI_BASE_URL` | OpenAI-compatible endpoint (LM Studio / llama.cpp / vLLM) | `https://api.openai.com/v1` |
| `OLLAMA_HOST` | Local Ollama host | null |
| `OLLAMA_MODEL` | Ollama model | `llama3.1` |
| `AI_TIMEOUT_MS` / `CAPTURE_TIMEOUT_MS` | AI request timeout | `30000` |

## Google Calendar (optional)

Independent of login. See [Google Calendar](/administration/google-calendar/).

| Variable | Purpose | Default |
|---|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client id | null |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret | null |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Registered redirect (`…/auth/google/calendar/callback`) | null |
| `GOOGLE_CALENDAR_SCOPES` | OAuth scopes | `openid email …/auth/calendar` |
| `CALENDAR_SYNC_INTERVAL_MS` | Inbound sync poll interval | `300000` (5m) |

## Media / storage

| Variable | Purpose | Default |
|---|---|---|
| `STORAGE_DRIVER` | Blob storage backend | `local` |
| `MEDIA_DIR` | Where the api writes blobs (the `waffled_media` volume) | `/data/media` |
| `MEDIA_BASE_URL` | Public path Caddy serves blobs at | `/media` |

## Backups & S3

Full guide: [Backup & restore](/operations/backup/).

| Variable | Purpose | Default |
|---|---|---|
| `BACKUP_ENABLED` | Lets health expect a recent backup (set `false` only if you remove the service) | `true` |
| `BACKUP_TIME` | Daily HH:MM (container TZ) | `02:00` |
| `TZ` | Container timezone | `UTC` |
| `BACKUP_ON_START` | Also back up right after start | `false` |
| `BACKUP_RETENTION_DAYS` | Prune local dumps older than this | `14` |
| `BACKUP_INCLUDE_MEDIA` | Also tar the media dir | `false` |
| `BACKUP_HOST_PATH` | Write dumps to a host folder instead of the volume | volume |
| `BACKUP_S3_BUCKET` | e.g. `s3://my-bucket/waffled`; empty = local-only | empty |
| `BACKUP_S3_ENDPOINT` | Set for B2 / R2 / MinIO; empty = AWS | empty |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | S3 credentials | empty |
| `BACKUP_S3_REGION` | S3 region | `us-east-1` |

## Image tags / versioning

| Variable | Purpose | Default |
|---|---|---|
| `WAFFLED_VERSION` | The single version knob — resolves all three GHCR tags | current release |
| `WAFFLED_API_IMAGE` / `WAFFLED_CADDY_IMAGE` / `WAFFLED_BACKUP_IMAGE` | Explicit image overrides (win over `WAFFLED_VERSION`) | GHCR `:${WAFFLED_VERSION}` |
| `GIT_SHA` / `BUILD_TIME` | Build provenance (set by `./waffled`) | `dev` / empty |

## Update notifier

| Variable | Purpose | Default |
|---|---|---|
| `UPDATE_CHECK_ENABLED` | In-app "update available" check (`false` = no outbound call) | `true` |
| `UPDATE_CHECK_REPO` | GitHub repo to check | `kevinpsites/waffled` |

## Observability (optional, off by default)

Bring up with `./waffled observability up`. See [System health](/administration/system-health/).

| Variable | Purpose | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP backend; empty = OTEL disabled | empty |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP protocol | `http/protobuf` |
| `OTEL_SERVICE_NAME` | Service name in traces | `waffled-api` |
| `OTEL_SDK_DISABLED` | Kill switch | unset |
| `LOG_FORMAT` | `json` or `pretty` | `json` |
| `LOG_LEVEL` | Log verbosity | `info` |
| `GRAFANA_PORT` / `OTLP_GRPC_PORT` / `OTLP_HTTP_PORT` | lgtm host ports | `3001` / `4317` / `4318` |

## Background jobs & external APIs

| Variable | Purpose | Default |
|---|---|---|
| `EXPANSION_INTERVAL_MS` | Recurring-event / meal expansion job | `21600000` (6h) |
| `CHORE_PROOF_CLEANUP_INTERVAL_MS` | Chore-proof media cleanup | `86400000` (24h) |
| `OFF_API_BASE` | Open Food Facts base URL | `https://world.openfoodfacts.org` |
| `OFF_USER_AGENT` | Open Food Facts user agent | `Waffled-SelfHosted/1.0` |
| `OPEN_METEO_GEOCODE_URL` / `OPEN_METEO_FORECAST_URL` | Weather API endpoints | Open-Meteo defaults |
