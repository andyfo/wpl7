# @docs get-started/how-it-works, reference/third-party
# What wpl7-start and wpl7-reload share: where the panel's files are, and how they get into the
# configuration. Sourced, not run. Installed in /usr/local/lib.
#
# The panel writes these to a read-only folder mount. A file that is missing or refused is not
# fatal: the site comes up on the image's defaults (no page cache, default pool) rather than not at
# all.

RUNTIME_DIR=/etc/wpl7-runtime

NGINX_LINK=/etc/nginx/wpl7-site.conf
NGINX_PASSTHROUGH=/etc/nginx/wpl7-passthrough.conf
POOL_FILE=/usr/local/etc/php-fpm.d/zzz-wpl7-runtime.conf
INI_LINK=/usr/local/etc/php/conf.d/zy-wpl7-runtime.ini

FPM_SOCKET=/run/wpl7/php-fpm.sock
REDIS_SOCKET=/run/wpl7/redis.sock
FPM_PID_FILE=/run/php-fpm.pid

say() {
    printf '%s: %s\n' "${0##*/}" "$*" >&2
}

# Points nginx at the panel's site file, if nginx accepts it. Fails if it doesn't, with the link as
# it was and nginx's own message on stderr. With no file from the panel, nginx gets the
# pass-through.
link_nginx() {
    local previous
    previous=$(readlink "$NGINX_LINK")
    if [[ ! -f $RUNTIME_DIR/nginx-site.conf ]]; then
        ln -sfn "$NGINX_PASSTHROUGH" "$NGINX_LINK"
        say "no nginx-site.conf from the panel: the page cache is off"
        return 0
    fi
    ln -sfn "$RUNTIME_DIR/nginx-site.conf" "$NGINX_LINK"
    if nginx -q -t -e stderr; then
        return 0
    fi
    ln -sfn "$previous" "$NGINX_LINK"
    say "nginx refused the panel's nginx-site.conf"
    return 1
}

# Puts the panel's OPcache sizes and pool sizes where the next start of PHP-FPM reads them. Fails if
# PHP-FPM refuses the pool file, and what was there before stays. There is no such check for an ini
# file: PHP warns about a bad one, and goes on.
#
# The pool file is copied, not linked. A reload reads its configuration only once its requests have
# finished, up to seconds after the signal, and one it can't read ends PHP-FPM and the site with it.
# So it must read what passed the check here, not what the panel may have written since.
link_php() {
    local output candidate check status
    if [[ -f $RUNTIME_DIR/php.ini ]]; then
        ln -sfn "$RUNTIME_DIR/php.ini" "$INI_LINK"
    else
        rm -f "$INI_LINK"
        say "no php.ini from the panel: OPcache keeps the image's default sizes"
    fi
    if [[ ! -f $RUNTIME_DIR/php-fpm-pool.conf ]]; then
        rm -f "$POOL_FILE"
        say "no php-fpm-pool.conf from the panel: PHP-FPM keeps the image's default pool"
        return 0
    fi
    # Outside php-fpm.d, where a reload under way would read it.
    candidate=$(mktemp /run/wpl7-pool.XXXXXX) || return
    check=$(mktemp /run/wpl7-pool-check.XXXXXX) || return
    cp "$RUNTIME_DIR/php-fpm-pool.conf" "$candidate"
    chmod 644 "$candidate"
    printf 'include=/usr/local/etc/php-fpm.conf\ninclude=%s\n' "$candidate" > "$check"
    output=$(php-fpm -t -y "$check" 2>&1)
    status=$?
    rm -f "$check"
    if ((status == 0)); then
        mv "$candidate" "$POOL_FILE"
        return 0
    fi
    rm -f "$candidate"
    printf '%s\n' "$output" >&2
    say "PHP-FPM refused the panel's php-fpm-pool.conf"
    return 1
}
