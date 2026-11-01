/**
 * The page cache's rules, the parts the API, the web app and the renderers share: what a rule
 * is, the built-in groups every site starts with, what a site keeps in `sites.cache_rules`, and
 * `activeCacheRules` - the one function that decides which rules are in force for a site. The
 * nginx file (services/siteStack.ts), the PHP file (services/wpCachePhp.ts), the API and the
 * Caching card all go through it, so they cannot disagree about a site.
 *
 * A rule's value ends up in nginx's config and in PHP. `cacheRuleProblem` is why that is safe,
 * so the renderers call it again on every rule, and a stored rule that fails is left out.
 */
// @docs sites/caching
import { z } from 'zod';

// ---------------------------------------------------------------------------
// What a rule is

/**
 * skip: the request goes past the cache. copy: a separate copy per value. keep: stored for a
 * set time instead of the site's own. ignore: a query parameter that is left out of the cache
 * key and taken off the request PHP sees, so a value cannot end up inside a stored page.
 */
export const cacheRuleKinds = ['skip', 'copy', 'keep', 'ignore'] as const;
export type CacheRuleKind = (typeof cacheRuleKinds)[number];

export const cacheRuleMatches = ['path', 'cookie', 'query', 'agent', 'postType', 'phone'] as const;
export type CacheRuleMatch = (typeof cacheRuleMatches)[number];

/**
 * Which matches each kind takes. nginx runs everything it can see in the request, before the
 * lookup or in the key; a post type is only known to WordPress, and so is a keep time, which
 * has to go out with the page. So `wp-cache.php` runs `postType` and `keep`.
 */
export const CACHE_RULE_MATCHES: Record<CacheRuleKind, readonly CacheRuleMatch[]> = {
  skip: ['path', 'cookie', 'query', 'agent', 'postType'],
  copy: ['cookie', 'query', 'phone'],
  keep: ['path', 'postType'],
  ignore: ['query'],
};

export interface CacheRule {
  /** Stable: a site switches a built-in rule off by this id, which outlives a change of value. */
  id: string;
  kind: CacheRuleKind;
  match: CacheRuleMatch;
  /** Empty for `phone`, which is one test and has no value. */
  value: string;
  /** `keep` only. */
  seconds?: number;
}

/**
 * The longest a page is kept, for a site and for a rule. WordPress's form tokens expire after
 * 12 to 24 hours, so a page kept longer could hand out a dead one.
 */
export const MAX_KEEP_SECONDS = 36_000;
/** How long a 404 is kept: bots asking for missing pages stop costing a full WordPress load. */
export const NOT_FOUND_SECONDS = 300;
/** Each separate-copy rule multiplies the copies of every page. */
export const MAX_OWN_COPY_RULES = 5;
export const MAX_OWN_RULES = 50;

const MAX_PATH_LENGTH = 200;
const OWN_RULE_ID = /^[a-z0-9]{1,12}$/;

// ---------------------------------------------------------------------------
// Which values a rule may have

/**
 * Letters of any language with their combining marks (a Hindi or Thai word needs them), digits,
 * and / _ - . ~ %. Not `;`, quotes, braces, `$`, a backslash or `|`: each means something to
 * nginx or to the map that picks a request's skip reason.
 */
const PATH_VALUE = /^\/[\p{L}\p{M}\p{Nd}/_.~%-]*\*?$/u;
const COOKIE_VALUE = /^[A-Za-z0-9_.-]{1,64}$/;
const QUERY_VALUE = /^[A-Za-z0-9_.-]{1,64}$/;
const IGNORED_QUERY_VALUE = /^[A-Za-z0-9_.-]{1,64}\*?$/;
const AGENT_VALUE = /^[A-Za-z0-9 _./:;()+-]{1,64}$/;
const POST_TYPE_VALUE = /^[a-z0-9_-]{1,20}$/;
const PERCENT_ESCAPE = /^%[0-9A-Fa-f]{2}/;

/**
 * Why a rule cannot be used; null when it can. Used by the web app and the API to answer the
 * person typing, and by the renderers on every rule they are given, stored or built in. It has
 * to hold up against anything, so it looks at every field's type: an old row or a hand-edited
 * one can hold whatever it holds.
 */
