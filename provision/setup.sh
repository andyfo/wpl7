#!/usr/bin/env bash
# WPL7 provisioning: blank Ubuntu 26.04 -> running WordPress hosting stack.
#
# Main server (panel + sites), as root from a clone at /opt/wpl7:
#   ./provision/setup.sh --panel-domain=panel.example.com --dev-domain=dev.example.com --acme-email=you@example.com
#
# Worker server (sites only; driven by the central panel over SSH):
#   ./provision/setup.sh --role=worker --dev-domain=dev.example.com --acme-email=you@example.com \
#       --panel-key='ssh-ed25519 AAAA… wpl7-panel@panel.example.com'
#   (The panel's "Add server" with provisioning runs exactly this for you.)
#
# Every step is guarded; the script is safe to re-run. It never overwrites an existing .env,
# except for a value you pass explicitly on the re-run:
#   ./provision/setup.sh --mail-hostname=smtp.example.com    # change the name postfix announces
# @docs get-started/installation, get-started/quick-start, reference/installer-and-scripts, security/overview, servers/add, servers/resources
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env"
SRV_ROOT="${SRV_ROOT:-/srv}"
. "$REPO_DIR/provision/lib.sh"

ROLE="main" PANEL_DOMAIN="" DEV_DOMAIN="" ACME_EMAIL="" ADMIN_USER="admin" ADMIN_PASSWORD=""
DNS_PROVIDER_ARG="" MAIL_HOSTNAME_ARG="" NON_INTERACTIVE=0 DNS_TOKEN_STDIN=0 DNS_TOKEN="" SSH_PORT_ARG=""
NO_FIREWALL=0
PANEL_KEYS=()
for arg in "$@"; do
  case "$arg" in
    --role=*) ROLE="${arg#*=}" ;;
    --panel-domain=*) PANEL_DOMAIN="${arg#*=}" ;;
    --dev-domain=*) DEV_DOMAIN="${arg#*=}" ;;
    --acme-email=*) ACME_EMAIL="${arg#*=}" ;;
    --admin-user=*) ADMIN_USER="${arg#*=}" ;;
    --admin-password=*) ADMIN_PASSWORD="${arg#*=}" ;;
    --dns-provider=*) DNS_PROVIDER_ARG="${arg#*=}" ;;
    --mail-hostname=*) MAIL_HOSTNAME_ARG="${arg#*=}" ;;
    --panel-key=*) PANEL_KEYS+=("${arg#*=}") ;;
    # The port the panel reaches this machine on; always kept open in the firewall below.
    --ssh-port=*) SSH_PORT_ARG="${arg#*=}" ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    # CI runners and containers where ufw is absent or would cut the only route in.
    --no-firewall) NO_FIREWALL=1 ;;
    # The DNS provider API token arrives on stdin (never argv - argv is visible in `ps`).
    --dns-token-stdin) DNS_TOKEN_STDIN=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; echo "Try: $0 --help" >&2; exit 1 ;;
  esac
done
case "$ROLE" in main|worker) ;; *) echo "--role must be main or worker" >&2; exit 1 ;; esac
if [ "$DNS_TOKEN_STDIN" = 1 ]; then
  IFS= read -r DNS_TOKEN || true
fi

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

env_value() { wpl7_env_get "$ENV_FILE" "$1"; }

# Every port sshd actually listens on, plus the one given with --ssh-port. Opening only 22
# locked out servers whose daemon runs elsewhere: default-deny then cut the very connection
# the provisioner (and the administrator) came in on, with no way back in to fix it.
ssh_ports() {
  {
    sshd -T 2>/dev/null | awk '$1=="port"{print $2}' || true
    grep -hsE '^[[:space:]]*Port[[:space:]]+[0-9]+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null \
      | awk '{print $2}' || true
    ss -tlnpH 2>/dev/null | awk '/"sshd"/{sub(/.*:/,"",$4); print $4}' || true
    [ -n "$SSH_PORT_ARG" ] && echo "$SSH_PORT_ARG" || true
  } | grep -E '^[0-9]+$' | sort -un || true
}

# RFC1918 / CGNAT / link-local check for the auto-detected address.
is_private_ipv4() {
  case "$1" in
    10.*|127.*|192.168.*|169.254.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
    *) return 1 ;;
  esac
}

set_env_value() { wpl7_env_set "$ENV_FILE" "$1" "$2"; }

