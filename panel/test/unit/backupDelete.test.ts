import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backupCopies, backups, jobLogs, jobs, type BackupRow, type SiteRow } from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { BACKUP_DELETE_LANE } from '../../src/services/backup.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

/** Simulate the wordpress image entrypoint: seed core files once the container starts. */
function seedCoreFilesOnStart(w: TestWorld): void {
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const p = sitePaths(w.config, name.slice(3));
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '6.9';");
  };
}

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    return row.status !== 'queued' && row.status !== 'running';
  }, 25_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

async function createSite(w: TestWorld, slug = 'shop'): Promise<SiteRow> {
  seedCoreFilesOnStart(w);
  const { job } = w.deps.sites.create({
    title: 'Shop',
    slug,
    domainMode: 'dev',
    adminUser: 'boss',
    adminEmail: 'boss@example.test',
    discourageSearchEngines: true,
    plugins: { catalogIds: [], extraWporgSlugs: [] },
  });
  expect((await runJob(w, job.id)).status).toBe('succeeded');
  return w.deps.sites.bySlug(slug);
}

/** Backups with distinct timestamps, oldest first. */
async function backupsOf(w: TestWorld, site: SiteRow, types: BackupRow['type'][]): Promise<BackupRow[]> {
  const out: BackupRow[] = [];
  for (const type of types) {
    out.push(await w.core.backup.create(site, type, {}));
    await new Promise((r) => setTimeout(r, 5));
  }
  return out;
}

const addDestination = (w: TestWorld) =>
  w.offsite.create({
    name: 'bucket',
    provider: 's3',
    config: { accessKeyId: 'AKIA', region: 'eu-central-1', bucket: 'b', prefix: 'panel.example.com' },
    secrets: { secretAccessKey: 'sekrit' },
  });