export function cacheRuleProblem(rule: Pick<CacheRule, 'kind' | 'match' | 'value' | 'seconds'>): string | null {
  const { kind, match, value, seconds } = rule;
  if (!cacheRuleKinds.includes(kind)) return 'Unknown kind of rule';
  if (!CACHE_RULE_MATCHES[kind].includes(match)) return `A rule of kind "${kind}" cannot match ${String(match)}`;
  if (typeof value !== 'string') return 'A rule needs a value';

  if (match === 'phone') {
    if (value !== '') return 'The phone test has no value';
  } else if (match === 'path') {
    const problem = pathProblem(value);
    if (problem) return problem;
  } else if (match === 'cookie') {
    if (!COOKIE_VALUE.test(value)) return 'A cookie name is 1 to 64 letters, digits and _ . -';
  } else if (match === 'query') {
    if (kind === 'ignore') {
      if (!IGNORED_QUERY_VALUE.test(value)) return 'A parameter name is 1 to 64 letters, digits and _ . -, with an optional * at the end';
    } else if (!QUERY_VALUE.test(value)) {
      return 'A parameter name is 1 to 64 letters, digits and _ . -';
    }
  } else if (match === 'agent') {
    if (!AGENT_VALUE.test(value)) return 'A user agent is 1 to 64 letters, digits, spaces and _ . / : ; ( ) + -';
  } else if (match === 'postType') {
    if (!POST_TYPE_VALUE.test(value)) return 'A post type is 1 to 20 lower-case letters, digits and _ -';
  }

  if (kind === 'keep') {
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1) return 'Say how many seconds to keep the page';
    if (seconds > MAX_KEEP_SECONDS) return `A page is kept for at most ${MAX_KEEP_SECONDS / 3600} hours`;
  } else if (seconds !== undefined) {
    return 'Only a keep rule has a time';
  }
  return null;
}

function pathProblem(value: string): string | null {
  if (!value.startsWith('/')) return 'A path starts with /';
  if (value.length > MAX_PATH_LENGTH) return `A path is at most ${MAX_PATH_LENGTH} characters`;
  if (!PATH_VALUE.test(value)) return 'A path is letters, digits and / _ - . ~ %, with an optional * at the end';
  for (let i = value.indexOf('%'); i !== -1; i = value.indexOf('%', i + 1)) {
    if (!PERCENT_ESCAPE.test(value.slice(i))) return 'A % in a path is followed by two hex digits';
  }
  if (cachePathBytes(value).some((byte) => byte < 0x20 || byte === 0x7f)) return 'A path cannot contain control characters';
  return null;
}

// ---------------------------------------------------------------------------
// A path, as nginx and PHP compare it

/**
 * The bytes a path value stands for, without a trailing `*`. nginx compares against `$uri` and
 * `wp-cache.php` against the decoded request path: both are bytes with every %XX already
 * undone, and neither is in UTF-8 mode. So `/café/` and `/caf%C3%A9/` are the same rule.
 */
