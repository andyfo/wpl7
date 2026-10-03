import { describe, expect, it } from 'vitest';
import { CidrSet } from '../../shared/cidr.js';
import {
  customRulesSchema,
  effectivePolicy,
  parseSecurityName,
  withRuleIds,
  type CustomRuleInput,
  type SecurityLevel,
  type SecurityOverrides,
} from '../../shared/security.js';
import type { TrustedProxy } from '../../src/lib/clientIp.js';
import { RANGE_SOURCES } from '../../src/services/proxyRanges.js';
import {
  RuleValueError,
  buildSiteSecurityConfig,
  bypassList,
  fleetAddresses,
  quoteRegex,
  renderDynamicFile,
  type DynamicConfig,
  type SiteRulesInput,
} from '../../src/services/securityConfig.js';
import { route, ruleMatches, type SimRequest } from '../traefikSim.js';

const CLOUDFLARE: TrustedProxy = { name: 'cloudflare', header: 'Cf-Connecting-Ip', ranges: new CidrSet(RANGE_SOURCES.cloudflare.builtin) };
const FLEET = ['203.0.113.10', '203.0.113.11'];
const DOMAINS = ['my-blog.com', 'www.my-blog.com', 'my-blog.dev.example.com'];

function input(
  opts: { level?: SecurityLevel; overrides?: SecurityOverrides; rules?: CustomRuleInput[]; over?: Partial<SiteRulesInput> } = {},
): SiteRulesInput {
  const customRules = withRuleIds(customRulesSchema.parse(opts.rules ?? []));
  return {
    slug: 'my-blog',
    domains: DOMAINS,
    policy: effectivePolicy({ level: opts.level ?? 'standard', overrides: {} }, { level: null, overrides: opts.overrides ?? {}, customRules }),
    tlsMode: 'letsencrypt',
    proxies: [CLOUDFLARE],
    bypass: bypassList({ fleet: FLEET, neverBlock: ['198.51.100.0/24'], bypassPrivate: true }),
    fleet: FLEET,
    jetpack: RANGE_SOURCES.jetpack.builtin,
    ...opts.over,
  };
}

const build = (i: SiteRulesInput) => buildSiteSecurityConfig(i)!;

/** A visitor on the internet, direct. */
const VISITOR = '198.18.7.7';

function ask(config: DynamicConfig | null, req: Partial<SimRequest> & { path: string }) {
  const full: SimRequest = { host: 'my-blog.com', method: 'GET', peer: VISITOR, ...req };
  const [path, query] = full.path.split('?') as [string, string | undefined];
  return route(config, { ...full, path, query: query ?? full.query ?? '' }, DOMAINS, 'my-blog');
}

describe('the rules file', () => {
  it('reads as it should', async () => {
    const config = build(input({ rules: [{ action: 'block', conditions: [{ field: 'path', op: 'startsWith', value: '/private/' }] }] }));
    // The custom rule's id is random; pin it so the file compares.
    const text = renderDynamicFile(config, ['Written by the WPL7 panel: the protection of "my-blog" (standard).']).replace(
      /block-[a-z0-9]{6}/g,
      'block-abc123',
    );
    await expect(text).toMatchFileSnapshot('../fixtures/security/sec-standard.yml');
  });

  it('is not written at all for a site whose protection is off', () => {
    expect(buildSiteSecurityConfig(input({ level: 'off' }))).toBeNull();
  });

  it('names every router and middleware after its site, so the name splits back apart', () => {
    const config = build(input({ level: 'strict' }));
    for (const name of [...Object.keys(config.http.routers), ...Object.keys(config.http.middlewares)]) {
      expect(parseSecurityName(name)?.slug, name).toBe('my-blog');
    }
  });

  it('borrows nothing from Docker but the container service', () => {
    const config = build(input({ level: 'strict' }));
    const defined = new Set(Object.keys(config.http.middlewares));
    for (const router of Object.values(config.http.routers)) {
      expect(router.service).toBe('wp-my-blog@docker');
      for (const mw of router.middlewares ?? []) expect(defined.has(mw), mw).toBe(true);
      expect(router.tls).toEqual({});
      expect(router.entryPoints).toEqual(['websecure']);
    }
  });

  it('serves plain HTTP on the web entrypoint where TLS is off', () => {
    const config = build(input({ over: { tlsMode: 'none' } }));
    for (const router of Object.values(config.http.routers)) {
      expect(router.entryPoints).toEqual(['web']);
      expect(router.tls).toBeUndefined();
    }
  });
});

