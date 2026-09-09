#!/usr/bin/env bash
# Assembles Waffled.app with a runtime bundle embedded under Contents/Resources/runtime —
# the layout RuntimeLocator.locate() expects in production, and the one the runtime's own
# `--bundle` default (the directory above the binary) resolves to on its own.
#
#   ./Scripts/build-app.sh <bundle-dir> [out-dir]
#
#   <bundle-dir>  a runtime bundle built by infra/native/bundle/build.sh (it must contain
#                 manifest.json and bin/waffled-runtime)
#   [out-dir]     where the .app and its DerivedData go (default: apps/mac/build)
#
# This is a script rather than an Xcode copy-files phase on purpose: the bundle is ~670 MB,
# and a build phase would re-copy it on every incremental build of a 9-file app. Run it when
# you want a whole app; run xcodebuild when you want the app.
#
# Idempotent: it removes what it is about to write, so a second run replaces the .app rather
# than nesting a runtime inside the last one.
#
# The app is signed ad hoc, by xcodebuild, exactly as `xcodebuild build` signs it today —
# Developer ID signing and notarization are Phase 3 item 5 (docs/product/native-mac-plan.md
# §7). Nothing here re-signs the app AFTER embedding, and the distinction matters: a shallow
# `codesign --force --sign - Waffled.app` would only rewrite Contents/MacOS/Waffled and
# Contents/_CodeSignature, neither of which the runtime manifest covers, and would be safe.
# It is `--deep` that rewrites the Mach-O files inside Resources/runtime/ and invalidates
# every one of their hashes — which is why the packaging order in
# infra/native/bundle/README.md is sign first, write the manifest second.
#
# bash 3.2-clean (macOS /bin/bash): no associative arrays, no ${x,,}, no mapfile.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MAC="$(cd "$HERE/.." && pwd)"

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓ %s%s\n' "$c_grn" "$*" "$c_reset"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; exit 1; }
hsize() { du -sh "$1" 2>/dev/null | cut -f1 | tr -d ' '; }

BUNDLE="${1:-}"
OUT="${2:-$MAC/build}"
[ -n "$BUNDLE" ] || die "usage: $0 <bundle-dir> [out-dir]
  <bundle-dir> is a runtime bundle from infra/native/bundle/build.sh build"
