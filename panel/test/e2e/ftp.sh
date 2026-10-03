#!/usr/bin/env bash
# Live e2e for FTP/SFTP logins (services/ftp.ts) against a throwaway sshd+dind "worker":
# real SFTPGo containers, set up by FtpService over SSH exactly as on a real worker, then
# real clients - SFTP from here, FTPS from the worker itself so it crosses Docker's NAT.
# Needs a local Docker daemon and network access. The SFTPGo image is built here from
# deploy/sftpgo-image (a few minutes the first time) and handed to the worker under the name
# the panel uses. E2E_SFTPGO=build leaves the worker without it, so the panel builds it there
# as it does on a server installed from source; WPL7_SFTPGO_IMAGE=<ref> runs another image.
#   panel/test/e2e/ftp.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(cd "$DIR/../.." && pwd)"
REPO_DIR="$(cd "$PANEL_DIR/.." && pwd)"
NAME=wpl7-e2e-ftp
SSH_PORT="${E2E_SSH_PORT:-39223}"
SFTP_PORT="${E2E_SFTP_PORT:-39224}"
WORK="$(mktemp -d)"

cleanup() {
  [ -n "${KEEP:-}" ] && { echo "(KEEP set: $NAME left running)"; return; }
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Generating throwaway panel keypair"
ssh-keygen -q -t ed25519 -N '' -C 'wpl7-panel-e2e' -f "$WORK/id_ed25519"

echo "==> Building the sshd+dind server image"
docker build -q -t wpl7-e2e-server2 "$DIR/server2" >/dev/null

echo "==> Starting $NAME (sshd on :$SSH_PORT, the gateway's SFTP on :$SFTP_PORT)"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --privileged --name "$NAME" \
  -p "127.0.0.1:$SSH_PORT:22" \
  -p "127.0.0.1:$SFTP_PORT:2222" \
  -v "$WORK/id_ed25519.pub:/panel-key.pub:ro" \
  wpl7-e2e-server2 >/dev/null

echo "==> Waiting for sshd + dockerd inside the container"
for i in $(seq 1 60); do
  if docker exec "$NAME" docker info >/dev/null 2>&1 && docker exec "$NAME" pgrep sshd >/dev/null 2>&1; then
    break
  fi
  [ "$i" = 60 ] && { echo "dind/sshd did not come up"; docker logs "$NAME" | tail -20; exit 1; }
  sleep 1
done

if [ -z "${WPL7_SFTPGO_IMAGE:-}" ] && [ "${E2E_SFTPGO:-}" != build ]; then
  image="wpl7-sftpgo:$(cat "$REPO_DIR/deploy/sftpgo-image/VERSION")"
  echo "==> Building $image"
  docker build -q -t "$image" "$REPO_DIR/deploy/sftpgo-image" >/dev/null
  docker save "$image" | docker exec -i "$NAME" docker load >/dev/null
fi

echo "==> Running the FTP checks"
cd "$PANEL_DIR"
E2E_SSH_HOST=127.0.0.1 E2E_SSH_PORT="$SSH_PORT" E2E_SSH_KEY="$WORK/id_ed25519" E2E_SFTP_PORT="$SFTP_PORT" \
  E2E_SFTPGO="${E2E_SFTPGO:-}" \
  npx tsx test/e2e/ftp.ts