export function cachePathBytes(value: string): number[] {
  const path = value.endsWith('*') ? value.slice(0, -1) : value;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < path.length; ) {
    if (path[i] === '%' && PERCENT_ESCAPE.test(path.slice(i))) {
      bytes.push(parseInt(path.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const char = String.fromCodePoint(path.codePointAt(i) ?? 0);
      bytes.push(...encoder.encode(char));
      i += char.length;
    }
  }
  return bytes;
}

/** Bytes as regular expression source: only what cannot mean anything stays as itself. */
function bytesRegex(bytes: readonly number[]): string {
  return bytes
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[A-Za-z0-9/_~-]/.test(char)) return char;
      return char === '.' ? '\\.' : `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

/**
 * The regular expression a path value stands for, in the form both PCREs take. `/shop/` is that
 * page, with or without its last slash, because WordPress redirects one to the other; `/shop/*`
 * is that page and what is under it; `/shop*` is whatever starts so.
 */
export function cachePathRegex(value: string): string {
  const wildcard = value.endsWith('*');
  const bytes = cachePathBytes(value);
  // The last slash is handled by what follows it, in both shapes.
  const lastSlash = bytes.at(-1) === 0x2f;
  const body = bytesRegex(lastSlash ? bytes.slice(0, -1) : bytes);
  if (!wildcard) return `^${body}/?$`;
  return lastSlash ? `^${body}(?:/|$)` : `^${body}`;
}

/** Escapes what means something to a regular expression, for a validated name or user agent. */
export function cacheRegexEscape(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

/**
 * What a rule says as a request's skip reason, which goes out in the `X-Cache-Skipped` header.
 * A header stays ASCII, so anything else is percent-encoded.
 */
export function cacheRuleReason(rule: Pick<CacheRule, 'match' | 'value'>): string {
  const label = rule.match === 'postType' ? 'post type' : rule.match;
  const encoder = new TextEncoder();
  const value = Array.from(rule.value)
    .map((char) =>
      char.charCodeAt(0) < 0x80
        ? char
        : Array.from(encoder.encode(char), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
    )
    .join('');
  return `${label} ${value}`;
}

// ---------------------------------------------------------------------------
// The built-in groups

export interface CacheRuleGroup {
  /** Stable: a site switches a group off by this id. Rule ids start with it and a dot. */
  id: string;
  label: string;
  description: string;
  /** Why a site cannot switch it off; a group without it can be switched off. */
  lockedReason?: string;
  /**
   * The plugins that mark the group In use on the Caching card, by folder, as `wp plugin list`
   * names them. Empty when no plugin says whether it matters. Only a mark: every group is on
   * whether a plugin is there or not, because a cookie rule matches nothing without its plugin
   * and there is then no lag after a plugin is activated.
   */
  plugins: readonly string[];
  rules: readonly CacheRule[];
}

const skipCookie = (id: string, value: string): CacheRule => ({ id, kind: 'skip', match: 'cookie', value });
const skipPath = (id: string, value: string): CacheRule => ({ id, kind: 'skip', match: 'path', value });
const copyCookie = (id: string, value: string): CacheRule => ({ id, kind: 'copy', match: 'cookie', value });
const ignoreQuery = (id: string, value: string): CacheRule => ({ id, kind: 'ignore', match: 'query', value });

/**
 * On for every site, improved by each release. A site that needs another value switches a rule
 * off and adds its own; the rules it did not touch keep improving.
 *
 * Every name here was read from the plugin's own code or from WP Rocket's lists of them, and
 * anything added gets the same check. They are on the watchlist (docs/internal/watchlist.md).
 */
export const CACHE_RULE_GROUPS: readonly CacheRuleGroup[] = [
  {
    id: 'wordpress',
    label: 'WordPress',
    description: "Logged-in visitors, wp-admin, logins, comments, files and the panel's own checks.",
    lockedReason: "WordPress needs these: without them a visitor could get someone else's page.",
    plugins: [],
    rules: [
      skipCookie('wordpress.logged-in', 'wordpress_logged_in_'),
      skipCookie('wordpress.post-password', 'wp-postpass_'),
      skipCookie('wordpress.comment-author', 'comment_author_'),
      skipCookie('wordpress.no-cache', 'wordpress_no_cache'),
      skipPath('wordpress.admin', '/wp-admin/*'),
      skipPath('wordpress.login', '/wp-login.php'),
      skipPath('wordpress.xmlrpc', '/xmlrpc.php'),
      skipPath('wordpress.cron', '/wp-cron.php'),
      skipPath('wordpress.rest', '/wp-json/*'),
      skipPath('wordpress.comments-post', '/wp-comments-post.php'),
      // Files, which proxy_cache would spool to disk and strip Range from: a video would lose
      // seeking, and a big download its resume.
      skipPath('wordpress.content', '/wp-content/*'),
      skipPath('wordpress.includes', '/wp-includes/*'),
      // The panel's uptime and health checks, which have to see a failure the cache would hide.
      { id: 'wordpress.probe', kind: 'skip', match: 'agent', value: 'wpl7-probe/1' },
    ],
  },
  {
    id: 'phones',
    label: 'Phones',
    description: 'A separate copy for phones, for themes that change by device.',
    plugins: [],
    rules: [{ id: 'phones.copy', kind: 'copy', match: 'phone', value: '' }],
  },
  {
    id: 'php-sessions',
    label: 'PHP sessions',
    description: 'Skips the cache for a visitor with a PHP session.',
    plugins: [],
    rules: [skipCookie('php-sessions.phpsessid', 'PHPSESSID')],
  },
  {
    id: 'woocommerce',
    label: 'WooCommerce',
    description: 'Skips the cache once a visitor has a cart. A separate copy per ?v=, for Geolocate with page caching support.',
    plugins: ['woocommerce'],
    rules: [
      skipCookie('woocommerce.items-in-cart', 'woocommerce_items_in_cart'),
      skipCookie('woocommerce.cart-hash', 'woocommerce_cart_hash'),
      skipCookie('woocommerce.session', 'wp_woocommerce_session_'),
      { id: 'woocommerce.location', kind: 'copy', match: 'query', value: 'v' },
    ],
  },
  {
    id: 'easy-digital-downloads',
    label: 'Easy Digital Downloads',
    description: 'Skips the cache once a visitor has a cart.',
    plugins: ['easy-digital-downloads'],
    rules: [skipCookie('easy-digital-downloads.items-in-cart', 'edd_items_in_cart')],
  },
  {
    id: 'currency',
    label: 'Currency switchers',
    description: 'A separate copy per currency, country or tax choice.',
    // Aelia's and the Currency Converter Widget are sold elsewhere, not on wordpress.org.
    plugins: [
      'woocommerce-multilingual',
      'woocommerce-currency-switcher',
      'woo-multi-currency',
      'woocommerce-aelia-currencyswitcher',
      'woocommerce-currency-converter-widget',
    ],
    rules: [
      copyCookie('currency.aelia-currency', 'aelia_cs_selected_currency'),
      copyCookie('currency.aelia-country', 'aelia_customer_country'),
      copyCookie('currency.aelia-state', 'aelia_customer_state'),
      copyCookie('currency.aelia-tax-exempt', 'aelia_tax_exempt'),
      copyCookie('currency.wcml-currency', 'wcml_client_currency'),
      copyCookie('currency.wcml-language', 'wcml_client_currency_language'),
      copyCookie('currency.wcml-country', 'wcml_client_country'),
      copyCookie('currency.converter-widget', 'woocommerce_current_currency'),
      copyCookie('currency.curcy', 'wmc_current_currency'),
      // Set next to the one above on every switch, so without it a visitor who switched would
      // carry a cookie nginx doesn't know, and could never store a page.
      copyCookie('currency.curcy-old', 'wmc_current_currency_old'),
      copyCookie('currency.woocs', 'woocs_current_currency'),
    ],
  },
  {
    id: 'languages',
    label: 'Languages',
    description: 'A separate copy per language cookie.',
    // WPML is sold elsewhere, not on wordpress.org.
    plugins: ['polylang', 'sitepress-multilingual-cms'],
    rules: [copyCookie('languages.polylang', 'pll_language'), copyCookie('languages.wpml', 'wp-wpml_current_language')],
  },
  {
    id: 'tracking',
    label: 'Tracking parameters',
    description: 'Left out of the cache and taken off the request PHP sees. Switch one off if the site reads it in PHP.',
    plugins: [],
    rules: [
      ignoreQuery('tracking.utm', 'utm_*'),
      ignoreQuery('tracking.gclid', 'gclid'),
      ignoreQuery('tracking.gbraid', 'gbraid'),
      ignoreQuery('tracking.wbraid', 'wbraid'),
      ignoreQuery('tracking.fbclid', 'fbclid'),
      ignoreQuery('tracking.msclkid', 'msclkid'),
      ignoreQuery('tracking.mc-cid', 'mc_cid'),
      ignoreQuery('tracking.mc-eid', 'mc_eid'),
      ignoreQuery('tracking.ga', '_ga'),
      ignoreQuery('tracking.gl', '_gl'),
    ],
  },
];

/** Whether an inventory's plugins mark a group In use. */
export function cacheGroupInUse(group: Pick<CacheRuleGroup, 'plugins'>, installed: Iterable<string>): boolean {
  const names = new Set(installed);
  return group.plugins.some((plugin) => names.has(plugin));
}

/**
 * Only a request with no unknown cookies may store a page; it can still get a HIT. Unknown means
 * not a separate-copy cookie and not one of these: analytics cookies, and WordPress's own for the
 * screens of wp-admin, which never change what a page shows. So a custom login or membership plugin
 * that doesn't signal no-cache cannot put one visitor's page in front of another.
 *
 * Each is a regular expression for the whole name, as narrow as its vendor's names allow, so a
 * member cookie that starts like one (`_gid_member`, `_hjLogin`) is not taken for one. A name this
 * misses costs little: that visitor can't fill the cache. Consent cookies aren't here on purpose:
 * Complianz draws what a visitor agreed to in PHP, so one who agreed would store a page for one who
 * refused, and Cookiebot's PHP reads its cookie too.
 */
export const HARMLESS_COOKIES = [
  '_ga(?:_[A-Z0-9]+)?',
  '_gid',
  '_gat(?:_[A-Za-z0-9_-]+)?',
  '_gcl_[a-z]{2}',
  '_fbp',
  '_fbc',
  '_hj(?:id|FirstSeen|TLDTest|AbsoluteSessionInProgress|Session(?:User)?_[0-9]+|IncludedIn(?:Session|Pageview)Sample(?:_[0-9]+)?)',
  '_clck',
  '_clsk',
  '_uet(?:sid|vid)',
  '__utm[a-z]',
  '__cf_bm',
  'cf_clearance',
  'wp-settings-(?:time-)?[0-9]+',
  'wordpress_test_cookie',
] as const;

// ---------------------------------------------------------------------------
// What a site keeps

/** `sites.cache_rules`, as JSON. Whether the cache is on at all is `sites.page_cache`. */
export interface SiteCacheRules {
  /** null = what Settings says. */
  keepSeconds: number | null;
  /** Ids of built-in groups and rules this site switched off. */
  off: string[];
  own: CacheRule[];
  /** Why the page cache was switched off when the site moved to this setup; shown on the card. */
  offReason: string | null;
}

/** A site that changed nothing. */
export const noCacheRules = (): SiteCacheRules => ({ keepSeconds: null, off: [], own: [], offReason: null });

/** A time in seconds a page can be kept for; anything longer is the longest there is. */
export function clampKeepSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 1) return MAX_KEEP_SECONDS;
  return Math.min(Math.floor(seconds), MAX_KEEP_SECONDS);
}

/** How long a site keeps pages: its own time, or what Settings says. */
export function siteKeepSeconds(rules: Pick<SiteCacheRules, 'keepSeconds'>, panelDefault: number): number {
  return clampKeepSeconds(rules.keepSeconds ?? panelDefault);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the column whatever it holds, null and broken JSON included, and answers with something
 * usable: a site must keep working over a bad row. Only what cannot be a rule at all is dropped.
 * A rule with a bad value stays, so the Caching card can show it for removal; the renderers
 * leave it out (`usableCacheRules`) and say so.
 */
export function parseSiteCacheRules(stored: unknown): SiteCacheRules {
  let value = stored;
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored);
    } catch {
      return noCacheRules();
    }
  }
  if (!isRecord(value)) return noCacheRules();

  const keep = value.keepSeconds;
  const off = Array.isArray(value.off) ? value.off.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64) : [];
  const reason = typeof value.offReason === 'string' ? value.offReason.trim().slice(0, 300) : '';
  return {
    keepSeconds: typeof keep === 'number' && Number.isFinite(keep) && keep >= 1 ? clampKeepSeconds(keep) : null,
    off: [...new Set(off)],
    own: parseOwnRules(value.own),
    offReason: reason === '' ? null : reason,
  };
}

