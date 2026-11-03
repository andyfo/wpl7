/**
 * The page cache's rules (shared/cacheRules.ts): what a rule may hold, because every value ends up
 * in nginx's config and in PHP; the built-in groups; what a site keeps; and which rules are in
 * force for it.
 */
import { describe, expect, it } from 'vitest';
import {
  CACHE_RULE_GROUPS,
  CACHE_RULE_MATCHES,
  HARMLESS_COOKIES,
  MAX_KEEP_SECONDS,
  MAX_OWN_COPY_RULES,
  MAX_OWN_RULES,
  NOT_FOUND_SECONDS,
  activeCacheRules,
  cacheGroupInUse,
  cachePathBytes,
  cachePathRegex,
  cacheRegexEscape,
  cacheRuleProblem,
  cacheRuleReason,
  cacheRuleSchema,
  clampKeepSeconds,
  noCacheRules,
  ownCacheRulesSchema,
  parseSiteCacheRules,
  siteKeepSeconds,
  usableCacheRules,
  withCacheRuleIds,
  type CacheRule,
  type CacheRuleKind,
  type CacheRuleMatch,
} from '../../shared/cacheRules.js';

const rule = (kind: CacheRuleKind, match: CacheRuleMatch, value: string, seconds?: number) => ({
  kind,
  match,
  value,
  ...(seconds === undefined ? {} : { seconds }),
});

const own = (id: string, kind: CacheRuleKind, match: CacheRuleMatch, value: string, seconds?: number): CacheRule => ({
  id,
  ...rule(kind, match, value, seconds),
});

