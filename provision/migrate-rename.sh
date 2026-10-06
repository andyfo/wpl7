#!/usr/bin/env bash
# One-time migration of an install from ceo-server to WPL7.
#
# provision/setup.sh calls this by itself when it finds a `ceo-panel` container, between
# building the site images and starting the stack - so by the time anything stops, every
# slow step is already done. By hand, on a box whose checkout has been updated:
#
#   sudo ./provision/migrate-rename.sh            # ask before the outage
#   sudo ./provision/migrate-rename.sh --yes      # do not ask
#   sudo ./provision/migrate-rename.sh --dry-run  # print the plan, change nothing
#
# It renames the stack, not the data: /srv/sites, /srv/mysql and /srv/backups are never
# touched, and site containers keep running throughout. They are unreachable for the ~1
# minute between Traefik stopping and the new stack answering, and they stay on their old
# networks afterwards - the panel queues one `site.reconcile` each to finish the job, with
# the usual per-site rollback (services/legacyRename.ts).
# @docs reference/installer-and-scripts
set -euo pipefail

case "${1:-}" in -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;; esac

REPO_DIR="${WPL7_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The checkout is about to be renamed out from under this file. A rename within one
# filesystem would keep bash's descriptor valid, but a checkout on a different mount makes
# `mv` a copy-and-delete, and bash then reads the rest of a script that no longer exists.
if [ "${MIGRATE_SELF_COPY:-}" != "$0" ]; then
  self="$(mktemp)"
  cp "$REPO_DIR/provision/migrate-rename.sh" "$self"
  export MIGRATE_SELF_COPY="$self" WPL7_REPO_DIR="$REPO_DIR"
  exec bash "$self" "$@"
fi
rm -f -- "$0" 2>/dev/null || true   # the copy unlinks itself; the open fd stays valid

NEW_DIR="/opt/wpl7"
STATE_FILE="" ASSUME_YES=0 DRY=0
for arg in "$@"; do
  case "$arg" in
    --new-dir=*) NEW_DIR="${arg#*=}" ;;
    # setup.sh reads the new checkout path back out of this file.
    --state-file=*) STATE_FILE="${arg#*=}" ;;
    --yes|--non-interactive) ASSUME_YES=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

DEPLOY_DIR="$REPO_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env"
SRV_ROOT="${SRV_ROOT:-/srv}"
. "$REPO_DIR/provision/lib.sh"
# Standalone runs build the panel themselves; called from setup.sh the stamp is already
# exported and this recomputes the same values. An install that predates the rename is by
# definition a checkout, but the guard keeps this from overriding a version .env owns.
if [ "$(wpl7_source_mode "$ENV_FILE")" = build ]; then wpl7_stamp "$REPO_DIR" source; fi

OLD_STACK=(ceo-panel ceo-mail ceo-dkim ceo-traefik ceo-mariadb)
OLD_NETWORKS=(ceo_proxy ceo_db)
OLD_SPOOL=ceo_mailspool
NEW_SPOOL=wpl7_mailspool

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\n\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

exists() { docker inspect "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- pre-flight

[ "$(id -u)" = 0 ] || die "Run as root (sudo $0)."
[ -f "$ENV_FILE" ] || die "No $ENV_FILE - this does not look like an install to migrate."

if ! exists ceo-panel && ! exists ceo-traefik; then
  log "Nothing to migrate: no ceo-* stack container on this host."
  if [ -n "$STATE_FILE" ]; then printf 'MIGRATED=0\nREPO_DIR=%s\n' "$REPO_DIR" > "$STATE_FILE"; fi
  exit 0
fi

log "Pre-flight"

# A site created before per-site isolation (PR #10) is still a member of the shared proxy
# network, and would lose its routing here with nothing to put it back. Reconciling it
# first is a panel operation with a rollback; doing it from a teardown script is not.
if docker network inspect ceo_proxy >/dev/null 2>&1; then
  strays=""
  for name in $(docker network inspect ceo_proxy --format '{{range .Containers}}{{.Name}} {{end}}'); do
    case " ${OLD_STACK[*]} " in *" $name "*) continue ;; esac
    strays="$strays $name"
  done
  [ -z "$strays" ] || die "Still on ceo_proxy:$strays
   Those sites predate per-site isolation. In the panel, Sites -> Re-apply security policy
   (or POST /api/sites/reconcile-all), wait for the jobs, then run this again."
