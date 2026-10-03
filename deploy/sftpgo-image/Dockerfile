# wpl7-sftpgo: SFTPGo for the FTP gateway and file servers (panel/src/services/ftp.ts).
#
# Upstream's distroless build of one pinned release, plus staged-overwrite.patch. Upstream's
# atomic uploads move a file that is being overwritten to the temporary name before the new
# one arrives, so the file is missing for the whole transfer - a site without its
# wp-config.php, which WordPress answers with its install screen - and is lost if the
# transfer breaks off. The patch writes the new file to the temporary name instead and
# renames it over the old one only once it is complete; a resume continues the file in place.
#
# Each server has it as wpl7-sftpgo:<VERSION>, like the site images: an install from released
# images pulls what .github/workflows/build-images.yml publishes (once per VERSION), and one
# built from source has the panel build it on the server from this folder (services/ftp.ts).
# A change to what the image contains needs a new VERSION. By hand:
#   docker build -t "wpl7-sftpgo:$(cat deploy/sftpgo-image/VERSION)" deploy/sftpgo-image
FROM golang:1.26-trixie AS builder
# Marks this stage's leftovers - the Go toolchain's work, gigabytes of it - which a server that
# builds the image prunes right after (services/ftp.ts); only the second stage is kept.
LABEL wpl7.build=sftpgo

ARG SFTPGO_VERSION=v2.7.6
# The commit the tag named when this was written: a tag can be moved, a commit cannot.
ARG SFTPGO_COMMIT=62ae9ba3957e9ed52b44a4f885e805e2d7b35972

ENV CGO_ENABLED=0 GOFLAGS="-mod=readonly"

RUN apt-get update && apt-get install -y --no-install-recommends media-types && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
RUN git clone --depth 1 --branch "$SFTPGO_VERSION" https://github.com/drakkan/sftpgo.git . \
  && test "$(git rev-parse HEAD)" = "$SFTPGO_COMMIT"
RUN go mod download && go mod verify

COPY staged-overwrite.patch VERSION /tmp/
# VERSION is <SFTPGo release>-wpl7.<n>: bumping one without the other is a mistake.
RUN test "v$(sed 's/-.*//' /tmp/VERSION)" = "$SFTPGO_VERSION" \
  && git apply /tmp/staged-overwrite.patch

# As upstream builds its distroless image (Dockerfile.distroless and the "distroless" entry
# of .github/workflows/docker.yml), with the patch level after the commit:
# `sftpgo --version` says "2.7.6-62ae9ba3+wpl7.1-<date>".
RUN build="$(printf %.8s "$SFTPGO_COMMIT")+$(sed 's/^[^-]*-//' /tmp/VERSION)" \
  && go build -tags nopgxregisterdefaulttypes,disable_grpc_modules,nosqlite -trimpath \
    -ldflags "-s -w -X github.com/drakkan/sftpgo/v2/internal/version.commit=$build -X github.com/drakkan/sftpgo/v2/internal/version.date=$(git log -1 --format=%cI)" \
    -o sftpgo \
  && ./sftpgo --version

RUN mkdir -p /etc/sftpgo /var/lib/sftpgo /srv/sftpgo

FROM gcr.io/distroless/static-debian13

COPY --from=builder --chown=1000:1000 /etc/sftpgo /etc/sftpgo
COPY --from=builder --chown=1000:1000 /srv/sftpgo /srv/sftpgo
COPY --from=builder --chown=1000:1000 /var/lib/sftpgo /var/lib/sftpgo
COPY --from=builder --chown=1000:1000 /workspace/sftpgo.json /etc/sftpgo/sftpgo.json
COPY --from=builder /workspace/templates /usr/share/sftpgo/templates
COPY --from=builder /workspace/static /usr/share/sftpgo/static
COPY --from=builder /workspace/openapi /usr/share/sftpgo/openapi
COPY --from=builder /workspace/sftpgo /usr/local/bin/
COPY --from=builder /etc/mime.types /etc/mime.types
# AGPL-3.0: this is a modified SFTPGo, and here is the modification.
COPY staged-overwrite.patch /usr/share/doc/wpl7-sftpgo/

ENV SFTPGO_LOG_FILE_PATH=""
# user.Current() needs these without cgo.
ENV USER=sftpgo
ENV HOME=/var/lib/sftpgo

LABEL org.opencontainers.image.title="wpl7-sftpgo" \
      org.opencontainers.image.description="SFTPGo with overwrites staged until complete, for WPL7's FTP logins" \
      org.opencontainers.image.source="https://github.com/andyfo/wpl7" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /var/lib/sftpgo
USER 1000:1000

CMD ["sftpgo", "serve"]
