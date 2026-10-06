#!/usr/bin/env bash
# Thin wrapper around `docker compose` that always uses this install's .env and overlays,
# so a rebuild can never accidentally recreate the stack with a different configuration.
#
#   ./provision/compose.sh up -d --build panel   # apply local panel changes
#   ./provision/compose.sh ps
#   ./provision/compose.sh logs -f wpl7-panel
# @docs reference/installer-and-scripts
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env"

# Pass-through wrapper: never swallow docker's own flags, so only a bare --help is ours.
if [ $# -eq 1 ] && { [ "$1" = --help ] || [ "$1" = -h ]; }; then
  sed -n '2,7p' "$0" | sed 's/^# \?//'
  exit 0
fi

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE - run provision/setup.sh first." >&2; exit 1; }

. "$REPO_DIR/provision/lib.sh"
# The panel needs the HOST path of this install to hand an update to systemd; inside
# the container it only ever sees /app/bundle.
export WPL7_INSTALL_DIR="$REPO_DIR"

FILES=(-f "$DEPLOY_DIR/docker-compose.yml")
WORKER=0
if grep -q '^SERVER_ROLE=worker' "$ENV_FILE"; then WORKER=1; fi

# Source mode compiles the panel here instead of pulling the release. WPL7_COMPOSE_BUILD
# forces it for build.sh, which is the on-box edit loop and therefore always a build.
#
# Never on a worker. Source mode there means only "build the site images rather than pull
# them" - there is no panel container on a worker to build, and this overlay is not in the
# bundle the panel pushes, so adding it would fail on a missing file.
if [ "$WORKER" = 0 ] && { [ "$(wpl7_source_mode "$ENV_FILE")" = build ] || [ "${WPL7_COMPOSE_BUILD:-0}" = 1 ]; }; then
  FILES+=(-f "$DEPLOY_DIR/docker-compose.build.yml")
fi
# Worker servers run the stack without the panel (the central panel drives them over SSH).
if [ "$WORKER" = 1 ]; then
  FILES+=(-f "$DEPLOY_DIR/docker-compose.worker.yml")
fi
# Backups on another disk: the panel container can only write to paths mounted into it.
if grep -q '^BACKUP_ROOT=..*' "$ENV_FILE"; then
  FILES+=(-f "$DEPLOY_DIR/docker-compose.backup-root.yml")
fi

exec docker compose --env-file "$ENV_FILE" "${FILES[@]}" "$@"
