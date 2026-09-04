#!/usr/bin/env bash
# Phase 1 spike: the whole Waffled stack natively on macOS (arm64), no Docker.
# Throwaway. See README.md in this directory for what was learned.
#
#   ./spike.sh fetch     download/build everything into the cache (idempotent)
#   ./spike.sh up        postgres → init sql → migrate → api → powersync → caddy
#   ./spike.sh status    pids, health, RSS per process
#   ./spike.sh logs [svc] [lines]
#   ./spike.sh down      stop everything (reverse order)
#   ./spike.sh reset     wipe the spike DATA dir only (asks y/N)
#
# bash 3.2-clean (macOS /bin/bash): no associative arrays, no ${x,,}, no mapfile.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SPIKE_DIR/../../.." && pwd)"

# ── Pins ────────────────────────────────────────────────────────────────────
# Postgres 16 via the embedded-postgres npm binaries (EDB-built, universal, signed).
PG_NPM_PKG="@embedded-postgres/darwin-arm64"
PG_NPM_VERSION="${SPIKE_PG_VERSION:-16.14.0-beta.17}"
# Caddy 2 official darwin/arm64 release tarball from GitHub.
CADDY_VERSION="${SPIKE_CADDY_VERSION:-2.11.4}"
# PowerSync service, same tag as the compose image journeyapps/powersync-service:1.22.0.
POWERSYNC_TAG="${SPIKE_POWERSYNC_TAG:-v1.22.0}"
POWERSYNC_REPO="https://github.com/powersync-ja/powersync-service"
# The repo pins packageManager pnpm@11.0.9; pnpm@9 refuses its v9 lockfile ("overrides" mismatch).
PNPM_SPEC="pnpm@11.0.9"

# ── Dirs / ports ────────────────────────────────────────────────────────────
DATA="${SPIKE_DATA_DIR:-$HOME/Library/Application Support/WaffledSpike}"
CACHE="${SPIKE_CACHE_DIR:-$HOME/Library/Caches/WaffledSpike}"
NODE_BIN="${SPIKE_NODE_BIN:-/opt/homebrew/opt/node@24/bin}"
export PATH="$NODE_BIN:$PATH"

HTTP_PORT="${SPIKE_HTTP_PORT:-8090}"          # Caddy public (web + /api + /media)
PS_PUBLIC_PORT="${SPIKE_POWERSYNC_PORT:-8091}" # PowerSync via Caddy
API_PORT="${SPIKE_API_PORT:-3001}"             # api, loopback
PS_PORT="${SPIKE_PS_INTERNAL_PORT:-8092}"      # powersync, loopback
PG_PORT="${SPIKE_PG_PORT:-5433}"               # postgres, loopback

PGDATA="$DATA/postgres"
MEDIA_DIR="$DATA/media"
LOGS="$DATA/logs"
PIDS="$DATA/pids"
ENV_FILE="$DATA/config.env"

