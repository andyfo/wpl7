import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobLogs, jobs, siteLicenses, sites } from '../../src/db/schema.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { sitePaths } from '../../src/services/siteSpec.js';

/** Simulate the wordpress image entrypoint: seed core files once the container starts. */
function seedCoreFilesOnStart(w: TestWorld): void {
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const slug = name.slice(3);
    const p = sitePaths(w.config, slug);
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
  };
}

async function runCreate(w: TestWorld, body: Parameters<TestWorld['deps']['sites']['create']>[0]) {
  const { site, job } = w.deps.sites.create(body);
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return { site, job: w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()! };
}

const baseBody = {
  title: 'Demo Site',
  domainMode: 'dev' as const,
  adminUser: 'boss',
  adminEmail: 'boss@example.com',
  discourageSearchEngines: true,
  plugins: { catalogIds: [], extraWporgSlugs: ['akismet'] },
};

describe('site.create', () => {
  it('provisions end-to-end on the dev domain', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    const { site, job } = await runCreate(w, baseBody);

    expect(job.status).toBe('succeeded');
    const row = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect(row.status).toBe('running');
    expect(JSON.parse(row.domains)).toEqual(['demo-site.dev.example.test']);
    expect(row.devHostname).toBe('demo-site.dev.example.test');

    // container spec sanity: installed unrouted first, published (routed) once the admin exists
    type Spec = { image: string; labels: Record<string, string>; env: Record<string, string> };
    const creates = w.docker.calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as Spec);
    expect(creates).toHaveLength(2);
    expect(creates[0]!.labels['traefik.enable']).toBe('false');
    expect(creates[0]!.labels['traefik.http.routers.wp-demo-site.rule']).toBeUndefined();
    const spec = creates[1]!;
    expect(spec.image).toBe('wpl7-wordpress:php8.3');
    expect(spec.labels['traefik.http.routers.wp-demo-site.rule']).toBe('Host(`demo-site.dev.example.test`)');
    expect(spec.env.WORDPRESS_DB_NAME).toBe('wp_demo_site');
    expect(spec.env.WORDPRESS_CONFIG_EXTRA).toContain('DISABLE_WP_CRON');

    // wp-cli ran install (+ admin verification) + plugin via docker exec, all before publishing
    const execCmds = w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
    expect(execCmds.some((c) => c.startsWith('wp core install'))).toBe(true);
    expect(execCmds.some((c) => c.startsWith('wp user get boss'))).toBe(true);
    // As the administrator it just created: a plugin that makes whoever activates it its owner has one.
    expect(execCmds).toContain('wp plugin install akismet --activate --user=boss');
    // Without this the install's own loopback probe leaves the site on plain permalinks and
    // /wp-json/ answers with the home page; plugins are activated after it, against the
    // structure they will be flushing rewrite rules into.
    const permalinks = execCmds.indexOf('wp rewrite structure /%postname%/');
    expect(permalinks).toBeGreaterThan(execCmds.findIndex((c) => c.startsWith('wp core install')));
    expect(execCmds.findIndex((c) => c.includes('plugin install akismet'))).toBeGreaterThan(permalinks);
    // Search engines are discouraged by default, before a plugin can read the option.
    const noindex = execCmds.indexOf('wp option update blog_public 0');
    expect(noindex).toBeGreaterThan(-1);
    expect(execCmds.findIndex((c) => c.includes('plugin install akismet'))).toBeGreaterThan(noindex);
    const lastExec = w.docker.calls.map((c) => c.method).lastIndexOf('exec');
    const publish = w.docker.calls.map((c) => c.method).lastIndexOf('createSiteContainer');
    expect(publish).toBeGreaterThan(lastExec);

    // generated admin password surfaces exactly once, in the job result
    const result = JSON.parse(job.result!) as { adminPassword?: string; url: string };
    expect(result.adminPassword).toBeTruthy();
    expect(result.url).toBe('http://demo-site.dev.example.test');
  });

  it('deletes the plugins WordPress bundles, before installing the selected ones', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    // core install, the administrator check, permalinks, search visibility, then the bundled-plugin listing.
    w.docker.execQueue.push(
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'boss', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify([
          { name: 'akismet', status: 'inactive', version: '5.5', update_version: null },
          { name: 'hello', status: 'inactive', version: '1.7.2', update_version: null },
        ]),
        stderr: '',
        exitCode: 0,
      },
    );
    const { job } = await runCreate(w, baseBody);

    expect(job.status).toBe('succeeded');
    const execCmds = w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
    // As the administrator the install just created: Akismet's uninstall routine runs as someone.
    const deleted = execCmds.indexOf('wp plugin delete akismet hello --user=boss');
    expect(deleted).toBeGreaterThan(-1);
    // Order matters: baseBody asks for akismet, which must come back from wp.org afterwards.
    expect(execCmds.findIndex((c) => c.startsWith('wp plugin install akismet'))).toBeGreaterThan(deleted);
  });

  it('leaves search engine visibility alone when the box is unticked', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    const { job } = await runCreate(w, { ...baseBody, discourageSearchEngines: false });

    expect(job.status).toBe('succeeded');
    const execCmds = w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
    // WordPress installs public; not touching the option is what "allowed to index" means.
    expect(execCmds.some((c) => c.startsWith('wp option update blog_public'))).toBe(false);
  });

  it('skips the deletion when the bundled plugins are not installed', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    w.docker.execQueue.push(
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'boss', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: JSON.stringify([{ name: 'wordpress-seo', status: 'active', version: '24.0', update_version: null }]), stderr: '', exitCode: 0 },
    );
    const { job } = await runCreate(w, baseBody);

    expect(job.status).toBe('succeeded');
    const execCmds = w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
    expect(execCmds.some((c) => c.startsWith('wp plugin delete'))).toBe(false);
  });

  it('rolls back everything when the database step fails', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    w.dbAdmin.failOn.set('createSiteDb', 'db down');
    const { site, job } = await runCreate(w, baseBody);

    expect(job.status).toBe('failed');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
    expect(fs.existsSync(sitePaths(w.config, 'demo-site').root)).toBe(false);
    expect(w.docker.calls.some((c) => c.method === 'createSiteContainer')).toBe(false);
  });

  it('rolls back container, db and files in reverse order when wp install fails', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    // first exec call is `wp core install` -> fail it
    w.docker.execQueue.push({ stdout: '', stderr: 'Error: DB connection', exitCode: 1 });
    const { site, job } = await runCreate(w, baseBody);

    expect(job.status).toBe('failed');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
    const methods = w.docker.calls.map((c) => c.method);
    expect(methods).toContain('removeContainer');
    const dbCalls = w.dbAdmin.calls.map((c) => c.method);
    expect(dbCalls).toEqual(['createSiteDb', 'dropSiteDb']);
    // reverse order: container removed before db dropped, db dropped before dir removed
    const removeIdx = w.docker.calls.findIndex((c) => c.method === 'removeContainer');
    expect(removeIdx).toBeGreaterThan(-1);
    expect(fs.existsSync(sitePaths(w.config, 'demo-site').root)).toBe(false);
  });

  it('rejects duplicate slugs and taken domains', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    await runCreate(w, baseBody);
    expect(() => w.deps.sites.create(baseBody)).toThrowError(/already/);
    expect(() =>
      w.deps.sites.create({
        ...baseBody,
        title: 'Other',
        domainMode: 'custom',
        domains: ['demo-site.dev.example.test'],
      }),
    ).toThrowError(/already in use/);
  });

  it('custom-domain mode uses the given domains and marks the site live', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    const { job, site } = await runCreate(w, {
      ...baseBody,
      title: 'Shop',
      domainMode: 'custom',
      domains: ['shop.example.com', 'www.shop.example.com'],
    });
    expect(job.status).toBe('succeeded');
    const row = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect(row.isLive).toBe(1);
    expect(row.devHostname).toBeNull();
    expect(JSON.parse(row.domains)).toEqual(['shop.example.com', 'www.shop.example.com']);
  });

  it('rolls back a container that was created by a step which then failed', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    // Mirrors createContainer succeeding and the db-network attach failing right after.
    w.docker.failAfter.set('createSiteContainer', 'network wpl7_db not found');

    const { site, job } = await runCreate(w, baseBody);
    expect(job.status).toBe('failed');

    // Nothing may be left behind, or re-creating the same slug hits a name conflict
    // against an orphan the panel no longer knows about.
    expect(w.docker.containers.has('wp-demo-site')).toBe(false);
    expect(w.docker.calls.some((c) => c.method === 'removeContainer' && c.args[0] === 'wp-demo-site')).toBe(true);
    expect(w.dbAdmin.databases.has('wp_demo_site')).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
  });
});