function seedCompleteCopy(w: TestWorld, backup: BackupRow, destinationId: number) {
  return w.db
    .insert(backupCopies)
    .values({
      backupId: backup.id,
      destinationId,
      status: 'complete',
      remotePath: `b/panel.example.com/${backup.siteSlug}/${path.basename(backup.path)}`,
      completedAt: Date.now(),
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

const purges = (w: TestWorld) =>
  w.docker.calls
    .filter((c) => c.method === 'runEphemeral')
    .map((c) => (c.args[0] as { cmd: string[] }).cmd.join(' '))
    .filter((argv) => argv.includes(' purge '));

const queueDeletion = (w: TestWorld, ids: number[]) =>
  w.worker.enqueue('backup.delete', { backupIds: ids }, undefined, { lane: BACKUP_DELETE_LANE });

const byNumber = (a: number, b: number) => a - b;
const remainingIds = (w: TestWorld) => w.db.select({ id: backups.id }).from(backups).all().map((r) => r.id).sort(byNumber);
const logOf = (w: TestWorld, jobId: number) =>
  w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => l.message).join('\n');

describe('backup.delete', () => {
  it('deletes each backup everywhere - remote copies, files and row - and says what it freed', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const [a, b, keep] = await backupsOf(w, site, ['scheduled', 'manual', 'manual']);
    const dest = addDestination(w);
    seedCompleteCopy(w, a!, dest.id);

    const job = queueDeletion(w, [a!.id, b!.id, 12345]);
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(remainingIds(w)).toEqual([keep!.id]);
    expect(fs.existsSync(a!.path)).toBe(false);
    expect(fs.existsSync(b!.path)).toBe(false);
    expect(fs.existsSync(keep!.path)).toBe(true);
    expect(purges(w)).toEqual([expect.stringContaining(path.basename(a!.path))]);
    expect(w.db.select().from(backupCopies).all()).toEqual([]);
    expect(JSON.parse(done.result!)).toEqual({
      requested: 3,
      deleted: 2,
      alreadyGone: 1,
      notDeleted: 0,
      freedBytes: a!.sizeBytes! + b!.sizeBytes!,
    });
  });

  it('leaves the backups of a site with a restore under way alone, deletes the rest, and fails naming them', async () => {
    const w = await makeWorld({ exec: hostExec });
    const shop = await createSite(w);
    const blog = await createSite(w, 'blog');
    const [restoring, sibling] = await backupsOf(w, shop, ['manual', 'manual']);
    const [other] = await backupsOf(w, blog, ['manual']);
    const restore = w.worker.enqueue(
      'backup.restore',
      { backupId: restoring!.id, skipPreRestoreBackup: true },
      { id: shop.id, slug: shop.slug, serverId: 1 },
    );
    // As if under way - it takes a backup of the site as it goes - without the worker running it.
    w.db.update(jobs).set({ status: 'running', startedAt: Date.now() }).where(eq(jobs.id, restore.id)).run();

    const done = await runJob(w, queueDeletion(w, [restoring!.id, other!.id, sibling!.id]).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^2 of 3 backups were not deleted: /);
    expect(done.error).toContain(`job #${restore.id} (backup.restore)`);
    expect(remainingIds(w)).toEqual([restoring!.id, sibling!.id].sort(byNumber));
    expect(fs.existsSync(restoring!.path)).toBe(true);
    expect(fs.existsSync(other!.path)).toBe(false);
    expect(JSON.parse(done.result!)).toMatchObject({ requested: 3, deleted: 1, notDeleted: 2 });
  });

  it('keeps a backup whose remote copy cannot be removed, rather than forgetting the object', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const [stuck] = await backupsOf(w, site, ['manual']);
    seedCompleteCopy(w, stuck!, addDestination(w).id);
    w.docker.ephemeral = (opts) =>
      opts.cmd.join(' ').includes(' purge ')
        ? { exitCode: 1, stdout: '', stderr: 'AccessDenied: no delete permission' }
        : { exitCode: 0, stdout: '', stderr: '' };

    const done = await runJob(w, queueDeletion(w, [stuck!.id]).id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('1 remote copy/copies could not be removed');
    expect(remainingIds(w)).toEqual([stuck!.id]);
    expect(fs.existsSync(stuck!.path)).toBe(true);
    expect(w.db.select().from(backupCopies).all()).toHaveLength(1);
    expect(logOf(w, done.id)).toContain('AccessDenied');
  });

  it('is not blocked by the site deletion that queued it, and is by any other job of the site', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const [backup] = await backupsOf(w, site, ['manual']);
    const siteDelete = w.worker.enqueue('site.delete', { siteId: site.id, finalBackup: false }, { id: site.id, slug: site.slug, serverId: 1 });
    expect(w.core.backup.deletionBlocker(backup!)).toContain(`job #${siteDelete.id} (site.delete)`);
    expect(w.core.backup.deletionBlocker(backup!, [siteDelete.id])).toBeNull();
  });

  it('keeps what it names from being copied offsite or pruned while it is queued', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    addDestination(w);
    const made = await backupsOf(w, site, ['scheduled', 'scheduled', 'scheduled']);
    const doomed = made[0]!;
    queueDeletion(w, [doomed.id]);

    w.offsite.tick();
    const copied = w.db.select({ backupId: backupCopies.backupId }).from(backupCopies).all().map((c) => c.backupId);
    expect(copied).not.toContain(doomed.id);
    expect(copied).toEqual(expect.arrayContaining([made[1]!.id, made[2]!.id]));
    const uploads = w.db.select().from(jobs).where(eq(jobs.type, 'backup.offsite')).all();
    expect(uploads.map((j) => JSON.parse(j.payload).backupId)).not.toContain(doomed.id);

    // Retention would remove it too; the deletion job is the one that does.
    w.db.delete(backupCopies).run();
    for (const j of uploads) w.worker.cancel(j.id);
    expect(await w.core.backup.prune(1)).toEqual({ deleted: 1, offsiteOnly: 0 });
    expect(remainingIds(w)).toEqual([doomed.id, made[2]!.id].sort(byNumber));
  });
});