PG_HOME="$CACHE/postgres/pg16/native"
CADDY_BIN="$CACHE/caddy/caddy"
PS_SRC="$CACHE/powersync-service"
API_DIR="$ROOT/apps/api"
WEB_DIR="$ROOT/apps/web"

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_ylw=$'\033[33m'; c_reset=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓ %s%s\n' "$c_grn" "$*" "$c_reset"; }
warn() { printf '%s⚠ %s%s\n' "$c_ylw" "$*" "$c_reset"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; exit 1; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# ── config.env: the same four secrets `waffled` generates, generated the same way ──
env_val() { sed -n -E "s/^$1=(.*)$/\1/p" "$ENV_FILE" 2>/dev/null | head -n 1; }
set_env_var() {
  if grep -qE "^$1=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak -E "s|^$1=.*$|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    echo "$1=$2" >> "$ENV_FILE"
  fi
}
ensure_env() {
  mkdir -p "$DATA"
  if [ ! -f "$ENV_FILE" ]; then
    ( umask 077; : > "$ENV_FILE" )
    chmod 600 "$ENV_FILE"
  fi
  command -v openssl >/dev/null 2>&1 || die "openssl not found (needed to generate secrets)"
  # Identical to ensure_env in ./waffled (repo root): base64-48, base64-32, RSA-2048 PEM
  # base64'd on one line, and a HEX postgres password (URL-safe — it is interpolated
  # into postgres:// URLs).
  [ -n "$(env_val LOCAL_JWT_SECRET)" ] || set_env_var LOCAL_JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
  [ -n "$(env_val TOKEN_ENCRYPTION_KEY)" ] || set_env_var TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"
  [ -n "$(env_val POWERSYNC_JWT_PRIVATE_KEY)" ] || set_env_var POWERSYNC_JWT_PRIVATE_KEY "$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | openssl base64 -A)"
  [ -n "$(env_val POSTGRES_PASSWORD)" ] || set_env_var POSTGRES_PASSWORD "$(openssl rand -hex 24 | tr -d '\n')"
  [ -n "$(env_val POSTGRES_USER)" ] || set_env_var POSTGRES_USER waffled
  [ -n "$(env_val POSTGRES_DB)" ] || set_env_var POSTGRES_DB waffled
  for secret in LOCAL_JWT_SECRET TOKEN_ENCRYPTION_KEY POSTGRES_PASSWORD POWERSYNC_JWT_PRIVATE_KEY; do
    [ -n "$(env_val "$secret")" ] || die "$secret is missing in $ENV_FILE"
  done
  POSTGRES_USER="$(env_val POSTGRES_USER)"; POSTGRES_PASSWORD="$(env_val POSTGRES_PASSWORD)"
  POSTGRES_DB="$(env_val POSTGRES_DB)"
  DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$PG_PORT/$POSTGRES_DB"
  STORAGE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$PG_PORT/powersync_storage"
}

# ── helpers ─────────────────────────────────────────────────────────────────
pid_of() { cat "$PIDS/$1.pid" 2>/dev/null || true; }
alive() { local p; p="$(pid_of "$1")"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
http_ok() { curl -sf -o /dev/null --max-time 2 "$1"; }
http_code() { curl -s -o /dev/null --max-time 2 -w '%{http_code}' "$1" 2>/dev/null || echo 000; }
# /api/health is admin-only (adminRoute): 401 without a token still proves Caddy → api works.
api_health_reachable() { case "$(http_code "http://127.0.0.1:$HTTP_PORT/api/health")" in 200|401) return 0 ;; *) return 1 ;; esac; }
wait_http() { # wait_http <name> <url> <seconds>
  local i=0
  while [ "$i" -lt "$3" ]; do
    if http_ok "$2"; then return 0; fi
    alive "$1" || die "$1 exited during startup — see: $0 logs $1"
    sleep 1; i=$((i + 1))
  done
  die "$1 did not answer at $2 within ${3}s — see: $0 logs $1"
}
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
# Run a background service with its own log + pid file. Args after the name are the command.
spawn() {
  local name="$1"; shift
  mkdir -p "$LOGS" "$PIDS"
  nohup "$@" >> "$LOGS/$name.log" 2>&1 &
  echo $! > "$PIDS/$name.pid"
}
stop_pid() { # stop_pid <name> [seconds]
  local name="$1" secs="${2:-15}" p i=0
  p="$(pid_of "$name")"
  [ -n "$p" ] || return 0
  if kill -0 "$p" 2>/dev/null; then
    kill -TERM "$p" 2>/dev/null || true
    while kill -0 "$p" 2>/dev/null && [ "$i" -lt "$secs" ]; do sleep 1; i=$((i + 1)); done
    if kill -0 "$p" 2>/dev/null; then warn "$name ($p) ignored SIGTERM, killing"; kill -KILL "$p" 2>/dev/null || true; fi
  fi
  rm -f "$PIDS/$name.pid"
}
rss_kb() { ps -o rss= -p "$1" 2>/dev/null | tr -d ' '; }
pg_pid() { head -n 1 "$PGDATA/postmaster.pid" 2>/dev/null || true; }
# RSS of a process plus its direct children (Postgres = postmaster + workers).
rss_tree_kb() {
  local total=0 p r
  for p in "$1" $(pgrep -P "$1" 2>/dev/null || true); do
    r="$(rss_kb "$p")"; [ -n "$r" ] && total=$((total + r))
  done
  echo "$total"
}

# Tiny SQL runner over the api's `pg` (the embedded-postgres bundle ships no psql).
sql() { # sql <database-url> <file|->
  ( cd "$API_DIR" && node "$SPIKE_DIR/sql.mjs" "$1" "$2" )
}
sql_stmt() { printf '%s\n' "$2" | sql "$1" -; }

# ── fetch ───────────────────────────────────────────────────────────────────
fetch_postgres() {
  if [ -x "$PG_HOME/bin/postgres" ]; then ok "postgres already in cache ($("$PG_HOME/bin/postgres" --version))"; return; fi
  say "→ Postgres 16: npm pack $PG_NPM_PKG@$PG_NPM_VERSION"
  mkdir -p "$CACHE/postgres"
  ( cd "$CACHE/postgres" && npm pack "$PG_NPM_PKG@$PG_NPM_VERSION" >/dev/null )
  local tgz; tgz="$(ls "$CACHE/postgres"/embedded-postgres-darwin-arm64-*.tgz | head -n 1)"
  rm -rf "$CACHE/postgres/pg16"; mkdir -p "$CACHE/postgres/pg16"
  tar -xzf "$tgz" -C "$CACHE/postgres/pg16" --strip-components=1
  # The tarball carries no symlinks; the package's postinstall recreates them from
  # native/pg-symlinks.json (libicui18n.dylib → libicui18n.68.2.dylib, …). Without this
  # `postgres` dies at dyld time. Same script, run by hand:
  ( cd "$CACHE/postgres/pg16" && node scripts/hydrate-symlinks.js )
  xattr -dr com.apple.quarantine "$CACHE/postgres/pg16" 2>/dev/null || true
  "$PG_HOME/bin/postgres" --version >/dev/null || die "bundled postgres does not run"
  ok "postgres $("$PG_HOME/bin/postgres" --version) ($(du -sh "$CACHE/postgres/pg16" | cut -f1))"
}
fetch_caddy() {
  if [ -x "$CADDY_BIN" ]; then ok "caddy already in cache ($("$CADDY_BIN" version | cut -d' ' -f1))"; return; fi
  say "→ Caddy v$CADDY_VERSION (darwin/arm64 release tarball)"
  mkdir -p "$CACHE/caddy"
  local url="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_mac_arm64.tar.gz"
  curl -fsSL "$url" -o "$CACHE/caddy/caddy.tar.gz"
  tar -xzf "$CACHE/caddy/caddy.tar.gz" -C "$CACHE/caddy" caddy
  xattr -d com.apple.quarantine "$CADDY_BIN" 2>/dev/null || true
  ok "caddy $("$CADDY_BIN" version | cut -d' ' -f1) ($(du -sh "$CADDY_BIN" | cut -f1))"
}
fetch_powersync() {
  if [ -f "$PS_SRC/service/lib/entry.js" ]; then ok "powersync-service already built in cache"; return; fi
  say "→ PowerSync service $POWERSYNC_TAG (path a: clone + pnpm install + build)"
  mkdir -p "$CACHE"
  if [ ! -d "$PS_SRC/.git" ]; then
    git clone --depth 1 --branch "$POWERSYNC_TAG" "$POWERSYNC_REPO" "$PS_SRC"
  fi
  local t0 t1
  t0="$(date +%s)"
  ( cd "$PS_SRC" && npx --yes "$PNPM_SPEC" install --frozen-lockfile )
  ( cd "$PS_SRC" && npx --yes "$PNPM_SPEC" build:production )
  t1="$(date +%s)"
  [ -f "$PS_SRC/service/lib/entry.js" ] || die "powersync build produced no service/lib/entry.js"
  ok "powersync-service built in $((t1 - t0))s (node_modules: $(du -sh "$PS_SRC/node_modules" | cut -f1))"
}
build_api() {
  say "→ api: npm ci + build ($API_DIR)"
  ( cd "$API_DIR" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null )
  [ -f "$API_DIR/dist/server.js" ] || die "api build produced no dist/server.js"
  ok "api built (dist: $(du -sh "$API_DIR/dist" | cut -f1))"
}
build_web() {
  say "→ web: npm ci + build ($WEB_DIR)"
  ( cd "$WEB_DIR" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null )
  [ -f "$WEB_DIR/dist/index.html" ] || die "web build produced no dist/index.html"
  ok "web built (dist: $(du -sh "$WEB_DIR/dist" | cut -f1))"
}
cmd_fetch() {
  [ -x "$NODE_BIN/node" ] || die "Node 24 not found at $NODE_BIN (brew install node@24)"
  say "node $(node --version) from $NODE_BIN"
  fetch_postgres
  fetch_caddy
  fetch_powersync
  if [ -f "$API_DIR/dist/server.js" ] && [ "${SPIKE_REBUILD:-0}" != 1 ]; then ok "api already built"; else build_api; fi
  if [ -f "$WEB_DIR/dist/index.html" ] && [ "${SPIKE_REBUILD:-0}" != 1 ]; then ok "web already built"; else build_web; fi
  ok "fetch done"
}

# ── up ──────────────────────────────────────────────────────────────────────
pg_ctl() { "$PG_HOME/bin/pg_ctl" -D "$PGDATA" "$@"; }
init_postgres() {
  [ ! -f "$PGDATA/PG_VERSION" ] || return 0
  say "→ initdb ($PGDATA)"
  local pwfile="$DATA/.pwfile.$$"
  ( umask 077; printf '%s\n' "$POSTGRES_PASSWORD" > "$pwfile" )
  # Superuser = POSTGRES_USER, like the postgres:16 image; scram from the first byte.
  "$PG_HOME/bin/initdb" -D "$PGDATA" -U "$POSTGRES_USER" --pwfile="$pwfile" \
    --auth=scram-sha-256 --encoding=UTF8 --locale=C >> "$LOGS/postgres.log" 2>&1 \
    || { rm -f "$pwfile"; die "initdb failed — see $LOGS/postgres.log"; }
  rm -f "$pwfile"
  # Everything compose passes on the `postgres` command line, plus loopback-only.
  cat >> "$PGDATA/postgresql.conf" <<EOF

# ── waffled spike ──────────────────────────────────────────────────────────
listen_addresses = '127.0.0.1'
port = $PG_PORT
unix_socket_directories = '$PGDATA'
wal_level = logical
max_replication_slots = 10
max_wal_senders = 10
password_encryption = scram-sha-256
log_line_prefix = '%m [%p] '
EOF
  cat > "$PGDATA/pg_hba.conf" <<EOF
# TYPE  DATABASE     USER  ADDRESS        METHOD
local   all          all                  scram-sha-256
host    all          all   127.0.0.1/32   scram-sha-256
host    all          all   ::1/128        scram-sha-256
host    replication  all   127.0.0.1/32   scram-sha-256
EOF
  ok "initdb done"
}
start_postgres() {
  mkdir -p "$LOGS" "$PIDS"
  if [ -f "$PGDATA/postmaster.pid" ] && kill -0 "$(pg_pid)" 2>/dev/null; then ok "postgres already running (pid $(pg_pid))"; return; fi
  rm -f "$PGDATA/postmaster.pid"
  # -w waits until the server accepts connections (pg_ctl uses libpq PQping; no pg_isready needed).
  pg_ctl -w -t 60 -l "$LOGS/postgres.log" start >/dev/null || die "postgres failed to start — see $LOGS/postgres.log"
  ok "postgres up on 127.0.0.1:$PG_PORT (pid $(pg_pid))"
}
init_databases() {
  local admin="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$PG_PORT/postgres"
  # postgres:16 creates POSTGRES_DB, then runs /docker-entrypoint-initdb.d/*.sql against it.
  sql_stmt "$admin" "select 'create database \"$POSTGRES_DB\"' where not exists (select 1 from pg_database where datname = '$POSTGRES_DB')\\gexec"
  sql "$DATABASE_URL" "$ROOT/infra/compose/postgres/init/00-init.sql"
  ok "databases: $POSTGRES_DB (pgcrypto) + powersync_storage"
}
migrate() {
  say "→ migrate (node-pg-migrate up)"
  ( cd "$API_DIR" && DATABASE_URL="$DATABASE_URL" npm run --silent migrate >> "$LOGS/migrate.log" 2>&1 ) \
    || die "migrations failed — see $LOGS/migrate.log"
  ok "migrations applied"
}
start_api() {
  if alive api; then ok "api already running (pid $(pid_of api))"; return; fi
  mkdir -p "$MEDIA_DIR"
  # Mirrors the `api` service environment in infra/compose/docker-compose.yml.
  # No backup sidecar in the spike, so BACKUP_ENABLED=false keeps /api/health from nagging.
  spawn api env \
    NODE_ENV=production \
    PORT="$API_PORT" \
    LOCAL_JWT_SECRET="$(env_val LOCAL_JWT_SECRET)" \
    TOKEN_ENCRYPTION_KEY="$(env_val TOKEN_ENCRYPTION_KEY)" \
    POWERSYNC_JWT_PRIVATE_KEY="$(env_val POWERSYNC_JWT_PRIVATE_KEY)" \
    DATABASE_URL="$DATABASE_URL" \
    STORAGE_DRIVER=local \
    MEDIA_DIR="$MEDIA_DIR" \
    MEDIA_BASE_URL=/media \
    POWERSYNC_PUBLIC_URL="${POWERSYNC_PUBLIC_URL:-}" \
    POWERSYNC_PORT="$PS_PUBLIC_PORT" \
    LOG_FORMAT=json LOG_LEVEL=info \
    BACKUP_ENABLED=false \
    UPDATE_CHECK_ENABLED=false \
    node "$API_DIR/dist/server.js"
  wait_http api "http://127.0.0.1:$API_PORT/healthz" 30
  ok "api up on :$API_PORT (pid $(pid_of api))"
}
start_powersync() {
  if alive powersync; then ok "powersync already running (pid $(pid_of powersync))"; return; fi
  # The repo config, verbatim; only the PS_* env values differ from compose.
  mkdir -p "$DATA/powersync"
  cp "$ROOT/infra/compose/powersync/service.yaml" "$ROOT/infra/compose/powersync/sync-config.yaml" "$DATA/powersync/"
  spawn powersync env \
    POWERSYNC_CONFIG_PATH="$DATA/powersync/service.yaml" \
    NODE_OPTIONS=--max-old-space-size=1000 \
    PS_PORT="$PS_PORT" \
    PS_DATA_SOURCE_URI="$DATABASE_URL" \
    PS_STORAGE_SOURCE_URI="$STORAGE_URL" \
    PS_JWKS_URL="http://127.0.0.1:$API_PORT/api/auth/keys" \
    node "$PS_SRC/service/lib/entry.js" start -r unified
  wait_http powersync "http://127.0.0.1:$PS_PORT/probes/liveness" 60
  ok "powersync up on :$PS_PORT (pid $(pid_of powersync))"
}
generate_caddyfile() {
  # infra/compose/caddy/Caddyfile verbatim, with the compose-network upstreams and
  # image paths rewritten for loopback + local dirs. The listener addresses stay env-driven.
  sed \
    -e "s|api:3000|127.0.0.1:$API_PORT|g" \
    -e "s|powersync:8080|127.0.0.1:$PS_PORT|g" \
    -e "s|root \* /srv|root * \"$WEB_DIR/dist\"|" \
    -e "s|root \* /data/media|root * \"$MEDIA_DIR\"|" \
    "$ROOT/infra/compose/caddy/Caddyfile" > "$DATA/Caddyfile"
}
start_caddy() {
  if alive caddy; then ok "caddy already running (pid $(pid_of caddy))"; return; fi
  generate_caddyfile
  mkdir -p "$DATA/caddy"
  # Keep Caddy's own state (autosave.json, certs) inside the spike data dir.
  spawn caddy env \
    CADDY_SITE_ADDRESS=":$HTTP_PORT" \
    POWERSYNC_CADDY_ADDRESS=":$PS_PUBLIC_PORT" \
    XDG_DATA_HOME="$DATA/caddy" XDG_CONFIG_HOME="$DATA/caddy" \
    "$CADDY_BIN" run --config "$DATA/Caddyfile" --adapter caddyfile
  wait_http caddy "http://127.0.0.1:$HTTP_PORT/healthz" 30
  ok "caddy up on :$HTTP_PORT (web + /api) and :$PS_PUBLIC_PORT (powersync) (pid $(pid_of caddy))"
}
preflight_ports() {
  # A port owned by one of our own live services is fine (re-running `up` is idempotent).
  local p
  for p in "$HTTP_PORT" "$PS_PUBLIC_PORT" "$API_PORT" "$PS_PORT" "$PG_PORT"; do
    if port_busy "$p"; then
      case "$p" in
        "$HTTP_PORT"|"$PS_PUBLIC_PORT") alive caddy && continue ;;
        "$API_PORT") alive api && continue ;;
        "$PS_PORT") alive powersync && continue ;;
        "$PG_PORT") [ -n "$(pg_pid)" ] && kill -0 "$(pg_pid)" 2>/dev/null && continue ;;
      esac
      warn "port $p is already in use by:"; lsof -nP -iTCP:"$p" -sTCP:LISTEN | tail -n +2 | sed 's/^/    /'
      die "free it or override SPIKE_HTTP_PORT / SPIKE_POWERSYNC_PORT / SPIKE_API_PORT / SPIKE_PS_INTERNAL_PORT / SPIKE_PG_PORT"
    fi
  done
}
cmd_up() {
  local t0 t1
  t0="$(now_ms)"
  [ -x "$PG_HOME/bin/postgres" ] && [ -x "$CADDY_BIN" ] && [ -f "$PS_SRC/service/lib/entry.js" ] \
    && [ -f "$API_DIR/dist/server.js" ] && [ -f "$WEB_DIR/dist/index.html" ] \
    || die "cache incomplete — run: $0 fetch"
  mkdir -p "$DATA" "$LOGS" "$PIDS" "$MEDIA_DIR"
  ensure_env
  preflight_ports
  init_postgres
  start_postgres
  init_databases
  migrate
  start_api
  start_powersync
  start_caddy
  api_health_reachable || warn "/api/health is not reachable through Caddy (curl -s localhost:$HTTP_PORT/api/health)"
  t1="$(now_ms)"
  ok "green in $(( (t1 - t0) / 1000 )).$(( ((t1 - t0) % 1000) / 100 ))s → http://localhost:$HTTP_PORT"
}

