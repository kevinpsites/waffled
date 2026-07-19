#!/usr/bin/env bash
# Tests for the ./waffled CLI script. Plain bash, no framework.
#
#   bash tests/waffled.test.sh              # any bash
#   /bin/bash tests/waffled.test.sh         # macOS stock bash 3.2 — the compat target
#
# Every scenario runs in a CHILD bash (the same interpreter running this file), so
# `set -euo pipefail` inside ./waffled can't kill the runner and each test starts
# clean. The functions under test are loaded with `source ./waffled help` — the help
# branch prints usage and falls through, leaving all functions defined. A test passes
# ONLY if its child prints PASS (a child killed by set -e/-u prints nothing => fail).
#
# NOTE on bash versions: the wait_for_services regression ("requested[@]: unbound
# variable") only *reproduces* on bash < 4.4 (macOS /bin/bash is 3.2), because 4.4
# made empty-array expansion legal under `set -u`. On newer bash these tests still
# guard the sourcing, arg-filtering, re-exec, and ensure_env behavior.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASH_BIN="${BASH:-bash}"
fails=0
runs=0

t() { # t <name> <child-script>; child sees $WAFFLED and must print PASS to succeed
  local name="$1" script="$2" out
  runs=$((runs + 1))
  out="$(WAFFLED="$ROOT/waffled" "$BASH_BIN" -c "$script" 2>&1)" || true
  case "$out" in
    *PASS*) echo "ok - $name" ;;
    *)      echo "not ok - $name"
            printf '%s\n' "$out" | sed 's/^/    /'
            fails=$((fails + 1)) ;;
  esac
}

# --- 1. the script must PARSE under this bash (catches >3.2-only syntax) ------------
runs=$((runs + 1))
if "$BASH_BIN" -n "$ROOT/waffled"; then
  echo "ok - script parses under bash $("$BASH_BIN" -c 'echo "$BASH_VERSION"')"
else
  echo "not ok - script does not parse under this bash"; fails=$((fails + 1))
fi

# --- 2. wait_for_services with NO args must not crash (the v0.8.0 upgrade bug) ------
# Under set -u on bash < 4.4, expanding an empty array copy of "$@" aborts the whole
# script with "unbound variable" — right after `docker compose up -d` in up/upgrade.
t "wait_for_services (no args) survives set -u" '
  source "$WAFFLED" help >/dev/null 2>&1
  DC=(false)                      # no docker: every service simply reports not-ready
  WAFFLED_HEALTH_ATTEMPTS=1
  out="$( { wait_for_services || true; } 2>&1 )"
  case "$out" in
    *"unbound variable"*) echo "FAIL: $out" ;;
    *) echo "PASS" ;;
  esac
'

# --- 3. wait_for_services filters args: services kept, compose flags ignored --------
t "wait_for_services ignores non-service args" '
  source "$WAFFLED" help >/dev/null 2>&1
  DC=(false)
  WAFFLED_HEALTH_ATTEMPTS=1
  out="$( { wait_for_services --build api || true; } 2>&1 )"
  case "$out" in
    *"unbound variable"*) echo "FAIL: $out" ;;
    *) echo "PASS" ;;
  esac
'

# --- 4. upgrade re-execs the freshly pulled script -----------------------------------
# The repo fast-forward can replace ./waffled mid-run; the old in-memory copy must hand
# off to the new one (this is how 0.7.0 -> 0.8.0 broke: old ensure_env vs new compose).
t "maybe_reexec_upgrade hands off to the changed script (guard + args preserved)" '
  source "$WAFFLED" help >/dev/null 2>&1
  tmp="$(mktemp -d)"; trap "rm -rf \"$tmp\"" EXIT
  printf "%s\n" "old script body" > "$tmp/waffled"
  ROOT="$tmp"
  before="$(script_checksum)"
  printf "#!/bin/sh\necho \"REEXEC guard=\${WAFFLED_UPGRADE_REEXEC:-unset} args=\$*\"\n" > "$tmp/waffled"
  chmod +x "$tmp/waffled"
  out="$( "$BASH" -c "source \"$WAFFLED\" help >/dev/null 2>&1; ROOT=\"$tmp\"; maybe_reexec_upgrade \"$before\" --skip-backup" 2>&1 )"
  case "$out" in
    *"REEXEC guard=1 args=upgrade --skip-backup"*) echo "PASS" ;;
    *) echo "FAIL: unexpected handoff output: $out" ;;
  esac
