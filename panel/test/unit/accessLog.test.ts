import { describe, expect, it } from 'vitest';
import { CidrSet } from '../../shared/cidr.js';
import { parseSecurityName, securityName } from '../../shared/security.js';
import type { TrustedProxy } from '../../src/lib/clientIp.js';
import {
  hostOfAddr,
  isBotUserAgent,
  isPageView,
  normalizePath,
  parseAccessLog,
  parseAccessLogLine,
  referrerHostOf,
  siteSlugFromRouter,
} from '../../src/lib/accessLog.js';

/** One line as Traefik v3 emits it with --accesslog.format=json. */
const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ClientHost: '203.0.113.7',
    DownstreamContentSize: 18432,
    DownstreamStatus: 200,
    Duration: 214_000_000,
    RequestCount: 4211,
    RequestHost: 'acme.test',
    RequestMethod: 'GET',
    RequestPath: '/blog/hello-world/',
    RouterName: 'wp-acme@docker',
    ServiceName: 'wp-acme@docker',
    StartUTC: '2026-09-19T10:45:59.123456789Z',
    'request_User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141 Safari/537.36',
    request_Referer: 'https://news.ycombinator.com/item?id=1',
    ...over,
  });

describe('parseAccessLogLine', () => {
  it('reads one request, with the site taken from the router Traefik matched', () => {
    expect(parseAccessLogLine(line())).toEqual({
      ts: Date.parse('2026-09-19T10:45:59.123Z'),
      requestCount: 4211,
      slug: 'acme',
      host: 'acme.test',
      path: '/blog/hello-world/',
      method: 'GET',
      status: 200,
      originStatus: 0,
      bytes: 18432,
      durationMs: 214,
      clientIp: '203.0.113.7',
      peerIp: '203.0.113.7',
      via: null,
      router: 'wp-acme',
      userAgent: expect.stringContaining('Chrome'),
      referrerHost: 'news.ycombinator.com',
    });
  });

  it('takes the peer from ClientAddr, not from the ClientHost that X-Forwarded-For can overwrite', () => {
    const event = parseAccessLogLine(line({ ClientAddr: '198.51.100.20:51234', ClientHost: '10.9.9.9' }));
    expect(event).toMatchObject({ peerIp: '198.51.100.20', clientIp: '198.51.100.20', via: null });
    expect(parseAccessLogLine(line({ ClientAddr: '[2001:db8::7]:443' }))?.peerIp).toBe('2001:db8::7');
  });

  describe('behind a trusted proxy', () => {
    const cloudflare: TrustedProxy = { name: 'cloudflare', header: 'Cf-Connecting-Ip', ranges: new CidrSet(['173.245.48.0/20']) };
    const akamai: TrustedProxy = { name: 'akamai', header: 'True-Client-Ip', ranges: new CidrSet(['2001:db8:a::/48']) };
    const proxies = [cloudflare, akamai];

    it("is the visitor the proxy's header names", () => {
      const event = parseAccessLogLine(
        line({ ClientAddr: '173.245.48.9:40000', 'request_Cf-Connecting-Ip': '198.51.100.44' }),
        Date.now(),
        proxies,
      );
      expect(event).toMatchObject({ clientIp: '198.51.100.44', peerIp: '173.245.48.9', via: 'cloudflare' });
    });

    it('matches the header name whatever case Traefik wrote it in, and each proxy reads only its own', () => {
      const event = parseAccessLogLine(
        line({ ClientAddr: '[2001:db8:a::5]:40000', 'request_True-Client-IP': '2001:db8:ffff::1', 'request_Cf-Connecting-Ip': '192.0.2.1' }),
        Date.now(),
        proxies,
      );
      expect(event).toMatchObject({ clientIp: '2001:db8:ffff::1', via: 'akamai' });
    });

    it('ignores the header from anyone but the proxy', () => {
      const forged = parseAccessLogLine(
        line({ ClientAddr: '203.0.113.66:40000', 'request_Cf-Connecting-Ip': '1.1.1.1' }),
        Date.now(),
        proxies,
      );
      expect(forged).toMatchObject({ clientIp: '203.0.113.66', via: null });
    });

    it('keeps the proxy as the visitor when its header is missing or not an address', () => {
      for (const value of [undefined, '', 'unknown', '198.51.100.1, 198.51.100.2']) {
        const event = parseAccessLogLine(
          line({ ClientAddr: '173.245.48.9:1', ...(value === undefined ? {} : { 'request_Cf-Connecting-Ip': value }) }),
          Date.now(),
          proxies,
        );
        expect(event, String(value)).toMatchObject({ clientIp: '173.245.48.9', via: null });
      }
    });
  });

  it('skips Traefik\'s own chatter and half-written lines', () => {
    expect(parseAccessLogLine('time="2026-09-19T10:00:00Z" level=info msg="Configuration loaded"')).toBeNull();
    expect(parseAccessLogLine('{"level":"info","msg":"Starting provider *docker.Provider"}')).toBeNull();
    expect(parseAccessLogLine('{"ClientHost":"203.0.113.7","Down')).toBeNull();
    expect(parseAccessLogLine('')).toBeNull();
  });

  it('keeps counting a request the panel cannot attribute to a site', () => {
    // The panel's own host, or a hostname matching no router at all.
    expect(parseAccessLogLine(line({ RouterName: 'panel@docker', ServiceName: 'panel@docker' }))?.slug).toBeNull();
    expect(parseAccessLogLine(line({ RouterName: '', ServiceName: '' }))?.slug).toBeNull();
  });

  it('parses a whole chunk, dropping what is not a request', () => {
    const chunk = ['{"level":"info","msg":"hello"}', line(), '', line({ RequestCount: 4212 })].join('\n');
    expect(parseAccessLog(chunk).map((e) => e.requestCount)).toEqual([4211, 4212]);
  });
});

