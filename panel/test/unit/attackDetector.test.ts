import { describe, expect, it } from 'vitest';
import { sites } from '../../src/db/schema.js';
import type { AccessEvent } from '../../src/lib/accessLog.js';
import { isTrapPath, signalsOf } from '../../src/lib/attackSignals.js';
import { verifyCrawler, type CrawlerResolver } from '../../src/lib/crawlerVerify.js';
import { AttackDetector, MAX_TRACKED } from '../../src/services/attackDetector.js';
import { TrafficService } from '../../src/services/traffic.js';
import { makeWorld, type TestWorld } from '../helpers.js';

const T0 = Date.now() - 20 * 60_000;
const ATTACKER = '198.18.66.66';
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

let n = 0;
function event(over: Partial<AccessEvent> = {}): AccessEvent {
  return {
    ts: T0,
    requestCount: ++n,
    slug: 'acme',
    host: 'acme.test',
    path: '/',
    method: 'GET',
    status: 200,
    originStatus: 200,
    bytes: 100,
    durationMs: 10,
    clientIp: ATTACKER,
    peerIp: ATTACKER,
    via: null,
    router: 'wpl7sec_main_acme',
    userAgent: BROWSER,
    referrerHost: '',
    ...over,
  };
}

/** `count` requests, one second apart from `start`. */
const burst = (count: number, over: (i: number) => Partial<AccessEvent>, start = T0) =>
  Array.from({ length: count }, (_, i) => event({ ts: start + i * 1000, ...over(i) }));

const failedLogin = (i: number): Partial<AccessEvent> => ({ method: 'POST', path: '/wp-login.php', status: 200, originStatus: 200, ts: T0 + i * 1000 });

function detectorFor(w: TestWorld, resolver?: CrawlerResolver): AttackDetector {
  return new AttackDetector(w.core.settings, w.core.blocklist, quiet, resolver ?? { reverse: async () => [], lookup: async () => [] });
}

async function run(w: TestWorld, events: AccessEvent[], resolver?: CrawlerResolver) {
  const d = detectorFor(w, resolver);
  d.feed(1, events, T0);
  const result = await d.evaluate(T0 + 60_000);
  return { d, result };
}

describe('what counts', () => {
  it('reads the signals off a request', () => {
    expect(signalsOf(event(failedLogin(0)), null)).toEqual([{ rule: 'login', points: 1 }]);
    // A successful login redirects: not a guess.
    expect(signalsOf(event({ method: 'POST', path: '/wp-login.php', status: 302 }), null)).toEqual([]);
    expect(signalsOf(event({ method: 'POST', path: '/xmlrpc.php' }), null)).toEqual([{ rule: 'xmlrpc', points: 1 }]);
    expect(signalsOf(event({ path: '/.env', status: 403 }), 'files')).toEqual([{ rule: 'probing', points: 4, distinct: '/.env' }]);
    expect(signalsOf(event({ path: '/?author=1', status: 403 }), 'enum')).toEqual([{ rule: 'probing', points: 1, distinct: '/' }]);
    expect(signalsOf(event({ path: '/no-such-page/', status: 404 }), null)).toEqual([{ rule: 'deadUrls', points: 1, distinct: '/no-such-page/' }]);
    // A missing image is a broken page, not somebody guessing.
    expect(signalsOf(event({ path: '/wp-content/uploads/x.jpg', status: 404 }), null)).toEqual([]);
    expect(signalsOf(event({ path: '/shop/', status: 429, originStatus: 0 }), 'limit-requests')).toEqual([{ rule: 'flooding', points: 1 }]);
    // The site's own 429 is the site's business.
    expect(signalsOf(event({ path: '/shop/', status: 429, originStatus: 429 }), null)).toEqual([]);
  });

  it('knows a trap path from an ordinary one', () => {
    for (const p of ['/.env', '/.git/config', '/phpmyadmin/', '/wso.php', '/wp-config.php.bak', '/wp-content/uploads/2026/x.php', '/vendor/phpunit/src/Util/PHP/eval-stdin.php']) {
      expect(isTrapPath(p), p).toBe(true);
    }
    for (const p of ['/', '/wp-admin/upload.php', '/blog/env-tips/', '/wp-login.php', '/xmlrpc.php', '/shop.php']) expect(isTrapPath(p), p).toBe(false);
  });
});