describe('what a rule may hold', () => {
  it.each([
    rule('skip', 'path', '/shop/'),
    rule('skip', 'path', '/shop/*'),
    rule('skip', 'path', '/shop*'),
    rule('skip', 'path', '/'),
    rule('skip', 'path', '/*'),
    rule('skip', 'path', '/wp-login.php'),
    rule('skip', 'path', '/a_b-c.d~e/'),
    rule('skip', 'path', '/caf%C3%A9/'),
    rule('skip', 'path', '/café/'),
    rule('skip', 'path', '/日本語/*'),
    rule('skip', 'path', '/हिन्दी/'), // combining marks: a language's letters aren't all \p{L}
    rule('skip', 'path', '/магазин/товары/'),
    rule('skip', 'path', '/٣٤/'),
    rule('skip', 'cookie', 'wordpress_logged_in_'),
    rule('skip', 'cookie', 'a.b-c_d'),
    rule('skip', 'query', 'nocache'),
    rule('skip', 'agent', 'Mozilla/5.0 (X11; Linux x86_64) Foo:1+2'),
    rule('skip', 'postType', 'product'),
    rule('skip', 'postType', 'my_type-2'),
    rule('copy', 'cookie', 'wp-wpml_current_language'),
    rule('copy', 'query', 'lang'),
    rule('copy', 'phone', ''),
    rule('keep', 'path', '/news/*', 600),
    rule('keep', 'postType', 'event', 1),
    rule('keep', 'path', '/x/', MAX_KEEP_SECONDS),
    rule('ignore', 'query', 'gclid'),
    rule('ignore', 'query', 'utm_*'),
  ])('takes $kind $match "$value"', (r) => {
    expect(cacheRuleProblem(r)).toBeNull();
  });

  // Each of these means something to nginx, to PHP, to a regular expression or to the map that
  // picks a request's reason, and no match allows any of them.
  const DANGEROUS = ['"', "'", '`', '{', '}', '$', '\\', '|', '\n', '\r', '\t', '\0', '#', '<', '>', '&', '=', '^', '[', ']', '?', '!', ',', '@'];
  const examples: [CacheRuleKind, CacheRuleMatch, (bad: string) => string][] = [
    ['skip', 'path', (bad) => `/a${bad}b/`],
    ['skip', 'cookie', (bad) => `a${bad}b`],
    ['copy', 'cookie', (bad) => `a${bad}b`],
    ['skip', 'query', (bad) => `a${bad}b`],
    ['copy', 'query', (bad) => `a${bad}b`],
    ['ignore', 'query', (bad) => `a${bad}b`],
    ['skip', 'agent', (bad) => `a${bad}b`],
    ['skip', 'postType', (bad) => `a${bad}b`],
    ['keep', 'path', (bad) => `/a${bad}b/`],
    ['keep', 'postType', (bad) => `a${bad}b`],
  ];
  it.each(examples.flatMap(([kind, match, make]) => DANGEROUS.map((c) => ({ kind, match, value: make(c), seconds: kind === 'keep' ? 60 : undefined }))))(
    'refuses $kind $match $value',
    (r) => {
      expect(cacheRuleProblem(r)).not.toBeNull();
    },
  );

  it.each([
    rule('skip', 'path', 'shop/'), // not a path
    rule('skip', 'path', ''),
    rule('skip', 'path', '/a b/'),
    rule('skip', 'path', '/a;b/'),
    rule('skip', 'path', '/a*b/'),
    rule('skip', 'path', '/a**'),
    rule('skip', 'path', '/a%'),
    rule('skip', 'path', '/a%2'),
    rule('skip', 'path', '/a%zz/'),
    rule('skip', 'path', '/a%0a/'),
    rule('skip', 'path', '/a%00/'),
    rule('skip', 'path', '/a%7f/'),
    rule('skip', 'path', `/${'a'.repeat(200)}`),
    rule('skip', 'cookie', ''),
    rule('skip', 'cookie', 'a*'),
    rule('skip', 'cookie', 'a b'),
    rule('skip', 'cookie', 'a;b'),
    rule('skip', 'cookie', 'é'),
    rule('skip', 'cookie', 'a'.repeat(65)),
    rule('copy', 'cookie', 'a*'),
    rule('skip', 'query', 'utm_*'),
    rule('copy', 'query', 'utm_*'),
    rule('skip', 'query', ''),
    rule('skip', 'query', 'a'.repeat(65)),
    rule('ignore', 'query', '*'),
    rule('ignore', 'query', 'a*b'),
    rule('ignore', 'query', 'a**'),
    rule('ignore', 'query', `${'a'.repeat(65)}*`),
    rule('skip', 'agent', ''),
    rule('skip', 'agent', 'é'),
    rule('skip', 'agent', 'a'.repeat(65)),
    rule('skip', 'postType', ''),
    rule('skip', 'postType', 'Product'),
    rule('skip', 'postType', 'a.b'),
    rule('skip', 'postType', 'a'.repeat(21)),
    rule('copy', 'phone', 'iPhone'),
  ])('refuses $kind $match "$value"', (r) => {
    expect(cacheRuleProblem(r)).not.toBeNull();
  });

  it('allows the longest values', () => {
    expect(cacheRuleProblem(rule('skip', 'path', `/${'a'.repeat(199)}`))).toBeNull();
    expect(cacheRuleProblem(rule('skip', 'cookie', 'a'.repeat(64)))).toBeNull();
    expect(cacheRuleProblem(rule('skip', 'query', 'a'.repeat(64)))).toBeNull();
    expect(cacheRuleProblem(rule('ignore', 'query', `${'a'.repeat(64)}*`))).toBeNull();
    expect(cacheRuleProblem(rule('skip', 'agent', 'a'.repeat(64)))).toBeNull();
    expect(cacheRuleProblem(rule('skip', 'postType', 'a'.repeat(20)))).toBeNull();
  });

  it('holds each kind to the matches it takes', () => {
    const kinds = Object.keys(CACHE_RULE_MATCHES) as CacheRuleKind[];
    const all: CacheRuleMatch[] = ['path', 'cookie', 'query', 'agent', 'postType', 'phone'];
    for (const kind of kinds) {
      for (const match of all) {
        if (CACHE_RULE_MATCHES[kind].includes(match)) continue;
        expect(cacheRuleProblem(rule(kind, match, match === 'path' ? '/a' : 'a', kind === 'keep' ? 60 : undefined))).toMatch(/cannot match/);
      }
    }
  });

  it('stands up to what a bad row can hold', () => {
    const junk = (r: unknown) => cacheRuleProblem(r as CacheRule);
    expect(junk({ kind: 'evil', match: 'path', value: '/a' })).not.toBeNull();
    expect(junk({ kind: 'skip', match: 'evil', value: '/a' })).not.toBeNull();
    expect(junk({ kind: 'skip', match: 'path', value: 7 })).not.toBeNull();
    expect(junk({ kind: 'skip', match: 'path', value: null })).not.toBeNull();
    expect(junk({ kind: 'skip', match: 'path' })).not.toBeNull();
    expect(junk({ kind: '__proto__', match: 'path', value: '/a' })).not.toBeNull();
  });

  it('holds a keep time to the 10-hour ceiling', () => {
    expect(MAX_KEEP_SECONDS).toBe(36_000);
    expect(cacheRuleProblem(rule('keep', 'path', '/a', MAX_KEEP_SECONDS))).toBeNull();
    expect(cacheRuleProblem(rule('keep', 'path', '/a', MAX_KEEP_SECONDS + 1))).toMatch(/10 hours/);
    expect(cacheRuleProblem(rule('keep', 'path', '/a'))).not.toBeNull();
    expect(cacheRuleProblem(rule('keep', 'path', '/a', 0))).not.toBeNull();
    expect(cacheRuleProblem(rule('keep', 'path', '/a', -1))).not.toBeNull();
    expect(cacheRuleProblem(rule('keep', 'path', '/a', 1.5))).not.toBeNull();
    expect(cacheRuleProblem(rule('skip', 'path', '/a', 60))).toMatch(/Only a keep rule/);
    expect(NOT_FOUND_SECONDS).toBe(300);
  });
});