# ── status / logs / down / reset ────────────────────────────────────────────
status_line() { # status_line <name> <pid> <url>
  local name="$1" pid="$2" url="$3" state="stopped" health="-" rss="-"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    state="running"
    rss="$(( $(rss_tree_kb "$pid") / 1024 ))MB"
    if [ -n "$url" ]; then if http_ok "$url"; then health="ok"; else health="FAIL"; fi; fi
  fi
  printf '  %-10s %-8s pid=%-6s rss=%-8s %-4s %s\n' "$name" "$state" "${pid:--}" "$rss" "$health" "$url"
}
cmd_status() {
  say "WaffledSpike  data=$DATA"
  status_line postgres "$(pg_pid)" ""
  status_line api "$(pid_of api)" "http://127.0.0.1:$API_PORT/healthz"
  status_line powersync "$(pid_of powersync)" "http://127.0.0.1:$PS_PORT/probes/liveness"
  status_line caddy "$(pid_of caddy)" "http://127.0.0.1:$HTTP_PORT/healthz"
  if api_health_reachable; then ok "http://localhost:$HTTP_PORT/api/health reachable (HTTP $(http_code "http://127.0.0.1:$HTTP_PORT/api/health"); 401 = admin token required)"; else warn "http://localhost:$HTTP_PORT/api/health not reachable"; fi
}
cmd_logs() {
  if [ $# -eq 0 ]; then ls -la "$LOGS" 2>/dev/null || say "no logs yet"; return; fi
  [ -f "$LOGS/$1.log" ] || die "no log for $1 (have: $(ls "$LOGS" | sed 's/\.log$//' | tr '\n' ' '))"
  tail -n "${2:-200}" "$LOGS/$1.log"
}
cmd_down() {
  stop_pid caddy 10
  stop_pid powersync 20
  stop_pid api 15
  if [ -f "$PGDATA/postmaster.pid" ] && kill -0 "$(pg_pid)" 2>/dev/null; then
    pg_ctl -w -t 60 -m fast stop >/dev/null || warn "pg_ctl stop failed — see $LOGS/postgres.log"
  fi
  ok "down"
}
cmd_reset() {
  case "$DATA" in *WaffledSpike*) ;; *) die "refusing to reset $DATA (not a WaffledSpike dir)" ;; esac
  cmd_down
  printf 'Delete %s ? [y/N] ' "$DATA"
  read -r answer
  case "$answer" in y|Y) rm -rf "$DATA"; ok "removed $DATA" ;; *) say "kept" ;; esac
}

case "${1:-}" in
  fetch)  cmd_fetch ;;
  up)     cmd_up ;;
  status) cmd_status ;;
  logs)   shift; cmd_logs "$@" ;;
  down)   cmd_down ;;
  reset)  cmd_reset ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