function parseOwnRules(stored: unknown): CacheRule[] {
  if (!Array.isArray(stored)) return [];
  const own: CacheRule[] = [];
  const ids = new Set<string>();
  let copies = 0;
  for (const entry of stored) {
    if (own.length >= MAX_OWN_RULES) break;
    if (!isRecord(entry)) continue;
    const { id, kind, match, value, seconds } = entry;
    if (!cacheRuleKinds.includes(kind as CacheRuleKind)) continue;
    if (!cacheRuleMatches.includes(match as CacheRuleMatch)) continue;
    if (typeof value !== 'string') continue;
    if (kind === 'copy' && ++copies > MAX_OWN_COPY_RULES) continue;
    let ruleId = typeof id === 'string' && OWN_RULE_ID.test(id) ? id : `r${own.length}`;
    while (ids.has(ruleId)) ruleId = `${ruleId.slice(0, 11)}x`;
    ids.add(ruleId);
    own.push({
      id: ruleId,
      kind: kind as CacheRuleKind,
      match: match as CacheRuleMatch,
      value,
      ...(typeof seconds === 'number' ? { seconds } : {}),
    });
  }
  return own;
}

// ---------------------------------------------------------------------------
// What the API takes

/** A rule of a site's own, as the API takes it. A phone is built in: it has a switch of its own. */
export const cacheRuleSchema = z
  .object({
    /** Short and stable, and without a dot, so it can never be taken for a built-in rule's. */
    id: z.string().regex(OWN_RULE_ID, 'A rule id is 1-12 letters and digits').optional(),
    kind: z.enum(cacheRuleKinds),
    match: z.enum(cacheRuleMatches),
    value: z.string(),
    seconds: z.number().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.match === 'phone') {
      ctx.addIssue({ code: 'custom', message: 'Phones are built in: switch that group on instead', path: ['match'] });
      return;
    }
    const problem = cacheRuleProblem(rule);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['value'] });
  });
