#!/usr/bin/env bash
# The Mac half of a Waffled release: a signed, notarized, stapled DMG and the Sparkle
# appcast beside it.
#
#   apps/mac/Scripts/release-mac.sh <version> [--adhoc] [--no-notarize] [--no-upload]
#
# It runs on the one Mac that holds the Developer ID certificate, the notarytool profile and
# the Sparkle EdDSA key — all three in the login Keychain, none of them in this repo or in
# CI, which is why this is a local command and not a workflow. `./waffled release X.Y.Z`
# does the repo half (versions, changelog, tag) and then tells you to run this.
#
# Everything lands under apps/mac/dist/ (gitignored). Idempotent: every step replaces what
# it wrote last time, so a run that failed at notarization can simply be run again.
#
# bash 3.2-clean (macOS /bin/bash): no associative arrays, no ${x,,}, no mapfile.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MAC="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$MAC/../.." && pwd)"

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓ %s%s\n' "$c_grn" "$*" "$c_reset"; }
warn() { printf '%s! %s%s\n' "$c_ylw" "$*" "$c_reset"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; exit 1; }
hsize() { du -sh "$1" 2>/dev/null | cut -f1 | tr -d ' '; }

# Timing, per step, because "how long does a Mac release take?" is the question everyone
# asks first and nobody records. SECONDS is bash's own counter — no date arithmetic.
STEP_START=0
step() { STEP_START=$SECONDS; printf '\n%s── %s%s\n' "$c_dim" "$*" "$c_reset"; }
took() { printf '%s   (%ss)%s\n' "$c_dim" "$((SECONDS - STEP_START))" "$c_reset"; }

usage() {
  cat <<'USAGE'
release-mac.sh — build, sign, notarize and package Waffled.app as a DMG

  release-mac.sh <version> [options]

  <version>   the release, X.Y.Z. It must already be in apps/mac/project.yml
              (./waffled release X.Y.Z puts it there) — this script refuses to
              build a DMG whose name and contents disagree.

Options:
  --adhoc          build an unsigned DMG for local testing. Implies --no-notarize
                   and --no-upload: an ad-hoc build cannot be notarized, and must
                   never be published.
  --no-notarize    sign, but skip notarization and stapling. Implies --no-upload:
                   Gatekeeper refuses an unnotarized download, while Sparkle would
                   install it anyway, so it must never reach a Release.
  --no-upload      do everything except `gh release upload`.
  -h, --help       this.

Signing comes from ~/.config/waffled/signing.conf (see apps/mac/signing.example.conf);
environment variables of the same name override it:

  WAFFLED_SIGN_IDENTITY   e.g. "Developer ID Application: Name (TEAMID1234)"
  WAFFLED_TEAM_ID         the team, for DEVELOPMENT_TEAM
  WAFFLED_NOTARY_PROFILE  an `xcrun notarytool store-credentials` Keychain profile

Nothing secret is read, printed or stored by this script: the certificate's private key,
the notarization password and the Sparkle EdDSA key all stay in the login Keychain. The
FIRST codesign of a session may raise a Keychain dialog — a headless shell cannot answer
one, so if this appears to hang at 0% CPU, look at the screen.

Output, all under apps/mac/dist/:
  runtime/                 the runtime bundle this release was built from
  app/Waffled.app          the signed, notarized, stapled app
  release/Waffled-X.Y.Z.dmg + appcast.xml   the two files that get uploaded
USAGE
}

# ── arguments ────────────────────────────────────────────────────────────────
VERSION=""
ADHOC=no
NOTARIZE=yes
UPLOAD=yes
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help|help) usage; exit 0 ;;
    --adhoc)        ADHOC=yes; NOTARIZE=no; UPLOAD=no ;;
    # Skipping notarization also skips the upload, and not as a convenience: Sparkle trusts
    # an update by EdDSA signature alone, so an unnotarized DMG on the Release is one every
    # installed copy would download and install while Gatekeeper refuses it to anyone who
    # clicks the same link.
    --no-notarize)  NOTARIZE=no; UPLOAD=no ;;
    --no-upload)    UPLOAD=no ;;
    -*)             die "unknown option: $1 (--help for the list)" ;;
    *)              [ -z "$VERSION" ] || die "one version, not two: $VERSION and $1"
                    VERSION="$1" ;;
  esac
  shift
