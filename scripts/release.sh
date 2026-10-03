#!/usr/bin/env bash
# Cut a release: bump panel/package.json, commit, tag, push. CI does the rest
# (.github/workflows/release.yml builds the images and publishes the release).
#
#   ./scripts/release.sh 0.3.0
#   ./scripts/release.sh 0.3.0-rc.1     # prerelease: images and a release, no `latest`
#   ./scripts/release.sh 0.3.0 --dry-run
#
# Run from a clean `main` that is already pushed. A release is not a new state of the code -
# it is the commit that has been running on the maintainer's box as `edge` since it merged.
set -euo pipefail

case "${1:-}" in -h|--help|'') sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;; esac

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$1"; shift
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
  || die "\"$VERSION\" is not a semver version (0.3.0, or 0.3.0-rc.1)."

cd "$REPO_DIR"
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = main ] || die "On $branch. A release is cut from main."
git diff --quiet && git diff --cached --quiet || die "Working tree is dirty."

git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || die "HEAD is not origin/main. Push (or pull) first - CI tags the commit you push."

if git rev-parse --verify --quiet "refs/tags/v$VERSION" >/dev/null; then
  die "Tag v$VERSION already exists."
fi

current="$(node -p "require('./panel/package.json').version")"
log "Releasing $current -> $VERSION ($(git rev-parse --short HEAD))"

# release.yml refuses a tag that disagrees with the package, because the panel reports the
# package version whenever it is not running from a stamped image.
run npm --prefix panel version "$VERSION" --no-git-tag-version --allow-same-version
run git add panel/package.json panel/package-lock.json
run git commit -m "Release $VERSION"
run git tag -a "v$VERSION" -m "$VERSION"

log "Pushing the commit and the tag"
run git push origin main
run git push origin "v$VERSION"

if [ "$DRY" = 0 ]; then
  cat <<EOF

 Watch it: gh run watch --exit-status \$(gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId')

 When it is green:
   - the release is at https://github.com/\$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$VERSION
   - the first release of a package on GHCR is PRIVATE. Make ghcr.io/<owner>/wpl7/panel,
     .../wordpress and .../sftpgo public, or no box can pull them. Check from a logged-out client:
       docker logout ghcr.io && docker manifest inspect ghcr.io/<owner>/wpl7/panel:$VERSION

EOF
  case "$VERSION" in
    *-*) cat <<EOF
 $VERSION is published as a pre-release, which install.sh and panels on stable skip.
 If users should get it anyway:  gh release edit v$VERSION --prerelease=false --latest

EOF
    ;;
  esac
fi
