#!/usr/bin/env bash
# Authorize GitHub Actions to deploy to this server (.github/workflows/deploy.yml).
#
#   sudo ./provision/ci-access.sh                     # print the values to paste into GitHub
#   sudo ./provision/ci-access.sh --repo=owner/name   # ...and set them for you with `gh`
#   sudo ./provision/ci-access.sh --rotate            # replace an existing CI key
#
# Creates an ed25519 key whose only power is running provision/deploy.sh: the public half is
# installed with `restrict` + a forced command, so a leaked Actions secret cannot open a shell,
# forward a port, or run anything else. The private half is printed (or handed to `gh`) once
# and never stored on this server.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_USER="wp" REPO="" HOST="" PORT="" ROTATE=0
KEY_COMMENT="wpl7-deploy@github-actions"

for arg in "$@"; do
  case "$arg" in
    --user=*) DEPLOY_USER="${arg#*=}" ;;
    --repo=*) REPO="${arg#*=}" ;;
    --host=*) HOST="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    --rotate|--force) ROTATE=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; echo "Try: $0 --help" >&2; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root (sudo $0)."
id -u "$DEPLOY_USER" >/dev/null 2>&1 \
  || die "User '$DEPLOY_USER' does not exist - run provision/dev-access.sh first (it creates the checkout owner)."
[ -x "$REPO_DIR/provision/deploy.sh" ] || die "Missing $REPO_DIR/provision/deploy.sh"

# Check `gh` up front, not after the key is installed: a failure here used to leave an
# authorized key behind with no secrets to match it, so the retry needed --rotate.
if [ -n "$REPO" ]; then
  command -v gh >/dev/null \
    || die "--repo given but GitHub CLI is not installed (provision/dev-access.sh installs it). Re-run without --repo to print the secrets instead."
  sudo -u "$DEPLOY_USER" -H gh auth status >/dev/null 2>&1 \
    || die "--repo given but '$DEPLOY_USER' is not logged in to GitHub.
   Either log in first:  sudo -u $DEPLOY_USER -H gh auth login
   or drop --repo:       sudo $0   (prints the secrets for you to paste into GitHub)
   Nothing on this server has been changed."
fi

OWNER="$(stat -c '%U' "$REPO_DIR")"
[ "$OWNER" = "$DEPLOY_USER" ] \
  || warn "$REPO_DIR is owned by '$OWNER', not '$DEPLOY_USER' - deploys will fail to write. Run provision/dev-access.sh --user=$DEPLOY_USER."

# Port the CI runner should connect to: the first port sshd actually listens on.
if [ -z "$PORT" ]; then
  PORT="$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}' || true)"
  PORT="${PORT:-22}"
fi
if [ -z "$HOST" ]; then
  HOST="$(grep -m1 '^SERVER_PUBLIC_IP=' "$REPO_DIR/deploy/.env" 2>/dev/null | cut -d= -f2- || true)"
  HOST="${HOST:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 || true)}"
fi
[ -n "$HOST" ] || die "Could not determine this server's address - pass --host=<ip or hostname>."

# ---------------------------------------------------------------- the key
# Generated here, but NOT authorized until the secrets that match it exist (bottom of the
# file). A key installed before that step is a live credential GitHub cannot use - exactly
# the dangling state a failed run used to leave behind, which then needed --rotate to clear.
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
DEPLOY_GROUP="$(id -gn "$DEPLOY_USER")"
AUTH_KEYS="$DEPLOY_HOME/.ssh/authorized_keys"

if [ -f "$AUTH_KEYS" ] && grep -qF "$KEY_COMMENT" "$AUTH_KEYS" && [ "$ROTATE" = 0 ]; then
  die "A CI key is already authorized for $DEPLOY_USER. Re-run with --rotate to replace it (the old key stops working immediately)."
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ssh-keygen -q -t ed25519 -N '' -C "$KEY_COMMENT" -f "$WORK/id_ed25519"

