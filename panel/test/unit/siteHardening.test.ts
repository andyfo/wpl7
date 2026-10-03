/**
 * The protection inside a site's container (services/siteHardening.ts): two files it mounts
 * read-only, written before every start, changed live - PHP's replaced whole, Apache's
 * rewritten in place, checked and then reloaded gracefully - and the one-time rebuild of the
 * containers that were made before either existed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, type SiteRow } from '../../src/db/schema.js';
import type { SiteContainerSpec } from '../../src/services/docker.js';
import { SecurityService } from '../../src/services/security.js';
import {
  HARDENING_LABEL,
  HARDENING_VERSION,
  hardeningFiles,
  renderApacheHardening,
  renderWpConfigHardening,
  sweepHardening,
} from '../../src/services/siteHardening.js';
import { WORDPRESS_CONFIG_EXTRA, sitePaths } from '../../src/services/siteSpec.js';
import { HOOKS } from '../../src/updates/hooks.js';
import { LEVEL_PRESETS } from '../../shared/security.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

const HAS_PHP = spawnSync('php', ['-v']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-hardening-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Run `code` through the PHP CLI, as if Apache were serving it when `sapi` says so. */
function php(code: string, opts: { sapi?: string; before?: string } = {}) {
  const file = path.join(tmp, `extra-${Math.random().toString(36).slice(2)}.php`);
  fs.writeFileSync(file, opts.sapi ? code.replaceAll('PHP_SAPI', JSON.stringify(opts.sapi)) : code);
  const script = `${opts.before ?? ''} require ${JSON.stringify(file)}; echo json_encode([defined('DISALLOW_FILE_EDIT') ? DISALLOW_FILE_EDIT : null, defined('DISALLOW_FILE_MODS') ? DISALLOW_FILE_MODS : null]);`;
  const res = spawnSync('php', ['-d', 'display_errors=stderr', '-d', 'error_reporting=E_ALL', '-r', script], { encoding: 'utf8' });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
}

function seedCoreFilesOnStart(w: TestWorld): void {
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const p = sitePaths(w.config, name.slice(3));
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
  };
}

async function runJob(w: TestWorld, jobId: number): Promise<string> {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status;
}

async function createSite(w: TestWorld): Promise<SiteRow> {
  seedCoreFilesOnStart(w);
  const { site, job } = w.deps.sites.create({
    title: 'Demo Site',
    domainMode: 'dev' as const,
    adminUser: 'boss',
    adminEmail: 'boss@example.com',
    plugins: { catalogIds: [], extraWporgSlugs: [] },
  });
  expect(await runJob(w, job.id)).toBe('succeeded');
  return w.deps.sites.bySlug(site.slug);
}

const lastSpec = (w: TestWorld) =>
  w.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!.args[0] as SiteContainerSpec;
const apacheChecks = (w: TestWorld) =>
  w.docker.calls.filter((c) => c.method === 'exec' && (c.args[1] as string[])[0] === 'apache2ctl');
const inode = (file: string) => fs.statSync(file).ino;
const read = (file: string) => fs.readFileSync(file, 'utf8');

/** The container the previous version built: no protection mounts, no label, no files. */
async function makeOld(w: TestWorld, site: SiteRow): Promise<void> {
  const spec = lastSpec(w);
  const labels = { ...spec.labels };
  delete labels[HARDENING_LABEL];
  await w.docker.removeContainer(site.containerName);
  await w.docker.createSiteContainer({ ...spec, labels, binds: spec.binds.filter((b) => !/security/.test(b)) });
  w.docker.containers.set(site.containerName, 'running');
  const p = sitePaths(w.config, site.slug);
  fs.rmSync(p.securityApacheConf, { force: true });
  fs.rmSync(p.securityDir, { recursive: true, force: true });
}

