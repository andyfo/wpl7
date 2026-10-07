#!/usr/bin/env bash
# Install WPL7 on a blank Ubuntu 26.04 server (x86-64).
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
# @docs get-started/installation, get-started/quick-start, panel/updating, reference/installer-and-scripts

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
# run, with the command's output dropped - but not the line a dry run prints in its place.
runq() { if [ "$DRY" = 1 ]; then run "$@"; else "$@" >/dev/null; fi; }

# The released panel and site images, and the third-party DKIM signer's, are built for x86-64
# only. Anywhere else they exit at once with "exec format error", and the install would still
# end with "WPL7 is up".
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ;;
  aarch64|arm*) die "This is an ARM server ($ARCH). WPL7 runs on x86-64 (amd64) servers only: its images are not built for ARM." ;;
  *) die "This server's processor is $ARCH. WPL7 runs on x86-64 (amd64) servers only." ;;
esac

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
# installing anything. curl and tar are on every Ubuntu server image; jq is not. A dry run
# installs nothing, so without jq it finds the release but leaves the manifest unread.
if ! command -v jq >/dev/null; then
  log "Installing jq"
  run env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  runq env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq
fi

# ------------------------------------------------------------ resolve

log "Finding the release"
# The links github.com gives a release and its files, not the GitHub API: no JSON to read
# before the manifest, and no API rate limit.
RELEASES="https://github.com/$REPO/releases"
OFFLINE="Could not reach github.com. Check this machine's outbound network."

if [ "$CHANNEL" = edge ]; then
  RELEASE_TAG=edge
elif [ -n "$VERSION" ]; then
  RELEASE_TAG="v${VERSION#v}"
else
  # This link redirects to the latest release's page, whose address ends in its tag.
  LATEST="$(curl -sS -o /dev/null -w '%{redirect_url}' "$RELEASES/latest")" || die "$OFFLINE"
  case "$LATEST" in
    */releases/tag/?*) RELEASE_TAG="${LATEST##*/releases/tag/}" ;;
    *) die "$REPO has no published release." ;;
  esac
fi

if [ -e "$DIR/deploy/.env" ]; then
  die "$DIR is already an install. Update it instead:  $DIR/provision/update.sh --to=${RELEASE_TAG#v}"
fi

# The manifest, then the HTTP status it ended with, on a line of its own.
ANSWER="$(curl -sSL -w '\n%{http_code}' "$RELEASES/download/$RELEASE_TAG/manifest.json")" || die "$OFFLINE"
case "${ANSWER##*$'\n'}" in
  200) MANIFEST="${ANSWER%$'\n'*}" ;;
  404)
    [ "$(curl -sS -o /dev/null -w '%{http_code}' "$RELEASES/tag/$RELEASE_TAG")" = 200 ] \
      || die "No release tagged $RELEASE_TAG in $REPO."
    die "Release $RELEASE_TAG has no manifest.json - it was not published by release.yml." ;;
  *) die "github.com answered HTTP ${ANSWER##*$'\n'} for the manifest of $RELEASE_TAG. Try again later." ;;
esac

BUNDLE_URL=""
if [ "$DRY" = 1 ] && ! command -v jq >/dev/null; then
  echo "   $REPO $RELEASE_TAG ($CHANNEL). jq is not installed, so a dry run does not read its manifest."
else
  VERSION="$(printf '%s' "$MANIFEST" | jq -r '.version')"
  PANEL_IMAGE="$(printf '%s' "$MANIFEST" | jq -r '.images.panel')"
  # The tag images were published under: the version for a release, `edge` for the rolling
  # build, which calls itself 0.x.y-edge.<commit>.
  IMAGE_TAG="${PANEL_IMAGE##*:}"
  PANEL_REPO="${PANEL_IMAGE%:*}"
  WORDPRESS_REPO="$(printf '%s' "$MANIFEST" | jq -r '.images.wordpress | to_entries[0].value // empty')"
  WORDPRESS_REPO="${WORDPRESS_REPO%:*}"
  # release.yml and deploy.yml name the bundle after the version in this manifest.
  BUNDLE_URL="$RELEASES/download/$RELEASE_TAG/wpl7-$VERSION-bundle.tar.gz"
  echo "   $REPO $RELEASE_TAG -> $VERSION ($CHANNEL) · $PANEL_IMAGE"
fi

# -------------------------------------------------------------- unpack

log "Unpacking the bundle into $DIR"
run mkdir -p "$DIR"
if [ "$DRY" = 0 ]; then
  curl -fsSL "$BUNDLE_URL" | tar -xz -C "$DIR" || die "Could not download and unpack $BUNDLE_URL."
  [ -x "$DIR/provision/setup.sh" ] || die "The bundle has no provision/setup.sh."
elif [ -n "$BUNDLE_URL" ]; then
  [ "$(curl -sSIL -o /dev/null -w '%{http_code}' "$BUNDLE_URL")" = 200 ] \
    || die "Release $RELEASE_TAG has no wpl7-$VERSION-bundle.tar.gz - it was not published by release.yml."
  echo "   would download: $BUNDLE_URL"
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
