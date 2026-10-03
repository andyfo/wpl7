#!/usr/bin/env bash
# Live e2e for the SSH transport (pooled ssh2 + docker-over-ssh + streamed exec)
# against a throwaway sshd+dind container. Needs a local Docker daemon.
#   panel/test/e2e/ssh-transport.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(cd "$DIR/../.." && pwd)"
NAME=wpl7-e2e-ssh
PORT="${E2E_SSH_PORT:-39222}"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Generating throwaway panel keypair"
ssh-keygen -q -t ed25519 -N '' -C 'wpl7-panel-e2e' -f "$WORK/id_ed25519"

echo "==> Building the sshd+dind server image"
docker build -q -t wpl7-e2e-server2 "$DIR/server2"

echo "==> Starting $NAME (sshd on :$PORT)"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --privileged --name "$NAME" \
  -p "127.0.0.1:$PORT:22" \
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

echo "==> Running the transport checks"
cd "$PANEL_DIR"
E2E_SSH_HOST=127.0.0.1 E2E_SSH_PORT="$PORT" E2E_SSH_KEY="$WORK/id_ed25519" \
  npx tsx test/e2e/sshTransport.ts
