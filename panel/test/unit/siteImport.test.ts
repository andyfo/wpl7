import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { backups, imports, jobs, sites } from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { FORGET_MIGRATE_PLUGIN, makeRoomForStatements } from '../../src/jobs/handlers/import.js';
import type { JobContext } from '../../src/jobs/context.js';
import { makeWorld } from '../helpers.js';
import { BIG, CHOICES, PHOTO, connected, importRow, logOf, oldSiteTables, settle, wpCalls } from '../importWorld.js';

describe('importing a site', () => {
  it('pulls the old site and brings it up on its dev address', async () => {
    const { w, id, fake, dumps } = await connected();
    const { job } = w.core.imports.start(id, CHOICES);
    expect(job.lane).toBe('import:1');
    expect(job.siteId).toBeNull();
    const row = await settle(w, id);
    const pullLog = logOf(w, job.id);
    expect(row.status, [row.lastError, ...pullLog].join('\n')).toBe('done');

    const site = w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()!;
    expect(site).toMatchObject({ status: 'running', tablePrefix: 'wpx_', isLive: 0, devHostname: 'willow.dev.example.test' });
    const p = sitePaths(w.config, 'willow');
    // The files, as they were - and not what stays behind.
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-content', 'uploads', '2024', '01', 'photo.jpg')).equals(PHOTO)).toBe(true);
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-content', 'uploads', 'big.bin')).equals(BIG)).toBe(true);
    expect(fs.statSync(path.join(p.wordpress, 'wp-content', 'uploads', 'empty')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(p.wordpress, 'wp-content', 'object-cache.php'))).toBe(false);
    expect(fs.existsSync(path.join(p.wordpress, 'wp-content', 'shortcut'))).toBe(false);
    // wp-config.php is the image's, never the old host's.
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-config.php'), 'utf8')).toBe('<?php // written by the image');
    expect(fs.readFileSync(path.join(p.wordpress, '.htaccess'), 'utf8')).toContain('# BEGIN WordPress');

    // The database: checked lines, in the panel's own frame, imported as the site's own user.
    expect(w.dbAdmin.calls.find((c) => c.method === 'importFromAs')!.args.slice(1)).toEqual([site.dbName, site.dbUser, site.dbPassword]);
    expect(w.dbAdmin.calls.some((c) => c.method === 'importFrom')).toBe(false);
    const dump = dumps[0]!;
    expect(dump.startsWith('SET NAMES utf8mb4;\n')).toBe(true);
    expect(dump.trimEnd().endsWith('-- wpl7-import: end')).toBe(true);
    expect(dump).toContain("(2,'Willow\\'s; Pediatrics')");
    expect(dump).toContain("X'000102ff'");
    expect(dump).not.toContain('other_stats');
    // The longest statement is written down, for the database server's packet limit.
    expect(w.core.imports.cursorOf(row)!.longestStatement).toBe(Math.max(...dump.split('\n').map((l) => Buffer.byteLength(l))));

    // WordPress, set up for its new home.
    const wp = wpCalls(w, site.containerName);
    expect(wp).toContain('wp config set WP_MEMORY_LIMIT 256M --type=constant');
    expect(wp).toContain('wp config set WP_POST_REVISIONS 5 --type=constant --raw');
    expect(wp.some((c) => c.includes('DISALLOW_FILE_MODS'))).toBe(false);
    expect(wp).toContain(
      'wp search-replace https://willow-pediatrics.example http://willow.dev.example.test --all-tables --skip-columns=guid --report-changed-only --skip-plugins --skip-themes',
    );
    expect(wp).toContain(
      'wp search-replace /home/willow/public_html /var/www/html --all-tables --skip-columns=guid --report-changed-only --skip-plugins --skip-themes',
    );
    expect(wp).toContain('wp option update blog_public 0 --skip-plugins --skip-themes');
    // The migration plugin stays behind, its settings with it.
    expect(wp).toContain(`wp eval ${FORGET_MIGRATE_PLUGIN} --skip-plugins --skip-themes`);
    expect(wp.some((c) => c.startsWith('wp plugin deactivate redis-cache'))).toBe(true);

    // Published, backed up, scanned, cleaned up.
    const lastSpec = w.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!.args[0] as { labels: Record<string, string>; env: Record<string, string> };
    expect(lastSpec.labels['wpl7.routing']).toBe('public');
    expect(lastSpec.env.WORDPRESS_TABLE_PREFIX).toBe('wpx_');
    expect(w.db.select().from(backups).where(eq(backups.siteSlug, 'willow')).all().map((b) => b.type)).toEqual(['import']);
    const scan = w.db.select().from(jobs).where(eq(jobs.type, 'site.malwareScan')).get()!;
    expect(JSON.parse(scan.payload)).toMatchObject({ siteId: site.id, trigger: 'import' });
    expect(fs.existsSync(path.join(w.config.srvRoot, 'wpl7-import', String(id)))).toBe(false);
    expect(row).toMatchObject({ siteId: site.id, stagingPath: null });
    expect(row.importedAt).not.toBeNull();
    // Small files came many to a request.
    expect(fake.count('bundle')).toBeGreaterThan(0);
    expect(fake.count('bundle')).toBeLessThan(5);
  });

  it('reads a small file again in ranges when it grew past a bundle before it was read', async () => {
    const { w, id, fake } = await connected();
    const grown = Buffer.alloc(2 * 1024 * 1024, 7);
    fake.changeFile('index.php', grown);
    const { job } = w.core.imports.start(id, CHOICES);
    const row = await settle(w, id);
    expect(row.status, [row.lastError, ...logOf(w, job.id)].join('\n')).toBe('done');
    expect(fs.readFileSync(path.join(sitePaths(w.config, 'willow').wordpress, 'index.php')).equals(grown)).toBe(true);
    expect(w.core.imports.cursorOf(row)!.skipped.unreadable).toBe(0);
    expect(w.core.imports.cursorOf(row)!.filesDone).toBe(5);
  });

  it('says what the old site left out of its listing and its tables', async () => {
    const { w, id, fake } = await connected();
    fake.createComments = { wpx_posts: '/*!50100 PARTITION BY HASH (`ID`) */' };
    fake.snapshotWarnings = [
      { code: 'excluded', detail: 'wp-content/cache/**', count: 1200 },
      { code: 'link', count: 1 },
      { code: 'special', count: 2 },
    ];
    const { job } = w.core.imports.start(id, CHOICES);
    expect((await settle(w, id)).status).toBe('done');
    const log = logOf(w, job.id);
    expect(log).toContain('info: Left out, as always: wp-content/cache/** (1,200)');
    expect(log).toContain('warn: 2 special files (pipes, sockets, devices), not copied.');
    expect(log).toContain('warn: wpx_posts: copied without /*!50100 PARTITION BY HASH (`ID`) */ from its definition.');
    expect(log.filter((l) => l.includes('link'))).toEqual(['warn: 1 symbolic link was not copied.']);
  });

  it('goes on from where it stopped, in the files and in the database', async () => {
    const { w, id, fake, dumps } = await connected();
    fake.pageSize = 4;
    // The second page's big file never comes; then a page of a table never does.
    fake.failNext('range', ...Array<number>(8).fill(503));
    const { job } = w.core.imports.start(id, CHOICES);
    let row = await settle(w, id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/did not answer range after 8 attempts/);
    const stopped = w.core.imports.cursorOf(row)!;
    expect(stopped.phase).toBe('files');
    expect(stopped.filesAfterId).toBeGreaterThan(0);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()!.status).toBe('error');
    expect(logOf(w, job.id).join('\n')).toContain('Continue goes on from where it stopped.');

    // Continue: the listing is not asked for again, and the files go on after the last batch.
    const listings = fake.count('snapshot');
    fake.failNext('sql', ...Array<number>(8).fill(500));
    const seenAfter: number[] = [];
    fake.onRequest = (action, params) => {
      if (action === 'files') seenAfter.push(Number(params.after));
    };
    w.core.imports.retry(id);
    row = await settle(w, id);
    expect(row.status).toBe('failed');
    expect(w.core.imports.cursorOf(row)!.phase).toBe('db');
    expect(fake.count('snapshot')).toBe(listings);
    expect(seenAfter[0]).toBe(stopped.filesAfterId);

    fake.onRequest = null;
    w.core.imports.retry(id);
    row = await settle(w, id);
    expect(row.status, row.lastError ?? '').toBe('done');
    const p = sitePaths(w.config, 'willow');
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-content', 'uploads', 'big.bin')).equals(BIG)).toBe(true);
    // Every file counted once, though the batch that failed had started on some of them.
    expect(w.core.imports.cursorOf(row)!.filesDone).toBe(5);
    // Every row once: the half-written part of the dump was cut off before going on.
    const dump = dumps.at(-1)!;
    expect(dump.split("(2,'Willow\\'s; Pediatrics')").length).toBe(2);
    expect(dump.match(/DROP TABLE IF EXISTS `wpx_options`;/g)).toHaveLength(1);
  });

  it('stops when asked, and Continue resumes it', async () => {
    const { w, id, fake } = await connected();
    const { job } = w.core.imports.start(id, CHOICES);
    fake.onRequest = (action) => {
      if (action === 'tables') w.worker.cancel(job.id);
    };
    let row = await settle(w, id);
    expect(row).toMatchObject({ status: 'failed', lastError: 'Stopped' });
    expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe('canceled');
    // Stopped is not broken: the site is still being made.
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()!.status).toBe('provisioning');
    fake.onRequest = null;
    w.core.imports.retry(id);
    row = await settle(w, id);
    expect(row.status).toBe('done');
  });

  it('gives the name back when the pull is canceled before it started', async () => {
    const { w, id } = await connected();
    const { job } = w.core.imports.start(id, CHOICES);
    expect(w.worker.cancel(job.id)).toBe('canceled');
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()).toBeUndefined();
    expect(importRow(w, id)).toMatchObject({ status: 'connected', siteId: null, cursor: null });
    // And it can be started again.
    expect(w.core.imports.start(id, CHOICES).job.type).toBe('site.import');
  });

  it('gives up at once when the old site refuses the panel', async () => {
    const w = await makeWorld({ exec: hostExec });
    const { id, fake } = await connected({ world: w, fake: { token: 'a'.repeat(43) } });
    w.core.imports.start(id, CHOICES);
    const row = await settle(w, id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/refused the panel/);
    // No retries for a signature: the first answer said it all.
    expect(fake.count('ping')).toBe(1);
  });

  it('reads a file again that changed while it was read', async () => {
    const { w, id, fake } = await connected();
    const changed = Buffer.alloc(BIG.length + 100, 9);
    fake.changeFileAfter('wp-content/uploads/big.bin', 5, changed);
    fake.changeFile('wp-content/uploads/2024/01/photo.jpg', 'smaller now');
    w.core.imports.start(id, CHOICES);
    const row = await settle(w, id);
    expect(row.status, row.lastError ?? '').toBe('done');
    const p = sitePaths(w.config, 'willow');
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-content', 'uploads', 'big.bin')).equals(changed)).toBe(true);
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-content', 'uploads', '2024', '01', 'photo.jpg'), 'utf8')).toBe('smaller now');
  });

  it('puts the pulled copy back when setting the site up fails, and Continue sets it up', async () => {
    const { w, id } = await connected();
    w.docker.failAfter.set('createSiteContainer', 'network attach failed');
    w.core.imports.start(id, CHOICES);
    let row = await settle(w, id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/network attach failed/);
    const staging = path.join(w.config.srvRoot, 'wpl7-import', String(id));
    expect(fs.existsSync(path.join(staging, 'wordpress', 'index.php'))).toBe(true);
    expect(fs.existsSync(sitePaths(w.config, 'willow').root)).toBe(false);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'dropSiteDb').length).toBeGreaterThan(1);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()!.status).toBe('error');
    expect(w.core.imports.cursorOf(row)).toMatchObject({ phase: 'done', materialized: false });

    w.docker.failAfter.delete('createSiteContainer');
    const { job } = w.core.imports.retry(id);
    expect(job.type).toBe('site.importFinish');
    row = await settle(w, id);
    expect(row.status, row.lastError ?? '').toBe('done');
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()!.status).toBe('running');
  });

  it('keeps the site when the files cannot be moved back to staging', async () => {
    const { w, id } = await connected();
    w.docker.failAfter.set('createSiteContainer', 'network attach failed');
    const staging = path.join(w.config.srvRoot, 'wpl7-import', String(id), 'wordpress');
    const files = w.servers.handleFor(1).files;
    const rename = files.rename.bind(files);
    files.rename = async (from, to) => {
      if (to === staging) throw new Error('rename: Device or resource busy');
      return rename(from, to);
    };
    w.core.imports.start(id, CHOICES);
    const row = await settle(w, id);
    expect(row.status).toBe('failed');
    expect(w.core.imports.cursorOf(row)).toMatchObject({ phase: 'done', materialized: true });
    expect(logOf(w, row.jobId!)).toContain("warn: The files are still in the site's folder. Continue moves them back and tries the set-up again.");
    const wordpress = sitePaths(w.config, 'willow').wordpress;
    expect(fs.existsSync(path.join(wordpress, 'index.php'))).toBe(true);

    // Deleting the import leaves the site, and its name, to the site's own Delete.
    await w.core.imports.delete(id);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()).toMatchObject({ status: 'error' });
    expect(fs.existsSync(path.join(wordpress, 'index.php'))).toBe(true);
  });

  it('imports onto another server', async () => {
    const w = await makeWorld({ exec: hostExec });
    const s2 = w.addSshServer('s2', { real: true });
    const { id } = await connected({ world: w });
    s2.docker.onStart = (name) => {
      const config = path.join(s2.root!, 'sites', name.slice(3), 'wordpress', 'wp-config.php');
      if (name.startsWith('wp-') && !fs.existsSync(config)) fs.writeFileSync(config, '<?php // written by the image');
    };
    const { job } = w.core.imports.start(id, { ...CHOICES, serverId: s2.id });
    expect(job.lane).toBe(`import:${s2.id}`);
    const row = await settle(w, id);
    expect(row.status, row.lastError ?? '').toBe('done');
    expect(fs.readFileSync(path.join(s2.root!, 'sites', 'willow', 'wordpress', 'wp-content', 'uploads', 'big.bin')).equals(BIG)).toBe(true);
    expect(s2.dbAdmin.calls.some((c) => c.method === 'importFromAs')).toBe(true);
    expect(fs.existsSync(path.join(s2.root!, 'wpl7-import', String(id)))).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()!.serverId).toBe(s2.id);
  });

  it('refuses to start without the disk space for it', async () => {
    const { w, id, fake } = await connected();
    const files = w.servers.handleFor(1).files;
    files.statvfs = async () => ({ totalBytes: 10 * 1024 ** 3, freeBytes: 1024 });
    w.core.imports.start(id, CHOICES);
    const row = await settle(w, id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/Not enough free disk/);
    expect(fake.count('snapshot')).toBe(0);
  });

  it('refuses SQL outside the grammar, before it reaches the database', async () => {
    const tables = oldSiteTables();
    tables[0]!.create = tables[0]!.create.replace(') ENGINE', ') DEFINER=`root`@`%` ENGINE');
    const { w, id } = await connected({ fake: { tables } });
    w.core.imports.start(id, CHOICES);
    const row = await settle(w, id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/Refused SQL from the old site \(table wpx_options, line 2\): DEFINER/);
    expect(w.dbAdmin.calls.some((c) => c.method === 'importFromAs')).toBe(false);
  });

  it('gets past a host that blocks /wp-json/, alters binary bodies and keeps another time', async () => {
    const { w, id, fake } = await connected();
    fake.blockRest = true;
    fake.mangleRaw = true;
    fake.clockSkewS = 1800;
    w.core.imports.start(id, CHOICES);
    const row = await settle(w, id);
    expect(row.status, row.lastError ?? '').toBe('done');
    expect(w.core.imports.cursorOf(row)).toMatchObject({ transport: 'query', encoding: 'base64' });
    const p = sitePaths(w.config, 'willow');
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-content', 'uploads', 'big.bin')).equals(BIG)).toBe(true);
  });

  it('marks a pull the restart cut short as failed, resumable', async () => {
    const { w, id } = await connected();
    const { job } = w.core.imports.start(id, CHOICES);
    w.db.update(jobs).set({ status: 'failed', error: 'Interrupted by panel restart' }).where(eq(jobs.id, job.id)).run();
    w.db.update(imports).set({ status: 'pulling' }).where(eq(imports.id, id)).run();
    expect(w.core.imports.reconcileOnBoot()).toBe(1);
    expect(importRow(w, id)).toMatchObject({ status: 'failed', lastError: 'Interrupted by panel restart' });
    expect(w.core.imports.retry(id).job.type).toBe('site.import');
  });

  it('clears away imports that waited or failed too long', async () => {
    const { w, id } = await connected();
    w.core.imports.start(id, CHOICES);
    const staging = path.join(w.config.srvRoot, 'wpl7-import', String(id));
    fs.mkdirSync(path.join(staging, 'wordpress'), { recursive: true });
    w.db.update(imports).set({ status: 'failed', updatedAt: Date.now() - 8 * 24 * 3600_000 }).where(eq(imports.id, id)).run();
    const waiting = w.core.imports.create({ allowHttp: false }, 'admin');
    w.db.update(imports).set({ expiresAt: Date.now() - 1 }).where(eq(imports.id, waiting.id)).run();

    expect(await w.core.imports.prune()).toBe(2);
    expect(importRow(w, id)).toMatchObject({ status: 'expired', token: null });
    expect(fs.existsSync(staging)).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()).toBeUndefined();
    expect(importRow(w, waiting.id).status).toBe('expired');
    // A month on, the records go too.
    expect(await w.core.imports.prune(Date.now() + 31 * 24 * 3600_000)).toBe(2);
    expect(w.db.select().from(imports).all()).toHaveLength(0);
  });

  it('deletes a stopped import with what it left: staging, the reserved site, the plugin’s hold', async () => {
    const { w, id, fake } = await connected();
    fake.failNext('tables', ...Array<number>(8).fill(500));
    w.core.imports.start(id, CHOICES);
    const row = await settle(w, id);
    expect(row.status).toBe('failed');
    await w.core.imports.delete(id);
    expect(fake.finished).toBe(true);
    expect(fs.existsSync(path.join(w.config.srvRoot, 'wpl7-import', String(id)))).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()).toBeUndefined();
    expect(w.db.select().from(imports).where(eq(imports.id, id)).get()).toBeUndefined();
  });

  it('makes room on the database server for a statement longer than its packet limit', async () => {
    const w = await makeWorld();
    const lines: string[] = [];
    const ctx = { info: (m: string) => lines.push(m) } as unknown as JobContext<unknown>;
    const server = w.servers.handleFor(1);
    const MIB = 1024 * 1024;
    await makeRoomForStatements(ctx, server, 10 * MIB);
    expect(w.dbAdmin.calls.some((c) => c.method === 'raisePacketLimit')).toBe(false);
    await makeRoomForStatements(ctx, server, 20 * MIB);
    expect(w.dbAdmin.maxAllowedPacket).toBe(32 * MIB);
    await makeRoomForStatements(ctx, server, 20 * MIB);
    expect(lines).toEqual(['The database server now takes statements of up to 32 MB, for one of 20 MB, until it restarts.']);
  });

});
