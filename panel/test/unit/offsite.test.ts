import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  backupCopies,
  backupDestinations,
  backups,
  jobs,
  sites,
  type BackupDestinationRow,
  type BackupRow,
  type SiteRow,
} from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { JobContext } from '../../src/jobs/context.js';
import { panelSnapshot } from '../../src/jobs/handlers/offsite.js';
import type { EphemeralOpts, RunResult } from '../../src/services/docker.js';
import { sitePaths } from '../../src/services/siteSpec.js';
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

const addDestination = (w: TestWorld, patch: Partial<Parameters<TestWorld['offsite']['create']>[0]> = {}) =>
  w.offsite.create({
    name: 'bucket',
    provider: 's3',
    config: { accessKeyId: 'AKIA', region: 'eu-central-1', bucket: 'b', prefix: 'panel.example.com' },
    secrets: { secretAccessKey: 'sekrit' },
    ...patch,
  });

const copiesOf = (w: TestWorld, backupId: number) =>
  w.db.select().from(backupCopies).where(eq(backupCopies.backupId, backupId)).all();

/** The rclone invocations FakeDocker recorded, as argv arrays. */
const rcloneCalls = (w: TestWorld): { opts: EphemeralOpts; argv: string }[] =>
  w.docker.calls
    .filter((c) => c.method === 'runEphemeral')
    .map((c) => c.args[0] as EphemeralOpts)
    .filter((opts) => opts.image.startsWith('rclone/'))
    .map((opts) => ({ opts, argv: opts.cmd.join(' ') }));

describe('offsite reconciler', () => {
  it('creates one pending copy per eligible backup and enqueues one job per backup', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});

    const { created, enqueued } = w.offsite.tick();
    expect(created).toBe(1);
    expect(enqueued).toBe(1);
    expect(copiesOf(w, backup.id)[0]).toMatchObject({
      status: 'pending',
      remotePath: `b/panel.example.com/demo/${path.basename(backup.path)}`,
    });

    // Idempotent: a second tick neither duplicates the row nor the job.
    expect(w.offsite.tick()).toEqual({ created: 0, enqueued: 0 });
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'backup.offsite')).all()).toHaveLength(1);
  });

  it('honours the destination copy-type policy', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addDestination(w, { copyTypes: ['scheduled'] });
    const scheduled = await w.core.backup.create(site, 'scheduled', {});
    const preRestore = await w.core.backup.create(site, 'pre_restore', {});

    w.offsite.tick();
    expect(copiesOf(w, scheduled.id)).toHaveLength(1);
    expect(copiesOf(w, preRestore.id)).toHaveLength(0);
  });

  it('skips sites that opted out, and keeps copying a deleted site\'s final backup', async () => {
    const w = await makeWorld({ exec: hostExec });
    const optedOut = makeSite(w, 'quiet');
    const gone = makeSite(w, 'gone');
    addDestination(w);
    w.db.update(sites).set({ offsiteEnabled: 0 }).where(eq(sites.id, optedOut.id)).run();
    const skipped = await w.core.backup.create(optedOut, 'scheduled', {});
    const final = await w.core.backup.create(gone, 'final', {});
    // The site row goes; the backup row survives it, which is the whole point of a final.
    w.db.update(backups).set({ siteId: null }).where(eq(backups.id, final.id)).run();
    w.db.delete(sites).where(eq(sites.id, gone.id)).run();

    w.offsite.tick();
    expect(copiesOf(w, skipped.id)).toHaveLength(0);
    expect(copiesOf(w, final.id)).toHaveLength(1);
  });

  it('backfill "none" ignores what already exists; "all" reaches back', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const old = await w.core.backup.create(site, 'scheduled', {});
    w.db.update(backups).set({ createdAt: Date.now() - 86_400_000 }).where(eq(backups.id, old.id)).run();

    const none = addDestination(w, { name: 'later' });
    w.offsite.tick();
    expect(copiesOf(w, old.id)).toHaveLength(0);

    addDestination(w, { name: 'everything', backfill: 'all' });
    w.offsite.tick();
    expect(copiesOf(w, old.id).map((c) => c.destinationId)).not.toContain(none.id);
    expect(copiesOf(w, old.id)).toHaveLength(1);
  });

  it('leaves a backup on an unreachable server for the next tick', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addDestination(w);
    await w.core.backup.create(site, 'scheduled', {});
    w.servers.markUnreachable(1, new Error('down'));

    const { created, enqueued } = w.offsite.tick();
    expect(created).toBe(1); // the intent is recorded…
    expect(enqueued).toBe(0); // …but nothing is queued against a server that is not there
  });
});