done
[ -n "$VERSION" ] || { usage >&2; exit 1; }
printf '%s' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
  || die "version must be canonical SemVer X.Y.Z (no leading v): got '$VERSION'"

DIST="$MAC/dist"
BUNDLE="$DIST/runtime"
APPOUT="$DIST/app"
APP="$APPOUT/Waffled.app"
RELEASE="$DIST/release"
DMG="$RELEASE/Waffled-$VERSION.dmg"
STAGING="$DIST/staging"
ENTITLEMENTS="$MAC/Entitlements"
# codesign narrates every file it touches on stderr ("replacing existing signature"), which
# over 124 runtime binaries plus Sparkle is a screen of nothing. It goes here, and is printed
# only when something fails.
SIGNLOG="$DIST/codesign.log"

# ── the identity ──────────────────────────────────────────────────────────
step "1. signing configuration"
CONF="$HOME/.config/waffled/signing.conf"
if [ -f "$CONF" ]; then
  # Values only — the file is ours and holds no code, but sourcing it would still let a
  # stray line run. Read it as key=value, and let a real environment variable win.
  # Surrounding quotes are stripped: the identity has spaces in it, so anyone who has ever
  # written a .env will quote it, and a literal `"` in the value is a certificate name that
  # matches nothing.
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    case "$key" in
      WAFFLED_SIGN_IDENTITY) [ -n "${WAFFLED_SIGN_IDENTITY:-}" ] || WAFFLED_SIGN_IDENTITY="$val" ;;
      WAFFLED_TEAM_ID)       [ -n "${WAFFLED_TEAM_ID:-}" ]       || WAFFLED_TEAM_ID="$val" ;;
      WAFFLED_NOTARY_PROFILE) [ -n "${WAFFLED_NOTARY_PROFILE:-}" ] || WAFFLED_NOTARY_PROFILE="$val" ;;
    esac
  done < "$CONF"
  ok "read $CONF"
else
  say "${c_dim}  no $CONF${c_reset}"
fi
SIGN_ID="${WAFFLED_SIGN_IDENTITY:-}"
TEAM_ID="${WAFFLED_TEAM_ID:-}"
NOTARY_PROFILE="${WAFFLED_NOTARY_PROFILE:-}"

if [ "$ADHOC" = yes ]; then
  SIGN_ID=""
  warn "ad-hoc build: the DMG will be unsigned, unnotarized, and must not be published"
else
  [ -n "$SIGN_ID" ] || die "no signing identity.
  Put WAFFLED_SIGN_IDENTITY in $CONF (see apps/mac/signing.example.conf), or set it in the
  environment — or pass --adhoc for an unsigned DMG you can only test locally."
  [ -n "$TEAM_ID" ] || die "WAFFLED_SIGN_IDENTITY is set but WAFFLED_TEAM_ID is not"
  security find-identity -v -p codesigning | grep -Fq "$SIGN_ID" \
    || die "'$SIGN_ID' is not a codesigning identity in this Keychain.
  security find-identity -v -p codesigning  lists what is."
  ok "identity: $SIGN_ID"
  if [ "$NOTARIZE" = yes ]; then
    [ -n "$NOTARY_PROFILE" ] || die "notarization needs WAFFLED_NOTARY_PROFILE (or --no-notarize)"
    ok "notarytool profile: $NOTARY_PROFILE"
  fi
fi
took

