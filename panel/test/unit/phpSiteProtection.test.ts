/**
 * A PHP site's protection, scans, Redis and images: none of WordPress's rules, its assets counted
 * wherever they are, a scan that ends without asking for WordPress, Redis for its own app, and no
 * container from an image that cannot run it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CidrSet } from '../../shared/cidr.js';
import { LEVEL_PRESETS, WORDPRESS_ONLY_SETTINGS, effectivePolicy, isWordPressOnlySetting } from '../../shared/security.js';
import { jobs, sites } from '../../src/db/schema.js';
import { RANGE_SOURCES } from '../../src/services/proxyRanges.js';
import { buildSiteSecurityConfig, bypassList, type SiteRulesInput } from '../../src/services/securityConfig.js';
import { sweepSiteImages } from '../../src/services/siteImages.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { route } from '../traefikSim.js';
import { addPhpSite, makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status), 20_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

async function authed(w: TestWorld) {
  const { app } = await makeApp(w);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

const DOMAINS = ['shop.example.com'];
const VISITOR = '198.18.7.7';

function rules(app: 'wordpress' | 'php', level: 'standard' | 'strict' = 'strict') {
  const input: SiteRulesInput = {
    slug: 'shop',
    app,
    domains: DOMAINS,
    policy: effectivePolicy({ level, overrides: {} }, { level: null, overrides: {}, customRules: [] }, app),
    tlsMode: 'letsencrypt',
    proxies: [{ name: 'cloudflare', header: 'Cf-Connecting-Ip', ranges: new CidrSet(RANGE_SOURCES.cloudflare.builtin) }],
    bypass: bypassList({ fleet: ['203.0.113.10'], neverBlock: [], bypassPrivate: true }),
    fleet: ['203.0.113.10'],
    jetpack: RANGE_SOURCES.jetpack.builtin,
  };
  return buildSiteSecurityConfig(input)!;
}

const ask = (config: ReturnType<typeof rules>, p: string) => {
  const [pathname, query] = p.split('?') as [string, string | undefined];
  return route(config, { host: 'shop.example.com', method: 'GET', peer: VISITOR, path: pathname, query: query ?? '' }, DOMAINS, 'shop');
};

describe("a PHP site's protection", () => {
  it("has none of WordPress's parts, whatever the level and the default say", () => {
    const fleet = { level: 'strict' as const, overrides: { rules: { enum: true, uploads: true } } };
    const php = effectivePolicy(fleet, { level: null, overrides: {}, customRules: [] }, 'php');
    expect(php.rules).toEqual({ files: true, uploads: false, install: false, scanners: true, enum: false });
    expect([php.xmlrpc, php.wpcron, php.limits.login, php.limits.xmlrpc]).toEqual(['allow', 'allow', null, null]);
    expect(php.container).toEqual({ blockPhpInUploads: false, disallowFileEdit: false, disallowFileMods: false });
    expect(php.limits.requests).toEqual(LEVEL_PRESETS.strict.limits.requests);
    expect(php.headers).toEqual(LEVEL_PRESETS.strict.headers);
    expect(Object.keys(php.sources).filter(isWordPressOnlySetting)).toEqual([]);
    // The same default, for a WordPress site: as it was.
    const wp = effectivePolicy(fleet, { level: null, overrides: {}, customRules: [] }, 'wordpress');
    expect([wp.rules.enum, wp.rules.uploads, wp.xmlrpc, wp.wpcron]).toEqual([true, true, 'deny', 'deny']);
    expect(WORDPRESS_ONLY_SETTINGS).toHaveLength(10);
  });

  it('lets ?author= through, and counts its assets as assets wherever they are', () => {
    const php = rules('php');
    const wp = rules('wordpress');
    // Through to the site, under the request limit; a WordPress site refuses it.
    expect(ask(php, '/?author=1').answer).toBe('limited');
    expect(ask(wp, '/?author=1').answer).toBe('refused');
    expect(ask(php, '/assets/app.css').middlewares.some((m) => m.includes('limit-assets'))).toBe(true);
    expect(ask(wp, '/assets/app.css').middlewares.some((m) => m.includes('limit-assets'))).toBe(false);
    expect(ask(wp, '/wp-content/themes/x/style.css').middlewares.some((m) => m.includes('limit-assets'))).toBe(true);
    // Secret files are refused on both.
    expect(ask(php, '/.env').answer).toBe('refused');
  });

  it("refuses a site's own change to a WordPress-only setting, naming each", async () => {
    const w = await makeWorld();
    addPhpSite(w, 'shop');
    const { app, headers } = await authed(w);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sites/shop/security',
      headers,
      payload: { overrides: { rules: { enum: true, files: false }, xmlrpc: 'deny', limits: { login: null } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('"shop" is a PHP site, which has none of these: rules.enum, xmlrpc, limits.login');
    const ok = await app.inject({ method: 'PUT', url: '/api/sites/shop/security', headers, payload: { overrides: { rules: { files: false } } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ app: 'php', policy: { rules: { files: false, enum: false } } });
  });
});

describe("a PHP site's malware scan", () => {
  it('ends clean, not incomplete, though no WordPress is found', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'shop');
    fs.mkdirSync(sitePaths(w.config, 'shop').wordpress, { recursive: true });
    const out = (...lines: object[]) => ({ stdout: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', stderr: '', exitCode: 0 });
    w.docker.ephemeral = (opts) => {
      const which = opts.labels?.['wpl7.scan'];
      if (which === 'inventory') return out({ t: 'inventory', core: null, plugins: [], themes: [] });
      if (which === 'check') {
        return out({ t: 'summary', engine: 'check', complete: true, files: 12, unreadable: 0, findings: 0, truncated: false, packages: {}, links: [] });
      }
      return out({ t: 'summary', engine: 'signatures', exit: 0, report: true, scanned: 12, complete: true, errors: 0, unreadable: 0, definitions: '2026.09.08.1', findings: 0, truncated: false, peakMemory: 1 });
    };
    const log = { info: () => undefined, warn: () => undefined, checkCanceled: () => undefined };
    const result = await w.core.malwareScan.scan(log, site.id, 'manual', null);
    expect([result.outcome, result.problem]).toEqual(['clean', null]);
  });
});

describe("a PHP site's Redis", () => {
  it('is Redis alone: no plugin, and it is never emptied by the panel', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'shop');
    w.docker.stackOf('wpl7-wordpress:php8.3', 2);
    const { app, headers } = await authed(w);
    // A stack 2 container, as every PHP site's is.
    const { ensureSiteMountSources } = await import('../../src/jobs/handlers/shared.js');
    await ensureSiteMountSources(w.servers.handleFor(1), w.core, site);
    const { siteContainerSpec, siteRuntimeFrom } = await import('../../src/services/siteSpec.js');
    await w.docker.createSiteContainer(await siteContainerSpec(w.core, w.servers.handleFor(1), site, ['shop.example.test'], siteRuntimeFrom(w.core.settings, site)));
    w.docker.containers.set('wp-shop', 'running');

    const res = await app.inject({ method: 'PUT', url: '/api/sites/shop/cache', headers, payload: { object: true } });
    expect(res.statusCode).toBe(202);
    const done = await runJob(w, res.json().job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.objectCache).toBe(1);
    const execs = w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
    expect(execs.filter((c) => c.startsWith('wp '))).toEqual([]);
    expect(w.docker.reloads).toContainEqual({ name: 'wp-shop', service: 'redis' });
    expect(fs.existsSync(path.join(sitePaths(w.config, 'shop').runtimeDir, 'redis.conf'))).toBe(true);
    expect(w.docker.redisFlushes).toEqual([]);
  });
});

describe("a PHP site and its server's image", () => {
  it('a PHP version change to an image from before PHP sites is refused before it is queued, and by the job', async () => {
    const w = await makeWorld();
    w.deps.settings.set('phpVersions', ['8.3', '8.4']);
    const site = addPhpSite(w, 'shop');
    w.docker.images.add('wpl7-wordpress:php8.4');
    w.docker.appsOf('wpl7-wordpress:php8.4', ['wordpress']);
    const { app, headers } = await authed(w);
    const res = await app.inject({ method: 'PUT', url: '/api/sites/shop/php', headers, payload: { phpVersion: '8.4' } });
    expect([res.statusCode, res.json().error.message]).toEqual([409, 'The site image on "local" is from before PHP sites. Update the server, then try again.']);
    const job = w.worker.enqueue('site.changePhp', { siteId: site.id, phpVersion: '8.4' }, site);
    const done = await runJob(w, job.id);
    expect([done.status, done.error]).toEqual(['failed', 'The site image on "local" is from before PHP sites. Update the server, then try again.']);
    // The old container is never set aside for it.
    expect(w.docker.calls.filter((c) => c.method === 'renameContainer' || c.method === 'stopContainer')).toEqual([]);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.phpVersion).toBe('8.3');
  });

  it("a restore keeps the site's PHP version, and says so, when the backup's is on an image from before PHP sites", async () => {
    const { hostExec } = await import('../../src/lib/exec.js');
    const { jobLogs } = await import('../../src/db/schema.js');
    const w = await makeWorld({ exec: hostExec });
    w.deps.settings.set('phpVersions', ['8.3', '8.4']);
    const site = addPhpSite(w, 'shop');
    fs.mkdirSync(sitePaths(w.config, 'shop').wordpress, { recursive: true });
    w.db.update(sites).set({ phpVersion: '8.4' }).where(eq(sites.id, site.id)).run();
    const backup = await w.core.backup.create(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!, 'manual');
    w.db.update(sites).set({ phpVersion: '8.3' }).where(eq(sites.id, site.id)).run();
    w.docker.images.add('wpl7-wordpress:php8.4');
    w.docker.appsOf('wpl7-wordpress:php8.4', ['wordpress']);
    const job = w.worker.enqueue('backup.restore', { backupId: backup.id, skipPreRestoreBackup: true }, site);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.phpVersion).toBe('8.3');
    const log = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, job.id)).all().map((l) => l.message).join('\n');
    expect(log).toContain('Backup was taken on PHP 8.4, but the site image for it on "local" is from before PHP sites; keeping PHP 8.3.');
  });

  it('the image sweep leaves a PHP site alone while its tag names an image from before PHP sites', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'shop');
    w.docker.imageByContainer.set('wp-shop', 'sha256:older');
    w.docker.imageIds.set('wpl7-wordpress:php8.3', 'sha256:newer');
    w.docker.appsOf('wpl7-wordpress:php8.3', ['wordpress']);
    const sweep = await sweepSiteImages(w.core, w.worker);
    expect(sweep.queued).toEqual([]);
    w.docker.appsOf('wpl7-wordpress:php8.3', ['wordpress', 'php']);
    expect((await sweepSiteImages(w.core, w.worker)).queued).toEqual([site.slug]);
  });
});
