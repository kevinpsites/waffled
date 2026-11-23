---
title: Environment variables
description: Every environment variable Waffled reads, what it does, and its default.
---

Every setting is optional: `docker compose up -d` works with no `.env` at all. To change one,
copy [`.env.example`](https://github.com/evan-ribbey/waffled-ng/blob/main/.env.example) to
**`.env` in the same folder as `compose.yaml`**, uncomment the line, and run
`docker compose up -d` again. Settings must live in that file: variables exported in your shell
do not reach the containers (this needs Docker Compose v2.24+). Defaults below come from the
compose file and the app's config.

> **Secrets are generated for you.** On first start the app writes `LOCAL_JWT_SECRET` and
> `TOKEN_ENCRYPTION_KEY` to `/data/secrets.json` in the `waffled_data` volume and reuses them.
> A value set in `.env` always wins, and is saved to the file so removing it later keeps the same key. They are never rotated automatically: rotating
> `TOKEN_ENCRYPTION_KEY` orphans stored calendar and SSO tokens.

## Core

| Variable | Purpose | Default |
|---|---|---|
| `HTTP_PORT` | Host port the app is published on (maps to container port 3000) | `8080` |
| `TZ` | Container timezone (also the backup schedule's) | `UTC` |
| `WAFFLED_VERSION` | Image tag to run (pin a release, e.g. `0.16.0`) | `latest` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Database credentials. Postgres is never published to the host. Set before the first start; changing them later does not change an existing database. Use URL-safe characters | `waffled` / `waffled` / `waffled` |
| `MIGRATE_LOCK_TIMEOUT` | How long a migration waits for a table lock before retrying; milliseconds or a duration like `30s`, `0` waits indefinitely. See [Upgrade stuck on migrate](/operations/troubleshooting/#upgrade-stuck-on-migrate) | `10s` |
| `DATABASE_URL` | Built by compose (`postgres://…@postgres:5432/…`) | derived |
| `LOCAL_JWT_SECRET` | HS256 secret for built-in auth (`openssl rand -base64 48`) | generated |
| `TOKEN_ENCRYPTION_KEY` | AES key that encrypts Google, Outlook **and** OIDC secrets at rest (`openssl rand -base64 32`) | generated |
| `NODE_ENV` | Node environment | `production` |

Production startup refuses missing or malformed required secrets; with no `.env` the app
generates valid ones.

## URLs & reverse proxy

| Variable | Purpose | Default |
|---|---|---|
| `PUBLIC_BASE_URL` | Public origin for OIDC and calendar redirect URLs; empty = derived from the request | empty |
| `TRUST_PROXY` | Honour `X-Forwarded-For`, `-Proto` and `-Host`. Set `true` **only** behind a reverse proxy you control; otherwise clients could spoof their address past the rate limiter | off |

See [Reverse proxy & TLS](/install/reverse-proxy/) for the full remote-access story.

## Auth & sessions

| Variable | Purpose | Default |
|---|---|---|
| `ACCESS_TOKEN_TTL_SECONDS` | Access-token lifetime | `3600` (1h) |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh-token lifetime | `60` |
| `AUTH_FORCE_PASSWORD` | Break-glass: always show the password form, even in SSO-only mode (`=1`) | unset |
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

Set any subset; choose the active provider/model **per household** in Settings → AI & Capture.
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

Independent of login. See [Google Calendar](/administration/google-calendar/) and
[Outlook / Microsoft 365](/administration/outlook-calendar/).

| Variable | Purpose | Default |
|---|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client id | null |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret | null |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Registered redirect (`…/auth/google/calendar/callback`) | `http://localhost:8080/auth/google/calendar/callback` |
| `GOOGLE_CALENDAR_SCOPES` | OAuth scopes | `openid email …/auth/calendar` |
| `MS_CLIENT_ID` | Azure app (client) id | null |
| `MS_CLIENT_SECRET` | Azure client secret | null |
| `MS_CALENDAR_REDIRECT_URI` | Registered redirect (`…/auth/microsoft/calendar/callback`) | null |
| `MS_CALENDAR_SCOPES` | Microsoft Graph scopes | `openid email offline_access User.Read Calendars.ReadWrite` |
| `CALENDAR_SYNC_INTERVAL_MS` | Inbound sync poll interval (Google + Outlook) | `300000` (5m) |
| `ICS_SYNC_INTERVAL_MS` | Calendar-feed (ICS) refresh interval; `0` disables | `900000` (15m) |

## Media / storage

| Variable | Purpose | Default |
|---|---|---|
| `STORAGE_DRIVER` | Blob storage backend | `local` |
| `MEDIA_DIR` | Where the api writes blobs (the `waffled_media` volume) | `/data/media` |
| `MEDIA_BASE_URL` | Public path blobs are served at (the app serves `/media` itself) | `/media` |

## Backups & S3

Full guide: [Backup & restore](/operations/backup/). Backups are **off by default**: start the
service with `docker compose --profile backup up -d` and set `BACKUP_ENABLED=true`.

| Variable | Purpose | Default |
|---|---|---|
| `BACKUP_ENABLED` | Lets System Health expect (and warn about) a recent backup. Set `true` when you run the backup profile | `false` |
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
| `WAFFLED_VERSION` | Tag for both the `waffled` and `waffled-backup` GHCR images | `latest` |

## Update notifier

| Variable | Purpose | Default |
|---|---|---|
| `UPDATE_CHECK_ENABLED` | In-app "update available" check (`false` = no outbound call) | `true` |
| `UPDATE_CHECK_REPO` | GitHub repo to check | `evan-ribbey/waffled-ng` |

## Observability (optional, off by default)

The bundled Grafana stack was removed in 0.16, but the app still exports OpenTelemetry to any
collector you point it at. See [System health](/administration/system-health/).

| Variable | Purpose | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP backend; empty = OTEL disabled | empty |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP protocol | `http/protobuf` |
| `OTEL_SERVICE_NAME` | Service name in traces | `waffled` |
| `OTEL_SDK_DISABLED` | Kill switch | unset |
| `LOG_FORMAT` | `json` or `pretty` | `json` |
| `LOG_LEVEL` | Log verbosity | `info` |

## Background jobs & external APIs

| Variable | Purpose | Default |
|---|---|---|
| `EXPANSION_INTERVAL_MS` | Recurring-event / meal expansion job | `21600000` (6h) |
| `CHORE_PROOF_CLEANUP_INTERVAL_MS` | Chore-proof media cleanup | `86400000` (24h) |
| `OFF_API_BASE` | Open Food Facts base URL | `https://world.openfoodfacts.org` |
| `OFF_USER_AGENT` | Open Food Facts user agent | `Waffled-SelfHosted/1.0` |
| `OPEN_METEO_GEOCODE_URL` / `OPEN_METEO_FORECAST_URL` | Weather API endpoints | Open-Meteo defaults |