export type CacheRuleInput = z.infer<typeof cacheRuleSchema>;

export const ownCacheRulesSchema = z
  .array(cacheRuleSchema)
  .max(MAX_OWN_RULES, `A site has at most ${MAX_OWN_RULES} rules of its own`)
  .refine(
    (rules) => rules.filter((r) => r.kind === 'copy').length <= MAX_OWN_COPY_RULES,
    `A site has at most ${MAX_OWN_COPY_RULES} separate-copy rules of its own, because each multiplies the copies of every page`,
  )
  .refine((rules) => {
    const ids = rules.map((r) => r.id).filter((id): id is string => id !== undefined);
    return new Set(ids).size === ids.length;
  }, 'Two rules have the same id');

/** Gives every rule an id, keeping the ones it has. */
export function withCacheRuleIds(rules: readonly CacheRuleInput[], random: () => string = randomRuleId): CacheRule[] {
  const taken = new Set(rules.map((r) => r.id).filter(Boolean));
  return rules.map((rule) => {
    if (rule.id) return rule as CacheRule;
    let id = random();
    while (taken.has(id)) id = random();
    taken.add(id);
    return { ...rule, id };
  });
}

function randomRuleId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

// ---------------------------------------------------------------------------
// What a site gets

/**
 * The rules in force for a site: the locked groups whatever it says, the built-in ones it did
 * not switch off, then its own. The order is the order they are tried in, built-in first, so a
 * site's rule never takes a request away from WordPress's.
 */
