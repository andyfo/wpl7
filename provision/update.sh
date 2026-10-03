#!/usr/bin/env bash
# Update this install to a released version: pull, swap, health-check, roll back.
#
#   ./provision/update.sh --to=0.3.0       # a release
#   ./provision/update.sh --to=edge        # the rolling build of main
#   ./provision/update.sh --to=0.3.0 --dry-run
#
# Runs on the HOST, as root (it re-execs itself under `sudo -n` when it is not). The panel
# starts it through systemd rather than calling it directly, because the panel is one of the
# containers being replaced - see docs/updating.md. State and log:
#
#   /srv/panel/update/state.json     what is happening, and what happened last time
#   /srv/panel/update/current.log    everything this run printed
#
# The rollback is the previous image plus the previous bundle plus the panel database as it
# was before the new panel ran its migrations. There are no down-migrations, ever: a failed
# update goes back to the whole previous state, not partway.
set -euo pipefail

case "${1:-}" in -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;; esac

REPO_DIR="${WPL7_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Root, for all of it. Everything under /srv/panel - the state file the panel reads, the log
# it streams, the database snapshot taken before migrations run - is root-owned and 0700
# (setup.sh), and the panel launches this as the checkout's OWNER, which on an install made
# with dev-access.sh is not root. Escalating around the one call to setup.sh is not enough:
# the very first mkdir already fails. setup.sh gives the checkout back to its owner at the
# end, and restore_repo_owner() below covers the paths that never reach it.
if [ "$(id -u)" != 0 ]; then
  sudo -n true 2>/dev/null || {
    echo "update.sh has to run as root and $(id -un) has no passwordless sudo." >&2
    echo "Run it with sudo, or grant it: provision/dev-access.sh does." >&2
    exit 1
  }
  keep=(WPL7_REPO_DIR="$REPO_DIR")
  for var in SRV_ROOT WPL7_UPDATE_HEALTH_TIMEOUT WPL7_HEALTH_TIMEOUT; do
    [ -n "${!var:-}" ] && keep+=("$var=${!var}")
  done
  exec sudo -n env "${keep[@]}" bash "$REPO_DIR/provision/update.sh" "$@"
fi

# The bundle - this file included - is replaced part-way through. Re-exec from a throwaway
# copy so an update always runs the version of the script it started with.
if [ "${UPDATE_SELF_COPY:-}" != "$0" ]; then
  self="$(mktemp)"
  cp "$REPO_DIR/provision/update.sh" "$self"
  export UPDATE_SELF_COPY="$self" WPL7_REPO_DIR="$REPO_DIR"
  exec bash "$self" "$@"
fi
rm -f -- "$0" 2>/dev/null || true   # the copy unlinks itself; the open fd stays valid

DEPLOY_DIR="$REPO_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env"
SRV_ROOT="${SRV_ROOT:-/srv}"
. "$REPO_DIR/provision/lib.sh"

TO="" CHANNEL_ARG="" ROLLBACK=1 DRY=0 FORCE=0 EXPECT_SHA=""
for arg in "$@"; do
  case "$arg" in
    --to=*) TO="${arg#*=}" ;;
    --channel=*) CHANNEL_ARG="${arg#*=}" ;;
    # The commit CD believed was current when it asked. Reported, not enforced: a second
    # merge landing first is a race, not a failure, and the older run going red for it
    # would be noise.
    --expect-sha=*) EXPECT_SHA="${arg#*=}" ;;
    --no-rollback) ROLLBACK=0 ;;
    --dry-run) DRY=1 ;;
    # Overwrite a hand-built panel, and switch an install back out of source mode.
    --force) FORCE=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done
[ -n "$TO" ] || { echo "--to=<version|edge> is required. Try: $0 --help" >&2; exit 1; }

