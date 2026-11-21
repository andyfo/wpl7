// @docs servers/recover, backups/restore
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { appRoutes, appSettings, backups, jobs, moveCleanups, siteDatabases, sites, type BackupRow, type MoveCleanupRow, type SiteRow } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { assertPhpImage, siteImage, sitePaths } from '../../services/siteSpec.js';
import { hasDatabase, isContainerApp, isExternal, isPhpSite } from '../../lib/siteKind.js';
import { loadSite, probeOptsFor, probeSite, removeSiteContainers, rewriteWordPressUrls, siteDomains, siteUrl, stopGraceOf, updateSiteRow, writeSiteJson } from './shared.js';
import { ensureSiteImage } from './sites.js';
import { proxyConfigPathFor, rmOn } from './moveHelpers.js';
import { extraDbFile, manifestDatabases, otherAppRefusal, tsStamp } from '../../services/backup.js';
import { restoreSiteOnServer, type ProtectionHold } from './restoreSite.js';
import { backupImage, type PlacedImage } from './apps.js';
import { appRows } from '../../services/appSpec.js';
import { pinned, pullAuthFor, pullPinned } from '../../services/appImages.js';
import { repointSiteDns, writeForwarding, type DnsRepoint } from './siteHandover.js';
import { finalizeCleanup } from './move.js';
import { checkRecoverRequest, serverAnswers, serverReach, siteRecoveryState, siteRowFromManifest, type BackupManifest } from '../../services/recovery.js';
import { TABLE_PREFIX_RE } from '../../../shared/schemas.js';
import type { RecoveryState } from '../../../shared/types.js';

export const siteRecoverPayload = z.object({
  siteId: z.number().int(),
  backupId: z.number().int(),
  /** A destination with a complete copy, or null for the backup's own files on the target. */
  destinationId: z.number().int().nullable(),
  targetServerId: z.number().int(),
  /** A deleted site made again from this backup (services/recovery.ts): its row is new, and goes again on a failure. */
  asNew: z.boolean().default(false),
});

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function readManifestOn(h: ServerHandle, dir: string): Promise<BackupManifest | null> {
  try {
    return JSON.parse(await h.files.readFile(path.join(dir, 'manifest.json'))) as BackupManifest;
  } catch {
    return null;
  }
}

/**
 * Bring a site back from one of its backups: onto another server when its own does not answer,
 * or onto its own once it is gone from there (services/recovery.ts decides which may go). The
 * backup is fetched from its offsite copy onto the target first, unless its files are there
 * already, and the site is then built there as a move builds it (restoreSiteOnServer). Until the
 * site row points at the target, every step is undone on a failure, and running it again is the
 * way to retry. After that the site lives on the target.
 *
 * The old server is not touched while it does not answer. Its copy of the site is parked there as
 * a move parks one, with the handover still owed: when the server answers again,
 * `site.recoverHandover` stops that copy and forwards its visitors here, and the copy is removed a
 * day later. On its own server, what is left of the site is set aside rather than deleted.
 */
export async function siteRecover(ctx: JobContext<z.infer<typeof siteRecoverPayload>>, s: CoreServices): Promise<void> {
  if (!ctx.payload.asNew) return recoverSite(ctx, s, ctx.payload.siteId, null);
  const made = await makeDeletedSite(ctx, s);
  return recoverSite(ctx, s, made.siteId, made);
}

/**
 * A backup's files where they are listed, on the target, checked. A reinstalled disk can take a
 * backup that has no copy without the panel knowing, until someone asks (BackupService.checkFiles).
 */
async function checkFilesOn(ctx: JobContext<unknown>, s: CoreServices, target: ServerHandle, backup: BackupRow): Promise<void> {
  if (!(await target.files.exists(path.join(backup.path, 'sha256sums')))) {
    throw new Error(`Backup #${backup.id}'s files are not on "${target.name}" any more: pick another backup, or its offsite copy. Nothing was changed.`);
  }
  ctx.info(`Backup #${backup.id}'s files are on "${target.name}"; checking them…`);
  await s.backup.verifyChecksums(backup);
}

/** The backup a deleted site was made again from, already on the target and checked (makeDeletedSite). */
interface Prepared {
  backup: BackupRow;
  manifest: BackupManifest | null;
}

/**
 * A deleted site's row, made again from its backup's manifest (services/recovery.ts
 * siteRowFromManifest): the backup comes onto the target first, because that is where the manifest
 * is when the backup is kept only offsite. The job takes the new site as its own.
 */
