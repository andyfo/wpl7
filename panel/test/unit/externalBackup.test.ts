import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { backups } from '../../src/db/schema.js';
import { makeApp } from '../helpers.js';
import { connectionRow, externalWorld, runJob, shopFiles, siteRow } from '../connectWorld.js';

/** Backups of a site hosted elsewhere: a copy kept up to date, and an ordinary backup packed from it. */

const tarList = (file: string) => execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();

/** True when a gzip file is one member: the last member's size field is the whole content's. */
const oneGzipMember = (buf: Buffer) => buf.readUInt32LE(buf.length - 4) === zlib.gunzipSync(buf).length % 2 ** 32;

async function backupOnce(w: Awaited<ReturnType<typeof externalWorld>>['w']) {
  const site = siteRow(w);
  const job = w.worker.enqueue('backup.create', { siteId: site.id, type: 'manual' }, { id: site.id, slug: site.slug });
  return runJob(w, job.id);
}

describe('backups of a site hosted elsewhere', () => {
  it('pulls the whole site the first time, and packs a backup a person can restore by hand', async () => {
    const { w, fake } = await externalWorld({ real: true });
    const { job, log, result } = await backupOnce(w);
    expect(job.status, log.join('\n')).toBe('succeeded');
    const row = w.db.select().from(backups).where(eq(backups.id, result!.backupId as number)).get()!;
    expect(row).toMatchObject({ siteSlug: 'shop', type: 'manual', status: 'complete', serverId: 1 });

    expect(tarList(path.join(row.path, 'files.tar.gz'))).toEqual([
      'wordpress/',
      'wordpress/index.php',
      'wordpress/wp-config.php',
      'wordpress/wp-content/',
      'wordpress/wp-content/plugins/',
      'wordpress/wp-content/plugins/akismet/',
      'wordpress/wp-content/plugins/akismet/akismet.php',
      'wordpress/wp-content/plugins/wpl7-connect/',
      'wordpress/wp-content/plugins/wpl7-connect/wpl7-connect.php',
      'wordpress/wp-content/uploads/',
      'wordpress/wp-content/uploads/2026/',
      'wordpress/wp-content/uploads/2026/10/',
      'wordpress/wp-content/uploads/2026/10/photo.jpg',
      'wordpress/wp-content/uploads/empty/',
      'wordpress/wp-includes/',
      'wordpress/wp-includes/version.php',
    ]);
    const gz = fs.readFileSync(path.join(row.path, 'db.sql.gz'));
    expect(oneGzipMember(gz)).toBe(true);
    const sql = zlib.gunzipSync(gz).toString('utf8');
    expect(sql.startsWith('SET NAMES utf8mb4;')).toBe(true);
    expect(sql).toContain('DROP TABLE IF EXISTS `wp_options`;');
    expect(sql).toContain("(2,'Shop\\'s; options')");
    expect(sql).toContain('INSERT INTO `wp_posts`');
    expect(sql).not.toContain('other_app_table');
    expect(sql.trimEnd().endsWith('-- wpl7-import: end')).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(row.path, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ format: 1, kind: 'external', home: 'https://shop.example.org', tablePrefix: 'wp_', consistency: 'paged', skipped: { rows: [], tables: ['other_app_table'] } });
    expect(fs.readFileSync(path.join(row.path, 'sha256sums'), 'utf8')).toMatch(/^[0-9a-f]{64} {2}db\.sql\.gz\n[0-9a-f]{64} {2}files\.tar\.gz\n$/);

    const site = siteRow(w);
    expect(site.diskBytes).toBeGreaterThan(150 * 1024);
    expect(connectionRow(w, site.id).lastBackupAt).toBeGreaterThan(0);
    expect(fake.count('snapshot')).toBeGreaterThan(0);
  });

  it('pulls only what changed the next time, and removes what the site deleted', async () => {
    const { w, fake } = await externalWorld({ real: true });
    await backupOnce(w);
    const mirror = w.core.externalBackups.mirrorOf({ slug: 'shop' }).wordpress;
    const before = { bundle: fake.count('bundle'), range: fake.count('range') };
    fake.writeFile('wp-content/uploads/new.txt', 'brand new');
    fake.writeFile('index.php', '<?php // changed');
    fake.deleteFile('wp-content/plugins/akismet/akismet.php');
    // Listed from when the last listing began (minus 5 minutes for clocks): the fake's files are
    // from 2023, so only the three changed ones count as changed.
    const { job, log, result } = await backupOnce(w);
    expect(job.status, log.join('\n')).toBe('succeeded');
    expect(fs.readFileSync(path.join(mirror, 'index.php'), 'utf8')).toBe('<?php // changed');
    expect(fs.readFileSync(path.join(mirror, 'wp-content/uploads/new.txt'), 'utf8')).toBe('brand new');
    expect(fs.existsSync(path.join(mirror, 'wp-content/plugins/akismet/akismet.php'))).toBe(false);
    // Its folder went with it; a folder the site still has, empty or not, stays.
    expect(fs.existsSync(path.join(mirror, 'wp-content/plugins/akismet'))).toBe(false);
    expect(fs.existsSync(path.join(mirror, 'wp-content/uploads/empty'))).toBe(true);
    // The photo was not read again.
    expect(fake.count('bundle') + fake.count('range') - before.bundle - before.range).toBeLessThanOrEqual(2);
    expect(log.join('\n')).toContain('Removed 1 file the site deleted since the last backup.');
    const row = w.db.select().from(backups).where(eq(backups.id, result!.backupId as number)).get()!;
    expect(tarList(path.join(row.path, 'files.tar.gz'))).toContain('wordpress/wp-content/uploads/new.txt');
    expect(tarList(path.join(row.path, 'files.tar.gz'))).not.toContain('wordpress/wp-content/plugins/akismet/akismet.php');
  });

  it('leaves no backup when a run fails, and keeps the last good listing', async () => {
    const { w, fake } = await externalWorld({ real: true });
    await backupOnce(w);
    const listedBefore = w.core.externalBackups.listings.read(siteRow(w).id);
    fake.failNext('sql', 403, 403);
    const { job } = await backupOnce(w);
    expect(job.status).toBe('failed');
    const rows = w.db.select().from(backups).all();
    expect(rows.map((r) => r.status)).toEqual(['complete', 'failed']);
    expect(fs.existsSync(rows[1]!.path)).toBe(false);
    expect(w.core.externalBackups.listings.read(siteRow(w).id)?.listedAt).toBe(listedBefore?.listedAt);
  });

  it('drops what a failed run pulled, once the site no longer has it', async () => {
    const { w, fake } = await externalWorld({ real: true });
    await backupOnce(w);
    const mirror = w.core.externalBackups.mirrorOf({ slug: 'shop' }).wordpress;
    // A run that pulls a new file and a changed one, then fails on the database.
    fake.writeFile('wp-content/uploads/added.txt', 'added');
    fake.writeFile('index.php', '<?php // changed in the run that failed');
    fake.failNext('sql', 403);
    expect((await backupOnce(w)).job.status).toBe('failed');
    expect(fs.readFileSync(path.join(mirror, 'wp-content/uploads/added.txt'), 'utf8')).toBe('added');
    // The site deletes both before the next backup, which no listing of a good backup ever named.
    fake.deleteFile('wp-content/uploads/added.txt');
    fake.deleteFile('index.php');
    const { job, log, result } = await backupOnce(w);
    expect(job.status, log.join('\n')).toBe('succeeded');
    expect(fs.existsSync(path.join(mirror, 'wp-content/uploads/added.txt'))).toBe(false);
    expect(fs.existsSync(path.join(mirror, 'index.php'))).toBe(false);
    expect(log).toContain('info: Removed 2 files the site deleted since the last backup.');
    const row = w.db.select().from(backups).where(eq(backups.id, result!.backupId as number)).get()!;
    const packed = tarList(path.join(row.path, 'files.tar.gz'));
    expect(packed).not.toContain('wordpress/wp-content/uploads/added.txt');
    expect(packed).not.toContain('wordpress/index.php');
    expect(packed).toContain('wordpress/wp-content/uploads/2026/10/photo.jpg');
  });

  it('copies again what a failed run changed in the copy, once the site has it back as it was', async () => {
    // A plugin's folder set aside for a new version, and put back after a backup failed: its
    // files come back with the times the last good backup listed, but the copy no longer has them.
    const plugin = 'wp-content/plugins/akismet';
    const { w, fake } = await externalWorld({ real: true, fake: { files: { ...shopFiles(), [`${plugin}/readme.txt`]: 'Akismet 5' } } });
    await backupOnce(w);
    const mirror = w.core.externalBackups.mirrorOf({ slug: 'shop' }).wordpress;
    for (const f of ['akismet.php', 'readme.txt']) fake.moveFile(`${plugin}/${f}`, `${plugin}.old/${f}`);
    fake.writeFile(`${plugin}/akismet.php`, '<?php /* Plugin Name: Akismet Anti-spam, version 6 */');
    fake.failNext('sql', 403);
    expect((await backupOnce(w)).job.status).toBe('failed');
    expect(fs.readFileSync(path.join(mirror, plugin, 'akismet.php'), 'utf8')).toContain('version 6');
    expect(fs.existsSync(path.join(mirror, plugin, 'readme.txt'))).toBe(false);

    fake.deleteFile(`${plugin}/akismet.php`);
    for (const f of ['akismet.php', 'readme.txt']) fake.moveFile(`${plugin}.old/${f}`, `${plugin}/${f}`);
    const { job, log, result } = await backupOnce(w);
    expect(job.status, log.join('\n')).toBe('succeeded');
    expect(fs.readFileSync(path.join(mirror, plugin, 'akismet.php'), 'utf8')).toBe(shopFiles()[`${plugin}/akismet.php`]);
    expect(fs.readFileSync(path.join(mirror, plugin, 'readme.txt'), 'utf8')).toBe('Akismet 5');
    expect(fs.existsSync(path.join(mirror, `${plugin}.old`))).toBe(false);
    const row = w.db.select().from(backups).where(eq(backups.id, result!.backupId as number)).get()!;
    const packed = tarList(path.join(row.path, 'files.tar.gz'));
    expect(packed).toContain(`wordpress/${plugin}/readme.txt`);
    expect(packed).not.toContain(`wordpress/${plugin}.old/akismet.php`);
  });

  it('puts the file the site has in place of a folder into the copy, instead of failing on it', async () => {
    const page = 'wp-content/cache/page';
    const { w, fake } = await externalWorld({ real: true, fake: { files: { ...shopFiles(), [`${page}/index.html`]: 'cached' } } });
    await backupOnce(w);
    fake.deleteFile(`${page}/index.html`);
    fake.writeFile(page, 'a file now');
    const { job, log, result } = await backupOnce(w);
    expect(job.status, log.join('\n')).toBe('succeeded');
    expect(log.join('\n')).not.toContain('Kept');
    const mirror = w.core.externalBackups.mirrorOf({ slug: 'shop' }).wordpress;
    expect(fs.readFileSync(path.join(mirror, page), 'utf8')).toBe('a file now');
    const row = w.db.select().from(backups).where(eq(backups.id, result!.backupId as number)).get()!;
    const packed = tarList(path.join(row.path, 'files.tar.gz'));
    expect(packed).toContain(`wordpress/${page}`);
    expect(packed).not.toContain(`wordpress/${page}/index.html`);
  });

  it('hands out the files and the database of a backup on their own', async () => {
    const { w } = await externalWorld({ real: true });
    const { result } = await backupOnce(w);
    const { app } = await makeApp(w);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    const headers = { cookie: `${c.name}=${c.value}` };
    const db = await app.inject({ method: 'GET', url: `/api/backups/${result!.backupId}/download?part=database`, headers });
    expect(db.statusCode).toBe(200);
    expect(db.headers['content-type']).toBe('application/gzip');
    expect(db.headers['content-disposition']).toMatch(/filename="shop-\d{8}-\d{6}-database\.sql\.gz"/);
    expect(zlib.gunzipSync(db.rawPayload).toString('utf8')).toContain('CREATE TABLE `wp_posts`');
    const files = await app.inject({ method: 'GET', url: `/api/backups/${result!.backupId}/download?part=files`, headers });
    expect(files.headers['content-disposition']).toMatch(/-files\.tar\.gz"/);
    expect(zlib.gunzipSync(files.rawPayload).length).toBeGreaterThan(150 * 1024);
    const restore = await app.inject({ method: 'POST', url: `/api/backups/${result!.backupId}/restore`, headers: { ...headers, 'x-csrf': '1' }, payload: {} });
    expect(restore.statusCode).toBe(409);
    expect(restore.json()).toMatchObject({ error: { message: 'Restore a site hosted elsewhere by hand: download its files and its database.' } });
  });
});