UPDATE_DIR="$SRV_ROOT/panel/update"
STATE_FILE="$UPDATE_DIR/state.json"
LOG_FILE="$UPDATE_DIR/current.log"
PREVIOUS_DIR="$REPO_DIR/.previous"
HEALTH_TIMEOUT="${WPL7_UPDATE_HEALTH_TIMEOUT:-300}"
REPO_SLUG="$(wpl7_env_get "$ENV_FILE" WPL7_REPO)"
REPO_SLUG="${REPO_SLUG:-andyfo/wpl7}"
GH_TOKEN_VALUE="$(wpl7_env_get "$ENV_FILE" WPL7_GITHUB_TOKEN)"

mkdir -p "$UPDATE_DIR"
# Everything below is tee'd, so the panel can show the same text the operator would see.
if [ "$DRY" = 0 ]; then exec > >(tee "$LOG_FILE") 2>&1; fi

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

# This script is root and writes into a checkout that may belong to somebody else (the `wp`
# user dev-access.sh creates). Root-owned files there are ones that user can no longer edit.
# setup.sh does the same repair at the end of every run; this is for the paths that fail
# before reaching it.
restore_repo_owner() {
  local owner group
  owner="$(stat -c '%U' "$REPO_DIR" 2>/dev/null || echo root)"
  [ "$owner" = root ] && return 0
  group="$(stat -c '%G' "$REPO_DIR" 2>/dev/null || echo "$owner")"
  chown -R "$owner:$group" "$REPO_DIR" 2>/dev/null || true
}

UPDATE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
FROM="$(wpl7_env_get "$ENV_FILE" WPL7_VERSION)"
FROM_CHANNEL="$(wpl7_env_get "$ENV_FILE" WPL7_CHANNEL)"
FROM_SOURCE="$(wpl7_source_mode "$ENV_FILE")"
PHASE=fetching WARNINGS='[]' ERROR=null ROLLED_BACK=null FINISHED=null

# state.json is the panel's only window into a process that outlives its container. Every
# field is always present (null when it does not apply) so the reader never branches on
# shape, and it is written at every phase change rather than only at the end - a panel that
# is restarted mid-update has to be able to say what is going on.
write_state() {
  [ "$DRY" = 1 ] && return 0
  local tmp="$STATE_FILE.tmp"
  jq -n \
    --arg id "$UPDATE_ID" --arg from "$FROM" --arg to "$TO" --arg channel "${CHANNEL_ARG:-$FROM_CHANNEL}" \
    --arg phase "$PHASE" --arg startedAt "$STARTED_AT" \
    --argjson rolledBack "$ROLLED_BACK" --argjson warnings "$WARNINGS" \
    --argjson error "$ERROR" --argjson finishedAt "$FINISHED" \
    --argjson logTail "$(log_tail_json)" --argjson pid "$$" \
    '{ id: $id, from: $from, to: $to, channel: $channel, phase: $phase,
       rolledBack: $rolledBack, startedAt: $startedAt, finishedAt: $finishedAt,
       warnings: $warnings, error: $error, logTail: $logTail, pid: $pid }' > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

log_tail_json() {
  if [ "$PHASE" = failed ] && [ -n "${LOG_TAIL_TEXT:-}" ]; then
    printf '%s' "$LOG_TAIL_TEXT" | jq -R -s 'split("\n")'
  else
    echo '[]'
  fi
}

add_warning() { WARNINGS="$(printf '%s' "$WARNINGS" | jq --arg w "$1" '. + [$w]')"; warn "$1"; }

fail() {
  ERROR="$(printf '%s' "$1" | jq -R -s .)"
  LOG_TAIL_TEXT="$(docker logs --tail 60 wpl7-panel 2>&1 || true)"
  PHASE=failed
  FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ | jq -R .)"
  write_state
  printf '\n\033[1;31mxx %s\033[0m\n' "$1" >&2
  exit 1
}

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ------------------------------------------------------------------- 1. lock