require_or_prompt() {
  local var=$1 prompt=$2
  if [ -z "${!var}" ]; then
    if [ "$NON_INTERACTIVE" = 1 ]; then
      echo "Missing required value: --${var//_/-} (non-interactive mode)" | tr '[:upper:]' '[:lower:]' >&2
      exit 1
    fi
    read -rp "$prompt" "${var?}"
  fi
}

# The released panel and site images, and the third-party DKIM signer's, are built for x86-64
# only. A checkout builds the first two here, but not the signer's. Anywhere else they exit at
# once with "exec format error", and this script would still print that the stack is up. So it
# stops before installing anything, as install.sh does, and Add server in the panel shows the
# message as the server's last error.
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ;;
  aarch64|arm*) echo "This is an ARM server ($ARCH). WPL7 runs on x86-64 (amd64) servers only: its images are not built for ARM." >&2; exit 1 ;;
  *) echo "This server's processor is $ARCH. WPL7 runs on x86-64 (amd64) servers only." >&2; exit 1 ;;
esac
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo $0)." >&2; exit 1; }
if ! grep -q 'Ubuntu 26' /etc/os-release 2>/dev/null; then
  echo "WARNING: this script targets Ubuntu 26.04 LTS; detected: $(. /etc/os-release && echo "$PRETTY_NAME"). Continuing anyway." >&2
fi

log "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw jq openssl >/dev/null

log "Docker CE"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker

log "Docker daemon config (log rotation + live-restore)"
if ! cmp -s "$REPO_DIR/provision/daemon.json" /etc/docker/daemon.json 2>/dev/null; then
  cp "$REPO_DIR/provision/daemon.json" /etc/docker/daemon.json
  systemctl restart docker
fi

SSH_PORTS="$(ssh_ports)"
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
if [ "$NO_FIREWALL" = 1 ]; then
  log "Firewall: skipped (--no-firewall)"
else
log "Firewall (UFW: ssh on $(echo "$SSH_PORTS" | tr '\n' ' ')rate-limited, 80, 443)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
# Existing rules are kept (no reset): whatever access was configured before stays valid.
for port in $SSH_PORTS; do ufw limit "$port/tcp" >/dev/null; done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
fi
# Note: Docker-published ports bypass UFW; only Traefik publishes (80/443), which are allowed anyway.
# Blocking an address from the sites therefore happens in a table of its own, below.

log "Directory layout under $SRV_ROOT"
mkdir -p "$SRV_ROOT"/{sites,backups,mysql,traefik,panel,plugins} "$SRV_ROOT/traefik/dynamic"

# The network layer of Security's blocked addresses (docs/security.md): the panel writes the
# list, `wpl7-firewall apply` loads it into the nftables table `inet wpl7`, which drops TCP 80
# and 443 from a blocked address before Docker forwards the ports - and a unit of its own loads
# the last list at boot, panel or no panel. Not nftables.service: its default configuration
# begins with `flush ruleset`, which would take Docker's and UFW's rules with it.
if [ "$NO_FIREWALL" = 1 ]; then
  log "Blocked addresses: skipped (--no-firewall); Traefik alone refuses them on this server"
else
  log "Blocked addresses (nftables table inet wpl7, wpl7-firewall)"
  apt-get install -y -qq nftables >/dev/null
  install -m 0755 "$REPO_DIR/provision/firewall/wpl7-firewall" /usr/local/sbin/wpl7-firewall
  install -m 0644 "$REPO_DIR/provision/firewall/wpl7-firewall.service" /etc/systemd/system/wpl7-firewall.service
  printf 'SRV_ROOT=%s\n' "$SRV_ROOT" > /etc/default/wpl7-firewall
  install -d -m 700 "$SRV_ROOT/wpl7-firewall"
  systemctl daemon-reload
  systemctl enable wpl7-firewall.service >/dev/null 2>&1
  if systemctl is-enabled --quiet nftables.service 2>/dev/null; then
    echo "NOTE: nftables.service is enabled here. If /etc/nftables.conf still begins with 'flush ruleset'," >&2
    echo "      each start of it also removes the table of blocked addresses (and Docker's rules)." >&2
  fi
fi
mkdir -p "$SRV_ROOT/mail/dkim" "$SRV_ROOT/mail/policy" "$SRV_ROOT/mail/sasl" "$SRV_ROOT/mail/sasl2"
chmod 700 "$SRV_ROOT/backups" "$SRV_ROOT/mysql" "$SRV_ROOT/panel" "$SRV_ROOT/mail/dkim" "$SRV_ROOT/mail/sasl"

