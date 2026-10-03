#!/usr/bin/env bash
# Deploy a pushed revision on this server: fast-forward the checkout, rebuild only what the
# diff actually touched, verify the panel comes back healthy, roll back if it does not.
#
# GitHub Actions runs this over SSH after every push to main (.github/workflows/deploy.yml;
# authorize it with provision/ci-access.sh). By hand:
#
#   ./provision/deploy.sh                # deploy the tip of origin/main
#   ./provision/deploy.sh --ref=<sha>    # deploy that exact commit (must be on the branch)
#   ./provision/deploy.sh --full         # force a whole provision/setup.sh run
#   ./provision/deploy.sh --workers      # afterwards, update every worker server too
#   ./provision/deploy.sh --dry-run      # print the plan, change nothing
#
# Run as the user that OWNS the checkout (`wp` after dev-access.sh, else root): pulling as
# root into a wp-owned checkout leaves files wp can no longer edit.
set -euo pipefail

# Usage needs no repo and no re-exec - answer it before anything else can fail.
case "${1:-}" in -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;; esac

REPO_DIR="${WPL7_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Checking out the new revision rewrites this file while bash is still reading it, which can
# corrupt execution mid-deploy. Re-exec from a throwaway copy, so a deploy always runs the
# script version it started with.
if [ "${DEPLOY_SELF_COPY:-}" != "$0" ]; then
  self="$(mktemp)"
  cp "$REPO_DIR/provision/deploy.sh" "$self"
  export DEPLOY_SELF_COPY="$self" WPL7_REPO_DIR="$REPO_DIR"
  exec bash "$self" "$@"
fi
rm -f -- "$0" 2>/dev/null || true   # the copy unlinks itself; the open fd stays valid

DEPLOY_DIR="$REPO_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env"
. "$REPO_DIR/provision/lib.sh"
BRANCH="${DEPLOY_BRANCH:-main}"
HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-300}"
WORKER_TIMEOUT="${DEPLOY_WORKER_TIMEOUT:-900}"

# Deploy-time settings that belong on the server rather than in the repo or in GitHub's
# secret store - currently just WPL7_API_KEY, the panel API key used to update workers.
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$HOME/.wpl7-deploy.env}"
if [ -f "$DEPLOY_ENV_FILE" ]; then set -a; . "$DEPLOY_ENV_FILE"; set +a; fi

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\n\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

# Invoked as an SSH forced command (ci-access.sh pins command="…/deploy.sh" on the CI key):
# argv is empty and the client's request arrives in $SSH_ORIGINAL_COMMAND. Accept only this
# script's own flags from there - that key must never become a general-purpose shell.
# --branch is deliberately not allowed: a leaked Actions secret cannot deploy another branch.
if [ $# -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  read -ra REQUESTED <<<"$SSH_ORIGINAL_COMMAND" || true
  if [ "${#REQUESTED[@]}" -gt 0 ]; then
    case "${REQUESTED[0]}" in */deploy.sh|deploy.sh) REQUESTED=("${REQUESTED[@]:1}") ;; esac
  fi
  for a in ${REQUESTED[@]+"${REQUESTED[@]}"}; do
    case "$a" in
      --ref=*) [[ "${a#*=}" =~ ^[0-9a-f]{7,40}$ ]] || die "forced command: '$a' is not a commit sha" ;;
      --full|--workers|--dry-run|--no-rollback) ;;
      *) die "forced command: refusing '$a'" ;;
    esac
  done
  set -- ${REQUESTED[@]+"${REQUESTED[@]}"}
fi

REF="" FULL=0 WORKERS=0 DRY=0 ALLOW_DIRTY=0 ROLLBACK=1
for arg in "$@"; do
  case "$arg" in
    --ref=*) REF="${arg#*=}" ;;
    --branch=*) BRANCH="${arg#*=}" ;;
    --full) FULL=1 ;;
    --workers) WORKERS=1 ;;
    --dry-run) DRY=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --no-rollback) ROLLBACK=0 ;;
    -h|--help) sed -n '2,15p' "$REPO_DIR/provision/deploy.sh" | sed 's/^# \?//'; exit 0 ;;
    *) die "Unknown flag: $arg - try: $0 --help" ;;
  esac