# ── the version ───────────────────────────────────────────────────────────
# CFBundleVersion follows MARKETING_VERSION (project.yml), and Sparkle compares that. A DMG
# named for one version holding an app that reports another is the one mistake this whole
# pipeline cannot recover from: it ships, and every installed copy either ignores it or
# offers it forever.
step "2. version"
PROJECT_VERSION="$(sed -nE 's/^[[:space:]]*MARKETING_VERSION:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/p' "$MAC/project.yml" | head -1)"
[ -n "$PROJECT_VERSION" ] || die "no MARKETING_VERSION in $MAC/project.yml"
[ "$PROJECT_VERSION" = "$VERSION" ] || die "apps/mac/project.yml says $PROJECT_VERSION, you asked for $VERSION.
  ./waffled release $VERSION is what bumps it; run this after that, on the tagged commit."
ok "apps/mac/project.yml MARKETING_VERSION = $VERSION"
took

# ── the bundle and the app ────────────────────────────────────────────────
step "3. runtime bundle"
"$ROOT/infra/native/bundle/build.sh" build "$BUNDLE" || die "the runtime bundle did not build"
ok "$BUNDLE ($(hsize "$BUNDLE"))"
took

step "4. Waffled.app"
rm -rf "$APP"
if [ -n "$SIGN_ID" ]; then
  WAFFLED_SIGN_IDENTITY="$SIGN_ID" WAFFLED_TEAM_ID="$TEAM_ID" \
    "$HERE/build-app.sh" "$BUNDLE" "$APPOUT" || die "build-app.sh failed"
else
  "$HERE/build-app.sh" "$BUNDLE" "$APPOUT" || die "build-app.sh failed"
fi
[ -d "$APP" ] || die "build-app.sh produced no $APP"

took

# ── Sparkle, inside-out ───────────────────────────────────────────────────
# Xcode signs Sparkle.framework itself with our identity and stops there: measured on
# Sparkle 2.9.6 via SPM, Autoupdate, Updater.app, Downloader.xpc and Installer.xpc all come
# out of a Developer ID build still `Signature=adhoc`, and notarization rejects the app for
# them. They are separate code inside the framework, so they have to be signed first and the
# framework re-sealed around them — Sparkle's own documented order.
#
# No entitlements, also following Sparkle: the only one any of them ships is Autoupdate's
# `com.apple.application-identifier`, which names Sparkle's team rather than ours and means
# nothing outside the App Store.
step "5. Sparkle's nested code"
mkdir -p "$DIST"
: > "$SIGNLOG"
SPARKLE="$APP/Contents/Frameworks/Sparkle.framework"
if [ -n "$SIGN_ID" ] && [ -d "$SPARKLE" ]; then
  for nested in \
    "Versions/B/XPCServices/Downloader.xpc" \
    "Versions/B/XPCServices/Installer.xpc" \
    "Versions/B/Updater.app" \
    "Versions/B/Autoupdate" \
    "Versions/B"
  do
    [ -e "$SPARKLE/$nested" ] || continue
    codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$SPARKLE/$nested" \
      >>"$SIGNLOG" 2>&1 || { tail -n 20 "$SIGNLOG" >&2; die "could not sign Sparkle's $nested"; }
    say "  $nested"
  done
  # Prove it, rather than trust it: this is the check that a 690 MB notarization round trip
  # would otherwise be. Counted, because a loop that skipped all four would "pass".
  verified=0
  for nested in \
    "Versions/B/Autoupdate" \
    "Versions/B/Updater.app" \
    "Versions/B/XPCServices/Downloader.xpc" \
    "Versions/B/XPCServices/Installer.xpc"
  do
    [ -e "$SPARKLE/$nested" ] || continue
    authority="$(codesign -dvv "$SPARKLE/$nested" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
    case "$authority" in
      "Developer ID Application:"*) ;;
      *) die "Sparkle's $nested is signed '${authority:-ad hoc}', not with the Developer ID —
  notarization would reject the whole app for it." ;;
    esac
    verified=$((verified + 1))
  done
  [ "$verified" -eq 4 ] || die "only $verified of Sparkle's 4 nested items were there to verify.
  Autoupdate, Updater.app, Downloader.xpc and Installer.xpc all have to carry the Developer ID;
  a missing one means the framework layout changed — update the nested paths above."
  ok "Autoupdate, Updater.app and both XPC services carry the Developer ID"
