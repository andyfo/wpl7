# wpl7-wordpress: official WordPress PHP-FPM image, behind Apache and an nginx page cache in the
# same container, plus Redis for sites with the object cache on, msmtp (working PHP mail()) and
# wp-cli.
# wpl7-start explains how they run together.
# Build per offered PHP version:
#   docker build --build-arg PHP_TAG=php8.3 -t wpl7-wordpress:php8.3 deploy/wordpress-image
# Keep this folder flat: the panel's on-demand build sends only its top-level files.
ARG PHP_TAG=php8.3
FROM wordpress:${PHP_TAG}-fpm

# The panel builds a container to match the image it finds, so a server that still has an older
# image keeps getting the containers that image needs (panel/src/services/siteStack.ts). wpl7.apps
# says what sites the image can run: the panel makes no PHP site's container from an image without
# it, because an older wpl7-start puts WordPress into any folder that has none
# (panel/src/services/siteSpec.ts).
LABEL wpl7.stack="2" wpl7.apps="wordpress php"

# Refuse a base image whose PHP predates the last security release of its branch, so a stale
# cached base fails the build instead of shipping. Raise a branch's floor with each PHP
# security release (docs/internal/watchlist.md); a branch missing here is not checked.
RUN php -r '$floor = ["8.2" => "8.2.35", "8.3" => "8.3.36", "8.4" => "8.4.27", "8.5" => "8.5.12"][PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION] ?? "0"; \
    if (version_compare(PHP_VERSION, $floor, "<")) { fwrite(STDERR, "PHP " . PHP_VERSION . " is older than " . $floor . ", the last security release of its branch. Pull a newer base image.\n"); exit(1); }'

# Upload progress tracking stays off: nothing in WordPress uses it, and PHP's advisory for
# CVE-2026-109619 found it running before a request is initialized, which is where that bug
# was exploited. The advisory recommends it off even once PHP is patched.
RUN printf 'session.upload_progress.enabled = Off\n' > /usr/local/etc/php/conf.d/zz-wpl7-hardening.ini

# Apache's and nginx's packages each leave a welcome page in the folder a site's files go in, and
# BuildKit keeps it in the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    apache2 nginx redis-server tini msmtp msmtp-mta less mariadb-client \
  && rm -f /var/www/html/index.html /var/www/html/index.nginx-debian.html \
  && rm -rf /var/lib/apt/lists/*

# phpredis, the client the object cache plugin talks to Redis with, pinned
# (docs/internal/watchlist.md). PHP's build tools are in the official image already.
RUN pecl install redis-6.3.0 \
  && docker-php-ext-enable redis \
  && rm -rf /tmp/pear

# PDO's MySQL driver, which most PHP apps connect with. WordPress uses mysqli, the only one the
# official image has.
RUN docker-php-ext-install pdo_mysql

# wp-cli, pinned via the stable phar channel; runs as www-data through `docker exec -u 33:33`.
RUN curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
  && chmod +x /usr/local/bin/wp \
  && wp --allow-root --version

COPY msmtprc /etc/msmtprc
RUN chmod 644 /etc/msmtprc

# PHP mail() -> wpl7-sendmail -> msmtp -> wpl7-mail (postfix). msmtp takes the envelope sender
# from one place and refuses two, so the wrapper picks one: -f from the caller, else the From
# header, else the site's default sender. sendmail is the wrapper too, for libraries that run it
# themselves. -t stays out of the wrapper, so that it can be both.
COPY wpl7-sendmail /usr/local/bin/wpl7-sendmail
RUN chmod 755 /usr/local/bin/wpl7-sendmail \
  && ln -sf /usr/local/bin/wpl7-sendmail /usr/sbin/sendmail \
  && ln -sf /usr/local/bin/wpl7-sendmail /usr/lib/sendmail \
  && printf 'sendmail_path = "/usr/local/bin/wpl7-sendmail -t"\n' \
    > /usr/local/etc/php/conf.d/zz-msmtp.ini

# PHP's settings and pool. The official image's own access log goes, for the same reason Apache has
# none: Traefik logs every request.
COPY php.ini /usr/local/etc/php/conf.d/zx-wpl7.ini
COPY php-fpm.conf /usr/local/etc/php-fpm.d/zz-wpl7.conf
RUN chmod 644 /usr/local/etc/php/conf.d/zx-wpl7.ini /usr/local/etc/php-fpm.d/zz-wpl7.conf \
  && sed -i '/^access\.log/d' /usr/local/etc/php-fpm.d/docker.conf

# Apache listens on the loopback only: nginx takes the site's traffic, and the panel's in-container
# `curl http://127.0.0.1/` still reaches Apache on port 80, uncached. Debian enables every other
# module the official Apache image has, so a .htaccess keeps working, apart from mod_status: its
# `Require local` would see nginx's 127.0.0.1 if remoteip ever had no X-Forwarded-For. mod_actions is
# what refuses a file a .htaccess hands to mod_php. mpm_event.conf and deflate.conf give way to
# wpl7-site.conf.
COPY apache-site.conf /etc/apache2/conf-available/wpl7-site.conf
RUN chmod 644 /etc/apache2/conf-available/wpl7-site.conf \
  && a2enmod expires remoteip rewrite headers brotli proxy proxy_fcgi actions \
  && a2dismod status \
  && a2enconf wpl7-site \
  && a2disconf other-vhosts-access-log \
  && a2dissite 000-default \
  && rm /etc/apache2/mods-enabled/mpm_event.conf /etc/apache2/mods-enabled/deflate.conf \
  && printf 'Listen 127.0.0.1:80\n' > /etc/apache2/ports.conf \
  && apache2ctl -t

# nginx's folder for cached pages belongs to www-data, so that a clear from WordPress or WP-CLI can
# delete the files. Its parent stays root's, so the folder itself can't be swapped for another.
COPY nginx.conf /etc/nginx/nginx.conf
COPY nginx-passthrough.conf /etc/nginx/wpl7-passthrough.conf
RUN chmod 644 /etc/nginx/nginx.conf /etc/nginx/wpl7-passthrough.conf \
  && rm -f /etc/nginx/sites-enabled/default \
  && install -d -m 755 /var/cache/nginx \
  && install -d -o www-data -g www-data -m 700 /var/cache/nginx/wpl7 \
  && ln -s /etc/nginx/wpl7-passthrough.conf /etc/nginx/wpl7-site.conf \
  && nginx -q -t -e stderr

COPY wpl7-start wpl7-reload /usr/local/bin/
COPY wpl7-runtime.sh /usr/local/lib/wpl7-runtime.sh
RUN chmod 755 /usr/local/bin/wpl7-start /usr/local/bin/wpl7-reload \
  && chmod 644 /usr/local/lib/wpl7-runtime.sh

EXPOSE 8080

# The base image stops with SIGQUIT, which is PHP-FPM's own way of stopping. Here TERM stops all of
# it: see wpl7-start.
STOPSIGNAL SIGTERM

# Throwaway containers replace this with php or cp, and they don't get a service started.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/wpl7-start"]
