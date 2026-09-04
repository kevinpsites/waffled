#!/usr/bin/env bash
# Assembles the self-contained `runtime/` directory that Waffled for Mac ships: the four
# service binaries (Postgres 16, Node 24, Caddy 2, the built PowerSync service), the api
# and web builds, and the compose config files — plus a manifest with a sha256 for every
# file. Nothing in the output depends on Homebrew, a system Node, or Docker at run time.
# See README.md next to this file for the layout, sizes, sources and gotchas.
#
#   ./build.sh fetch            populate the cache (downloads + the PowerSync build)
#   ./build.sh build [outdir]   assemble runtime/ into outdir (default: ./out/runtime)
#   ./build.sh verify <outdir>  manifest check + smoke test (the test for this script)
#   ./build.sh clean [--all]    remove ./out (and with --all the cache too)
#
# Env: WAFFLED_BUNDLE_CACHE (default ~/Library/Caches/WaffledBundle), WAFFLED_BUNDLE_SEED
# (default ~/Library/Caches/WaffledSpike — the Phase 1 spike's downloads are reused when
# present so a rebuild costs no network), WAFFLED_BUNDLE_NO_NETWORK=1 (fail instead of
# downloading anything), WAFFLED_BUNDLE_NPM_CI=1 (force `npm ci` for api + web).
#
# bash 3.2-clean (macOS /bin/bash): no associative arrays, no ${x,,}, no mapfile.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

# ── Pins (bump these; the manifest records them) ──────────────────────────────
# Official nodejs.org build — Homebrew's node is a non-relocatable stub (spike README).
# Major must match the repo's .nvmrc.
NODE_VERSION="${WAFFLED_NODE_VERSION:-24.19.0}"
# Postgres 16 server: EDB's universal build as repacked by embedded-postgres on npm.
PG_NPM_PKG="@embedded-postgres/darwin-arm64"
PG_NPM_VERSION="${WAFFLED_PG_NPM_VERSION:-16.14.0-beta.17}"
PG_VERSION="16.14"
# Postgres 16 client tools (pg_dump, pg_restore, pg_isready, psql): the npm repack ships
# only initdb/pg_ctl/postgres, and EDB's full zip is ~300 MB. theseus-rs publishes a
# complete arm64 build of the SAME minor as a 12 MB tarball; we take four binaries from it.
PG_CLIENT_VERSION="${WAFFLED_PG_CLIENT_VERSION:-16.14.0}"
PG_CLIENT_TOOLS="pg_dump pg_restore pg_isready psql"
# Caddy 2 official release tarball.
CADDY_VERSION="${WAFFLED_CADDY_VERSION:-2.11.4}"
# PowerSync service — the tag the compose image journeyapps/powersync-service:1.22.0 is built from.
POWERSYNC_VERSION="${WAFFLED_POWERSYNC_VERSION:-1.22.0}"
POWERSYNC_REPO="https://github.com/powersync-ja/powersync-service"
# The repo pins packageManager pnpm@11.0.9; pnpm@9 refuses its lockfile (spike gotcha 3).
PNPM_SPEC="pnpm@11.0.9"

ARCH="arm64"
PLATFORM="darwin"

CACHE="${WAFFLED_BUNDLE_CACHE:-$HOME/Library/Caches/WaffledBundle}"
SEED="${WAFFLED_BUNDLE_SEED:-$HOME/Library/Caches/WaffledSpike}"
DEFAULT_OUT="$HERE/out/runtime"

NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_SUMS_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
PG_CLIENT_URL="https://github.com/theseus-rs/postgresql-binaries/releases/download/${PG_CLIENT_VERSION}/postgresql-${PG_CLIENT_VERSION}-aarch64-apple-darwin.tar.gz"
CADDY_URL="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_mac_arm64.tar.gz"
CADDY_SUMS_URL="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_checksums.txt"

