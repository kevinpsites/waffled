#!/usr/bin/env bash
# Maintainer-only: cut a release locally. Usage: scripts/release.sh X.Y.Z
# Bumps apps/api + apps/web versions, dates the CHANGELOG, commits and tags. Never pushes.
set -euo pipefail

REPO_URL="https://github.com/evan-ribbey/waffled-ng"
VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: scripts/release.sh X.Y.Z" >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"

[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "must be on main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree must be clean" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && { echo "tag v$VERSION already exists" >&2; exit 1; }

# Entries under [Unreleased] are everything between its heading and the next "## [" heading.
entries="$(awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md | grep -c '[^[:space:]]' || true)"
[ "$entries" -ge 1 ] || { echo "CHANGELOG.md needs at least one entry under [Unreleased]" >&2; exit 1; }

prev="$(grep -m1 -E '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' CHANGELOG.md | sed -E 's/^## \[([^]]+)\].*/\1/')"
[ -n "$prev" ] || { echo "no previous release heading in CHANGELOG.md" >&2; exit 1; }

for app in api web; do
  (cd "apps/$app" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
done

TODAY="$(date +%Y-%m-%d)"
VERSION="$VERSION" PREV="$prev" TODAY="$TODAY" REPO_URL="$REPO_URL" python3 - <<'PY'
import os, re
v, prev, today, repo = (os.environ[k] for k in ("VERSION", "PREV", "TODAY", "REPO_URL"))
s = open("CHANGELOG.md").read()
s = s.replace("## [Unreleased]\n", f"## [Unreleased]\n\n## [{v}] - {today}\n", 1)
s = re.sub(r"^\[Unreleased\]:.*$",
           f"[Unreleased]: {repo}/compare/v{v}...HEAD\n[{v}]: {repo}/compare/v{prev}...v{v}",
           s, count=1, flags=re.M)
open("CHANGELOG.md", "w").write(s)
PY

git add CHANGELOG.md apps/api/package.json apps/api/package-lock.json apps/web/package.json apps/web/package-lock.json
git commit -q -m "release: v$VERSION"
git tag "v$VERSION"

echo "Released v$VERSION locally. Publish with:"
echo "  git push origin main v$VERSION"