fi

DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
avail_gb="$(df -BG --output=avail "$DOCKER_ROOT" 2>/dev/null | tail -1 | tr -dc '0-9' || true)"
[ "${avail_gb:-0}" -ge 3 ] || die "Only ${avail_gb:-0}G free on $DOCKER_ROOT; the new images need ~3G."
echo "   ${avail_gb}G free on $DOCKER_ROOT, ceo_proxy holds only the stack"

if [ -e "$NEW_DIR" ] && [ "$REPO_DIR" != "$NEW_DIR" ]; then
  die "$NEW_DIR already exists, and the checkout is at $REPO_DIR. Move or remove it first."
fi

if [ "$ASSUME_YES" = 0 ] && [ "$DRY" = 0 ]; then
  cat <<EOF

 This stops the panel, the relay, Traefik and MariaDB and starts them again under their new
 names. Sites stop answering for about a minute; their data is not touched.

 Before continuing, check the panel's Jobs page: a backup, a restore or a move interrupted
 here has to be restarted by hand afterwards.

EOF
  read -rp " Continue? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) die "Aborted." ;; esac
fi

# ------------------------------------------------- pre-build (no downtime yet)

log "Aliasing the site images under their new names"
# Running site containers hold an image ID and do not care, but a reconcile builds its
# replacement from `wpl7-wordpress:php<v>` - including PHP versions this install offers no
# longer, which setup.sh therefore never rebuilt.
for image in $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^ceo-wordpress:' || true); do
  new="wpl7-${image#ceo-}"
  if docker image inspect "$new" >/dev/null 2>&1; then
    echo "   $new exists"
  else
    run docker tag "$image" "$new"
    echo "   $image -> $new"
  fi
done

if grep -q '^SERVER_ROLE=worker' "$ENV_FILE"; then
  # The worker overlay parks the panel service under an inactive profile, so compose does
  # not know the service at all here - and there is nothing to build: a worker runs Traefik,
  # MariaDB and the relay from published images.
  echo "   worker role: no panel image to build"
else
  log "Building the panel image (the slow step, while everything still serves)"
  run "$REPO_DIR/provision/compose.sh" build panel
fi

# ------------------------------------------------------------------- teardown

log "Stopping the old stack"
# Order matters: the panel first so nothing writes to its database or starts a job, then
# mail, then the two that every site depends on - Traefik last of the reachable ones, so
# sites are dark for as short a time as possible.
run docker stop -t 30 ceo-panel 2>/dev/null || true

if [ -f "$SRV_ROOT/panel/panel.db" ]; then
  log "Snapshotting the panel database"
  # Taken with the panel stopped, so it is the only writer and this is a consistent copy.
  # It is what a rollback restores; nothing deletes it.
  run wpl7_db_copy "$SRV_ROOT/panel/panel.db" "$SRV_ROOT/panel/panel.db.pre-wpl7"
  echo "   $SRV_ROOT/panel/panel.db.pre-wpl7"
fi

run docker stop ceo-mail ceo-dkim 2>/dev/null || true
run docker stop ceo-traefik 2>/dev/null || true
run docker stop -t 60 ceo-mariadb 2>/dev/null || true

log "Removing the old containers and networks"
for c in "${OLD_STACK[@]}"; do if exists "$c"; then run docker rm -f "$c" || true; fi; done
for n in "${OLD_NETWORKS[@]}"; do
  # Best effort: pre-flight already proved ceo_proxy holds nothing but the stack, and a
  # leftover network costs a name, not a service.
  if docker network inspect "$n" >/dev/null 2>&1; then
    run docker network rm "$n" >/dev/null || warn "could not remove $n"
  fi
done

# --------------------------------------------------------------- move in place

