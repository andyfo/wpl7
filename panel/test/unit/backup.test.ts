import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, sites, type SiteRow } from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { makeWorld, type TestWorld } from '../helpers.js';
import { sitePaths } from '../../src/services/siteSpec.js';

async function makeSite(w: TestWorld, slug = 'demo'): Promise<SiteRow> {
  const row = w.db
    .insert(sites)
    .values({
      slug,
      title: 'Demo',
      domains: JSON.stringify([`${slug}.dev.example.test`]),
      devHostname: `${slug}.dev.example.test`,
      phpVersion: '8.3',
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'pw',
      containerName: `wp-${slug}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .returning()
    .get();
  const p = sitePaths(w.config, slug);
  fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
  fs.mkdirSync(p.configDir, { recursive: true });
  fs.writeFileSync(path.join(p.wordpress, 'index.php'), '<?php // wp');
  fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9.1';");
  fs.writeFileSync(p.uploadsIni, 'upload_max_filesize = 64M');
  return row;
}

describe('BackupService', () => {
  it('creates a backup with dump, tar, manifest and checksums (real tar)', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const row = await w.core.backup.create(site, 'manual', { note: 'test' });

    expect(row.status).toBe('complete');
    expect(row.wpVersion).toBe('6.9.1');
    expect(row.sizeBytes!).toBeGreaterThan(0);
    for (const f of ['db.sql.gz', 'files.tar.gz', 'manifest.json', 'sha256sums']) {
      expect(fs.existsSync(path.join(row.path, f)), f).toBe(true);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(row.path, 'manifest.json'), 'utf8'));
    expect(manifest.slug).toBe('demo');
    expect(manifest.domains).toEqual(['demo.dev.example.test']);

    await expect(w.core.backup.verifyChecksums(row)).resolves.toBeUndefined();
    fs.appendFileSync(path.join(row.path, 'files.tar.gz'), 'corruption');
    await expect(w.core.backup.verifyChecksums(row)).rejects.toThrow(/Checksum mismatch/);
  });

  it('restoreFiles swaps in archive contents and keeps a safety copy', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const backup = await w.core.backup.create(site, 'manual', {});

    const p = sitePaths(w.config, site.slug);
    fs.writeFileSync(path.join(p.wordpress, 'index.php'), '<?php // MODIFIED after backup');
    const safety = await w.core.backup.restoreFiles(backup, site, () => undefined);

    expect(fs.readFileSync(path.join(p.wordpress, 'index.php'), 'utf8')).toBe('<?php // wp');
    expect(safety && fs.existsSync(safety)).toBe(true);
    expect(fs.readFileSync(path.join(safety!, 'index.php'), 'utf8')).toContain('MODIFIED');
  });

  it('prunes only scheduled backups beyond retention, never manual/final', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const mk = async (type: 'scheduled' | 'manual' | 'final') => {
      const row = await w.core.backup.create(site, type, {});
      // distinct timestamps for deterministic ordering
      await new Promise((r) => setTimeout(r, 5));
      return row;
    };
    const s1 = await mk('scheduled');
    const s2 = await mk('scheduled');
    const s3 = await mk('scheduled');
    const m1 = await mk('manual');
    const f1 = await mk('final');

    const removed = await w.core.backup.prune(2);
    expect(removed).toEqual({ deleted: 1, offsiteOnly: 0 });
    const remaining = w.db.select().from(backups).all().map((b) => b.id);
    expect(remaining).not.toContain(s1.id);
    expect(remaining).toEqual(expect.arrayContaining([s2.id, s3.id, m1.id, f1.id]));
    expect(fs.existsSync(s1.path)).toBe(false);
  });

  // What the Backups page tells an operator about a deleted site's backups: retention is per
  // slug and does not know the site is gone, so its scheduled ones are still thinned to the
  // newest N - but its final backup, like every other kind, stays.
  it("keeps applying retention to a deleted site's scheduled backups, never to its final one", async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const mk = async (type: 'scheduled' | 'final') => {
      const row = await w.core.backup.create(site, type, {});
      await new Promise((r) => setTimeout(r, 5));
      return row;
    };
    const s1 = await mk('scheduled');
    const s2 = await mk('scheduled');
    const s3 = await mk('scheduled');
    const f1 = await mk('final');
    w.db.delete(sites).where(eq(sites.id, site.id)).run();
    expect(w.db.select().from(backups).where(eq(backups.id, f1.id)).get()!.siteId).toBeNull();

    expect(await w.core.backup.prune(2)).toEqual({ deleted: 1, offsiteOnly: 0 });
    const remaining = w.db.select().from(backups).all().map((b) => b.id);
    expect(remaining).toEqual(expect.arrayContaining([s2.id, s3.id, f1.id]));
    expect(remaining).not.toContain(s1.id);
    // Down to the newest one, it still never touches the final backup.
    expect(await w.core.backup.prune(1)).toEqual({ deleted: 1, offsiteOnly: 0 });
    expect(w.db.select().from(backups).all().map((b) => b.id).sort()).toEqual([s3.id, f1.id].sort());
  });

  it('marks the row failed and removes the dir when the dump fails', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    w.dbAdmin.failOn.set('dumpTo', 'mariadb-dump failed (exit 1): access denied');
    await expect(w.core.backup.create(site, 'manual', {})).rejects.toThrow(/mariadb-dump failed/);
    const row = w.db.select().from(backups).where(eq(backups.siteSlug, 'demo')).get()!;
    expect(row.status).toBe('failed');
    expect(fs.existsSync(row.path)).toBe(false);
  });
});

describe('backup directory allocation', () => {
  // Regression: the timestamp has one-second resolution, so same-second backups used to
  // share a directory - deleting one then rm -rf'd the files the other row pointed at.
  it('gives same-second backups their own directory, and deleting one keeps the other intact', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);

    const a = await w.core.backup.create(site, 'manual', { note: 'first' });
    const b = await w.core.backup.create(site, 'manual', { note: 'second' });

    expect(b.path).not.toBe(a.path);
    expect(fs.existsSync(path.join(a.path, 'files.tar.gz'))).toBe(true);
    expect(fs.existsSync(path.join(b.path, 'files.tar.gz'))).toBe(true);

    await w.core.backup.deleteBackup(a);
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(path.join(b.path, 'files.tar.gz'))).toBe(true);
    expect(w.db.select().from(backups).all().map((r) => r.id)).toEqual([b.id]);
  });
});