describe('backup.delete beside a relocation', () => {
  const jobRow = (w: TestWorld, id: number) => w.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
  const ended = (w: TestWorld, id: number) => !['queued', 'running'].includes(jobRow(w, id).status);
  const newRoot = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `wpl7-${name}-`)), 'backups');
  const ok = { exitCode: 0, stdout: '', stderr: '' };

  // Regression: a relocation that started while a deletion waited on a remote purge moved the
  // files and repointed the row; the deletion then removed the old path and the row, and the
  // moved copy stayed on disk with nothing left that knew of it.
  it('a relocation that starts while a deletion purges leaves the doomed backup to it', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const [doomed, other] = await backupsOf(w, site, ['manual', 'manual']);
    seedCompleteCopy(w, doomed!, addDestination(w).id);
    let purging!: () => void;
    const purgeStarted = new Promise<void>((r) => (purging = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.docker.ephemeral = async (opts) => {
      if (opts.cmd.join(' ').includes(' purge ')) {
        purging();
        await gate;
      }
      return ok;
    };
    const to = newRoot('relocate');

    const deletion = queueDeletion(w, [doomed!.id]);
    w.worker.start();
    await purgeStarted;
    const relocation = w.worker.enqueue('server.relocateBackups', { serverId: 1, to }, undefined, { serverId: 1 });
    await waitFor(() => ended(w, relocation.id), 25_000);
    release();
    await waitFor(() => ended(w, deletion.id), 25_000);
    await w.worker.stop();

    expect(jobRow(w, deletion.id).status).toBe('succeeded');
    expect(JSON.parse(jobRow(w, relocation.id).result!)).toMatchObject({ moved: 1, skipped: 1 });
    expect(logOf(w, relocation.id)).toContain(`#${doomed!.id} (job #${deletion.id} is deleting it)`);
    // Nothing of the deleted backup anywhere; the other one moved, and its row says where.
    expect(w.db.select().from(backups).where(eq(backups.id, doomed!.id)).get()).toBeUndefined();
    expect(fs.existsSync(doomed!.path)).toBe(false);
    expect(fs.existsSync(path.join(to, site.slug, path.basename(doomed!.path)))).toBe(false);
    const moved = w.db.select().from(backups).where(eq(backups.id, other!.id)).get()!;
    expect(moved.path.startsWith(to)).toBe(true);
    expect(fs.existsSync(path.join(moved.path, 'files.tar.gz'))).toBe(true);
  });

  it('keeps its hands off a server whose backups a relocation is moving, and so does retention', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const [old] = await backupsOf(w, site, ['scheduled', 'scheduled']);
    const relocation = w.worker.enqueue('server.relocateBackups', { serverId: 1, to: newRoot('busy') }, undefined, { serverId: 1 });
    // Under way - with nothing to say which backup it is copying right now.
    w.db.update(jobs).set({ status: 'running', startedAt: Date.now() }).where(eq(jobs.id, relocation.id)).run();

    expect(w.core.backup.deletionBlocker(old!)).toContain(`job #${relocation.id} moves its server's backups`);
    const done = await runJob(w, queueDeletion(w, [old!.id]).id);
    expect(done.status).toBe('failed');
    expect(fs.existsSync(old!.path)).toBe(true);
    expect(await w.core.backup.prune(1)).toEqual({ deleted: 0, offsiteOnly: 0 });

    // A backup with no local files has nothing to move, and nothing to wait for.
    w.db.update(backups).set({ filesPresent: 0 }).where(eq(backups.id, old!.id)).run();
    expect(w.core.backup.deletionBlocker({ ...old!, filesPresent: 0 })).toBeNull();
    w.db.update(backups).set({ filesPresent: 1 }).where(eq(backups.id, old!.id)).run();

    w.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).where(eq(jobs.id, relocation.id)).run();
    expect(w.core.backup.deletionBlocker(old!)).toBeNull();
    expect(await w.core.backup.prune(1)).toEqual({ deleted: 1, offsiteOnly: 0 });
  });

  it('deletes the files where the row says they are once the remote copies are gone', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const [backup] = await backupsOf(w, site, ['manual']);
    seedCompleteCopy(w, backup!, addDestination(w).id);
    const to = newRoot('moved');
    const movedTo = path.join(to, site.slug, path.basename(backup!.path));
    // While the purge runs the files move and the row follows them, as a relocation does it.
    w.docker.ephemeral = async (opts) => {
      if (opts.cmd.join(' ').includes(' purge ')) {
        fs.mkdirSync(path.dirname(movedTo), { recursive: true });
        fs.renameSync(backup!.path, movedTo);
        w.db.update(backups).set({ path: movedTo, rootPath: to }).where(eq(backups.id, backup!.id)).run();
      }
      return ok;
    };

    expect(await w.offsite.deleteEverywhere(backup!)).toEqual({ purgeFailed: 0, keptByPolicy: 0 });
    expect(fs.existsSync(movedTo)).toBe(false);
    expect(fs.existsSync(backup!.path)).toBe(false);
    expect(w.db.select().from(backups).where(eq(backups.id, backup!.id)).get()).toBeUndefined();
  });
});