'

t "maybe_reexec_upgrade is a no-op when the script is unchanged" '
  source "$WAFFLED" help >/dev/null 2>&1
  tmp="$(mktemp -d)"; trap "rm -rf \"$tmp\"" EXIT
  printf "%s\n" "same script body" > "$tmp/waffled"
  ROOT="$tmp"
  before="$(script_checksum)"
  maybe_reexec_upgrade "$before"
  echo "PASS"
'

t "maybe_reexec_upgrade never loops (guard already set -> no exec)" '
  source "$WAFFLED" help >/dev/null 2>&1
  tmp="$(mktemp -d)"; trap "rm -rf \"$tmp\"" EXIT
  printf "%s\n" "old script body" > "$tmp/waffled"
  ROOT="$tmp"
  before="$(script_checksum)"
  printf "#!/bin/sh\necho REEXEC\n" > "$tmp/waffled"; chmod +x "$tmp/waffled"
  WAFFLED_UPGRADE_REEXEC=1 maybe_reexec_upgrade "$before"
  echo "PASS"
'

# --- 5. ensure_env backfills a missing required secret into an EXISTING .env --------
# (Documents behavior that shipped in v0.8.0 — the upgrade fix relies on it running
# from the NEW script. Retrofit test: this behavior predates this test.)
t "ensure_env backfills LOCAL_JWT_SECRET without touching other values" '
  source "$WAFFLED" help >/dev/null 2>&1
  tmp="$(mktemp -d)"; trap "rm -rf \"$tmp\"" EXIT
  ENV_FILE="$tmp/.env"
  {
    echo "POSTGRES_PASSWORD=keep-this-password"
    echo "TOKEN_ENCRYPTION_KEY=keep-this-key"
    echo "POWERSYNC_JWT_PRIVATE_KEY=keep-this-pem"
  } > "$ENV_FILE"
  ensure_env >/dev/null
  grep -qE "^LOCAL_JWT_SECRET=.." "$ENV_FILE" || { echo "FAIL: LOCAL_JWT_SECRET not backfilled"; exit 0; }
  grep -qxF "POSTGRES_PASSWORD=keep-this-password" "$ENV_FILE" || { echo "FAIL: POSTGRES_PASSWORD changed"; exit 0; }
  grep -qxF "POWERSYNC_JWT_PRIVATE_KEY=keep-this-pem" "$ENV_FILE" || { echo "FAIL: POWERSYNC_JWT_PRIVATE_KEY changed"; exit 0; }
  echo "PASS"
'

# --- 6. release checks require a clean, synchronized main branch --------------------
t "release_repository_ready accepts a clean main synchronized with origin" '
  source "$WAFFLED" help >/dev/null 2>&1
  tmp="$(mktemp -d)"; trap "rm -rf \"$tmp\"" EXIT
  git init --bare -q "$tmp/origin.git"
  git clone -q "$tmp/origin.git" "$tmp/work"
  git -C "$tmp/work" config user.email test@example.com
  git -C "$tmp/work" config user.name "Waffled Test"
  git -C "$tmp/work" switch -q -c main
  mkdir -p "$tmp/work/apps/api" "$tmp/work/apps/web" "$tmp/work/apps/ios" "$tmp/work/infra/compose"
  printf "%s\n" "## [Unreleased]" "" "### Added" "- Ready to ship" "" "## [0.8.0]" > "$tmp/work/CHANGELOG.md"
  printf "%s\n" "{\"version\":\"0.8.0\"}" > "$tmp/work/apps/api/package.json"
  printf "%s\n" "{\"version\":\"0.8.0\"}" > "$tmp/work/apps/web/package.json"
  printf "%s\n" "WAFFLED_VERSION=0.8.0" > "$tmp/work/infra/compose/.env.example"
  printf "%s\n" "  MARKETING_VERSION: \"0.8.0\"" > "$tmp/work/apps/ios/project.yml"
  git -C "$tmp/work" add .
  git -C "$tmp/work" commit -qm "test fixture"
  git -C "$tmp/work" push -qu origin main
  ROOT="$tmp/work"
  out="$(release_repository_ready "0.9.0" 2>&1)" || {
    echo "FAIL: synchronized main was rejected: $out"; exit 0;
  }
  case "$out" in
    *"Release repository checks passed"*) echo "PASS" ;;
    *) echo "FAIL: missing success message: $out" ;;
  esac
