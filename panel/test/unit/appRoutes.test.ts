/**
 * A container app's routes file: its routers, their names and priorities, where they sit among a
 * site's own and the block list, the hosts an app may route on, and the service that keeps each
 * server's files in line. The real Traefik's answers are in test/engine/containerApps.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { APP_ROUTE_PRIORITY, appRoutePriority, appRouterName, parseAppRouterName } from '../../shared/apps.js';
import { CidrSet, parseCidr } from '../../shared/cidr.js';
import { MAX_CUSTOM_RULES, effectivePolicy } from '../../shared/security.js';
import { appRoutes, moveCleanups, sites } from '../../src/db/schema.js';
import type { JobContext } from '../../src/jobs/context.js';
import { finalizeCleanup } from '../../src/jobs/handlers/move.js';
import { proxyConfigYaml } from '../../src/jobs/handlers/moveHelpers.js';
import { siteSlugFromRouter } from '../../src/lib/accessLog.js';
import type { FilesPort } from '../../src/lib/files.js';
import { ServerUnreachableError } from '../../src/servers/sshConnection.js';
import {
  APP_ROUTES_FILE_RE,
  AppRoutesService,
  MAX_APP_ROUTES,
  appDomains,
  appHttpHosts,
  appsRoutingOn,
  buildAppRoutes,
  hostRefusal,
  plainHttpRefusal,
  routedOnRefusal,
  type AppRoutesInput,
} from '../../src/services/appRoutes.js';
import { buildBlockedFile } from '../../src/services/firewallRender.js';
import { traefikLabels } from '../../src/services/labels.js';
import { RANGE_SOURCES } from '../../src/services/proxyRanges.js';
import { PRIORITY, RuleValueError, buildSiteSecurityConfig, bypassList, renderDynamicFile, type DynamicConfig } from '../../src/services/securityConfig.js';
import { TRAEFIK_CONTAINER } from '../../src/services/stack.js';
import { route as simRoute } from '../traefikSim.js';
import { FakeDocker, addContainerApp, addPhpSite, makeWorld, type TestWorld } from '../helpers.js';

const route = (id: number, host: string, match: 'none' | 'prefix' | 'exact', p: string, scheme: 'https' | 'http' | 'both', enabled = 1) => ({
  id,
  host,
  match,
  path: p,
  scheme,
  enabled,
});

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A time as Traefik stamps its own lines: to the second. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

const input = (over: Partial<AppRoutesInput> = {}): AppRoutesInput => ({
  slug: 'orders',
  containerName: 'wp-orders',
  port: 8000,
  routes: [route(1, 'orders.example.com', 'none', '', 'both'), route(2, 'shop.example.com', 'prefix', '/api/', 'https'), route(3, 'shop.example.com', 'exact', '/hook', 'http')],
  ownHosts: ['orders.example.com', 'orders.dev.example.net'],
  tlsMode: 'letsencrypt',
  acmeResolver: 'letsencrypt',
  devDomain: 'dev.example.net',
  wildcardProvider: '',
  held: false,
  ...over,
});

describe('the routers of an app', () => {
  it('names each route’s routers so no slug can be read into them, and the service by the container’s name', () => {
    const config = buildAppRoutes(input());
    expect(Object.keys(config.http.routers)).toEqual(['wpl7app_r1_orders', 'wpl7app_r1-http_orders', 'wpl7app_r2_orders', 'wpl7app_r3-http_orders']);
    expect(config.http.services).toEqual({ wpl7app_svc_orders: { loadBalancer: { servers: [{ url: 'http://wp-orders:8000' }] } } });
    expect(parseAppRouterName('wpl7app_r3-http_shop-r2@file')).toEqual({ kind: 'r3-http', slug: 'shop-r2' });
    expect(parseAppRouterName('wp-shop-r2')).toBeNull();
    expect(siteSlugFromRouter('wpl7app_r3-http_shop-r2@file')).toBe('shop-r2');
    expect(siteSlugFromRouter('wpl7app_svc_orders@file')).toBe('orders');
    expect(() => appRouterName('r1', 'Not_A_Slug')).toThrow();
  });

  it('puts https on websecure with the host’s certificate, http on web, and nothing in the file is an empty section', () => {
    const config = buildAppRoutes(input());
    expect(config.http.routers['wpl7app_r1_orders']).toEqual({
      rule: 'Host(`orders.example.com`)',
      priority: APP_ROUTE_PRIORITY,
      entryPoints: ['websecure'],
      service: 'wpl7app_svc_orders',
      tls: { certResolver: 'letsencrypt' },
    });
    expect(config.http.routers['wpl7app_r1-http_orders']).toMatchObject({ entryPoints: ['web'], rule: 'Host(`orders.example.com`)' });
    expect(config.http.routers['wpl7app_r1-http_orders']?.tls).toBeUndefined();
    expect(config.http.routers['wpl7app_r3-http_orders']?.rule).toBe('Host(`shop.example.com`) && Path(`/hook`)');
    const text = renderDynamicFile(config);
    expect(text).not.toMatch(/middlewares/);
    expect(text).toContain('certResolver: "letsencrypt"');
  });

  it('gives a dev hostname the shared wildcard certificate when the server has one', () => {
    const config = buildAppRoutes(input({ routes: [route(4, 'orders.dev.example.net', 'none', '', 'https')], wildcardProvider: 'cloudflare' }));
    expect(config.http.routers['wpl7app_r4_orders']?.tls).toEqual({ certResolver: 'letsencrypt-dns', domains: [{ main: 'dev.example.net', sans: ['*.dev.example.net'] }] });
    const staging = buildAppRoutes(input({ routes: [route(4, 'orders.dev.example.net', 'none', '', 'https')], wildcardProvider: 'cloudflare', acmeResolver: 'letsencrypt-staging' }));
    expect(staging.http.routers['wpl7app_r4_orders']?.tls?.certResolver).toBe('letsencrypt-dns-staging');
  });

  it('ranks a longer path above a shorter one, an exact one above a prefix, all of them between a site’s whole table and the block list', () => {
    expect(appRoutePriority({ match: 'exact', path: '/a' })).toBeGreaterThan(appRoutePriority({ match: 'prefix', path: '/a/very/long/prefix/' }));
    expect(appRoutePriority({ match: 'prefix', path: '/api/v2/' })).toBeGreaterThan(appRoutePriority({ match: 'prefix', path: '/api/' }));
    expect(appRoutePriority({ match: 'none', path: '' })).toBeGreaterThan(PRIORITY.allow + MAX_CUSTOM_RULES);
    expect(appRoutePriority({ match: 'exact', path: '/'.repeat(9_999) })).toBeLessThan(PRIORITY.blocked);
    expect(PRIORITY.app).toBe(APP_ROUTE_PRIORITY);
  });

  it('leaves switched-off routes out, keeps every router while held with no server behind them, and needs one router per route without TLS', () => {
    const off = buildAppRoutes(input({ routes: [route(1, 'orders.example.com', 'none', '', 'both', 0)] }));
    expect(off.http.routers).toEqual({});
    const held = buildAppRoutes(input({ held: true }));
    expect(Object.keys(held.http.routers)).toHaveLength(4);
    expect(held.http.services?.['wpl7app_svc_orders']).toEqual({ loadBalancer: { servers: [] } });
    expect(renderDynamicFile(held)).toContain('servers: []');
    const plain = buildAppRoutes(input({ tlsMode: 'none' }));
    expect(Object.keys(plain.http.routers)).toEqual(['wpl7app_r1_orders', 'wpl7app_r2_orders', 'wpl7app_r3_orders']);
    expect(Object.values(plain.http.routers).every((r) => r.entryPoints.join() === 'web' && !r.tls)).toBe(true);
  });

  it('refuses a value Traefik would read differently, before anything is written', () => {
    expect(() => buildAppRoutes(input({ routes: [route(1, 'a.example.com', 'prefix', '/x`) || Host(`victim.example.com', 'https')] }))).toThrow(RuleValueError);
    expect(() => buildAppRoutes(input({ routes: [route(1, 'a.example.com', 'prefix', '/{{ .Env }}', 'https')] }))).toThrow(RuleValueError);
  });
});

describe('a path on another site’s domain', () => {
  const SHOP = ['shop.example.com', 'www.shop.example.com'];
  const protection = buildSiteSecurityConfig({
    slug: 'shop',
    app: 'wordpress',
    domains: SHOP,
    policy: effectivePolicy({ level: 'strict', overrides: {} }, { level: null, overrides: {}, customRules: [] }, 'wordpress'),
    tlsMode: 'letsencrypt',
    proxies: [{ name: 'cloudflare', header: 'Cf-Connecting-Ip', ranges: new CidrSet(RANGE_SOURCES.cloudflare.builtin) }],
    bypass: bypassList({ fleet: ['203.0.113.10'], neverBlock: [], bypassPrivate: true }),
    fleet: ['203.0.113.10'],
    jetpack: RANGE_SOURCES.jetpack.builtin,
  })!;
  const app = buildAppRoutes(input());
  const onWebsecure = Object.fromEntries(Object.entries(app.http.routers).filter(([, r]) => r.entryPoints.includes('websecure')));
  const merged: DynamicConfig = { http: { routers: { ...protection.http.routers, ...onWebsecure }, middlewares: protection.http.middlewares } };
  const ask = (p: string, method = 'GET') => simRoute(merged, { host: 'shop.example.com', path: p, method, peer: '198.51.100.20' }, SHOP, 'shop').router;

  it('wins over the site’s router and its whole protection file for its own path, and nowhere else', () => {
    expect(ask('/api/orders')).toBe('wpl7app_r2_orders');
    expect(ask('/api/.env')).toBe('wpl7app_r2_orders');
    expect(ask('/')).toBe('wpl7sec_main_shop');
    expect(ask('/apix')).toBe('wpl7sec_main_shop');
    expect(ask('/wp-login.php', 'POST')).toBe('wpl7sec_login_shop');
    expect(ask('/.env')).toBe('wpl7sec_deny-files_shop');
  });

  it('is allowed only on a hosted site’s domain on the same server, with a path, and never on the panel’s own', () => {
    const deps = { config: { panelDomain: 'panel.example.net' }, devDomains: ['dev.example.net'] };
    const me = { id: 9, serverId: 1, devHostname: 'orders.dev.example.net' };
    const owner = (o: Partial<{ id: number; slug: string; serverId: number; kind: string; devHostname: string | null }> = {}) => ({
      id: 3,
      slug: 'shop',
      serverId: 1,
      kind: 'hosted',
      devHostname: 'shop.dev.example.net',
      ...o,
    });
    expect(hostRefusal(deps, me, 'orders.example.com', null, 'none')).toBeNull();
    expect(hostRefusal(deps, me, 'orders.dev.example.net', null, 'none')).toBeNull();
    expect(hostRefusal(deps, me, 'shop.example.com', owner(), 'prefix')).toBeNull();
    expect(hostRefusal(deps, me, 'panel.example.net', null, 'prefix')).toBe("panel.example.net is the panel's own address.");
    expect(hostRefusal(deps, me, 'other.dev.example.net', null, 'none')).toMatch(/under a dev domain/);
    expect(hostRefusal(deps, me, 'shop.example.com', owner(), 'none')).toBe('shop.example.com belongs to "shop": a route there needs a path.');
    expect(hostRefusal(deps, me, 'shop.example.com', owner({ serverId: 2 }), 'prefix')).toBe('shop.example.com belongs to "shop", on another server.');
    expect(hostRefusal(deps, me, 'shop.example.com', owner({ kind: 'external' }), 'prefix')).toBe('shop.example.com belongs to "shop", a site hosted elsewhere.');
    expect(hostRefusal(deps, me, 'shop.dev.example.net', owner(), 'prefix')).toBe('shop.dev.example.net is the dev hostname of "shop".');
  });

  it('keeps a borrowed host out of the app’s domains', () => {
    expect(appDomains('orders.dev.example.net', input().routes, new Set(['orders.example.com']))).toEqual(['orders.example.com', 'orders.dev.example.net']);
    expect(appDomains('orders.dev.example.net', [route(1, 'shop.example.com', 'prefix', '/api/', 'https')], new Set())).toEqual(['orders.dev.example.net']);
  });
});

describe('what the panel writes on port 80', () => {
  it('names an entry point in every router it writes; with TLS on, only an app’s http routers and the block list’s twins are on web', () => {
    const labels = traefikLabels({ slug: 'shop', primary: 'shop.example.com', aliases: ['www.shop.example.com'], tlsMode: 'letsencrypt', acmeResolver: 'letsencrypt', devDomain: 'dev.example.net', dnsProvider: '' });
    expect(labels['traefik.http.routers.wp-shop.entrypoints']).toBe('websecure');
    const blocks = [{ cidr: parseCidr('198.51.100.7/32')!, expiresAt: null, createdAt: 1 }];
    const proxies = [{ name: 'cloudflare', header: 'Cf-Connecting-Ip', ranges: new CidrSet(RANGE_SOURCES.cloudflare.builtin) }];
    const plain = buildBlockedFile({ blocks, proxies, direct: true, panelHost: 'panel.example.net', tlsMode: 'letsencrypt' }).config!;
    const twinned = buildBlockedFile({ blocks, proxies, direct: true, panelHost: 'panel.example.net', tlsMode: 'letsencrypt', webHosts: ['orders.example.com', 'shop.example.com'] }).config!;
    const files: DynamicConfig[] = [plain, twinned, buildAppRoutes(input())];
    for (const file of files) {
      for (const [name, r] of Object.entries(file.http.routers)) {
        expect(r.entryPoints.length, name).toBe(1);
        if (r.entryPoints[0] === 'web') expect(name, name).toMatch(/^wpl7app_r\d+-http_|-web$/);
      }
    }
    expect(Object.keys(plain.http.routers).some((n) => n.endsWith('-web'))).toBe(false);
    expect(twinned.http.routers['wpl7blk_direct-web']).toMatchObject({
      entryPoints: ['web'],
      priority: PRIORITY.blocked,
      rule: '(Host(`orders.example.com`) || Host(`shop.example.com`)) && !Host(`panel.example.net`) && (ClientIP(`198.51.100.7`))',
    });
    expect(twinned.http.routers['wpl7blk_direct-web']?.tls).toBeUndefined();
    expect(proxyConfigYaml({ slug: 'm', hosts: ['m.example.org'], targetIp: '192.0.2.4', tlsMode: 'letsencrypt', acmeResolver: 'letsencrypt' })).toContain('entryPoints: [websecure]');
  });

  it('puts the block list’s twin in front of a move’s forwarder on port 80, however many hosts it forwards', () => {
    const hosts = Array.from({ length: MAX_APP_ROUTES }, (_, i) => `${'a'.repeat(63)}.${'b'.repeat(63)}.n${i}.example.org`);
    const yaml = proxyConfigYaml({ slug: 'm', hosts, httpHosts: hosts, targetIp: '192.0.2.4', tlsMode: 'letsencrypt', acmeResolver: 'letsencrypt' });
    // No priority of its own: Traefik ranks it by the length of its rule.
    expect(yaml).not.toContain('priority');
    const rule = JSON.parse(/ {4}move-m-http:\n {6}rule: (".*")\n/.exec(yaml)![1]!) as string;
    const blocks = [{ cidr: parseCidr('198.51.100.7/32')!, expiresAt: null, createdAt: 1 }];
    const twinned = buildBlockedFile({ blocks, proxies: [], direct: true, panelHost: 'panel.example.net', tlsMode: 'letsencrypt', webHosts: hosts }).config!;
    const onWeb = Object.fromEntries(Object.entries(twinned.http.routers).filter(([, r]) => r.entryPoints.includes('web')));
    const web: DynamicConfig = {
      http: { routers: { ...onWeb, 'move-m-http': { rule, priority: rule.length, entryPoints: ['web'], service: 'move-m-http' } }, middlewares: twinned.http.middlewares },
    };
    const ask = (peer: string) => simRoute(web, { host: hosts.at(-1)!, path: '/', peer }, [], 'm');
    expect(ask('198.51.100.7')).toMatchObject({ router: 'wpl7blk_direct-web', answer: 'refused' });
    expect(ask('203.0.113.50')).toMatchObject({ router: 'move-m-http', answer: 'served' });
  });

  it('takes an http route only on a server whose Traefik lets a router beat the redirect', async () => {
    const docker = new FakeDocker();
    const server = { name: 'edge-1' };
    docker.containers.set(TRAEFIK_CONTAINER, 'running');
    docker.containerConfigs.set(TRAEFIK_CONTAINER, { cmd: ['--entrypoints.web.address=:80'], envSet: [] });
    expect(await plainHttpRefusal({ docker }, server, 'letsencrypt')).toBe('Traefik on "edge-1" is from before plain http routes. Update the server, then try again.');
    docker.containerConfigs.set(TRAEFIK_CONTAINER, { cmd: ['--entrypoints.web.http.redirections.entrypoint.priority=1'], envSet: [] });
    expect(await plainHttpRefusal({ docker }, server, 'letsencrypt')).toBeNull();
    docker.containers.delete(TRAEFIK_CONTAINER);
    expect(await plainHttpRefusal({ docker }, server, 'letsencrypt')).toBe('Traefik is not running on "edge-1".');
    expect(await plainHttpRefusal({ docker }, server, 'none')).toBeNull();
  });
});

describe('the files on each server', () => {
  async function appWorld() {
    const w = await makeWorld({ env: { TLS_MODE: 'letsencrypt' } });
    const shop = addPhpSite(w, 'shop', { domains: ['shop.example.com'] });
    const app = addContainerApp(w, 'orders', {
      domains: ['orders.example.com', 'orders.dev.example.test'],
      routes: [{ host: 'orders.example.com', scheme: 'both' }, { host: 'shop.example.com', match: 'prefix', path: '/api/' }],
    });
    const file = path.join(w.core.config.srvRoot, 'traefik', 'dynamic', 'app-orders.yml');
    return { w, id: app.id, shop, file };
  }

  it('writes a running app’s file, holds it, and takes it away once the app stops', async () => {
    const { w, id, file } = await appWorld();
    await w.core.appRoutes.syncServer(1);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('wpl7app_r1-http_orders');
    expect(text).toContain('url: "http://wp-orders:8000"');
    await w.core.appRoutes.hold({ id, serverId: 1 });
    expect(fs.readFileSync(file, 'utf8')).toContain('servers: []');
    expect(w.core.appRoutes.state(id).state).toBe('held');
    await w.core.appRoutes.release({ id, serverId: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    w.db.update(sites).set({ status: 'stopped' }).where(eq(sites.id, id)).run();
    await w.core.appRoutes.syncServer(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves every other file in the folder alone, and rewrites nothing that has not changed', async () => {
    const { w, file } = await appWorld();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'move-other.yml'), 'kept');
    fs.writeFileSync(path.join(dir, 'app-gone.yml'), 'an app that is no more');
    await w.core.appRoutes.syncServer(1);
    expect(fs.readFileSync(path.join(dir, 'move-other.yml'), 'utf8')).toBe('kept');
    expect(fs.existsSync(path.join(dir, 'app-gone.yml'))).toBe(false);
    const before = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await w.core.appRoutes.syncServer(1);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(APP_ROUTES_FILE_RE.test('app-orders.yml')).toBe(true);
    expect(APP_ROUTES_FILE_RE.test('sec-orders.yml')).toBe(false);
  });

  it('knows the apps that route on a site, and the http hosts the block list follows onto web', async () => {
    const { w, id, shop } = await appWorld();
    const shopHost = JSON.parse(shop.domains)[0] as string;
    expect(appsRoutingOn(w.db, shop)).toEqual([{ slug: 'orders', host: shopHost }]);
    expect(routedOnRefusal(shop.slug, appsRoutingOn(w.db, shop))).toBe(
      `The container app "orders" has routes on ${shopHost}, which belongs to "${shop.slug}": change its routes first.`,
    );
    expect(appHttpHosts(w.db, 1)).toEqual(['orders.example.com']);
    w.db.update(sites).set({ status: 'stopped' }).where(eq(sites.id, id)).run();
    expect(appHttpHosts(w.db, 1)).toEqual([]);
  });

  it('counts the hosts a move still forwards on plain http on the server it left, until the move is finalized', async () => {
    const { w, id } = await appWorld();
    const s2 = w.addSshServer('s2');
    // Past the cutover: the app is the target's, and its old server forwards its hosts there.
    w.db.update(sites).set({ serverId: s2.id }).where(eq(sites.id, id)).run();
    const forwarder = path.join(w.config.srvRoot, 'traefik', 'dynamic', 'move-orders.yml');
    const cleanup = w.db
      .insert(moveCleanups)
      .values({
        siteId: id,
        siteSlug: 'orders',
        sourceServerId: 1,
        targetServerId: s2.id,
        containerName: 'wp-orders',
        dbName: '',
        dbUser: '',
        filesPath: path.join(w.config.srvRoot, 'sites', 'orders'),
        verifyHosts: '[]',
        targetIp: '203.0.113.9',
        proxyConfigPath: forwarder,
        status: 'pending',
        createdAt: Date.now(),
      })
      .returning()
      .get();
    expect(appHttpHosts(w.db, s2.id)).toEqual(['orders.example.com']);
    expect(appHttpHosts(w.db, 1)).toEqual(['orders.example.com']);
    // A move with no forwarder forwards nothing, and a finalized one has none left.
    w.db.update(moveCleanups).set({ proxyConfigPath: null }).where(eq(moveCleanups.id, cleanup.id)).run();
    expect(appHttpHosts(w.db, 1)).toEqual([]);
    w.db.update(moveCleanups).set({ proxyConfigPath: forwarder, status: 'done' }).where(eq(moveCleanups.id, cleanup.id)).run();
    expect(appHttpHosts(w.db, 1)).toEqual([]);
  });
});

/** Every write of an app's routes file, held or serving, once it is done; `stall()` makes the next one wait for `open()`. */
function slowWrites(files: FilesPort) {
  const write = files.writeFile.bind(files);
  const writes: ('held' | 'serving')[] = [];
  let gate: { reached: () => void; opened: Promise<void> } | null = null;
  let open = () => undefined as void;
  files.writeFile = async (p, content, opts) => {
    if (!APP_ROUTES_FILE_RE.test(path.basename(p))) return write(p, content, opts);
    const g = gate;
    gate = null;
    if (g) {
      g.reached();
      await g.opened;
    }
    await write(p, content, opts);
    writes.push(String(content).includes('servers: []') ? 'held' : 'serving');
  };
  return {
    writes,
    /** Resolves once the next write has begun to wait. */
    stall(): Promise<void> {
      const opened = new Promise<void>((r) => (open = r));
      return new Promise<void>((reached) => (gate = { reached, opened }));
    },
    open: () => open(),
  };
}

