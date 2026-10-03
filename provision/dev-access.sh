#!/usr/bin/env bash
# Prepare this server for editing WPL7 on the box itself (edit, test, push).
#
#   sudo ./provision/dev-access.sh                       # interactive
#   sudo ./provision/dev-access.sh --user=wp --git-name="Your Name" --git-email=you@example.com
#   sudo ./provision/dev-access.sh --with-claude         # ...and install Claude Code
#
# What it sets up:
#   - a non-root user that OWNS the checkout and can drive Docker (so nothing here runs as root)
#   - Node 22 on the host, for `npm test` / `npm run typecheck` before you rebuild
#   - GitHub CLI (gh), from its official signed apt repository
#   - an SSH key for that user, to register on GitHub as a repository deploy key with write access
#
# --with-claude additionally installs Claude Code from its official signed apt repository.
# Opt-in, because an AI coding agent on a production host is a choice, not a default.
#
# Safe to re-run: every step is guarded and nothing is overwritten.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_USER="wp"
GIT_NAME=""
GIT_EMAIL=""
WITH_NODE=1
WITH_GH=1
WITH_CLAUDE=0

for arg in "$@"; do
  case "$arg" in
    --user=*) DEV_USER="${arg#*=}" ;;
    --git-name=*) GIT_NAME="${arg#*=}" ;;
    --git-email=*) GIT_EMAIL="${arg#*=}" ;;
    --skip-node) WITH_NODE=0 ;;
    --skip-gh) WITH_GH=0 ;;
    --with-claude) WITH_CLAUDE=1 ;;
    --skip-claude) WITH_CLAUDE=0 ;;   # accepted and now redundant: it is off by default
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; echo "Try: $0 --help" >&2; exit 1 ;;
  esac
done

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
as_dev() { sudo -u "$DEV_USER" -H "$@"; }

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo $0)." >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq curl ca-certificates gnupg >/dev/null 2>&1 || true

# ---------------------------------------------------------------- dev user
log "Development user: $DEV_USER"
if ! id -u "$DEV_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$DEV_USER"
  echo "Created user $DEV_USER"
fi
# docker: needed to rebuild/restart the stack without sudo.
# sudo:   needed for provision/setup.sh (apt, ufw, /etc/docker).
if getent group docker >/dev/null; then
  usermod -aG docker "$DEV_USER"
else
  warn "No 'docker' group yet - run provision/setup.sh first, then re-run this script."
fi
usermod -aG sudo "$DEV_USER"

# The user logs in with an SSH key, so it has no password; give it passwordless sudo.
# This grants no privilege it does not already have: membership in the `docker` group is
# root-equivalent (any member can start a container that mounts the host filesystem).
if [ ! -f "/etc/sudoers.d/90-wpl7-dev-$DEV_USER" ]; then
  echo "$DEV_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-wpl7-dev-$DEV_USER"
  chmod 440 "/etc/sudoers.d/90-wpl7-dev-$DEV_USER"
  visudo -cf "/etc/sudoers.d/90-wpl7-dev-$DEV_USER" >/dev/null
fi

# Let the new user log in with the same key you use for root.
DEV_HOME="$(getent passwd "$DEV_USER" | cut -d: -f6)"
if [ -f /root/.ssh/authorized_keys ] && [ ! -s "$DEV_HOME/.ssh/authorized_keys" ]; then
  install -d -m 700 -o "$DEV_USER" -g "$DEV_USER" "$DEV_HOME/.ssh"
  install -m 600 -o "$DEV_USER" -g "$DEV_USER" /root/.ssh/authorized_keys "$DEV_HOME/.ssh/authorized_keys"
  echo "Copied root's authorized_keys -> $DEV_USER (log in with: ssh $DEV_USER@<server>)"
elif [ ! -s "$DEV_HOME/.ssh/authorized_keys" ]; then
  warn "$DEV_USER has no authorized_keys and no password - add your public key to"
  warn "$DEV_HOME/.ssh/authorized_keys, or you will not be able to log in as $DEV_USER."
fi

# ---------------------------------------------------------------- repo ownership
log "Checkout ownership ($REPO_DIR)"
chown -R "$DEV_USER":"$DEV_USER" "$REPO_DIR"
# The checkout is no longer root-owned, so root's git would refuse to touch it.
git config --global --get-all safe.directory | grep -qx "$REPO_DIR" \
  || git config --global --add safe.directory "$REPO_DIR"

# ---------------------------------------------------------------- git identity
log "Git identity for $DEV_USER"
CUR_NAME="$(as_dev git config --global user.name 2>/dev/null || true)"
CUR_EMAIL="$(as_dev git config --global user.email 2>/dev/null || true)"
if [ -z "$GIT_NAME$GIT_EMAIL" ] && [ -n "$CUR_NAME" ] && [ -n "$CUR_EMAIL" ]; then
  echo "Keeping existing identity: $CUR_NAME <$CUR_EMAIL>"
