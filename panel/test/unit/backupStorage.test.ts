import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { backups, jobLogs, servers, sites, type SiteRow } from '../../src/db/schema.js';
import { hostExec, type ExecPort, type ExecResult } from '../../src/lib/exec.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { StorageService, parseMounts } from '../../src/services/storage.js';
import { serverRelocateBackups } from '../../src/jobs/handlers/storage.js';
import { JobContext } from '../../src/jobs/context.js';
import { makeWorld, type TestWorld } from '../helpers.js';

function makeSite(w: TestWorld, slug = 'demo', serverId = 1): SiteRow {
  const row = w.db
    .insert(sites)
    .values({
      slug,
      serverId,
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
  fs.writeFileSync(path.join(p.wordpress, 'index.php'), '<?php // wp');
  fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9.1';");
  return row;
}

const setRoot = (w: TestWorld, serverId: number, root: string) => {
  fs.mkdirSync(root, { recursive: true });
  w.db.update(servers).set({ backupRoot: root, updatedAt: Date.now() }).where(eq(servers.id, serverId)).run();
  w.servers.invalidate(serverId);
};

const tmpRoot = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ceo-${name}-`));

describe('per-server backup locations', () => {
  it('creates backups under the server\'s own root and records it on the row', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const root = tmpRoot('root');
    setRoot(w, 1, root);

    const row = await w.core.backup.create(site, 'manual', {});
    expect(row.path.startsWith(root)).toBe(true);
    expect(row.rootPath).toBe(root);
    expect(fs.existsSync(path.join(row.path, 'files.tar.gz'))).toBe(true);
    // Not under the default root any more.
    expect(fs.existsSync(path.join(w.config.paths.backups, 'demo'))).toBe(false);
  });

  it('deletes a backup at its own recorded root, not at whatever the server uses now', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const oldRoot = tmpRoot('old');
    setRoot(w, 1, oldRoot);
    const row = await w.core.backup.create(site, 'manual', {});
    // The operator moves the location afterwards without relocating existing backups.
    setRoot(w, 1, tmpRoot('new'));

    await w.core.backup.deleteBackup(row);
    expect(fs.existsSync(row.path)).toBe(false);
    expect(w.db.select().from(backups).all()).toHaveLength(0);
  });

  it('refuses to touch the files of a row whose path and root disagree', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const row = await w.core.backup.create(site, 'manual', {});

    // A row doctored to point somewhere outside its own root is never rm -rf'd.
    const tampered = w.db
      .update(backups)
      .set({ path: '/srv/sites/demo/wordpress' })
      .where(eq(backups.id, row.id))
      .returning()
      .get();
    await expect(w.core.backup.deleteBackup(tampered)).rejects.toThrow(/not <root>\/<site>\/<timestamp>/);
    expect(w.db.select().from(backups).all()).toHaveLength(1);
  });

  it('refuses a row whose recorded root is not a legal backup location at all', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const row = await w.core.backup.create(site, 'manual', {});
    const tampered = w.db
      .update(backups)
      .set({ rootPath: '/', path: '/demo/20260101-000000' })
      .where(eq(backups.id, row.id))
      .returning()
      .get();
    await expect(w.core.backup.deleteBackup(tampered)).rejects.toThrow(/not a valid backup root/);
  });

  it('still deletes rows written before roots were selectable', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const row = await w.core.backup.create(site, 'manual', {});
    // Old rows have no root_path; it is recoverable from the fixed <root>/<slug>/<ts> layout.
    const legacy = w.db.update(backups).set({ rootPath: null }).where(eq(backups.id, row.id)).returning().get();

    await w.core.backup.deleteBackup(legacy);
    expect(fs.existsSync(row.path)).toBe(false);
    expect(w.db.select().from(backups).all()).toHaveLength(0);
  });
});

describe('storage discovery', () => {
  it('reports the current location, its disk and how much is stored there', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    await w.core.backup.create(site, 'manual', {});

    const dto = await w.core.storage.describe(1);
    expect(dto.backupRoot).toBe(w.config.paths.backups);
    expect(dto.isDefault).toBe(true);
    expect(dto.exists).toBe(true);
    expect(dto.writable).toBe(true);
    expect(dto.backups.count).toBe(1);
    expect(dto.backups.bytes).toBeGreaterThan(0);
    // Without a containerized panel there is no second path namespace to worry about.
    expect(dto.visibleInPanel).toBe(true);
  });

  it('rejects a candidate that would sit on live data, before asking the server anything', async () => {
    const w = await makeWorld({ exec: hostExec });
    const dto = await w.core.storage.describe(1, path.join(w.config.srvRoot, 'sites'));
    expect(dto.reason).toMatch(/live data/);
    expect(dto.discovered).toBe(false);
  });

  it('says a not-yet-existing candidate will be created rather than calling it broken', async () => {
    const w = await makeWorld({ exec: hostExec });
    const candidate = path.join(tmpRoot('cand'), 'not-there-yet');
    const dto = await w.core.storage.describe(1, candidate);
    expect(dto.exists).toBe(false);
    expect(dto.reason).toMatch(/will be created/);
  });

  it('setRoot creates the directory, probes it and stores it; empty goes back to the default', async () => {
    const w = await makeWorld({ exec: hostExec });
    const root = path.join(tmpRoot('set'), 'backups');

    await w.core.storage.setRoot(1, root);
    expect(fs.existsSync(root)).toBe(true);
    expect(w.servers.rowById(1)!.backupRoot).toBe(root);
    expect(w.core.storage.roots()[0]).toMatchObject({ serverId: 1, root, isDefault: false });

    await w.core.storage.setRoot(1, null);
    expect(w.servers.rowById(1)!.backupRoot).toBeNull();
    expect(w.core.storage.roots()[0]!.isDefault).toBe(true);
  });

  it('setRoot refuses a reserved location', async () => {
    const w = await makeWorld({ exec: hostExec });
    await expect(w.core.storage.setRoot(1, path.join(w.config.srvRoot, 'mysql'))).rejects.toThrow(/live data/);
    expect(w.servers.rowById(1)!.backupRoot).toBeNull();
  });
});

/**
 * The panel in its container: it can reach the host only over the read-only SSH hop, and a
 * path the host has that the container has not is the one location that looks fine and is
 * not. `needsSsh()` is what StorageService reads to know it is in that world.
 */
function containerizedHost(script: (cmd: string, args: string[]) => ExecResult): ExecPort & { needsSsh(): boolean } {
  const fail = () => Promise.reject(new Error('read-only'));
  return {
    needsSsh: () => true,
    run: async (cmd, args) => script(cmd, args),
    runWithInput: fail as never,
    runToStream: fail as never,
  };
}

const FINDMNT_ROOT_DISK = '/ /dev/sda1 ext4 40000000000 15000000000\n';

describe('storage discovery from inside the panel container', () => {
  const service = (w: TestWorld, hostExecPort: ExecPort) =>
    new StorageService(w.db, w.config, w.servers, w.core.backup, w.core.log, hostExecPort);

  it('says a path the container cannot write to is unmounted, and does not also promise to create it', async () => {
    const w = await makeWorld({ exec: hostExec });
    // The host has one disk, mounted at /. /backups is a directory on it that nobody has
    // created yet - which is exactly what clicking the root filesystem in the form suggests.
    const host = containerizedHost((cmd) => {
      if (cmd === 'stat') return { stdout: '', stderr: 'No such file or directory', exitCode: 1 };
      if (cmd === 'findmnt') return { stdout: FINDMNT_ROOT_DISK, stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 }; // the probe: not a directory here
    });

    const dto = await service(w, host).describe(1, '/backups');
    expect(dto.visibleInPanel).toBe(false);
    expect(dto.reason).toMatch(/not mounted into the panel container/);
    // The contradiction this replaced: "it will be created" next to "the panel cannot write there".
    expect(dto.reason).not.toMatch(/will be created/);
    expect(dto.mountInstructions).toEqual({
      envLine: 'BACKUP_ROOT=/backups',
      command: './provision/compose.sh up -d panel',
    });
  });

  it('names the disk by its mount point and the directory it would use separately', async () => {
    const w = await makeWorld({ exec: hostExec });
    const host = containerizedHost((cmd) => {
      if (cmd === 'stat') return { stdout: '', stderr: '', exitCode: 1 };
      if (cmd === 'findmnt') return { stdout: FINDMNT_ROOT_DISK, stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const dto = await service(w, host).describe(1);
    // One disk, mounted at "/" - the form labels the row with that, not with the path it
    // would put backups in. Both are in the DTO; only one of them is a filesystem.
    expect(dto.mounts).toHaveLength(1);
    expect(dto.mounts[0]).toMatchObject({ target: '/', source: '/dev/sda1', suggested: '/backups' });
  });

  it('a path the container really can write to is usable', async () => {
    const w = await makeWorld({ exec: hostExec });
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-shared-'));
    const stat = fs.statSync(shared);
    const host = containerizedHost((cmd, args) => {
      // Same device and inode on both sides: a real bind mount, not the container's own layer.
      if (cmd === 'stat') return { stdout: `${stat.dev} ${stat.ino}\n`, stderr: '', exitCode: 0 };
      if (cmd === 'findmnt') return { stdout: FINDMNT_ROOT_DISK, stderr: '', exitCode: 0 };
      if (args.join(' ').includes(shared)) return { stdout: 'exists\nwritable\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const dto = await service(w, host).describe(1, shared);
    expect(dto.visibleInPanel).toBe(true);
    expect(dto.mountInstructions).toBeNull();
    expect(dto.reason).toBeNull();
  });
});

describe('parseMounts', () => {
  it('keeps the mount point and derives the directory from it', () => {
    const mounts = parseMounts(
      ['/ /dev/sda1 ext4 40000000000 15000000000', '/mnt/data /dev/sdb1 xfs 900000000000 880000000000'].join('\n'),
    );
    expect(mounts.map((m) => [m.target, m.suggested])).toEqual([
      ['/mnt/data', '/mnt/data/backups'], // most free space first
      ['/', '/backups'],
    ]);
  });

  it('drops the pseudo-filesystems a backup could never live on', () => {
    const mounts = parseMounts(
      [
        '/proc proc proc 0 0',
        '/sys sysfs sysfs 0 0',
        '/run tmpfs tmpfs 800000000 790000000',
        '/var/lib/docker/overlay2/x overlay overlay 40000000000 15000000000',
        '/ /dev/sda1 ext4 40000000000 15000000000',
      ].join('\n'),
    );
    expect(mounts.map((m) => m.target)).toEqual(['/']);
  });
});

describe('server.relocateBackups', () => {
  afterEach(() => vi.restoreAllMocks());

  const runJob = async (w: TestWorld, payload: { serverId: number; to: string }) => {
    const job = w.worker.enqueue('server.relocateBackups', payload, undefined, { serverId: payload.serverId });
    const ctx = new JobContext(job.id, payload, w.db);
    await serverRelocateBackups(ctx as never, w.core);
    return ctx;
  };

  it('copies, verifies, removes the originals and repoints the rows', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const a = await w.core.backup.create(site, 'manual', { note: 'first' });
    const b = await w.core.backup.create(site, 'scheduled', {});
    const to = path.join(tmpRoot('relocate'), 'backups');

    const ctx = await runJob(w, { serverId: 1, to });
    expect(ctx.getResult()).toMatchObject({ moved: 2, skipped: 0, root: to });

    for (const row of w.db.select().from(backups).all()) {
      expect(row.rootPath).toBe(to);
      expect(row.path.startsWith(to)).toBe(true);
      expect(fs.existsSync(path.join(row.path, 'sha256sums'))).toBe(true);
      expect(fs.existsSync(path.join(row.path, 'files.tar.gz'))).toBe(true);
    }
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(b.path)).toBe(false);
    expect(w.servers.rowById(1)!.backupRoot).toBe(to);
  });

  it('skips a backup a job is using and still moves the rest', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const busy = await w.core.backup.create(site, 'manual', {});
    // A queued restore holds this site's backups; moving them under it would pull the
    // restore's input out from beneath it.
    w.worker.enqueue('backup.restore', { backupId: busy.id, skipPreRestoreBackup: true }, {
      id: site.id,
      slug: site.slug,
    });
    const to = path.join(tmpRoot('relocate-busy'), 'backups');

    const ctx = await runJob(w, { serverId: 1, to });
    expect(ctx.getResult()).toMatchObject({ moved: 0, skipped: 1 });
    expect(fs.existsSync(busy.path)).toBe(true);
    expect(w.db.select().from(backups).where(eq(backups.id, busy.id)).get()!.path).toBe(busy.path);
    // The location still changes, so new backups land in the right place and a re-run
    // finishes the job.
    expect(w.servers.rowById(1)!.backupRoot).toBe(to);
  });

  it('skips a backup it could not check, saying why, and still moves the rest', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const unchecked = await w.core.backup.create(site, 'manual', {});
    await w.core.backup.create(site, 'scheduled', {});
    // As a check that timed out on a server: before, this read as "files missing".
    const files = w.servers.handleFor(1).files;
    const real = files.exists.bind(files);
    const source = w.core.backup.backupDir(unchecked);
    vi.spyOn(files, 'exists').mockImplementation((p) =>
      p === source ? Promise.reject(new Error(`test -e ${p} failed (exit 124)`)) : real(p),
    );
    const to = path.join(tmpRoot('relocate-unchecked'), 'backups');

    const ctx = await runJob(w, { serverId: 1, to });
    expect(ctx.getResult()).toMatchObject({ moved: 1, skipped: 1, root: to });
    expect(fs.existsSync(unchecked.path)).toBe(true);
    expect(w.db.select().from(backups).where(eq(backups.id, unchecked.id)).get()!.path).toBe(unchecked.path);
    const warned = w.db.select().from(jobLogs).all().map((l) => l.message).join('\n');
    expect(warned).toMatch(/exit 124/);
    expect(warned).not.toMatch(/files missing/);
  });

  it('is re-runnable and a no-op once everything has arrived', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    await w.core.backup.create(site, 'manual', {});
    const to = path.join(tmpRoot('relocate-twice'), 'backups');

    await runJob(w, { serverId: 1, to });
    const ctx = await runJob(w, { serverId: 1, to });
    expect(ctx.getResult()).toBeNull(); // already there: returns before doing any work
  });
});
