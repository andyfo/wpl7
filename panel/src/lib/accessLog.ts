/**
 * Traefik access-log parsing.
 *
 * Traefik is the only component that sees every request for every site together with the
 * address it came from: a site container is behind the proxy, so its own Apache log records
 * Traefik's container address for every visitor on the box. The log is emitted as one JSON
 * object per line (`--accesslog.format=json`, see deploy/docker-compose.yml) and read back
 * through `docker logs`, exactly like the mail relay's.
 *
 * Everything here is pure: `TrafficService` owns the I/O, the hashing and the database.
 */
// @docs sites/visitors
import { PROXY_HEADERS, parseSecurityName, type ProxyHeader } from '../../shared/security.js';
import { resolveClient, type ProxyHeaders, type TrustedProxy } from './clientIp.js';

/** One request, as far as the statistics care. */
export interface AccessEvent {
  ts: number;
  /**
   * Traefik's per-process request counter. Strictly increasing while Traefik runs, which
   * is what lets the ingest re-read the overlap window without double-counting.
   */
  requestCount: number;
  /** Site the request was routed to; null for the panel, the dashboard, unmatched hosts. */
  slug: string | null;
  host: string;
  path: string;
  method: string;
  status: number;
  /**
   * What the site itself answered; 0 when Traefik answered without asking it - a refusal or a
   * rate limit. That is what tells the panel's own 429 from one a plugin sent.
   */
  originStatus: number;
  bytes: number;
  durationMs: number;
  /** The visitor: behind a trusted proxy, the address it vouched for (lib/clientIp.ts). */
  clientIp: string;
  /** Whoever opened the connection to Traefik - the visitor, or the proxy in front of it. */
  peerIp: string;
  /** The trusted proxy the visitor came through; null for a direct visitor. */
  via: string | null;
  /**
   * The router that answered, without its provider: `wp-<slug>` for a site's own, the
   * `wpl7sec_<kind>_<slug>` ones Security writes (which is how a blocked request is told from a
   * served one), `wpl7blk_…` for a blocked address. '' when none matched.
   */
  router: string;
  userAgent: string;
  /** Referring host only (never the full URL, which can carry query strings). */
  referrerHost: string;
}

/**
 * Router and service names are `<name>@<provider>`, and site containers are labelled
 * `wp-<slug>` (services/labels.ts) - so the site falls out of the routing decision Traefik
 * already made, rather than out of the Host header, which anything may claim. The routers
 * Security writes carry the slug in their own name (shared/security.ts).
 */
export function siteSlugFromRouter(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split('@')[0] ?? '';
  if (base.startsWith('wp-') && base.length > 3) return base.slice(3);
  return parseSecurityName(base)?.slug ?? null;
}

/** `203.0.113.7:51234`, `[2001:db8::1]:51234` -> the address. */
export function hostOfAddr(addr: string): string {
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    return end === -1 ? addr : addr.slice(1, end);
  }
  const colon = addr.lastIndexOf(':');
  // More than one colon and no brackets: an IPv6 address with no port at all.
  return colon !== -1 && addr.indexOf(':') === colon ? addr.slice(0, colon) : addr;
}

/**
 * The vendor headers of a log row. Traefik writes a kept header as `request_<Name>`, and
 * whether a CDN's spelling survives to there is not something to depend on - so the names
 * are matched without regard to case.
 */
function proxyHeadersOf(row: Record<string, unknown>): ProxyHeaders {
  const out: ProxyHeaders = {};
  const wanted = new Map<string, ProxyHeader>(PROXY_HEADERS.map((h) => [`request_${h.toLowerCase()}`, h]));
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'string' || !key.startsWith('request_')) continue;
    const header = wanted.get(key.toLowerCase());
    if (header) out[header] = value;
  }
  return out;
}

/**
 * Crawlers, previewers, scanners and scripted clients. Deliberately broad: a hosting
 * dashboard that counts every Googlebot hit as a visitor is worse than useless to an
 * agency showing a customer their numbers.
 *
 * `bot\b` and not `\bbot\b`: the convention crawlers follow is to glue the word onto their
 * name - Googlebot, bingbot, AhrefsBot, PetalBot - so demanding a word break in front of it
 * misses nearly all of them, while no browser's user agent contains "bot" at all.
 */
