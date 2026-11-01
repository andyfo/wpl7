// @docs sites/caching
import type { ContainerLimits } from './docker.js';
import { HARMLESS_COOKIES, cachePathRegex, cacheRegexEscape, cacheRuleReason, usableCacheRules, type CacheRule, type SiteCacheRules } from '../../shared/cacheRules.js';

/**
 * What a site's container is made of, as the panel has to know it. A container built from an
 * image with this label runs nginx in front of Apache and PHP-FPM (stack 2); one without it is
 * the older Apache and mod_php (stack 1), and has none of the files below.
 *
 * The folder holding them is mounted read-only from `config/runtime/`, so nothing in the site can
 * change or delete them, and no file lands in wp-content. The image reads them at every start,
 * and they are applied to a running container in place, without rebuilding it. This module only
 * says what they contain; writing them and reloading what reads them is services/siteCaches.ts.
 */
export const SITE_STACK_LABEL = 'wpl7.stack';
export type SiteStack = 1 | 2;

/** What a container's or an image's labels say. No label means it predates all of this. */
export const stackFromLabels = (labels: Record<string, string> | null | undefined): SiteStack =>
  labels?.[SITE_STACK_LABEL] === '2' ? 2 : 1;

/** Where Traefik reaches a stack 2 container: nginx, in front of Apache on 127.0.0.1:80. */
export const SITE_STACK_PORT = 8080;

export const RUNTIME_DIR_IN_CONTAINER = '/etc/wpl7-runtime';
/** Included at `http {}` level by the image's `nginx.conf`. */
export const NGINX_SITE_IN_CONTAINER = `${RUNTIME_DIR_IN_CONTAINER}/nginx-site.conf`;
export const FPM_POOL_IN_CONTAINER = `${RUNTIME_DIR_IN_CONTAINER}/php-fpm-pool.conf`;
export const PHP_INI_IN_CONTAINER = `${RUNTIME_DIR_IN_CONTAINER}/php.ini`;
/** Only there while the object cache is on: the image starts Redis when it finds this file. */
export const REDIS_CONF_IN_CONTAINER = `${RUNTIME_DIR_IN_CONTAINER}/redis.conf`;
export const WP_CACHE_PHP_IN_CONTAINER = `${RUNTIME_DIR_IN_CONTAINER}/wp-cache.php`;
export const FPM_SOCKET_IN_CONTAINER = '/run/wpl7/php-fpm.sock';
export const REDIS_SOCKET_IN_CONTAINER = '/run/wpl7/redis.sock';
/** Owned by www-data, so WordPress and WP-CLI can delete from it; emptied at every start. */
export const PAGE_CACHE_DIR_IN_CONTAINER = '/var/cache/nginx/wpl7';
/** Baked into the image, for when the panel's file is missing or fails `nginx -t` at a start. */
export const NGINX_PASSTHROUGH_IN_CONTAINER = '/etc/nginx/wpl7-passthrough.conf';

// ---------------------------------------------------------------------------
// Sizes