describe('blocking', () => {
  it('blocks a login guesser, and says why', async () => {
    const w = await makeWorld();
    const { d, result } = await run(w, burst(25, failedLogin));
    expect(result.blocked).toBe(1);
    const [block] = w.core.blocklist.active();
    expect(block).toMatchObject({ address: ATTACKER, source: 'detector', rule: 'login', strike: 1 });
    expect(block!.reason).toMatch(/failed logins|login guessing/i);
    expect(JSON.parse(block!.evidence!)).toMatchObject({ threshold: 20, windowMin: 10, sites: ['acme'], samplePaths: ['/wp-login.php'] });
    expect(d.status().decisions[0]).toMatchObject({ action: 'blocked', address: ATTACKER, rule: 'login' });
  });

  it('leaves five mistyped passwords alone', async () => {
    const w = await makeWorld();
    const { result } = await run(w, burst(5, failedLogin));
    expect(result).toEqual({ blocked: 0, observed: 0, skipped: 0 });
    expect(w.core.blocklist.activeCount()).toBe(0);
  });

  it('forgives a slow guesser the bucket has time to empty for', async () => {
    const w = await makeWorld();
    // 30 attempts, one a minute: never 20 inside ten minutes.
    const { result } = await run(w, Array.from({ length: 30 }, (_, i) => event({ ...failedLogin(0), ts: T0 + i * 60_000 })));
    expect(result.blocked).toBe(0);
  });

  it('blocks a scanner walking trap paths, counting each path once', async () => {
    const w = await makeWorld();
    const paths = ['/.env', '/.git/config', '/phpmyadmin/'];
    // The same trap path a hundred times is one path.
    const again = await run(w, burst(100, () => ({ path: '/.env', status: 403, originStatus: 0, router: 'wpl7sec_deny-files_acme' })));
    expect(again.result.blocked).toBe(0);
    const { result } = await run(w, burst(3, (i) => ({ path: paths[i]!, status: 404, originStatus: 404 })));
    expect(result.blocked).toBe(1);
    expect(w.core.blocklist.active()[0]).toMatchObject({ rule: 'probing' });
  });

  it('blocks an IPv6 visitor by its /64', async () => {
    const w = await makeWorld();
    const { result } = await run(w, burst(25, (i) => ({ ...failedLogin(i), clientIp: `2001:db8:5:6::${(i % 9) + 1}` })));
    expect(result.blocked).toBe(1);
    expect(w.core.blocklist.active()[0]!.address).toBe('2001:db8:5:6::/64');
  });

  it('blocks the visitor behind Cloudflare, never Cloudflare', async () => {
    const w = await makeWorld();
    const { result } = await run(w, burst(25, (i) => ({ ...failedLogin(i), clientIp: ATTACKER, peerIp: '173.245.48.9', via: 'cloudflare' })));
    expect(result.blocked).toBe(1);
    expect(w.core.blocklist.active()[0]!.address).toBe(ATTACKER);
    // And the proxy itself, arriving without a visitor, is not even counted.
    const d = detectorFor(w);
    d.feed(1, burst(40, (i) => ({ ...failedLogin(i), clientIp: '173.245.48.9', peerIp: '173.245.48.9' })), T0);
    expect(d.trackedCount()).toBe(0);
  });

  it('does not block an office behind one address, and says so', async () => {
    const w = await makeWorld();
    const agents = [BROWSER, 'Mozilla/5.0 (Macintosh) Safari/605.1.15', 'Mozilla/5.0 (Windows NT 10.0) Edg/141.0'];
    const { d, result } = await run(w, burst(25, (i) => ({ ...failedLogin(i), userAgent: agents[i % 3]! })));
    expect(result).toMatchObject({ blocked: 0, skipped: 1 });
    expect(d.status().decisions[0]).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/looks like a proxy/) });
  });

  it('does not block a search engine it can verify, and does block one pretending to be it', async () => {
    const w = await makeWorld();
    const google = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    const real = '66.249.66.1';
    const resolver: CrawlerResolver = {
      reverse: async (ip) => (ip === real ? ['crawl-66-249-66-1.googlebot.com'] : ['fake.example.net']),
      lookup: async (host) => (host === 'crawl-66-249-66-1.googlebot.com' ? [real] : []),
    };
    const deadUrl = (ip: string) => (i: number) => ({ clientIp: ip, userAgent: google, path: `/gone-${i}/`, status: 404, originStatus: 404 });
    const genuine = await run(w, burst(70, deadUrl(real)), resolver);
    expect(genuine.result).toMatchObject({ blocked: 0, skipped: 1 });
    expect(genuine.d.status().decisions[0]!.reason).toMatch(/Googlebot, verified by its reverse DNS \(crawl-66-249-66-1\.googlebot\.com\)/);
    const fake = await run(w, burst(70, deadUrl(ATTACKER)), resolver);
    expect(fake.result.blocked).toBe(1);
  });

  it('verifies an IPv6 crawler by its own address, not the /64 it is counted in', async () => {
    const w = await makeWorld();
    const google = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    // Every address of Google's /64 names a crawler host that points back; nothing else has a name.
    const hostOf = (ip: string) => `crawl-${ip.replace(/:/g, '-')}.googlebot.com`;
    const resolver: CrawlerResolver = {
      reverse: async (ip) => {
        if (ip.includes('/')) throw new Error(`getHostByAddr EINVAL ${ip}`);
        if (!ip.startsWith('2001:db8:5:6::')) throw new Error(`getHostByAddr ENOTFOUND ${ip}`);
        return [hostOf(ip)];
      },
      lookup: async (host) => (host.startsWith('crawl-2001-db8-5-6--') ? [host.slice(6, -14).replace(/-/g, ':')] : []),
    };
    const deadUrl = (prefix: string) => (i: number) => ({ clientIp: `${prefix}${(i % 3) + 1}`, userAgent: google, path: `/gone-${i}/`, status: 404, originStatus: 404 });
    const genuine = await run(w, burst(70, deadUrl('2001:db8:5:6::')), resolver);
    expect(genuine.result).toMatchObject({ blocked: 0, skipped: 1 });
    expect(genuine.d.status().decisions[0]).toMatchObject({ address: '2001:db8:5:6::/64', reason: expect.stringContaining(`verified by its reverse DNS (${hostOf('2001:db8:5:6::1')})`) });
    const fake = await run(w, burst(70, deadUrl('2001:db8:7:7::')), resolver);
    expect(fake.result.blocked).toBe(1);
    expect(w.core.blocklist.active()[0]!.address).toBe('2001:db8:7:7::/64');
  });

  it("never blocks an AI assistant's published address, whatever it asks for", async () => {
    const w = await makeWorld();
    // ChatGPT fetching made-up URLs for its users, from one of OpenAI's addresses.
    const d = detectorFor(w);
    d.feed(1, burst(70, (i) => ({ clientIp: '9.129.1.1', userAgent: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)', path: `/made-up-${i}/`, status: 404, originStatus: 404 })), T0);
    expect(d.trackedCount()).toBe(0);
    expect(await d.evaluate(T0 + 60_000)).toMatchObject({ blocked: 0 });
    expect(w.core.blocklist.activeCount()).toBe(0);
  });

  it('never blocks where the panel is used from', async () => {
    const w = await makeWorld();
    w.core.blocklist.recordAdmin(ATTACKER, 'alice');
    const { d, result } = await run(w, burst(25, failedLogin));
    expect(result.blocked).toBe(0);
    // Protected addresses are not even watched.
    expect(d.trackedCount()).toBe(0);
  });

  it('only records what it would do in observe mode, and does nothing when off', async () => {
    const w = await makeWorld();
    w.core.settings.set('securityAutoBlock', 'observe');
    const observed = await run(w, burst(25, failedLogin));
    expect(observed.result.observed).toBe(1);
    expect(w.core.blocklist.activeCount()).toBe(0);
    expect(observed.d.status().decisions[0]).toMatchObject({ action: 'observed', reason: expect.stringMatching(/^Would have been blocked/) });

    w.core.settings.set('securityAutoBlock', 'off');
    const off = await run(w, burst(25, failedLogin));
    expect(off.result).toEqual({ blocked: 0, observed: 0, skipped: 0 });
    expect(off.d.trackedCount()).toBe(0);
  });

  it('follows the thresholds in the settings, rule by rule', async () => {
    const w = await makeWorld();
    const rules = w.core.settings.get('securityRules');
    w.core.settings.set('securityRules', { ...rules, login: { enabled: true, threshold: 5, windowMin: 10 } });
    expect((await run(w, burst(6, failedLogin))).result.blocked).toBe(1);
    const w2 = await makeWorld();
    w2.core.settings.set('securityRules', { ...rules, login: { ...rules.login, enabled: false } });
    expect((await run(w2, burst(50, failedLogin))).result.blocked).toBe(0);
  });

  it('keeps at most so many addresses in mind', async () => {
    const w = await makeWorld();
    const d = detectorFor(w);
    const events: AccessEvent[] = [];
    for (let i = 0; i < MAX_TRACKED + 50; i++) {
      events.push(event({ ...failedLogin(0), clientIp: `100.${Math.floor(i / 65536) + 130}.${Math.floor(i / 256) % 256}.${i % 256}` }));
    }
    d.feed(1, events, T0);
    expect(d.trackedCount()).toBe(MAX_TRACKED);
  });
});

describe('through the logs', () => {
  function line(over: Record<string, unknown>): string {
    return JSON.stringify({
      ClientAddr: `${ATTACKER}:40000`,
      DownstreamContentSize: 10,
      DownstreamStatus: 200,
      OriginStatus: 200,
      Duration: 1_000_000,
      RequestCount: ++n,
      RequestHost: 'acme.test',
      RequestMethod: 'POST',
      RequestPath: '/wp-login.php',
      RouterName: 'wpl7sec_login_acme@file',
      StartUTC: new Date(Date.now() - 30_000).toISOString(),
      'request_User-Agent': BROWSER,
      ...over,
    });
  }

  it('blocks from what Traefik logged, on every server, within the tick', async () => {
    const w = await makeWorld();
    const now = Date.now();
    w.db.insert(sites).values({ slug: 'acme', title: 'acme', domains: '["acme.test"]', phpVersion: '8.3', status: 'running', dbName: 'a', dbUser: 'a', dbPassword: 'x', containerName: 'wp-acme', createdAt: now, updatedAt: now }).run();
    w.docker.logs.set('wpl7-traefik', Array.from({ length: 25 }, () => line({})).join('\n'));
    await w.deps.traffic.ingestServer(1);
    await w.deps.schedulers.run('blocked-addresses', 'timer');
    await w.core.firewall.idle();
    expect(w.core.blocklist.active().map((b) => b.address)).toEqual([ATTACKER]);
    expect(w.firewallHost(1).applied.at(-1)).toContain(ATTACKER);
  });

  it('remembers the last ten minutes across a restart, without counting anything twice', async () => {
    const w = await makeWorld();
    const logs = Array.from({ length: 15 }, () => line({}));
    w.docker.logs.set('wpl7-traefik', logs.join('\n'));
    await w.deps.traffic.ingestServer(1);
    // The panel restarts: a new ingest with the cursor where it was, and a new detector.
    const log = quiet;
    const traffic = new TrafficService(w.db, w.servers, w.core.settings, log, w.geoip);
    const d = detectorFor(w);
    await d.rebuild((id, since) => traffic.readBeforeBoot(id, since), [1]);
    // Ten more after the restart: 25 in all, over the threshold - but only if the first 15
    // were remembered, and the ten are counted once.
    w.docker.logs.set('wpl7-traefik', [...logs, ...Array.from({ length: 10 }, () => line({}))].join('\n'));
    traffic.onEvents((serverId, events) => d.feed(serverId, events));
    await traffic.ingestServer(1);
    expect((await d.evaluate()).blocked).toBe(1);

    const fresh = detectorFor(w);
    await fresh.rebuild((id, since) => traffic.readBeforeBoot(id, since), [1]);
    expect((await fresh.evaluate()).blocked).toBe(0);
  });
});

describe('crawler verification', () => {
  it('needs the reverse name to be theirs and to point back', async () => {
    const reverse = { reverse: async () => ['crawl.googlebot.com'], lookup: async () => ['66.249.66.1'] };
    const ua = 'Googlebot/2.1';
    expect(await verifyCrawler('66.249.66.1', ua, reverse)).toMatchObject({ claims: 'Googlebot', verified: true });
    expect(await verifyCrawler('66.249.66.2', ua, reverse)).toMatchObject({ verified: false });
    expect(await verifyCrawler('66.249.66.1', ua, { reverse: async () => ['googlebot.com.evil.example'], lookup: async () => ['66.249.66.1'] })).toMatchObject({ verified: false });
    expect(await verifyCrawler('66.249.66.1', BROWSER, reverse)).toMatchObject({ claims: null, verified: false });
    // Any Google Cloud machine has a name like this, which points back.
    const cloud = { reverse: async () => ['1.0.227.35.bc.googleusercontent.com'], lookup: async () => ['35.227.0.1'] };
    expect(await verifyCrawler('35.227.0.1', ua, cloud)).toMatchObject({ claims: 'Googlebot', verified: false });
  });
});