# Two locks, deliberately. This one survives a reboot and is what the panel reads; the
# systemd unit name is the other, and is what stops a second click from ever getting here.
if [ "$DRY" = 0 ] && [ -f "$STATE_FILE" ]; then
  prev_phase="$(jq -r '.phase // ""' "$STATE_FILE" 2>/dev/null || true)"
  prev_pid="$(jq -r '.pid // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
  case "$prev_phase" in
    switched|failed|'') ;;
    *) if [ "$prev_pid" -gt 0 ] && kill -0 "$prev_pid" 2>/dev/null; then
         echo "An update is already running (pid $prev_pid, phase $prev_phase)." >&2
         exit 1
       fi
       warn "Ignoring a stale $prev_phase state from pid $prev_pid - that process is gone." ;;
  esac
fi
write_state

# --------------------------------------------------------------- 2. resolve

log "Resolving $TO"

# `accept` differs per call: the releases API answers JSON, an asset answers its bytes only
# when asked for octet-stream. The token is optional and only needed while the repository is
# private - and it is what makes a conditional request free of rate limit, which the panel's
# own checker relies on (services/updates.ts).
gh_get() {
  local url=$1 accept=$2
  local args=(-fsSL -H "Accept: $accept" -H 'X-GitHub-Api-Version: 2022-11-28')
  if [ -n "$GH_TOKEN_VALUE" ]; then args+=(-H "Authorization: Bearer $GH_TOKEN_VALUE"); fi
  curl "${args[@]}" "$url"
}

case "$TO" in
  edge) RELEASE_TAG=edge ;;
  v*)   RELEASE_TAG="$TO"; TO="${TO#v}" ;;
  *)    RELEASE_TAG="v$TO" ;;
esac

RELEASE_JSON="$(gh_get "https://api.github.com/repos/$REPO_SLUG/releases/tags/$RELEASE_TAG" 'application/vnd.github+json')" \
  || fail "No release tagged $RELEASE_TAG in $REPO_SLUG (or GitHub is unreachable)."
MANIFEST_URL="$(printf '%s' "$RELEASE_JSON" | jq -r '.assets[] | select(.name == "manifest.json") | .url')"
[ -n "$MANIFEST_URL" ] || fail "Release $RELEASE_TAG has no manifest.json asset - it was not published by release.yml."

# The asset API URL, not browser_download_url: this one also works for a private repository.
MANIFEST="$(gh_get "$MANIFEST_URL" 'application/octet-stream')" \
  || fail "Could not download the manifest for $RELEASE_TAG."

TO="$(printf '%s' "$MANIFEST" | jq -r '.version')"
CHANNEL="$(printf '%s' "$MANIFEST" | jq -r '.channel')"
PANEL_IMAGE="$(printf '%s' "$MANIFEST" | jq -r '.images.panel')"
# The tag the release was published under. For a release that is the version; for edge it is
# the moving tag `edge`, while the version reads 0.3.0-edge.<short>. Compose pulls the tag,
# everything else compares the version, and .env records both.
IMAGE_TAG="${PANEL_IMAGE##*:}"
PANEL_REPO="${PANEL_IMAGE%:*}"
# Recorded too, so setup.sh pulls the site images from wherever this release published them
# rather than from the upstream default - which is the whole point of a fork override.
WORDPRESS_REF="$(printf '%s' "$MANIFEST" | jq -r '.images.wordpress | to_entries[0].value // empty')"
WORDPRESS_REPO="${WORDPRESS_REF%:*}"
MIN_FROM="$(printf '%s' "$MANIFEST" | jq -r '.minUpgradeFrom // empty')"
REQUIRES_DOWNTIME="$(printf '%s' "$MANIFEST" | jq -r '.requiresDowntime // false')"
CHANNEL_ARG="${CHANNEL_ARG:-$CHANNEL}"
echo "   $FROM -> $TO ($CHANNEL) · $PANEL_IMAGE"

MANIFEST_SHA="$(printf '%s' "$MANIFEST" | jq -r '.gitSha // empty')"
if [ -n "$EXPECT_SHA" ] && [ -n "$MANIFEST_SHA" ] && [ "${MANIFEST_SHA#"$EXPECT_SHA"}" = "$MANIFEST_SHA" ]; then
  warn "Asked for $EXPECT_SHA but $RELEASE_TAG is built from $MANIFEST_SHA - a later merge moved it first."
fi