describe('site.delete with deleteBackups', () => {
  /** Run a site deletion, then the deletion of backups it queued. */
  async function deleteSite(w: TestWorld, site: SiteRow, finalBackup: boolean) {
    const done = await runJob(w, w.deps.sites.delete(site.slug, finalBackup, true).id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    const result = JSON.parse(done.result!) as { finalBackupId?: number; backupDeleteJobId?: number };
    const follow = result.backupDeleteJobId
      ? w.db.select().from(jobs).where(eq(jobs.id, result.backupDeleteJobId)).get()!
      : null;
    if (follow) {
      expect(follow).toMatchObject({ type: 'backup.delete', lane: BACKUP_DELETE_LANE, siteSlug: site.slug });
      expect(JSON.parse(follow.payload).parentJobId).toBe(done.id);
      expect((await runJob(w, follow.id)).status).toBe('succeeded');
    }
    return { done, result, follow };
  }

  it('takes the final backup, then deletes every other one: the site is left with exactly one', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const old = await backupsOf(w, site, ['scheduled', 'manual', 'pre_update']);
    const panelSnapshot = w.db
      .insert(backups)
      .values({ siteSlug: 'panel', serverId: 1, type: 'panel', status: 'complete', path: '/nowhere/panel/1', createdAt: 1 })
      .returning()
      .get();

    const { done, result, follow } = await deleteSite(w, site, true);
    expect(result.finalBackupId).toBeTypeOf('number');
    expect(follow).not.toBeNull();
    expect(JSON.parse(follow!.payload).backupIds).toEqual(old.map((b) => b.id));
    expect(remainingIds(w)).toEqual([panelSnapshot.id, result.finalBackupId!].sort(byNumber));
    const final = w.db.select().from(backups).where(eq(backups.id, result.finalBackupId!)).get()!;
    expect(final).toMatchObject({ type: 'final', status: 'complete', siteSlug: site.slug });
    expect(fs.existsSync(final.path)).toBe(true);
    for (const b of old) expect(fs.existsSync(b.path)).toBe(false);
    expect(done.summary).toBe('Keeping only a final backup');
    expect(logOf(w, done.id)).toContain(`Its 3 other backups are deleted next, remote copies included: job #${follow!.id}.`);
  });

  it('without a final backup, deletes every backup the site had', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    await backupsOf(w, site, ['scheduled', 'manual']);
    const { result } = await deleteSite(w, site, false);
    expect(result.finalBackupId).toBeUndefined();
    expect(remainingIds(w)).toEqual([]);
  });

  it('keeps the newest backup when a final one was asked for but the files were already gone', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const [older, newest] = await backupsOf(w, site, ['manual', 'manual']);
    // A second attempt after a teardown that got as far as the files.
    fs.rmSync(sitePaths(w.config, site.slug).wordpress, { recursive: true, force: true });

    const { done, result } = await deleteSite(w, site, true);
    expect(result.finalBackupId).toBeUndefined();
    expect(remainingIds(w)).toEqual([newest!.id]);
    expect(fs.existsSync(older!.path)).toBe(false);
    expect(logOf(w, done.id)).toContain(`its newest backup, #${newest!.id} (manual`);
  });

  it('leaves the backups alone unless asked, as before', async () => {
    const w = await makeWorld({ exec: hostExec });
    const site = await createSite(w);
    const old = await backupsOf(w, site, ['manual']);
    const done = await runJob(w, w.deps.sites.delete(site.slug, true).id);
    expect(done.status).toBe('succeeded');
    expect(JSON.parse(done.payload).deleteBackups).toBe(false);
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'backup.delete')).all()).toEqual([]);
    expect(remainingIds(w)).toHaveLength(2);
    expect(remainingIds(w)).toContain(old[0]!.id);
  });
});
