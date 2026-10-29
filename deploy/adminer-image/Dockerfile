# wpl7-adminer: Adminer for "Open in Adminer" on a site's Database tab (panel/src/adminer/).
#
# PHP's CLI image with mysqli and nothing else, and Adminer's MySQL-only English build - its
# other drivers are where most of this year's advisories were - checked against its SHA-256.
# The official Adminer image is not used: it carries every driver and serves any PHP file in its
# folder, so /adminer.php gets past its plugins.
#
# PHP's built-in server listens on the container's own loopback, and the panel reaches it with
# `docker exec … php relay.php`: nothing on any network can connect to it. router.php takes every
# request, refuses a sign-in without the panel's key, and serves Adminer and nothing else.
#
# Each server has it as wpl7-adminer:<VERSION>, like wpl7-sftpgo: an install from released images
# pulls what .github/workflows/build-images.yml publishes (once per VERSION), and one built from
# source has the panel build it from this folder. A change to the image needs a new VERSION, and
# a new Adminer is a new ADMINER_VERSION and ADMINER_SHA256 (docs/internal/watchlist.md). By hand:
#   docker build -t "wpl7-adminer:$(cat deploy/adminer-image/VERSION)" deploy/adminer-image
FROM php:8.4-cli-alpine

ARG ADMINER_VERSION=6.2.0
ARG ADMINER_SHA256=8daeb33d23967df1a309d2614d0e7fcdfe99f799e25b4fd5312e5a7db159e58c

# tini and coreutils: see the ENTRYPOINT below.
RUN apk add --no-cache coreutils tini \
  && docker-php-ext-install mysqli \
  && mkdir -p /srv/adminer/empty \
  && wget -q -O /srv/adminer/adminer.php \
    "https://github.com/vrana/adminer/releases/download/v${ADMINER_VERSION}/adminer-${ADMINER_VERSION}-mysql-en.php" \
  && echo "${ADMINER_SHA256}  /srv/adminer/adminer.php" | sha256sum -c -

COPY VERSION /tmp/VERSION
# VERSION is <Adminer release>-wpl7.<n>: bumping one without the other is a mistake.
RUN test "$(sed 's/-.*//' /tmp/VERSION)" = "$ADMINER_VERSION" && rm /tmp/VERSION

COPY php.ini /usr/local/etc/php/conf.d/zz-wpl7.ini
COPY router.php relay.php wpl7.php /srv/adminer/

USER 65534:65534
WORKDIR /srv/adminer
# Two more than the panel sends requests at once (frontDoor.ts): its own questions never wait.
ENV PHP_CLI_SERVER_WORKERS=6
# Every request is a `docker exec`, which the panel wraps in `timeout`. tini, as process 1, reaps
# what an exec leaves behind: PHP's server would not, and each one would count against the
# container's process limit for good. coreutils' timeout stays the parent of its command, where
# busybox's leaves a watcher that holds the exec's output open after the command has ended.
ENTRYPOINT ["/sbin/tini", "--"]
# PHP's server holds nothing to save (its sessions are in a tmpfs that goes with it): a stop
# need not wait out Docker's grace period.
STOPSIGNAL SIGKILL
# The document root is an empty folder: router.php answers every request itself.
CMD ["php", "-S", "127.0.0.1:8080", "-t", "/srv/adminer/empty", "/srv/adminer/router.php"]
