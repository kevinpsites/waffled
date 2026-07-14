#!/usr/bin/env bash
# Verify the OCI bootstrap produces a VALID, COMPLETE compose stack — without
# provisioning anything in the cloud and without pulling images. It reproduces what
# the bootstrap assembles on the server (the deployed ref's compose files + the
# `docker-compose.override.yml` override the bootstrap writes + a complete .env) and runs
# `docker compose config`, which:
#   • merges base + override and fails if the override is malformed, and
#   • fails if any REQUIRED (`:?`) variable is missing — the exact check that would
#     have caught the POWERSYNC_JWT_PRIVATE_KEY regression.
#
# It then asserts the HTTPS shape is present and that an app_env value is injected,
# and runs a negative test proving a missing required secret is rejected.
#
# Requirements: docker (daemon running) + git. No network/image pulls, no Terraform.
# For a real end-to-end bring-up, see full-stack.sh (needs image-pull network).
#
# Usage:  ./config-check.sh [REF]      REF defaults to origin/main (what the module deploys)
set -euo pipefail

REF="${1:-origin/main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPL="$HERE/../cloud-init.sh.tftpl"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; exit 1; }

echo "== OCI bootstrap config check (ref: $REF, default PowerSync mode) =="

# 1) Materialize the deployed ref's compose tree into a scratch dir.
git -C "$REPO_ROOT" archive "$REF" infra/compose | tar -x -C "$WORK"
CDIR="$WORK/infra/compose"
[ -f "$CDIR/docker-compose.yml" ] || fail "couldn't extract infra/compose from $REF"

# 2) Recreate the override + Caddyfile the bootstrap writes, by extracting the real
#    heredoc bodies from the template and applying default-mode substitutions
#    (powersync.<domain> subdomain) — so this stays faithful to cloud-init.sh.tftpl.
PORTS_YAML='      - "80:80"\n      - "443:443"'
awk "/cat > docker-compose.override.yml <<'COMPOSE_EOF'/{f=1;next} /^COMPOSE_EOF/{f=0} f" "$TPL" \
  | sed "s|\${caddy_ports_yaml}|$PORTS_YAML|" > "$CDIR/docker-compose.override.yml"
awk "/cat > caddy\/Caddyfile.oci <<'CADDY_EOF'/{f=1;next} /^CADDY_EOF/{f=0} f" "$TPL" \
  | sed "s|\${powersync_site}|powersync.demo.waffled.app|" > "$CDIR/caddy/Caddyfile.oci"
grep -q 'ports: !override' "$CDIR/docker-compose.override.yml" || fail "override extraction failed — template shape changed?"

# 3) Build a COMPLETE .env: .env.example defaults + every required (:?) secret + the
#    cloud/networking vars + a sample app_env key. Required secrets are discovered
#    from the compose file, so a newly-added required var is covered automatically.
cd "$CDIR"
cp .env.example .env
set_env() { local k="$1"; shift; grep -v -E "^$k=" .env > .env.t 2>/dev/null || true; mv .env.t .env; printf '%s=%s\n' "$k" "$*" >> .env; }
mapfile -t REQ < <(grep -oE '\$\{[A-Z_]+:\?[^}]*\}' docker-compose.yml | sed -E 's/\$\{([A-Z_]+):\?.*/\1/' | sort -u)
[ "${#REQ[@]}" -gt 0 ] || fail "no required (:?) vars found — grep/logic broke"
for v in "${REQ[@]}"; do
  case "$v" in
    POSTGRES_PASSWORD) set_env "$v" "$(openssl rand -hex 24 | tr -d '\n')" ;;   # URL-safe
    *)                 set_env "$v" "$(openssl rand -base64 32 | tr -d '\n')" ;;
  esac
done
set_env CADDY_SITE_ADDRESS "demo.waffled.app"
set_env PUBLIC_BASE_URL "https://demo.waffled.app"
set_env POWERSYNC_PUBLIC_URL "https://powersync.demo.waffled.app"
set_env ANTHROPIC_API_KEY "sk-ant-config-check"   # stands in for an app_env value

DC=(docker compose -f docker-compose.yml -f docker-compose.override.yml --env-file .env)

# 4) Positive: the full config must be valid.
"${DC[@]}" config -q 2>"$WORK/err" || { cat "$WORK/err"; fail "compose config rejected a complete stack"; }
pass "compose config is valid (base + override merge, all required vars satisfied)"

# 5) Assert the HTTPS override landed, PowerSync's plaintext port is closed, app_env injected.
CFG="$("${DC[@]}" config 2>/dev/null)"
grep -q 'published: "443"' <<<"$CFG" || fail "port 443 not published (HTTPS override missing)"
grep -q 'published: "8090"' <<<"$CFG" && fail "PowerSync 8090 still published (should be fronted by Caddy, not exposed)"
grep -q 'ANTHROPIC_API_KEY: sk-ant-config-check' <<<"$CFG" || fail "app_env value not injected"
pass "HTTPS override applied (443 published, PowerSync's 8090 closed), app_env injected"

# 6) Negative: every required secret must be enforced. Drop each and expect failure.
for v in "${REQ[@]}"; do
  grep -v -E "^$v=" .env > .env.bad
  if docker compose -f docker-compose.yml -f docker-compose.override.yml --env-file .env.bad config -q 2>/dev/null; then
    fail "compose accepted a stack missing required $v"
  fi
done
pass "all ${#REQ[@]} required secrets are enforced (missing any is rejected): ${REQ[*]}"

echo "== all checks passed =="