describe('a path as nginx and PHP compare it', () => {
  // Node's latin1 keeps bytes as characters, which is how a regex in byte mode sees them.
  const bytes = (uri: string) => Buffer.from(uri, 'utf8').toString('latin1');
  const matches = (value: string, uri: string) => new RegExp(cachePathRegex(value)).test(bytes(uri));

  it('takes a page with or without its last slash', () => {
    for (const value of ['/shop/', '/shop']) {
      expect(matches(value, '/shop')).toBe(true);
      expect(matches(value, '/shop/')).toBe(true);
      expect(matches(value, '/shop/x')).toBe(false);
      expect(matches(value, '/shopping')).toBe(false);
      expect(matches(value, '/a/shop')).toBe(false);
    }
  });

  it('takes a page and what is under it', () => {
    expect(matches('/shop/*', '/shop')).toBe(true);
    expect(matches('/shop/*', '/shop/')).toBe(true);
    expect(matches('/shop/*', '/shop/x/y')).toBe(true);
    expect(matches('/shop/*', '/shopping')).toBe(false);
  });

  it('takes whatever starts so', () => {
    expect(matches('/shop*', '/shop')).toBe(true);
    expect(matches('/shop*', '/shopping/x')).toBe(true);
    expect(matches('/shop*', '/sho')).toBe(false);
  });

  it('takes the root apart from the rest', () => {
    expect(matches('/', '/')).toBe(true);
    expect(matches('/', '/x')).toBe(false);
    expect(matches('/*', '/x/y')).toBe(true);
  });

  it('escapes a dot', () => {
    expect(matches('/wp-login.php', '/wp-login.php')).toBe(true);
    expect(matches('/wp-login.php', '/wp-loginXphp')).toBe(false);
  });

  it('compares non-ASCII letters byte for byte, typed or percent-encoded', () => {
    expect(cachePathBytes('/é/')).toEqual([0x2f, 0xc3, 0xa9, 0x2f]);
    expect(cachePathBytes('/%C3%A9/')).toEqual([0x2f, 0xc3, 0xa9, 0x2f]);
    expect(cachePathBytes('/%c3%a9/*')).toEqual([0x2f, 0xc3, 0xa9, 0x2f]);
    expect(cachePathRegex('/é/')).toBe('^/\\xC3\\xA9/?$');
    expect(cachePathRegex('/%C3%A9/')).toBe(cachePathRegex('/é/'));
    for (const value of ['/日本語/', '/%E6%97%A5%E6%9C%AC%E8%AA%9E/']) {
      expect(matches(value, '/日本語')).toBe(true);
      expect(matches(value, '/日本')).toBe(false);
    }
  });

  it('never lets what %XX stands for into the regex as itself', () => {
    expect(cachePathRegex('/a%2Ab%20c%3F/')).toBe('^/a\\x2Ab\\x20c\\x3F/?$');
    expect(cachePathRegex('/a%22b%24c%5Cd%7Ce/')).toBe('^/a\\x22b\\x24c\\x5Cd\\x7Ce/?$');
    // A star spelled %2A is a star, not a wildcard.
    expect(matches('/a%2A', '/a*')).toBe(true);
    expect(matches('/a%2A', '/ab')).toBe(false);
  });

  it('escapes what means something to a regular expression', () => {
    expect(cacheRegexEscape('a.b(c)+d')).toBe('a\\.b\\(c\\)\\+d');
    expect(new RegExp(cacheRegexEscape('Foo (X11; Bar) a+b.c/1')).test('Foo (X11; Bar) a+b.c/1')).toBe(true);
    expect(new RegExp(cacheRegexEscape('a.b')).test('aXb')).toBe(false);
  });
});