else
  # Default to the author of the last commit in this repo - that is the identity
  # GitHub already attributes this project's history to.
  DEF_NAME="${GIT_NAME:-$(cd "$REPO_DIR" && git log -1 --format='%an' 2>/dev/null || true)}"
  DEF_EMAIL="${GIT_EMAIL:-$(cd "$REPO_DIR" && git log -1 --format='%ae' 2>/dev/null || true)}"
  [ -n "$GIT_NAME" ] || read -rp "Git author name [${DEF_NAME:-none}]: " GIT_NAME
  [ -n "$GIT_EMAIL" ] || read -rp "Git author email [${DEF_EMAIL:-none}]: " GIT_EMAIL
  GIT_NAME="${GIT_NAME:-$DEF_NAME}"
  GIT_EMAIL="${GIT_EMAIL:-$DEF_EMAIL}"
  if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
    as_dev git config --global user.name "$GIT_NAME"
    as_dev git config --global user.email "$GIT_EMAIL"
    echo "Commits from this server will be authored by: $GIT_NAME <$GIT_EMAIL>"
  else
    warn "No git identity set - 'git commit' will fail until you run: git config --global user.email ..."
  fi
fi

# ---------------------------------------------------------------- Node (for tests)
if [ "$WITH_NODE" = 1 ] && ! command -v node >/dev/null 2>&1; then
  log "Node.js 22 (host-side, for npm test / npm run typecheck)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs >/dev/null
  echo "node $(node --version)"
fi

# ---------------------------------------------------------------- GitHub CLI
if [ "$WITH_GH" = 1 ] && ! command -v gh >/dev/null 2>&1; then
  log "GitHub CLI (official apt repository)"
  apt-get install -y -qq wget >/dev/null
  install -d -m 755 /etc/apt/keyrings
  wget -nv -O /tmp/githubcli.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg
  install -m 644 /tmp/githubcli.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg
  rm -f /tmp/githubcli.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh >/dev/null
  echo "$(gh --version | head -1)"
fi

# ---------------------------------------------------------------- Claude Code
# Installed system-wide from Anthropic's signed apt repository. Deliberately NOT
# `sudo npm install -g`, which Anthropic's docs warn against, and which would leave
# a root-owned install that a non-root user cannot update.
if [ "$WITH_CLAUDE" = 1 ] && ! command -v claude >/dev/null 2>&1; then
  log "Claude Code (official apt repository, stable channel)"
  apt-get install -y -qq curl gnupg >/dev/null
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://downloads.claude.ai/keys/claude-code.asc -o /etc/apt/keyrings/claude-code.asc
  EXPECTED_FPR="31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"
  ACTUAL_FPR="$(gpg --show-keys --with-colons /etc/apt/keyrings/claude-code.asc 2>/dev/null | awk -F: '/^fpr:/{print $10; exit}')"
  if [ "$ACTUAL_FPR" != "$EXPECTED_FPR" ]; then
    rm -f /etc/apt/keyrings/claude-code.asc
    warn "Claude Code signing key fingerprint mismatch (got '${ACTUAL_FPR:-none}') - skipping install."
    warn "Install manually per https://code.claude.com/docs/en/setup"
  else
    echo "deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main" \
      > /etc/apt/sources.list.d/claude-code.list
    apt-get update -qq && apt-get install -y -qq claude-code >/dev/null
    echo "$(claude --version 2>/dev/null || echo 'claude installed')"
  fi
fi

# ---------------------------------------------------------------- deploy key
log "SSH key for pushing to GitHub"
KEY="$DEV_HOME/.ssh/id_ed25519"
install -d -m 700 -o "$DEV_USER" -g "$DEV_USER" "$DEV_HOME/.ssh"
if [ ! -f "$KEY" ]; then
  as_dev ssh-keygen -t ed25519 -N "" -C "wpl7-deploy-$(hostname -s)" -f "$KEY" >/dev/null
  echo "Generated $KEY"
fi
if ! as_dev grep -q '^github.com ' "$DEV_HOME/.ssh/known_hosts" 2>/dev/null; then
  ssh-keyscan -t rsa,ecdsa,ed25519 github.com 2>/dev/null >> "$DEV_HOME/.ssh/known_hosts"
  chown "$DEV_USER":"$DEV_USER" "$DEV_HOME/.ssh/known_hosts"
fi

REMOTE_URL="$(cd "$REPO_DIR" && git remote get-url origin 2>/dev/null || echo '<no origin remote>')"
REPO_SLUG="$(echo "$REMOTE_URL" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"

cat <<EOF

============================================================================
 Server is ready for on-box development.

 1. Add this PUBLIC key to GitHub as a deploy key WITH WRITE ACCESS:
       https://github.com/$REPO_SLUG/settings/keys/new
       (tick "Allow write access")

$(cat "$KEY.pub")

    Then verify:  sudo -u $DEV_USER ssh -T git@github.com
    (expect: "Hi $REPO_SLUG! You've successfully authenticated...")

 2. Log in as the dev user and authenticate the tools:
       ssh $DEV_USER@$(hostname -f 2>/dev/null || hostname)
       gh auth login          # optional: PRs/issues from the server$(if [ "$WITH_CLAUDE" = 1 ]; then printf '\n       claude                 # opens the browser login flow'; fi)

 3. Edit / apply / push:
       cd $REPO_DIR$(if [ "$WITH_CLAUDE" = 1 ]; then printf '\n       claude'; fi)
       ./provision/build.sh          # typecheck + test + rebuild what changed + verify
       git add -A && git commit -m "..." && git push

 Note: $DEV_USER is in the 'docker' group, which is root-equivalent on this host.
 It keeps file ownership sane and avoids running an agent as root - it is not a
 security boundary against a determined attacker.
============================================================================
EOF