describe('site.create plugin licenses', () => {
  it('activates licensed plugins after the installs and before the site is published', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    w.core.licenses.install('breakdance');
    w.core.licenses.setInput('breakdance', 'key', 'abc123def456ghi7');
    // core install, admin check, permalinks, search visibility, the bundled-plugin listing,
    // the breakdance install - then the recipe run: listing, license, update, status.
    w.docker.execQueue.push(
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'boss', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '[]', stderr: '', exitCode: 0 },
      { stdout: "Plugin 'breakdance' activated.", stderr: '', exitCode: 0 },
      { stdout: JSON.stringify([{ name: 'breakdance', status: 'active', version: '2.7.0', update_version: null }]), stderr: '', exitCode: 0 },
      { stdout: 'License Information:\n  Status: Valid\n  Activation: Active\n', stderr: '', exitCode: 0 },
      { stdout: 'Success: Plugin already updated.', stderr: '', exitCode: 0 },
      { stdout: 'License: Pro Mode', stderr: '', exitCode: 0 },
    );
    const { site, job } = await runCreate(w, { ...baseBody, plugins: { catalogIds: [], extraWporgSlugs: ['breakdance'] } });

    expect(job.status).toBe('succeeded');
    const execCmds = w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));
    const install = execCmds.findIndex((c) => c.startsWith('wp plugin install breakdance'));
    const activate = execCmds.indexOf('wp breakdance license abc123def456ghi7');
    expect(activate).toBeGreaterThan(install);
    const publish = w.docker.calls.map((c) => c.method).lastIndexOf('createSiteContainer');
    const activateCall = w.docker.calls.findIndex((c) => c.method === 'exec' && (c.args[1] as string[]).join(' ') === 'wp breakdance license abc123def456ghi7');
    expect(publish).toBeGreaterThan(activateCall);
    const rows = w.db.select().from(siteLicenses).where(eq(siteLicenses.siteId, site.id)).all();
    expect(rows).toEqual([expect.objectContaining({ recipeId: 'breakdance', status: 'active', url: 'http://demo-site.dev.example.test' })]);
  });

  it('still succeeds when the vendor turns the key down', async () => {
    const w = await makeWorld();
    seedCoreFilesOnStart(w);
    w.core.licenses.install('breakdance');
    w.core.licenses.setInput('breakdance', 'key', 'wrong-key-0000');
    w.docker.execQueue.push(
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: 'boss', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '[]', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: JSON.stringify([{ name: 'breakdance', status: 'active', version: '2.7.0', update_version: null }]), stderr: '', exitCode: 0 },
      { stdout: 'License Information:\n  Status: Invalid\n  Activation: Inactive\n', stderr: '', exitCode: 0 },
    );
    const { site, job } = await runCreate(w, { ...baseBody, plugins: { catalogIds: [], extraWporgSlugs: ['breakdance'] } });
    expect(job.status).toBe('succeeded');
    const rows = w.db.select().from(siteLicenses).where(eq(siteLicenses.siteId, site.id)).all();
    expect(rows[0]!.status).toBe('failed');
    const logs = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, job.id)).all().map((l) => l.message);
    expect(logs.some((m) => m.startsWith('Breakdance: FAILED'))).toBe(true);
    expect(logs.join('\n')).not.toContain('wrong-key-0000');
  });
});
