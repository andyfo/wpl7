import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backupCopies, backups, sites, type BackupRow, type SiteRow } from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { makeWorld, type TestWorld } from '../helpers.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { runHousekeeping } from '../../src/services/housekeeping.js';

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

describe('deleting backups by age', () => {
  const DAY = 24 * 3600_000;

  /** The backup, made `days` old. */
  function aged(w: TestWorld, row: BackupRow, days: number): BackupRow {
    return w.db.update(backups).set({ createdAt: Date.now() - days * DAY }).where(eq(backups.id, row.id)).returning().get();
  }

  async function backup(w: TestWorld, site: SiteRow, type: BackupRow['type'], days: number): Promise<BackupRow> {
    return aged(w, await w.core.backup.create(site, type, {}), days);
  }

  const remaining = (w: TestWorld) => w.db.select().from(backups).all().map((b) => b.id).sort((a, b) => a - b);
  const sorted = (rows: BackupRow[]) => rows.map((b) => b.id).sort((a, b) => a - b);

  it('deletes what is past its keep period, and never a manual or a final backup', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const expiring = [
      await backup(w, site, 'scheduled', 40),
      await backup(w, site, 'pre_update', 40),
      await backup(w, site, 'pre_restore', 40),
      await backup(w, site, 'move', 40),
      await backup(w, site, 'import', 40),
    ];
    const kept = [
      await backup(w, site, 'manual', 400),
      await backup(w, site, 'final', 400),
      await backup(w, site, 'pre_update', 29),
      await backup(w, site, 'scheduled', 1),
    ];

    expect(await w.core.backup.expire({ sites: 30, panel: 0 })).toEqual({ deleted: 5, offsiteOnly: 0 });
    expect(remaining(w)).toEqual(sorted(kept));
    for (const row of expiring) expect(fs.existsSync(row.path), row.type).toBe(false);
  });

  it('keeps the newest backup of each site and of the panel, however old', async () => {
    const w = await makeWorld({ exec: hostExec });
    // Stopped long ago: it takes no new backups, and must not lose its last one.
    const site = await makeSite(w);
    const older = await backup(w, site, 'scheduled', 90);
    const last = await backup(w, site, 'scheduled', 60);
    const panel = (days: number) =>
      w.db
        .insert(backups)
        .values({ siteSlug: 'panel', serverId: 1, type: 'panel', status: 'complete', path: path.join(w.config.paths.backups, 'panel', `p${days}`), rootPath: w.config.paths.backups, createdAt: Date.now() - days * DAY })
        .returning()
        .get();
    const panelOlder = panel(50);
    const panelLast = panel(40);
    // A failed one holds nothing, and is no backup to keep.
    w.db.update(backups).set({ status: 'failed' }).where(eq(backups.id, older.id)).run();

    expect(await w.core.backup.expire({ sites: 0, panel: 0 })).toEqual({ deleted: 0, offsiteOnly: 0 });
    expect(await w.core.backup.expire({ sites: 30, panel: 30 })).toEqual({ deleted: 2, offsiteOnly: 0 });
    expect(remaining(w)).toEqual(sorted([last, panelLast]));
    expect(remaining(w)).not.toContain(panelOlder.id);
  });

  it('keeps the newest backup that is staying, when a deletion already has the newest', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const older = await backup(w, site, 'scheduled', 50);
    const kept = await backup(w, site, 'scheduled', 40);
    const doomed = await backup(w, site, 'scheduled', 35);
    w.worker.enqueue('backup.delete', { backupIds: [doomed.id] }, undefined, { lane: 'backup-delete' });

    expect(await w.core.backup.expire({ sites: 30, panel: 0 })).toEqual({ deleted: 1, offsiteOnly: 0 });
    // The deletion takes the one it names; this run took the oldest, and left the one after it.
    expect(remaining(w)).toEqual(sorted([kept, doomed]));
    expect(remaining(w)).not.toContain(older.id);
  });

  it('follows a site’s own keep period, and the panel’s setting once the site is deleted', async () => {
    const w = await makeWorld({ exec: hostExec });
    const longer = await makeSite(w, 'longer');
    const never = await makeSite(w, 'never');
    const gone = await makeSite(w, 'gone');
    w.deps.sites.setBackupKeepDays('longer', 60);
    w.deps.sites.setBackupKeepDays('never', 0);

    const longerOld = await backup(w, longer, 'scheduled', 70);
    const longerKept = [await backup(w, longer, 'scheduled', 45), await backup(w, longer, 'scheduled', 1)];
    const neverKept = [await backup(w, never, 'pre_update', 400), await backup(w, never, 'scheduled', 1)];
    const goneOld = await backup(w, gone, 'scheduled', 45);
    const goneFinal = await backup(w, gone, 'final', 40);
    // Its own setting goes with the site: what is left follows the panel's.
    w.deps.sites.setBackupKeepDays('gone', 0);
    w.db.delete(sites).where(eq(sites.id, gone.id)).run();

    expect(await w.core.backup.expire({ sites: 30, panel: 0 })).toEqual({ deleted: 2, offsiteOnly: 0 });
    expect(remaining(w)).toEqual(sorted([...longerKept, ...neverKept, goneFinal]));
    expect(remaining(w)).not.toContain(longerOld.id);
    expect(remaining(w)).not.toContain(goneOld.id);
  });

  it('takes only the local files of one copied offsite, and waits for an upload still to come', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const dest = w.offsite.create({
      name: 'bucket',
      provider: 's3',
      config: { accessKeyId: 'AKIA', region: 'eu-central-1', bucket: 'b', prefix: 'panel.example.com' },
      secrets: { secretAccessKey: 'sekrit' },
    });
    const copied = await backup(w, site, 'scheduled', 40);
    const uploading = await backup(w, site, 'scheduled', 40);
    await backup(w, site, 'scheduled', 1);
    const copy = (row: BackupRow, status: 'complete' | 'pending') =>
      w.db.insert(backupCopies).values({ backupId: row.id, destinationId: dest.id, status, remotePath: `b/${row.id}`, createdAt: Date.now() }).run();
    copy(copied, 'complete');
    copy(uploading, 'pending');

    expect(await w.core.backup.expire({ sites: 30, panel: 0 })).toEqual({ deleted: 0, offsiteOnly: 1 });
    const row = (id: number) => w.db.select().from(backups).where(eq(backups.id, id)).get()!;
    expect(row(copied.id).filesPresent).toBe(0);
    expect(fs.existsSync(copied.path)).toBe(false);
    expect(row(uploading.id).filesPresent).toBe(1);
    // Offsite-only already: nothing more for it to do here.
    expect(await w.core.backup.expire({ sites: 30, panel: 0 })).toEqual({ deleted: 0, offsiteOnly: 0 });
  });

  it('runs in the nightly housekeeping, on the settings', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await makeSite(w);
    const old = await backup(w, site, 'pre_update', 20);
    await backup(w, site, 'scheduled', 1);
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };

    expect((await runHousekeeping(w.core, log)).oldBackupsDeleted).toBe(0);
    w.deps.settings.update({ backupKeepDays: 14 });
    expect((await runHousekeeping(w.core, log)).oldBackupsDeleted).toBe(1);
    expect(remaining(w)).not.toContain(old.id);
    expect(lines).toContain('Backup age: deleted 1 backup(s) older than their keep period');
  });
});
