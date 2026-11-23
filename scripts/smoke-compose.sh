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

compose up -d --build

echo "smoke: waiting for ${BASE}/healthz"
deadline=$(( $(date +%s) + 120 ))
until curl -fsS "${BASE}/healthz" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || fail "/healthz not ready within 120s"
  sleep 2
done

curl -fsS "${BASE}/" | grep -q '<div id="root"' || fail 'GET / did not serve the SPA (no <div id="root")'

services="$(compose ps --services --status running | sort | tr '\n' ' ')"
[ "$services" = "postgres waffled " ] || fail "expected running services 'postgres waffled', got '${services}'"

echo "smoke: PASS"