async function makeDeletedSite(
  ctx: JobContext<z.infer<typeof siteRecoverPayload>>,
  s: CoreServices,
): Promise<Prepared & { siteId: number }> {
  const p = ctx.payload;
  let backup = s.db.select().from(backups).where(eq(backups.id, p.backupId)).get();
  if (!backup || backup.status !== 'complete') throw new Error(`Backup #${p.backupId} is not a complete backup any more. Nothing was changed.`);
  const slug = backup.siteSlug;
  if (s.db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)).get()) {
    throw new Error(`"${slug}" is a site already. Nothing was changed.`);
  }
  const target = s.servers.handleFor(p.targetServerId);
  ctx.info(`Making "${slug}" again from backup #${backup.id} on "${target.name}"…`);
  const alive = await target.exec.run('true', [], { timeoutMs: 30_000 });
  if (alive.exitCode !== 0) throw new Error(`"${target.name}" does not answer: ${alive.stderr.trim().slice(0, 200)}`);
  if (p.destinationId === null) {
    await checkFilesOn(ctx, s, target, backup);
  } else {
    backup = await s.offsite.fetchBackup(backup.id, p.destinationId, ctx, { targetServerId: target.id });
  }
  const manifest = await readManifestOn(target, backup.path);
  if (!manifest) {
    throw new Error(`Backup #${backup.id} has no manifest.json that can be read, so it can't be told what the site was. Nothing was changed.`);
  }
  const values = siteRowFromManifest(s, slug, manifest, target.row, (message) => ctx.warn(message));
  let siteId: number;
  try {
    siteId = s.db.insert(sites).values(values).returning({ id: sites.id }).get().id;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: sites\.slug/.test(err.message)) {
      throw new Error(`"${slug}" is a site again already. Nothing was changed.`);
    }
    throw err;
  }
  // Its job from here on: the site's page shows it, and no other job of the site starts beside it.
  s.db.update(jobs).set({ siteId }).where(eq(jobs.id, ctx.jobId)).run();
  ctx.info(`"${slug}" is back in the panel; bringing back its files and databases…`);
  return { siteId, backup, manifest };
}