/** One address blocked, in force on every server; what the block list's file on server 1 says then. */
async function blockOne(w: TestWorld): Promise<() => string> {
  w.core.blocklist.block({ address: '198.18.9.9', source: 'manual', reason: 'test', durationMs: null });
  await w.core.firewall.idle();
  return () => fs.readFileSync(path.join(w.config.srvRoot, 'traefik', 'dynamic', 'wpl7-blocked.yml'), 'utf8');
}

describe('one sync at a time on a server', () => {
  async function appWorld() {
    const w = await makeWorld({ env: { TLS_MODE: 'letsencrypt' } });
    const app = addContainerApp(w, 'orders', {
      routes: [{ host: 'orders.example.com', scheme: 'both' }, { host: 'shop.example.com', match: 'prefix', path: '/api/' }],
    });
    const file = path.join(w.config.srvRoot, 'traefik', 'dynamic', 'app-orders.yml');
    return { w, id: app.id, file, local: w.servers.rowById(1)!.name };
  }
  const race = <T>(p: Promise<T>) => Promise.race([p.then(() => 'done'), sleep(50).then(() => 'waiting')]);

  it('writes a hold after the sync in progress on its server, so an older plan never lands over it', async () => {
    const { w, id, file } = await appWorld();
    const io = slowWrites(w.servers.handleFor(1).files);
    // The tick planned the routes serving, and is slow to write them.
    const stalled = io.stall();
    const ticked = w.core.appRoutes.tick();
    await stalled;
    const held = w.core.appRoutes.hold({ id, serverId: 1 });
    expect(await race(held)).toBe('waiting');
    io.open();
    await held;
    expect(io.writes).toEqual(['serving', 'held']);
    expect(fs.readFileSync(file, 'utf8')).toContain('servers: []');
    await ticked;
    await w.core.appRoutes.idle();
    expect(fs.readFileSync(file, 'utf8')).toContain('servers: []');
  });

  it('writes a release after the sync in progress too, so the routes do not stay held', async () => {
    const { w, id, file } = await appWorld();
    await w.core.appRoutes.hold({ id, serverId: 1 });
    // The next plan differs from the file, so the tick has something to write: the routes, still held.
    w.db.update(appRoutes).set({ enabled: 0 }).where(eq(appRoutes.host, 'shop.example.com')).run();
    const io = slowWrites(w.servers.handleFor(1).files);
    const stalled = io.stall();
    const ticked = w.core.appRoutes.tick();
    await stalled;
    const released = w.core.appRoutes.release({ id, serverId: 1 });
    expect(await race(released)).toBe('waiting');
    io.open();
    await Promise.all([released, ticked]);
    expect(io.writes).toEqual(['held', 'serving']);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('url: "http://wp-orders:8000"');
    expect(text).not.toContain('shop.example.com');
  });

  it('lets a hold or a release ride along with a kick still waiting to start, without its debounce', async () => {
    const { w, id, file } = await appWorld();
    const routes = new AppRoutesService(w.db, w.config, w.servers, w.core.dns, quiet, { debounceMs: 60_000 });
    // Before the kick's wait has begun, and during it.
    const first = routes.kick(1);
    await routes.hold({ id, serverId: 1 });
    expect(fs.readFileSync(file, 'utf8')).toContain('servers: []');
    expect(await race(first)).toBe('done');
    const second = routes.kick(1);
    await sleep(10);
    await routes.release({ id, serverId: 1 });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('servers: []');
    expect(await race(second)).toBe('done');
  });

  it('refuses a hold it could not write, and holds nothing then', async () => {
    const { w, id, file, local } = await appWorld();
    await w.core.appRoutes.syncServer(1);
    const files = w.servers.handleFor(1).files;
    const write = files.writeFile.bind(files);
    files.writeFile = async () => {
      throw new Error('ENOSPC: no space left on device');
    };
    await expect(w.core.appRoutes.hold({ id, serverId: 1 })).rejects.toThrow(`Could not hold the app's routes on "${local}": ENOSPC: no space left on device`);
    expect(w.core.appRoutes.isHeld(id)).toBe(false);
    files.writeFile = write;

    // A path Traefik would read differently: the app's own file cannot be made at all.
    w.db.update(appRoutes).set({ path: '/api/`) || Host(`victim.example.com' }).where(eq(appRoutes.host, 'shop.example.com')).run();
    await expect(w.core.appRoutes.hold({ id, serverId: 1 })).rejects.toThrow(`Could not hold the app's routes on "${local}": path: A backtick (\`) cannot be used in a rule`);
    expect(w.core.appRoutes.isHeld(id)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('servers: []');

    const s2 = w.addSshServer('s2', { real: true });
    const far = addContainerApp(w, 'far', { serverId: s2.id, routes: [{ host: 'far.example.com' }] });
    s2.files.writeFile = async () => {
      throw new ServerUnreachableError(s2.id, 's2', new Error('connect ETIMEDOUT'));
    };
    await expect(w.core.appRoutes.hold(far)).rejects.toThrow(`Could not hold the app's routes on "s2": Server "s2" (#${s2.id}) is unreachable over SSH: connect ETIMEDOUT`);
    expect(w.core.appRoutes.isHeld(far.id)).toBe(false);
  });

  it('puts a held file back that landed although its write failed, and holds nothing', async () => {
    const { w, id, file, local } = await appWorld();
    await w.core.appRoutes.syncServer(1);
    await w.core.firewall.idle();
    const files = w.servers.handleFor(1).files;
    const write = files.writeFile.bind(files);
    // The rename was done before the command timed out: the file says held, the write says it failed.
    files.writeFile = async (p, content, opts) => {
      await write(p, content, opts);
      if (!APP_ROUTES_FILE_RE.test(path.basename(p))) return;
      files.writeFile = write;
      throw new Error('the command timed out');
    };
    await expect(w.core.appRoutes.hold({ id, serverId: 1 })).rejects.toThrow(`Could not hold the app's routes on "${local}": the command timed out`);
    expect(w.core.appRoutes.isHeld(id)).toBe(false);
    await w.core.appRoutes.idle();
    expect(fs.readFileSync(file, 'utf8')).toContain('url: "http://wp-orders:8000"');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('servers: []');
  });

  it('lets go of a hold whatever the server says, and logs what it could not write', async () => {
    const { w, id, file, local } = await appWorld();
    const warnings: string[] = [];
    const routes = new AppRoutesService(w.db, w.config, w.servers, w.core.dns, { ...quiet, warn: (m: string) => void warnings.push(m) }, { debounceMs: 0 });
    await routes.hold({ id, serverId: 1 });
    const files = w.servers.handleFor(1).files;
    const write = files.writeFile.bind(files);
    files.writeFile = async () => {
      throw new Error('EACCES: permission denied');
    };
    await expect(routes.release({ id, serverId: 1 })).resolves.toBeUndefined();
    expect(routes.isHeld(id)).toBe(false);
    expect(warnings).toContain(`Routes of site #${id} still held on "${local}": EACCES: permission denied. The minute tick tries again.`);
    expect(fs.readFileSync(file, 'utf8')).toContain('servers: []');
    files.writeFile = write;
    await routes.tick();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('servers: []');
  });

  it('tells the block list when a server’s plain http hosts change, and only then', async () => {
    const { w, id } = await appWorld();
    const changes: number[] = [];
    const routes = new AppRoutesService(w.db, w.config, w.servers, w.core.dns, quiet, { debounceMs: 0, onWebHostsChange: (serverId) => void changes.push(serverId) });
    // The first sight of a server is one: the block list read its hosts as the panel started, before this did.
    await routes.syncServer(1);
    expect(changes).toEqual([1]);
    await routes.hold({ id, serverId: 1 });
    await routes.release({ id, serverId: 1 });
    expect(changes).toEqual([1]);
    w.db.update(appRoutes).set({ scheme: 'both' }).where(eq(appRoutes.host, 'shop.example.com')).run();
    await routes.kick(1);
    expect(changes).toEqual([1, 1]);
    // A path is nothing the block list follows.
    w.db.update(appRoutes).set({ path: '/v2/' }).where(eq(appRoutes.host, 'shop.example.com')).run();
    await routes.kick(1);
    expect(changes).toEqual([1, 1]);
    w.db.update(sites).set({ status: 'stopped' }).where(eq(sites.id, id)).run();
    await routes.kick(1);
    expect(changes).toEqual([1, 1, 1]);
  });

  it('brings the block list’s twin along for a host that just took plain http', async () => {
    const { w } = await appWorld();
    const blocked = await blockOne(w);
    await w.core.appRoutes.syncServer(1);
    await w.core.firewall.idle();
    expect(blocked()).not.toContain('Host(`shop.example.com`)');
    w.db.update(appRoutes).set({ scheme: 'both' }).where(eq(appRoutes.host, 'shop.example.com')).run();
    await w.core.appRoutes.kick(1);
    await w.core.firewall.idle();
    expect(blocked()).toContain('Host(`shop.example.com`)');
  });

  it('lets go of what Traefik said about an app’s routers once its file is written again, or removed', async () => {
    const { w, id } = await appWorld();
    await w.core.appRoutes.syncServer(1);
    // Traefik's word on the file there now, as it logs it.
    const said = () => `${stamp(Date.now())} ERR error="error while adding rule Host: empty args for matcher Host, []" entryPointName=web routerName=wpl7app_r1-http_orders@file`;
    w.core.security.noteTraefikLog(said());
    expect(w.core.security.appRouteRejections('orders')).toMatchObject([{ router: 'wpl7app_r1-http_orders' }]);
    // Nothing to write: what Traefik said still stands.
    await w.core.appRoutes.syncServer(1);
    expect(w.core.security.appRouteRejections('orders')).toHaveLength(1);
    w.db.update(appRoutes).set({ path: '/v2/' }).where(eq(appRoutes.host, 'shop.example.com')).run();
    await w.core.appRoutes.syncServer(1);
    expect(w.core.security.appRouteRejections('orders')).toEqual([]);
    w.core.security.noteTraefikLog(said());
    expect(w.core.security.appRouteRejections('orders')).toHaveLength(1);
    // Stopped: its file is taken away, and with it what Traefik said.
    w.db.update(sites).set({ status: 'stopped' }).where(eq(sites.id, id)).run();
    await w.core.appRoutes.syncServer(1);
    expect(w.core.security.appRouteRejections('orders')).toEqual([]);
  });
});

describe('the hosts the block list follows onto web', () => {
  const tls = () => makeWorld({ env: { TLS_MODE: 'letsencrypt' } });

  it('has the block list look again at a server the routes see for the first time, which writes and loads nothing when nothing changed', async () => {
    const w = await tls();
    addContainerApp(w, 'orders', { routes: [{ host: 'orders.example.com', scheme: 'both' }] });
    // The block list's own sync, as the panel starts.
    const blocked = await blockOne(w);
    const host = w.firewallHost(1);
    const [text, looks, loads] = [blocked(), host.calls.length, host.applied.length];
    expect(text).toContain('Host(`orders.example.com`)');
    const file = path.join(w.config.srvRoot, 'traefik', 'dynamic', 'wpl7-blocked.yml');
    const mtime = fs.statSync(file).mtimeMs;
    await sleep(20);
    await w.core.appRoutes.syncServer(1);
    await w.core.firewall.idle();
    expect(host.calls).toHaveLength(looks + 1);
    expect(host.applied).toHaveLength(loads);
    expect(blocked()).toBe(text);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('brings along a host that took plain http after the block list read them, before the routes’ first sync', async () => {
    const w = await tls();
    addContainerApp(w, 'orders', { routes: [{ host: 'orders.example.com', scheme: 'https' }] });
    const blocked = await blockOne(w);
    expect(blocked()).not.toContain('Host(`orders.example.com`)');
    w.db.update(appRoutes).set({ scheme: 'both' }).where(eq(appRoutes.host, 'orders.example.com')).run();
    await w.core.appRoutes.kick(1);
    await w.core.firewall.idle();
    expect(blocked()).toContain('Host(`orders.example.com`)');
  });

  it('follows a new app’s hosts from its pin, while its row still says provisioning', async () => {
    const w = await tls();
    const blocked = await blockOne(w);
    await w.core.appRoutes.syncServer(1);
    await w.core.firewall.idle();
    // appCreate's order (jobs/handlers/apps.ts): the file is written before the row says the app runs.
    const app = addContainerApp(w, 'orders', { status: 'provisioning', routes: [{ host: 'orders.example.com', scheme: 'both' }] });
    const unpin = w.core.appRoutes.pin(1, app.id);
    await w.core.appRoutes.kick(1);
    await w.core.firewall.idle();
    expect(blocked()).toContain('Host(`orders.example.com`)');
    w.db.update(sites).set({ status: 'running' }).where(eq(sites.id, app.id)).run();
    unpin();
    await w.core.appRoutes.idle();
    await w.core.firewall.idle();
    expect(blocked()).toContain('Host(`orders.example.com`)');
  });

  it('takes a pinned app’s routes and their twins away once the pin lets go, unless its row keeps them', async () => {
    const w = await tls();
    const blocked = await blockOne(w);
    // A create that fails after its routes were written: the row never says the app runs.
    const app = addContainerApp(w, 'orders', { status: 'provisioning', routes: [{ host: 'orders.example.com', scheme: 'both' }] });
    const file = path.join(w.config.srvRoot, 'traefik', 'dynamic', 'app-orders.yml');
    const unpin = w.core.appRoutes.pin(1, app.id);
    await w.core.appRoutes.kick(1);
    await w.core.firewall.idle();
    expect(fs.existsSync(file)).toBe(true);
    expect(blocked()).toContain('Host(`orders.example.com`)');
    w.db.update(sites).set({ status: 'error' }).where(eq(sites.id, app.id)).run();
    unpin();
    await w.core.appRoutes.idle();
    await w.core.firewall.idle();
    expect(fs.existsSync(file)).toBe(false);
    expect(blocked()).not.toContain('Host(`orders.example.com`)');
  });

  it('drops a moved app’s twins on the server it left once its move is finalized, not before', async () => {
    const w = await tls();
    const s2 = w.addSshServer('s2', { real: true });
    // Past the cutover: the app is the target's, and its old server forwards its hosts there.
    const app = addContainerApp(w, 'orders', { serverId: s2.id, routes: [{ host: 'orders.example.com', scheme: 'both' }] });
    const forwarder = path.join(w.config.srvRoot, 'traefik', 'dynamic', 'move-orders.yml');
    const cleanup = w.db
      .insert(moveCleanups)
      .values({
        siteId: app.id,
        siteSlug: 'orders',
        sourceServerId: 1,
        targetServerId: s2.id,
        containerName: 'wp-orders',
        dbName: '',
        dbUser: '',
        filesPath: path.join(w.config.srvRoot, 'sites', 'orders'),
        verifyHosts: '[]',
        targetIp: '203.0.113.9',
        proxyConfigPath: forwarder,
        status: 'pending',
        createdAt: Date.now(),
      })
      .returning()
      .get();
    const blocked = await blockOne(w);
    await w.core.appRoutes.syncServer(1);
    await w.core.firewall.idle();
    expect(blocked()).toContain('Host(`orders.example.com`)');
    // The forwarder goes last: a sync queued before it has run by then, and the cleanup is not done yet.
    const files = w.servers.handleFor(1).files;
    const rm = files.rm.bind(files);
    files.rm = async (p) => {
      if (p === forwarder) await w.core.appRoutes.idle();
      return rm(p);
    };
    const ctx = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as JobContext<unknown>;
    await finalizeCleanup(ctx, w.core, cleanup);
    await w.core.appRoutes.idle();
    await w.core.firewall.idle();
    expect(blocked()).not.toContain('Host(`orders.example.com`)');
  });
});
