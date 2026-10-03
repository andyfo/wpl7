/**
 * A site's protection as a Traefik rules file - `<SRV_ROOT>/traefik/dynamic/sec-<slug>.yml`
 * on the server it runs on. Pure: services/security.ts decides what to write where.
 *
 * The file adds routers in front of the site's own (its container's label router, which stays
 * as the fallback): each matches the site's hosts plus a condition, and the highest priority
 * that matches answers. Refusals and custom blocks come first, then the bypass for the fleet's
 * own traffic, then the limited routes, then the catch-all that carries the request limit and
 * the headers.
 *
 * What Traefik does with a broken file decides how careful this has to be:
 * - a router whose service or middleware is missing is skipped and the rest keep working, so
 *   the file references nothing but the site's container service, defines every middleware it
 *   uses itself, and one router per custom rule means a rejected rule disables only itself;
 * - one file that does not PARSE stops the whole folder loading - move forwarding included - so
 *   the YAML is emitted from typed objects, with only known keys, and never by hand;
 * - every file is run through Go's template engine first, so `{{` and `}}` are refused in any
 *   value, and so is a backtick, which would end a rule's quoted string early.
 */
import { CidrSet, isPrivateIp, normalizeIp, parseCidr, PRIVATE_RANGES } from '../../shared/cidr.js';
import {
  MAX_CUSTOM_RULES,
  ruleValueProblem,
  securityName,
  type CustomCondition,
  type CustomRule,
  type EffectivePolicy,
  type LimitId,
  type RateLimit,
} from '../../shared/security.js';
import { headerRegex } from '../lib/addressRegex.js';
import type { TrustedProxy } from '../lib/clientIp.js';

// ---------------------------------------------------------------------------
// The shape of what is written

export interface TraefikRouter {
  rule: string;
  priority: number;
  entryPoints: string[];
  service: string;
  middlewares?: string[];
  /** `{}`: TLS with whatever certificate the store has for the host - the label router's. */
  tls?: Record<string, never>;
}

export type TraefikMiddleware =
  | { ipAllowList: { sourceRange: string[] } }
  | { rateLimit: { average: number; burst: number; period: string; sourceCriterion?: { requestHeaderName: string } } }
  | {
      headers: {
        contentTypeNosniff?: boolean;
        customFrameOptionsValue?: string;
        stsSeconds?: number;
        referrerPolicy?: string;
      };
    }
  | { redirectRegex: { regex: string; replacement: string; permanent: boolean } };

export interface TraefikService {
  loadBalancer: { servers: { url: string }[] };
}

export interface DynamicConfig {
  http: {
    routers: Record<string, TraefikRouter>;
    middlewares: Record<string, TraefikMiddleware>;
    services?: Record<string, TraefikService>;
  };
}

// ---------------------------------------------------------------------------
// Priorities: the bigger number answers first. A site's label router has its rule's length.

export const PRIORITY = {
  /** Blocked addresses behind a proxy (wpl7-blocked.yml, services/firewallRender.ts). */
  blocked: 1_000_000,
  allow: 900_000,
  block: 800_000,
  deny: 700_000,
  infra: 600_000,
  login: 500_000,
  xmlrpc: 400_000,
  static: 300_000,
  main: 200_000,
} as const;

/** The order the refusals are tried in; any of them answers 403, so it only decides the log. */
const DENY_ORDER = ['files', 'uploads', 'install', 'scanners', 'enum', 'xmlrpc', 'wpcron'] as const;

// ---------------------------------------------------------------------------
// Guards

export class RuleValueError extends Error {}

/** Refuse anything Traefik would read differently from what was meant: a value inside a rule. */
export function guard(value: string, what: string): string {
  const problem = ruleValueProblem(value);
  if (problem) throw new RuleValueError(`${what}: ${problem}`);
  return textGuard(value, what);
}

/**
 * Refuse what no string in the file may hold, a whole rule included (whose backticks are its
 * own): a Go template, a control character, a line separator - YAML 1.1 ends a line there.
 */