const BOT_RE = new RegExp(
  [
    // The naming conventions themselves.
    String.raw`bot\b`,
    String.raw`spider\b`,
    'crawler',
    'crawling',
    'slurp',
    'scraper',
    'archiver',
    'fetcher',
    'validator',
    'monitoring',
    // Link-preview agents: somebody pasted the URL, nobody read the page.
    'facebookexternalhit',
    'bingpreview',
    'embedly',
    'quora link preview',
    'skypeuripreview',
    'whatsapp',
    // Search engines that do not say "bot".
    'yandex',
    'baidu',
    'sogou',
    'duckduck',
    'petal',
    'bytespider',
    'applebot',
    'seznam',
    // Uptime and performance checkers - including the panel's own probe (lib/httpProbe.ts),
    // which hits every site once a minute, forever.
    'wpl7-probe',
    // LEGACY(ceo) - delete in 0.3.0. The probe's user agent before the rename: access logs
    // written by the panel that was running an hour ago are still being ingested.
    'ceo-panel-probe',
    'pingdom',
    'uptimerobot',
    'statuscake',
    'newrelic',
    'datadog',
    'gtmetrix',
    'lighthouse',
    'headlesschrome',
    'phantomjs',
    // An HTTP library is never a person.
    String.raw`curl/`,
    'wget',
    'python-requests',
    'python-urllib',
    'go-http-client',
    String.raw`java/`,
    'libwww',
    'okhttp',
    String.raw`axios/`,
    'node-fetch',
    'guzzle',
    'httpie',
    'postman',
    // Scanners.
    'zgrab',
    'masscan',
    'nmap',
    'nikto',
    'sqlmap',
  ].join('|'),
  'i',
);

export function isBotUserAgent(ua: string): boolean {
  // An empty user agent is never a browser; it is a script that did not bother.
  return ua.trim() === '' || BOT_RE.test(ua);
}

/**
 * Crawlers whose user agent does not announce a name the generic rules below can pick out,
 * mapped to the name a person would recognise. Matched case-insensitively as a substring.
 */
const CRAWLER_ALIASES: [RegExp, string][] = [
  [/facebookexternalhit/i, 'Facebook'],
  [/bingpreview/i, 'BingPreview'],
  [/skypeuripreview/i, 'Skype'],
  [/quora link preview/i, 'Quora'],
  [/whatsapp/i, 'WhatsApp'],
  [/embedly/i, 'Embedly'],
  [/bytespider/i, 'Bytespider'],
  [/yandex/i, 'Yandex'],
  [/baidu/i, 'Baidu'],
  [/sogou/i, 'Sogou'],
  [/duckduck/i, 'DuckDuckGo'],
  [/petal/i, 'PetalBot'],
  [/seznam/i, 'Seznam'],
  [/uptimerobot/i, 'UptimeRobot'],
  [/statuscake/i, 'StatusCake'],
  [/pingdom/i, 'Pingdom'],
  [/gtmetrix/i, 'GTmetrix'],
  [/lighthouse/i, 'Lighthouse'],
  [/headlesschrome/i, 'Headless Chrome'],
  [/phantomjs/i, 'PhantomJS'],
  [/ceo-panel-probe/i, 'Panel uptime check'],
];

/** `Googlebot/2.1`, `AhrefsBot/7.0`, `Bytespider;` - the shape most crawlers announce. */
const NAMED_CRAWLER_RE = /([A-Za-z][A-Za-z0-9._-]*(?:bot|spider|crawler|slurp))(?:[/;)\s]|$)/i;
/** Last resort: the leading `product/version` token, which is what scripted clients send. */
const PRODUCT_RE = /^([A-Za-z][A-Za-z0-9._-]*)\//;

/**
 * A display name to group a crawler's requests under.
 *
 * Grouping is the whole point, so the version is dropped: `Googlebot/2.1` and
 * `Googlebot/2.0` are one row, not two. Returns 'Other' for a user agent that trips the
 * bot test without naming itself - which is what an empty or hand-rolled one does.
 */
export function crawlerName(ua: string): string {
  const trimmed = ua.trim();
  if (trimmed === '') return 'Unidentified';
  for (const [re, name] of CRAWLER_ALIASES) {
    if (re.test(trimmed)) return name;
  }
  const named = NAMED_CRAWLER_RE.exec(trimmed);
  // Capitalised the way the crawler writes itself, so `bingbot` stays `bingbot`.
  if (named?.[1]) return named[1].slice(0, 60);
  const product = PRODUCT_RE.exec(trimmed);
  if (product?.[1]) return product[1].slice(0, 60);
  return 'Other';
}