elif [ -n "$SIGN_ID" ]; then
  die "Sparkle.framework not at $SPARKLE — the layout changed; update the nested paths"
else
  say "${c_dim}  --adhoc: left as built${c_reset}"
fi
took

# ── sign every Mach-O in the embedded runtime ─────────────────────────────
# Found by Mach-O magic, never by extension: Postgres ships extensions as .dylib and .so,
# PowerSync's native prebuilds are .node, and node, caddy and waffled-runtime are bare
# names in bin/. 124 of them in the 0.14.3 bundle, out of 36,479 files.
#
# One codesign per file, not `--deep` over the app: --deep would rewrite these same Mach-O
# files as a side effect of sealing the app, invalidating every hash in the bundle manifest
# that the runtime checks before it starts anything.
step "6. sign the embedded runtime"
RT="$APP/Contents/Resources/runtime"
[ -d "$RT" ] || die "no runtime inside $APP"
MACHOS="$DIST/machos.txt"
"$RT/bin/node" -e '
const { readdir, open, lstat } = require("node:fs/promises")
const path = require("node:path")
const root = path.resolve(process.argv[1])
// Mach-O and universal-binary magics, big-endian read: 32/64-bit, both byte orders, fat.
const MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])
const files = []
const found = []
async function visit(rel) {
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isSymbolicLink()) continue          // a link is signed through its target
    else if (e.isDirectory()) await visit(r)
    else if (e.isFile()) files.push(r)
  }
}
visit("").then(async () => {
  let i = 0
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (i < files.length) {
      const rel = files[i++]
      const abs = path.join(root, rel)
      if ((await lstat(abs)).size < 4) continue
      let fh
      try { fh = await open(abs, "r") } catch { continue }
      try {
        const buf = Buffer.alloc(4)
        await fh.read(buf, 0, 4, 0)
        if (MAGIC.has(buf.readUInt32BE(0))) found.push(rel)
      } finally { await fh.close() }
    }
  }))
  // Deepest first: inside-out, so a nested bundle is sealed before whatever contains it.
  found.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b))
  console.log(found.join("\n"))
})
' "$RT" > "$MACHOS" || die "could not scan the runtime for Mach-O files"
MACHO_COUNT="$(grep -c . "$MACHOS" || true)"
[ "$MACHO_COUNT" -gt 0 ] || die "found no Mach-O files under $RT — the scan is broken"
say "  $MACHO_COUNT Mach-O files"