describe('uploading', () => {
  const uploadWorld = async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick();
    return { w, site, dest, backup };
  };

  it('runs rclone in a throwaway container with the backup read-only and the secret in env', async () => {
    const { w, backup } = await uploadWorld();
    await w.offsite.uploadBackup(backup.id);

    const calls = rcloneCalls(w);
    expect(calls.map((c) => /exec rclone (\w+)/.exec(c.argv)?.[1])).toEqual(['copy', 'check', 'size']);
    const copy = calls[0]!;
    expect(copy.opts.image).toBe(w.config.rcloneImage);
    expect(copy.opts.entrypoint).toEqual(['/bin/sh']);
    expect(copy.opts.binds).toEqual([`${backup.path}:/data:ro`]);
    // No panel networks: the container needs the internet and nothing of ours.
    expect(copy.opts.networks).toEqual([]);
    expect(copy.opts.env).toContain('RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY=sekrit');
    // The secret is in the environment and nowhere else - argv is visible in `ps`.
    expect(copy.argv).not.toContain('sekrit');
    expect(copy.argv).toContain('DEST:b/panel.example.com/demo/');
    expect(copy.argv).toContain('--stats-one-line');
    // Verified, not merely uploaded.
    expect(calls[1]!.argv).toContain('check /data DEST:');
    expect(calls[1]!.argv).toContain('--one-way');
  });

  it('marks the copy complete and stamps the destination', async () => {
    const { w, dest, backup } = await uploadWorld();
    await w.offsite.uploadBackup(backup.id);

    const copy = copiesOf(w, backup.id)[0]!;
    expect(copy.status).toBe('complete');
    expect(copy.completedAt).toBeGreaterThan(0);
    expect(w.db.select().from(backupDestinations).where(eq(backupDestinations.id, dest.id)).get()!.lastSuccessAt)
      .toBeGreaterThan(0);
  });

  it('pulls the rclone image when the server has not got it', async () => {
    const { w, backup } = await uploadWorld();
    await w.offsite.uploadBackup(backup.id);
    expect(w.docker.calls.filter((c) => c.method === 'pullImage')).toHaveLength(1);
    w.docker.images.add(w.config.rcloneImage);
    w.offsite.requeue(backup);
    await w.offsite.uploadBackup(backup.id);
    expect(w.docker.calls.filter((c) => c.method === 'pullImage')).toHaveLength(1);
  });

  it('backs a failure off, then gives up and stops retrying', async () => {
    const { w, backup } = await uploadWorld();
    const fail = () => {
      w.docker.execQueue.push({ stdout: '', stderr: 'AccessDenied', exitCode: 1 });
    };
    const attempt = async () => {
      fail();
      await w.offsite.uploadBackup(backup.id).catch(() => undefined);
      const copy = copiesOf(w, backup.id)[0]!;
      // Re-arm: the reconciler would do this once nextAttemptAt came due.
      if (copy.nextAttemptAt !== null) {
        w.db.update(backupCopies).set({ nextAttemptAt: 1 }).where(eq(backupCopies.id, copy.id)).run();
      }
      return copy;
    };

    const first = await attempt();
    expect(first.status).toBe('failed');
    expect(first.attempts).toBe(1);
    expect(first.error).toContain('AccessDenied');
    expect(first.nextAttemptAt).toBeGreaterThan(Date.now());

    await attempt();
    const third = await attempt();
    expect(third.attempts).toBe(3);
    const fourth = await attempt();
    // Out of attempts: the row stays (the failures view shows it) but nothing retries it.
    expect(fourth.attempts).toBe(4);
    expect(fourth.nextAttemptAt).toBeNull();
    expect(w.offsite.tick().enqueued).toBe(0);
  });

  it('succeeds when one destination works and fails only when every one does', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addDestination(w, { name: 'good' });
    addDestination(w, { name: 'bad' });
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick();

    // First destination's three commands succeed, the second's copy fails.
    w.docker.execQueue.push(
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '{"bytes":10}', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'no route to host', exitCode: 1 },
    );
    const result = await w.offsite.uploadBackup(backup.id);
    expect(result).toEqual({ ok: 1, failed: 1 });
    expect(copiesOf(w, backup.id).map((c) => c.status).sort()).toEqual(['complete', 'failed']);

    // Both failing is a failed job: this backup is nowhere.
    w.offsite.requeue(backup);
    w.docker.execQueue.push({ stdout: '', stderr: 'x', exitCode: 1 }, { stdout: '', stderr: 'x', exitCode: 1 });
    await expect(w.offsite.uploadBackup(backup.id)).rejects.toThrow(/every destination/);
  });

  it('stops gracefully when the backup is deleted mid-flight', async () => {
    const { w, backup } = await uploadWorld();
    w.db.delete(backups).where(eq(backups.id, backup.id)).run();
    await expect(w.offsite.uploadBackup(backup.id)).resolves.toEqual({ ok: 0, failed: 0 });
  });
});

