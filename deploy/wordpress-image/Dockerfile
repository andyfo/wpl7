# wpl7-wordpress: official WordPress Apache image + msmtp (working PHP mail()) + wp-cli.
# Build per offered PHP version:
#   docker build --build-arg PHP_TAG=php8.3 -t wpl7-wordpress:php8.3 deploy/wordpress-image
ARG PHP_TAG=php8.3
FROM wordpress:${PHP_TAG}-apache

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
