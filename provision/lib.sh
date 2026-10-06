#!/usr/bin/env bash
# Shared helpers for the provision/ scripts. Sourced, never executed.
#
#   . "$REPO_DIR/provision/lib.sh"
# @docs get-started/installation, reference/installer-and-scripts

# --------------------------------------------------------------------- .env

# Read KEY=... out of an .env file. `VAR="$(grep … | cut …)"` looks harmless but aborts the
# caller under `set -euo pipefail` whenever grep matches nothing, which makes every
# "${VAR:-fallback}" downstream unreachable. `|| true` keeps the assignment succeeding.
wpl7_env_get() {
  grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2- || true
}

# Replace KEY=... in an .env file, appending when the key is absent. Pure bash on purpose:
# values (passwords especially) may contain &, \ or | which sed would interpret, silently
# corrupting the file that holds this install's database password.
wpl7_env_set() {
  local file=$1 key=$2 value=$3 line out="" found=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "${line%%=*}" = "$key" ] && [ "${line#"$key"=}" != "$line" ]; then
      out+="$key=$value"$'\n'
      found=1
    else
      out+="$line"$'\n'
    fi
  done < "$file"
  [ "$found" = 1 ] || out+="$key=$value"$'\n'
  printf '%s' "$out" > "$file"
}

# ------------------------------------------------------------------- mail relay

# Make NAME the hostname the mail relay announces, as `setup.sh --mail-hostname=NAME` asks:
# MAIL_HOSTNAME in the .env, and no hostname left in the panel's relay.env. Mail -> Setup
# guide writes one there, and compose reads that file after .env, so it would win. The
# override goes even when .env already says NAME: that is when it is the only thing between
# the operator and the name they asked for. Other settings in the file are kept; a file with
# none left is removed, so the compose `env_file` is simply absent again.
#
# Touches no container: `compose up` recreates the relay, its environment having changed.
wpl7_mail_hostname_set() {
  local env_file=$1 relay_env=$2 name=$3 old override kept changed=0
  old="$(wpl7_env_get "$env_file" MAIL_HOSTNAME)"
  if [ "$old" != "$name" ]; then
    wpl7_env_set "$env_file" MAIL_HOSTNAME "$name"
    echo "MAIL_HOSTNAME: ${old:-(unset)} -> $name"
    changed=1
  fi
  if [ -f "$relay_env" ] && grep -q '^POSTFIX_myhostname=' "$relay_env"; then
    override="$(grep '^POSTFIX_myhostname=' "$relay_env" | tail -n 1 | cut -d= -f2-)"
    kept="$(grep -v '^POSTFIX_myhostname=' "$relay_env" || true)"
    if grep -q '^[A-Za-z_][A-Za-z0-9_]*=' <<<"$kept"; then
      printf '%s\n' "$kept" > "$relay_env.tmp" && mv "$relay_env.tmp" "$relay_env"
    else
      rm -f "$relay_env"
    fi
    echo "Cleared the hostname set in the panel ($override), so $name is the one that applies"
    changed=1
  fi
  if [ "$changed" = 1 ]; then
    echo "Next: add an A record for $name -> this server, and change the server's reverse DNS to"
    echo "match. Panel -> Mail -> Setup guide checks both."
  else
    echo "The mail relay already announces $name"
  fi
}

# -------------------------------------------------------------- build identity

# How this install gets its panel image.
#
#   image  (default)  pull the released image named by WPL7_VERSION
#   build             build it from this checkout
#
# Image mode is what a release is for: an update becomes a pull and a recreate rather than a
# compile on a customer's VPS, and every server in a fleet runs the identical binary. Build
# mode is for developing on the box (provision/build.sh switches an install into it) and for
# anyone who would rather compile what they run.
wpl7_source_mode() {
  local file=$1
  if [ -f "$file" ] && [ "$(wpl7_env_get "$file" WPL7_SOURCE)" = build ]; then echo build; else echo image; fi
}

# Stamp the panel image with what it is.
#
# panel/Dockerfile turns these two into WPL7_VERSION and WPL7_GIT_SHA inside the image, and
# that is the only way the panel can know its own version: .dockerignore drops .git, so it
# cannot read the commit at runtime, and a number hardcoded in the source is one someone has
# to remember to bump in two places. compose.sh inherits the exported values.
#
# Only ever called in build mode. In image mode the version is whatever .env says is
# installed, and overriding it here would have compose pull a tag that was never published.
#
#   wpl7_stamp "$REPO_DIR" dev       # a local build of whatever is on disk
#   wpl7_stamp "$REPO_DIR" source    # a build of a committed revision -> "<package>-source"
#   wpl7_stamp "$REPO_DIR" 0.3.0     # a release
wpl7_stamp() {
  local repo_dir=$1 version=$2
  if [ "$version" = source ]; then
    # `|| true` because callers run with `set -euo pipefail`: a sed that cannot open the file
    # would otherwise take the assignment, and the whole script, down - defeating the 0.0.0
    # fallback on the next line. A bundle without panel/ is a real caller (a worker server).
    version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$repo_dir/panel/package.json" 2>/dev/null | head -1 || true)"
    version="${version:-0.0.0}-source"
  fi
  WPL7_VERSION="$version"
  WPL7_GIT_SHA="$(git -C "$repo_dir" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  export WPL7_VERSION WPL7_GIT_SHA
}

# ------------------------------------------------------------- panel database

# Copy the panel's SQLite database, write-ahead log included.
#
# Only ever with the panel stopped: it is the single writer, and a copy taken while it runs
# is a torn one. The -wal and -shm files go with it because a clean shutdown checkpoints the
# WAL but a killed process does not, and restoring a .db next to somebody else's -wal is
# worse than either half on its own.
wpl7_db_copy() {
  local src=$1 dst=$2 suffix
  [ -f "$src" ] || return 0
  cp -a "$src" "$dst"
  for suffix in -wal -shm; do
    if [ -f "$src$suffix" ]; then cp -a "$src$suffix" "$dst$suffix"; else rm -f "$dst$suffix"; fi
  done
}

# ------------------------------------------------------------------- health

# Wait for a container to report healthy (or merely running, for images without a
# HEALTHCHECK). Returns non-zero on a container that has exited or never got there, so the
# caller can roll back. WPL7_HEALTH_TIMEOUT bounds it.
wpl7_wait_healthy() {
  local name=$1 timeout=${2:-${WPL7_HEALTH_TIMEOUT:-300}} state health
  # A separate statement on purpose. Bash expands every word of a `local` before it assigns
  # any of them, so a deadline computed on the line above reads $timeout while it is still
  # unset - and under `set -u` that aborts the caller instead of waiting. update.sh runs with
  # nounset, so the first health gate would kill the update rather than roll it back.
  local deadline=$((SECONDS + timeout))
  echo "Waiting for $name to report healthy (up to ${timeout}s)"
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo none)"
    case "$state/$health" in
      running/healthy|running/none) echo "  $name: $state/$health"; return 0 ;;
      exited/*|dead/*) echo "  $name: $state" >&2; return 1 ;;
    esac
    sleep 3
  done
  echo "  $name: still $state/$health after ${timeout}s" >&2
  return 1
}