# Postfix opens its sender-authorization maps when it starts and tempfails every message if
# one is missing, so they exist from the start - empty means "no domain is owned yet", which
# is true on a fresh box. The panel rewrites both (and /etc/sasl2/smtpd.conf beside them)
# whenever a site is created, moved, renamed or deleted.
touch "$SRV_ROOT/mail/policy/sender_login" "$SRV_ROOT/mail/policy/sasl_block"
touch "$SRV_ROOT/traefik/acme.json" "$SRV_ROOT/traefik/acme-staging.json" "$SRV_ROOT/traefik/acme-dns.json"
chmod 600 "$SRV_ROOT"/traefik/acme*.json

# The DKIM signer bind-mounts this file. Docker creates a *directory* in its place if it
# does not exist yet, and the container then fails to start - so seed it here. The panel
# rewrites it (and the tables beside it) whenever DKIM keys change; until then this
# starting config makes the container come up healthy with nothing to sign.
if [ ! -f "$SRV_ROOT/mail/opendkim.conf" ]; then
  cat > "$SRV_ROOT/mail/opendkim.conf" <<'DKIMCONF'
# Replaced by the WPL7 panel on the first DKIM sync.
UserID                  root
BaseDirectory           /run/opendkim
Socket                  inet:8891
Syslog                  Yes
SyslogSuccess           Yes
Mode                    s
Canonicalization        relaxed/simple
KeyTable                file:/etc/opendkim/keys/KeyTable
SigningTable            refile:/etc/opendkim/keys/SigningTable
ExternalIgnoreList      refile:/etc/opendkim/keys/TrustedHosts
InternalHosts           refile:/etc/opendkim/keys/TrustedHosts
OversignHeaders         From
DKIMCONF
fi
# Empty tables are valid: opendkim starts, signs nothing, and waits for the panel.
for f in KeyTable SigningTable; do
  [ -f "$SRV_ROOT/mail/dkim/$f" ] || : > "$SRV_ROOT/mail/dkim/$f"
done
[ -f "$SRV_ROOT/mail/dkim/TrustedHosts" ] || printf '0.0.0.0/0\n::/0\n' > "$SRV_ROOT/mail/dkim/TrustedHosts"

log "Swap (2G if RAM < 4G and no swap active)"
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 4096 ] && [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Configuration ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  if [ "$ROLE" = main ]; then
    require_or_prompt PANEL_DOMAIN "Panel domain (e.g. panel.example.com): "
  fi
  require_or_prompt DEV_DOMAIN "Dev domain with wildcard DNS (e.g. dev.example.com): "
  require_or_prompt ACME_EMAIL "Let's Encrypt email: "
  if [ "$ROLE" = main ] && [ -z "$ADMIN_PASSWORD" ] && [ "$NON_INTERACTIVE" = 0 ]; then
    read -rsp "Panel admin password (empty = generate & print on first boot): " ADMIN_PASSWORD; echo
  fi
  PUBLIC_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
  cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # The example ships image mode, which is what install.sh and a bundle install want. A
  # checkout is the other case: the source is here, so it is what gets built.
  if [ -d "$REPO_DIR/.git" ]; then set_env_value WPL7_SOURCE build; fi
  set_env_value SERVER_ROLE "$ROLE"
  set_env_value DEV_DOMAIN "$DEV_DOMAIN"
  set_env_value ACME_EMAIL "$ACME_EMAIL"
  set_env_value SERVER_PUBLIC_IP "$PUBLIC_IP"
  set_env_value MARIADB_ROOT_PASSWORD "$(openssl rand -hex 24)"
  if [ "$ROLE" = main ]; then
    set_env_value PANEL_DOMAIN "$PANEL_DOMAIN"
    set_env_value PANEL_SESSION_SECRET "$(openssl rand -hex 24)"
    set_env_value PANEL_ADMIN_USER "$ADMIN_USER"
    set_env_value PANEL_ADMIN_PASSWORD "$ADMIN_PASSWORD"
    set_env_value MAIL_HOSTNAME "${MAIL_HOSTNAME_ARG:-mail.${PANEL_DOMAIN#panel.}}"
  else
    set_env_value MAIL_HOSTNAME "${MAIL_HOSTNAME_ARG:-mail.$DEV_DOMAIN}"
  fi
  if [ -n "$DNS_PROVIDER_ARG" ]; then
    set_env_value DNS_PROVIDER "$DNS_PROVIDER_ARG"
    if [ -n "$DNS_TOKEN" ]; then
      case "$DNS_PROVIDER_ARG" in
        cloudflare) set_env_value CF_DNS_API_TOKEN "$DNS_TOKEN" ;;
        hetzner) set_env_value HETZNER_API_KEY "$DNS_TOKEN" ;;
        digitalocean) set_env_value DO_AUTH_TOKEN "$DNS_TOKEN" ;;
        *) echo "WARNING: no token variable known for provider '$DNS_PROVIDER_ARG'; set it in .env manually" >&2 ;;
      esac
    fi
  fi
  echo "Wrote $ENV_FILE - review it (SMTP relay, DNS provider for wildcard certs) before going to production."