describe('crash recovery', () => {
  it('resets a copy left "uploading" by a restart, so the backup is not stuck forever', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick();
    const copy = copiesOf(w, backup.id)[0]!;
    // What a panel killed mid-transfer leaves behind: the job row is marked failed on the
    // next boot, the copy row is not - and `uploading` is neither retried nor deletable.
    w.db.update(backupCopies).set({ status: 'uploading' }).where(eq(backupCopies.id, copy.id)).run();
    w.db.update(jobs).set({ status: 'failed' }).where(eq(jobs.type, 'backup.offsite')).run();

    expect(() => w.core.backup.assertDeletable(backup)).toThrow(/being copied to a remote destination/);
    const { enqueued } = w.offsite.tick();
    expect(copiesOf(w, backup.id)[0]!.status).toBe('pending');
    expect(enqueued).toBe(1);
    expect(() => w.core.backup.assertDeletable(backup)).toThrow(/backup\.offsite/); // now it is the new job
  });

  it('leaves an upload that really is running alone', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick(); // enqueues a job that is still queued
    const copy = copiesOf(w, backup.id)[0]!;
    w.db.update(backupCopies).set({ status: 'uploading' }).where(eq(backupCopies.id, copy.id)).run();

    w.offsite.tick();
    expect(copiesOf(w, backup.id)[0]!.status).toBe('uploading');
  });
});