# Cache layout
NODE_TGZ="$CACHE/node/node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_HOME="$CACHE/node/node-v${NODE_VERSION}-darwin-arm64"
BUILD_NODE="$NODE_HOME/bin/node"            # the bundled node also drives the build
PG_TGZ="$CACHE/postgres/embedded-postgres-darwin-arm64-${PG_NPM_VERSION}.tgz"
PG_HOME="$CACHE/postgres/edb-${PG_NPM_VERSION}"       # unpacked npm package (native/{bin,lib,share})
PG_CLIENT_TGZ="$CACHE/postgres/postgresql-${PG_CLIENT_VERSION}-aarch64-apple-darwin.tar.gz"
PG_CLIENT_HOME="$CACHE/postgres/theseus-${PG_CLIENT_VERSION}"
CADDY_TGZ="$CACHE/caddy/caddy_${CADDY_VERSION}_mac_arm64.tar.gz"
CADDY_HOME="$CACHE/caddy/caddy-${CADDY_VERSION}"
PS_SRC="$CACHE/powersync-service"
PS_PRUNED_STAMP="$PS_SRC/.waffled-prod-pruned"

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓ %s%s\n' "$c_grn" "$*" "$c_reset"; }
warn() { printf '%s⚠ %s%s\n' "$c_ylw" "$*" "$c_reset"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; exit 1; }
hsize() { du -sh "$1" 2>/dev/null | cut -f1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH (needed at build time)"; }

# ── network helpers ──────────────────────────────────────────────────────────
download() { # download <url> <dest>
  [ -f "$2" ] && return 0
  [ "${WAFFLED_BUNDLE_NO_NETWORK:-0}" = 1 ] && die "would download $1 but WAFFLED_BUNDLE_NO_NETWORK=1"
  say "  ↓ $1"
  mkdir -p "$(dirname "$2")"
  curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
  say "    $(hsize "$2")"
}
# seed <cache-dest> <seed-file> — reuse a file the spike already downloaded (no network).
seed() {
  [ -f "$1" ] && return 0
  [ -f "$2" ] || return 0
  mkdir -p "$(dirname "$1")"; cp "$2" "$1"
  say "  ↺ reused $2"
}
sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
sha512_of() { shasum -a 512 "$1" | cut -d' ' -f1; }
# expect_sum <file> <expected> <actual>
expect_sum() { [ "$2" = "$3" ] || die "checksum mismatch for $1
  expected $2
  actual   $3"; }

# ── fetch ────────────────────────────────────────────────────────────────────
fetch_node() {
  if [ -x "$BUILD_NODE" ]; then ok "node v$NODE_VERSION (cached)"; return; fi
  say "→ Node v$NODE_VERSION (official darwin-arm64 tarball)"
  download "$NODE_URL" "$NODE_TGZ"
  download "$NODE_SUMS_URL" "$CACHE/node/SHASUMS256-v${NODE_VERSION}.txt"
  local want
  want="$(awk -v f="node-v${NODE_VERSION}-darwin-arm64.tar.gz" '$2 == f { print $1 }' "$CACHE/node/SHASUMS256-v${NODE_VERSION}.txt")"
  [ -n "$want" ] || die "node-v${NODE_VERSION}-darwin-arm64.tar.gz not listed in SHASUMS256.txt"
  expect_sum "$NODE_TGZ" "$want" "$(sha256_of "$NODE_TGZ")"
  rm -rf "$NODE_HOME"; mkdir -p "$NODE_HOME"
  tar -xzf "$NODE_TGZ" -C "$NODE_HOME" --strip-components=1
  [ "$("$BUILD_NODE" --version)" = "v$NODE_VERSION" ] || die "extracted node reports $("$BUILD_NODE" --version)"
  ok "node v$NODE_VERSION ($(hsize "$BUILD_NODE"))"
}

fetch_postgres_server() {
  if [ -x "$PG_HOME/native/bin/postgres" ]; then ok "postgres $PG_VERSION server (cached)"; return; fi
  say "→ Postgres $PG_VERSION server: $PG_NPM_PKG@$PG_NPM_VERSION"
  seed "$PG_TGZ" "$SEED/postgres/embedded-postgres-darwin-arm64-${PG_NPM_VERSION}.tgz"
  if [ ! -f "$PG_TGZ" ]; then
    [ "${WAFFLED_BUNDLE_NO_NETWORK:-0}" = 1 ] && die "would npm pack $PG_NPM_PKG but WAFFLED_BUNDLE_NO_NETWORK=1"
    mkdir -p "$CACHE/postgres"
    say "  ↓ npm pack $PG_NPM_PKG@$PG_NPM_VERSION"
    ( cd "$CACHE/postgres" && PATH="$NODE_HOME/bin:$PATH" npm pack "$PG_NPM_PKG@$PG_NPM_VERSION" >/dev/null 2>&1 )
    [ -f "$PG_TGZ" ] || die "npm pack did not produce $PG_TGZ"
    say "    $(hsize "$PG_TGZ")"
  fi
  rm -rf "$PG_HOME"; mkdir -p "$PG_HOME"
  tar -xzf "$PG_TGZ" -C "$PG_HOME" --strip-components=1
  [ -f "$PG_HOME/native/pg-symlinks.json" ] || die "$PG_NPM_PKG has no native/pg-symlinks.json (layout changed?)"
  for b in initdb pg_ctl postgres; do [ -x "$PG_HOME/native/bin/$b" ] || die "$PG_NPM_PKG has no bin/$b"; done
  ok "postgres server unpacked ($(hsize "$PG_HOME"), universal — thinned at build)"
}

fetch_postgres_client() {
  if [ -x "$PG_CLIENT_HOME/bin/pg_dump" ]; then ok "postgres $PG_CLIENT_VERSION client tools (cached)"; return; fi
  say "→ Postgres $PG_CLIENT_VERSION client tools (theseus-rs/postgresql-binaries, arm64)"
  download "$PG_CLIENT_URL" "$PG_CLIENT_TGZ"
  download "$PG_CLIENT_URL.sha256" "$PG_CLIENT_TGZ.sha256"
  expect_sum "$PG_CLIENT_TGZ" "$(cut -d' ' -f1 "$PG_CLIENT_TGZ.sha256")" "$(sha256_of "$PG_CLIENT_TGZ")"
  rm -rf "$PG_CLIENT_HOME"; mkdir -p "$PG_CLIENT_HOME"
  tar -xzf "$PG_CLIENT_TGZ" -C "$PG_CLIENT_HOME" --strip-components=1
  for b in $PG_CLIENT_TOOLS; do [ -x "$PG_CLIENT_HOME/bin/$b" ] || die "client tarball has no bin/$b"; done
  ok "postgres client tools unpacked ($(hsize "$PG_CLIENT_HOME"))"
}

fetch_caddy() {
  if [ -x "$CADDY_HOME/caddy" ]; then ok "caddy v$CADDY_VERSION (cached)"; return; fi
  say "→ Caddy v$CADDY_VERSION (official darwin/arm64 release tarball)"
  seed "$CADDY_TGZ" "$SEED/caddy/caddy.tar.gz"
  download "$CADDY_URL" "$CADDY_TGZ"
  download "$CADDY_SUMS_URL" "$CACHE/caddy/caddy_${CADDY_VERSION}_checksums.txt"
  local want
  want="$(awk -v f="caddy_${CADDY_VERSION}_mac_arm64.tar.gz" '$2 == f { print $1 }' "$CACHE/caddy/caddy_${CADDY_VERSION}_checksums.txt")"
  [ -n "$want" ] || die "caddy_${CADDY_VERSION}_mac_arm64.tar.gz not listed in the Caddy checksums file"
  expect_sum "$CADDY_TGZ" "$want" "$(sha512_of "$CADDY_TGZ")"
  rm -rf "$CADDY_HOME"; mkdir -p "$CADDY_HOME"
  tar -xzf "$CADDY_TGZ" -C "$CADDY_HOME" caddy LICENSE
  local v; v="$("$CADDY_HOME/caddy" version | cut -d' ' -f1)"
  [ "$v" = "v$CADDY_VERSION" ] || die "extracted caddy reports $v"
  ok "caddy $v ($(hsize "$CADDY_HOME/caddy"))"
}

# CI=true: pnpm otherwise stops for a TTY confirmation when it wants to re-create node_modules.
pnpm() { ( cd "$PS_SRC" && CI=true PATH="$NODE_HOME/bin:$PATH" npx --yes "$PNPM_SPEC" "$@" ); }
rm_node_modules() { rm -rf "$PS_SRC/node_modules" "$PS_SRC"/*/node_modules "$PS_SRC"/*/*/node_modules; }
fetch_powersync() {
  if [ -f "$PS_PRUNED_STAMP" ] && [ -f "$PS_SRC/service/lib/entry.js" ]; then ok "powersync-service v$POWERSYNC_VERSION built + prod-pruned (cached)"; return; fi
  say "→ PowerSync service v$POWERSYNC_VERSION (build from source, then prod-only install)"
  need rsync
  if [ ! -f "$PS_SRC/package.json" ]; then
    if [ -f "$SEED/powersync-service/service/package.json" ]; then
      # The spike's clone (already built). node_modules is re-created below; .git is not needed.
      say "  ↺ reusing the clone at $SEED/powersync-service"
      mkdir -p "$PS_SRC"
      rsync -a --exclude node_modules --exclude .git "$SEED/powersync-service/" "$PS_SRC/"
    else
      [ "${WAFFLED_BUNDLE_NO_NETWORK:-0}" = 1 ] && die "would clone $POWERSYNC_REPO but WAFFLED_BUNDLE_NO_NETWORK=1"
      say "  ↓ git clone --depth 1 --branch v$POWERSYNC_VERSION $POWERSYNC_REPO"
      git clone --quiet --depth 1 --branch "v$POWERSYNC_VERSION" "$POWERSYNC_REPO" "$PS_SRC"
      rm -rf "$PS_SRC/.git"
    fi
  fi
  local got; got="$(sed -n -E 's/^ *"version": *"([^"]+)".*/\1/p' "$PS_SRC/service/package.json" | head -n 1)"
  [ "$got" = "$POWERSYNC_VERSION" ] || die "powersync-service/service/package.json is $got, expected $POWERSYNC_VERSION"
  rm -f "$PS_PRUNED_STAMP"
  if [ ! -f "$PS_SRC/service/lib/entry.js" ]; then
    # Same targets the image's service/Dockerfile builds. Dev deps are needed for tsc.
    local t0; t0="$(date +%s)"
    say "  · pnpm install --frozen-lockfile (dev, for the build)"
    rm_node_modules
    pnpm install --frozen-lockfile --ignore-scripts --prefer-offline >/dev/null
    say "  · pnpm build:production"
    # tsc -b trusts a stale tsconfig.tsbuildinfo and skips a package whose lib/ is gone.
    find "$PS_SRC" -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
    pnpm build:production >/dev/null
    [ -f "$PS_SRC/service/lib/entry.js" ] || die "build produced no service/lib/entry.js"
    say "  · built in $(( $(date +%s) - t0 ))s; node_modules (dev): $(hsize "$PS_SRC/node_modules")"
  fi
  # Prod-only, and only the service image's dependency closure (drops test-client and
  # every package's dev deps). --ignore-scripts as in the Dockerfile; the one native dep
  # (@napi-rs/snappy) resolves to its darwin-arm64 prebuild, nothing compiles.
  say "  · pnpm install --prod --filter '@powersync/service-image...' (prune)"
  rm_node_modules
  pnpm install --frozen-lockfile --prod --ignore-scripts --prefer-offline --filter '@powersync/service-image...' >/dev/null
  [ -d "$PS_SRC/service/node_modules/@powersync" ] || die "prod install produced no service/node_modules/@powersync"
  ( cd "$PS_SRC" && env -i PATH=/usr/bin:/bin "$BUILD_NODE" service/lib/entry.js --help >/dev/null 2>&1 ) || die "pruned powersync-service does not run (node service/lib/entry.js --help)"
  : > "$PS_PRUNED_STAMP"
  ok "powersync-service v$POWERSYNC_VERSION built + prod-pruned ($(hsize "$PS_SRC"), node_modules $(hsize "$PS_SRC/node_modules"))"
}

cmd_fetch() {
  [ "$(uname -s)" = "Darwin" ] || die "the bundle is built on macOS"
  need curl; need tar; need shasum; need lipo
  mkdir -p "$CACHE"
  say "cache: $CACHE"
  [ -d "$SEED" ] && say "seed:  $SEED (spike downloads reused when present)"
  fetch_node
  fetch_postgres_server
  fetch_postgres_client
  fetch_caddy
  fetch_powersync
  ok "fetch done — cache is $(hsize "$CACHE")"
}

# ── build ────────────────────────────────────────────────────────────────────
have_fetched() {
  [ -x "$BUILD_NODE" ] && [ -x "$PG_HOME/native/bin/postgres" ] && [ -x "$PG_CLIENT_HOME/bin/pg_dump" ] \
    && [ -x "$CADDY_HOME/caddy" ] && [ -f "$PS_PRUNED_STAMP" ]
}
is_macho() { # is_macho <file> — Mach-O (thin or fat) by magic number
  local m; m="$(head -c 4 "$1" | xxd -p 2>/dev/null)"
  case "$m" in cffaedfe|feedfacf|cafebabe|bebafeca) return 0 ;; *) return 1 ;; esac
}
# Thin every universal Mach-O under <dir> to arm64. Signatures are per-slice, so EDB's
# Developer ID signature on the arm64 slice survives (Phase 3 re-signs everything anyway).
thin_tree() {
  local dir="$1" n=0 f
  while IFS= read -r f; do
    is_macho "$f" || continue
    case "$(lipo -archs "$f" 2>/dev/null)" in
      *" "*) lipo -thin "$ARCH" "$f" -output "$f.thin" && mv "$f.thin" "$f"; n=$((n + 1)) ;;
    esac
  done < <(find "$dir" -type f)
  say "  · thinned $n universal Mach-O files to $ARCH"
}

build_postgres() {
  local out="$1/bin/postgres"
  say "→ postgres → bin/postgres/"
  mkdir -p "$out"
  cp -R "$PG_HOME/native/bin" "$PG_HOME/native/lib" "$PG_HOME/native/share" "$out/"
  # Recreate the 17 lib symlinks the npm tarball drops (postgres links
  # @loader_path/../lib/libicui18n.dylib, the file is libicui18n.68.2.dylib) — relative,
  # from the package's own pg-symlinks.json, so the tree is relocatable.
  local n
  n="$("$BUILD_NODE" -e '
    const fs = require("fs"), path = require("path");
    const [json, out] = process.argv.slice(1);
    let n = 0;
    for (const { source, target } of JSON.parse(fs.readFileSync(json, "utf8"))) {
      const rel = (p) => p.replace(/^native\//, "");
      const link = path.join(out, rel(target));
      try { fs.unlinkSync(link); } catch {}
      fs.symlinkSync(path.basename(rel(source)), link);
      n++;
    }
    process.stdout.write(String(n));
  ' "$PG_HOME/native/pg-symlinks.json" "$out")"
  say "  · recreated $n lib symlinks"
  thin_tree "$out"
  # Client tools from the theseus build: same 16.14, arm64-only, linked against
  # @loader_path/../lib/libpq.5.dylib (+ libcrypto.3.dylib) which EDB's lib/ provides.
  for b in $PG_CLIENT_TOOLS; do cp "$PG_CLIENT_HOME/bin/$b" "$out/bin/$b"; done
  say "  · added client tools: $PG_CLIENT_TOOLS"
  xattr -cr "$out" 2>/dev/null || true
  ok "postgres $PG_VERSION ($(hsize "$out"))"
}

build_node() {
  say "→ node → bin/node"
  mkdir -p "$1/bin"
  cp "$BUILD_NODE" "$1/bin/node"
  xattr -c "$1/bin/node" 2>/dev/null || true
  ok "node v$NODE_VERSION ($(hsize "$1/bin/node"))"
}

build_caddy() {
  say "→ caddy → bin/caddy"
  mkdir -p "$1/bin"
  cp "$CADDY_HOME/caddy" "$1/bin/caddy"
  xattr -c "$1/bin/caddy" 2>/dev/null || true
  ok "caddy v$CADDY_VERSION ($(hsize "$1/bin/caddy"))"
}

npm_build() { # npm_build <app dir> — npm ci (if needed) + npm run build with the bundled node
  ( cd "$1" && export PATH="$NODE_HOME/bin:$PATH"
    if [ ! -d node_modules ] || [ "${WAFFLED_BUNDLE_NPM_CI:-0}" = 1 ]; then
      say "  · npm ci"; npm ci --no-audit --no-fund >/dev/null 2>&1 || die "npm ci failed in $1"
    fi
    say "  · npm run build"; npm run build >/dev/null 2>&1 || die "npm run build failed in $1" )
}
build_api() {
  local src="$ROOT/apps/api" out="$1/api"
  say "→ api → api/ (esbuild bundle + migrations)"
  npm_build "$src"
  [ -f "$src/dist/server.js" ] || die "apps/api build produced no dist/server.js"
  mkdir -p "$out/dist"
  # dist/ minus what has no meaning natively: lambda.js (AWS handler) and otel.js (the
  # --require preload needs the @opentelemetry/* node_modules the image stages; the
  # bundle ships no node_modules, so the runtime must never set NODE_OPTIONS=--require it).
  local f
  for f in "$src"/dist/*; do
    case "$(basename "$f")" in lambda.js|lambda.js.map|otel.js|otel.js.map) continue ;; esac
    cp "$f" "$out/dist/"
  done
  # dist/migrate.js resolves the .sql files at ../migrations relative to itself.
  cp -R "$src/migrations" "$out/migrations"
  "$BUILD_NODE" -e '
    const p = require(process.argv[1]);
    process.stdout.write(JSON.stringify({ name: p.name, version: p.version, private: true, type: "commonjs",
      description: "Waffled API, esbuild-bundled: `node dist/server.js` (serve), `node dist/migrate.js` (apply migrations/). No node_modules needed." }, null, 2) + "\n");
  ' "$src/package.json" > "$out/package.json"
  ok "api $(api_version) ($(hsize "$out"))"
}
api_version() { sed -n -E 's/^ *"version": *"([^"]+)".*/\1/p' "$ROOT/apps/api/package.json" | head -n 1; }
web_version() { sed -n -E 's/^ *"version": *"([^"]+)".*/\1/p' "$ROOT/apps/web/package.json" | head -n 1; }

build_web() {
  local src="$ROOT/apps/web" out="$1/web"
  say "→ web → web/ (vite build)"
  npm_build "$src"
  [ -f "$src/dist/index.html" ] || die "apps/web build produced no dist/index.html"
  cp -R "$src/dist" "$out"
  ok "web $(web_version) ($(hsize "$out"))"
}

build_powersync() {
  local out="$1/powersync"
  say "→ powersync → powersync/ (the prod-pruned monorepo, as the official image ships it)"
  need rsync
  mkdir -p "$out"
  # Everything the image's Dockerfile keeps. Dropped: docs, test-client (not in the
  # service's dependency closure), repo housekeeping. Symlinks (pnpm's layout) are kept
  # as symlinks — they are relative and part of the manifest.
  rsync -a --exclude .git --exclude docs --exclude test-client --exclude .github \
    --exclude .changeset --exclude .husky --exclude .vscode --exclude '.waffled-*' \
    "$PS_SRC/" "$out/"
  ok "powersync-service v$POWERSYNC_VERSION ($(hsize "$out"), $(find "$out" -type l | wc -l | tr -d ' ') symlinks)"
}

build_config() {
  local out="$1/config"
  say "→ config → config/ (verbatim from infra/compose)"
  mkdir -p "$out/powersync"
  cp "$ROOT/infra/compose/caddy/Caddyfile" "$out/Caddyfile"
  cp "$ROOT/infra/compose/postgres/init/00-init.sql" "$out/00-init.sql"
  cp "$ROOT/infra/compose/powersync/service.yaml" "$out/powersync/service.yaml"
  cp "$ROOT/infra/compose/powersync/sync-config.yaml" "$out/powersync/sync-config.yaml"
  ok "config (4 files)"
}

build_licenses() {
  local out="$1/licenses"
  mkdir -p "$out"
  cp "$NODE_HOME/LICENSE" "$out/node.LICENSE"
  cp "$CADDY_HOME/LICENSE" "$out/caddy.LICENSE"
  cp "$PG_HOME/LICENSE.md" "$out/postgres-embedded.LICENSE.md"
  cp "$PG_CLIENT_HOME/COPYRIGHT" "$out/postgres.COPYRIGHT"
  cp "$PS_SRC/LICENSE" "$out/powersync-service.LICENSE"
  ok "licenses (5 files)"
}

git_sha() { git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown; }
git_dirty() { [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] && echo true || echo false; }

write_manifest() {
  local out="$1"
  say "→ manifest.json"
  "$BUILD_NODE" "$HERE/manifest.mjs" write "$out" <<EOF
{
  "arch": "$ARCH",
  "platform": "$PLATFORM",
  "gitSha": "$(git_sha)",
  "gitDirty": $(git_dirty),
  "waffledVersion": "$(api_version)",
  "components": {
    "node": { "version": "$NODE_VERSION", "path": "bin/node", "source": "$NODE_URL" },
    "postgres": { "version": "$PG_VERSION", "path": "bin/postgres",
      "source": "npm:$PG_NPM_PKG@$PG_NPM_VERSION (EDB build, thinned to $ARCH)",
      "clientTools": { "tools": "$PG_CLIENT_TOOLS", "version": "$PG_CLIENT_VERSION", "source": "$PG_CLIENT_URL" } },
    "caddy": { "version": "$CADDY_VERSION", "path": "bin/caddy", "source": "$CADDY_URL" },
    "api": { "version": "$(api_version)", "path": "api", "serve": "api/dist/server.js", "migrate": "api/dist/migrate.js", "migrations": "api/migrations" },
    "powersync": { "version": "$POWERSYNC_VERSION", "path": "powersync", "entry": "powersync/service/lib/entry.js", "source": "$POWERSYNC_REPO@v$POWERSYNC_VERSION" },
    "web": { "version": "$(web_version)", "path": "web" },
    "config": { "path": "config", "source": "infra/compose (verbatim)" }
  }
}
EOF
  ok "manifest.json ($(hsize "$out/manifest.json"))"
}

cmd_build() {
  local out="${1:-$DEFAULT_OUT}"
  have_fetched || die "cache is incomplete — run: $0 fetch"
  need lipo; need rsync; need xxd
  case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
  say "building runtime/ → $out"
  rm -rf "$out"; mkdir -p "$out"
  build_node "$out"
  build_postgres "$out"
  build_caddy "$out"
  build_api "$out"
  build_web "$out"
  build_powersync "$out"
  build_config "$out"
  build_licenses "$out"
  write_manifest "$out"
  ok "build done — $(hsize "$out") total"
}

# ── verify ───────────────────────────────────────────────────────────────────
# The test for this script. Everything runs with an EMPTY environment and
# PATH=/usr/bin:/bin — no Homebrew, no nvm, no repo — to prove the tree is self-contained.
PASS=0; FAIL=0
check() { # check <name> <expected-exit|any> <expect-regex> <forbid-regex> -- <cmd...>
  local name="$1" want="$2" expect="$3" forbid="$4"; shift 5
  local outfile; outfile="$(mktemp)"
  local code=0
  ( cd "$RT" && env -i PATH=/usr/bin:/bin HOME="$SMOKE_HOME" NODE_ENV="${SMOKE_NODE_ENV:-}" "$@" ) >"$outfile" 2>&1 || code=$?
  local why=""
  if [ "$want" != any ] && [ "$code" != "$want" ]; then why="exit $code (wanted $want)"; fi
  if [ -n "$expect" ] && ! grep -Eq -- "$expect" "$outfile"; then why="${why:+$why; }output lacks /$expect/"; fi
  if [ -n "$forbid" ] && grep -Eq -- "$forbid" "$outfile"; then why="${why:+$why; }output matches /$forbid/"; fi
  if [ -z "$why" ]; then
    PASS=$((PASS + 1)); printf '%s✓ %s%s %s\n' "$c_grn" "$name" "$c_reset" "$c_dim$(head -n 1 "$outfile" | cut -c1-90)$c_reset"
  else
    FAIL=$((FAIL + 1)); printf '%s✗ %s — %s%s\n' "$c_red" "$name" "$why" "$c_reset"; sed 's/^/    /' "$outfile" | head -n 12
  fi
  rm -f "$outfile"
}
check_file() { if [ -e "$RT/$1" ]; then PASS=$((PASS + 1)); ok "$1 present"; else FAIL=$((FAIL + 1)); printf '%s✗ %s missing%s\n' "$c_red" "$1" "$c_reset"; fi; }

cmd_verify() {
  RT="${1:-}"; [ -n "$RT" ] || die "usage: $0 verify <outdir>"
  case "$RT" in /*) ;; *) RT="$PWD/$RT" ;; esac
  [ -f "$RT/manifest.json" ] || die "$RT has no manifest.json"
  need lipo; need xxd
  SMOKE_HOME="$(mktemp -d)"
  say "verifying $RT"
  say "── manifest"
  if "$RT/bin/node" "$HERE/manifest.mjs" verify "$RT"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
  say "── binaries (env -i, PATH=/usr/bin:/bin)"
  local nodev; nodev="$("$RT/bin/node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).components.node.version' "$RT/manifest.json")"
  check "node --version" 0 "^v${nodev}\$" "" -- bin/node --version
  check "caddy version" 0 "^v[0-9]" "" -- bin/caddy version
  local b
  for b in postgres initdb pg_ctl pg_dump pg_restore pg_isready psql; do
    check "postgres/bin/$b --version" 0 "\(PostgreSQL\) 16\." "dyld|Library not loaded" -- "bin/postgres/bin/$b" --version
  done
  # arm64-only: every Mach-O under bin/ must have exactly one architecture
  local fat=0 f
  while IFS= read -r f; do
    is_macho "$f" || continue
    case "$(lipo -archs "$f" 2>/dev/null)" in *" "*) fat=$((fat + 1)); warn "still universal: ${f#$RT/}" ;; esac
  done < <(find "$RT/bin" -type f)
  if [ "$fat" = 0 ]; then PASS=$((PASS + 1)); ok "all Mach-O files under bin/ are single-arch"; else FAIL=$((FAIL + 1)); fi
  say "── api (bundled node, no node_modules)"
  # With NODE_ENV=production and no secrets the api refuses to start at load time — after
  # every module resolved. Without DATABASE_URL, migrate.js says so and exits 1.
  SMOKE_NODE_ENV=production check "api server.js loads, refuses without secrets" 1 "Invalid production secrets" "Cannot find module|ERR_MODULE_NOT_FOUND" -- bin/node api/dist/server.js
  check "api migrate.js fails on missing DATABASE_URL" 1 "DATABASE_URL is not set" "Cannot find module" -- bin/node api/dist/migrate.js
  check "api health-cli.js loads" any "" "Cannot find module" -- bin/node api/dist/health-cli.js --help
  check_file api/migrations
  check "api migrations present (≥ 90 .sql files)" 0 "^(9[0-9]|[1-9][0-9]{2,})\$" "" -- sh -c 'ls api/migrations/*.sql | wc -l | tr -d " "'
  say "── powersync"
  check "powersync entry.js --help" 0 "start \[options\]" "Cannot find module|ERR_MODULE_NOT_FOUND" -- bin/node powersync/service/lib/entry.js --help
  # The one native addon (mongodb's snappy, via @napi-rs) must be the darwin-arm64 prebuild and load.
  check "powersync native addon @napi-rs/snappy-darwin-arm64 loads" 0 "^ok$" "" -- sh -c 'f="$(find "$PWD/powersync/node_modules/.pnpm" -name "snappy.darwin-arm64.node" | head -n 1)"; [ -n "$f" ] && bin/node -e "require(process.argv[1]); console.log(\"ok\")" "$f"'
  say "── web + config"
  check_file web/index.html
  check_file config/Caddyfile
  check_file config/00-init.sql
  check_file config/powersync/service.yaml
  check_file config/powersync/sync-config.yaml
  if [ -f "$ROOT/infra/compose/caddy/Caddyfile" ]; then
    if cmp -s "$RT/config/Caddyfile" "$ROOT/infra/compose/caddy/Caddyfile" \
       && cmp -s "$RT/config/00-init.sql" "$ROOT/infra/compose/postgres/init/00-init.sql" \
       && cmp -s "$RT/config/powersync/service.yaml" "$ROOT/infra/compose/powersync/service.yaml" \
       && cmp -s "$RT/config/powersync/sync-config.yaml" "$ROOT/infra/compose/powersync/sync-config.yaml"; then
      PASS=$((PASS + 1)); ok "config/ is byte-identical to infra/compose"
    else FAIL=$((FAIL + 1)); printf '%s✗ config/ differs from infra/compose%s\n' "$c_red" "$c_reset"; fi
  fi
  rm -rf "$SMOKE_HOME"
  say "── sizes"
  ( cd "$RT" && du -sh bin/node bin/postgres bin/caddy api powersync web config licenses manifest.json 2>/dev/null | sed 's/^/  /' && printf '  %s\ttotal\n' "$(du -sh . | cut -f1)" )
  say ""
  if [ "$FAIL" = 0 ]; then ok "verify: $PASS checks passed"; else die "verify: $FAIL failed, $PASS passed"; fi
}

# ── clean ────────────────────────────────────────────────────────────────────
cmd_clean() {
  rm -rf "$HERE/out"; ok "removed $HERE/out"
  if [ "${1:-}" = "--all" ]; then rm -rf "$CACHE"; ok "removed $CACHE"; fi
}

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
case "${1:-}" in
  fetch)  cmd_fetch ;;
  build)  cmd_build "${2:-}" ;;
  verify) cmd_verify "${2:-}" ;;
  clean)  cmd_clean "${2:-}" ;;
  *) usage ;;
esac