else
  echo "Keeping existing $ENV_FILE"
  # Idempotent re-runs may still deliver a fresh panel key below.
fi
# A --mail-hostname passed on THIS run is an instruction, not a default being re-derived, so
# it is honoured on an existing install too, whose .env is otherwise left alone: re-deriving
# the defaults would silently undo deliberate edits. It also beats a name set in the panel -
# the operator overruling it - and the stack started below recreates the relay with it.
if [ -n "$MAIL_HOSTNAME_ARG" ]; then
  wpl7_mail_hostname_set "$ENV_FILE" "$SRV_ROOT/mail/relay.env" "$MAIL_HOSTNAME_ARG"
fi

# Which release this install runs, as recorded by whoever put the bundle here: install.sh for
# a fresh main server, the panel for a worker server. Those keys - the version, the tag the
# images were published under, the registry - are the one thing this script cannot derive and
# will not invent, and a worker has no checkout to derive them from either.
#
# Applied whether or not .env already exists, and consumed once. That is deliberate: on a
# worker, "Update" means "make this machine match the panel", so a re-run has to be able to
# move the version forward. Nothing else writes this file, and it is removed as soon as it
# has been read.
if [ -f "$REPO_DIR/.wpl7-install" ]; then
  while IFS='=' read -r key value; do
    case "$key" in WPL7_*) set_env_value "$key" "$value" ;; esac
  done < "$REPO_DIR/.wpl7-install"
  rm -f "$REPO_DIR/.wpl7-install"
  echo "Applied the recorded release: source=$(env_value WPL7_SOURCE) version=$(env_value WPL7_VERSION) channel=$(env_value WPL7_CHANNEL)"
fi

# Where the panel comes from. Written once and then left alone: an install that compiles the
# panel keeps compiling it and one that pulls keeps pulling, until an operator edits the key
# or build.sh / update.sh moves it. A checkout is read as "the source is here and is meant to
# be used" - which is every install that predates image mode.
if [ -z "$(env_value WPL7_SOURCE)" ]; then
  if [ -d "$REPO_DIR/.git" ]; then set_env_value WPL7_SOURCE build; else set_env_value WPL7_SOURCE image; fi
fi
[ -n "$(env_value WPL7_CHANNEL)" ] || set_env_value WPL7_CHANNEL stable
SOURCE_MODE="$(wpl7_source_mode "$ENV_FILE")"

if [ "$SOURCE_MODE" = build ] && [ -f "$REPO_DIR/panel/package.json" ]; then
  wpl7_stamp "$REPO_DIR" source
  set_env_value WPL7_VERSION "$WPL7_VERSION"
  log "Panel: built from this checkout ($WPL7_VERSION, $WPL7_GIT_SHA)"
elif [ "$SOURCE_MODE" = build ]; then
  # A worker of a source-built panel. Build mode means only "build the site images from the
  # Dockerfile in this bundle": there is no panel container here and no panel source either -
  # the bundle the panel pushes is provision/ + deploy/ - so there is no version to derive,
  # and deriving one anyway is a `sed` on a file that does not exist, which under pipefail
  # ends the provision. The version already in .env is the panel build that pushed this.
  PROVISIONED_BY="$(env_value WPL7_VERSION)"
  log "Site images: built from this bundle (no panel on this server${PROVISIONED_BY:+; pushed by $PROVISIONED_BY})"