describe('what the files say', () => {
  it('Standard: no PHP under uploads, and no file editor in wp-admin', () => {
    const { apache, php: extra } = hardeningFiles(LEVEL_PRESETS.standard.container);
    expect(apache).toContain('<Directory "/var/www/html/wp-content/uploads">');
    expect(apache).toContain('php_admin_flag engine off');
    expect(apache).toContain('Require all denied');
    expect(extra).toContain("define('DISALLOW_FILE_EDIT', true)");
    expect(extra).not.toContain('DISALLOW_FILE_MODS');
  });

  it('Strict adds no installs from wp-admin; Off adds nothing at all', () => {
    expect(renderWpConfigHardening(LEVEL_PRESETS.strict.container)).toContain("define('DISALLOW_FILE_MODS', true)");
    const off = hardeningFiles(LEVEL_PRESETS.off.container);
    expect(off.apache).not.toMatch(/^[^#\n]/m);
    expect(off.php).not.toContain('define(');
  });

  it('refuses the same PHP files under uploads as the Traefik rule does, and nothing else', () => {
    const pattern = /<LocationMatch "\(\?i\)(.+)">/.exec(renderApacheHardening({ blockPhpInUploads: true }))![1]!;
    const re = new RegExp(pattern, 'i');
    for (const p of ['/wp-content/uploads/2026/09/shell.php', '/wp-content/uploads/x.PHP7', '/wp-content/uploads/a.phtml', '/wp-content/uploads/a.phar', '/wp-content/uploads/a.php/more', '/wp-content/uploads/a.php.jpg']) {
      expect(re.test(p), p).toBe(true);
    }
    for (const p of ['/wp-content/uploads/2026/09/photo.jpg', '/wp-content/uploads/php/readme.txt', '/wp-content/plugins/x/x.php', '/wp-login.php']) {
      expect(re.test(p), p).toBe(false);
    }
  });

  it.skipIf(!HAS_PHP)('is PHP that runs cleanly: never from the command line, and a constant the site set first wins', () => {
    const strict = renderWpConfigHardening(LEVEL_PRESETS.strict.container);
    expect(php(strict)).toEqual({ code: 0, out: '[null,null]', err: '' });
    expect(php(strict, { sapi: 'apache2handler' })).toEqual({ code: 0, out: '[true,true]', err: '' });
    // Defined earlier in the site's own wp-config.php: kept, and no warning about it.
    expect(php(strict, { sapi: 'apache2handler', before: "define('DISALLOW_FILE_EDIT', false);" })).toEqual({ code: 0, out: '[false,true]', err: '' });
    expect(php(renderWpConfigHardening(LEVEL_PRESETS.off.container), { sapi: 'apache2handler' })).toEqual({ code: 0, out: '[null,null]', err: '' });
  });

  it.skipIf(!HAS_PHP)("includes the file from the container's wp-config extra, and only when it is there", () => {
    const res = spawnSync('php', ['-d', 'display_errors=stderr', '-r', WORDPRESS_CONFIG_EXTRA], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(WORDPRESS_CONFIG_EXTRA).toContain("if (is_readable('/etc/wpl7/wp-config-extra.php')) { require_once '/etc/wpl7/wp-config-extra.php'; }");
  });
});

describe('a site container', () => {
  it('mounts both read-only, carries the label, and finds them written from its protection', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const p = sitePaths(w.config, site.slug);
    const spec = lastSpec(w);
    expect(spec.binds).toContain(`${p.securityApacheConf}:/etc/apache2/conf-enabled/zz-wpl7-security.conf:ro`);
    expect(spec.binds).toContain(`${p.securityDir}:/etc/wpl7:ro`);
    expect(spec.labels[HARDENING_LABEL]).toBe(HARDENING_VERSION);
    const want = hardeningFiles(LEVEL_PRESETS.standard.container);
    expect(read(p.securityApacheConf)).toBe(want.apache);
    expect(read(p.securityWpPhp)).toBe(want.php);
    expect(fs.statSync(p.securityWpPhp).mode & 0o777).toBe(0o644);
  });

  it('gets them rewritten from the protection as it is now before every start', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const p = sitePaths(w.config, site.slug);
    expect(await runJob(w, w.deps.sites.action(site.slug, 'stop').id)).toBe('succeeded');
    w.core.security.updateSite(site, { level: 'strict' }, 'alice');
    await w.core.security.idle();
    fs.writeFileSync(p.securityApacheConf, '# edited by hand\n');

    expect(await runJob(w, w.deps.sites.action(site.slug, 'start').id)).toBe('succeeded');
    const want = hardeningFiles(LEVEL_PRESETS.strict.container);
    expect(read(p.securityApacheConf)).toBe(want.apache);
    expect(read(p.securityWpPhp)).toBe(want.php);
  });

  it('starts even where Docker left a directory in place of the Apache file', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.enforceFileBinds = true;
    const p = sitePaths(w.config, site.slug);
    fs.rmSync(p.securityApacheConf);
    fs.mkdirSync(p.securityApacheConf);

    expect(await runJob(w, w.deps.sites.action(site.slug, 'restart').id)).toBe('succeeded');
    expect(fs.statSync(p.securityApacheConf).isFile()).toBe(true);
    expect(w.docker.containers.get(site.containerName)).toBe('running');
  });
});

