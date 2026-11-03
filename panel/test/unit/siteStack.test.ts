/**
 * What a stack 2 site's runtime files say (services/siteStack.ts): the sizes, and the nginx file
 * with its rules. The checks on a real nginx are the engine test's. Here the file's maps are read
 * back and worked out the way nginx does, which needs no Docker and shows what a request gets.
 */
import { describe, expect, it } from 'vitest';
import {
  FPM_POOL_IN_CONTAINER,
  FPM_SOCKET_IN_CONTAINER,
  NGINX_PASSTHROUGH_IN_CONTAINER,
  NGINX_SITE_IN_CONTAINER,
  PAGE_CACHE_DIR_IN_CONTAINER,
  PHP_INI_IN_CONTAINER,
  REDIS_CONF_IN_CONTAINER,
  REDIS_SOCKET_IN_CONTAINER,
  RUNTIME_DIR_IN_CONTAINER,
  SITE_STACK_LABEL,
  SITE_STACK_PORT,
  WP_CACHE_PHP_IN_CONTAINER,
  fpmMaxChildren,
  opcacheMb,
  redisMaxMemoryMb,
  renderFpmPool,
  renderNginxSite,
  renderPhpIni,
  renderRedisConf,
  siteBodyLimitMb,
  stackFromLabels,
  stackSizing,
} from '../../src/services/siteStack.js';
import { CACHE_RULE_GROUPS, MAX_OWN_COPY_RULES, MAX_OWN_RULES, type CacheRule } from '../../shared/cacheRules.js';

// ---------------------------------------------------------------------------
// nginx's maps, read back

interface NginxMap {
  source: string;
  entries: { from: string; to: string }[];
}