if [ "$FROM" = "$TO" ] && [ "$FORCE" = 0 ]; then
  log "Already on $TO; nothing to do."
  PHASE=switched FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ | jq -R .)"
  write_state
  exit 0
fi

# A `dev` version means someone built this panel on the box; overwriting it silently would
# throw away work that exists nowhere else. Same idea as deploy.sh refusing a dirty tree.
if { [ "$FROM" = dev ] || [ "$FROM_SOURCE" = build ]; } && [ "$FORCE" = 0 ]; then
  fail "This install builds its panel from the checkout (WPL7_SOURCE=$FROM_SOURCE, WPL7_VERSION=$FROM).
   Re-run with --force to replace it with the released image."
fi

# Older installs have to step through an intermediate release: the post-update hooks between
# here and there only run if a panel of that generation boots (services/updates hooks).
if [ -n "$MIN_FROM" ] && [ -n "$FROM" ]; then
  if [ "$(printf '%s\n%s\n' "$MIN_FROM" "$FROM" | sort -V | head -1)" != "$MIN_FROM" ]; then
    fail "$TO can only be applied to $MIN_FROM or newer; this install is $FROM. Update to $MIN_FROM first."
  fi
fi

# ----------------------------------------------------------------- 3. fetch

# Pin what is running RIGHT NOW, before a single pull, by image id.
#
# On the edge channel the tag is a moving one: `panel:edge` is re-pointed at the new build by
# the pull below, and `wpl7-wordpress:php8.3` - the local name every site container is created
# from - by the retag after it. Afterwards nothing on this box names the version being
# replaced, so a rollback that only put the old tag back in .env would boot the very build it
# is rolling away from, against the restored database. An image id does not move.
#
# `.Config.Image` is the reference compose asked for, so restoring it puts the previous image
# back under exactly the name the recreate will look up; the rollback sets WPL7_SKIP_PULL so
# setup.sh does not immediately fetch the moving tag again over the top.
FROM_PANEL_REF="" FROM_PANEL_ID="" FROM_WORDPRESS=""
if [ "$DRY" = 0 ]; then
  FROM_PANEL_REF="$(docker inspect --format '{{.Config.Image}}' wpl7-panel 2>/dev/null || true)"
  FROM_PANEL_ID="$(docker inspect --format '{{.Image}}' wpl7-panel 2>/dev/null || true)"
  while read -r ref; do
    [ -n "$ref" ] || continue
    id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
    if [ -n "$id" ]; then FROM_WORDPRESS="$FROM_WORDPRESS$ref $id"$'\n'; fi
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' wpl7-wordpress 2>/dev/null || true)
fi

log "Pulling images"
run docker pull "$PANEL_IMAGE" || fail "Could not pull $PANEL_IMAGE. If the package is private, no box can update."
WORDPRESS_IMAGES="$(printf '%s' "$MANIFEST" | jq -r '.images.wordpress | to_entries[] | .key + " " + .value')"
while read -r php image; do
  [ -n "$php" ] || continue
  run docker pull "$image" || fail "Could not pull $image."
  run docker tag "$image" "wpl7-wordpress:php$php"
done <<< "$WORDPRESS_IMAGES"

log "Extracting the provisioning bundle from the panel image"
# The bundle rides inside the image (panel/Dockerfile), so there is nothing else to download
# and the scripts can never be a different revision from the panel that will run them.
if [ "$DRY" = 0 ]; then
  STAGING="$(mktemp -d)"
  trap 'rm -rf "$STAGING"' EXIT
  cid="$(docker create "$PANEL_IMAGE")"
  docker cp "$cid:/app/bundle/." "$STAGING/" >/dev/null
  docker rm -f "$cid" >/dev/null
  [ -f "$STAGING/provision/setup.sh" ] || fail "The image's bundle has no provision/setup.sh - refusing to continue."

  rm -rf "$PREVIOUS_DIR"
  mkdir -p "$PREVIOUS_DIR"
  for entry in provision deploy; do
    [ -e "$REPO_DIR/$entry" ] && cp -a "$REPO_DIR/$entry" "$PREVIOUS_DIR/"
  done
  # .env is this install's own and is never in the bundle; copying the staging over the
  # checkout therefore cannot touch it.
  rm -f "$PREVIOUS_DIR/deploy/.env"
  echo "   previous bundle kept in $PREVIOUS_DIR"

  if [ -d "$REPO_DIR/.git" ]; then
    warn "$REPO_DIR is a git checkout; the files from the image will make it differ from HEAD."
  fi
  cp -a "$STAGING/." "$REPO_DIR/"
  restore_repo_owner