async function recoverSite(
  ctx: JobContext<z.infer<typeof siteRecoverPayload>>,
  s: CoreServices,
  siteId: number,
  prepared: Prepared | null,
): Promise<void> {
  const p = ctx.payload;
  let site = loadSite(s.db, siteId);
  const fromServerId = site.serverId;
  const fromName = s.servers.rowById(fromServerId)?.name ?? `server #${fromServerId}`;
  const target = s.servers.handleFor(p.targetServerId);
  const sameServer = target.id === fromServerId;
  const paths = sitePaths(s.config, site.slug);
  const domains = siteDomains(site);
  const primary = domains[0]!;
  // A stopped site comes back stopped: it runs on the target only for the probe.
  const wasStopped = site.status === 'stopped';
  const probeTimeout = Math.max(s.config.probeTimeoutMs, 60_000);
  const extrasBefore = s.databases.extraNames(site.id);

  s.monitor.busySlugs.add(site.slug);
  let committed = false;
  let resumeFtp: (() => void) | null = null;
  const protection: ProtectionHold = { release: null };
  let aside: string | null = null;
  try {
    // ------------------------------------------------------------ 0: preflight
    ctx.info(`Recovering "${site.slug}" from backup #${p.backupId} onto "${target.name}"…`);
    let state: RecoveryState = 'missing';
    if (!prepared) {
      const reach = sameServer ? { answers: true, refusesKey: false } : await serverReach(s, fromServerId);
      const now = await siteRecoveryState(s, site, { ...reach, exceptJobId: ctx.jobId });
      if (now.refusal) throw new Error(`${now.refusal} Nothing was changed.`);
      state = now.state;
    }
    const checked = checkRecoverRequest(s, site, state, {
      backupId: prepared?.backup.id ?? p.backupId,
      // A deleted site's backup is on the target by now (makeDeletedSite).
      destinationId: prepared ? null : p.destinationId,
      targetServerId: p.targetServerId,
    });
    const blocker = s.backup.deletionBlocker(checked.backup.row, [ctx.jobId]);
    if (blocker) throw new Error(`${blocker}. Nothing was changed.`);

    const alive = await target.exec.run('true', [], { timeoutMs: 30_000 });
    if (alive.exitCode !== 0) throw new Error(`"${target.name}" does not answer: ${alive.stderr.trim().slice(0, 200)}`);
    if ((await target.docker.containerState('wpl7-mariadb')) !== 'running') {
      throw new Error(`MariaDB is not running on "${target.name}". Nothing was changed.`);
    }
    const targetBackupRoot = s.backup.rootFor(target);
    const need = Math.max((site.diskBytes ?? 0) * 2.5, (checked.backup.row.sizeBytes ?? 0) * 4);
    const disk = await target.files.statvfs(targetBackupRoot).catch(() => null);
    if (disk && need > 0 && disk.freeBytes < need) {
      throw new Error(
        `Not enough free disk on "${target.name}": ${Math.round(disk.freeBytes / 1e6)}MB free, ~${Math.round(need / 1e6)}MB needed. Nothing was changed.`,
      );
    }
    if (!disk) ctx.warn(`Could not read the free disk space on "${target.name}"; continuing.`);
    await target.files.mkdirp(s.config.paths.plugins);
    ctx.checkCanceled();

    // ------------------------------------------------------------ 1: the backup, on the target
    let backup: BackupRow = checked.backup.row;
    if (prepared) {
      // Fetched and checked already, to read the manifest the site was made from.
    } else if (checked.destinationId === null) {
      await checkFilesOn(ctx, s, target, backup);
    } else {
      backup = await s.offsite.fetchBackup(backup.id, checked.destinationId, ctx, { targetServerId: target.id });
    }
    const manifest = prepared ? prepared.manifest : await readManifestOn(target, backup.path);
    if (manifest?.kind === 'external') {
      throw new Error('This is a backup of a site hosted elsewhere: it is restored by hand, from its download. Nothing was changed.');
    }
    const otherApp = otherAppRefusal(site, manifest);
    if (otherApp) throw new Error(otherApp);
    ctx.checkCanceled();

    // ------------------------------------------------------------ 2: what the backup says
    // Kept on a copy of the row until the cutover: a recovery that fails leaves the row as it was.
    const recovering: SiteRow = { ...site, serverId: target.id };
    const offered = s.settings.get('phpVersions') ?? [];
    if (!isContainerApp(site) && manifest?.phpVersion && manifest.phpVersion !== site.phpVersion) {
      if (offered.includes(manifest.phpVersion)) {
        ctx.info(`The backup was taken on PHP ${manifest.phpVersion}; the site comes back on it.`);
        recovering.phpVersion = manifest.phpVersion;
      } else {
        ctx.warn(`The backup was taken on PHP ${manifest.phpVersion}, which is no longer offered; the site comes back on PHP ${site.phpVersion}.`);
      }
    }
    const prefix = manifest?.tablePrefix;
    if (site.app === 'wordpress' && prefix && TABLE_PREFIX_RE.test(prefix) && prefix !== site.tablePrefix) {
      ctx.info(`The backup's tables start with ${prefix}, not ${site.tablePrefix}; the site comes back with ${prefix}.`);
      recovering.tablePrefix = prefix;
    }
    if (isPhpSite(site) && typeof manifest?.webRoot === 'string' && manifest.webRoot !== site.webRoot) {
      const where = (root: string) => (root === '' ? "the site's folder" : root);
      ctx.warn(`The backup was taken with the web root ${where(manifest.webRoot)}; the site keeps ${where(site.webRoot)}. Change it in Settings if the files need the other.`);
    }
    if (hasDatabase(site) && backup.hasDatabase !== 1) {
      throw new Error(`Backup #${backup.id} holds no database, and "${site.slug}" has one: pick a backup that holds it. Nothing was changed.`);
    }
    if (!hasDatabase(site) && backup.hasDatabase === 1) {
      ctx.warn('The backup holds a database, and the site has none now: it comes back without it. Its dump stays in the backup.');
    }

    // The backup's other databases must land on names that are free there and belong to no other site.
    const inBackup = manifestDatabases(manifest);
    const onTarget = new Set(inBackup.length > 0 || sameServer ? (await target.dbAdmin.inventory()).map((r) => r.name) : []);
    if (inBackup.length > 0) {
      const taken = inBackup.filter((n) => onTarget.has(n));
      if (taken.length > 0) {
        throw new Error(
          `"${target.name}" already has a database called ${taken.join(', ')}. ` +
            (sameServer ? 'Restore the site instead, or delete it under Databases.' : 'Delete it under Databases if no site needs it, then recover again.') +
            ' Nothing was changed.',
        );
      }
      for (const name of inBackup) {
        const owner = s.db.select().from(siteDatabases).where(eq(siteDatabases.name, name)).get();
        if (owner && owner.siteId !== site.id) throw new Error(`The backup's database ${name} is another site's now. Nothing was changed.`);
      }
    }

    if (!isContainerApp(site)) {
      await ensureSiteImage(ctx, target, s.config, recovering.phpVersion);
      if (isPhpSite(site)) await assertPhpImage(target, siteImage(recovering.phpVersion));
      // Its drop-in would stay behind with no Redis to talk to.
      if (site.objectCache === 1 && (await target.docker.imageStack(siteImage(recovering.phpVersion))) === 1) {
        throw new Error(`"${target.name}" has no object cache yet, because it still has the old site image. Update that server first, or switch this site's object cache off. Nothing was changed.`);
      }
    }
    if (isContainerApp(site) && !sameServer) {
      // Its plain http routes need a Traefik there that can answer them, as a move checks.
      const enabled = s.db.select({ scheme: appRoutes.scheme }).from(appRoutes).where(and(eq(appRoutes.siteId, site.id), eq(appRoutes.enabled, 1))).all();
      await s.apps.assertHttpRoutesOn(target.id, enabled);
    }
    const appImage = isContainerApp(site) ? await recoveryImage(ctx, s, target, site, manifest) : null;
    ctx.checkCanceled();

    // ------------------------------------------------------------ 3: clear the way on the target
    if (sameServer) {
      // A deleted site's name may still have a database there that no site uses: someone's data,
      // which is not this recovery's to drop.
      if (prepared && hasDatabase(site) && (await target.dbAdmin.inventory()).some((r) => r.name === site.dbName)) {
        throw new Error(`A database called ${site.dbName} is on "${target.name}" and no site uses it. Delete it under Databases, then try again. Nothing was changed.`);
      }
      // What is left of the site there is not a working site, but it is not ours to delete either:
      // set aside, then kept for a day as the restore keeps the files it replaces.
      resumeFtp = await s.ftp.suspendSite(site);
      await removeSiteContainers(target.docker, site.containerName, isContainerApp(site) ? { volumes: true } : undefined);
      if (hasDatabase(site)) await target.dbAdmin.dropSiteDb(site.dbName, site.dbUser);
      if (await target.files.exists(paths.root)) {
        const setAside = `${paths.root}.pre-recover-${tsStamp(new Date())}`;
        await target.files.rename(paths.root, setAside);
        aside = setAside;
        ctx.info(`What was left in the site's folder is set aside in ${setAside}.`);
        ctx.pushCompensation('put the site folder back', async () => {
          await rmOn(target, s.config.paths.sites, site.slug);
          await target.files.rename(setAside, paths.root);
        });
      }
    } else {
      // Leftovers of the slug there are garbage: an earlier attempt, or the copy a move away from
      // that server parked, which this recovery supersedes.
      for (const parked of pendingCleanupsOn(s, site.id, target.id)) {
        // Removed as a finalize removes it, its forwarding file with it: this recovery takes its place.
        ctx.info(`Removing the copy an earlier move parked on "${target.name}": this recovery takes its place.`);
        await finalizeCleanup(ctx, s, parked);
      }
      if ((await target.docker.containerState(site.containerName)) !== 'missing') {
        ctx.warn(`Removing leftover container ${site.containerName} on "${target.name}"`);
      }
      await removeSiteContainers(target.docker, site.containerName, isContainerApp(site) ? { volumes: true } : undefined);
      if (await target.files.exists(paths.root)) {
        ctx.warn(`Removing leftover files on "${target.name}"`);
        await rmOn(target, s.config.paths.sites, site.slug);
      }
      if (hasDatabase(site)) await target.dbAdmin.dropSiteDb(site.dbName, site.dbUser);
    }

    // Databases the backup holds that the site no longer lists come back as the site's.
    const reserved: number[] = [];
    for (const name of inBackup.filter((n) => !extrasBefore.includes(n))) {
      const id = s.databases.reserve(site.id, name, null);
      if (id === null) throw new Error(`The backup's database ${name} is another site's now. Nothing was changed.`);
      reserved.push(id);
    }
    if (reserved.length > 0) {
      ctx.pushCompensation('forget the databases reserved for the recovery', async () => {
        s.db.delete(siteDatabases).where(inArray(siteDatabases.id, reserved)).run();
      });
    }

    // ------------------------------------------------------------ 4: the site, built on the target
    await restoreSiteOnServer(
      ctx,
      s,
      target,
      recovering,
      domains,
      {
        kind: 'archive',
        filesTarGz: path.join(backup.path, 'files.tar.gz'),
        dbSqlGz: hasDatabase(site) ? path.join(backup.path, 'db.sql.gz') : null,
        extraDbs: inBackup.map((name) => ({ name, sqlGz: path.join(backup.path, extraDbFile(name)) })),
        ranOnFpm: manifest?.stack === 2,
      },
      {
        routing: true,
        requireWpConfig: site.app === 'wordpress',
        protection,
        // A deleted site made again has no other copy for a rollback to leave in place, and the
        // same backup would fail the same way again: it stays, to be repaired, and is checked once
        // it is in (step 5). A PHP site's own config still names its database user's old password.
        probe: prepared
          ? null
          : {
              host: primary,
              timeoutMs: probeTimeout,
              message: wasStopped ? `Probing the site on "${target.name}" (it is started briefly for this)…` : `Probing the site on "${target.name}"…`,
            },
        ...(appImage ? { appImage: appImage.ref } : {}),
      },
    );

    // On its own server its user was made again, without the grants it had on the databases it keeps there.
    if (sameServer && hasDatabase(site)) {
      for (const name of extrasBefore.filter((n) => !inBackup.includes(n) && onTarget.has(n))) {
        await target.dbAdmin.grantDb(name, site.dbUser);
        ctx.info(`Database ${name} is not in this backup and stays as it is there, the site's as before.`);
      }
    }

    // Its address may have changed since the backup: WordPress follows the site's current one.
    const listed = Array.isArray(manifest?.domains) ? (manifest.domains as unknown[]) : [];
    const backupPrimary = typeof listed[0] === 'string' ? listed[0] : undefined;
    if (backupPrimary && backupPrimary !== primary) {
      if (site.app === 'wordpress') {
        const rewrite = rewriteWordPressUrls(ctx, s, target, recovering, siteUrl(s.config, backupPrimary), siteUrl(s.config, primary), true);
        // A WordPress that does not run can't be rewritten either: a deleted site stays regardless.
        await (prepared
          ? rewrite.catch((err: unknown) => {
              ctx.warn(`WordPress's URLs still say ${backupPrimary}, as they could not be rewritten to ${primary}: ${errMsg(err)}`);
            })
          : rewrite);
      } else if (!isContainerApp(site)) {
        ctx.info(`The backup used ${backupPrimary}. If the site's own config names its address, change it there to ${primary}.`);
      }
    }
    ctx.checkCanceled();
    if (wasStopped) {
      ctx.info('The site was stopped; stopping it again.');
      await target.docker.stopContainer(site.containerName, stopGraceOf(s.db, site));
    }

    // ------------------------------------------------------------ 5: cutover
    let cleanupId: number | null = null;
    // Added after the backup: gone with the lost server, unless the site came back on its own server,
    // where such a database is still there and stays the site's.
    const dropped = extrasBefore.filter((n) => !inBackup.includes(n) && !(sameServer && onTarget.has(n)));
    s.db.transaction(() => {
      updateSiteRow(s.db, site.id, {
        serverId: target.id,
        phpVersion: recovering.phpVersion,
        tablePrefix: recovering.tablePrefix,
        status: wasStopped ? 'stopped' : 'running',
      });
      if (appImage) {
        s.db
          .update(appSettings)
          .set({ imageId: appImage.imageId, ...(appImage.digest ? { digest: appImage.digest } : {}), updatedAt: Date.now() })
          .where(eq(appSettings.siteId, site.id))
          .run();
      }
      // Added after this backup: they were on the old server only, and they did not come back.
      if (dropped.length > 0) {
        s.db.delete(siteDatabases).where(and(eq(siteDatabases.siteId, site.id), inArray(siteDatabases.name, dropped))).run();
      }
      if (!sameServer) {
        cleanupId = s.db
          .insert(moveCleanups)
          .values({
            siteId: site.id,
            siteSlug: site.slug,
            sourceServerId: fromServerId,
            targetServerId: target.id,
            containerName: site.containerName,
            dbName: site.dbName,
            dbUser: site.dbUser,
            extraDbs: extrasBefore.length > 0 ? JSON.stringify(extrasBefore) : null,
            filesPath: paths.root,
            verifyHosts: JSON.stringify(domains),
            targetIp: target.row.publicIp,
            proxyConfigPath: proxyConfigPathFor(s.config.srvRoot, site.slug),
            status: 'pending',
            handover: 'pending',
            createdAt: Date.now(),
          })
          .returning({ id: moveCleanups.id })
          .get().id;
      }
    });
    ctx.clearCompensations(); // the target is authoritative now - never tear it down below
    committed = true;
    ctx.info(`"${site.slug}" now lives on "${target.name}", as it was in backup #${backup.id}.`);
    for (const name of dropped) ctx.warn(`Database ${name} was added after this backup, so it is not in it. It was on "${fromName}" only.`);

    site = loadSite(s.db, site.id);
    await writeSiteJson(target, s, site);
    protection.release?.();
    protection.release = null;
    await s.security.kick(target.id);
    if (!sameServer) void s.security.kick(fromServerId);
    if (isContainerApp(site)) await s.appRoutes.kick(target.id);
    void s.ftp.kick(target.id);
    s.databases.kick(target.id);

    if (aside) {
      // Whole - files, mounts kept out of backups, quarantine - and removed a day from now by
      // BackupService.gcSafetyCopies, which reads the time in its name.
      ctx.info(`What was left of the site there is kept for a day in ${aside}.`);
    }

    if (prepared) {
      ctx.info(`Checking that the site answers on "${target.name}"…`);
      // No live HTTP in unit tests; the container state is the check there, as in restoreSiteOnServer.
      const answers =
        s.config.nodeEnv === 'test'
          ? (await target.docker.containerState(site.containerName)) === 'running'
          : await probeSite(target, site.containerName, primary, probeTimeout, probeOptsFor(site)).catch(() => false);
      if (!answers) {
        ctx.warn(
          isPhpSite(site) && hasDatabase(site)
            ? "The site does not answer yet. Its database user has a new password: put it in the site's own config, from the Database tab."
            : 'The site does not answer yet. It stays as the backup brought it back: check its logs, or restore another backup.',
        );
      }
    }

    const dns: DnsRepoint = await repointSiteDns(ctx, s, site, target, { fromName, sameServer, madeAgain: prepared !== null });

    // ------------------------------------------------------------ 6: the old server
    if (cleanupId !== null) {
      // One way to the old server, a job of its own in its lane: the server answering again queues
      // the same job, and two of them must not stop the same copy at once.
      if (await serverAnswers(s, fromServerId)) {
        queueHandovers(s, fromServerId);
        ctx.info(`"${fromName}" answers: a job of its own stops the old copy there and forwards its visitors here.`);
      } else {
        ctx.warn(
          `"${fromName}" does not answer. If it answers again, the panel stops the old copy there, ` +
            'forwards its visitors here, and removes it a day later.',
        );
      }
    }

    ctx.setResult({
      slug: site.slug,
      fromServerId,
      toServerId: target.id,
      backupId: backup.id,
      destinationId: checked.destinationId,
      backupCreatedAt: backup.createdAt,
      url: siteUrl(s.config, primary),
      cleanupId,
      dns,
    });
    ctx.info('Recovery complete.');
  } catch (err) {
    ctx.error(`Recovery failed: ${errMsg(err)}`);
    if (committed) {
      ctx.error(
        `The recovery itself SUCCEEDED - "${site.slug}" lives on "${target.name}" - but a follow-up step ` +
          `(DNS, or the old server) failed. Nothing was rolled back. Check the DNS records above.`,
      );
      throw err;
    }
    await ctx.runCompensations();
    if (p.asNew) {
      // The site was made for this recovery: without it, its backups read as a deleted site's again.
      s.db.delete(sites).where(eq(sites.id, site.id)).run();
      ctx.info(`Nothing of "${site.slug}" is left on "${target.name}"; its backups are as they were.`);
    } else {
      ctx.info(`Nothing of "${site.slug}" is left on "${target.name}"; the site is as it was. Running the recovery again is safe.`);
    }
    throw err;
  } finally {
    s.monitor.busySlugs.delete(site.slug);
    resumeFtp?.();
    if (protection.release) {
      protection.release();
      await s.security.kick(target.id);
      if (isContainerApp(site)) await s.appRoutes.kick(target.id);
    }
  }
}