if [ -n "$SIGN_ID" ]; then
  # --timestamp is a network round trip to Apple per signature, and it dominates: serially
  # that is ~10 minutes for 124 binaries and 5 seconds at -P 8. Entitled binaries are signed
  # one at a time first, so the parallel pass can be a single uniform command.
  #
  # Entitlements are matched by FILE NAME: apps/mac/Entitlements/<name>.entitlements.plist.
  # Today that is node alone (V8's code range needs allow-jit), and the policy is that the
  # set stays this small — see apps/mac/CLAUDE.md.
  ENTITLED=""
  for plist in "$ENTITLEMENTS"/*.entitlements.plist; do
    [ -f "$plist" ] || continue
    name="$(basename "$plist" .entitlements.plist)"
    matched=0
    while IFS= read -r rel; do
      [ "$(basename "$rel")" = "$name" ] || continue
      say "  $rel + $(basename "$plist")"
      codesign --force --options runtime --timestamp --entitlements "$plist" \
        --sign "$SIGN_ID" "$RT/$rel" >>"$SIGNLOG" 2>&1 \
        || { tail -n 20 "$SIGNLOG" >&2; die "could not sign $rel with $plist"; }
      matched=$((matched + 1))
      ENTITLED="$ENTITLED$rel
"
    done < "$MACHOS"
    # An entitlement that silently applied to nothing is how node loses allow-jit: the
    # binary moves or is renamed, every signature still succeeds, and V8 aborts at launch
    # on the notarized build.
    [ "$matched" -gt 0 ] || die "$(basename "$plist") matched no binary named '$name' under $RT.
  Entitlements are matched by file name — rename the plist to the binary it belongs to, or
  remove it."
  done
  # Everything else, in parallel. -P 8 is well inside Apple's timestamp service's tolerance
  # and turns the slowest step of the pipeline into one of the quicker ones.
  PLAIN="$DIST/machos-plain.txt"
  if [ -n "$ENTITLED" ]; then
    printf '%s' "$ENTITLED" | sort > "$DIST/machos-entitled.txt"
    sort "$MACHOS" | comm -23 - "$DIST/machos-entitled.txt" > "$PLAIN"
  else
    cp "$MACHOS" "$PLAIN"
  fi
  ( cd "$RT" && tr '\n' '\0' < "$PLAIN" | xargs -0 -P 8 -n 1 \
      codesign --force --options runtime --timestamp --sign "$SIGN_ID" ) >>"$SIGNLOG" 2>&1 \
    || { tail -n 30 "$SIGNLOG" >&2; die "signing the runtime failed — full log at $SIGNLOG"; }
  ok "signed $MACHO_COUNT binaries with the hardened runtime and a secure timestamp"
else
  say "${c_dim}  --adhoc: left as built${c_reset}"
fi
took

# ── the manifest, then prove it ───────────────────────────────────────────
# Signing rewrote the bytes of 124 files the manifest records a sha256 for, so the manifest
# is written LAST — the rule in infra/native/bundle/README.md. The metadata half (versions,
# components, git sha) is carried over from the manifest the build wrote; only the hashes
# change.
step "7. rewrite the bundle manifest"
if [ -n "$SIGN_ID" ]; then
  "$RT/bin/node" -e '
    const { readFile } = require("node:fs/promises")
    readFile(process.argv[1] + "/manifest.json", "utf8").then((raw) => {
      const { arch, platform, gitSha, gitDirty, waffledVersion, components } = JSON.parse(raw)
      console.log(JSON.stringify({ arch, platform, gitSha, gitDirty, waffledVersion, components }))
    })
  ' "$RT" > "$DIST/manifest-meta.json" || die "could not read the manifest's metadata"
  "$RT/bin/node" "$ROOT/infra/native/bundle/manifest.mjs" write "$RT" < "$DIST/manifest-meta.json" \
    || die "could not rewrite the manifest"
fi

# The embedded supervisor verifying the embedded bundle — the same gate build-app.sh runs,
# re-run because everything it proved has been rewritten since. Its own throwaway data
# directory: never the household's, and never one an app is about to be booted against.
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
doctor_out="$("$RT/bin/waffled-runtime" doctor --json --data "$probe" 2>&1 || true)"
detail="$(printf '%s' "$doctor_out" | "$RT/bin/node" -e '
  const NAME = "bundle manifest";  // supervisor.CheckBundleManifest
  let raw = "";
  process.stdin.on("data", (c) => (raw += c)).on("end", () => {
    let checks;
    try { checks = JSON.parse(raw) } catch {
      console.error("doctor --json printed no parseable JSON:");
      console.error(raw.trim() || "  (nothing at all)");
      process.exit(1);
    }
    const check = (Array.isArray(checks) ? checks : []).find((c) => c && c.name === NAME);
    if (!check) { console.error(`doctor reported no "${NAME}" check`); process.exit(1) }
    if (check.status !== "ok") { console.error(`"${NAME}" is ${check.status}: ${check.detail}`); process.exit(1) }
    console.log(check.detail);
  });
')" || die "the signed runtime does not verify against its own manifest — see above"
ok "$detail"
took

# ── seal the app around all of it ─────────────────────────────────────────
# Last, and shallow. Steps 5 and 6 changed files the app's CodeResources seals, so the
# signature build-app.sh left is stale; --deep would fix that by re-signing the runtime's
# Mach-O files too, undoing step 6.
step "8. sign the app"
if [ -n "$SIGN_ID" ]; then
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP" \
    || die "could not sign $APP"
else
  codesign --force --sign - "$APP" >/dev/null 2>&1 || die "could not re-sign $APP ad hoc"
fi
codesign --verify --deep --strict --verbose=2 "$APP" || die "the signed app does not verify"
ok "codesign --verify --deep --strict passes"
# Informational before notarization, a gate after it: a correctly signed app that has not
# been notarized yet is *supposed* to be rejected here, and reporting the verdict is more
# use than hiding it.
say "${c_dim}  spctl before notarization:${c_reset}"
spctl -a -vv -t exec "$APP" 2>&1 | sed 's/^/    /' || true
took

# ── notarize ──────────────────────────────────────────────────────
notarize() { # notarize <path> <what>
  local path="$1" what="$2" zip="" target submit id
  target="$path"
  case "$path" in
    *.app)
      # notarytool takes an archive, not a directory. ditto -c -k --keepParent is the form
      # Apple documents, and the one that keeps the bundle's 1,338 symlinks as symlinks.
      zip="$DIST/$(basename "$path").zip"
      rm -f "$zip"
      ditto -c -k --keepParent "$path" "$zip" || die "could not zip $path for notarization"
      target="$zip"
      ;;
  esac
  # ${what} braced: the ellipsis that follows is multibyte, and bash 3.2 reads its first
  # byte as part of an unbraced name.
  say "  submitting $(hsize "$target") of ${what}…"
  submit="$(xcrun notarytool submit "$target" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)" \
    || { printf '%s\n' "$submit"; die "notarytool submit failed for $what"; }
  printf '%s\n' "$submit" | sed 's/^/    /'
  id="$(printf '%s\n' "$submit" | sed -n 's/^ *id: *//p' | head -1)"
  if ! printf '%s' "$submit" | grep -q 'status: Accepted'; then
    if [ -n "$id" ]; then
      say "${c_red}  notarization log:${c_reset}"
      xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" 2>&1 | sed 's/^/    /' || true
    fi
    die "$what was not accepted"
  fi
  ok "$what accepted (submission $id)"
  if [ -n "$zip" ]; then rm -f "$zip"; fi
  # Stapling writes the ticket into the bundle/DMG so a Mac with no network can still see it.
  xcrun stapler staple "$path" || die "could not staple $what"
  xcrun stapler validate "$path" || die "$what does not validate after stapling"
  ok "stapled"
  return 0
}