else
  WPL7_VERSION="$(env_value WPL7_VERSION)"
  if [ -z "$WPL7_VERSION" ]; then
    echo "WPL7_SOURCE=image but WPL7_VERSION is unset in $ENV_FILE." >&2
    echo "Nothing here invents a version. Either set it to a published release (and let" >&2
    echo "provision/update.sh maintain it), or set WPL7_SOURCE=build to compile the panel" >&2
    echo "from this checkout." >&2
    exit 1
  fi
  # The tag the images were published under. It is the version for a release and `edge`
  # for the rolling build, which is why it is recorded separately rather than derived.
  WPL7_IMAGE_TAG="$(env_value WPL7_IMAGE_TAG)"
  WPL7_IMAGE_TAG="${WPL7_IMAGE_TAG:-$WPL7_VERSION}"
  export WPL7_VERSION WPL7_IMAGE_TAG
  log "Panel: pulling the released image ($WPL7_VERSION, tag $WPL7_IMAGE_TAG)"
fi

if [ "$ROLE" = worker ] || [ ${#PANEL_KEYS[@]} -gt 0 ]; then
  log "Panel access user (wpl7-panel)"
  # The central panel drives this server over SSH as wpl7-panel: docker group for the
  # Docker API + NOPASSWD sudo for host file operations (chown 33:33, rm under /srv).
  # docker-group membership is already root-equivalent on this host, so the sudoers
  # entry adds no privilege - it just makes host-side ops behave like the panel's
  # local root container does.
  id wpl7-panel >/dev/null 2>&1 || useradd -m -s /bin/bash wpl7-panel
  # '*' = no password login, but NOT locked - sshd without PAM refuses pubkey auth for locked ('!') accounts.
  usermod -p '*' wpl7-panel
  usermod -aG docker wpl7-panel
  echo 'wpl7-panel ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/91-wpl7-panel
  chmod 440 /etc/sudoers.d/91-wpl7-panel
  visudo -c -q
  install -d -m 700 -o wpl7-panel -g wpl7-panel /home/wpl7-panel/.ssh
  touch /home/wpl7-panel/.ssh/authorized_keys
  chmod 600 /home/wpl7-panel/.ssh/authorized_keys
  chown wpl7-panel:wpl7-panel /home/wpl7-panel/.ssh/authorized_keys
  for key in ${PANEL_KEYS[@]+"${PANEL_KEYS[@]}"}; do
    grep -qF "$key" /home/wpl7-panel/.ssh/authorized_keys || echo "$key" >> /home/wpl7-panel/.ssh/authorized_keys
  done
  # The panel's web terminal opens a root shell here with the same key. No new
  # privilege - wpl7-panel above is already root-equivalent (docker group + sudo).
  install -d -m 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  for key in ${PANEL_KEYS[@]+"${PANEL_KEYS[@]}"}; do
    grep -qF "$key" /root/.ssh/authorized_keys || echo "$key" >> /root/.ssh/authorized_keys
  done
fi

if [ "$ROLE" = main ]; then
  log "Web terminal: panel key in root's authorized_keys"
  # The panel's web terminal SSHes to this very host as root using the panel's own
  # key (the panel is already root-equivalent via docker.sock; this adds reach, not
  # privilege). On a first install the panel hasn't booted yet, so generate its
  # identity up front - ensurePanelSshKey() in the panel adopts an existing key file.
  if [ ! -f "$SRV_ROOT/panel/ssh/id_ed25519" ]; then
    install -d -m 700 "$SRV_ROOT/panel/ssh"
    ssh-keygen -q -t ed25519 -N '' -C "wpl7-panel@$(env_value PANEL_DOMAIN)" -f "$SRV_ROOT/panel/ssh/id_ed25519"
  fi
  install -d -m 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  PANEL_PUB="$(cat "$SRV_ROOT/panel/ssh/id_ed25519.pub")"
  grep -qF "$PANEL_PUB" /root/.ssh/authorized_keys || echo "$PANEL_PUB" >> /root/.ssh/authorized_keys
fi

PHP_VERSIONS="$(env_value WP_PHP_VERSIONS)"
PHP_VERSIONS="${PHP_VERSIONS:-8.2,8.3,8.4,8.5}"
if [ "$SOURCE_MODE" = build ]; then
  log "Building wpl7-wordpress images for offered PHP versions"
  for v in ${PHP_VERSIONS//,/ }; do
    docker build --build-arg "PHP_TAG=php$v" -t "wpl7-wordpress:php$v" "$DEPLOY_DIR/wordpress-image"
  done
elif [ "${WPL7_SKIP_PULL:-0}" = 1 ]; then
  log "WPL7_SKIP_PULL=1: keeping the wpl7-wordpress images already on this host"
else
  log "Pulling wpl7-wordpress images for offered PHP versions"
  # Built once in CI with --pull, so every server in a fleet runs byte-identical site
  # containers and wp-cli is fetched once instead of on every box. Retagged to the local
  # name the panel references (services/siteSpec.ts), so nothing in the panel has to know
  # about registries - and so a site container's image reference survives a channel change.
  WORDPRESS_IMAGE="$(env_value WPL7_WORDPRESS_IMAGE)"
  WORDPRESS_IMAGE="${WORDPRESS_IMAGE:-ghcr.io/andyfo/wpl7/wordpress}"
  for v in ${PHP_VERSIONS//,/ }; do
    docker pull "$WORDPRESS_IMAGE:php$v-$WPL7_IMAGE_TAG"
    docker tag "$WORDPRESS_IMAGE:php$v-$WPL7_IMAGE_TAG" "wpl7-wordpress:php$v"
  done
fi

# An install that still runs the pre-rename stack is moved across here, after the images
# are built and before anything is started: `compose up` would otherwise bring up a second,
# parallel copy of Traefik, MariaDB and the relay beside the ceo-* ones, and two edge
# proxies cannot both hold port 443.
MIGRATED=0
if docker inspect ceo-panel >/dev/null 2>&1 || docker inspect ceo-traefik >/dev/null 2>&1; then
  log "This host still runs the ceo-server stack; migrating it first"
  migrate_state="$(mktemp)"
  migrate_args=(--state-file="$migrate_state")
  [ "$NON_INTERACTIVE" = 1 ] && migrate_args+=(--yes)
  SRV_ROOT="$SRV_ROOT" "$REPO_DIR/provision/migrate-rename.sh" "${migrate_args[@]}"
  # migrate-rename.sh may have moved the checkout; every path below has to follow it.
  # shellcheck disable=SC1090
  . "$migrate_state"
  rm -f "$migrate_state"
  DEPLOY_DIR="$REPO_DIR/deploy"
  ENV_FILE="$DEPLOY_DIR/.env"
fi

log "Starting the stack"
# LEGACY - delete in 0.4.0. The DNS overlay's resolvers are in docker-compose.yml now, and Traefik
# reads Cloudflare's token from the file the panel keeps (docs/dns.md). An update copies the new
# bundle over the old one without deleting, so the overlay would stay - and a compose run that
# still named it would hand Traefik .env's token, which wins over the panel's.
rm -f "$DEPLOY_DIR/docker-compose.dns.yml"
grep -q '^SERVER_ROLE=worker' "$ENV_FILE" && echo "Worker role -> including docker-compose.worker.yml (no panel container)"
if [ "$SOURCE_MODE" = image ]; then
  # Pull before the recreate rather than during it: `up` would do it anyway, but a registry
  # that is slow or unreachable should fail while the old containers are still serving.
  #
  # WPL7_SKIP_PULL is a rollback: update.sh has already put the exact images it wants back
  # under these very tags, and on the edge channel those tags move - pulling again would
  # fetch the build being rolled away from.
  if [ "${WPL7_SKIP_PULL:-0}" = 1 ]; then
    echo "WPL7_SKIP_PULL=1 -> recreating from the images already on this host"
  else
    "$REPO_DIR/provision/compose.sh" pull --quiet
  fi
  "$REPO_DIR/provision/compose.sh" up -d
elif [ "$ROLE" = worker ]; then
  "$REPO_DIR/provision/compose.sh" up -d
else
  "$REPO_DIR/provision/compose.sh" up -d --build
fi

# If a dev user owns this checkout (see provision/dev-access.sh), make sure running the
# provisioner as root has not left root-owned files that user can no longer edit.
REPO_OWNER="$(stat -c '%U' "$REPO_DIR" 2>/dev/null || echo root)"
if [ "$REPO_OWNER" != root ]; then
  log "Restoring checkout ownership to $REPO_OWNER"
  chown -R "$REPO_OWNER":"$(stat -c '%G' "$REPO_DIR")" "$REPO_DIR"
fi

log "Waiting for MariaDB to become healthy"
for _ in $(seq 1 30); do
  state="$(docker inspect --format '{{.State.Health.Status}}' wpl7-mariadb 2>/dev/null || echo starting)"
  [ "$state" = healthy ] && break
  sleep 2
done

# On a migration this is the moment of truth: a panel that never answers means the sites
# stay on their old networks with nothing left to repair them, so say so loudly rather than
# printing the usual "everything is up" banner.
if [ "$MIGRATED" = 1 ] && [ "$ROLE" = main ]; then
  log "Waiting for the panel to become healthy after the migration"
  panel_ok=0
  for _ in $(seq 1 60); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' wpl7-panel 2>/dev/null || echo missing)"
    case "$state" in healthy|running) panel_ok=1; break ;; esac
    sleep 3
  done
  if [ "$panel_ok" = 0 ]; then
    docker logs --tail 60 wpl7-panel 2>&1 | sed 's/^/  | /' || true
    echo
    echo "The migration completed but wpl7-panel is not healthy. The rollback recipe was" >&2
    echo "printed above, and $SRV_ROOT/panel/panel.db.pre-wpl7 is the database it restores." >&2
    exit 1
  fi
  echo "   the panel is up; it is now queueing one reconcile per site (Jobs page)"
fi

DEV_DOMAIN_FINAL="$(env_value DEV_DOMAIN)"
PUBLIC_IP_FINAL="$(env_value SERVER_PUBLIC_IP)"
if [ -n "$PUBLIC_IP_FINAL" ] && is_private_ipv4 "$PUBLIC_IP_FINAL"; then
  echo "WARNING: SERVER_PUBLIC_IP=$PUBLIC_IP_FINAL is a private address (auto-detected from the default route)." >&2
  echo "         If this machine is behind NAT, set the real public IP in $ENV_FILE - DNS records use it." >&2
fi

if [ "$ROLE" = worker ]; then
  HOST_KEY_FP="$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}' || echo unknown)"
  cat <<EOF

============================================================================
 Worker server is up (traefik + mariadb + mail + dkim; no panel).

 Register it in the panel: Servers -> Add server -> "Already provisioned"
   SSH host:   $PUBLIC_IP_FINAL     Port: $(echo "$SSH_PORTS" | tr '\n' ' ')    User: wpl7-panel
   Public IP:  $PUBLIC_IP_FINAL
   Host key:   $HOST_KEY_FP
     (compare when the panel pins it on first connect)

 If you did not pass --panel-key, authorize the panel first:
   ./provision/setup.sh --role=worker --panel-key='<key from the panel Servers page>'

 DNS: sites on this server get explicit per-site records (panel-managed) or
      point *.$DEV_DOMAIN here if this should be the wildcard server.
============================================================================
EOF
else
  PANEL_DOMAIN_FINAL="$(env_value PANEL_DOMAIN)"
  # An install from the release bundle has no checkout to pull: it updates by image.
  if [ "$SOURCE_MODE" = image ]; then
    UPDATE_HINT="Settings -> Updates in the panel, or
                $REPO_DIR/provision/update.sh --to=<version>"
  else
    UPDATE_HINT="cd $REPO_DIR && git pull && ./provision/setup.sh"
  fi
  cat <<EOF

============================================================================
 WPL7 is up.

 Panel:      https://$PANEL_DOMAIN_FINAL
             (first-boot admin password, a minute after the panel starts:
              docker logs wpl7-panel | grep -A2 'First boot')

 DNS needed: A  $PANEL_DOMAIN_FINAL      -> $PUBLIC_IP_FINAL
             A  *.$DEV_DOMAIN_FINAL      -> $PUBLIC_IP_FINAL   (wildcard, for dev sites)
             mail records (SPF/DKIM/DMARC/rDNS): Panel -> Mail -> Setup guide

 Traefik requests the panel's TLS certificate when it starts. If the panel
 DNS record did not resolve yet, run 'docker restart wpl7-traefik' once it
 does. To test without burning Let's Encrypt rate limits, set BOTH in .env
 (TLS_MODE alone does not pick the CA):
             TLS_MODE=staging
             ACME_RESOLVER=letsencrypt-staging

 Update later:  $UPDATE_HINT
EOF
  if [ "$SOURCE_MODE" = build ]; then
    cat <<EOF

 To edit this server's code with Claude Code (git push, gh, tests):
             ./provision/dev-access.sh
EOF
  fi
  echo '============================================================================'
fi