describe('retention and deletion', () => {
  const seedCompleteCopy = (w: TestWorld, backup: BackupRow, dest: BackupDestinationRow, at = Date.now()) =>
    w.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'complete',
        remotePath: `b/panel.example.com/${backup.siteSlug}/${path.basename(backup.path)}`,
        completedAt: at,
        createdAt: at,
      })
      .returning()
      .get();

  it('local pruning keeps a backup that exists offsite, as offsite-only', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const old = await w.core.backup.create(site, 'scheduled', {});
    await new Promise((r) => setTimeout(r, 5));
    await w.core.backup.create(site, 'scheduled', {});
    seedCompleteCopy(w, old, dest);

    expect(await w.core.backup.prune(1)).toEqual({ deleted: 0, offsiteOnly: 1 });
    const row = w.db.select().from(backups).where(eq(backups.id, old.id)).get()!;
    expect(row.filesPresent).toBe(0);
    expect(fs.existsSync(old.path)).toBe(false);
    // Still listed, still restorable after a fetch.
    expect(row.sizeBytes).toBeGreaterThan(0);
  });

  it('local pruning skips a backup whose upload has not happened yet', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addDestination(w);
    const old = await w.core.backup.create(site, 'scheduled', {});
    await new Promise((r) => setTimeout(r, 5));
    await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick(); // creates the pending rows

    expect(await w.core.backup.prune(1)).toEqual({ deleted: 0, offsiteOnly: 0 });
    expect(fs.existsSync(old.path)).toBe(true);
  });

  it('local pruning still deletes outright when nothing is offsite', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const old = await w.core.backup.create(site, 'scheduled', {});
    await new Promise((r) => setTimeout(r, 5));
    await w.core.backup.create(site, 'scheduled', {});

    expect(await w.core.backup.prune(1)).toEqual({ deleted: 1, offsiteOnly: 0 });
    expect(w.db.select().from(backups).all()).toHaveLength(1);
  });

  it('offsite retention purges the oldest extras, per site', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w, { retentionScheduled: 2 });
    const made: BackupRow[] = [];
    for (let i = 0; i < 4; i++) {
      made.push(await w.core.backup.create(site, 'scheduled', {}));
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const b of made) seedCompleteCopy(w, b, dest, b.createdAt);

    expect(await w.offsite.applyRetention()).toBe(2);
    const purges = rcloneCalls(w).filter((c) => c.argv.includes(' purge '));
    expect(purges).toHaveLength(2);
    // The two oldest go; the two newest stay.
    expect(purges.map((p) => p.argv)).toEqual(
      expect.arrayContaining([expect.stringContaining(path.basename(made[0]!.path))]),
    );
    const left = w.db.select().from(backupCopies).all();
    expect(left).toHaveLength(2);
    expect(left.map((c) => c.backupId).sort()).toEqual([made[2]!.id, made[3]!.id].sort());
  });

  it('never deletes anything at a destination whose provider owns retention', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w, { retentionScheduled: 1, retentionMode: 'external' });
    for (let i = 0; i < 3; i++) {
      seedCompleteCopy(w, await w.core.backup.create(site, 'scheduled', {}), dest);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await w.offsite.applyRetention()).toBe(0);
    expect(rcloneCalls(w).filter((c) => c.argv.includes(' purge '))).toHaveLength(0);
    expect(w.db.select().from(backupCopies).all()).toHaveLength(3);
  });

  it('refuses to delete a backup that is being uploaded right now', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    const copy = seedCompleteCopy(w, backup, dest);
    w.db.update(backupCopies).set({ status: 'uploading' }).where(eq(backupCopies.id, copy.id)).run();

    expect(() => w.core.backup.assertDeletable(backup)).toThrow(/being copied to a remote destination/);
  });

  it('refuses to delete a backup an offsite job is queued for', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick();
    // The job carries no siteId (its lane is its own), so only the payload identifies it.
    expect(() => w.core.backup.assertDeletable(backup)).toThrow(/backup\.offsite/);
  });

  it('purging a destination removes only the paths this panel wrote', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    const copy = seedCompleteCopy(w, backup, dest);

    await w.offsite.purgeCopies([copy]);
    const purge = rcloneCalls(w).find((c) => c.argv.includes(' purge '))!;
    expect(purge.argv).toContain(`DEST:${copy.remotePath}`);
    // Never the prefix itself: another panel may share the bucket.
    expect(purge.argv).not.toMatch(/purge DEST:b\/panel\.example\.com'?$/);
    expect(w.db.select().from(backupCopies).all()).toHaveLength(0);
  });

  it('dropEmptyBackups removes rows with no files and no copies left', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    const copy = seedCompleteCopy(w, backup, dest);
    await w.core.backup.removeLocalFiles(backup);

    expect(w.offsite.dropEmptyBackups()).toBe(0); // still has a copy
    await w.offsite.purgeCopies([copy]);
    expect(w.offsite.dropEmptyBackups()).toBe(1);
    expect(w.db.select().from(backups).all()).toHaveLength(0);
  });
});