/** What the sizes below are worked out from: a site's limits, in the units they are given in. */
export function stackSizing(limits: Pick<ContainerLimits, 'memoryBytes' | 'nanoCpus'>): { memoryMb: number; cpus: number | null } {
  return { memoryMb: Math.floor(limits.memoryBytes / (1024 * 1024)), cpus: limits.nanoCpus ? limits.nanoCpus / 1e9 : null };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * OPcache's share of a site's memory. A site's limit can be as low as 128 MB, so a fixed size
 * would take the room its PHP workers need. 512 MB and up get the full 192.
 */
export const opcacheMb = (memoryMb: number): number => clamp(Math.floor((memoryMb * 3) / 8), 32, 192);
const opcacheStringsMb = (memoryMb: number): number => (opcacheMb(memoryMb) >= 192 ? 16 : 8);
const OPCACHE_MAX_FILES = 20_000;

/**
 * What a PHP worker counts as, past what OPcache shares between them. Real WooCommerce at 512 MB
 * came to 11 to 18 MB per worker waiting on something, and most of the rest of a busy one is shared.
 */
const FPM_WORKER_MB = 32;
/**
 * Past this, workers doing real work only take turns. Workers that wait are another matter: on a
 * remote service, on a slow visitor, or on a call to the site itself, which deadlocks once all the
 * workers are making one. With mod_php a site had 150. Each slow PHP download holds one too.
 */
const FPM_WORKERS_PER_CPU = 5;
/** A site without a CPU cap: the host's count isn't known here, so count it as two. */
const FPM_CPUS_WHEN_UNCAPPED = 2;

/**
 * How many PHP requests a site runs at once. What memory leaves after OPcache, between 2 and 5
 * per CPU, so a burst queues at FPM instead of running the site out of memory.
 */
export function fpmMaxChildren(memoryMb: number, cpus: number | null): number {
  const byMemory = Math.floor((memoryMb - opcacheMb(memoryMb)) / FPM_WORKER_MB);
  const byCpu = Math.floor(FPM_WORKERS_PER_CPU * (cpus && cpus > 0 ? cpus : FPM_CPUS_WHEN_UNCAPPED));
  return Math.max(2, Math.min(byMemory, byCpu));
}

/** An eighth of the site's memory: it comes out of the site's own limit. */
export const redisMaxMemoryMb = (memoryMb: number): number => Math.max(16, Math.floor(memoryMb / 8));

// ---------------------------------------------------------------------------
// The small files

const written = (comment: string) =>
  [`${comment} Written by the WPL7 panel from this site's limits, and mounted read-only.`, `${comment} Change them in the panel: an edit here is overwritten.`, ''].join('\n');

/** Only what depends on the site: the rest of the pool is the image's, in `php-fpm.d`. */
export function renderFpmPool(memoryMb: number, cpus: number | null): string {
  return `${written(';')}[www]\npm.max_children = ${fpmMaxChildren(memoryMb, cpus)}\n`;
}

/**
 * OPcache's sizes are PHP_INI_SYSTEM, read once when FPM starts, so the pool file cannot hold
 * them. They can't go in `uploads.ini` either: operators edit that, and backups restore it. The
 * image links this file into `conf.d`.
 */
export function renderPhpIni(memoryMb: number): string {
  return [
    `${written(';')}opcache.memory_consumption = ${opcacheMb(memoryMb)}`,
    `opcache.interned_strings_buffer = ${opcacheStringsMb(memoryMb)}`,
    `opcache.max_accelerated_files = ${OPCACHE_MAX_FILES}`,
    '',
  ].join('\n');
}

/**
 * Socket only: no port for the site's network to reach, and only www-data (FPM and WP-CLI alike)
 * can use it. No persistence, because it is a cache and every container start begins empty. The
 * least recently used keys go first when it is full, whatever their expiry.
 */
export function renderRedisConf(memoryMb: number): string {
  return [
    `${written('#')}port 0`,
    `unixsocket ${REDIS_SOCKET_IN_CONTAINER}`,
    'unixsocketperm 600',
    'daemonize no',
    'logfile ""',
    'save ""',
    'appendonly no',
    `maxmemory ${redisMaxMemoryMb(memoryMb)}mb`,
    'maxmemory-policy allkeys-lru',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// nginx

export interface NginxSiteOptions {
  pageCache: boolean;
  /** What the site keeps; the rules in force are worked out from it, the WordPress group included. */
  rules: Pick<SiteCacheRules, 'off' | 'own'>;
  /** Told about each stored rule that is left out, for the job log. */
  warn?: (message: string) => void;
  /** More than the image's ceiling on a request body, from `siteBodyLimitMb`. 0 is no ceiling. */
  maxBodyMb?: number;
}

/** The image's `client_max_body_size` (nginx.conf). */
const BODY_LIMIT_MB = 1024;
/** So that a form on top of a file of exactly post_max_size still gets as far as PHP. */
const BODY_LIMIT_MARGIN_MB = 16;

/**
 * What nginx has to take for a site whose PHP settings allow more than the image's ceiling, so
 * that nothing that worked before is refused. Read from `uploads.ini`, which operators edit. A
 * `post_max_size` of 0 is PHP's "no limit", and then this is too. Undefined: the ceiling will do.
 */
export function siteBodyLimitMb(uploadsIni: string): number | undefined {
  // The last one counts, as when PHP reads the file.
  const found = [...uploadsIni.matchAll(/^[ \t]*post_max_size[ \t]*=[ \t]*["']?(\d+)[ \t]*([KkMmGg]?)/gm)].at(-1);
  if (!found) return undefined;
  const value = Number(found[1]);
  if (value === 0) return 0;
  const unit = { k: 1 / 1024, m: 1, g: 1024 }[found[2]!.toLowerCase()] ?? 1 / (1024 * 1024);
  const needed = Math.ceil(value * unit) + BODY_LIMIT_MARGIN_MB;
  return needed > BODY_LIMIT_MB ? needed : undefined;
}

/** nginx reads one word of its config into a 4 KB buffer, and refuses a longer one. */
const NGINX_LONGEST_WORD = 4000;

/** A separate-copy value: short, so a visitor making up cookies cannot fill the cache with junk. */
const COPY_VALUE = '[A-Za-z0-9_-]{1,32}';

const HEADER = [
  "# Written by the WPL7 panel from this site's caching settings, and mounted read-only.",
  '# Change them in the panel: an edit here is overwritten.',
];

/** What Apache alone ignored, and would mean something to nginx. */
const IGNORE_ACCEL = 'X-Accel-Redirect X-Accel-Limit-Rate X-Accel-Charset';

/** A location-level proxy_set_header replaces the ones from `nginx.conf`, so each location has these. */
const COMMON_PROXY_HEADERS = [
  'proxy_set_header Host $http_host;',
  'proxy_set_header Connection $wpl7_connection;',
  'proxy_set_header Upgrade $http_upgrade;',
  'proxy_set_header X-Wpl7-Server-Addr $server_addr;',
];

/**
 * Every browser or crawler sends these, and they are blanked on the path that may store a page. With
 * them, nothing could fill the cache: PHP refuses to store for a request with a header it doesn't
 * know (wpl7_cache_unknown_request_header in services/wpCachePhp.ts). Nothing draws a page by these.
 */
const NOISE_HEADERS = [
  'Sec-Fetch-Site',
  'Sec-Fetch-Mode',
  'Sec-Fetch-User',
  'Sec-Fetch-Dest',
  'Sec-Fetch-Storage-Access',
  'Sec-CH-UA',
  'Sec-CH-UA-Platform',
  'Upgrade-Insecure-Requests',
  'DNT',
  'Sec-GPC',
  'Cache-Control',
  'Pragma',
  'Priority',
  'TE',
  'From',
  'Save-Data',
  'Purpose',
  'Sec-Purpose',
  'X-Moz',
];

/**
 * What Cloudflare adds to every request of a site it proxies, which would otherwise stop such a site
 * from ever storing a page. A plugin could draw one visitor's address or country into a page for
 * everyone, so they go too. The country comes back for a store that geolocates: X-Wpl7-Country.
 */
const CLOUDFLARE_HEADERS = [
  'CF-Connecting-IP',
  'CF-Connecting-IPv6',
  'CF-Pseudo-IPv4',
  'CF-IPCountry',
  'CF-IPCity',
  'CF-IPContinent',
  'CF-IPLatitude',
  'CF-IPLongitude',
  'CF-Metro-Code',
  'CF-Postal-Code',
  'CF-Region',
  'CF-Region-Code',
  'CF-Timezone',
  'CF-Ray',
  'CF-Visitor',
  'CF-EW-Via',
  'CDN-Loop',
  'True-Client-IP',
];

/** Ways to ask PHP to be something else, which a stored page must not depend on. */
const REQUEST_REWRITING_HEADERS = ['X-Original-URL', 'X-Rewrite-URL', 'X-Host', 'Forwarded', 'X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override'];

/** Cache-Control, Expires, Pragma or Vary from what comes after PHP: in practice a line in a .htaccess. */
const LATER_LAYER_REASON = '.htaccess or Apache says no-cache';

/** A request for part of a page, or from another site's script: it gets what PHP says, not a stored page. */
const AJAX_HEADER_VARIABLES = '$http_x_requested_with$http_x_pjax$http_hx_request$http_turbo_frame$http_origin';

const quoted = (text: string) => `"${text}"`;

type MapEntry = readonly [from: string, to: string];

function nginxMap(source: string, variable: string, entries: readonly MapEntry[]): string {
  return [`map ${source} ${variable} {`, ...entries.map(([from, to]) => `    ${from} ${to};`), '}'].join('\n');
}

const regexEntry = (regex: string, to: string): MapEntry => [quoted(`~${regex}`), quoted(to)];

function server(locations: string[], maxBodyMb: number | undefined): string {
  const body = maxBodyMb === undefined ? [] : [`    client_max_body_size ${maxBodyMb}m;`];
  return ['server {', `    listen ${SITE_STACK_PORT} default_server;`, '    server_name _;', ...body, '', ...locations, '}'].join('\n');
}

function location(name: string, lines: readonly string[]): string {
  return [`    location ${name} {`, ...lines.map((line) => (line === '' ? '' : `        ${line}`)), '    }'].join('\n');
}

/**
 * The cache is off: every request goes straight through. Answers come back as they are made, and
 * nothing of them is written to disk. Request bodies are saved first, so that a slow sender holds
 * no PHP worker: `nginx.conf` says how much of that there can be.
 */
function renderPassThrough(maxBodyMb: number | undefined): string {
  return `${[
    ...HEADER,
    '# The page cache is off for this site.',
    '',
    server(
      [
        location('/', [
          'proxy_buffering off;',
          `proxy_ignore_headers ${IGNORE_ACCEL};`,
          ...COMMON_PROXY_HEADERS,
          'proxy_set_header X-Wpl7-Cache "";',
          'add_header X-Cache-Status BYPASS always;',
          'add_header X-Cache-Skipped off always;',
          'proxy_pass http://apache;',
        ]),
      ],
      maxBodyMb,
    ),
  ].join('\n')}\n`;
}

/** Where a cookie can start. PHP skips space at the very start too, so a regex has to as well. */
const COOKIE_START = '(?:^\\s*|;\\s*)';

/**
 * A copy cookie's map: "name=value; " for a short token, "" when it is absent, and "!" otherwise
 * (the request then skips the cache). Sent twice it is "!" too: PHP reads the first one, and the
 * regex below would look past a first one it dislikes and key on the second, which would put the
 * page PHP built for one value in another value's copy.
 */
function copyCookieEntries(name: string): MapEntry[] {
  const at = `${COOKIE_START}${cacheRegexEscape(name)}=`;
  return [
    ['default', '""'],
    regexEntry(`${at}.*;\\s*${cacheRegexEscape(name)}=`, '!'),
    // Nothing between the value and the `;`: PHP would keep a space in the value, and key on a
    // cookie that isn't the one it reads.
    regexEntry(`${at}(${COPY_VALUE})(?:;|$)`, `${name}=$1; `),
    regexEntry(at, '!'),
  ];
}

/** The same for a parameter: "&name=value". Twice is "!", because PHP reads the last and a regex the first. */
function copyQueryEntries(name: string): MapEntry[] {
  const escaped = cacheRegexEscape(name);
  return [
    ['default', '""'],
    regexEntry(`(?:^|&)${escaped}(?:=[^&]*)?&(?:.*&)?${escaped}(?:=|&|$)`, '!'),
    regexEntry(`(?:^|&)${escaped}=(${COPY_VALUE})(?:&|$)`, `&${name}=$1`),
    regexEntry(`(?:^|&)${escaped}(?:=|&|$)`, '!'),
  ];
}

/** An ignored parameter as a regex alternative: `utm_*` is any name starting so. */
const ignoredName = (value: string) => (value.endsWith('*') ? `${cacheRegexEscape(value.slice(0, -1))}[^=&]*` : cacheRegexEscape(value));

/**
 * The one regex that says a query string holds only parameters the cache knows. It works on the
 * raw string on purpose: %76=1, v[]=1 and utm.source=1 reach PHP under other names, so they must
 * not count as known. Each parameter is atomic, so one the regex can't place can't send it back
 * through every way of matching the ones before it.
 *
 * Fifty long names would not fit in one word of nginx's config. Separate copies come first, so
 * what goes is an ignored parameter, and a request with one then only skips the cache.
 */
function knownQueryEntry(copies: readonly CacheRule[], ignored: readonly CacheRule[], warn: NginxSiteOptions['warn']): MapEntry | null {
  const wrap = (alternatives: readonly string[]) => `^(?>(?:${alternatives.join('|')})(?:=[^&]*)?(?:&|$))+$`;
  const fitting = copies.map((rule) => cacheRegexEscape(rule.value));
  for (const rule of ignored) {
    const name = ignoredName(rule.value);
    if (wrap([...fitting, name]).length > NGINX_LONGEST_WORD) {
      warn?.(`Cache rule ${JSON.stringify(rule.id)} left out: too many ignored parameters for one site`);
    } else {
      fitting.push(name);
    }
  }
  return fitting.length > 0 ? regexEntry(wrap(fitting), '') : null;
}

/**
 * Only a request with no unknown cookies may store a page: see HARMLESS_COOKIES. A name has to be
 * followed by `=`, or `_ga; session=1` would pass `session` off as harmless. Atomic like the one
 * above: a long cookie header would otherwise cost more for each cookie in it.
 */
function noStoreCookieEntries(copyCookies: readonly string[]): MapEntry[] {
  const name = [...copyCookies.map(cacheRegexEscape), ...HARMLESS_COOKIES].join('|');
  return [['""', '""'], regexEntry(`^(?>\\s*(?:${name})=[^;]*(?:;|$))*\\s*$`, ''), ['default', '"1"']];
}

/** A coding the client takes, and didn't refuse with `;q=0`. */
const acceptsCoding = (coding: string) => `(?:^|[,\\s])${coding}(?!\\s*;\\s*q=0(?:\\.0*)?\\s*(?:,|$))(?:[,;\\s]|$)`;

/**
 * What came off a redirect's address goes back on, because PHP never saw it: a click id or a
 * campaign must survive `/page` becoming `/page/`. Only on a redirect within the site, because an
 * address elsewhere never got those from PHP either, and they are the visitor's own, so a stored 301
 * gives each visitor theirs. A `www.` either way counts as the same site.
 *
 * An address with a query of its own, like WooCommerce's ?v=, only gets them when they are all there
 * is to add, because a copy parameter would then be in it twice. The location replaces the header
 * rather than using proxy_redirect, which would apply this to a Refresh header too, and whose regex
 * can't hold a variable, so the host couldn't be compared there.
 */
function redirectMaps(copyQueries: boolean): string[] {
  return [
    nginxMap(quoted('$upstream_http_location|$http_host'), '$wpl7_redirect_here', [
      ['default', '""'],
      regexEntry('^/(?!/)', '1'),
      [quoted('~*^https?://(?:www\\.)?([^/?#|]+)(?:[/?#][^|]*)?\\|(?:www\\.)?\\1$'), '"1"'],
    ]),
    nginxMap(quoted(`$wpl7_redirect_here|$upstream_http_location|$args|${copyQueries ? '$wpl7_clean_args' : ''}`), '$wpl7_redirect_args', [
      ['default', '""'],
      regexEntry('^1\\|[^?#|]*\\|(.+)\\|', '?$1'),
      regexEntry('^1\\|[^#|]*\\|(.+)\\|$', '&$1'),
    ]),
  ];
}

function renderCachedSite(rules: readonly CacheRule[], warn: NginxSiteOptions['warn'], maxBodyMb: number | undefined): string {
  const values = (kind: CacheRule['kind'], match: CacheRule['match']) => rules.filter((r) => r.kind === kind && r.match === match);
  const copyCookies = values('copy', 'cookie').map((r) => r.value);
  const copyQueries = values('copy', 'query');
  const phones = values('copy', 'phone').length > 0;

  const cookieVars = copyCookies.map((_, i) => `$wpl7_copy_c${i}`);
  const queryVars = copyQueries.map((_, i) => `$wpl7_copy_q${i}`);
  const copyVars = [...cookieVars, ...queryVars];

  const knownQuery = knownQueryEntry(copyQueries, values('ignore', 'query'), warn);
  const skipReasons = [
    '$wpl7_skip_method',
    '$wpl7_skip_upgrade',
    '$wpl7_skip_auth',
    '$wpl7_skip_file',
    '$wpl7_skip_path',
    '$wpl7_skip_cookie',
    '$wpl7_skip_query',
    '$wpl7_skip_agent',
    '$wpl7_skip_body',
    '$wpl7_skip_ajax',
    '$wpl7_skip_range',
    ...(phones ? ['$wpl7_skip_device'] : []),
    ...(copyVars.length > 0 ? ['$wpl7_skip_copy'] : []),
  ];
  const cacheKey = [
    `$wpl7_proto://$http_host$wpl7_raw_path${queryVars.length > 0 ? '$wpl7_clean_args' : ''}`,
    cookieVars.join(''),
    phones ? '$wpl7_phone' : '',
    '$wpl7_encoding',
  ].join('|');
  const upstream = `http://apache$wpl7_raw_path${queryVars.length > 0 ? '$wpl7_clean_args' : ''}`;

  return `${[
    ...HEADER,
    '',
    `proxy_cache_path ${PAGE_CACHE_DIR_IN_CONTAINER} levels=1:2 keys_zone=wpl7:16m max_size=256m inactive=10h use_temp_path=off;`,
    '',
    ...(copyVars.length > 0
      ? [
          '# Separate copies. Each map yields "name=value; " for a cookie or "&name=value" for a parameter, "" when',
          '# absent, and "!" when present with a value that is not a short token: the request then skips the cache.',
          ...copyCookies.map((name, i) => nginxMap('$http_cookie', cookieVars[i]!, copyCookieEntries(name))),
          ...copyQueries.map((rule, i) => nginxMap('$args', queryVars[i]!, copyQueryEntries(rule.value))),
          '',
        ]
      : []),
    '# Why a request skips the cache. A map gives the first match, so a skip comes before what is known.',
    nginxMap('$args', '$wpl7_skip_query', [
      ['""', '""'],
      ...values('skip', 'query').map((r) => regexEntry(`(?:^|&)${cacheRegexEscape(r.value)}(?:=|&|$)`, cacheRuleReason(r))),
      ...(knownQuery ? [knownQuery] : []),
      ['default', '"query string"'],
    ]),
    nginxMap('$http_cookie', '$wpl7_skip_cookie', [
      ['default', '""'],
      ...values('skip', 'cookie').map((r) => regexEntry(`${COOKIE_START}${cacheRegexEscape(r.value)}`, cacheRuleReason(r))),
    ]),
    "# WordPress serves a page under any spelling of its address, so a rule is for all of them.",
    nginxMap('$uri', '$wpl7_skip_path', [
      ['default', '""'],
      ...values('skip', 'path').map((r): MapEntry => [quoted(`~*${cachePathRegex(r.value)}`), quoted(cacheRuleReason(r))]),
    ]),
    '# Anything that looks like a file goes straight through, because the cache would strip Range and spool it',
    '# to disk. Except what WordPress can render itself.',
    nginxMap('$uri', '$wpl7_skip_file', [
      ['default', '""'],
      regexEntry('^/index\\.php$', ''),
      [quoted('~*\\.(?:html?|xml|xsl|txt|json)$'), '""'],
      regexEntry('\\.[A-Za-z0-9]{1,10}$', 'file'),
    ]),
    nginxMap('$http_user_agent', '$wpl7_skip_agent', [
      ['default', '""'],
      ...values('skip', 'agent').map((r) => regexEntry(cacheRegexEscape(r.value), cacheRuleReason(r))),
    ]),
    nginxMap('$request_method', '$wpl7_skip_method', [['GET', '""'], ['HEAD', '""'], ['default', '"method"']]),
    '# A site behind .htaccess Basic auth would otherwise store a page for a logged-in request and give it to anyone.',
    nginxMap('$http_authorization', '$wpl7_skip_auth', [['""', '""'], ['default', '"authorization"']]),
    nginxMap('$http_upgrade', '$wpl7_skip_upgrade', [['""', '""'], ['default', '"upgrade"']]),
    "# PHP can read a GET's body, and a page built from one is that visitor's.",
    nginxMap(quoted('$content_length$http_transfer_encoding'), '$wpl7_skip_body', [['""', '""'], ['"0"', '""'], ['default', '"body"']]),
    nginxMap(quoted(AJAX_HEADER_VARIABLES), '$wpl7_skip_ajax', [['""', '""'], ['default', '"ajax"']]),
    '# The cache strips Range, so a download at an address with no extension would lose seeking and resume.',
    nginxMap('$http_range', '$wpl7_skip_range', [['""', '""'], ['default', '"range"']]),
    ...(phones
      ? [
          '# The client hint and the user agent disagreeing is either device emulation or a visitor picking a copy. A',
          '# theme reading the user agent would freeze the wrong one. A tablet says ?0 with Android and no Mobile, and that is no',
          '# disagreement.',
          nginxMap(quoted('$http_sec_ch_ua_mobile|$http_user_agent'), '$wpl7_skip_device', [
            ['default', '""'],
            regexEntry('^\\?0\\|.*Mobile', 'device'),
            regexEntry('^\\?1\\|(?!.*(?:Mobile|Android|Silk/|Kindle|BlackBerry|Opera Mini|Opera Mobi))', 'device'),
          ]),
        ]
      : []),
    ...(copyVars.length > 0
      ? [nginxMap(quoted(copyVars.join('')), '$wpl7_skip_copy', [['default', '""'], regexEntry('!', 'separate copy value')])]
      : []),
    '# The first reason found, or nothing. A reason cannot hold `|`: no rule value may contain it.',
    nginxMap(quoted(skipReasons.join('|')), '$wpl7_skip', [['default', '""'], regexEntry('^\\|*([^|]+)', '$1')]),
    '',
    '# What goes to Apache: the path as it came, and only the separate-copy parameters, in a fixed order.',
    nginxMap('$request_uri', '$wpl7_raw_path', [regexEntry('^([^?]*)', '$1')]),
    ...(queryVars.length > 0 ? [nginxMap(quoted(queryVars.join('')), '$wpl7_clean_args', [['default', '""'], regexEntry('^&(.*)$', '?$1')])] : []),
    '',
    '# The rest of the key. The host is as PHP will see it, port and all: a page built with it in its links',
    '# must not reach anyone who asked for the plain name.',
    '# A regex, because a plain string in a map ignores case, and WordPress reads HTTPS as not https.',
    nginxMap('$http_x_forwarded_proto', '$wpl7_proto', [['default', '"http"'], regexEntry('^https$', 'https')]),
    nginxMap('$http_accept_encoding', '$wpl7_encoding', [
      ['default', '""'],
      [quoted(`~*${acceptsCoding('br')}`), '"br"'],
      [quoted(`~*${acceptsCoding('gzip')}`), '"gzip"'],
    ]),
    ...(phones
      ? [
          '# The same test as wp_is_mobile(): the client hint if it is there, else the user agent. PHP is then told',
          '# the answer, so wp_is_mobile() can only ever agree with the copy its page goes into.',
          nginxMap('$http_user_agent', '$wpl7_phone_agent', [
            ['default', '""'],
            regexEntry('(?:Mobile|Android|Silk/|Kindle|BlackBerry|Opera Mini|Opera Mobi)', 'phone'),
          ]),
          nginxMap('$http_sec_ch_ua_mobile', '$wpl7_phone', [['""', '$wpl7_phone_agent'], ['"?1"', '"phone"'], ['default', '""']]),
          nginxMap('$wpl7_phone', '$wpl7_phone_hint', [['phone', '"?1"'], ['default', '"?0"']]),
        ]
      : []),
    '',
    '# Only a request with no unknown cookies stores a page. It can still get a HIT.',
    nginxMap('$http_cookie', '$wpl7_no_store_cookie', noStoreCookieEntries(copyCookies)),
    "# X-Accel-Expires outranks all of these in nginx, so refuse what a later layer says, such as a .htaccess' Header",
    '# line, or a CGI Status header, which PHP cannot see. Not on a 404: WordPress sends no-cache on every one of its own,',
    '# so there it says nothing about the page.',
    nginxMap('$upstream_status', '$wpl7_no_store_status', [['200', '""'], ['301', '""'], ['404', '""'], ['default', '"1"']]),
    nginxMap(quoted('$upstream_status|$upstream_http_cache_control|$upstream_http_pragma'), '$wpl7_no_store_header', [
      ['default', '""'],
      regexEntry('^404\\|', ''),
      [quoted('~*(?:no-cache|no-store|private|[|,\\s](?:s-maxage|max-age)\\s*=\\s*0+\\s*(?:[,|]|$))'), '"1"'],
    ]),
    '# A date from 2020 on, which is all a regex can tell of the future. Anything else counts as the past: "0" often does.',
    nginxMap(quoted('$upstream_status|$upstream_http_expires'), '$wpl7_no_store_expires', [
      ['default', '"1"'],
      regexEntry('^404\\|', ''),
      regexEntry('^[^|]*\\|$', ''),
      regexEntry('^[^|]*\\|[A-Za-z]{3},\\s+\\d{1,2}\\s+[A-Za-z]{3}\\s+20[2-9]\\d\\s', ''),
    ]),
    '# What the key has already. A .htaccess adds the proxy header by itself, when a rewrite condition reads it.',
    nginxMap('$upstream_http_vary', '$wpl7_no_store_vary', [['""', '""'], [quoted('~*^(?:\\s*(?:accept-encoding|x-forwarded-proto|host)\\s*(?:,|$))+$'), '""'], ['default', '"1"']]),
    '# PHP asked for the page to be stored, and something after it said no. A site should be able to see why it has no cache.',
    nginxMap(quoted('$upstream_http_x_accel_expires|$wpl7_no_store_header$wpl7_no_store_expires$wpl7_no_store_vary'), '$wpl7_no_store_reason', [
      ['default', '""'],
      regexEntry('^[^|]+\\|1', LATER_LAYER_REASON),
    ]),
    '',
    ...redirectMaps(queryVars.length > 0),
    '',
    server(
      [
        location('/', [
          'error_page 418 = @direct;',
          'if ($wpl7_skip) { return 418; }',
          '',
          'proxy_cache wpl7;',
          `proxy_cache_key ${quoted(cacheKey)};`,
          '# No proxy_cache_valid: a response without X-Accel-Expires is not stored, and only wp-cache.php sends it.',
          `proxy_ignore_headers Expires Cache-Control Vary ${IGNORE_ACCEL};`,
          'proxy_no_cache $wpl7_no_store_cookie $wpl7_no_store_status $wpl7_no_store_header $wpl7_no_store_expires $wpl7_no_store_vary;',
          '# The last good page when PHP or the database has failed, and only then. An expired page whose refresh says',
          '# anything else, such as a 401 from a site just locked, must not go on being served.',
          'proxy_cache_use_stale error timeout http_500 http_502 http_503 http_504;',
          "# A response PHP doesn't mark for storing is sent as it comes. A download at an address with no extension",
          '# would otherwise put up to 1 GB per visitor on the disk.',
          'proxy_max_temp_file_size 0;',
          '# PHP never saw the tracking parameters, so a redirect gets them back on the way out.',
          'proxy_hide_header Location;',
          '',
          ...COMMON_PROXY_HEADERS,
          'proxy_set_header Accept-Encoding $wpl7_encoding;',
          ...(phones ? ['proxy_set_header Sec-CH-UA-Mobile $wpl7_phone_hint;'] : []),
          'proxy_set_header X-Wpl7-Cache 1;',
          '# nginx joins several Cookie lines with `;` and Apache would with `,`. PHP has to read what the maps read.',
          'proxy_set_header Cookie $http_cookie;',
          '# Plugins print the Referer into forms, with whatever it holds. wp-cache.php gives it back for what runs',
          '# before a page is drawn: hotlink checks and click counters read it.',
          'proxy_set_header Referer "";',
          'proxy_set_header X-Wpl7-Referer $http_referer;',
          'proxy_set_header X-Wpl7-Country $http_cf_ipcountry;',
          ...[...REQUEST_REWRITING_HEADERS, ...NOISE_HEADERS, ...CLOUDFLARE_HEADERS].map((header) => `proxy_set_header ${header} "";`),
          '',
          'add_header X-Cache-Status $upstream_cache_status always;',
          'add_header X-Cache-Skipped $wpl7_no_store_reason always;',
          'add_header Location "$upstream_http_location$wpl7_redirect_args" always;',
          '',
          `proxy_pass ${upstream};`,
        ]),
        '',
        location('@direct', [
          'proxy_buffering off;',
          `proxy_ignore_headers ${IGNORE_ACCEL};`,
          ...COMMON_PROXY_HEADERS,
          'proxy_set_header X-Wpl7-Cache "";',
          'add_header X-Cache-Status BYPASS always;',
          'add_header X-Cache-Skipped $wpl7_skip always;',
          'proxy_pass http://apache;',
        ]),
      ],
      maxBodyMb,
    ),
  ].join('\n')}\n`;
}

/** The nginx file for a site. Every stored rule is checked again here, and one that fails is left out. */
export function renderNginxSite(opts: NginxSiteOptions): string {
  return opts.pageCache ? renderCachedSite(usableCacheRules(opts.rules, opts.warn), opts.warn, opts.maxBodyMb) : renderPassThrough(opts.maxBodyMb);
}
