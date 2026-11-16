#!/usr/bin/env bash
# Live e2e for the SSH transport (pooled ssh2 + docker-over-ssh + streamed exec)
# against a throwaway sshd+dind container. Needs a local Docker daemon.
#   panel/test/e2e/ssh-transport.sh
#
# It runs twice, once per image store Docker has: the classic one and containerd's
# (E2E_IMAGE_STORES="classic containerd" by default). The container-app checks need Docker Hub
# from inside the worker, for the images they pull there.
# E2E_FACTS=<file> appends what the container-app checks saw, one JSON line each.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(cd "$DIR/../.." && pwd)"
NAME=wpl7-e2e-ssh
PORT="${E2E_SSH_PORT:-39222}"
STORES="${E2E_IMAGE_STORES:-classic containerd}"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker rmi wpl7-e2e-big:1 >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Generating throwaway panel keypair"
ssh-keygen -q -t ed25519 -N '' -C 'wpl7-panel-e2e' -f "$WORK/id_ed25519"

echo "==> Building the sshd+dind server image"
docker build -q -t wpl7-e2e-server2 "$DIR/server2"

# An app image as big as a real one: 400 MB of random bytes, which nothing compresses, saved the
# way an app's CI would hand it over.
echo "==> Making a 400 MB image archive"
mkdir -p "$WORK/big"
head -c 400000000 /dev/urandom > "$WORK/big/big.bin"
BIG_SHA="$(shasum -a 256 "$WORK/big/big.bin" | cut -d' ' -f1)"
printf 'FROM busybox:1.37\nCOPY big.bin /big.bin\n' > "$WORK/big/Dockerfile"
docker build -q -t wpl7-e2e-big:1 "$WORK/big" >/dev/null
docker save -o "$WORK/big.tar" wpl7-e2e-big:1
docker rmi wpl7-e2e-big:1 >/dev/null
rm -rf "$WORK/big"

# busybox's image for each architecture, by digest: the platform checks pull the one that is not
# the worker's.
DIGESTS="$(docker manifest inspect busybox:1.37)"
digest_of() {
  printf '%s' "$DIGESTS" | python3 -c "import json,sys; print(next(m['digest'] for m in json.load(sys.stdin)['manifests'] if m['platform']['os']=='linux' and m['platform']['architecture']==sys.argv[1]))" "$1"
}
DIGEST_AMD64="$(digest_of amd64)"
DIGEST_ARM64="$(digest_of arm64)"

for STORE in $STORES; do
  echo "==> Starting $NAME (sshd on :$PORT, the $STORE image store)"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --privileged --name "$NAME" \
    -e E2E_IMAGE_STORE="$STORE" \
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

  echo "==> Running the transport checks ($STORE)"
  cd "$PANEL_DIR"
  E2E_SSH_HOST=127.0.0.1 E2E_SSH_PORT="$PORT" E2E_SSH_KEY="$WORK/id_ed25519" \
    E2E_IMAGE_STORE="$STORE" E2E_BIG_ARCHIVE="$WORK/big.tar" E2E_BIG_SHA="$BIG_SHA" \
    E2E_DIGEST_AMD64="$DIGEST_AMD64" E2E_DIGEST_ARM64="$DIGEST_ARM64" E2E_WORK="$WORK" \
    npx tsx test/e2e/sshTransport.ts
done