'

t "release_repository_ready rejects main when origin has advanced" '
  source "$WAFFLED" help >/dev/null 2>&1
  tmp="$(mktemp -d)"; trap "rm -rf \"$tmp\"" EXIT
  git init --bare -q "$tmp/origin.git"
  git clone -q "$tmp/origin.git" "$tmp/work"
  git -C "$tmp/work" config user.email test@example.com
  git -C "$tmp/work" config user.name "Waffled Test"
  git -C "$tmp/work" switch -q -c main
  mkdir -p "$tmp/work/apps/api" "$tmp/work/apps/web" "$tmp/work/apps/ios" "$tmp/work/infra/compose"
  printf "%s\n" "## [Unreleased]" "" "### Added" "- Ready to ship" "" "## [0.8.0]" > "$tmp/work/CHANGELOG.md"
  printf "%s\n" "{\"version\":\"0.8.0\"}" > "$tmp/work/apps/api/package.json"
  printf "%s\n" "{\"version\":\"0.8.0\"}" > "$tmp/work/apps/web/package.json"
  printf "%s\n" "WAFFLED_VERSION=0.8.0" > "$tmp/work/infra/compose/.env.example"
  printf "%s\n" "  MARKETING_VERSION: \"0.8.0\"" > "$tmp/work/apps/ios/project.yml"
  git -C "$tmp/work" add .
  git -C "$tmp/work" commit -qm "test fixture"
  git -C "$tmp/work" push -qu origin main
  git clone -q --branch main "$tmp/origin.git" "$tmp/other"
  git -C "$tmp/other" config user.email test@example.com
  git -C "$tmp/other" config user.name "Waffled Test"
  printf "%s\n" "new remote work" > "$tmp/other/remote-change"
  git -C "$tmp/other" add remote-change
  git -C "$tmp/other" commit -qm "advance remote"
  git -C "$tmp/other" push -q origin main
  ROOT="$tmp/work"
  set +e
  out="$(release_repository_ready "0.9.0" 2>&1)"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "FAIL: stale main was accepted"; exit 0; }
  case "$out" in
    *"behind origin/main"*) echo "PASS" ;;
    *) echo "FAIL: stale-main guidance missing: $out" ;;
  esac
'

t "run_release_api_step strips ambient AI provider configuration" '
  source "$WAFFLED" help >/dev/null 2>&1
  tmp="$(mktemp -d)"; trap "rm -rf \"$tmp\"" EXIT
  ROOT="$tmp"
  mkdir -p "$ROOT/apps/api"
  printf "%s\n" \
    "#!/bin/sh" \
    "[ -z \"\${ANTHROPIC_API_KEY:-}\" ] || exit 1" \
    "[ -z \"\${ANTHROPIC_MODEL:-}\" ] || exit 1" \
    "[ -z \"\${OPENAI_API_KEY:-}\" ] || exit 1" \
    "[ -z \"\${OPENAI_BASE_URL:-}\" ] || exit 1" \
    "[ -z \"\${OPENAI_MODEL:-}\" ] || exit 1" \
    "[ -z \"\${OLLAMA_HOST:-}\" ] || exit 1" \
    "[ -z \"\${OLLAMA_MODEL:-}\" ] || exit 1" \
    "echo CLEAN" > "$tmp/check-env"
  chmod +x "$tmp/check-env"
  export ANTHROPIC_API_KEY=secret ANTHROPIC_MODEL=model
  export OPENAI_API_KEY=secret OPENAI_BASE_URL=http://localhost OPENAI_MODEL=model
  export OLLAMA_HOST=http://localhost OLLAMA_MODEL=model
  out="$(run_release_api_step "credential check" "$tmp/check-env" 2>&1)" || {
    echo "FAIL: provider configuration leaked into release tests: $out"; exit 0;
  }
  case "$out" in
    *CLEAN*) echo "PASS" ;;
    *) echo "FAIL: sanitized command did not run: $out" ;;
  esac
'

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails/$runs waffled test(s) FAILED"
  exit 1
fi
echo "all $runs waffled tests passed"