/** Static assets: everything a browser fetches *because of* a page, not as one. */
const ASSET_EXT_RE =
  /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|m4[av]|ogg|webm|wav|avi|mov|zip|gz|tar|pdf|txt|xml|json|webmanifest)$/i;

/** Paths that are machinery rather than content: the admin, the API, cron, login probes. */
const NON_PAGE_PREFIX_RE =
  /^\/(?:wp-admin|wp-includes|wp-content|wp-json|feed|comments\/feed|xmlrpc\.php|wp-login\.php|wp-cron\.php|wp-signup\.php|wp-trackback\.php|robots\.txt|favicon\.ico|sitemap|\.well-known)/i;

/**
 * Does this request represent somebody looking at a page?
 *
 * There is no response content type in the log (keeping one more header per request only to
 * classify it is not worth the volume), so this is decided from the path and the method.
 * 3xx counts: a redirect to the canonical host is still that visitor arriving.
 */
export function isPageView(event: Pick<AccessEvent, 'path' | 'method' | 'status'>): boolean {
  if (event.method !== 'GET' && event.method !== 'HEAD') return false;
  if (event.status >= 400) return false;
  const path = event.path.split('?')[0] ?? '';
  if (NON_PAGE_PREFIX_RE.test(path)) return false;
  return !ASSET_EXT_RE.test(path);
}

/** Referrer host, lower-cased and without `www.`; '' for direct, invalid or same-site. */
export function referrerHostOf(referer: string, siteHost: string): string {
  if (!referer || referer === '-') return '';
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return '';
  }
  const bare = host.replace(/^www\./, '');
  // Internal navigation is not a referral; it would otherwise be every site's top source.
  return bare === siteHost.toLowerCase().replace(/^www\./, '') ? '' : bare;
}

/** Strip the query string and cap the length; a path is a grouping key, not a URL. */
export function normalizePath(path: string): string {
  const bare = (path.split('?')[0] ?? '').trim() || '/';
  return bare.length > 200 ? `${bare.slice(0, 200)}…` : bare;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Parse one JSON access-log line. Returns null for anything that is not one — Traefik's own
 * startup and certificate chatter shares the stream, and so does a half-written line at the
 * head of a `docker logs --since` read.
 *
 * `proxies` are the trusted ones (services/proxyRanges.ts): a request that came through one
 * of them is the visitor its header names. Without any, every peer is its own visitor.
 */
export function parseAccessLogLine(line: string, now = Date.now(), proxies: readonly TrustedProxy[] = []): AccessEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Traefik's own log lines are JSON too when --log.format=json; they carry a level and no
  // request. DownstreamStatus is the field that only an access-log entry has.
  if (typeof row.DownstreamStatus !== 'number') return null;

  const startUtc = str(row.StartUTC) || str(row.time);
  const parsed = startUtc ? Date.parse(startUtc) : NaN;
  const host = str(row.RequestHost);
  const routerName = str(row.RouterName);
  // The peer from ClientAddr, not ClientHost: Traefik writes whatever X-Forwarded-For says
  // into ClientHost, and it only strips that header from peers it does not trust. ClientAddr
  // is the socket's own other end.
  const peerIp = hostOfAddr(str(row.ClientAddr)) || str(row.ClientHost);
  const { clientIp, via } = resolveClient(peerIp, proxyHeadersOf(row), proxies);
  return {
    ts: Number.isFinite(parsed) ? parsed : now,
    requestCount: int(row.RequestCount),
    slug: siteSlugFromRouter(routerName || str(row.ServiceName)),
    host,
    path: str(row.RequestPath) || '/',
    method: str(row.RequestMethod) || 'GET',
    status: int(row.DownstreamStatus),
    originStatus: int(row.OriginStatus),
    bytes: Math.max(0, int(row.DownstreamContentSize)),
    // Traefik reports Duration in nanoseconds.
    durationMs: Math.round(int(row.Duration) / 1e6),
    clientIp,
    peerIp,
    via,
    router: routerName.split('@')[0] ?? '',
    userAgent: str(row['request_User-Agent']),
    referrerHost: referrerHostOf(str(row.request_Referer), host),
  };
}

/** Parse a whole log chunk, dropping the lines that are not access-log entries. */
export function parseAccessLog(chunk: string, now = Date.now(), proxies: readonly TrustedProxy[] = []): AccessEvent[] {
  const out: AccessEvent[] = [];
  for (const line of chunk.split('\n')) {
    if (!line) continue;
    const event = parseAccessLogLine(line, now, proxies);
    if (event) out.push(event);
  }
  return out;
}
