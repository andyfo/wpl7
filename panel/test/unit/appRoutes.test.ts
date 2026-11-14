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
import { sites } from '../../src/db/schema.js';
import { proxyConfigYaml } from '../../src/jobs/handlers/moveHelpers.js';
import { siteSlugFromRouter } from '../../src/lib/accessLog.js';
import {
  APP_ROUTES_FILE_RE,
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
import { FakeDocker, addContainerApp, addPhpSite, makeWorld } from '../helpers.js';

const route = (id: number, host: string, match: 'none' | 'prefix' | 'exact', p: string, scheme: 'https' | 'http' | 'both', enabled = 1) => ({
  id,
  host,
  match,
  path: p,
  scheme,
  enabled,
});

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
});