/** The pending cleanups of a site whose parked copy is on `serverId`. */
function pendingCleanupsOn(s: CoreServices, siteId: number, serverId: number): MoveCleanupRow[] {
  return s.db
    .select()
    .from(moveCleanups)
    .where(and(eq(moveCleanups.siteId, siteId), eq(moveCleanups.sourceServerId, serverId), eq(moveCleanups.status, 'pending')))
    .all();
}

// ---------------------------------------------------------------------------

export const siteRecoverHandoverPayload = z.object({
  cleanupId: z.number().int(),
});

/** What a server that answers again is owed for one site that left it while it did not. */
export async function siteRecoverHandover(
  ctx: JobContext<z.infer<typeof siteRecoverHandoverPayload>>,
  s: CoreServices,
): Promise<void> {
  const cleanup = s.db.select().from(moveCleanups).where(eq(moveCleanups.id, ctx.payload.cleanupId)).get();
  if (!cleanup) throw new Error(`Cleanup #${ctx.payload.cleanupId} not found`);
  if (cleanup.handover === 'done' || cleanup.status === 'done') {
    ctx.info('The old copy was handed over already; nothing to do.');
    return;
  }
  await handOver(ctx, s, cleanup);
  ctx.setResult({ cleanupId: cleanup.id, slug: cleanup.siteSlug });
}