/** nginx's own unquoting: only these are special inside a quoted word. */
const unquote = (word: string) => (word.startsWith('"') ? word.slice(1, -1).replace(/\\(["'\\])/g, '$1') : word);

function readMaps(conf: string): Map<string, NginxMap> {
  const maps = new Map<string, NginxMap>();
  for (const block of conf.matchAll(/^map ("[^"]*"|\S+) (\$\w+) \{\n([\s\S]*?)^\}$/gm)) {
    const entries = block[3]!
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const words = /^\s*("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+);$/.exec(line);
        if (!words) throw new Error(`Cannot read map line: ${line}`);
        return { from: unquote(words[1]!), to: unquote(words[2]!) };
      });
    maps.set(block[2]!.slice(1), { source: unquote(block[1]!), entries });
  }
  return maps;
}

interface Request {
  method?: string;
  /** $uri, as nginx has it: decoded, in bytes (use `bytes`). */
  uri?: string;
  args?: string;
  cookie?: string;
  agent?: string;
  authorization?: string;
  upgrade?: string;
  hint?: string;
  acceptEncoding?: string;
  proto?: string;
  requestUri?: string;
  upstreamStatus?: string;
  upstreamCacheControl?: string;
  upstreamPragma?: string;
  upstreamExpires?: string;
  upstreamVary?: string;
  upstreamLocation?: string;
  upstreamAccelExpires?: string;
  host?: string;
  contentLength?: string;
  transferEncoding?: string;
  range?: string;
  requestedWith?: string;
  pjax?: string;
  htmx?: string;
  turboFrame?: string;
  origin?: string;
}

/** What nginx would have in a variable: an exact match first, then the regexes in order, then default. */
function evaluator(conf: string, request: Request) {
  const maps = readMaps(conf);
  const builtIn: Record<string, string> = {
    request_method: request.method ?? 'GET',
    uri: request.uri ?? '/',
    args: request.args ?? '',
    http_cookie: request.cookie ?? '',
    http_user_agent: request.agent ?? 'Mozilla/5.0 (X11; Linux x86_64)',
    http_authorization: request.authorization ?? '',
    http_upgrade: request.upgrade ?? '',
    http_sec_ch_ua_mobile: request.hint ?? '',
    http_accept_encoding: request.acceptEncoding ?? '',
    http_x_forwarded_proto: request.proto ?? 'https',
    request_uri: request.requestUri ?? '/',
    upstream_status: request.upstreamStatus ?? '200',
    upstream_http_cache_control: request.upstreamCacheControl ?? '',
    upstream_http_pragma: request.upstreamPragma ?? '',
    upstream_http_expires: request.upstreamExpires ?? '',
    upstream_http_vary: request.upstreamVary ?? '',
    upstream_http_location: request.upstreamLocation ?? '',
    upstream_http_x_accel_expires: request.upstreamAccelExpires ?? '',
    http_host: request.host ?? 'example.com',
    is_args: request.args ? '?' : '',
    content_length: request.contentLength ?? '',
    http_transfer_encoding: request.transferEncoding ?? '',
    http_range: request.range ?? '',
    http_x_requested_with: request.requestedWith ?? '',
    http_x_pjax: request.pjax ?? '',
    http_hx_request: request.htmx ?? '',
    http_turbo_frame: request.turboFrame ?? '',
    http_origin: request.origin ?? '',
  };
  const value = (name: string): string => {
    if (name in builtIn) return builtIn[name]!;
    const map = maps.get(name);
    if (!map) throw new Error(`No variable $${name}`);
    const input = expand(map.source);
    const exact = map.entries.find((e) => !e.from.startsWith('~') && e.from !== 'default' && e.from.toLowerCase() === input.toLowerCase());
    if (exact) return expand(exact.to);
    for (const entry of map.entries) {
      if (!entry.from.startsWith('~')) continue;
      const insensitive = entry.from.startsWith('~*');
      // JavaScript has no atomic groups. They change how long a failing match takes, not what matches.
      const source = entry.from.slice(insensitive ? 2 : 1).replaceAll('(?>', '(?:');
      const found = new RegExp(source, insensitive ? 'i' : '').exec(input);
      if (found) return expand(entry.to, found);
    }
    const fallback = map.entries.find((e) => e.from === 'default');
    return fallback ? expand(fallback.to) : '';
  };
  const expand = (text: string, captures?: RegExpExecArray): string =>
    text.replace(/\$(\w+)/g, (_, name: string) => (/^\d+$/.test(name) ? (captures?.[Number(name)] ?? '') : value(name)));
  return value;
}

// As a regex in byte mode sees them: Node's latin1 keeps each byte as one character.
const bytes = (text: string) => Buffer.from(text, 'utf8').toString('latin1');

const NOTHING_CHANGED = { off: [], own: [] };
const render = (rules: { off: string[]; own: CacheRule[] } = NOTHING_CHANGED, warn?: (message: string) => void) => renderNginxSite({ pageCache: true, rules, warn });
const skip = (conf: string, request: Request) => evaluator(conf, request)('wpl7_skip');

/** Every double-quoted word of the file, and the bare rest, for checks on what can be in it. */
const quotedWords = (conf: string) => [...conf.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => m[0]);

const own = (id: string, kind: CacheRule['kind'], match: CacheRule['match'], value: string, seconds?: number): CacheRule => ({
  id,
  kind,
  match,
  value,
  ...(seconds === undefined ? {} : { seconds }),
});

// ---------------------------------------------------------------------------

describe('the contract between the image and the panel', () => {
  it('has the agreed names and paths', () => {
    expect(SITE_STACK_LABEL).toBe('wpl7.stack');
    expect(SITE_STACK_PORT).toBe(8080);
    expect(RUNTIME_DIR_IN_CONTAINER).toBe('/etc/wpl7-runtime');
    expect(NGINX_SITE_IN_CONTAINER).toBe('/etc/wpl7-runtime/nginx-site.conf');
    expect(FPM_POOL_IN_CONTAINER).toBe('/etc/wpl7-runtime/php-fpm-pool.conf');
    expect(PHP_INI_IN_CONTAINER).toBe('/etc/wpl7-runtime/php.ini');
    expect(REDIS_CONF_IN_CONTAINER).toBe('/etc/wpl7-runtime/redis.conf');
    expect(WP_CACHE_PHP_IN_CONTAINER).toBe('/etc/wpl7-runtime/wp-cache.php');
    expect(FPM_SOCKET_IN_CONTAINER).toBe('/run/wpl7/php-fpm.sock');
    expect(REDIS_SOCKET_IN_CONTAINER).toBe('/run/wpl7/redis.sock');
    expect(PAGE_CACHE_DIR_IN_CONTAINER).toBe('/var/cache/nginx/wpl7');
    expect(NGINX_PASSTHROUGH_IN_CONTAINER).toBe('/etc/nginx/wpl7-passthrough.conf');
  });

  it('reads the stack from labels: no label means the old setup', () => {
    expect(stackFromLabels({ [SITE_STACK_LABEL]: '2' })).toBe(2);
    expect(stackFromLabels({ [SITE_STACK_LABEL]: '1' })).toBe(1);
    expect(stackFromLabels({})).toBe(1);
    expect(stackFromLabels(null)).toBe(1);
    expect(stackFromLabels(undefined)).toBe(1);
  });
});

describe('sizes', () => {
  it.each([
    // memory, OPcache, strings, then workers with no CPU cap and with 0.5, 1, 2, 4 and 16 CPUs
    [128, 48, 8, 2, 2, 2, 2, 2, 2],
    [256, 96, 8, 5, 2, 5, 5, 5, 5],
    [512, 192, 16, 10, 2, 5, 10, 10, 10],
    [1024, 192, 16, 10, 2, 5, 10, 20, 26],
    [4096, 192, 16, 10, 2, 5, 10, 20, 80],
  ])('%i MB', (memoryMb, opcache, strings, uncapped, half, one, two, four, sixteen) => {
    expect(opcacheMb(memoryMb)).toBe(opcache);
    expect(renderPhpIni(memoryMb)).toContain(`opcache.interned_strings_buffer = ${strings}\n`);
    expect(fpmMaxChildren(memoryMb, null)).toBe(uncapped);
    expect(fpmMaxChildren(memoryMb, 0.5)).toBe(half);
    expect(fpmMaxChildren(memoryMb, 1)).toBe(one);
    expect(fpmMaxChildren(memoryMb, 2)).toBe(two);
    expect(fpmMaxChildren(memoryMb, 4)).toBe(four);
    expect(fpmMaxChildren(memoryMb, 16)).toBe(sixteen);
  });

  it('gives Redis an eighth of the memory', () => {
    expect(redisMaxMemoryMb(128)).toBe(16);
    expect(redisMaxMemoryMb(256)).toBe(32);
    expect(redisMaxMemoryMb(512)).toBe(64);
    expect(redisMaxMemoryMb(1024)).toBe(128);
    expect(redisMaxMemoryMb(4096)).toBe(512);
  });

  it('keeps OPcache between its limits', () => {
    expect(opcacheMb(64)).toBe(32);
    expect(opcacheMb(65536)).toBe(192);
  });

  it('counts a CPU cap of nothing as no cap', () => {
    expect(fpmMaxChildren(4096, 0)).toBe(fpmMaxChildren(4096, null));
  });

  it('takes a fraction of a CPU', () => {
    expect(fpmMaxChildren(4096, 1.5)).toBe(7);
  });

  it('never leaves a site with one worker, whatever its limits', () => {
    expect(fpmMaxChildren(1, 0.1)).toBe(2);
  });

  it('reads a site’s limits in the units the container has them', () => {
    expect(stackSizing({ memoryBytes: 512 * 1024 * 1024, nanoCpus: 2e9 })).toEqual({ memoryMb: 512, cpus: 2 });
    expect(stackSizing({ memoryBytes: 512 * 1024 * 1024 })).toEqual({ memoryMb: 512, cpus: null });
    expect(stackSizing({ memoryBytes: 1024 * 1024 * 1024, nanoCpus: 5e8 })).toEqual({ memoryMb: 1024, cpus: 0.5 });
  });
});

describe('the small files', () => {
  it('has only pool sizes in the pool file', () => {
    const pool = renderFpmPool(512, 2);
    expect(pool).toContain('[www]\npm.max_children = 10\n');
    // Everything else is the image's: listen, user and pm itself must not come from here.
    expect(pool.split('\n').filter((l) => l && !l.startsWith(';') && l !== '[www]')).toEqual(['pm.max_children = 10']);
  });

  it('has only OPcache sizes in php.ini', () => {
    const ini = renderPhpIni(256);
    expect(ini.split('\n').filter((l) => l && !l.startsWith(';'))).toEqual([
      'opcache.memory_consumption = 96',
      'opcache.interned_strings_buffer = 8',
      'opcache.max_accelerated_files = 20000',
    ]);
  });

  it('gives Redis a socket, no port and no persistence', () => {
    const redis = renderRedisConf(512);
    expect(redis).toContain('\nport 0\n');
    expect(redis).toContain(`\nunixsocket ${REDIS_SOCKET_IN_CONTAINER}\n`);
    expect(redis).toContain('\nsave ""\n');
    expect(redis).toContain('\nappendonly no\n');
    expect(redis).toContain('\nmaxmemory 64mb\n');
    expect(redis).toContain('\nmaxmemory-policy allkeys-lru\n');
  });
});

describe('the nginx file, with the page cache off', () => {
  const conf = renderNginxSite({ pageCache: false, rules: NOTHING_CHANGED });

  it('has no cache in it', () => {
    expect(conf).not.toMatch(/proxy_cache/);
    expect(conf).not.toMatch(/^map /m);
    expect(conf).not.toContain(PAGE_CACHE_DIR_IN_CONTAINER);
  });

  it('passes everything straight through, and says so', () => {
    expect(conf).toContain('listen 8080 default_server;');
    expect(conf).toContain('location / {');
    expect(conf).not.toContain('@direct');
    expect(conf).toContain('proxy_buffering off;');
    expect(conf).toContain('proxy_pass http://apache;');
    expect(conf).toContain('add_header X-Cache-Status BYPASS always;');
    expect(conf).toContain('add_header X-Cache-Skipped off always;');
  });

  it('saves a request body before PHP sees it, so a slow sender holds no worker', () => {
    expect(conf).not.toContain('proxy_request_buffering');
  });

  it('never tells PHP a page may be stored, and repeats the headers a location replaces', () => {
    expect(conf).toContain('proxy_set_header X-Wpl7-Cache "";');
    expect(conf).toContain('proxy_set_header Host $http_host;');
    expect(conf).toContain('proxy_set_header Connection $wpl7_connection;');
    expect(conf).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(conf).toContain('proxy_set_header X-Wpl7-Server-Addr $server_addr;');
  });

  it('gives a rule no way in', () => {
    const warnings: string[] = [];
    const off = renderNginxSite({ pageCache: false, rules: { off: [], own: [own('a', 'skip', 'path', '/"; evil')] }, warn: (m) => warnings.push(m) });
    expect(off).toBe(conf);
    expect(off).not.toContain('evil');
  });
});

describe('the nginx file, with the page cache on', () => {
  const conf = render();

  it('stores only what a page asks for', () => {
    expect(conf).toContain(`proxy_cache_path ${PAGE_CACHE_DIR_IN_CONTAINER} levels=1:2 keys_zone=wpl7:16m max_size=256m inactive=10h use_temp_path=off;`);
    expect(conf).toContain('proxy_cache wpl7;');
    expect(conf).toContain('proxy_no_cache $wpl7_no_store_cookie $wpl7_no_store_status $wpl7_no_store_header $wpl7_no_store_expires $wpl7_no_store_vary;');
    // The last good page when PHP or the database has failed, and only then: a refresh refused
    // with a 401 must not leave the old page public for as long as anyone asks.
    expect(conf).toContain('proxy_cache_use_stale error timeout http_500 http_502 http_503 http_504;');
    expect(conf).not.toContain('proxy_cache_background_update');
    expect(conf).toContain('proxy_max_temp_file_size 0;');
    // Without a default time a response without X-Accel-Expires isn't stored. So nothing else is.
    expect(conf).not.toMatch(/^\s*proxy_cache_valid/m);
    // A page that turns out not to be stored would be served one at a time: see the build brief.
    expect(conf).not.toMatch(/^\s*proxy_cache_lock/m);
  });

  it('ignores what the page says for storage, but not X-Accel-Expires or a cookie', () => {
    const line = /proxy_ignore_headers Expires[^;]*;/.exec(conf)![0];
    expect(line).toContain('Cache-Control');
    expect(line).toContain('Vary');
    expect(line).not.toContain('X-Accel-Expires');
    expect(line).not.toContain('X-Accel-Buffering');
    expect(line).not.toContain('Set-Cookie');
  });

  it('gives X-Accel-Redirect no meaning on either path, as Apache alone gave it none', () => {
    expect(conf.match(/proxy_ignore_headers[^;]*X-Accel-Redirect/g)).toHaveLength(2);
  });

  it('sends skipped requests on unbuffered, without the mark', () => {
    const direct = conf.slice(conf.indexOf('location @direct'));
    expect(direct).toContain('proxy_buffering off;');
    expect(direct).not.toContain('proxy_request_buffering');
    expect(direct).not.toContain('proxy_max_temp_file_size');
    expect(direct).toContain('proxy_set_header X-Wpl7-Cache "";');
    expect(direct).toContain('add_header X-Cache-Status BYPASS always;');
    expect(direct).toContain('add_header X-Cache-Skipped $wpl7_skip always;');
    expect(direct).toContain('proxy_pass http://apache;');
    expect(direct).toContain('proxy_set_header Host $http_host;');
  });

  it('marks the path that may store a page, and blanks headers outside the key', () => {
    const cached = conf.slice(conf.indexOf('location / {'), conf.indexOf('location @direct'));
    expect(cached).toContain('error_page 418 = @direct;');
    expect(cached).toContain('if ($wpl7_skip) { return 418; }');
    expect(cached).toContain('proxy_set_header X-Wpl7-Cache 1;');
    expect(cached).toContain('proxy_set_header Host $http_host;');
    expect(cached).toContain('proxy_set_header Connection $wpl7_connection;');
    expect(cached).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(cached).toContain('proxy_set_header Accept-Encoding $wpl7_encoding;');
    expect(cached).toContain('proxy_set_header Sec-CH-UA-Mobile $wpl7_phone_hint;');
    expect(cached).toContain('add_header X-Cache-Status $upstream_cache_status always;');
    expect(cached).toContain('proxy_pass http://apache$wpl7_raw_path$wpl7_clean_args;');
    for (const header of ['X-Original-URL', 'X-Rewrite-URL', 'X-Host', 'Forwarded', 'X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override']) {
      expect(cached).toContain(`proxy_set_header ${header} "";`);
    }
  });

  it('gives PHP the cookies its maps read, in one line, and holds the Referer back', () => {
    const cached = conf.slice(conf.indexOf('location / {'), conf.indexOf('location @direct'));
    expect(cached).toContain('proxy_set_header Cookie $http_cookie;');
    expect(cached).toContain('proxy_set_header Referer "";');
    expect(cached).toContain('proxy_set_header X-Wpl7-Referer $http_referer;');
    expect(cached).toContain('proxy_set_header X-Wpl7-Server-Addr $server_addr;');
    const direct = conf.slice(conf.indexOf('location @direct'));
    expect(direct).not.toContain('Referer');
    expect(direct).toContain('proxy_set_header X-Wpl7-Server-Addr $server_addr;');
  });

  it('blanks what every browser and Cloudflare send, or nothing could fill the cache', () => {
    const cached = conf.slice(conf.indexOf('location / {'), conf.indexOf('location @direct'));
    for (const header of ['Sec-Fetch-Site', 'Sec-CH-UA', 'Upgrade-Insecure-Requests', 'DNT', 'Cache-Control', 'Priority', 'TE', 'From', 'CF-IPCountry', 'CF-Connecting-IP', 'CF-Ray', 'CDN-Loop', 'True-Client-IP']) {
      expect(cached).toContain(`proxy_set_header ${header} "";`);
    }
    // The country comes back in PHP, for a store that geolocates.
    expect(cached).toContain('proxy_set_header X-Wpl7-Country $http_cf_ipcountry;');
  });

  it('keys on everything that can change a page', () => {
    const key = /proxy_cache_key "([^"]*)";/.exec(conf)![1]!;
    // PHP sees the host with its port, so a page built with it stays in that host's copy.
    expect(key).toContain('$wpl7_proto://$http_host$wpl7_raw_path$wpl7_clean_args|');
    expect(key).toContain('$wpl7_copy_c0');
    expect(key).toContain('$wpl7_phone');
    expect(key).toContain('$wpl7_encoding');
    expect(key).not.toContain('$wpl7_copy_q0'); // in $wpl7_clean_args, in a fixed order
  });

  it('is ASCII only, whatever the rules', () => {
    // eslint-disable-next-line no-control-regex
    expect(render({ off: [], own: [own('a', 'skip', 'path', '/caf\u00e9/日本語/*')] })).toMatch(/^[\x00-\x7f]*$/);
  });

  describe('why a request skips the cache', () => {
    it.each<[string, Request]>([
      ['method', { method: 'POST' }],
      ['method', { method: 'PUT' }],
      ['method', { method: 'DELETE' }],
      ['method', { method: 'OPTIONS' }],
      ['upgrade', { upgrade: 'websocket' }],
      ['authorization', { authorization: 'Basic eDp5' }],
      ['file', { uri: '/a.mp4' }],
      ['file', { uri: '/wp-content/uploads/a.jpg' }],
      ['file', { uri: '/other.php' }],
      ['file', { uri: '/wp-login.php' }],
      ['path /wp-admin/*', { uri: '/wp-admin' }],
      ['path /wp-admin/*', { uri: '/wp-admin/' }],
      ['path /wp-admin/*', { uri: '/wp-admin/edit' }],
      ['path /wp-json/*', { uri: '/wp-json/wp/v2/posts' }],
      ['path /wp-content/*', { uri: '/wp-content/uploads/' }],
      ['path /wp-includes/*', { uri: '/wp-includes/js' }],
      ['cookie wordpress_logged_in_', { cookie: 'wordpress_logged_in_abc=1' }],
      ['cookie wordpress_logged_in_', { cookie: 'a=1; wordpress_logged_in_abc=1' }],
      ['cookie wp-postpass_', { cookie: 'wp-postpass_abc=1' }],
      ['cookie comment_author_', { cookie: 'comment_author_abc=1' }],
      ['cookie wordpress_no_cache', { cookie: 'wordpress_no_cache=1' }],
      ['cookie PHPSESSID', { cookie: 'PHPSESSID=a' }],
      ['cookie woocommerce_items_in_cart', { cookie: 'woocommerce_items_in_cart=1' }],
      ['cookie woocommerce_cart_hash', { cookie: 'woocommerce_cart_hash=1' }],
      ['cookie wp_woocommerce_session_', { cookie: 'wp_woocommerce_session_abc=1' }],
      ['cookie edd_items_in_cart', { cookie: 'edd_items_in_cart=1' }],
      ['query string', { args: 's=foo' }],
      ['query string', { args: 'add-to-cart=12' }],
      ['query string', { args: 'p=1&utm_source=x' }],
      ['agent wpl7-probe/1', { agent: 'wpl7-probe/1' }],
      ['agent wpl7-probe/1', { agent: 'something wpl7-probe/1 (x)' }],
      ['body', { contentLength: '8' }],
      ['body', { transferEncoding: 'chunked' }],
      ['ajax', { requestedWith: 'XMLHttpRequest' }],
      ['ajax', { pjax: 'true' }],
      ['ajax', { htmx: 'true' }],
      ['ajax', { turboFrame: 'main' }],
      ['ajax', { origin: 'https://elsewhere.example.net' }],
      ['range', { range: 'bytes=0-99' }],
      ['device', { hint: '?0', agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' }],
      ['device', { hint: '?1', agent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' }],
      ['path /wp-admin/*', { uri: '/WP-ADMIN/' }],
      ['cookie wordpress_logged_in_', { cookie: '\twordpress_logged_in_abc=1' }],
      // The first reason wins, and a reason with spaces comes through whole.
      ['method', { method: 'POST', uri: '/wp-admin/', cookie: 'wordpress_logged_in_a=1' }],
      ['path /wp-admin/*', { uri: '/wp-admin/', cookie: 'wordpress_logged_in_a=1', args: 's=1' }],
    ])('%s for %j', (reason, request) => {
      expect(skip(conf, request)).toBe(reason);
    });

    it.each<Request>([
      {},
      { uri: '/shop/' },
      { uri: '/a/b' },
      { method: 'HEAD' },
      { uri: '/index.php' },
      { uri: '/feed.xml' },
      { uri: '/robots.txt' },
      { uri: '/page.HTML' },
      { uri: '/data.json' },
      { uri: '/wp-sitemap.xsl' },
      { cookie: '_ga=1; wp-settings-1=x' },
      { cookie: 'somethingelse=1' }, // it may not store, but it may read
      { args: 'utm_source=x' },
      { args: 'utm_source=x&gclid=y&_ga=1&_gl=2&fbclid=3&msclkid=4&mc_cid=5&mc_eid=6&gbraid=7&wbraid=8&utm_=9&utm_a[b]=1' },
      { args: 'gclid' },
      { args: 'gclid=' },
      { args: 'gclid=1&' },
      { args: 'v=abc' },
      { args: 'v=abc&utm_source=x' },
      { agent: 'WPL7-PROBE/1' }, // case-sensitive, as nginx's ~ is
      { contentLength: '0' },
      // An Android tablet: no Mobile in the agent, ?0 in the hint, and that is no disagreement.
      { hint: '?0', agent: 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) Chrome/120 Safari/537.36' },
      { hint: '?1', agent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36' },
      { hint: '?0', agent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' },
    ])('none for %j', (request) => {
      expect(skip(conf, request)).toBe('');
    });

    // Raw on purpose: PHP would see these under other names, so they must not count as known.
    it.each(['%76=1', 'v[]=1', 'utm.source=1', 'utm%5Fsource=1', 'GCLID=1', 'gclid.x=1', 'x=1&v=1', '&&v=1', 'v=1&&gclid=2'])('query string for %s', (args) => {
      expect(skip(conf, { args })).toBe('query string');
    });
  });

  describe('separate copies', () => {
    const value = (request: Request) => evaluator(conf, request);

    it('keep a short cookie value in the key', () => {
      const get = value({ cookie: 'x=1; pll_language=de; y=2' });
      expect(get('wpl7_skip')).toBe('');
      const position = [...readMaps(conf).entries()].find(([, map]) => map.entries.some((e) => e.to === 'pll_language=$1; '))![0];
      expect(get(position)).toBe('pll_language=de; ');
    });

    it.each([
      ['pll_language=<script>', 'a value that is not a token'],
      [`pll_language=${'a'.repeat(33)}`, 'a value too long'],
      ['pll_language=', 'no value'],
      ['pll_language=de; pll_language=fr', 'twice, as PHP would read the first'],
      ['pll_language=!!; x=1; pll_language=fr', 'twice, the first one bad'],
      ['pll_language=de ; x=1', 'a space before the semicolon, which PHP would keep in the value'],
      ['\tpll_language=<script>', 'at the very start, after space, which PHP skips'],
    ])('skip for %s: %s', (cookie) => {
      expect(skip(conf, { cookie })).toBe('separate copy value');
    });

    it('do not take another cookie for the one they are after', () => {
      expect(skip(conf, { cookie: 'xpll_language=<script>' })).toBe('');
      expect(skip(conf, { cookie: 'pll_languageX=<script>' })).toBe('');
    });

    it('send only the parameter, in a fixed order', () => {
      const own2 = render({ off: [], own: [own('a', 'copy', 'query', 'lang')] });
      expect(evaluator(own2, { args: 'lang=de&v=abc&utm_source=x' })('wpl7_clean_args')).toBe('?v=abc&lang=de');
      expect(evaluator(own2, { args: 'v=abc&lang=de' })('wpl7_clean_args')).toBe('?v=abc&lang=de');
      expect(evaluator(own2, { args: 'utm_source=x' })('wpl7_clean_args')).toBe('');
      expect(evaluator(own2, {})('wpl7_clean_args')).toBe('');
    });

    it.each(['v=a&v=b', 'v&v=b', 'v=b&x=1&v=c', 'v', 'v=', 'v=a%20b', 'v=a+b', `v=${'a'.repeat(33)}`])('skip for ?%s', (args) => {
      // A known name with a value it can't key on, or twice. Both of the last ones reach PHP as something else.
      const reason = skip(conf, { args });
      expect(reason === 'separate copy value' || reason === 'query string').toBe(true);
      expect(reason).toBe(args.includes('x=1') ? 'query string' : 'separate copy value');
    });
  });

  describe('who may store a page', () => {
    const noStore = (cookie: string) => evaluator(conf, { cookie })('wpl7_no_store_cookie');

    it.each([
      '',
      '_ga=GA1.2.3',
      '_ga=1; _ga_ABC=2; _gid=3; _gat_x=4; _gcl_au=5; _fbp=6; _fbc=7; _hjSession_123=8; _clck=9; _clsk=10; _uetsid=11; __utma=12',
      '_hjid=1; _hjSessionUser_123=2; _hjFirstSeen=3; _hjAbsoluteSessionInProgress=4; _hjIncludedInSessionSample_123=5; _uetvid=6; __utmz=7',
      '__cf_bm=1; cf_clearance=2; wp-settings-1=a; wp-settings-time-1=b; wordpress_test_cookie=WP%20Cookie%20check',
      'pll_language=de',
      'pll_language=de; _ga=1; woocs_current_currency=EUR',
      'wmc_current_currency=EUR; wmc_current_currency_old=EUR',
      '_ga=1;',
      ' _ga=1 ; _gid=2',
      '_ga=a=b',
    ])('takes %j', (cookie) => {
      expect(noStore(cookie)).toBe('');
    });

    it.each([
      'session=1',
      '_ga=1; session=1',
      'session=1; _ga=1',
      // A prefix stops at the end of the name, or the next cookie would pass as part of it.
      '_ga; session=1',
      // A copy cookie is the name exactly.
      'pll_language2=de',
      'xpll_language=de',
      // PHP turns a dot into an underscore, so this would reach it as the copy cookie.
      'pll.language=de',
      'wordpress.logged.in_a=1',
      'x',
      '_ga',
      // A member cookie that only starts like an analytics one.
      '_gateway_session=alice',
      '_hjMember=alice',
      '_gid_member=alice',
      '_fbp_login=alice',
      '_ga_member=alice',
      '__utmost=alice',
      'wp-settings-member=alice',
      // PHP draws what a visitor agreed to, so these are no more harmless than a login.
      'cookieyes-consent=a',
      'CookieConsent=a',
      'cmplz_marketing=allow',
      'borlabs-cookie=x',
      'euconsent-v2=y',
      'OptanonConsent=z',
      'OptanonAlertBoxClosed=t',
    ])('refuses %j', (cookie) => {
      expect(noStore(cookie)).toBe('1');
    });

    it('takes a site’s own copy cookies, exactly', () => {
      const mine = render({ off: [], own: [own('a', 'copy', 'cookie', 'my.cookie')] });
      const of = (cookie: string) => evaluator(mine, { cookie })('wpl7_no_store_cookie');
      expect(of('my.cookie=1')).toBe('');
      expect(of('myXcookie=1')).toBe('1');
      expect(of('my.cookie2=1')).toBe('1');
    });

    it('holds each cookie in an atomic group, so a long header of them costs one pass', () => {
      expect(conf).toContain('"~^(?>\\s*(?:');
      expect(conf).toMatch(/\$wpl7_skip_query \{\n[^}]*"~\^\(\?>\(\?:/);
    });

    const header = (cacheControl: string, status = '200') => evaluator(conf, { upstreamCacheControl: cacheControl, upstreamStatus: status })('wpl7_no_store_header');

    it.each(['no-cache', 'no-store', 'private', 'NO-CACHE', 'no-cache, must-revalidate, max-age=0', 'public, no-store', 'max-age=0', 'public, s-maxage=0', 'max-age = 0', 's-maxage=00'])(
      'refuses what a later layer says: %s',
      (value) => {
        expect(header(value)).toBe('1');
      },
    );

    it.each(['', 'public', 'public, max-age=60', 'max-age=10', 's-maxage=100', 'max-age=0123'])('takes %j', (value) => {
      expect(header(value)).toBe('');
    });

    it('takes no word about a 404: WordPress sends no-cache on every one', () => {
      expect(header('no-cache, must-revalidate, max-age=0, no-store, private', '404')).toBe('');
      expect(header('no-cache', '200')).toBe('1');
      expect(header('no-cache', '301')).toBe('1');
      // A retried request is not the plain case this is for.
      expect(header('no-cache', '502, 404')).toBe('1');
    });

    it.each(['200', '301', '404'])('takes a status PHP may ask to store: %s', (status) => {
      expect(evaluator(conf, { upstreamStatus: status })('wpl7_no_store_status')).toBe('');
    });

    // A CGI Status header, which PHP-FPM obeys and PHP cannot see.
    it.each(['500', '503', '403', '302', '206', '502, 200'])('refuses any other: %s', (status) => {
      expect(evaluator(conf, { upstreamStatus: status })('wpl7_no_store_status')).toBe('1');
    });

    it('refuses Pragma: no-cache from a later layer', () => {
      expect(evaluator(conf, { upstreamPragma: 'no-cache' })('wpl7_no_store_header')).toBe('1');
      expect(evaluator(conf, { upstreamPragma: 'no-cache', upstreamStatus: '404' })('wpl7_no_store_header')).toBe('');
    });

    const expires = (value: string, status = '200') => evaluator(conf, { upstreamExpires: value, upstreamStatus: status })('wpl7_no_store_expires');

    it.each(['Thu, 01 Jan 1970 00:00:00 GMT', 'Wed, 11 Jan 1984 05:00:00 GMT', 'Mon, 26 Jul 1997 05:00:00 GMT', '0', '-1', 'not a date'])('refuses Expires from a later layer: %s', (value) => {
      expect(expires(value)).toBe('1');
    });

    it.each(['', 'Wed, 11 Jan 2034 05:00:00 GMT', 'Sun, 1 Nov 2026 12:00:00 GMT'])('takes Expires: %j', (value) => {
      expect(expires(value)).toBe('');
    });

    it('takes no word about Expires on a 404', () => {
      expect(expires('Wed, 11 Jan 1984 05:00:00 GMT', '404')).toBe('');
    });

    it('says so when PHP asked for a page to be stored and something after it refused', () => {
      const reason = (request: Request) => evaluator(conf, request)('wpl7_no_store_reason');
      expect(reason({ upstreamAccelExpires: '600', upstreamVary: 'Cookie' })).toBe('.htaccess or Apache says no-cache');
      expect(reason({ upstreamAccelExpires: '600', upstreamCacheControl: 'no-store' })).toBe('.htaccess or Apache says no-cache');
      expect(reason({ upstreamAccelExpires: '600', upstreamExpires: 'Thu, 01 Jan 1970 00:00:00 GMT' })).toBe('.htaccess or Apache says no-cache');
      // Stored, or PHP said no by itself, with a reason of its own.
      expect(reason({ upstreamAccelExpires: '600' })).toBe('');
      expect(reason({ upstreamVary: 'Cookie' })).toBe('');
      expect(reason({ upstreamAccelExpires: '300', upstreamStatus: '404', upstreamCacheControl: 'no-cache' })).toBe('');
    });

    const vary = (value: string) => evaluator(conf, { upstreamVary: value })('wpl7_no_store_vary');

    it.each(['', 'Accept-Encoding', 'accept-encoding', 'Accept-Encoding, Accept-Encoding', ' Accept-Encoding ,Accept-Encoding', 'Accept-Encoding, X-Forwarded-Proto', 'Host'])('takes Vary: %j', (value) => {
      expect(vary(value)).toBe('');
    });

    it.each(['Cookie', 'User-Agent', 'Accept-Encoding,Cookie', 'Cookie, Accept-Encoding', '*', 'X-Forwarded-Protocol'])('refuses Vary from a later layer: %s', (value) => {
      expect(vary(value)).toBe('1');
    });
  });

  describe('the rest of the key', () => {
    it('reads the scheme from what Traefik says', () => {
      expect(evaluator(conf, { proto: 'https' })('wpl7_proto')).toBe('https');
      expect(evaluator(conf, { proto: 'http' })('wpl7_proto')).toBe('http');
      expect(evaluator(conf, { proto: 'junk' })('wpl7_proto')).toBe('http');
      expect(evaluator(conf, { proto: '' })('wpl7_proto')).toBe('http');
      // WordPress reads this as not https, so a page built with it is the http copy.
      expect(evaluator(conf, { proto: 'HTTPS' })('wpl7_proto')).toBe('http');
    });

    it('cuts the query off the path, leaving the rest as it came', () => {
      expect(evaluator(conf, { requestUri: '/a%2Fb/caf%C3%A9/?x=1' })('wpl7_raw_path')).toBe('/a%2Fb/caf%C3%A9/');
      expect(evaluator(conf, { requestUri: '/plain' })('wpl7_raw_path')).toBe('/plain');
    });

    it.each([
      ['gzip, deflate, br', 'br'],
      ['br', 'br'],
      ['BR;q=0.5', 'br'],
      ['gzip', 'gzip'],
      ['gzip, deflate', 'gzip'],
      ['deflate,gzip', 'gzip'],
      ['br;q=0, gzip', 'gzip'],
      ['br;q=0.0, gzip;q=1', 'gzip'],
      ['gzip;q=0', ''],
      ['', ''],
      ['deflate', ''],
      ['x-gzip', ''],
      ['brotli', ''],
    ])('reads Accept-Encoding: %j as %j', (acceptEncoding, coding) => {
      expect(evaluator(conf, { acceptEncoding })('wpl7_encoding')).toBe(coding);
    });

    it.each([
      ['', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', 'phone'],
      ['', 'Mozilla/5.0 (Linux; Android 14) Chrome/120', 'phone'],
      ['', 'Mozilla/5.0 (X11; Linux x86_64) Silk/1', 'phone'],
      ['', 'Kindle/3.0', 'phone'],
      ['', 'BlackBerry9700', 'phone'],
      ['', 'Opera Mini/8', 'phone'],
      ['', 'Opera Mobi/1', 'phone'],
      ['', 'Mozilla/5.0 (X11; Linux x86_64)', ''],
      ['?1', 'Mozilla/5.0 (X11; Linux x86_64)', 'phone'],
      ['?0', 'Mozilla/5.0 (iPhone) Mobile', ''],
      // What wp_is_mobile() does with one: the hint is there, and is not ?1.
      ['junk', 'Mozilla/5.0 (iPhone) Mobile', ''],
      ['?1|x', 'Mozilla/5.0 (X11; Linux x86_64)', ''],
    ])('with the hint %j and the agent %s: %j, as wp_is_mobile() says', (hint, agent, phone) => {
      const get = evaluator(conf, { hint, agent });
      expect(get('wpl7_phone')).toBe(phone);
      // PHP is told, so it can only agree with the copy its page goes into.
      expect(get('wpl7_phone_hint')).toBe(phone ? '?1' : '?0');
    });
  });

  describe('a redirect gets back the tracking parameters PHP never saw', () => {
    const args = (upstreamLocation: string, query: string, host = 'example.com') => evaluator(conf, { upstreamLocation, args: query, host })('wpl7_redirect_args');

    it('replaces the header on the way out, and leaves a Refresh header alone', () => {
      const cached = conf.slice(conf.indexOf('location / {'), conf.indexOf('location @direct'));
      expect(cached).toContain('proxy_hide_header Location;');
      expect(cached).toContain('add_header Location "$upstream_http_location$wpl7_redirect_args" always;');
      expect(cached).not.toContain('proxy_redirect');
    });

    it('has them on an address with no query, for each visitor by themselves', () => {
      expect(args('https://example.com/page/', 'gclid=abc')).toBe('?gclid=abc');
      expect(args('https://example.com/page/', 'utm_source=a&utm_medium=b')).toBe('?utm_source=a&utm_medium=b');
      expect(args('/page/', 'gclid=abc')).toBe('?gclid=abc');
      expect(args('https://example.com', 'gclid=abc')).toBe('?gclid=abc');
      expect(args('https://example.com/page/', '')).toBe('');
    });

    it('adds nothing to no redirect at all', () => {
      expect(args('', 'gclid=abc')).toBe('');
    });

    it('counts www and no www as the same site, and capitals', () => {
      expect(args('https://example.com/', 'gclid=abc', 'www.example.com')).toBe('?gclid=abc');
      expect(args('https://www.example.com/', 'gclid=abc', 'example.com')).toBe('?gclid=abc');
      expect(args('https://EXAMPLE.com/', 'gclid=abc')).toBe('?gclid=abc');
    });

    it('never hands them to another site: PHP would not have', () => {
      expect(args('https://partner.example.net/landing', 'gclid=abc')).toBe('');
      expect(args('//partner.example.net/landing', 'gclid=abc')).toBe('');
      expect(args('https://example.com.partner.example.net/', 'gclid=abc')).toBe('');
      expect(args('https://partner.example.net/?a=1', 'gclid=abc')).toBe('');
      expect(args('https://example.com@partner.example.net/', 'gclid=abc')).toBe('');
    });

    it('adds them to a query of its own, like WooCommerce\'s ?v=, when there is nothing to double', () => {
      expect(args('https://example.com/shop/?v=abc', 'gclid=x')).toBe('&gclid=x');
      expect(args('https://example.com/shop/?v=abc', '')).toBe('');
      expect(args('https://example.com/shop/?v=abc', 'v=old&gclid=x')).toBe('');
    });

    it('leaves an address with a fragment as it is', () => {
      expect(args('https://example.com/page/#top', 'gclid=x')).toBe('');
      expect(args('https://example.com/page/?a=1#top', 'gclid=x')).toBe('');
    });

    it('has that map too with no separate-copy parameter at all', () => {
      const off = render({ off: ['woocommerce'], own: [] });
      expect(evaluator(off, { upstreamLocation: 'https://example.com/?a=1', args: 'gclid=x' })('wpl7_redirect_args')).toBe('&gclid=x');
      expect(evaluator(off, { upstreamLocation: 'https://example.com/a/', args: 'gclid=x' })('wpl7_redirect_args')).toBe('?gclid=x');
    });
  });

  describe('how big a request body can be', () => {
    it('leaves it to the image, unless told', () => {
      expect(conf).not.toContain('client_max_body_size');
      expect(renderNginxSite({ pageCache: false, rules: NOTHING_CHANGED })).not.toContain('client_max_body_size');
    });

    it.each([true, false])('says so at the server, with the page cache %s', (pageCache) => {
      const text = renderNginxSite({ pageCache, rules: NOTHING_CHANGED, maxBodyMb: 2064 });
      expect(text).toContain('    server_name _;\n    client_max_body_size 2064m;\n');
    });

    it.each<[string, number | undefined]>([
      ['', undefined],
      ['upload_max_filesize = 64M\npost_max_size = 64M\n', undefined],
      ['post_max_size = 1000M', undefined],
      ['post_max_size = 2G', 2064],
      ['post_max_size=2g', 2064],
      ['post_max_size = "3G"', 3088],
      ['post_max_size = 2097152K', 2064],
      ['post_max_size = 2147483648', 2064],
      ['post_max_size = 0', 0],
      ['; post_max_size = 2G\npost_max_size = 64M', undefined],
      ['post_max_size = 2G\npost_max_size = 64M', undefined],
      ['post_max_size = 64M\npost_max_size = 2G', 2064],
    ])('reads %j from uploads.ini as %j', (ini, expected) => {
      expect(siteBodyLimitMb(ini)).toBe(expected);
    });
  });

  describe('switching things off', () => {
    it('Phones: no test, and nothing about it in the key or to PHP', () => {
      const off = render({ off: ['phones'], own: [] });
      expect(off).not.toContain('$wpl7_phone');
      expect(off).not.toContain('Sec-CH-UA-Mobile');
      expect(/proxy_cache_key "[^"]*\|\|\$wpl7_encoding";/.test(off)).toBe(true);
    });

    it('a group: its cookie no longer skips, and its parameter is no longer known', () => {
      const off = render({ off: ['woocommerce'], own: [] });
      expect(skip(off, { cookie: 'woocommerce_items_in_cart=1' })).toBe('');
      expect(skip(off, { args: 'v=abc' })).toBe('query string');
      expect(off).not.toContain('$wpl7_clean_args');
      expect(off).toContain('proxy_pass http://apache$wpl7_raw_path;');
    });

    it('one rule: only that one', () => {
      const off = render({ off: ['woocommerce.items-in-cart'], own: [] });
      expect(skip(off, { cookie: 'woocommerce_items_in_cart=1' })).toBe('');
      expect(skip(off, { cookie: 'woocommerce_cart_hash=1' })).toBe('cookie woocommerce_cart_hash');
    });

    it('tracking parameters: a site that reads them gets them, by skipping', () => {
      const off = render({ off: ['tracking'], own: [] });
      expect(skip(off, { args: 'utm_source=x' })).toBe('query string');
      const one = render({ off: ['tracking.gclid'], own: [] });
      expect(skip(one, { args: 'gclid=1' })).toBe('query string');
      expect(skip(one, { args: 'fbclid=1' })).toBe('');
    });

    it('a copy cookie: nginx no longer knows it, so its visitors can read but not store', () => {
      const off = render({ off: ['languages.polylang'], own: [] });
      expect(off).not.toContain('pll_language');
      expect(evaluator(off, { cookie: 'pll_language=de' })('wpl7_no_store_cookie')).toBe('1');
      expect(skip(off, { cookie: 'pll_language=de' })).toBe('');
    });

    it('the WordPress group: not at all', () => {
      const ids = CACHE_RULE_GROUPS.find((g) => g.id === 'wordpress')!.rules.map((r) => r.id);
      const off = render({ off: ['wordpress', ...ids], own: [] });
      expect(skip(off, { cookie: 'wordpress_logged_in_a=1' })).toBe('cookie wordpress_logged_in_');
      expect(skip(off, { uri: '/wp-admin/' })).toBe('path /wp-admin/*');
      expect(skip(off, { agent: 'wpl7-probe/1' })).toBe('agent wpl7-probe/1');
    });

    it('everything else: still a working file, and the built-in tests still apply', () => {
      const off = render({ off: CACHE_RULE_GROUPS.map((g) => g.id), own: [] });
      expect(off).not.toContain('$wpl7_copy_');
      expect(off).not.toContain('$wpl7_skip_copy');
      expect(off).not.toContain('$wpl7_clean_args');
      expect(off).not.toContain('$wpl7_phone');
      expect(skip(off, { method: 'POST' })).toBe('method');
      expect(skip(off, { uri: '/a.jpg' })).toBe('file');
      expect(skip(off, { args: 'x=1' })).toBe('query string');
      expect(skip(off, {})).toBe('');
    });
  });

  describe('a site’s own rules', () => {
    const mine = render({
      off: [],
      own: [
        own('a', 'skip', 'path', '/shop/*'),
        own('b', 'skip', 'path', '/exact/'),
        own('c', 'skip', 'path', '/pre*'),
        own('d', 'skip', 'path', '/a.b/'),
        own('e', 'skip', 'cookie', 'member.'),
        own('f', 'skip', 'query', 'nocache'),
        own('g', 'skip', 'query', 'gclid'),
        own('h', 'skip', 'agent', 'Foo/5.0 (X11; Bar) Baz+1.0'),
        own('i', 'skip', 'postType', 'event'),
        own('j', 'copy', 'cookie', 'my.cookie'),
        own('k', 'copy', 'query', 'lang'),
        own('l', 'keep', 'path', '/news/*', 60),
        own('m', 'keep', 'postType', 'news', 60),
        own('n', 'ignore', 'query', 'ref_*'),
        own('o', 'ignore', 'query', 'my.param'),
      ],
    });

    it('skip by path, in any case: WordPress serves a page under any spelling of its address', () => {
      expect(skip(mine, { uri: '/SHOP/' })).toBe('path /shop/*');
      expect(skip(mine, { uri: '/Exact' })).toBe('path /exact/');
    });

    it('skip by path', () => {
      expect(skip(mine, { uri: '/shop' })).toBe('path /shop/*');
      expect(skip(mine, { uri: '/shop/x/y' })).toBe('path /shop/*');
      expect(skip(mine, { uri: '/exact' })).toBe('path /exact/');
      expect(skip(mine, { uri: '/exact/x' })).toBe('');
      expect(skip(mine, { uri: '/prefix/x' })).toBe('path /pre*');
      expect(skip(mine, { uri: '/a.b/' })).toBe('path /a.b/');
      expect(skip(mine, { uri: '/aXb/' })).toBe('');
    });

    it('skip by cookie, name as a prefix and escaped', () => {
      expect(skip(mine, { cookie: 'member.x=1' })).toBe('cookie member.');
      expect(skip(mine, { cookie: 'memberXx=1' })).toBe('');
    });

    it('skip by parameter, ahead of what is known', () => {
      expect(skip(mine, { args: 'nocache=1' })).toBe('query nocache');
      expect(skip(mine, { args: 'nocache' })).toBe('query nocache');
      expect(skip(mine, { args: 'a=1&nocache' })).toBe('query nocache');
      expect(skip(mine, { args: 'gclid=1' })).toBe('query gclid');
      expect(skip(mine, { args: 'nocachex=1' })).toBe('query string');
    });

    it('skip by user agent, taken literally', () => {
      expect(skip(mine, { agent: 'x Foo/5.0 (X11; Bar) Baz+1.0 y' })).toBe('agent Foo/5.0 (X11; Bar) Baz+1.0');
      expect(skip(mine, { agent: 'Foo/5.0 X11; Bar Bazz1.0' })).toBe('');
    });

    it('copy by cookie and by parameter', () => {
      expect(skip(mine, { cookie: 'my.cookie=x1' })).toBe('');
      expect(skip(mine, { cookie: 'my.cookie=<x>' })).toBe('separate copy value');
      expect(skip(mine, { args: 'lang=de' })).toBe('');
      expect(evaluator(mine, { args: 'lang=de' })('wpl7_clean_args')).toBe('?lang=de');
      expect(skip(mine, { args: 'lang=<x>' })).toBe('separate copy value');
    });

    it('ignore a parameter, by name or by prefix', () => {
      expect(skip(mine, { args: 'ref_abc=1&my.param=2' })).toBe('');
      expect(skip(mine, { args: 'refx=1' })).toBe('query string');
      expect(skip(mine, { args: 'myXparam=1' })).toBe('query string');
    });

    it('leave what runs in PHP out of this file', () => {
      expect(mine).not.toContain('/news/');
      expect(mine).not.toContain('event');
    });
  });

  describe('a stored rule that fails its check', () => {
    it.each<[string, CacheRule]>([
      ['closes the string', own('a', 'skip', 'path', '/"; } evil #')],
      ['a variable', own('a', 'skip', 'path', '/$request_uri')],
      ['a new line', own('a', 'skip', 'cookie', 'a\nevil on;')],
      ['closes a map', own('a', 'copy', 'cookie', 'a" "b"; } server { evil')],
      ['a backslash', own('a', 'skip', 'agent', 'a\\')],
      ['the reason separator', own('a', 'skip', 'query', 'a|b')],
      ['a quote in a parameter', own('a', 'ignore', 'query', 'a"*')],
      ['a keep time past the ceiling', own('a', 'keep', 'path', '/evil', 999_999)],
      ['a kind that does not exist', { id: 'a', kind: 'evil', match: 'path', value: '/evil' } as unknown as CacheRule],
      ['a value that is no string', { id: 'a', kind: 'skip', match: 'path', value: { evil: 1 } } as unknown as CacheRule],
    ])('is dropped, with a warning, and never rendered: %s', (_, bad) => {
      const warnings: string[] = [];
      expect(render({ off: [], own: [bad] }, (m) => warnings.push(m))).toBe(render());
      expect(warnings).toHaveLength(1);
    });

    it('takes nothing else with it', () => {
      const good = own('b', 'skip', 'path', '/good/');
      expect(render({ off: [], own: [own('a', 'skip', 'path', '/"evil'), good] })).toBe(render({ off: [], own: [good] }));
    });
  });

  describe('non-ASCII paths', () => {
    const cafe = render({ off: [], own: [own('a', 'skip', 'path', '/caf\u00e9/*')] });

    it('match $uri byte for byte, as nginx has no UTF mode here', () => {
      expect(cafe).toContain('"~*^/caf\\xC3\\xA9(?:/|$)"');
      expect(skip(cafe, { uri: bytes('/caf\u00e9') })).toBe('path /caf%C3%A9/*');
      expect(skip(cafe, { uri: bytes('/caf\u00e9/menu') })).toBe('path /caf%C3%A9/*');
      expect(skip(cafe, { uri: bytes('/cafe/') })).toBe('');
    });

    it('say so in ASCII', () => {
      expect(cafe).toContain('"path /caf%C3%A9/*"');
    });

    it('come out the same typed or percent-encoded', () => {
      expect(render({ off: [], own: [own('a', 'skip', 'path', '/caf%C3%A9/*')] })).toBe(cafe);
    });

    it('work in any script', () => {
      const conf2 = render({ off: [], own: [own('a', 'skip', 'path', '/日本語/'), own('b', 'skip', 'path', '/हिन्दी/*')] });
      expect(skip(conf2, { uri: bytes('/日本語') })).toBe('path /%E6%97%A5%E6%9C%AC%E8%AA%9E/');
      expect(skip(conf2, { uri: bytes('/हिन्दी/x') })).toMatch(/^path \/%E0%A4/);
    });
  });

  describe('what nginx will read', () => {
    /** nginx reads a word into a 4 KB buffer, and fails with "too long parameter" past it. */
    const words = (text: string) => quotedWords(text).map((w) => w.length);

    it('stays under its limit for one word, at the most a site can ask for', () => {
      const warnings: string[] = [];
      const many = Array.from({ length: MAX_OWN_RULES }, (_, i) => own(`i${i}`, 'ignore', 'query', `${'.'.repeat(60)}${String(i).padStart(4, '0')}`));
      const text = render({ off: [], own: many }, (m) => warnings.push(m));
      expect(Math.max(...words(text))).toBeLessThanOrEqual(4000);
      // What doesn't fit is said, and its request only skips the cache.
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toMatch(/too many ignored parameters/);
    });

    it('keeps separate copies and built-in parameters when that happens', () => {
      const many = [
        own('c', 'copy', 'query', 'lang'),
        ...Array.from({ length: 49 }, (_, i) => own(`i${i}`, 'ignore', 'query', `${'.'.repeat(60)}${String(i).padStart(4, '0')}`)),
      ];
      const text = render({ off: [], own: many });
      expect(skip(text, { args: 'lang=de' })).toBe('');
      expect(skip(text, { args: 'v=abc&gclid=1' })).toBe('');
    });

    it('fits the most separate copies a site can have', () => {
      const copies = Array.from({ length: MAX_OWN_COPY_RULES }, (_, i) => own(`c${i}`, 'copy', 'cookie', `${'a.'.repeat(31)}x${i}`));
      expect(Math.max(...words(render({ off: [], own: copies })))).toBeLessThan(2000);
    });

    it('has balanced braces and only whole statements', () => {
      const text = render({ off: [], own: [own('a', 'skip', 'path', '/a/*'), own('b', 'copy', 'query', 'lang')] });
      const code = text.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#.*$/gm, '');
      expect(code.match(/\{/g)!.length).toBe(code.match(/\}/g)!.length);
    });

    it('has a value only inside quotes, so its characters mean nothing', () => {
      const values = ['/shop.x~y-z_1/*', 'Foo/5.0 (X11; Bar) Baz+1.0'];
      const text = render({ off: [], own: [own('a', 'skip', 'path', values[0]!), own('b', 'skip', 'agent', values[1]!)] });
      for (const value of values) {
        const outside = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        expect(outside).not.toContain(value);
      }
    });
  });
});