done

# ---------------------------------------------------------------- preconditions
[ -f "$ENV_FILE" ] || die "Missing $ENV_FILE - this server has never been provisioned (provision/setup.sh)."
command -v git >/dev/null || die "git not found"
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon as $(id -un) - add the user to the 'docker' group (provision/dev-access.sh)."
cd "$REPO_DIR"

# Running as root in a checkout someone else owns is the documented footgun: git writes
# root-owned files the owner can then no longer edit. setup.sh repairs it, nothing else does.
if [ "$(id -u)" = 0 ]; then
  REPO_OWNER="$(stat -c '%U' "$REPO_DIR" 2>/dev/null || echo root)"
  if [ "$REPO_OWNER" != root ]; then
    warn "Running as root, but $REPO_DIR belongs to '$REPO_OWNER' - this will leave root-owned files that '$REPO_OWNER' cannot edit."
    warn "Prefer:  sudo -u $REPO_OWNER $REPO_DIR/provision/deploy.sh $*"   # $0 is the self-copy
  fi
fi

# deploy.sh moves a checkout and rebuilds from it. A box running the released image updates
# by pulling instead - a different mechanism with a different rollback (the previous image,
# not the previous commit). Rather than split CD in two, this stays the single entry point:
# ci-access.sh pins one forced command with one flag whitelist, and the same workflow step
# works whether the server compiles its panel or pulls it.
if [ "$(wpl7_source_mode "$ENV_FILE")" != build ]; then
  CHANNEL="$(wpl7_env_get "$ENV_FILE" WPL7_CHANNEL)"
  if [ "$CHANNEL" != edge ]; then
    die "This install pulls released images on the ${CHANNEL:-stable} channel, so there is
   nothing for a push to deploy. Apply a release from the panel (Settings -> Updates) or with:
   $REPO_DIR/provision/update.sh --to=<version>"
  fi
  log "Image mode, edge channel: handing over to update.sh"
  [ "$WORKERS" = 0 ] || echo "  (--workers ignored: the new panel updates worker servers itself)"
  UPDATE_ARGS=(--to=edge)
  if [ -n "$REF" ]; then UPDATE_ARGS+=("--expect-sha=$REF"); fi
  if [ "$DRY" = 1 ]; then UPDATE_ARGS+=(--dry-run); fi
  if [ "$ROLLBACK" = 0 ]; then UPDATE_ARGS+=(--no-rollback); fi
  exec "$REPO_DIR/provision/update.sh" "${UPDATE_ARGS[@]}"
fi

# Untracked files are harmless; modified tracked files would be overwritten by the checkout.
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" >&2
  if [ "$ALLOW_DIRTY" = 1 ]; then
    warn "Working tree is dirty; --allow-dirty given - the edits above will be overwritten."
  else
    die "Working tree is dirty - commit and push those server-side edits first (or re-run with --allow-dirty to discard them)."
  fi
fi

# ---------------------------------------------------------------- resolve the target
log "Fetching origin"
git fetch --prune --quiet origin \
  || die "git fetch failed - $(id -un) must be able to pull non-interactively (deploy key in ~/.ssh with no passphrase)."
TARGET="$(git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH^{commit}")" \
  || die "origin/$BRANCH not found - check the remote and the branch name."
if [ -n "$REF" ]; then
  git cat-file -e "$REF^{commit}" 2>/dev/null || die "commit $REF is not in this clone."
  git merge-base --is-ancestor "$REF" "$TARGET" \
    || die "commit $REF is not on origin/$BRANCH - refusing to deploy code that was never merged."
  TARGET="$(git rev-parse --verify "$REF^{commit}")"
fi