describe('siteSlugFromRouter', () => {
  it('unwraps the wp-<slug>@<provider> naming the site labels use', () => {
    expect(siteSlugFromRouter('wp-acme@docker')).toBe('acme');
    expect(siteSlugFromRouter('wp-my-blog@file')).toBe('my-blog');
    expect(siteSlugFromRouter('panel@docker')).toBeNull();
    expect(siteSlugFromRouter('wp-@docker')).toBeNull();
    expect(siteSlugFromRouter(undefined)).toBeNull();
  });

  it('finds the site in the routers Security writes too', () => {
    expect(siteSlugFromRouter('wpl7sec_deny-files_my-blog@file')).toBe('my-blog');
    expect(siteSlugFromRouter('wpl7sec_main-p0_a-b-c@file')).toBe('a-b-c');
    expect(siteSlugFromRouter('wpl7blk_cloudflare@file')).toBeNull();
  });
});

describe('security router names', () => {
  it('split back into kind and site, hyphens and all', () => {
    for (const [kind, slug] of [
      ['deny-files', 'my-blog'],
      ['main', 'a-b'],
      ['block-x7k2', 'shop-2-staging'],
      ['limit-login-p1', 'abc'],
    ] as const) {
      const name = securityName(kind, slug);
      expect(parseSecurityName(name)).toEqual({ kind, slug });
      expect(parseSecurityName(`${name}@file`)).toEqual({ kind, slug });
    }
  });

  it('refuses what would not split back apart', () => {
    expect(() => securityName('deny_files', 'blog')).toThrow();
    expect(() => securityName('main', 'my_blog')).toThrow();
    expect(parseSecurityName('wp-blog@docker')).toBeNull();
    expect(parseSecurityName('wpl7sec_main@file')).toBeNull();
    expect(parseSecurityName('wpl7sec_main_blog_extra@file')).toBeNull();
  });
});

describe('hostOfAddr', () => {
  it('drops the port, brackets and all', () => {
    expect(hostOfAddr('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(hostOfAddr('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(hostOfAddr('2001:db8::1')).toBe('2001:db8::1');
    expect(hostOfAddr('')).toBe('');
  });
});

describe('isBotUserAgent', () => {
  it('catches crawlers, scripts and the panel\'s own uptime probe', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'facebookexternalhit/1.1',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      'curl/8.7.1',
      'python-requests/2.32.3',
      'wpl7-probe/1',
      '',
      '   ',
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(true);
    }
  });

  it('leaves real browsers alone', () => {
    for (const ua of [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(false);
    }
  });
});

describe('isPageView', () => {
  const view = (path: string, over: { method?: string; status?: number } = {}) =>
    isPageView({ path, method: over.method ?? 'GET', status: over.status ?? 200 });

  it('counts pages, including the redirect to the canonical host', () => {
    expect(view('/')).toBe(true);
    expect(view('/blog/hello-world/')).toBe(true);
    expect(view('/kontakt')).toBe(true);
    expect(view('/?page_id=7')).toBe(true);
    expect(view('/', { status: 301 })).toBe(true);
  });

  it('does not count assets, machinery, errors or writes', () => {
    expect(view('/wp-content/themes/x/style.css')).toBe(false);
    expect(view('/wp-includes/js/jquery.min.js')).toBe(false);
    expect(view('/uploads/2026/09/photo.jpg')).toBe(false);
    expect(view('/favicon.ico')).toBe(false);
    expect(view('/robots.txt')).toBe(false);
    expect(view('/wp-admin/edit.php')).toBe(false);
    expect(view('/wp-login.php')).toBe(false);
    expect(view('/wp-json/wp/v2/posts')).toBe(false);
    expect(view('/wp-cron.php')).toBe(false);
    expect(view('/xmlrpc.php')).toBe(false);
    expect(view('/feed/')).toBe(false);
    expect(view('/missing-page', { status: 404 })).toBe(false);
    expect(view('/contact', { method: 'POST' })).toBe(false);
  });
});

describe('referrerHostOf', () => {
  it('keeps the host, drops www, the query string and same-site navigation', () => {
    expect(referrerHostOf('https://www.Google.com/search?q=secret+terms', 'acme.test')).toBe('google.com');
    expect(referrerHostOf('https://acme.test/blog/', 'acme.test')).toBe('');
    expect(referrerHostOf('https://www.acme.test/blog/', 'acme.test')).toBe('');
    expect(referrerHostOf('', 'acme.test')).toBe('');
    expect(referrerHostOf('-', 'acme.test')).toBe('');
    expect(referrerHostOf('not a url', 'acme.test')).toBe('');
  });
});

describe('normalizePath', () => {
  it('drops the query string and caps the length', () => {
    expect(normalizePath('/blog/?utm_source=newsletter')).toBe('/blog/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath(`/${'a'.repeat(400)}`)).toHaveLength(201);
  });
});