/** Cleanups being handed over right now: a server that answers again can queue one twice. */
const handingOver = new Set<number>();

/**
 * Stop the old copy on a server that answers again, so it can't serve beside the recovered site or
 * run its cron a second time, and forward its visitors to the server the site lives on now. Its
 * files and databases stay parked until the move's finalize removes them, a day after this at the
 * earliest. A site deleted meanwhile has nothing to forward to: its copy goes at once.
 */
export async function handOver(ctx: JobContext<unknown>, s: CoreServices, cleanup: MoveCleanupRow): Promise<void> {
  if (handingOver.has(cleanup.id)) {
    ctx.info('Another job is handing this copy over already.');
    return;
  }
  handingOver.add(cleanup.id);
  try {
    await handOverOnce(ctx, s, cleanup);
  } finally {
    handingOver.delete(cleanup.id);
  }
}

async function handOverOnce(ctx: JobContext<unknown>, s: CoreServices, cleanup: MoveCleanupRow): Promise<void> {
  const old = s.servers.handleFor(cleanup.sourceServerId);
  // Names are reused when a slug is: never touch what a site living on that server owns now.
  const byName = s.db.select().from(sites).where(eq(sites.slug, cleanup.siteSlug)).get();
  if (byName && !isExternal(byName) && byName.serverId === cleanup.sourceServerId) {
    s.db
      .update(moveCleanups)
      .set({ status: 'done', handover: 'done', handedOverAt: Date.now(), finalizedAt: Date.now() })
      .where(eq(moveCleanups.id, cleanup.id))
      .run();
    ctx.warn(`"${cleanup.siteSlug}" lives on "${old.name}" itself now, so the container, database and files there are its own.`);
    return;
  }
  // The site that left, by its id: one of the same name made since is another site.
  const owner = s.db.select().from(sites).where(eq(sites.id, cleanup.siteId)).get();
  ctx.info(`Stopping the old copy of "${cleanup.siteSlug}" on "${old.name}"…`);
  await removeSiteContainers(old.docker, cleanup.containerName, owner && isContainerApp(owner) ? { volumes: true } : undefined);
  const forwardTo = owner && !isExternal(owner) && cleanup.targetServerId !== 0 ? owner : null;
  if (!forwardTo) {
    // Teardown first: a handover is only done once nothing of the copy is left, so one that fails
    // part-way is tried again the next time.
    await finalizeCleanup(ctx, s, cleanup);
    s.db.update(moveCleanups).set({ handover: 'done', handedOverAt: Date.now() }).where(eq(moveCleanups.id, cleanup.id)).run();
    ctx.info(`The site was deleted meanwhile, so its old copy on "${old.name}" is removed now.`);
    return;
  }
  // Where the site lives now, which a later move or recovery may have changed since this copy was parked.
  const ip = s.servers.rowById(forwardTo.serverId)?.publicIp || cleanup.targetIp;
  await writeForwarding(ctx, s, forwardTo, old, ip);
  s.db
    .update(moveCleanups)
    .set({
      handover: 'done',
      handedOverAt: Date.now(),
      targetServerId: forwardTo.serverId,
      targetIp: ip,
      verifyHosts: JSON.stringify(siteDomains(forwardTo)),
    })
    .where(eq(moveCleanups.id, cleanup.id))
    .run();
  void s.security.kick(old.id);
  if (isContainerApp(forwardTo)) void s.appRoutes.kick(old.id);
  void s.ftp.kick(old.id);
  ctx.info(
    `The old copy on "${old.name}" is stopped, and its visitors go to the site's server. Its files and ` +
      'database are kept a day: anything written there after the backup is still in them until then.',
  );
}

