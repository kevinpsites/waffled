#!/usr/bin/env bash
# Signs a directory of Waffled releases into a Sparkle appcast.
#
# This is a thin wrapper over Sparkle's own generate_appcast: it finds the tool, checks the
# two things that otherwise fail late, and pins the one option a 671 MB app cares about.
# The private EdDSA key comes from the login Keychain — never a command line, never printed.
# Phase 3 item 5's release script calls this; nothing in CI does.
#
# bash 3.2-clean (macOS /bin/bash): no associative arrays, no ${x,,}, no mapfile.
set -euo pipefail

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓ %s%s\n' "$c_grn" "$*" "$c_reset"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; exit 1; }

usage() {
  cat <<'USAGE'
make-appcast.sh — sign a directory of Waffled releases into a Sparkle appcast

  make-appcast.sh <dir-of-dmgs-or-zips> [out]

  <dir>   holds the release archives (.dmg or .zip). Sparkle reads each app's version
          out of its Info.plist; nothing here needs telling.
  [out]   where to write the feed. Default: appcast.xml inside <dir> — which is also
          where an existing feed is picked up and extended rather than replaced.

Environment:
  SPARKLE_BIN                  directory holding generate_appcast, if it lives somewhere
                               this script would not think to look.
  WAFFLED_DOWNLOAD_URL_PREFIX  the URL the archives will be downloaded from, e.g.
                               https://github.com/kevinpsites/waffled/releases/download/v0.15.0/
                               Without it the feed names bare filenames, which only works
                               when the appcast is served from beside the archives.

The private key is never passed as an argument and never printed. Back it up once with
`generate_keys -x <file>` and keep it off this machine: losing it strands every installed
copy of Waffled on the version it already has.
USAGE
}

if [ $# -eq 0 ]; then
  usage >&2
  exit 1
fi
case "$1" in
  -h|--help|help) usage; exit 0 ;;
esac

DIR="$1"
OUT="${2:-}"
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac
[ -d "$DIR" ] || die "$DIR is not a directory"
if [ -n "$OUT" ]; then
  case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
fi

# ── the tool ─────────────────────────────────────────────────────────────────
# Sparkle ships generate_appcast inside the SPM artifact it resolves into DerivedData, so
# there is nothing to install: the first xcodebuild that resolved the package downloaded
# it. `find`'s first hit rather than the newest on purpose — project.yml pins Sparkle to an
# exact version, so every copy under an artifacts directory is the same tool.
TOOL=""
MAC="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${SPARKLE_BIN:-}" ] && [ -x "$SPARKLE_BIN/generate_appcast" ]; then
  TOOL="$SPARKLE_BIN/generate_appcast"
elif command -v generate_appcast >/dev/null 2>&1; then
  TOOL="$(command -v generate_appcast)"
else
  for root in "$HOME/Library/Developer/Xcode/DerivedData" "$MAC/build"; do
    if [ -d "$root" ]; then
      TOOL="$(find "$root" -maxdepth 8 -type f -perm -u+x -name generate_appcast \
                -path '*/artifacts/*/Sparkle/bin/*' -print 2>/dev/null | head -1)"
      if [ -n "$TOOL" ]; then
        break
      fi
    fi
  done
fi
[ -n "$TOOL" ] || die "generate_appcast not found.
  It ships with the Sparkle package, so resolving that package once is enough:
    cd apps/mac && xcodebuild -resolvePackageDependencies -project Waffled.xcodeproj -scheme Waffled
  Then re-run this, or point SPARKLE_BIN at the directory holding the tool."

# ── the key ──────────────────────────────────────────────────────────────────
# Checked before any work: generate_appcast extracts every archive before it discovers
# there is nothing to sign with, and extracting a 671 MB app is minutes.
GENKEYS="$(dirname "$TOOL")/generate_keys"
if [ -x "$GENKEYS" ]; then
  if ! "$GENKEYS" -p >/dev/null 2>&1; then
    die "no private EdDSA key in the login Keychain — this Mac cannot sign a Waffled update.
  If the key is backed up, import it:  $GENKEYS -f <the-backup-file>
  Generate a NEW one ($GENKEYS) only if no released build carries the old public key:
  a new key strands every installed copy."
  fi
fi

# No delta updates: they are built by extracting and diffing every archive, and a Waffled
# release is a 671 MB app whose runtime bundle is rebuilt from scratch each time. Sparkle
# downloads the whole archive when there is no delta, which is what would happen anyway.
set -- "$DIR" --maximum-deltas 0
if [ -n "$OUT" ]; then
  set -- "$@" -o "$OUT"
fi
if [ -n "${WAFFLED_DOWNLOAD_URL_PREFIX:-}" ]; then
  set -- "$@" --download-url-prefix "$WAFFLED_DOWNLOAD_URL_PREFIX"
fi

say "→ generate_appcast $DIR"
"$TOOL" "$@" || die "generate_appcast failed — see above"

FEED="${OUT:-$DIR/appcast.xml}"
[ -f "$FEED" ] || die "generate_appcast wrote no $FEED"
ok "$FEED"
say "${c_dim}  Upload it beside the archives it names."
say "  The private key stayed in the Keychain. Backed up? $GENKEYS -x <file>${c_reset}"