step "9. notarize the app"
if [ "$NOTARIZE" = yes ]; then
  notarize "$APP" "Waffled.app"
else
  warn "skipped (--no-notarize): this app is NOT publishable"
fi
took

# ── the DMG ───────────────────────────────────────────────────────────────
# A staging folder with the app and a symlink to /Applications — the drag-here layout every
# Mac user knows, and the whole of it. No create-dmg, no background image, no AppleScript
# window geometry: a 690 MB app is what people are here for.
step "10. build the DMG"
rm -rf "$STAGING"; mkdir -p "$STAGING" "$RELEASE"
cp -Rpc "$APP" "$STAGING/Waffled.app" || die "could not stage the app"
ln -s /Applications "$STAGING/Applications"
rm -f "$DMG"
hdiutil create -volname "Waffled $VERSION" -srcfolder "$STAGING" -ov -quiet \
  -format UDZO "$DMG" || die "hdiutil could not build the DMG"
rm -rf "$STAGING"
ok "$DMG ($(hsize "$DMG"))"
if [ -n "$SIGN_ID" ]; then
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG" || die "could not sign the DMG"
  ok "DMG signed"
fi
took

step "11. notarize the DMG"
if [ "$NOTARIZE" = yes ]; then
  notarize "$DMG" "Waffled-$VERSION.dmg"
  # The proof, and the only verdict that matters to a household: what Gatekeeper says about
  # the file they will actually download.
  verdict="$(spctl -a -vv -t install "$DMG" 2>&1)" || true
  printf '%s\n' "$verdict" | sed 's/^/    /'
  printf '%s' "$verdict" | grep -q 'source=Notarized Developer ID' \
    || die "Gatekeeper does not see a notarized DMG"
  ok "Gatekeeper: source=Notarized Developer ID"