BEFORE="$(git rev-parse HEAD)"
if [ "$BEFORE" = "$TARGET" ] && [ "$FULL" = 0 ]; then
  log "Already at $(git log -1 --format='%h %s' "$TARGET")"
  # --workers is a converge operation: keep going so a re-run can still push this revision
  # out to a worker that failed to update last time.
  if [ "$WORKERS" = 0 ]; then echo "  nothing to deploy."; exit 0; fi
fi
if [ "$BEFORE" != "$TARGET" ]; then
  git merge-base --is-ancestor "$BEFORE" "$TARGET" \
    || die "HEAD ($(git rev-parse --short "$BEFORE")) is not an ancestor of $TARGET - this checkout has commits that are not on origin/$BRANCH. Push or drop them first."
fi

# ---------------------------------------------------------------- plan
CHANGED="$(git diff --name-only "$BEFORE" "$TARGET")"
need_full=$FULL need_stack=0 need_panel=0 need_images=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    provision/*)                need_full=1 ;;
    deploy/wordpress-image/*)   need_images=1; need_panel=1 ;;
    deploy/docker-compose*.yml) need_stack=1 ;;
    # The panel image carries deploy/ + provision/ as the bundle it pushes to worker servers,
    # so anything under deploy/ has to be rebuilt into it, not just panel code.
    deploy/*)                   need_panel=1 ;;
    panel/*)                    need_panel=1 ;;
  esac
done <<<"$CHANGED"

plan=()
if [ "$need_full" = 1 ]; then
  plan+=("provision/setup.sh (full: apt, ufw, images, whole stack)")
else
  if [ "$need_images" = 1 ]; then plan+=("rebuild wpl7-wordpress base images"); fi
  if [ "$need_stack" = 1 ]; then plan+=("compose up -d --build (whole stack)")
  elif [ "$need_panel" = 1 ]; then plan+=("compose up -d --build panel"); fi
fi
if [ "$WORKERS" = 1 ]; then plan+=("update worker servers through the panel API"); fi
if [ "${#plan[@]}" -eq 0 ]; then plan+=("nothing to rebuild (docs/workflow files only)"); fi

log "Deploying $(git log -1 --format='%h %s' "$TARGET")"
echo "  from:    $(git rev-parse --short "$BEFORE")  ($(printf '%s\n' "$CHANGED" | grep -c . || true) file(s) changed)"
for p in "${plan[@]}"; do echo "  plan:    $p"; done

if [ "$DRY" = 1 ]; then log "--dry-run: stopping before any change."; exit 0; fi

# ---------------------------------------------------------------- apply
# Make the checkout be exactly $rev, forwards or backwards. Not `merge --ff-only`: rolling
# back means merging an ancestor, which reports "already up to date" and moves nothing - the
# failed revision would stay deployed. --force is safe here because the dirty-tree gate above
# has already decided local edits are either absent or explicitly discardable.
checkout() {
  git checkout --quiet --force -B "$BRANCH" "$1"
}

apply() {
  # After checkout(), never before: a rollback rebuilds an older commit and the image must
  # say so, or the sidebar and the update checker report the revision that failed.
  wpl7_stamp "$REPO_DIR" source
  wpl7_env_set "$ENV_FILE" WPL7_VERSION "$WPL7_VERSION"
  if [ "$need_full" = 1 ]; then
    log "Running provision/setup.sh"
    if [ "$(id -u)" = 0 ]; then
      "$REPO_DIR/provision/setup.sh" || return 1
    else
      sudo -n "$REPO_DIR/provision/setup.sh" || return 1   # dev-access.sh grants NOPASSWD sudo
    fi
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

# Worker servers run the stack without a panel container, so there is nothing to health-check.
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

checkout "$TARGET"

# .env is not in git; a release that adds a key needs a human to supply the value.
missing=""
while IFS= read -r key; do
  grep -q "^$key=" "$ENV_FILE" || missing="$missing $key"
done < <(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$DEPLOY_DIR/.env.example")
if [ -n "$missing" ]; then
  warn "deploy/.env.example has keys this install's .env does not:$missing"
  warn "Compose defaults apply until you add them by hand - the deploy will not invent values."
fi

ok=1
if ! apply; then ok=0; warn "Build/restart failed."; fi
if [ "$ok" = 1 ] && panel_expected && ! wait_healthy wpl7-panel; then ok=0; warn "wpl7-panel did not come back healthy."; fi

if [ "$ok" = 0 ]; then
  docker logs --tail 60 wpl7-panel 2>&1 | sed 's/^/  | /' || true
  if [ "$ROLLBACK" = 1 ] && [ "$BEFORE" != "$TARGET" ]; then
    log "Rolling back to $(git rev-parse --short "$BEFORE")"
    checkout "$BEFORE"
    if apply && { ! panel_expected || wait_healthy wpl7-panel; }; then
      die "Deploy of $(git rev-parse --short "$TARGET") failed - rolled back to $(git rev-parse --short "$BEFORE"), the panel is healthy again."
    fi
    die "Deploy of $(git rev-parse --short "$TARGET") failed AND the rollback did not come back healthy - the PANEL IS DOWN. Check: docker logs wpl7-panel"
  fi
  die "Deploy of $(git rev-parse --short "$TARGET") failed (rollback disabled)."
fi

# ---------------------------------------------------------------- worker servers
worker_failures=0
if [ "$WORKERS" = 1 ]; then
  API_KEY="${WPL7_API_KEY:-}"
  PANEL_HOST="$(grep -m1 '^PANEL_DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
  api() {
    local method=$1 path=$2 body=${3:-}
    # --resolve: talk to Traefik on this host directly, so worker updates do not depend on
    # the network hairpinning the panel's own public IP back to us.
    local args=(-fsS -X "$method" -H "Authorization: Bearer $API_KEY" --resolve "$PANEL_HOST:443:127.0.0.1")
    if [ -n "$body" ]; then args+=(-H 'content-type: application/json' -d "$body"); fi
    curl "${args[@]}" "https://$PANEL_HOST/api$path"
  }
  if [ -z "$API_KEY" ]; then
    echo "  no WPL7_API_KEY in $DEPLOY_ENV_FILE - skipping worker updates"
  elif ! command -v jq >/dev/null; then
    warn "--workers: jq not installed - skipping worker updates."
  elif [ -z "$PANEL_HOST" ]; then
    warn "--workers: PANEL_DOMAIN is empty in .env - skipping worker updates."
  else
    log "Updating worker servers"
    if ! ids="$(api GET /servers | jq -r '.items[] | select(.kind == "ssh") | .id')"; then
      warn "--workers: the panel API did not answer - skipping worker updates."
      ids=""
      worker_failures=1
    fi
    if [ -z "$ids" ] && [ "$worker_failures" = 0 ]; then echo "  no worker servers registered"; fi
    for id in $ids; do
      job="$(api POST "/servers/$id/update" '{}' | jq -r '.job.id // empty')"
      if [ -z "$job" ]; then
        warn "  server $id: the panel refused the update request"
        worker_failures=$((worker_failures + 1))
        continue
      fi
      echo "  server $id -> job $job"
      deadline=$((SECONDS + WORKER_TIMEOUT)) status=queued
      while [ "$SECONDS" -lt "$deadline" ]; do
        # A transient API error must not abort the run - keep polling until the deadline.
        status="$(api GET "/jobs/$job" 2>/dev/null | jq -r '.job.status // "unknown"' || echo unknown)"
        case "$status" in succeeded|failed|canceled) break ;; esac
        sleep 5
      done
      if [ "$status" != succeeded ]; then
        warn "  server $id: update $status"
        api GET "/jobs/$job?logAfter=0" | jq -r '.logs[]?.line // empty' | tail -20 | sed 's/^/    | /' || true
        worker_failures=$((worker_failures + 1))
      else
        echo "  server $id: updated"
      fi
    done
  fi
fi

log "Deployed $(git log -1 --format='%h %s' HEAD)"
if [ "$worker_failures" -gt 0 ]; then
  die "$worker_failures worker server(s) failed to update - this server is fine and running the new code."
fi