FINAL_DIR="$REPO_DIR"
if [ "$REPO_DIR" != "$NEW_DIR" ]; then
  log "Moving the checkout to $NEW_DIR"
  run mv "$REPO_DIR" "$NEW_DIR"
  # The CI forced command, root's shell history and anything an operator has in a script
  # still say /opt/ceo-server. The symlink keeps them working until ci-access.sh --rotate.
  run ln -sfn "$NEW_DIR" "$REPO_DIR"
  FINAL_DIR="$NEW_DIR"
  echo "   $REPO_DIR -> $NEW_DIR (symlink left behind)"
fi

OWNER="$(stat -c '%U' "$FINAL_DIR" 2>/dev/null || echo root)"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6 || true)"
if [ -n "$OWNER_HOME" ] && [ -f "$OWNER_HOME/.ceo-deploy.env" ]; then
  log "Renaming $OWNER's deploy environment file"
  if [ "$DRY" = 0 ]; then
    sed 's/^CEO_API_KEY=/WPL7_API_KEY=/' "$OWNER_HOME/.ceo-deploy.env" > "$OWNER_HOME/.wpl7-deploy.env"
    chown --reference="$OWNER_HOME/.ceo-deploy.env" "$OWNER_HOME/.wpl7-deploy.env"
    chmod 600 "$OWNER_HOME/.wpl7-deploy.env"
    rm -f "$OWNER_HOME/.ceo-deploy.env"
  fi
  echo "   $OWNER_HOME/.wpl7-deploy.env (CEO_API_KEY -> WPL7_API_KEY)"
fi

# ------------------------------------------------------- carry the mail queue

log "Creating the new stack's containers, networks and volumes"
# `create` rather than `up`: the mail queue has to be copied into wpl7_mailspool before
# postfix opens it, and letting compose make the volume is what gives it the project labels
# a later `compose down -v` looks for.
run "$FINAL_DIR/provision/compose.sh" create

if docker volume inspect "$OLD_SPOOL" >/dev/null 2>&1; then
  from="$(docker volume inspect "$OLD_SPOOL" --format '{{.Mountpoint}}' 2>/dev/null || true)"
  to="$(docker volume inspect "$NEW_SPOOL" --format '{{.Mountpoint}}' 2>/dev/null || true)"
  if [ -d "$from" ] && [ -d "$to" ]; then
    log "Copying the mail queue to $NEW_SPOOL"
    run cp -a "$from/." "$to/"
    echo "   deferred mail survives the rename; $OLD_SPOOL is left for you to delete"
  else
    warn "Could not locate both mail spool volumes; deferred mail stays in $OLD_SPOOL."
  fi
fi

# ----------------------------------------------------------------------- done

if [ -n "$STATE_FILE" ]; then printf 'MIGRATED=1\nREPO_DIR=%s\n' "$FINAL_DIR" > "$STATE_FILE"; fi

MOVED_BACK=""
if [ "$FINAL_DIR" != "$REPO_DIR" ]; then
  MOVED_BACK="        rm $REPO_DIR && mv $FINAL_DIR $REPO_DIR
"
fi

log "Migrated. setup.sh now starts the stack under the project name wpl7."
cat <<EOF

 Still to do, by hand:

   1. Rotate CI access so the forced command points at the new path:
        sudo $FINAL_DIR/provision/ci-access.sh --repo=<owner>/wpl7 --user=$OWNER --rotate
   2. Point the checkout at the renamed repository:
        sudo -u $OWNER git -C $FINAL_DIR remote set-url origin git@github.com:<owner>/wpl7.git

 Once the panel is healthy and every site has been reconciled (Jobs page), clean up:

        docker volume rm $OLD_SPOOL
        docker image rm ceo-panel:latest \$(docker image ls -q ceo-wordpress)
$([ "$FINAL_DIR" != "$REPO_DIR" ] && echo "        rm $REPO_DIR                       # the compatibility symlink")

 If the panel does not come back, the way back is:

        docker rm -f \$(docker ps -aq --filter name='^wpl7-')
${MOVED_BACK}        cp -a $SRV_ROOT/panel/panel.db.pre-wpl7 $SRV_ROOT/panel/panel.db
        git -C $REPO_DIR checkout <the commit you were on> && $REPO_DIR/provision/setup.sh

EOF