describe('a change of protection, on a running site', () => {
  it('replaces the PHP file whole, rewrites the Apache file in place, checks it, then reloads gracefully', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const p = sitePaths(w.config, site.slug);
    const phpInode = inode(p.securityWpPhp);
    const apacheInode = inode(p.securityApacheConf);

    w.core.security.updateSite(site, { level: 'off' }, 'alice');
    await w.core.security.idle();

    const off = hardeningFiles(LEVEL_PRESETS.off.container);
    expect(read(p.securityWpPhp)).toBe(off.php);
    expect(inode(p.securityWpPhp)).not.toBe(phpInode);
    expect(read(p.securityApacheConf)).toBe(off.apache);
    // The mount still shows the container this file: the same inode.
    expect(inode(p.securityApacheConf)).toBe(apacheInode);
    expect(apacheChecks(w)).toHaveLength(1);
    expect(apacheChecks(w)[0]!.args[0]).toBe(site.containerName);
    expect(w.docker.signals).toEqual([{ name: site.containerName, signal: 'SIGUSR1' }]);
  });

  it('leaves Apache alone when only the PHP side changes', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const p = sitePaths(w.config, site.slug);
    w.core.security.updateSite(site, { level: 'strict' }, 'alice');
    await w.core.security.idle();
    expect(read(p.securityWpPhp)).toContain('DISALLOW_FILE_MODS');
    expect(apacheChecks(w)).toHaveLength(0);
    expect(w.docker.signals).toEqual([]);
  });

  it('puts the old Apache file back when the check refuses the new one, says so, and does not insist', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const p = sitePaths(w.config, site.slug);
    const standard = read(p.securityApacheConf);
    // What Apache printed for a misspelt directive, word for word.
    w.docker.apacheCheck = {
      stdout: '',
      stderr: [
        "AH00558: apache2: Could not reliably determine the server's fully qualified domain name, using 172.17.0.3.",
        'AH00526: Syntax error on line 2 of /etc/apache2/conf-enabled/zz-wpl7-security.conf:',
        "Invalid command 'php_admin_flagg', perhaps misspelled or defined by a module not included in the server configuration",
      ].join('\n'),
      exitCode: 1,
    };

    w.core.security.updateSite(site, { overrides: { container: { blockPhpInUploads: false } } }, 'alice');
    await w.core.security.idle();
    expect(read(p.securityApacheConf)).toBe(standard);
    expect(w.docker.signals).toEqual([]);
    expect(w.core.security.siteStatus(w.deps.sites.bySlug(site.slug)).unprotected).toMatch(/Apache refused .*AH00526: Syntax error on line 2 of \S+: Invalid command 'php_admin_flagg'/);

    await w.core.security.kick(site.serverId);
    expect(apacheChecks(w)).toHaveLength(1);

    // Back to what it was: nothing to apply, nothing to complain about.
    w.core.security.updateSite(site, { overrides: {} }, 'alice');
    await w.core.security.idle();
    expect(w.core.security.siteStatus(w.deps.sites.bySlug(site.slug)).unprotected).toBeNull();
  });

  it('puts the old file back when the container cannot be asked, and tries again at the next tick', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const p = sitePaths(w.config, site.slug);
    const standard = read(p.securityApacheConf);
    w.docker.failOn.set('exec', 'container is restarting');

    w.core.security.updateSite(site, { overrides: { container: { blockPhpInUploads: false } } }, 'alice');
    await w.core.security.idle();
    expect(read(p.securityApacheConf)).toBe(standard);
    expect(w.core.security.siteStatus(w.deps.sites.bySlug(site.slug)).unprotected).toMatch(/could not be updated: container is restarting/);

    w.docker.failOn.delete('exec');
    expect(w.core.security.tick().kicked).toBe(1);
    await w.core.security.idle();
    expect(read(p.securityApacheConf)).toBe(renderApacheHardening({ blockPhpInUploads: false }));
    expect(w.docker.signals).toEqual([{ name: site.containerName, signal: 'SIGUSR1' }]);
    expect(w.core.security.siteStatus(w.deps.sites.bySlug(site.slug)).unprotected).toBeNull();
  });

  it('reads the files after a panel restart instead of rewriting them', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const p = sitePaths(w.config, site.slug);
    const phpInode = inode(p.securityWpPhp);
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const restarted = new SecurityService(w.db, w.config, w.servers, w.core.settings, w.core.proxyRanges, log, { debounceMs: 0 });
    await restarted.syncServer(site.serverId);
    expect(inode(p.securityWpPhp)).toBe(phpInode);
    expect(apacheChecks(w)).toHaveLength(0);
  });

  it('does not reach into a container built before the files existed, and says why', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    await makeOld(w, site);
    w.core.security.updateSite(site, { level: 'strict' }, 'alice');
    await w.core.security.idle();
    const p = sitePaths(w.config, site.slug);
    expect(fs.existsSync(p.securityDir)).toBe(false);
    expect(fs.existsSync(p.securityApacheConf)).toBe(false);
    expect(w.core.security.siteStatus(w.deps.sites.bySlug(site.slug)).unprotected).toMatch(/built before protection reached inside it/);
  });
});