case "$BUNDLE" in /*) ;; *) BUNDLE="$PWD/$BUNDLE" ;; esac
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
[ -f "$BUNDLE/manifest.json" ] || die "$BUNDLE is not a runtime bundle (no manifest.json)"
[ -x "$BUNDLE/bin/waffled-runtime" ] || die "$BUNDLE has no bin/waffled-runtime — rebuild it with
  infra/native/bundle/build.sh build '$BUNDLE'  (the supervisor is part of the bundle, and part
  of its manifest, so a bundle built before that change cannot be embedded)"

DD="$OUT/DerivedData"
APP="$OUT/Waffled.app"
PRODUCT="$DD/Build/Products/Release/Waffled.app"

# ── 1. the Xcode project ─────────────────────────────────────────────────────
# Waffled.xcodeproj is generated and gitignored (apps/mac/CLAUDE.md), so regenerate it when
# it is missing or older than the yml it comes from. A project that is merely up to date
# does not need XcodeGen installed at all.
if [ ! -d "$MAC/Waffled.xcodeproj" ] || [ "$MAC/project.yml" -nt "$MAC/Waffled.xcodeproj/project.pbxproj" ]; then
  command -v xcodegen >/dev/null 2>&1 || die "xcodegen not found on PATH — brew install xcodegen
  (project.yml is the source of truth; Waffled.xcodeproj is generated and gitignored)"
  say "→ xcodegen generate"
  ( cd "$MAC" && xcodegen generate >/dev/null ) || die "xcodegen generate failed"
  ok "Waffled.xcodeproj regenerated from project.yml"
else
  ok "Waffled.xcodeproj is up to date"
fi

# ── 2. build the app ─────────────────────────────────────────────────────────
# Release, and always -project: apps/ios has a scheme with the same name (apps/mac/CLAUDE.md).
say "→ xcodebuild build (Release, ad-hoc signed)"
mkdir -p "$OUT"
( cd "$MAC" && xcodebuild build \
    -project Waffled.xcodeproj -scheme Waffled -configuration Release \
    -destination 'platform=macOS' -derivedDataPath "$DD" >"$OUT/xcodebuild.log" 2>&1 ) || {
  tail -n 40 "$OUT/xcodebuild.log" >&2
  die "xcodebuild failed — full log at $OUT/xcodebuild.log"
}
[ -d "$PRODUCT" ] || die "xcodebuild produced no $PRODUCT"
rm -rf "$APP"
cp -Rp "$PRODUCT" "$APP"
ok "Waffled.app built ($(hsize "$APP"))"

# ── 3. embed the runtime bundle ──────────────────────────────────────────────
# cp -c asks APFS to clone: the 670 MB lands as shared blocks, so this costs a fraction of
# a second and no disk until something diverges. It only works within one APFS volume, so
# fall back to a real copy when the bundle lives somewhere else (an external disk, a
# different container) rather than failing the build over an optimisation.
DEST="$APP/Contents/Resources/runtime"
mkdir -p "$APP/Contents/Resources"
rm -rf "$DEST"
say "→ embedding $BUNDLE → Contents/Resources/runtime"
if cp -Rpc "$BUNDLE" "$DEST" 2>/dev/null; then
  ok "cloned into the app (APFS clonefile)"
else
  cp -Rp "$BUNDLE" "$DEST" || die "could not copy the bundle into the app"
  ok "copied into the app (no clonefile — different volume?)"
fi

# Symlinks must survive as symlinks (the manifest records targets and never follows them),
# and every target must stay inside the tree: the bundle is relocatable only because all
# 1,338 of them are relative. One absolute or ../-escaping link would work on this Mac and
# break on the machine that downloads the app.
"$DEST/bin/node" -e '
  const fs = require("fs"), path = require("path");
  const root = path.resolve(process.argv[1]);
  let links = 0; const bad = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        links++;
        const target = fs.readlinkSync(p);
        const resolved = path.resolve(path.dirname(p), target);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
          bad.push(p.slice(root.length + 1) + " → " + target);
        }
      } else if (e.isDirectory()) walk(p);
    }
  })(root);
  if (bad.length) {
    console.error(bad.length + " symlink(s) point outside the embedded runtime:");
    for (const b of bad.slice(0, 20)) console.error("  " + b);
    process.exit(1);
  }
  console.log(String(links));  // a bare Number gets util.inspect colour codes
' "$DEST" >"$OUT/.links" || die "the embedded runtime has symlinks pointing outside itself"
ok "$(cat "$OUT/.links") symlinks preserved, none pointing outside the tree"
rm -f "$OUT/.links"

# ── 4. verify the EMBEDDED copy, with the EMBEDDED binary ────────────────────
# `version` proves the supervisor runs from inside the app and is the build this tree
# produced. `doctor` then runs the same manifest verification that gates `start` — set
# equality on files and symlinks, sha256 per file, the exec bit — against the copy that
# will ship, which is what catches a copy that dropped a symlink or a mode.
RUNTIME_BIN="$DEST/bin/waffled-runtime"
[ -x "$RUNTIME_BIN" ] || die "no $RUNTIME_BIN in the assembled app"
say "→ verifying the embedded runtime"
version="$("$RUNTIME_BIN" version)" || die "the embedded $RUNTIME_BIN will not run"
ok "$version (run from inside the app)"

# Its own throwaway data directory: `doctor` creates one, generates the secrets into
# config.env and memoizes the verification there. It must never be the directory the app is
# about to be booted against — that would turn a fresh-Mac first start into a second one —
# and never the real ~/Library/Application Support/Waffled.
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
# No --bundle: the default is the directory above the binary, so this also proves the app's
# layout resolves on its own. The exit code is deliberately ignored — doctor reports on
# backups, ports and disk too, and a busy port on the build machine is not this script's
# business. The manifest line is.
doctor_out="$("$RUNTIME_BIN" doctor --data "$probe" 2>&1 || true)"
manifest_line="$(printf '%s\n' "$doctor_out" | grep '^✓ bundle manifest' || true)"
if [ -z "$manifest_line" ]; then
  printf '%s\n' "$doctor_out" | sed 's/^/    /' >&2
  die "the embedded runtime did not verify its own bundle — see doctor's output above"
fi
ok "${manifest_line#✓ bundle manifest}"

say ""
ok "$APP ($(hsize "$APP"))"
say "${c_dim}  unsigned beyond an ad-hoc signature: Gatekeeper will refuse it on another Mac"
say "  until Phase 3 item 5 (Developer ID + notarization). Run it here with:"
say "    $APP/Contents/MacOS/Waffled${c_reset}"