describe('fetching back', () => {
  /** Make rclone's `copy` put the saved remote contents into whatever it binds at /data. */
  const fakeRemote = (w: TestWorld, remoteDir: string) => {
    const real = w.docker.runEphemeral.bind(w.docker);
    w.docker.runEphemeral = async (opts: EphemeralOpts): Promise<RunResult> => {
      const res = await real(opts);
      if (opts.cmd.join(' ').includes('rclone copy DEST:')) {
        const target = opts.binds![0]!.split(':')[0]!;
        fs.cpSync(remoteDir, target, { recursive: true });
      }
      return res;
    };
  };

  it('restores the files, verifies the checksums and flips the row back', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});

    // Stand in for the bucket, then let local retention turn this into an offsite-only row.
    const remote = fs.mkdtempSync(path.join(w.config.srvRoot, 'remote-'));
    fs.cpSync(backup.path, remote, { recursive: true });
    w.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'complete',
        remotePath: `b/panel.example.com/demo/${path.basename(backup.path)}`,
        createdAt: Date.now(),
      })
      .run();
    await w.core.backup.removeLocalFiles(backup);
    expect(fs.existsSync(backup.path)).toBe(false);

    fakeRemote(w, remote);
    const row = await w.offsite.fetchBackup(backup.id, dest.id);
    expect(row.filesPresent).toBe(1);
    expect(fs.existsSync(path.join(row.path, 'files.tar.gz'))).toBe(true);
    expect(fs.existsSync(path.join(row.path, 'manifest.json'))).toBe(true);
  });

  it('refuses a fetch whose checksums do not match, and leaves nothing behind', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    const remote = fs.mkdtempSync(path.join(w.config.srvRoot, 'remote-'));
    fs.cpSync(backup.path, remote, { recursive: true });
    fs.appendFileSync(path.join(remote, 'files.tar.gz'), 'corruption');
    w.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'complete',
        remotePath: 'b/panel.example.com/demo/x',
        createdAt: Date.now(),
      })
      .run();
    await w.core.backup.removeLocalFiles(backup);

    fakeRemote(w, remote);
    await expect(w.offsite.fetchBackup(backup.id, dest.id)).rejects.toThrow(/Checksum verification failed/);
    expect(w.db.select().from(backups).where(eq(backups.id, backup.id)).get()!.filesPresent).toBe(0);
    expect(fs.existsSync(backup.path)).toBe(false);
  });

  it('a failed fetch leaves whatever was already there untouched', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    const before = fs.readFileSync(path.join(backup.path, 'sha256sums'), 'utf8');
    w.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'complete',
        remotePath: 'b/panel.example.com/demo/x',
        createdAt: Date.now(),
      })
      .run();

    // The download itself fails: nothing is swapped in, and the staging directory goes.
    w.docker.execQueue.push({ stdout: '', stderr: 'connection reset', exitCode: 1 });
    await expect(w.offsite.fetchBackup(backup.id, dest.id)).rejects.toThrow(/connection reset/);
    expect(fs.readFileSync(path.join(backup.path, 'sha256sums'), 'utf8')).toBe(before);
    expect(fs.existsSync(`${backup.path}.fetching`)).toBe(false);
  });

  it('fetches onto the server the site runs on today, lifting the cross-server limit', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    const remote = fs.mkdtempSync(path.join(w.config.srvRoot, 'remote-'));
    fs.cpSync(backup.path, remote, { recursive: true });
    w.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'complete',
        remotePath: 'b/panel.example.com/demo/x',
        createdAt: Date.now(),
      })
      .run();
    await w.core.backup.removeLocalFiles(backup);

    // The site moved to a second server after the backup was taken.
    const s2 = w.addSshServer('s2');
    w.db.update(sites).set({ serverId: s2.id }).where(eq(sites.id, site.id)).run();
    const real = s2.docker.runEphemeral.bind(s2.docker);
    s2.docker.runEphemeral = async (opts: EphemeralOpts): Promise<RunResult> => {
      const res = await real(opts);
      if (opts.cmd.join(' ').includes('rclone copy DEST:')) {
        fs.cpSync(remote, opts.binds![0]!.split(':')[0]!, { recursive: true });
      }
      return res;
    };

    const row = await w.offsite.fetchBackup(backup.id, dest.id);
    expect(row.serverId).toBe(s2.id);
    expect(row.filesPresent).toBe(1);
  });
});