describe('the containers built before', () => {
  it('are rebuilt once each by a reconcile, which gives them the mounts', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    await makeOld(w, site);

    const sweep = await sweepHardening(w.core, w.worker);
    expect(sweep).toEqual({ queued: [site.slug], busy: [] });
    const job = w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).get()!;
    expect(await runJob(w, job.id)).toBe('succeeded');
    expect(lastSpec(w).labels[HARDENING_LABEL]).toBe(HARDENING_VERSION);
    expect(fs.existsSync(sitePaths(w.config, site.slug).securityWpPhp)).toBe(true);
    await w.core.security.kick(site.serverId);
    expect(w.core.security.siteStatus(w.deps.sites.bySlug(site.slug)).unprotected).toBeNull();

    expect(await sweepHardening(w.core, w.worker)).toEqual({ queued: [], busy: [] });
  });

  it('leave a busy site for later, and count a reconcile already waiting as queued', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    await makeOld(w, site);
    w.worker.enqueue('site.restart', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: site.serverId });
    expect(await sweepHardening(w.core, w.worker)).toEqual({ queued: [], busy: [site.slug] });

    w.db.delete(jobs).run();
    w.worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: site.serverId });
    expect(await sweepHardening(w.core, w.worker)).toEqual({ queued: [site.slug], busy: [] });
    expect(w.db.select().from(jobs).all()).toHaveLength(1);
  });

  it('are what the update hook rebuilds too', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    await makeOld(w, site);
    const hook = HOOKS.find((h) => h.title === 'Rebuild site containers with the protection mounts')!;
    expect(hook.version).toBe('0.2.0');
    const warnings: string[] = [];
    const job = { warn: (m: string) => warnings.push(m) } as unknown as Parameters<typeof hook.run>[0]['job'];
    expect(await hook.run({ job, services: w.core })).toBe('1 site(s) queued for reconcile');
    // Run again - the "Re-run post-update tasks" button - and nothing is queued twice.
    expect(await hook.run({ job, services: w.core })).toBe('1 site(s) queued for reconcile');
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all()).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
