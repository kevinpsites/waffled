#!/usr/bin/env bash
# Vendor the PowerSync Swift SDK with a one-line compatibility patch.
#
# Why: PowerSync 1.14.3 (latest release as of June 2026) declares
#   `private weak let collection` in ActiveInstanceStore.swift. Swift 6.2 /
#   Xcode 26.1 now rejects `weak let` as a hard error ("'weak' must be a mutable
#   variable"). Flipping it to `weak var` then trips the Sendable rule (a mutable
#   stored property on a Sendable class), so we also mark that one class
#   @unchecked Sendable. The field is assigned once in init and read in deinit, so
#   this is safe. There is no fixed upstream release yet. project.yml points the
#   SPM dependency at this local copy.
#
# Remove this workaround once upstream ships a fix and bump back to the remote
# package pin. Vendor/ is gitignored; run this once after checkout (like
# `brew install xcodegen`).
set -euo pipefail

VERSION="1.14.3"
DIR="$(cd "$(dirname "$0")/.." && pwd)/Vendor/powersync-swift"

rm -rf "$DIR"
git clone --depth 1 --branch "$VERSION" \
  https://github.com/powersync-ja/powersync-swift "$DIR"

# weak let -> weak var (the only Swift-6.2 incompatibility in 1.14.3) ...
find "$DIR/Sources" -name '*.swift' -print0 \
  | xargs -0 sed -i '' -E 's/(private[[:space:]]+)?weak let /\1weak var /g'
# ... and keep the now-mutable-field class Sendable.
sed -i '' -E 's/final class ActiveDatabaseGroup: Sendable \{/final class ActiveDatabaseGroup: @unchecked Sendable {/' \
  "$DIR/Sources/PowerSync/Implementation/ActiveInstanceStore.swift"

# Drop the SDK's own git metadata so it's a plain local package.
rm -rf "$DIR/.git"

echo "Vendored PowerSync $VERSION with weak-let patch at $DIR"