/**
 * The image a container app comes back on, on the target. The backup's, when it is the one the app
 * runs: its settings fit it, its port and its user. Another one would need them read from the
 * image as a deploy reads them, so the app comes back on the image it runs, with the backup's files
 * and databases, and a restore of that backup afterwards brings its image back as restores do.
 */
async function recoveryImage(ctx: JobContext<unknown>, s: CoreServices, target: ServerHandle, site: SiteRow, manifest: unknown): Promise<PlacedImage> {
  const rows = appRows(s.db, site.id);
  if (!rows) throw new Error(`"${site.slug}" has no settings: delete it and create it again.`);
  const now = rows.settings;
  const c = (manifest as { container?: { digest?: string; imageId?: string } } | null)?.container;
  const same = c ? (c.digest ? c.digest === now.digest : Boolean(c.imageId) && c.imageId === now.imageId) : false;
  if (same) return backupImage(ctx, s, target, site, manifest);
  ctx.warn(
    c
      ? 'The backup was taken on another image than the app runs now. It comes back on the one it runs, with the backup\'s files and databases. Restore the backup afterwards to go back to its image.'
      : 'The backup names no image: the app comes back on the one it runs.',
  );
  if (now.source === 'registry' && now.reference && now.digest) {
    const ref = pinned(now.reference, now.digest);
    if (await target.docker.imageExists(ref)) return { ref, reference: now.reference, digest: now.digest, imageId: now.imageId, port: now.port };
    ctx.info(`Pulling the app's image, ${now.digest.slice(0, 19)}…, onto "${target.name}" by its digest…`);
    const pulled = await pullPinned(target, now.reference, now.digest, pullAuthFor(now, now.reference), (line) => ctx.info(line));
    return { ref: pulled.ref, reference: now.reference, digest: pulled.digest, imageId: pulled.imageId, port: now.port };
  }
  if (now.imageId && (await target.docker.imageExists(now.imageId))) return { ref: now.imageId, reference: '', digest: '', imageId: now.imageId, port: now.port };
  throw new Error(`The app's image was uploaded, and it is not on "${target.name}". Upload it again, then recover. Nothing was changed.`);
}

