#!/bin/sh
# End-to-end check of the root compose.yaml: build, boot, probe, tear down.
# Usage: HTTP_PORT=18080 scripts/smoke-compose.sh
set -eu

cd "$(dirname "$0")/.."

PROJECT=waffled-smoke
export HTTP_PORT="${HTTP_PORT:-18080}"
BASE="http://localhost:${HTTP_PORT}"

compose() { docker compose -p "$PROJECT" "$@"; }

cleanup() { compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() {
  echo "smoke: FAIL: $*" >&2
  compose ps >&2 || true
  compose logs --tail=80 >&2 || true
  exit 1
}

wait_healthy() {
  echo "smoke: waiting for ${BASE}/healthz"
  deadline=$(( $(date +%s) + 120 ))
  until curl -fsS "${BASE}/healthz" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "/healthz not ready within 120s"
    sleep 2
  done
}

secrets() { compose exec -T waffled cat /data/secrets.json; }

compose up -d --build
wait_healthy

curl -fsS "${BASE}/" | grep -q '<div id="root"' || fail 'GET / did not serve the SPA (no <div id="root")'

services="$(compose ps --services --status running | sort | tr '\n' ' ')"
[ "$services" = "postgres waffled " ] || fail "expected running services 'postgres waffled', got '${services}'"

# Operator CLIs run without the server's env, so they must find the generated secrets too.
compose exec -T -u node waffled node dist/admin.js list-members >/dev/null \
  || fail "admin.js list-members failed in the container"

before="$(secrets)" || fail "cannot read /data/secrets.json"
[ -n "$before" ] || fail "/data/secrets.json is empty"
compose restart waffled >/dev/null
wait_healthy
[ "$(secrets)" = "$before" ] || fail "/data/secrets.json changed across a restart"

traversal="$(curl -s "${BASE}/media/..%2fsecrets.json" || true)"
case "$traversal" in
  *LOCAL_JWT_SECRET*|*TOKEN_ENCRYPTION_KEY*) fail "/media/..%2fsecrets.json leaked secrets" ;;
esac

echo "smoke: PASS"
