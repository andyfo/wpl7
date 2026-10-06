#!/usr/bin/env bash
# One command for the on-box edit loop: test what you just changed, rebuild only what it
# touches, and make sure the panel comes back - restoring the previous image if it does not.
#
#   ./provision/build.sh              # install deps if needed, typecheck, test, rebuild, verify
#   ./provision/build.sh --quick      # skip typecheck+tests (you just ran them)
#   ./provision/build.sh --stack      # rebuild every service, not just the panel
#   ./provision/build.sh --images     # also rebuild the wpl7-wordpress:php* site images
#   ./provision/build.sh --full       # hand the whole thing to provision/setup.sh
#   ./provision/build.sh --dry-run    # print the plan, change nothing
#
# This is the uncommitted-work counterpart of provision/deploy.sh: `deploy.sh` ships a
# revision that is already on origin/main, `build.sh` builds whatever is on this disk right
# now. Run it as the user that owns the checkout (`wp` after dev-access.sh).
# @docs reference/installer-and-scripts
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env"
PANEL_DIR="$REPO_DIR/panel"
. "$REPO_DIR/provision/lib.sh"
# A local build is whatever is on disk, committed or not - so it is never a version number,
# and update.sh refuses to overwrite it without --force. Building at all puts the install
# into source mode: leaving WPL7_SOURCE=image while a hand-built panel is running would have
# the next `compose up` silently pull the release back over it.
wpl7_stamp "$REPO_DIR" dev
export WPL7_COMPOSE_BUILD=1
PANEL_IMAGE="wpl7-panel:$WPL7_VERSION"
HEALTH_TIMEOUT="${BUILD_HEALTH_TIMEOUT:-300}"

QUICK=0 WANT_STACK=0 WANT_IMAGES=0 FULL=0 DRY=0
for arg in "$@"; do
  case "$arg" in
    --quick|--skip-tests) QUICK=1 ;;
    --stack) WANT_STACK=1 ;;
    --images) WANT_IMAGES=1 ;;
    --full) FULL=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; echo "Try: $0 --help" >&2; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\n\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "Missing $ENV_FILE - this server has never been provisioned (provision/setup.sh)."
docker info >/dev/null 2>&1 \
  || die "cannot reach the Docker daemon as $(id -un) - add the user to the 'docker' group (provision/dev-access.sh)."
cd "$REPO_DIR"

# Running as root in a checkout someone else owns is the documented footgun: git writes
# root-owned files the owner can then no longer edit. setup.sh repairs it, nothing else does.
if [ "$(id -u)" = 0 ]; then
  REPO_OWNER="$(stat -c '%U' "$REPO_DIR" 2>/dev/null || echo root)"
  if [ "$REPO_OWNER" != root ]; then
    warn "Running as root, but $REPO_DIR belongs to '$REPO_OWNER' - this will leave root-owned files that '$REPO_OWNER' cannot edit."
    warn "Prefer:  sudo -u $REPO_OWNER $0 $*"
  fi
fi

# ---------------------------------------------------------------- what changed
# Everything that differs from HEAD, committed-but-unpushed work included, so a rebuild is
# not skipped just because the edit is already committed locally.
CHANGED="$(
  {
    git status --porcelain --untracked-files=all | sed 's/^...//'
    git diff --name-only "@{upstream}" 2>/dev/null || true
  } | sort -u
)"