describe('what answers a request, at Standard', () => {
  const config = build(input());
  const refused = (req: Partial<SimRequest> & { path: string }) => ask(config, req).answer;

  it.each([
    ['/.env'],
    ['/.env.production'],
    ['/.git/config'],
    ['/wp-config.php.bak'],
    ['/.wp-config.php.swp'],
    ['/wp-config.php'],
    ['/wp-content/debug.log'],
    ['/backup.sql.gz'],
    ['/wp-content/uploads/2026/09/shell.php'],
    ['/wp-content/uploads/x.PHTML'],
    ['/wp-content/uploads/x.php/anything'],
    ['/wp-content/uploads/cat.php.jpg'],
    ['/wp-admin/install.php'],
    ['/wp-admin/setup-config.php?step=1'],
    ['/?author=1'],
    ['/index.php?author=2'],
    ['/wp-json/wp/v2/users'],
    ['/?rest_route=/wp/v2/users'],
  ])('refuses %s', (path) => {
    expect(refused({ path })).toBe('refused');
  });

  it.each([
    ['/'],
    ['/.well-known/acme-challenge/abc'],
    ['/.well-known/security.txt'],
    ['/wp-admin/edit.php?author=1'],
    ['/wp-content/uploads/2026/09/cat.jpg'],
    ['/wp-content/themes/x/functions.php'],
    ['/environment/'],
    ['/blog/my-sql-tips/'],
    ['/wp-admin/upgrade.php'],
    ['/?authorised=1'],
  ])('lets %s through', (path) => {
    expect(refused({ path })).not.toBe('refused');
  });

  it('refuses scanners by user agent, and not browsers', () => {
    expect(refused({ path: '/', headers: { 'User-Agent': 'sqlmap/1.8#stable (https://sqlmap.org)' } })).toBe('refused');
    expect(refused({ path: '/', headers: { 'User-Agent': 'WPScan v3.8.25 (https://wpscan.com/wordpress-security-scanner)' } })).toBe('refused');
    expect(refused({ path: '/', headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' } })).not.toBe('refused');
  });

  it('gives the REST users list to the block editor, and to an application password', () => {
    expect(refused({ path: '/wp-json/wp/v2/users?context=edit', headers: { 'X-WP-Nonce': 'abc123' } })).not.toBe('refused');
    expect(refused({ path: '/wp-json/wp/v2/users', headers: { Authorization: 'Basic eDp5' } })).not.toBe('refused');
  });

  it('limits login attempts, per visitor, whatever the path after wp-login.php', () => {
    const post = ask(config, { path: '/wp-login.php', method: 'POST' });
    expect(post).toMatchObject({ router: 'wpl7sec_login_my-blog', answer: 'limited', limit: { average: 20, burst: 2, period: '1m', by: 'peer' } });
    expect(ask(config, { path: '/wp-login.php/x', method: 'POST' }).router).toBe('wpl7sec_login_my-blog');
    // Showing the form is an ordinary request.
    expect(ask(config, { path: '/wp-login.php' }).router).toBe('wpl7sec_main_my-blog');
  });

  it("counts a visitor behind Cloudflare by Cloudflare's header", () => {
    const post = ask(config, { path: '/wp-login.php', method: 'POST', peer: '173.245.48.9', headers: { 'Cf-Connecting-Ip': '198.18.1.1' } });
    expect(post).toMatchObject({ router: 'wpl7sec_login-p0_my-blog', limit: { by: 'Cf-Connecting-Ip' } });
    // The header from anyone else counts for nothing: that visitor is counted by address.
    const forged = ask(config, { path: '/wp-login.php', method: 'POST', headers: { 'Cf-Connecting-Ip': '198.18.1.1' } });
    expect(forged).toMatchObject({ router: 'wpl7sec_login_my-blog', limit: { by: 'peer' } });
  });

  it("limits XML-RPC, except for Jetpack's servers", () => {
    expect(ask(config, { path: '/xmlrpc.php', method: 'POST' })).toMatchObject({ router: 'wpl7sec_xmlrpc_my-blog', limit: { average: 30 } });
    expect(ask(config, { path: '/xmlrpc.php', method: 'POST', peer: '192.0.80.5' }).router).toBe('wpl7sec_main_my-blog');
  });

  it("knows Jetpack behind Cloudflare by Cloudflare's header", () => {
    const xmlrpc = (visitor: string, peer = '173.245.48.9') => ask(config, { path: '/xmlrpc.php', method: 'POST', peer, headers: { 'Cf-Connecting-Ip': visitor } });
    expect(xmlrpc('192.0.80.5').router).toBe('wpl7sec_main-p0_my-blog');
    expect(xmlrpc('198.18.1.1')).toMatchObject({ router: 'wpl7sec_xmlrpc-p0_my-blog', limit: { by: 'Cf-Connecting-Ip' } });
    // The header from anyone else counts for nothing.
    expect(xmlrpc('192.0.80.5', VISITOR).router).toBe('wpl7sec_xmlrpc_my-blog');
  });

  it('gives assets their own generous limit', () => {
    expect(ask(config, { path: '/wp-content/themes/x/style.css' })).toMatchObject({ router: 'wpl7sec_static_my-blog', limit: { average: 200, burst: 4000 } });
    expect(ask(config, { path: '/blog/' })).toMatchObject({ router: 'wpl7sec_main_my-blog', limit: { average: 50, burst: 500, period: '1s' } });
  });

  it("never slows the fleet's own traffic or a private address, but still refuses to them", () => {
    for (const peer of ['203.0.113.10', '172.18.0.1', '10.0.0.3', '198.51.100.40']) {
      expect(ask(config, { path: '/blog/', peer })).toMatchObject({ router: 'wpl7sec_infra_my-blog', answer: 'served' });
      expect(ask(config, { path: '/.env', peer }).answer, peer).toBe('refused');
    }
  });

  it('limits private addresses too when the bypass is off', () => {
    const strictPrivate = build(input({ over: { bypass: bypassList({ fleet: FLEET, neverBlock: [], bypassPrivate: false }) } }));
    expect(ask(strictPrivate, { path: '/blog/', peer: '172.18.0.1' }).router).toBe('wpl7sec_main_my-blog');
  });

  it('adds nosniff to what it serves and sends an alias to the canonical host', () => {
    expect(config.http.middlewares['wpl7sec_headers_my-blog']).toEqual({ headers: { contentTypeNosniff: true } });
    const canonical = config.http.middlewares['wpl7sec_canonical_my-blog'];
    expect(canonical).toMatchObject({ redirectRegex: { replacement: 'https://my-blog.com/${1}', permanent: true } });
    const re = new RegExp((canonical as { redirectRegex: { regex: string } }).redirectRegex.regex);
    expect(re.test('https://www.my-blog.com/blog/')).toBe(true);
    expect(re.test('https://my-blog.com/blog/')).toBe(false);
    expect(ask(config, { path: '/blog/' }).middlewares).toEqual(['wpl7sec_limit-requests_my-blog', 'wpl7sec_headers_my-blog', 'wpl7sec_canonical_my-blog']);
  });

  it('answers only for its own site', () => {
    expect(() => ask(config, { host: 'other.com', path: '/.env' })).toThrow(/Nothing routes/);
  });
});

describe('what Strict adds', () => {
  const config = build(input({ level: 'strict' }));

  it("refuses XML-RPC, except to Jetpack's servers", () => {
    expect(ask(config, { path: '/xmlrpc.php', method: 'POST' }).answer).toBe('refused');
    expect(ask(config, { path: '/xmlrpc.php', method: 'POST', peer: '192.0.80.5' }).answer).not.toBe('refused');
  });

  it('lets Jetpack through behind a trusted proxy, named alone in its header', () => {
    const lb: TrustedProxy = { name: 'lb', header: 'True-Client-Ip', ranges: new CidrSet(['192.0.2.0/24']) };
    const both = build(input({ level: 'strict', over: { proxies: [CLOUDFLARE, lb] } }));
    const xmlrpc = (peer: string, headers: Record<string, string>) => ask(both, { path: '/xmlrpc.php', method: 'POST', peer, headers }).answer;
    expect(xmlrpc('173.245.48.9', { 'Cf-Connecting-Ip': '192.0.80.5' })).not.toBe('refused');
    expect(xmlrpc('173.245.48.9', { 'Cf-Connecting-Ip': '195.234.111.255' })).not.toBe('refused');
    expect(xmlrpc('192.0.2.7', { 'True-Client-Ip': '122.248.245.244' })).not.toBe('refused');
    expect(xmlrpc('173.245.48.9', { 'Cf-Connecting-Ip': '198.18.1.1' })).toBe('refused');
    // One address and nothing else: a list, or more after it, is no Jetpack.
    expect(xmlrpc('173.245.48.9', { 'Cf-Connecting-Ip': '192.0.80.5, 198.18.1.1' })).toBe('refused');
    expect(xmlrpc('173.245.48.9', { 'Cf-Connecting-Ip': '192.0.80.5.7' })).toBe('refused');
    // Each proxy's own header, and only from that proxy.
    expect(xmlrpc('173.245.48.9', { 'True-Client-Ip': '192.0.80.5' })).toBe('refused');
    expect(xmlrpc(VISITOR, { 'Cf-Connecting-Ip': '192.0.80.5', 'True-Client-Ip': '192.0.80.5' })).toBe('refused');
  });

  it('refuses wp-cron.php from outside the fleet', () => {
    expect(ask(config, { path: '/wp-cron.php' }).answer).toBe('refused');
    expect(ask(config, { path: '/wp-cron.php', peer: '203.0.113.11' }).answer).not.toBe('refused');
    expect(ask(config, { path: '/wp-cron.php', peer: '172.18.0.1' }).answer).not.toBe('refused');
  });

  it('limits harder and sends every header', () => {
    expect(ask(config, { path: '/wp-login.php', method: 'POST' }).limit).toMatchObject({ average: 6, burst: 2 });
    expect(config.http.middlewares['wpl7sec_headers_my-blog']).toEqual({
      headers: { contentTypeNosniff: true, customFrameOptionsValue: 'SAMEORIGIN', stsSeconds: 31_536_000, referrerPolicy: 'strict-origin-when-cross-origin' },
    });
  });
});

describe('single rules switched off', () => {
  it('leave that request to the next router down', () => {
    const config = build(input({ overrides: { rules: { files: false }, limits: { login: null } } }));
    expect(ask(config, { path: '/.env' }).answer).not.toBe('refused');
    expect(ask(config, { path: '/wp-login.php', method: 'POST' }).router).toBe('wpl7sec_main_my-blog');
  });

  it('still send the headers when nothing is limited', () => {
    const config = build(input({ overrides: { limits: { login: null, xmlrpc: null, requests: null, assets: null } } }));
    expect(ask(config, { path: '/blog/' })).toMatchObject({ router: 'wpl7sec_main_my-blog', answer: 'served' });
  });
});

describe('custom rules', () => {
  const rules: CustomRuleInput[] = [
    { id: 'office', action: 'allow', conditions: [{ field: 'address', op: 'is', value: '192.0.2.44' }] },
    {
      id: 'badbot',
      action: 'block',
      match: 'any',
      conditions: [
        { field: 'userAgent', op: 'contains', value: 'BadBot/2.0 (+http://x.y)' },
        { field: 'query', name: 'action', op: 'is', value: 'revslider_show_image' },
      ],
    },
    { id: 'posts', action: 'block', conditions: [{ field: 'method', op: 'is', value: 'POST' }, { field: 'path', op: 'startsWith', value: '/api/' }] },
    { id: 'off', action: 'block', enabled: false, conditions: [{ field: 'path', op: 'is', value: '/' }] },
  ];
  const config = build(input({ rules }));

  it('block what they describe, and nothing else', () => {
    expect(ask(config, { path: '/', headers: { 'User-Agent': 'Mozilla badbot/2.0 (+http://x.y)' } })).toMatchObject({ router: 'wpl7sec_block-badbot_my-blog', answer: 'refused' });
    expect(ask(config, { path: '/wp-admin/admin-ajax.php?action=revslider_show_image' }).answer).toBe('refused');
    expect(ask(config, { path: '/api/x', method: 'POST' }).router).toBe('wpl7sec_block-posts_my-blog');
    expect(ask(config, { path: '/api/x' }).answer).not.toBe('refused');
    // A rule switched off is not written.
    expect(config.http.routers['wpl7sec_block-off_my-blog']).toBeUndefined();
  });

  it('let an allowed address past refusals and limits - directly or through a trusted proxy', () => {
    expect(ask(config, { path: '/.env', peer: '192.0.2.44' })).toMatchObject({ router: 'wpl7sec_allow-office_my-blog', answer: 'served' });
    expect(ask(config, { path: '/.env', peer: '104.16.0.9', headers: { 'Cf-Connecting-Ip': '192.0.2.44' } }).answer).toBe('served');
    expect(ask(config, { path: '/.env', headers: { 'Cf-Connecting-Ip': '192.0.2.44' } }).answer).toBe('refused');
  });

  it('match a value as written, special characters and all', () => {
    expect(quoteRegex('a.b(c)*[d]')).toBe('a\\.b\\(c\\)\\*\\[d\\]');
    const dotted = build(input({ rules: [{ id: 'x', action: 'block', conditions: [{ field: 'path', op: 'contains', value: '.php?' }] }] }));
    expect(ask(dotted, { path: '/a.php' }).answer).not.toBe('refused');
  });

  it('keep their place: the first listed answers first', () => {
    const both = build(
      input({
        rules: [
          { id: 'first', action: 'block', conditions: [{ field: 'path', op: 'startsWith', value: '/x' }] },
          { id: 'second', action: 'block', conditions: [{ field: 'path', op: 'startsWith', value: '/x/y' }] },
        ],
      }),
    );
    expect(ask(both, { path: '/x/y' }).router).toBe('wpl7sec_block-first_my-blog');
  });
});

describe('guards', () => {
  it('refuse a value Traefik would read as a template or as the end of a rule', () => {
    for (const bad of ['a`b', 'x{{ env "HOME" }}', 'x}}', 'a\u2028b']) {
      expect(() => build(input({ over: { domains: [`${bad}.com`] } })), bad).toThrow(RuleValueError);
    }
  });

  it('write nothing but the keys Traefik knows', () => {
    const config = build(input());
    (config.http.routers['wpl7sec_main_my-blog'] as unknown as Record<string, unknown>).ruleSyntax = 'v2';
    expect(() => renderDynamicFile(config)).toThrow(/unexpected key "ruleSyntax"/);
  });

  it('quote every string, so YAML reads back exactly what was meant', () => {
    const text = renderDynamicFile(build(input()));
    for (const line of text.split('\n').filter((l) => /: "/.test(l))) {
      const value = line.slice(line.indexOf(': "') + 2);
      expect(() => JSON.parse(value), line).not.toThrow();
    }
    expect(text).not.toMatch(/\t/);
  });

  it('parse back, rule by rule', () => {
    const config = build(input({ level: 'strict', rules: [{ id: 'q', action: 'block', conditions: [{ field: 'query', name: 'debug', op: 'present' }] }] }));
    for (const [name, router] of Object.entries(config.http.routers)) {
      expect(() => ruleMatches(router.rule, { host: 'my-blog.com', path: '/' }), name).not.toThrow();
    }
  });
});

describe('fleet addresses', () => {
  it('keeps public addresses only, once each', () => {
    expect(fleetAddresses(['203.0.113.10', '', '10.0.0.1', '203.0.113.10', 'nope', '2001:db8::1'])).toEqual(['2001:db8::1', '203.0.113.10']);
  });
});