describe('a skip reason', () => {
  it('names the rule', () => {
    expect(cacheRuleReason({ match: 'path', value: '/wp-admin/*' })).toBe('path /wp-admin/*');
    expect(cacheRuleReason({ match: 'cookie', value: 'PHPSESSID' })).toBe('cookie PHPSESSID');
    expect(cacheRuleReason({ match: 'postType', value: 'product' })).toBe('post type product');
  });

  it('stays ASCII, because it goes out in a header', () => {
    expect(cacheRuleReason({ match: 'path', value: '/café/*' })).toBe('path /caf%C3%A9/*');
    expect(cacheRuleReason({ match: 'path', value: '/caf%C3%A9/*' })).toBe('path /caf%C3%A9/*');
    expect(cacheRuleReason({ match: 'path', value: '/日本/' })).toBe('path /%E6%97%A5%E6%9C%AC/');
  });
});

describe('the built-in groups', () => {
  const group = (id: string) => CACHE_RULE_GROUPS.find((g) => g.id === id)!;
  const values = (id: string, kind: CacheRuleKind, match: CacheRuleMatch) =>
    group(id)
      .rules.filter((r) => r.kind === kind && r.match === match)
      .map((r) => r.value);

  it('are all good rules, with ids that can be told apart', () => {
    const ids = CACHE_RULE_GROUPS.flatMap((g) => [g.id, ...g.rules.map((r) => r.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of CACHE_RULE_GROUPS) {
      expect(g.id).not.toContain('.');
      expect(g.rules.length).toBeGreaterThan(0);
      for (const r of g.rules) {
        expect(r.id.startsWith(`${g.id}.`)).toBe(true);
        expect(cacheRuleProblem(r)).toBeNull();
      }
    }
  });

  it('lock only the WordPress group', () => {
    expect(CACHE_RULE_GROUPS.filter((g) => g.lockedReason).map((g) => g.id)).toEqual(['wordpress']);
  });

  it('have what the WordPress group needs', () => {
    expect(values('wordpress', 'skip', 'cookie')).toEqual(['wordpress_logged_in_', 'wp-postpass_', 'comment_author_', 'wordpress_no_cache']);
    expect(values('wordpress', 'skip', 'path')).toEqual([
      '/wp-admin/*',
      '/wp-login.php',
      '/xmlrpc.php',
      '/wp-cron.php',
      '/wp-json/*',
      '/wp-comments-post.php',
      '/wp-content/*',
      '/wp-includes/*',
    ]);
    // Has to match the user agent the panel's own checks send.
    expect(values('wordpress', 'skip', 'agent')).toEqual(['wpl7-probe/1']);
  });

  it('have the plugins’ own names', () => {
    expect(values('phones', 'copy', 'phone')).toEqual(['']);
    expect(values('php-sessions', 'skip', 'cookie')).toEqual(['PHPSESSID']);
    expect(values('woocommerce', 'skip', 'cookie')).toEqual(['woocommerce_items_in_cart', 'woocommerce_cart_hash', 'wp_woocommerce_session_']);
    expect(values('woocommerce', 'copy', 'query')).toEqual(['v']);
    expect(values('easy-digital-downloads', 'skip', 'cookie')).toEqual(['edd_items_in_cart']);
    expect(values('currency', 'copy', 'cookie')).toEqual([
      'aelia_cs_selected_currency',
      'aelia_customer_country',
      'aelia_customer_state',
      'aelia_tax_exempt',
      'wcml_client_currency',
      'wcml_client_currency_language',
      'wcml_client_country',
      'woocommerce_current_currency',
      'wmc_current_currency',
      'wmc_current_currency_old',
      'woocs_current_currency',
    ]);
    expect(values('languages', 'copy', 'cookie')).toEqual(['pll_language', 'wp-wpml_current_language']);
    expect(values('tracking', 'ignore', 'query')).toEqual(['utm_*', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', '_gl']);
  });

  it('say which plugins mark them In use', () => {
    expect(cacheGroupInUse(group('woocommerce'), ['akismet', 'woocommerce'])).toBe(true);
    expect(cacheGroupInUse(group('woocommerce'), ['akismet'])).toBe(false);
    expect(cacheGroupInUse(group('languages'), new Set(['polylang']))).toBe(true);
    expect(cacheGroupInUse(group('currency'), ['woo-multi-currency'])).toBe(true);
    expect(cacheGroupInUse(group('easy-digital-downloads'), ['easy-digital-downloads'])).toBe(true);
    expect(cacheGroupInUse(group('phones'), ['anything'])).toBe(false);
  });

  describe('the harmless cookies', () => {
    const harmless = (name: string) => HARMLESS_COOKIES.some((pattern) => new RegExp(`^(?:${pattern})$`).test(name));

    it.each(['_ga', '_ga_ABC123', '_gid', '_gat', '_gat_UA-123-1', '_gat_gtag_UA_123_1', '_gcl_au', '_gcl_aw', '_fbp', '_fbc', '_hjid', '_hjSession_123', '_hjSessionUser_123', '_hjFirstSeen', '_clck', '_clsk', '_uetsid', '_uetvid', '__utma', '__utmz', '__cf_bm', 'cf_clearance', 'wp-settings-1', 'wp-settings-time-1', 'wordpress_test_cookie'])(
      'take %s',
      (name) => {
        expect(harmless(name)).toBe(true);
      },
    );

    it.each(['wordpress_logged_in_x', 'wp-postpass_x', 'comment_author_x', 'session', 'PHPSESSID', '_gateway_session', '_hjMember', '_gid_member', '_fbp_login', '_ga_member', '__utmost', '_gcl_member', 'wp-settings-member', 'cf_clearance2'])(
      'do not take %s',
      (name) => {
        expect(harmless(name)).toBe(false);
      },
    );

    // Complianz draws what a visitor agreed to in PHP, so one who agreed would store a page for one who refused.
    it.each(['cookieyes-consent', 'CookieConsent', 'cmplz_marketing', 'borlabs-cookie', 'euconsent-v2', 'OptanonConsent', 'OptanonAlertBoxClosed'])('do not take a consent cookie: %s', (name) => {
      expect(harmless(name)).toBe(false);
    });

    it('hold nothing that could end a quoted word in nginx', () => {
      for (const pattern of HARMLESS_COOKIES) expect(pattern).toMatch(/^[A-Za-z0-9_(){}[\]?:|+-]+$/);
    });
  });
});

describe('what a site keeps', () => {
  const empty = { keepSeconds: null, off: [], own: [], offReason: null };

  it('reads a column that holds nothing useful as no changes', () => {
    for (const stored of [null, undefined, '', 'not json', '{', '[]', '"text"', '7', 'null', 7, true, []]) {
      expect(parseSiteCacheRules(stored)).toEqual(empty);
    }
    expect(noCacheRules()).toEqual(empty);
    // A fresh object each time: nothing can change what another site reads.
    expect(noCacheRules().own).not.toBe(noCacheRules().own);
  });

  it('reads a good row', () => {
    const stored = {
      keepSeconds: 600,
      off: ['phones', 'tracking.gclid'],
      own: [own('a1', 'skip', 'path', '/x/'), own('a2', 'keep', 'postType', 'event', 60)],
      offReason: 'A reason.',
    };
    expect(parseSiteCacheRules(JSON.stringify(stored))).toEqual(stored);
    expect(parseSiteCacheRules(stored)).toEqual(stored);
  });

  it('keeps a time within the ceiling, and drops one that is none', () => {
    expect(parseSiteCacheRules('{"keepSeconds":999999}').keepSeconds).toBe(MAX_KEEP_SECONDS);
    expect(parseSiteCacheRules('{"keepSeconds":60.9}').keepSeconds).toBe(60);
    for (const bad of ['0', '-5', '"600"', 'null', 'true', '{}']) {
      expect(parseSiteCacheRules(`{"keepSeconds":${bad}}`).keepSeconds).toBeNull();
    }
  });

  it('drops what cannot be read from the switches', () => {
    expect(parseSiteCacheRules('{"off":"phones"}').off).toEqual([]);
    expect(parseSiteCacheRules({ off: ['phones', 7, null, '', 'phones', 'x'.repeat(65), 'tracking'] }).off).toEqual(['phones', 'tracking']);
  });

  it('reads a reason only when there is one', () => {
    expect(parseSiteCacheRules('{"offReason":"  Why.  "}').offReason).toBe('Why.');
    expect(parseSiteCacheRules('{"offReason":"   "}').offReason).toBeNull();
    expect(parseSiteCacheRules('{"offReason":7}').offReason).toBeNull();
    expect(parseSiteCacheRules({ offReason: 'x'.repeat(1000) }).offReason).toHaveLength(300);
  });

  it('drops what cannot be a rule, and keeps a rule with a bad value for the card to show', () => {
    const parsed = parseSiteCacheRules({
      own: [
        'text',
        7,
        null,
        [],
        { kind: 'evil', match: 'path', value: '/x' },
        { kind: 'skip', match: 'evil', value: '/x' },
        { kind: 'skip', match: 'path', value: 7 },
        { kind: 'skip', match: 'path' },
        { id: 'bad', kind: 'skip', match: 'path', value: '/"; } evil #' },
        { kind: 'keep', match: 'path', value: '/x', seconds: '60' },
      ],
    });
    expect(parsed.own).toEqual([
      { id: 'bad', kind: 'skip', match: 'path', value: '/"; } evil #' },
      { id: 'r1', kind: 'keep', match: 'path', value: '/x' },
    ]);
    expect(cacheRuleProblem(parsed.own[0]!)).not.toBeNull();
    expect(cacheRuleProblem(parsed.own[1]!)).not.toBeNull();
  });

  it('gives a rule an id it can be found by, and never a built-in one', () => {
    const parsed = parseSiteCacheRules({
      own: [
        { id: 'wordpress.admin', kind: 'skip', match: 'path', value: '/a' },
        { id: 'same', kind: 'skip', match: 'path', value: '/b' },
        { id: 'same', kind: 'skip', match: 'path', value: '/c' },
      ],
    });
    const ids = parsed.own.map((r) => r.id);
    expect(ids[0]).toBe('r0');
    expect(ids[1]).toBe('same');
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{1,12}$/);
  });

  it('holds a stored list to the caps', () => {
    expect(MAX_OWN_RULES).toBe(50);
    expect(MAX_OWN_COPY_RULES).toBe(5);
    const many = Array.from({ length: 60 }, (_, i) => own(`r${i}`, 'skip', 'path', `/${i}`));
    expect(parseSiteCacheRules({ own: many }).own).toHaveLength(MAX_OWN_RULES);
    const copies = Array.from({ length: 8 }, (_, i) => own(`c${i}`, 'copy', 'cookie', `c${i}`));
    const parsed = parseSiteCacheRules({ own: [...copies, own('p', 'skip', 'path', '/p')] }).own;
    expect(parsed.filter((r) => r.kind === 'copy')).toHaveLength(MAX_OWN_COPY_RULES);
    expect(parsed.at(-1)!.id).toBe('p');
  });

  it('works out how long a site keeps pages', () => {
    expect(siteKeepSeconds({ keepSeconds: null }, 36_000)).toBe(36_000);
    expect(siteKeepSeconds({ keepSeconds: 600 }, 36_000)).toBe(600);
    expect(siteKeepSeconds({ keepSeconds: null }, 999_999)).toBe(MAX_KEEP_SECONDS);
    expect(clampKeepSeconds(MAX_KEEP_SECONDS + 1)).toBe(MAX_KEEP_SECONDS);
    expect(clampKeepSeconds(0)).toBe(MAX_KEEP_SECONDS);
    expect(clampKeepSeconds(Number.NaN)).toBe(MAX_KEEP_SECONDS);
    expect(clampKeepSeconds(90.5)).toBe(90);
  });
});

describe('what the API takes', () => {
  it('takes rules of every kind a site can add', () => {
    const rules = [
      { kind: 'skip', match: 'path', value: '/a/*' },
      { kind: 'skip', match: 'cookie', value: 'a' },
      { kind: 'skip', match: 'query', value: 'a' },
      { kind: 'skip', match: 'agent', value: 'Foo/1' },
      { kind: 'skip', match: 'postType', value: 'event' },
      { kind: 'copy', match: 'cookie', value: 'a' },
      { kind: 'copy', match: 'query', value: 'a' },
      { kind: 'keep', match: 'path', value: '/a/', seconds: 60 },
      { kind: 'keep', match: 'postType', value: 'event', seconds: 60 },
      { kind: 'ignore', match: 'query', value: 'ref_*' },
    ];
    expect(ownCacheRulesSchema.safeParse(rules).success).toBe(true);
  });

  it('refuses a value the check refuses, and says why', () => {
    const res = cacheRuleSchema.safeParse({ kind: 'skip', match: 'path', value: '/a;b' });
    expect(res.success).toBe(false);
    expect(res.error!.issues[0]!.message).toMatch(/letters, digits/);
    expect(cacheRuleSchema.safeParse({ kind: 'keep', match: 'path', value: '/a', seconds: 36_001 }).success).toBe(false);
  });

  it('has no use for a phone rule of a site’s own: there is a switch', () => {
    expect(cacheRuleSchema.safeParse({ kind: 'copy', match: 'phone', value: '' }).success).toBe(false);
  });

  it('refuses unknown fields and an id that could be taken for a built-in rule', () => {
    expect(cacheRuleSchema.safeParse({ kind: 'skip', match: 'path', value: '/a', note: 'x' }).success).toBe(false);
    expect(cacheRuleSchema.safeParse({ id: 'wordpress.admin', kind: 'skip', match: 'path', value: '/a' }).success).toBe(false);
  });

  it('holds a list to the caps', () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'skip', match: 'path', value: `/${i}` }));
    expect(ownCacheRulesSchema.safeParse(paths(MAX_OWN_RULES)).success).toBe(true);
    expect(ownCacheRulesSchema.safeParse(paths(MAX_OWN_RULES + 1)).success).toBe(false);
    const copies = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'copy', match: 'cookie', value: `c${i}` }));
    expect(ownCacheRulesSchema.safeParse(copies(MAX_OWN_COPY_RULES)).success).toBe(true);
    expect(ownCacheRulesSchema.safeParse(copies(MAX_OWN_COPY_RULES + 1)).success).toBe(false);
  });

  it('refuses two rules with one id, and gives the rest ids of their own', () => {
    const two = [
      { id: 'a', kind: 'skip', match: 'path', value: '/a' },
      { id: 'a', kind: 'skip', match: 'path', value: '/b' },
    ];
    expect(ownCacheRulesSchema.safeParse(two).success).toBe(false);
    const parsed = ownCacheRulesSchema.parse([{ id: 'a', kind: 'skip', match: 'path', value: '/a' }, { kind: 'skip', match: 'path', value: '/b' }]);
    let next = 0;
    const ids = withCacheRuleIds(parsed, () => ['a', 'b'][next++]!).map((r) => r.id);
    expect(ids).toEqual(['a', 'b']);
    expect(withCacheRuleIds([{ kind: 'skip', match: 'path', value: '/a' }])[0]!.id).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe('which rules are in force', () => {
  const allBuiltIn = CACHE_RULE_GROUPS.flatMap((g) => g.rules);
  const ids = (rules: readonly CacheRule[]) => rules.map((r) => r.id);

  it('has every built-in rule for a site that changed nothing', () => {
    expect(activeCacheRules(noCacheRules())).toEqual(allBuiltIn);
  });

  it('leaves out a group that is switched off, whole', () => {
    const active = ids(activeCacheRules({ off: ['woocommerce'], own: [] }));
    expect(active.filter((id) => id.startsWith('woocommerce.'))).toEqual([]);
    expect(active).toContain('phones.copy');
  });

  it('leaves out one rule that is switched off, and only that', () => {
    const active = ids(activeCacheRules({ off: ['woocommerce.location'], own: [] }));
    expect(active).not.toContain('woocommerce.location');
    expect(active).toContain('woocommerce.items-in-cart');
  });

  it('never leaves out the WordPress group or a rule of it', () => {
    const wordpress = ids(CACHE_RULE_GROUPS.find((g) => g.id === 'wordpress')!.rules);
    const active = ids(activeCacheRules({ off: ['wordpress', ...wordpress], own: [] }));
    expect(active).toEqual(expect.arrayContaining(wordpress));
  });

  it('puts a site’s own rules last, so they never take a request from WordPress’s', () => {
    const mine = own('a', 'skip', 'path', '/mine/');
    const active = activeCacheRules({ off: [], own: [mine] });
    expect(active.at(-1)).toEqual(mine);
    expect(active.slice(0, -1)).toEqual(allBuiltIn);
  });

  it('ignores an id it does not know, like one a later release removed', () => {
    expect(activeCacheRules({ off: ['gone', 'gone.rule'], own: [] })).toEqual(allBuiltIn);
  });

  it('leaves out a stored rule that fails its check, and says so', () => {
    const warnings: string[] = [];
    const bad = own('bad', 'skip', 'path', '/"; } evil #');
    const good = own('good', 'skip', 'path', '/good/');
    const usable = usableCacheRules({ off: [], own: [bad, good] }, (m) => warnings.push(m));
    expect(ids(usable)).not.toContain('bad');
    expect(ids(usable)).toContain('good');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"bad"');
  });

  it('leaves a value out of the warning: it is whatever the row held', () => {
    const warnings: string[] = [];
    usableCacheRules({ off: [], own: [own('bad', 'skip', 'cookie', 'evil\ninjected')] }, (m) => warnings.push(m));
    expect(warnings.join('\n')).not.toContain('injected');
  });

  it('counts the same rule once', () => {
    const twice = own('a', 'skip', 'cookie', 'PHPSESSID');
    expect(usableCacheRules({ off: [], own: [twice] }).filter((r) => r.value === 'PHPSESSID')).toHaveLength(1);
    expect(usableCacheRules({ off: ['php-sessions'], own: [twice] }).filter((r) => r.value === 'PHPSESSID')).toEqual([twice]);
  });
});