need_full=$FULL need_stack=$WANT_STACK need_panel=0 need_images=$WANT_IMAGES
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    provision/*)                need_full=1 ;;
    deploy/wordpress-image/*)   need_images=1; need_panel=1 ;;
    deploy/docker-compose*.yml) need_stack=1 ;;
    # The panel image carries deploy/ + provision/ as the bundle pushed to worker servers.
    deploy/*)                   need_panel=1 ;;
    panel/*)                    need_panel=1 ;;
  esac
done <<<"$CHANGED"
# Nothing detected (a clean tree, or edits only in docs) still rebuilds the panel by hand
# request: --stack/--images/--full were explicit, a bare run means "apply my work".
if [ "$need_full$need_stack$need_panel$need_images" = "0000" ]; then need_panel=1; fi

TOUCHED_PANEL_CODE=0
case "$CHANGED" in *panel/*) TOUCHED_PANEL_CODE=1 ;; esac

plan=()
if [ "$QUICK" = 0 ] && [ "$TOUCHED_PANEL_CODE" = 1 ]; then plan+=("npm run typecheck && npm test"); fi
if [ "$need_full" = 1 ]; then
  plan+=("provision/setup.sh (full: apt, ufw, images, whole stack)")
else
  if [ "$need_images" = 1 ]; then plan+=("rebuild wpl7-wordpress base images"); fi
  if [ "$need_stack" = 1 ]; then plan+=("compose up -d --build (whole stack)")
  elif [ "$need_panel" = 1 ]; then plan+=("compose up -d --build panel"); fi
fi

log "Building the working tree"
echo "  changed: $(printf '%s\n' "$CHANGED" | grep -c . || true) file(s) vs HEAD/upstream"
for p in "${plan[@]}"; do echo "  plan:    $p"; done
if [ "$DRY" = 1 ]; then log "--dry-run: stopping before any change."; exit 0; fi

# ---------------------------------------------------------------- tests
if [ "$QUICK" = 0 ] && [ "$TOUCHED_PANEL_CODE" = 1 ]; then
  # npm ci only when the lockfile moved ahead of the installed tree - it is slow, and the
  # common edit does not touch dependencies at all.
  if [ ! -d "$PANEL_DIR/node_modules" ] \
     || [ "$PANEL_DIR/package-lock.json" -nt "$PANEL_DIR/node_modules/.package-lock.json" ]; then
    log "Installing panel dependencies (lockfile moved)"
    (cd "$PANEL_DIR" && npm ci)
  fi
  log "Typecheck"
  (cd "$PANEL_DIR" && npm run typecheck) || die "Typecheck failed - nothing was rebuilt, the panel is still running the old code."
  log "Tests"
  (cd "$PANEL_DIR" && npm test) || die "Tests failed - nothing was rebuilt, the panel is still running the old code."
fi

# ---------------------------------------------------------------- build
# Keep the image that is serving right now, so a build that compiles but will not start has
# something to fall back to. deploy.sh rolls back by commit; here there is no pushed commit
# to return to, so the last good image is the fallback.
#
# By the RUNNING container's image id, the way update.sh does it - not by $PANEL_IMAGE, which
# is `wpl7-panel:dev`, the tag this build is about to write. A box deployed from a commit runs
# `wpl7-panel:<package>-source` and one on a release runs a registry image, so on a first
# local build that tag does not exist at all and there would be no rollback; if an older one
# is lying around, it is some unrelated image from a previous session. An id does not move.
ROLLBACK_TAG=""
if [ "$need_full" = 0 ]; then
  RUNNING_PANEL_ID="$(docker inspect --format '{{.Image}}' wpl7-panel 2>/dev/null || true)"
  if [ -n "$RUNNING_PANEL_ID" ]; then
    docker tag "$RUNNING_PANEL_ID" wpl7-panel:rollback
    ROLLBACK_TAG=wpl7-panel:rollback
  fi
fi

if [ "$(wpl7_source_mode "$ENV_FILE")" != build ] || [ "$(wpl7_env_get "$ENV_FILE" WPL7_VERSION)" != "$WPL7_VERSION" ]; then
  log "Switching this install to source mode (WPL7_SOURCE=build, WPL7_VERSION=$WPL7_VERSION)"
  echo "  provision/update.sh --force puts it back on a release."
  wpl7_env_set "$ENV_FILE" WPL7_SOURCE build
  wpl7_env_set "$ENV_FILE" WPL7_VERSION "$WPL7_VERSION"
fi

rebuild() {
  if [ "$need_full" = 1 ]; then
    log "Running provision/setup.sh"
    if [ "$(id -u)" = 0 ]; then "$REPO_DIR/provision/setup.sh" || return 1
    else sudo -n "$REPO_DIR/provision/setup.sh" || return 1; fi
    return 0
  fi
  if [ "$need_images" = 1 ]; then
    log "Rebuilding wpl7-wordpress base images"
    local versions
    versions="$(grep -m1 '^WP_PHP_VERSIONS=' "$ENV_FILE" | cut -d= -f2- || true)"
    versions="${versions:-8.2,8.3,8.4,8.5}"
    for v in ${versions//,/ }; do
      docker build --build-arg "PHP_TAG=php$v" -t "wpl7-wordpress:php$v" "$DEPLOY_DIR/wordpress-image" || return 1
    done
  fi
  if [ "$need_stack" = 1 ]; then
    log "Rebuilding the whole stack"
    "$REPO_DIR/provision/compose.sh" up -d --build || return 1
  elif [ "$need_panel" = 1 ]; then
    log "Rebuilding the panel"
    "$REPO_DIR/provision/compose.sh" up -d --build panel || return 1
  fi
  return 0
}

# Worker servers run the stack without a panel container - nothing to health-check there.
panel_expected() { ! grep -q '^SERVER_ROLE=worker' "$ENV_FILE"; }

wait_healthy() {
  local name=$1 deadline=$((SECONDS + HEALTH_TIMEOUT)) state health
  log "Waiting for $name to report healthy (up to ${HEALTH_TIMEOUT}s)"
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo none)"
    case "$state/$health" in
      running/healthy|running/none) echo "  $name: $state/$health"; return 0 ;;
      exited/*|dead/*) echo "  $name: $state" >&2; return 1 ;;
    esac
    sleep 3
  done
  echo "  $name: still $state/$health after ${HEALTH_TIMEOUT}s" >&2
  return 1
}

ok=1
if ! rebuild; then ok=0; warn "Build failed."; fi
if [ "$ok" = 1 ] && panel_expected && ! wait_healthy wpl7-panel; then ok=0; warn "wpl7-panel did not come back healthy."; fi

if [ "$ok" = 0 ]; then
  docker logs --tail 60 wpl7-panel 2>&1 | sed 's/^/  | /' || true
  if [ -n "$ROLLBACK_TAG" ]; then
    log "Restoring the previous panel image"
    docker tag "$ROLLBACK_TAG" "$PANEL_IMAGE"
    if "$REPO_DIR/provision/compose.sh" up -d --no-build --force-recreate panel >/dev/null 2>&1 \
       && { ! panel_expected || wait_healthy wpl7-panel; }; then
      die "Build failed - the panel is back on the previous image. Your edits are untouched on disk; fix and re-run."
    fi
    die "Build failed AND the previous image did not come back healthy - the PANEL IS DOWN. Check: docker logs wpl7-panel"
  fi
  die "Build failed. Your edits are untouched on disk."
fi

docker image rm wpl7-panel:rollback >/dev/null 2>&1 || true
log "Built and running. Commit and push when you are happy: git add -A && git commit && git push"