/**
 * Queue the handover of every recovered site whose old server answers again, once each. Called when
 * a server answers after it did not, at boot, and by the nightly housekeeping. Returns how many it queued.
 */
export function queueHandovers(s: CoreServices, serverId?: number, opts: { answered?: boolean } = {}): number {
  const pending = s.db
    .select()
    .from(moveCleanups)
    .where(
      and(
        eq(moveCleanups.status, 'pending'),
        eq(moveCleanups.handover, 'pending'),
        serverId === undefined ? undefined : eq(moveCleanups.sourceServerId, serverId),
      ),
    )
    .all();
  let queued = 0;
  for (const cleanup of pending) {
    const server = s.servers.rowById(cleanup.sourceServerId);
    if (!server || (server.status !== 'ok' && !opts.answered)) continue;
    const waiting = s.db
      .select({ id: jobs.id, payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.type, 'site.recoverHandover'), inArray(jobs.status, ['queued', 'running'])))
      .all()
      .some((job) => (JSON.parse(job.payload) as { cleanupId?: number }).cleanupId === cleanup.id);
    if (waiting) continue;
    s.worker.enqueue('site.recoverHandover', { cleanupId: cleanup.id }, undefined, {
      serverId: cleanup.sourceServerId,
      siteSlug: cleanup.siteSlug,
    });
    queued++;
  }
  return queued;
}

/**
 * At boot and every night: ask each server that is still owed a handover whether it answers,
 * whatever its row says, and queue what it is owed. Its row can say unreachable while the server
 * stats schedule is paused, or error after a failed update, and then nothing else asks it.
 */
export async function queueDueHandovers(s: CoreServices): Promise<number> {
  const owing = new Set(
    s.db
      .select({ serverId: moveCleanups.sourceServerId })
      .from(moveCleanups)
      .where(and(eq(moveCleanups.status, 'pending'), eq(moveCleanups.handover, 'pending')))
      .all()
      .map((row) => row.serverId),
  );
  let queued = 0;
  for (const serverId of owing) {
    const row = s.servers.rowById(serverId);
    if (!row) continue;
    if (row.status !== 'ok' && !(await serverAnswers(s, serverId))) continue;
    queued += queueHandovers(s, serverId, { answered: true });
  }
  return queued;
}
