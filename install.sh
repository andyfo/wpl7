#!/usr/bin/env bash
# Install WPL7 on a blank Ubuntu 26.04 server.
#
#   curl -fsSL https://github.com/andyfo/wpl7/releases/latest/download/install.sh | bash -s -- \
#     --panel-domain=panel.example.com --dev-domain=dev.example.com --acme-email=you@example.com
#
# Downloads the release bundle - a few kilobytes of compose files and shell scripts - and
# hands over to provision/setup.sh, which pulls the panel and site images and starts the
# stack. Nothing is compiled here: no git, no Node, no credential on the box.
#
#   --version=X.Y.Z   pin a version instead of taking the latest release
#   --channel=edge    follow the rolling build of main (maintainers; see docs/updating.md)
#   --dir=PATH        where to install (default /opt/wpl7)
#   --dry-run         print what it would do, change nothing
#
# Everything else is passed straight to setup.sh (--role=worker, --dns-provider=, --ssh-port=,
# --no-firewall, …).
set -euo pipefail

REPO="${WPL7_REPO:-andyfo/wpl7}"
DIR="/opt/wpl7"
VERSION="" CHANNEL="stable" DRY=0 ASKED_NON_INTERACTIVE=0
SETUP_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#*=}" ;;
    --channel=*) CHANNEL="${arg#*=}" ;;
    --dir=*) DIR="${arg#*=}" ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    --non-interactive) ASKED_NON_INTERACTIVE=1; SETUP_ARGS+=("$arg") ;;
    *) SETUP_ARGS+=("$arg") ;;
  esac
done

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

# `curl … | bash` is the documented command, and it hands setup.sh the exhausted pipe as its
# stdin. setup.sh would then reach its admin-password prompt, have `read` return EOF, and
# take the whole install down under `set -e` - before writing .env or starting anything.
# There is nobody to prompt anyway: every answer the documented command has is a flag.
if [ ! -t 0 ] && [ "$ASKED_NON_INTERACTIVE" = 0 ]; then
  SETUP_ARGS+=(--non-interactive)
  log "stdin is not a terminal, so setup.sh runs non-interactively"
  echo "   Every answer has to be a flag, and the panel admin password is generated - the end"
  echo "   of the run says where to read it. Run 'bash install.sh …' from a terminal to be asked."
fi

[ "$(id -u)" = 0 ] || die "Run as root (sudo bash install.sh …)."
case "$CHANNEL" in stable|edge) ;; *) die "--channel must be stable or edge" ;; esac

for tool in curl tar; do
  command -v "$tool" >/dev/null || die "$tool is required (apt-get install -y $tool)."
done
# Reading the release manifest needs jq, and that happens before setup.sh gets as far as
# installing anything. curl and tar are on every Ubuntu server image; jq is not.
if ! command -v jq >/dev/null; then
  log "Installing jq"
  run env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq >/dev/null
fi

# ------------------------------------------------------------ resolve

log "Finding the release"
gh_get() { curl -fsSL -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$@"; }

if [ "$CHANNEL" = edge ]; then
  RELEASE_TAG=edge
elif [ -n "$VERSION" ]; then
  RELEASE_TAG="v${VERSION#v}"
else
  RELEASE_TAG="$(gh_get "https://api.github.com/repos/$REPO/releases/latest" | jq -r '.tag_name')" \
    || die "Could not reach the GitHub API. Check this machine's outbound network."
fi

RELEASE_JSON="$(gh_get "https://api.github.com/repos/$REPO/releases/tags/$RELEASE_TAG")" \
  || die "No release tagged $RELEASE_TAG in $REPO."
MANIFEST_URL="$(printf '%s' "$RELEASE_JSON" | jq -r '.assets[] | select(.name == "manifest.json") | .url')"
BUNDLE_URL="$(printf '%s' "$RELEASE_JSON" | jq -r '.assets[] | select(.name | endswith("-bundle.tar.gz")) | .url')"
[ -n "$MANIFEST_URL" ] && [ -n "$BUNDLE_URL" ] || die "Release $RELEASE_TAG has no bundle and manifest - it was not published by release.yml."

MANIFEST="$(curl -fsSL -H 'Accept: application/octet-stream' "$MANIFEST_URL")"
VERSION="$(printf '%s' "$MANIFEST" | jq -r '.version')"
PANEL_IMAGE="$(printf '%s' "$MANIFEST" | jq -r '.images.panel')"
# The tag images were published under: the version for a release, `edge` for the rolling
# build, which calls itself 0.x.y-edge.<commit>.
IMAGE_TAG="${PANEL_IMAGE##*:}"
PANEL_REPO="${PANEL_IMAGE%:*}"
WORDPRESS_REPO="$(printf '%s' "$MANIFEST" | jq -r '.images.wordpress | to_entries[0].value // empty')"
WORDPRESS_REPO="${WORDPRESS_REPO%:*}"
echo "   $REPO $RELEASE_TAG -> $VERSION ($CHANNEL) · $PANEL_IMAGE"

# -------------------------------------------------------------- unpack

if [ -e "$DIR/deploy/.env" ]; then
  die "$DIR is already an install. Update it instead:  $DIR/provision/update.sh --to=$VERSION"
fi

log "Unpacking the bundle into $DIR"
run mkdir -p "$DIR"
if [ "$DRY" = 0 ]; then
  curl -fsSL -H 'Accept: application/octet-stream' "$BUNDLE_URL" | tar -xz -C "$DIR"
  [ -x "$DIR/provision/setup.sh" ] || die "The bundle has no provision/setup.sh."
fi

# ------------------------------------------------------- record + provision

# setup.sh will not run image mode without these, and deliberately invents nothing: writing
# them here, from the manifest, is the whole job of this script.
if [ "$DRY" = 0 ]; then
  mkdir -p "$DIR/deploy"
  # setup.sh creates .env from .env.example and applies this file over it: these are the
  # keys that describe the release, and they are the one thing setup.sh cannot derive.
  cat > "$DIR/.wpl7-install" <<EOF
WPL7_SOURCE=image
WPL7_VERSION=$VERSION
WPL7_IMAGE_TAG=$IMAGE_TAG
WPL7_CHANNEL=$CHANNEL
WPL7_PANEL_IMAGE=$PANEL_REPO
WPL7_WORDPRESS_IMAGE=$WORDPRESS_REPO
WPL7_REPO=$REPO
EOF
fi

log "Provisioning"
run "$DIR/provision/setup.sh" "${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}"