fi

# ------------------------------------------------------------- 4. pre-flight

PHASE=preflight; write_state
log "Pre-flight"

# deploy.sh's logic, for the same reason: .env is not in the bundle, so a release that needs
# a new key cannot fill it in. Reported, never invented.
if [ -f "$DEPLOY_DIR/.env.example" ]; then
  missing=""
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    grep -q "^$key=" "$ENV_FILE" || missing="$missing $key"
  done < <(grep -oE '^[A-Z][A-Z0-9_]*=' "$DEPLOY_DIR/.env.example" | tr -d '=')
  [ -z "$missing" ] || add_warning "New keys in .env.example that $ENV_FILE does not have:$missing"
fi

free_gb="$(df -BG --output=avail "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)" 2>/dev/null | tail -1 | tr -dc '0-9' || true)"
[ "${free_gb:-99}" -ge 2 ] || add_warning "Only ${free_gb}G free where Docker stores images."
[ "$REQUIRES_DOWNTIME" != true ] || add_warning "This release reports requiresDowntime: sites may be unreachable while it applies."
write_state

if [ "$DRY" = 1 ]; then
  log "--dry-run: stopping before anything is changed."
  echo "   would write WPL7_VERSION=$TO, WPL7_IMAGE_TAG=$IMAGE_TAG, WPL7_CHANNEL=$CHANNEL_ARG, WPL7_SOURCE=image"
  echo "   would run   sudo -n $REPO_DIR/provision/setup.sh"
  echo "   would wait  for wpl7-panel to report healthy on $TO"
  exit 0
fi

# ---------------------------------------------------------------- 5. switch

PHASE=switching; write_state
log "Switching to $TO"

# Stop the panel first and snapshot its database while it is the only writer. This copy is
# the migration safety net: migrations run at every boot, before listen(), and there are no
# down-migrations - so the only way back from a bad one is the file as it was.
docker stop -t 30 wpl7-panel >/dev/null 2>&1 || true
DB_SNAPSHOT=""
if [ -f "$SRV_ROOT/panel/panel.db" ]; then
  DB_SNAPSHOT="$UPDATE_DIR/panel.db.pre-$TO"
  wpl7_db_copy "$SRV_ROOT/panel/panel.db" "$DB_SNAPSHOT"
  echo "   database snapshot: $DB_SNAPSHOT"
fi

FROM_IMAGE_TAG="$(wpl7_env_get "$ENV_FILE" WPL7_IMAGE_TAG)"
FROM_PANEL_IMAGE="$(wpl7_env_get "$ENV_FILE" WPL7_PANEL_IMAGE)"
wpl7_env_set "$ENV_FILE" WPL7_VERSION "$TO"
wpl7_env_set "$ENV_FILE" WPL7_IMAGE_TAG "$IMAGE_TAG"
wpl7_env_set "$ENV_FILE" WPL7_PANEL_IMAGE "$PANEL_REPO"
if [ -n "$WORDPRESS_REPO" ]; then wpl7_env_set "$ENV_FILE" WPL7_WORDPRESS_IMAGE "$WORDPRESS_REPO"; fi
wpl7_env_set "$ENV_FILE" WPL7_CHANNEL "$CHANNEL_ARG"
wpl7_env_set "$ENV_FILE" WPL7_SOURCE image

# setup.sh is the idempotent "make this host match the bundle" step, and the new bundle is
# already in place. The pulls above mean it has nothing to download, so this is fast.
apply_bundle() {
  "$REPO_DIR/provision/setup.sh" --non-interactive
}
apply_ok=1
apply_bundle || apply_ok=0