export function activeCacheRules(rules: Pick<SiteCacheRules, 'off' | 'own'>): CacheRule[] {
  const off = new Set(rules.off);
  const active: CacheRule[] = [];
  for (const group of CACHE_RULE_GROUPS) {
    if (group.lockedReason) {
      active.push(...group.rules);
    } else if (!off.has(group.id)) {
      active.push(...group.rules.filter((rule) => !off.has(rule.id)));
    }
  }
  active.push(...rules.own);
  return active;
}

/**
 * The rules in force that pass their check. Every renderer goes through this, so a stored rule
 * that fails (an old row, a hand-edited one, a check made stricter since) never reaches nginx or
 * PHP, and is reported rather than quietly lost.
 */
export function usableCacheRules(rules: Pick<SiteCacheRules, 'off' | 'own'>, warn?: (message: string) => void): CacheRule[] {
  const seen = new Set<string>();
  const usable: CacheRule[] = [];
  for (const rule of activeCacheRules(rules)) {
    const problem = cacheRuleProblem(rule);
    if (problem) {
      warn?.(`Cache rule ${JSON.stringify(rule.id)} left out: ${problem}`);
      continue;
    }
    // The same rule twice would mean two maps for one cookie, for nothing.
    const key = `${rule.kind}|${rule.match}|${rule.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push(rule);
  }
  return usable;
}