else
  warn "skipped (--no-notarize)"
fi
took

# ── the appcast ──────────────────────────────────────────────────────────
# Sparkle 2 installs from a DMG as happily as from a zip, and a DMG is what people download,
# so the feed names the same file. generate_appcast reads the version out of the app inside
# it; the EdDSA signature is made in the Keychain and never leaves it.
step "12. the Sparkle appcast"
if [ "$NOTARIZE" != yes ]; then
  warn "skipped (--no-notarize): an unnotarized DMG must never be fed to Sparkle"
else
  WAFFLED_DOWNLOAD_URL_PREFIX="https://github.com/kevinpsites/waffled/releases/download/v$VERSION/" \
    "$HERE/make-appcast.sh" "$RELEASE" "$RELEASE/appcast.xml" || die "make-appcast.sh failed"
  grep -Fq "Waffled-$VERSION.dmg" "$RELEASE/appcast.xml" \
    || die "$RELEASE/appcast.xml does not name Waffled-$VERSION.dmg"
  ok "$RELEASE/appcast.xml"
fi
took

# ── upload ───────────────────────────────────────────────────────────────
# The GitHub Release is created by the `release` job in publish-images.yml when the v* tag
# is pushed, which takes a few minutes — so this waits for it rather than failing on a race
# and leaving a signed DMG nobody uploaded.
step "13. upload to the GitHub Release"
if [ "$UPLOAD" = yes ]; then
  command -v gh >/dev/null 2>&1 || die "gh is not installed — upload by hand, or --no-upload"
  say "  waiting for release v$VERSION (publish-images.yml creates it from the tag)…"
  waited=0
  until gh release view "v$VERSION" >/dev/null 2>&1; do
    [ "$waited" -lt 900 ] || die "release v$VERSION still does not exist after 15 minutes.
  Check the tag was pushed and that publish-images.yml's release job succeeded, then re-run
  this with the same arguments — everything before this step is idempotent."
    sleep 15
    waited=$((waited + 15))
    say "${c_dim}    ${waited}s${c_reset}"
  done
  gh release upload "v$VERSION" "$DMG" "$RELEASE/appcast.xml" --clobber \
    || die "gh release upload failed"
  ok "uploaded Waffled-$VERSION.dmg + appcast.xml to v$VERSION"
  say "${c_dim}  https://github.com/kevinpsites/waffled/releases/latest/download/appcast.xml"
  say "  now resolves to this feed — that is the URL every installed copy checks.${c_reset}"
else
  warn "skipped (--no-upload)"
  if [ "$NOTARIZE" = yes ]; then
    say "${c_dim}  Upload by hand with:"
    say "    gh release upload v$VERSION '$DMG' '$RELEASE/appcast.xml' --clobber${c_reset}"
  else
    say "${c_dim}  This DMG is for local testing only: unnotarized, and with no feed, there is"
    say "  nothing here that may be uploaded.${c_reset}"
  fi
fi
took

say ""
ok "Waffled $VERSION — $DMG ($(hsize "$DMG"))"