describe('alerts', () => {
  it('emails the operator once a day when copies have given up', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'failed',
        remotePath: 'b/x',
        attempts: 4,
        nextAttemptAt: null,
        error: 'AccessDenied',
        createdAt: Date.now(),
      })
      .run();
    const notify = vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);

    await w.offsite.alertOnFailures();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain('bucket');
    expect(notify.mock.calls[0]![1]).toContain('demo');

    // Same failure tomorrow morning: still one mail today.
    await w.offsite.alertOnFailures();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('says nothing while retries are still pending', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'failed',
        remotePath: 'b/x',
        attempts: 1,
        nextAttemptAt: Date.now() + 600_000,
        createdAt: Date.now(),
      })
      .run();
    const notify = vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);
    await w.offsite.alertOnFailures();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('connection test', () => {
  it('reports each probe step and treats a refused delete as an append-only key', async () => {
    const w = await makeWorld({ exec: hostExec });
    w.docker.execQueue.push({
      stdout: [
        'CEOCHECK list ok  -1 2026-09-20 03:00:00 shop',
        'CEOCHECK write ok wrote .ceo-probe-abc',
        'CEOCHECK delete fail AccessDenied: not authorized to perform DeleteObject',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });
    const res = await w.offsite.test({
      name: 'locked-bucket',
      provider: 's3',
      config: { accessKeyId: 'A', region: 'r', bucket: 'b', prefix: 'p' },
      secrets: { secretAccessKey: 's' },
    });
    expect(res.ok).toBe(true);
    expect(res.checks.find((c) => c.name === 'write')!.ok).toBe(true);
    const del = res.checks.find((c) => c.name === 'delete')!;
    expect(del.ok).toBe(true);
    expect(del.detail).toMatch(/append-only/);
  });

  it('fails a configuration that is not complete, without touching the network', async () => {
    const w = await makeWorld({ exec: hostExec });
    const res = await w.offsite.test({ name: 'x', provider: 's3', config: { bucket: 'b' }, secrets: {} });
    expect(res.ok).toBe(false);
    expect(res.checks[0]!.name).toBe('configuration');
    expect(rcloneCalls(w)).toHaveLength(0);
  });
});

describe('the panel\'s own state', () => {
  it('snapshots panel.db, checksums it, and makes it eligible for the same offsite copies', async () => {
    const w = await makeWorld({ exec: hostExec });
    addDestination(w);
    const job = w.worker.enqueue('panel.snapshot', {}, undefined, { serverId: 1 });
    const ctx = new JobContext(job.id, {}, w.db);
    await panelSnapshot(ctx as never, w.core);

    const row = w.db.select().from(backups).where(eq(backups.type, 'panel')).get()!;
    expect(row).toMatchObject({ status: 'complete', siteSlug: 'panel', siteId: null });
    expect(fs.existsSync(path.join(row.path, 'panel.db.gz'))).toBe(true);
    expect(fs.existsSync(path.join(row.path, 'manifest.json'))).toBe(true);
    // The file holds every credential the panel has; it is not world-readable.
    expect(fs.statSync(path.join(row.path, 'panel.db.gz')).mode & 0o077).toBe(0);
    // Checksummed like any other backup, so a fetched copy can be verified.
    const sums = fs.readFileSync(path.join(row.path, 'sha256sums'), 'utf8');
    expect(sums.trim().endsWith('panel.db.gz')).toBe(true);

    // The default policy copies it, which is what makes a fleet recoverable from a bucket.
    w.offsite.tick();
    expect(copiesOf(w, row.id)).toHaveLength(1);
  });

  it('is pruned by the same retention as scheduled backups', async () => {
    const w = await makeWorld({ exec: hostExec });
    for (let i = 0; i < 3; i++) {
      const job = w.worker.enqueue('panel.snapshot', {}, undefined, { serverId: 1 });
      await panelSnapshot(new JobContext(job.id, {}, w.db) as never, w.core);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await w.core.backup.prune(2)).toEqual({ deleted: 1, offsiteOnly: 0 });
    expect(w.db.select().from(backups).where(eq(backups.type, 'panel')).all()).toHaveLength(2);
  });
});

describe('encryption', () => {
  const encrypted = (w: TestWorld, patch = {}) =>
    addDestination(w, { name: 'vault', encryption: 'crypt', ...patch });

  it('is off unless asked for', async () => {
    const w = await makeWorld({ exec: hostExec });
    const dest = addDestination(w);
    expect(dest.encryption).toBe('none');
    expect(dest.cryptPassword).toBeNull();
  });

  it('mints a passphrase and salt, and both are needed', async () => {
    const w = await makeWorld({ exec: hostExec });
    const dest = encrypted(w);
    expect(dest.encryption).toBe('crypt');
    expect(dest.cryptPassword!.length).toBeGreaterThan(20);
    expect(dest.cryptSalt!.length).toBeGreaterThan(20);
    expect(dest.cryptSalt).not.toBe(dest.cryptPassword);
    // rclone treats the salt as a second password, so it is revealed with equal weight.
    expect(w.offsite.revealCrypt(dest.id)).toEqual({
      password: dest.cryptPassword,
      salt: dest.cryptSalt,
    });
  });

  it('adopts an existing passphrase, which is how a bucket is read after losing panel.db', async () => {
    const w = await makeWorld({ exec: hostExec });
    const dest = encrypted(w, { cryptPassword: 'old-passphrase-from-the-password-manager', cryptSalt: 'old-salt-value' });
    expect(dest.cryptPassword).toBe('old-passphrase-from-the-password-manager');
    expect(dest.cryptSalt).toBe('old-salt-value');
  });

  it('refuses half a passphrase', async () => {
    const w = await makeWorld({ exec: hostExec });
    expect(() => encrypted(w, { cryptPassword: 'only-the-password' })).toThrow(/both halves/);
  });

  it('wraps the remote in rclone crypt and verifies with cryptcheck', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = encrypted(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick();
    await w.offsite.uploadBackup(backup.id);

    const calls = rcloneCalls(w);
    const env = Object.fromEntries(
      calls[0]!.opts.env!.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    // The crypt remote is anchored AT bucket/prefix: an S3 bucket name has to stay literal,
    // and the prefix is how two panels share one bucket.
    expect(env.RCLONE_CONFIG_CRYPT_TYPE).toBe('crypt');
    expect(env.RCLONE_CONFIG_CRYPT_REMOTE).toBe('DEST:b/panel.example.com');
    expect(env.RCLONE_CONFIG_CRYPT_FILENAME_ENCRYPTION).toBe('standard');
    // Site names and timestamps are below the crypt root, so they are ciphertext too.
    expect(calls[0]!.argv).toContain(`CRYPT:demo/${path.basename(backup.path)}`);
    expect(calls[0]!.argv).not.toContain('DEST:b/panel.example.com/demo');

    // `check` cannot compare hashes against a crypt remote - rclone stores none - so it
    // would quietly degrade to a size comparison. `cryptcheck` hashes the encrypted form.
    expect(/exec rclone (\w+)/.exec(calls[1]!.argv)?.[1]).toBe('cryptcheck');
  });

  it('never puts the passphrase on the command line', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = encrypted(w, { cryptPassword: 'sentinel-passphrase-abcdef', cryptSalt: 'sentinel-salt-123456' });
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick();
    await w.offsite.uploadBackup(backup.id);

    for (const call of rcloneCalls(w)) {
      expect(call.argv).not.toContain('sentinel-passphrase-abcdef');
      expect(call.argv).not.toContain('sentinel-salt-123456');
      // It rides in as its own variable and rclone obscures it in the prelude.
      expect(call.opts.env).toContain('WPL7_CRYPT_PASSWORD=sentinel-passphrase-abcdef');
      expect(call.argv).toContain('rclone obscure "$WPL7_CRYPT_PASSWORD"');
    }
    void dest;
  });

  it('keeps the passphrase out of job logs and stored errors, even when rclone echoes it', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = encrypted(w, { cryptPassword: 'sentinel-passphrase-abcdef', cryptSalt: 'sentinel-salt-123456' });
    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick();

    // rclone's "obscured" form is reversible - its own docs call it eyedropping protection,
    // not encryption - so a credential quoted back in a diagnostic is a credential leaked.
    w.docker.execQueue.push({
      stdout: '',
      stderr: 'Failed to create file system for "CRYPT:": password sentinel-passphrase-abcdef rejected',
      exitCode: 1,
    });
    const lines: string[] = [];
    await w.offsite
      .uploadBackup(backup.id, { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) })
      .catch(() => undefined);

    expect(lines.join('\n')).not.toContain('sentinel-passphrase-abcdef');
    expect(lines.join('\n')).toContain('••••••');
    const stored = copiesOf(w, backup.id)[0]!;
    expect(stored.error).not.toContain('sentinel-passphrase-abcdef');
    const destRow = w.db.select().from(backupDestinations).where(eq(backupDestinations.id, dest.id)).get()!;
    expect(destRow.lastError).not.toContain('sentinel-passphrase-abcdef');
  });

  it('cannot be switched once the destination holds a backup — rclone has no rekey', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = addDestination(w);
    // Free to change while nothing has been written.
    expect(w.offsite.update(dest.id, { encryption: 'crypt' }).encryption).toBe('crypt');

    const backup = await w.core.backup.create(site, 'scheduled', {});
    w.offsite.tick();
    await w.offsite.uploadBackup(backup.id);
    // With content in place there is no way back: rclone cannot re-key encrypted content,
    // and the names themselves are derived from the passphrase.
    expect(() => w.offsite.update(dest.id, { encryption: 'none' })).toThrow(/already holds backups/);
    expect(w.offsite.byId(dest.id).encryption).toBe('crypt');
  });

  it('leaves the passphrase alone on an ordinary edit', async () => {
    const w = await makeWorld({ exec: hostExec });
    const dest = encrypted(w);
    const before = w.offsite.revealCrypt(dest.id);
    w.offsite.update(dest.id, { retentionScheduled: 90, cryptPassword: 'try-to-change-me', cryptSalt: 'and-this' });
    expect(w.offsite.revealCrypt(dest.id)).toEqual(before);
  });

  it('fetches an encrypted backup back through the crypt remote', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = encrypted(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    const remote = fs.mkdtempSync(path.join(w.config.srvRoot, 'remote-'));
    fs.cpSync(backup.path, remote, { recursive: true });
    w.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'complete',
        remotePath: `b/panel.example.com/demo/${path.basename(backup.path)}`,
        createdAt: Date.now(),
      })
      .run();
    await w.core.backup.removeLocalFiles(backup);

    const real = w.docker.runEphemeral.bind(w.docker);
    w.docker.runEphemeral = async (opts: EphemeralOpts): Promise<RunResult> => {
      const res = await real(opts);
      if (opts.cmd.join(' ').includes('rclone copy CRYPT:')) {
        fs.cpSync(remote, opts.binds![0]!.split(':')[0]!, { recursive: true });
      }
      return res;
    };
    const row = await w.offsite.fetchBackup(backup.id, dest.id);
    expect(row.filesPresent).toBe(1);
    // Decryption is transparent: the same restore path works afterwards.
    expect(fs.existsSync(path.join(row.path, 'files.tar.gz'))).toBe(true);
  });

  it('purges an encrypted copy through the crypt remote, not the plaintext path', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = makeSite(w);
    const dest = encrypted(w);
    const backup = await w.core.backup.create(site, 'scheduled', {});
    const copy = w.db
      .insert(backupCopies)
      .values({
        backupId: backup.id,
        destinationId: dest.id,
        status: 'complete',
        remotePath: 'b/panel.example.com/demo/20260920-030000',
        createdAt: Date.now(),
      })
      .returning()
      .get();

    await w.offsite.purgeCopies([copy]);
    const purge = rcloneCalls(w).find((c) => c.argv.includes(' purge '))!;
    expect(purge.argv).toContain('CRYPT:demo/20260920-030000');
  });
});
