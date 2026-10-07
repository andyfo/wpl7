import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { backups, jobs, sites } from '../../src/db/schema.js';
import { APPLY_CHANGED_FILES, REMOVE_UNCHANGED_SCRIPT } from '../../src/jobs/handlers/importRefresh.js';
import type { EphemeralOpts } from '../../src/services/docker.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { CHOICES, connected, logOf, settle, wpCalls } from '../importWorld.js';

/** A site imported from the fake old site, its plugin still connected. */
async function imported() {
  const world = await connected();
  world.w.core.imports.start(world.id, CHOICES);
  const row = await settle(world.w, world.id);
  expect(row.status, row.lastError ?? '').toBe('done');
  const site = world.w.db.select().from(sites).where(eq(sites.slug, 'willow')).get()!;
  return { ...world, site, wordpress: sitePaths(world.w.config, 'willow').wordpress };
}

const jobStatus = (w: Awaited<ReturnType<typeof imported>>['w'], id: number) => w.db.select().from(jobs).where(eq(jobs.id, id)).get()!.status;

describe('refreshing an imported site from the old site', () => {
  it('brings over what changed there, and removes what was deleted there', async () => {
    const { w, id, fake, dumps, site, wordpress } = await imported();
    // Since the import, on the old site: a file changed, an upload added, two deleted, a row added.
    fake.writeFile('index.php', '<?php // changed on the old site');
    fake.writeFile('wp-content/uploads/2026/10/new.jpg', 'a new upload');
    fake.deleteFile('wp-content/uploads/2024/01/photo.jpg');
    fake.deleteFile('wp-content/uploads/big.bin');
    fake.opts.tables[0]!.rows.push([6, 'a new row']);
    // On the new copy: one of the deleted files was changed here.
    fs.appendFileSync(path.join(wordpress, 'wp-content', 'uploads', 'big.bin'), 'changed here');
    const copied: number[] = [];
    const maintenance: boolean[] = [];
    fake.onRequest = (action, params) => {
      if (['files', 'range', 'bundle', 'tables', 'sql'].includes(action)) maintenance.push(fake.maintenance);
      if (action === 'bundle') copied.push(...(params.ids as number[]));
      if (action === 'range' && params.offset === 0) copied.push(Number(params.id));
    };

    const job = w.core.imports.refresh(id);
    expect(job).toMatchObject({ type: 'site.importRefresh', siteId: site.id, lane: null });
    await settle(w, id);
    const log = logOf(w, job.id);
    expect(jobStatus(w, job.id), log.join('\n')).toBe('succeeded');

    // Only the two new or changed files were copied, and brought in as the site's own user.
    expect(copied).toHaveLength(2);
    const apply = w.docker.calls.find((c) => c.method === 'runEphemeral' && (c.args[0] as EphemeralOpts).labels?.['wpl7.refresh'])!;
    expect(apply.args[0]).toMatchObject({ image: `wpl7-wordpress:php${site.phpVersion}`, user: '33:33', entrypoint: ['cp'], cmd: APPLY_CHANGED_FILES });
    expect((apply.args[0] as EphemeralOpts).binds).toContain(`${wordpress}:/var/www/html`);
    expect(fs.readFileSync(path.join(wordpress, 'index.php'), 'utf8')).toBe('<?php // changed on the old site');
    expect(fs.readFileSync(path.join(wordpress, 'wp-content', 'uploads', '2026', '10', 'new.jpg'), 'utf8')).toBe('a new upload');
    expect(fs.existsSync(path.join(wordpress, 'wp-content', 'uploads', '2024', '01', 'photo.jpg'))).toBe(false);
    expect(fs.readFileSync(path.join(wordpress, 'wp-content', 'uploads', 'big.bin'), 'utf8')).toMatch(/changed here$/);
    expect(log).toContain('info: Removed 1 file the old site deleted since the last pull.');
    expect(log).toContain('info: Kept 1 file the old site deleted: it was changed on this copy since.');
    // The new copy's own files stay its own.
    expect(fs.readFileSync(path.join(wordpress, 'wp-config.php'), 'utf8')).toBe('<?php // written by the image');
    expect(fs.existsSync(path.join(wordpress, 'wp-content', 'object-cache.php'))).toBe(false);

    // The database, whole and fresh, set up for the new address again.
    expect(dumps).toHaveLength(2);
    expect(dumps[1]).toContain("(6,'a new row')");
    const wp = wpCalls(w, site.containerName);
    expect(wp.filter((c) => c.startsWith('wp search-replace https://willow-pediatrics.example http://willow.dev.example.test'))).toHaveLength(2);
    expect(wp.filter((c) => c === 'wp option update blog_public 0 --skip-plugins --skip-themes')).toHaveLength(2);

    // The old site showed its maintenance page all the while, and not after.
    expect(maintenance.length).toBeGreaterThan(0);
    expect(maintenance.every(Boolean)).toBe(true);
    expect(fake.maintenance).toBe(false);
    expect(w.db.select().from(backups).where(eq(backups.siteSlug, 'willow')).all().map((b) => b.type)).toEqual(['import', 'pre_restore', 'import']);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('running');

    // A second refresh goes by the listing the first one wrote down: nothing left to remove.
    fake.onRequest = null;
    const again = w.core.imports.refresh(id);
    await settle(w, id);
    expect(jobStatus(w, again.id)).toBe('succeeded');
    expect(logOf(w, again.id).some((l) => l.includes('Removed'))).toBe(false);
  });

  it('copies what changed from when the last listing began, by the old site\'s clock', async () => {
    // The old site's clock is an hour behind the panel's.
    const world = await connected({ fake: {} });
    const { w, id, fake } = world;
    fake.clockSkewS = -3600;
    let listingBegan = 0;
    fake.onRequest = (action, params) => {
      if (action === 'snapshot' && params.op === 'start') listingBegan = Math.floor(Date.now() / 1000) + fake.clockSkewS;
    };
    w.core.imports.start(id, CHOICES);
    expect((await settle(w, id)).status).toBe('done');
    const sinces: unknown[] = [];
    fake.onRequest = (action, params) => {
      if (action === 'snapshot' && params.op === 'start') sinces.push(params.since);
    };
    // Written on the old site after the import, by its clock an hour earlier than the panel's.
    fake.writeFile('wp-content/uploads/after.txt', 'written after the import');
    const job = w.core.imports.refresh(id);
    await settle(w, id);
    expect(jobStatus(w, job.id), logOf(w, job.id).join('\n')).toBe('succeeded');
    expect(sinces).toHaveLength(1);
    expect(Math.abs((sinces[0] as number) - (listingBegan - 300))).toBeLessThanOrEqual(1);
    const wordpress = sitePaths(w.config, 'willow').wordpress;
    expect(fs.readFileSync(path.join(wordpress, 'wp-content', 'uploads', 'after.txt'), 'utf8')).toBe('written after the import');
  });

  it('leaves the site as it was when the old site stops answering before anything is replaced', async () => {
    const { w, id, fake, site, wordpress } = await imported();
    const before = fs.readFileSync(path.join(wordpress, 'index.php'), 'utf8');
    fake.writeFile('index.php', '<?php // changed on the old site');
    fake.failNext('sql', ...Array<number>(8).fill(500));

    const job = w.core.imports.refresh(id);
    await settle(w, id);
    const log = logOf(w, job.id);
    expect(jobStatus(w, job.id)).toBe('failed');
    expect(log.some((l) => l.includes('Putting the site back'))).toBe(false);
    expect(fs.readFileSync(path.join(wordpress, 'index.php'), 'utf8')).toBe(before);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'recreateDb')).toHaveLength(0);
    expect(fake.maintenance).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('running');
    // Still refreshable.
    expect(w.core.imports.get(id).status).toBe('done');
  });

  it('puts the safety backup back when it fails after replacing', async () => {
    const { w, id, fake, site, wordpress } = await imported();
    const before = fs.readFileSync(path.join(wordpress, 'index.php'), 'utf8');
    fake.writeFile('index.php', '<?php // changed on the old site');
    fake.deleteFile('wp-content/uploads/2024/01/photo.jpg');
    // Removing what the old site deleted fails, once the new files are in.
    const exec = w.docker.exec.bind(w.docker);
    w.docker.exec = async (name, cmd, opts) => {
      if (cmd[2] !== REMOVE_UNCHANGED_SCRIPT) return exec(name, cmd, opts);
      w.docker.exec = exec;
      return { stdout: '', stderr: 'rm: cannot remove: Read-only file system', exitCode: 1 };
    };

    const job = w.core.imports.refresh(id);
    await settle(w, id);
    const log = logOf(w, job.id);
    expect(jobStatus(w, job.id)).toBe('failed');
    expect(log).toContain('error: The refresh failed: Removing the files the old site deleted failed: rm: cannot remove: Read-only file system');
    expect(log, log.join('\n')).toContain('info: The site is back as it was.');
    expect(fs.readFileSync(path.join(wordpress, 'index.php'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(wordpress, 'wp-content', 'uploads', '2024', '01', 'photo.jpg'))).toBe(true);
    const safety = w.db.select().from(backups).where(eq(backups.type, 'pre_restore')).get()!;
    expect(w.dbAdmin.calls.find((c) => c.method === 'importFrom')!.args[0]).toBe(path.join(safety.path, 'db.sql.gz'));
    expect(fake.maintenance).toBe(false);
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()!.status).toBe('running');
  });

  it('is refused once the plugin is disconnected', async () => {
    const { w, id } = await imported();
    await w.core.imports.disconnect(id);
    expect(() => w.core.imports.refresh(id)).toThrow(/disconnected/);
    expect(fs.existsSync(path.join(w.config.paths.panel, 'imports', `${id}.files.gz`))).toBe(false);
  });
});