# ----------------------------------------------------------- 6. health gate

PHASE=healthcheck; write_state
healthy=0
if [ "$apply_ok" = 1 ] && wpl7_wait_healthy wpl7-panel "$HEALTH_TIMEOUT"; then
  # Healthy means the container's own HEALTHCHECK reached /api/health, which the panel only
  # serves after runMigrations() and listen() - so a migration that throws can never pass
  # this gate. What that does not prove is *which* image answered, hence the second check.
  running="$(docker exec wpl7-panel printenv WPL7_VERSION 2>/dev/null || true)"
  if [ "$running" = "$TO" ]; then
    healthy=1
  else
    warn "wpl7-panel is healthy but reports version '${running:-unknown}', not $TO."
  fi
fi

if [ "$healthy" = 1 ]; then
  PHASE=switched
  FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ | jq -R .)"
  write_state
  log "Updated to $TO."
  echo "   The panel finishes the job itself: worker servers and any per-version steps run"
  echo "   as a job in the new panel (Settings -> Updates)."
  exit 0
fi

# --------------------------------------------------------------- 7. rollback

if [ "$ROLLBACK" = 0 ]; then
  ROLLED_BACK=false
  fail "Update to $TO failed and --no-rollback was given: this install is left on the new version, unhealthy."
fi

log "Rolling back to ${FROM:-the previous version}"
# The old image is still on this box, so going back is a recreate rather than a download.
if [ -d "$PREVIOUS_DIR" ]; then
  cp -a "$PREVIOUS_DIR/." "$REPO_DIR/"
  restore_repo_owner
  echo "   restored the previous bundle"
fi

# Put those images back under the names compose and the site specs use - see the pinning at
# the top of the fetch phase - and then forbid the pull that would undo it. WPL7_SKIP_PULL is
# an environment variable rather than a flag because the bundle restored just above is the
# PREVIOUS release's, and an older setup.sh ignores a variable it does not know but dies on
# an argument it does not know.
if [ -n "$FROM_PANEL_ID" ] && [ -n "$FROM_PANEL_REF" ]; then
  if docker tag "$FROM_PANEL_ID" "$FROM_PANEL_REF"; then
    echo "   $FROM_PANEL_REF points at the image that was running again"
  else
    add_warning "Could not restore $FROM_PANEL_REF - the rollback may start the image that just failed."
  fi
fi
while read -r ref id; do
  if [ -n "$ref" ] && [ -n "$id" ]; then docker tag "$id" "$ref" || true; fi
done <<< "$FROM_WORDPRESS"
export WPL7_SKIP_PULL=1
wpl7_env_set "$ENV_FILE" WPL7_VERSION "$FROM"
wpl7_env_set "$ENV_FILE" WPL7_IMAGE_TAG "$FROM_IMAGE_TAG"
wpl7_env_set "$ENV_FILE" WPL7_PANEL_IMAGE "$FROM_PANEL_IMAGE"
if [ -n "$FROM_CHANNEL" ]; then wpl7_env_set "$ENV_FILE" WPL7_CHANNEL "$FROM_CHANNEL"; fi
wpl7_env_set "$ENV_FILE" WPL7_SOURCE "$FROM_SOURCE"
if [ -n "$DB_SNAPSHOT" ]; then
  docker stop -t 30 wpl7-panel >/dev/null 2>&1 || true
  wpl7_db_copy "$DB_SNAPSHOT" "$SRV_ROOT/panel/panel.db"
  echo "   restored the database as it was before the migrations ran"
fi

ROLLED_BACK=true
if apply_bundle && wpl7_wait_healthy wpl7-panel "$HEALTH_TIMEOUT"; then
  fail "Update to $TO failed - rolled back to ${FROM:-the previous version}, which is healthy again."
fi
fail "Update to $TO failed AND the rollback did not come back healthy - THE PANEL IS DOWN. Check: docker logs wpl7-panel"
