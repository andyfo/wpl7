# wpl7-wordpress: official WordPress Apache image + msmtp (working PHP mail()) + wp-cli.
# Build per offered PHP version:
#   docker build --build-arg PHP_TAG=php8.3 -t wpl7-wordpress:php8.3 deploy/wordpress-image
ARG PHP_TAG=php8.3
FROM wordpress:${PHP_TAG}-apache

# Refuse a base image whose PHP predates the last security release of its branch, so a stale
# cached base fails the build instead of shipping. Raise a branch's floor with each PHP
# security release (docs/internal/watchlist.md); a branch missing here is not checked.
RUN php -r '$floor = ["8.2" => "8.2.35", "8.3" => "8.3.36", "8.4" => "8.4.27", "8.5" => "8.5.12"][PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION] ?? "0"; \
    if (version_compare(PHP_VERSION, $floor, "<")) { fwrite(STDERR, "PHP " . PHP_VERSION . " is older than " . $floor . ", the last security release of its branch. Pull a newer base image.\n"); exit(1); }'

# Upload progress tracking stays off: nothing in WordPress uses it, and PHP's advisory for
# CVE-2026-109619 found it running before a request is initialized, which is where that bug
# was exploited. The advisory recommends it off even once PHP is patched.
RUN printf 'session.upload_progress.enabled = Off\n' > /usr/local/etc/php/conf.d/zz-wpl7-hardening.ini

RUN apt-get update \
  && apt-get install -y --no-install-recommends msmtp msmtp-mta less mariadb-client \
  && rm -rf /var/lib/apt/lists/*

# wp-cli, pinned via the stable phar channel; runs as www-data through `docker exec -u 33:33`.
RUN curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
  && chmod +x /usr/local/bin/wp \
  && wp --allow-root --version

COPY msmtprc /etc/msmtprc
RUN chmod 644 /etc/msmtprc

# PHP mail() -> msmtp -> wpl7-mail (postfix). --read-envelope-from takes the envelope
# sender from the From: header WordPress sets (wordpress@<site-domain>).
RUN printf 'sendmail_path = "/usr/bin/msmtp -t --read-envelope-from"\n' \
  > /usr/local/etc/php/conf.d/zz-msmtp.ini