# restrict = no pty, no port/agent/X11 forwarding, no user rc; command= pins what the key runs.
# deploy.sh re-parses the requested flags out of $SSH_ORIGINAL_COMMAND and rejects anything
# that is not one of its own.
authorize_key() {
  local line tmp
  line="restrict,command=\"$REPO_DIR/provision/deploy.sh\" $(cat "$WORK/id_ed25519.pub")"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "$DEPLOY_HOME/.ssh"
  tmp="$(mktemp)"
  [ -f "$AUTH_KEYS" ] && grep -vF "$KEY_COMMENT" "$AUTH_KEYS" > "$tmp" || true
  printf '%s\n' "$line" >> "$tmp"
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "$tmp" "$AUTH_KEYS"
  rm -f "$tmp"
  log "Authorized the CI key for $DEPLOY_USER (forced command: provision/deploy.sh)"
}

# ---------------------------------------------------------------- known_hosts for the runner
HOST_ENTRY="$HOST"
[ "$PORT" = 22 ] || HOST_ENTRY="[$HOST]:$PORT"
KNOWN_HOSTS=""
for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
  if [ -f "$f" ]; then
    KNOWN_HOSTS="$KNOWN_HOSTS$HOST_ENTRY $(cut -d' ' -f1,2 "$f")"$'\n'
  fi
done
KNOWN_HOSTS="${KNOWN_HOSTS%$'\n'}"
[ -n "$KNOWN_HOSTS" ] || die "No SSH host keys found in /etc/ssh - cannot pin the runner's known_hosts."

# ---------------------------------------------------------------- hand over the secrets
set_secret() { sudo -u "$DEPLOY_USER" -H gh secret set "$1" --repo "$REPO" --body "$2" >/dev/null; }

if [ -n "$REPO" ]; then
  log "Setting repository secrets on $REPO"
  set_secret DEPLOY_HOST "$HOST"
  set_secret DEPLOY_USER "$DEPLOY_USER"
  set_secret DEPLOY_PORT "$PORT"
  set_secret DEPLOY_PATH "$REPO_DIR"
  set_secret DEPLOY_SSH_KEY "$(cat "$WORK/id_ed25519")"
  set_secret DEPLOY_KNOWN_HOSTS "$KNOWN_HOSTS"
  authorize_key      # last: every secret is in place, so the key is usable the moment it lands
  cat <<EOF

============================================================================
 GitHub Actions can now deploy to this server.

 Secrets set on $REPO: DEPLOY_HOST, DEPLOY_USER, DEPLOY_PORT, DEPLOY_PATH,
                       DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS

 Push to main (or run the "Deploy" workflow manually) and watch it go.

 Fleets only: the panel API key that updates worker servers stays on this
 machine, not in GitHub -
   sudo -u $DEPLOY_USER sh -c 'echo WPL7_API_KEY=wpl7_... > ~/.wpl7-deploy.env && chmod 600 ~/.wpl7-deploy.env'
============================================================================
EOF
else
  authorize_key
  cat <<EOF

============================================================================
 Add these as repository secrets - GitHub -> Settings -> Secrets and
 variables -> Actions -> New repository secret.

 DEPLOY_HOST        $HOST
 DEPLOY_USER        $DEPLOY_USER
 DEPLOY_PORT        $PORT
 DEPLOY_PATH        $REPO_DIR

 The two multi-line values follow, unindented and between markers so they
 copy verbatim - a stray leading space breaks an OpenSSH private key. The
 key is shown ONCE; this server keeps no copy.

 Fleets only: the panel API key that updates worker servers stays on this
 machine, not in GitHub - write it to ~$DEPLOY_USER/.wpl7-deploy.env as
 WPL7_API_KEY=wpl7_... (mode 600).

 Faster next time: sudo ./provision/ci-access.sh --repo=owner/name --rotate
============================================================================

----- DEPLOY_KNOWN_HOSTS (copy the lines between the markers) -----
$KNOWN_HOSTS
----- end DEPLOY_KNOWN_HOSTS -----

----- DEPLOY_SSH_KEY (copy the lines between the markers) -----
$(cat "$WORK/id_ed25519")
----- end DEPLOY_SSH_KEY -----
EOF
fi