export function textGuard(value: string, what: string): string {
  if (value.includes('{{') || value.includes('}}')) throw new RuleValueError(`${what}: "{{" and "}}" cannot be written`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(value)) throw new RuleValueError(`${what}: contains a control character`);
  return value;
}

/** A value inside a rule: `\`value\``. */
const lit = (value: string, what: string) => `\`${guard(value, what)}\``;

/** Everything RE2 treats as special, escaped: the value matched as written. */
export function quoteRegex(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

const any = (parts: string[]) => (parts.length === 1 ? parts[0]! : `(${parts.join(' || ')})`);

/** `ClientIP` for every range, or'ed; null for an empty list. */
function clientIpAny(ranges: readonly string[]): string | null {
  if (ranges.length === 0) return null;
  return any(ranges.map((r) => `ClientIP(${lit(r, 'address')})`));
}

/**
 * Jetpack's servers: connecting themselves, or through a trusted proxy whose header names one
 * of them - the whole header, one address. Behind Cloudflare the peer is Cloudflare, so the
 * address alone would never match there. Null when there are none.
 */
function jetpackMatcher(input: SiteRulesInput): string | null {
  const parts: string[] = [];
  const direct = clientIpAny(input.jetpack);
  if (direct) parts.push(direct);
  const { regex } = headerRegex(new CidrSet(input.jetpack).cidrs, { whole: true });
  if (regex) {
    for (const proxy of input.proxies) {
      const from = clientIpAny(proxy.ranges.cidrs.map((r) => r.text));
      if (from) parts.push(`(${from} && HeaderRegexp(${lit(proxy.header, 'header')}, ${lit(regex, 'Jetpack')}))`);
    }
  }
  return parts.length === 0 ? null : any(parts);
}

// ---------------------------------------------------------------------------
// The file for one site

export interface SiteRulesInput {
  slug: string;
  /** Every host the site answers on; [0] is its canonical one. */
  domains: string[];
  policy: EffectivePolicy;
  tlsMode: 'letsencrypt' | 'staging' | 'none';
  /** Trusted proxies: each limit gets a twin keyed on the proxy's header. */
  proxies: readonly TrustedProxy[];
  /**
   * Addresses that pass without limits: the fleet's servers, the never-block list, and the
   * private ranges unless `securityBypassPrivate` is off. Refusals still apply to them.
   */
  bypass: readonly string[];
  /** The fleet's own addresses, for wp-cron.php under Strict (always with the private ranges). */
  fleet: readonly string[];
  /** Jetpack's ranges: never limited or refused on XML-RPC, directly or behind a trusted proxy. */
  jetpack: readonly string[];
}

/** Assets a page pulls in: generous limits, and never counted as a request for the page. */
const ASSET_PATH = String.raw`(?i)^/wp-(content|includes)/.+\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|wav|pdf)$`;

/** The refusals: a matcher each, joined with the site's hosts. */
function denyMatchers(input: SiteRulesInput): Partial<Record<(typeof DENY_ORDER)[number], string>> {
  const p = input.policy;
  const out: Partial<Record<(typeof DENY_ORDER)[number], string>> = {};
  if (p.rules.files) {
    // .env and friends, VCS folders, wp-config copies (and wp-config.php itself - no visitor
    // asks for it), debug.log, SQL dumps. Never /.well-known/: certificates and app links live there.
    out.files = `PathRegexp(${lit(
      String.raw`(?i)(/\.env([.-][^/]*)?$|/\.(git|svn|hg)(/|$)|/\.?wp-config[^/]*$|/debug\.log$|\.sql(\.(gz|bz2|xz|zip|7z|tar))?$)`,
      'files',
    )})`;
  }
  if (p.rules.uploads) {
    out.uploads = `PathRegexp(${lit(String.raw`(?i)^/wp-content/uploads/.*\.ph(p[0-9]?|tml|ar|t|ps)([./]|$)`, 'uploads')})`;
  }
  if (p.rules.install) {
    out.install = `PathRegexp(${lit(String.raw`^/wp-admin/(install|setup-config)\.php`, 'install')})`;
  }
  if (p.rules.scanners) {
    out.scanners = `HeaderRegexp(${lit('User-Agent', 'header')}, ${lit(
      String.raw`(?i)(sqlmap|nikto|wpscan|nuclei|acunetix|netsparker|nessus|openvas|dirbuster|gobuster|feroxbuster|ffuf|wfuzz|w3af|havij|jorgee|zgrab|masscan|nmap scripting|morfeus|zmeu)`,
      'scanners',
    )})`;
  }
  if (p.rules.enum) {
    // /?author=N redirects to the author's archive and gives their login name away. Inside
    // wp-admin the same parameter filters lists, so it stays. The REST users list only for
    // visitors who are not signed in: the block editor asks for it with a nonce.
    const author = `(QueryRegexp(${lit('author', 'query')}, ${lit('^[0-9]', 'query')}) && !PathPrefix(${lit('/wp-admin', 'path')}))`;
    const restUsers =
      `((PathRegexp(${lit(String.raw`(?i)^/wp-json/wp/v2/users`, 'path')}) || ` +
      `QueryRegexp(${lit('rest_route', 'query')}, ${lit(String.raw`(?i)^/wp/v2/users`, 'query')})) && ` +
      `!HeaderRegexp(${lit('X-WP-Nonce', 'header')}, ${lit('.', 'header')}) && ` +
      `!HeaderRegexp(${lit('Authorization', 'header')}, ${lit('.', 'header')}))`;
    out.enum = `(${author} || ${restUsers})`;
  }
  const jetpack = jetpackMatcher(input);
  if (p.xmlrpc === 'deny') {
    out.xmlrpc = `PathRegexp(${lit(String.raw`^/xmlrpc\.php`, 'path')})${jetpack ? ` && !${jetpack}` : ''}`;
  }
  if (p.wpcron === 'deny') {
    // From outside only: the fleet's own servers and private addresses may still call it.
    const inside = clientIpAny([...PRIVATE_RANGES, ...input.fleet]);
    out.wpcron = `PathRegexp(${lit(String.raw`^/wp-cron\.php`, 'path')})${inside ? ` && !${inside}` : ''}`;
  }
  return out;
}

/** One custom condition as a Traefik matcher. */
export function conditionMatcher(c: CustomCondition, proxies: readonly TrustedProxy[]): string {
  const value = c.value;
  let m: string;
  switch (c.field) {
    case 'path':
      m =
        c.op === 'is'
          ? `Path(${lit(value, 'path')})`
          : c.op === 'startsWith'
            ? `PathPrefix(${lit(value, 'path')})`
            : c.op === 'contains'
              ? `PathRegexp(${lit(quoteRegex(value), 'path')})`
              : `PathRegexp(${lit(value, 'path')})`;
      break;
    case 'userAgent': {
      // Case never matters in a user agent.
      const re =
        c.op === 'is'
          ? `(?i)^${quoteRegex(value)}$`
          : c.op === 'startsWith'
            ? `(?i)^${quoteRegex(value)}`
            : c.op === 'contains'
              ? `(?i)${quoteRegex(value)}`
              : value;
      m = `HeaderRegexp(${lit('User-Agent', 'header')}, ${lit(re, 'user agent')})`;
      break;
    }
    case 'method':
      m = `Method(${lit(value, 'method')})`;
      break;
    case 'query': {
      const name = lit(c.name ?? '', 'query parameter');
      const re =
        c.op === 'present'
          ? '.*'
          : c.op === 'is'
            ? `^${quoteRegex(value)}$`
            : c.op === 'startsWith'
              ? `^${quoteRegex(value)}`
              : c.op === 'contains'
                ? quoteRegex(value)
                : value;
      m = `QueryRegexp(${name}, ${lit(re, 'query')})`;
      break;
    }
    case 'address': {
      const cidr = parseCidr(value);
      if (!cidr) throw new RuleValueError(`address: "${value}" is not an address`);
      const parts = [`ClientIP(${lit(cidr.text, 'address')})`];
      // A single address is also matched as the visitor behind a trusted proxy. A range is
      // not: the proxy's header holds one address, and a range cannot be matched on it.
      const single = normalizeIp(cidr.text) === cidr.text;
      if (single) {
        for (const proxy of proxies) {
          const from = clientIpAny(proxy.ranges.cidrs.map((r) => r.text));
          if (!from) continue;
          parts.push(`(${from} && HeaderRegexp(${lit(proxy.header, 'header')}, ${lit(`(?i)^${quoteRegex(cidr.text)}$`, 'address')}))`);
        }
      }
      m = any(parts);
      break;
    }
  }
  return c.negate ? `!${m}` : m;
}

function customMatcher(rule: CustomRule, proxies: readonly TrustedProxy[]): string {
  const parts = rule.conditions.map((c) => conditionMatcher(c, proxies));
  if (parts.length === 1) return parts[0]!;
  return `(${parts.join(rule.match === 'any' ? ' || ' : ' && ')})`;
}

const escapeHostRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rateLimit(limit: RateLimit, header?: string): TraefikMiddleware {
  return {
    rateLimit: {
      average: limit.average,
      burst: limit.burst,
      period: limit.per === 'minute' ? '1m' : '1s',
      ...(header ? { sourceCriterion: { requestHeaderName: header } } : {}),
    },
  };
}

/**
 * The file's content as objects, or null when the site gets no file at all (level Off). Throws
 * RuleValueError for a value that must not reach Traefik - which the caller reports and does
 * not write; the site keeps whatever it had.
 */
export function buildSiteSecurityConfig(input: SiteRulesInput): DynamicConfig | null {
  const { slug, policy } = input;
  if (policy.level === 'off') return null;
  const [primary, ...aliases] = input.domains;
  if (!primary) return null;

  const name = (kind: string) => securityName(kind, slug);
  const hosts = any(input.domains.map((h) => `Host(${lit(h, 'host')})`));
  const https = input.tlsMode !== 'none';
  const base = {
    entryPoints: [https ? 'websecure' : 'web'],
    service: guard(`wp-${slug}@docker`, 'service'),
    ...(https ? { tls: {} as Record<string, never> } : {}),
  };
  const routers: Record<string, TraefikRouter> = {};
  const middlewares: Record<string, TraefikMiddleware> = {};
  const route = (kind: string, priority: number, condition: string | null, mws: string[]) => {
    routers[name(kind)] = {
      rule: condition ? `${hosts} && ${condition}` : hosts,
      priority,
      ...base,
      ...(mws.length > 0 ? { middlewares: mws } : {}),
    };
  };

  // The answer every refusal gives: an allow-list nobody is on (a 403), in front of the site's
  // real service - a router pointing at a Traefik-internal service would be left out of the
  // access log, and the log is how refusals are counted.
  const deny = name('deny');
  middlewares[deny] = { ipAllowList: { sourceRange: ['255.255.255.255/32'] } };

  // What every request that is let through gets: the headers and the canonical redirect.
  const pass: string[] = [];
  const h = policy.headers;
  if (h.nosniff || h.frameOptions || h.hsts || h.referrerPolicy) {
    middlewares[name('headers')] = {
      headers: {
        ...(h.nosniff ? { contentTypeNosniff: true } : {}),
        ...(h.frameOptions ? { customFrameOptionsValue: 'SAMEORIGIN' } : {}),
        // Traefik only sends it over HTTPS; a year, the value preload lists ask for.
        ...(h.hsts && https ? { stsSeconds: 31_536_000 } : {}),
        ...(h.referrerPolicy ? { referrerPolicy: 'strict-origin-when-cross-origin' } : {}),
      },
    };
    pass.push(name('headers'));
  }
  if (aliases.length > 0) {
    // The same redirect the container's labels carry (services/labels.ts), defined here so
    // the file borrows nothing: requests to an alias go to the canonical host.
    const scheme = https ? 'https' : 'http';
    middlewares[name('canonical')] = {
      redirectRegex: {
        regex: guard(`^https?://(?:${aliases.map(escapeHostRe).join('|')})(?::\\d+)?/(.*)`, 'redirect'),
        replacement: guard(`${scheme}://${primary}/\${1}`, 'redirect'),
        permanent: true,
      },
    };
    pass.push(name('canonical'));
  }

  // Custom rules, in the order they are listed: allow before block, each its own router.
  const enabled = policy.customRules.filter((r) => r.enabled).slice(0, MAX_CUSTOM_RULES);
  enabled.forEach((rule, i) => {
    const matcher = customMatcher(rule, input.proxies);
    if (rule.action === 'allow') route(`allow-${rule.id}`, PRIORITY.allow + (MAX_CUSTOM_RULES - i), matcher, pass);
    else route(`block-${rule.id}`, PRIORITY.block + (MAX_CUSTOM_RULES - i), matcher, [deny]);
  });

  const refusals = denyMatchers(input);
  DENY_ORDER.forEach((id, i) => {
    const matcher = refusals[id];
    if (matcher) route(`deny-${id}`, PRIORITY.deny + (DENY_ORDER.length - i), matcher, [deny]);
  });

  // The fleet's own traffic - the uptime probe, a moved site's old server forwarding - is never
  // slowed. Below the refusals on purpose: forwarded traffic arrives from a fleet address, and
  // must not skip them.
  const bypass = clientIpAny(input.bypass);
  if (bypass) route('infra', PRIORITY.infra, bypass, pass);

  /**
   * A limited route, and one twin per trusted proxy counting by the proxy's visitor header -
   * behind Cloudflare the peer is Cloudflare, and a limit per peer would be one allowance for
   * everyone who happens to share an edge server.
   */
  const limited = (kind: string, priority: number, condition: string | null, id: LimitId) => {
    const limit = policy.limits[id];
    if (!limit) return;
    middlewares[name(`limit-${id}`)] = rateLimit(limit);
    route(kind, priority, condition, [name(`limit-${id}`), ...pass]);
    input.proxies.forEach((proxy, i) => {
      const from = clientIpAny(proxy.ranges.cidrs.map((r) => r.text));
      if (!from) return;
      const twin = `${kind}-p${i}`;
      middlewares[name(`limit-${id}-p${i}`)] = rateLimit(limit, guard(proxy.header, 'header'));
      const visitor = `${from} && HeaderRegexp(${lit(proxy.header, 'header')}, ${lit('.', 'header')})`;
      route(twin, priority + 1 + i, condition ? `${condition} && ${visitor}` : visitor, [name(`limit-${id}-p${i}`), ...pass]);
    });
  };

  // A prefix, not the exact path: Apache serves /wp-login.php/anything as the login page too.
  limited('login', PRIORITY.login, `Method(${lit('POST', 'method')}) && PathRegexp(${lit(String.raw`^/wp-login\.php`, 'path')})`, 'login');
  if (policy.xmlrpc === 'limit') {
    const jetpack = jetpackMatcher(input);
    limited('xmlrpc', PRIORITY.xmlrpc, `PathRegexp(${lit(String.raw`^/xmlrpc\.php`, 'path')})${jetpack ? ` && !${jetpack}` : ''}`, 'xmlrpc');
  }
  limited('static', PRIORITY.static, `PathRegexp(${lit(ASSET_PATH, 'path')})`, 'assets');
  if (policy.limits.requests) limited('main', PRIORITY.main, null, 'requests');
  // No request limit: the headers still have to reach every response.
  else if (pass.length > 0) route('main', PRIORITY.main, null, pass);

  return { http: { routers, middlewares } };
}

/** The addresses that pass without limits (see SiteRulesInput.bypass). */
export function bypassList(opts: { fleet: readonly string[]; neverBlock: readonly string[]; bypassPrivate: boolean }): string[] {
  const set = new CidrSet([...opts.fleet, ...opts.neverBlock, ...(opts.bypassPrivate ? PRIVATE_RANGES : [])]);
  return set.cidrs.map((c) => c.text);
}

/** Public addresses of the fleet's servers, canonical; private or unparseable ones left out. */
export function fleetAddresses(publicIps: readonly string[]): string[] {
  const out = new Set<string>();
  for (const ip of publicIps) {
    const n = normalizeIp(ip);
    if (n && !isPrivateIp(n)) out.add(n);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// YAML

/** Keys the emitter will write, and nothing else: a typo cannot become a key Traefik rejects. */
const KNOWN_KEYS = new Set([
  'http',
  'routers',
  'middlewares',
  'services',
  'rule',
  'priority',
  'entryPoints',
  'service',
  'tls',
  'ipAllowList',
  'sourceRange',
  'rateLimit',
  'average',
  'burst',
  'period',
  'sourceCriterion',
  'requestHeaderName',
  'headers',
  'contentTypeNosniff',
  'customFrameOptionsValue',
  'stsSeconds',
  'referrerPolicy',
  'redirectRegex',
  'regex',
  'replacement',
  'permanent',
  'loadBalancer',
  'servers',
  'url',
]);

/** A name under `routers:`/`middlewares:`/`services:`, which is not a known key but ours. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*(@[a-z]+)?$/;

function scalar(value: unknown, path: string): string {
  if (typeof value === 'string') return JSON.stringify(textGuard(value, path));
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new RuleValueError(`${path}: not a whole number`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw new RuleValueError(`${path}: cannot be written`);
}

function emit(value: Record<string, unknown>, indent: string, path: string, namesHere: boolean, out: string[]): void {
  for (const [key, v] of Object.entries(value)) {
    if (namesHere ? !NAME_RE.test(key) : !KNOWN_KEYS.has(key)) throw new RuleValueError(`${path}: unexpected key "${key}"`);
    const at = `${path}.${key}`;
    // A router's, middleware's or service's own name is followed by its definition.
    const childNames = !namesHere && (key === 'routers' || key === 'middlewares' || key === 'services');
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push(`${indent}${key}: []`);
        continue;
      }
      out.push(`${indent}${key}:`);
      for (const item of v) {
        if (item !== null && typeof item === 'object') {
          const inner: string[] = [];
          emit(item as Record<string, unknown>, `${indent}    `, at, false, inner);
          if (inner.length === 0) throw new RuleValueError(`${at}: empty item`);
          out.push(`${indent}  - ${inner[0]!.trimStart()}`, ...inner.slice(1));
        } else {
          out.push(`${indent}  - ${scalar(item, at)}`);
        }
      }
    } else if (v !== null && typeof v === 'object') {
      if (Object.keys(v).length === 0) {
        out.push(`${indent}${key}: {}`);
        continue;
      }
      out.push(`${indent}${key}:`);
      emit(v as Record<string, unknown>, `${indent}  `, at, childNames, out);
    } else if (v !== undefined) {
      out.push(`${indent}${key}: ${scalar(v, at)}`);
    }
  }
}

/**
 * The file as text. Every string is JSON-quoted, which YAML reads as the same string; keys are
 * checked against what Traefik's configuration has. `header` lines are comments.
 */
export function renderDynamicFile(config: DynamicConfig, header: string[] = []): string {
  const out = header.map((line) => `# ${textGuard(line, 'comment')}`.trimEnd());
  emit(config as unknown as Record<string, unknown>, '', 'config', false, out);
  return `${out.join('\n')}\n`;
}

/** Where a site's rules live on its server. */
export const securityFileName = (slug: string) => `sec-${slug}.yml`;
/** A file this module wrote, by name; anything else in the folder (move-*.yml) is never touched. */
export const SECURITY_FILE_RE = /^sec-([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\.yml$/;
