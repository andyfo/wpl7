// @docs integrations/cloudflare, integrations/dns, sites/move
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appRoutes, appSettings, backups, moveCleanups, sites, type MoveCleanupRow } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { assertPhpImage, sitePaths, siteImage } from '../../services/siteSpec.js';
import { APP_MOVES_STOPPED, PHP_NO_MAINTENANCE, hasDatabase, isContainerApp, isPhpSite } from '../../lib/siteKind.js';
import { removeSiteNetwork } from '../../services/siteNetwork.js';
import { loadSite, removeSiteContainers, siteDomains, siteUrl, startSiteContainer, stopGraceOf, updateSiteRow, writeSiteJson } from './shared.js';
import { ensureSiteImage } from './sites.js';
import { pipeBetweenServers, proxyConfigPathFor, rmOn } from './moveHelpers.js';
import { repointSiteDns, writeForwarding } from './siteHandover.js';
import { extraDbFile } from '../../services/backup.js';
import { parseNames } from '../../services/databases.js';
import { restoreSiteOnServer, type ProtectionHold } from './restoreSite.js';
import { carryAppImage, cleanAppImages, mountsOutOfBackups } from './apps.js';
import { appRows } from '../../services/appSpec.js';

export const siteMovePayload = z.object({
  siteId: z.number().int(),
  sourceServerId: z.number().int(),
  targetServerId: z.number().int(),
  quiesce: z.enum(['maintenance', 'stop', 'none']),
  /**
   * Accepted for jobs queued by older panel versions; it no longer changes behaviour. The
   * source copy is ALWAYS torn down later (daily DNS verification, or "Finalize move"), never
   * inside this job: resolvers keep handing out the old address for a while after ANY record
   * change, managed or not, and unmanaged/failed records keep pointing at the old server until
   * someone fixes them.
   */
  decommission: z.enum(['auto', 'deferred']).default('deferred'),
});

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** WordPress ignores a .maintenance marker older than 10 minutes; re-arm well inside that. */
const MAINTENANCE_REFRESH_MS = 5 * 60_000;
/** A marker only stops NEW requests; give in-flight ones a moment before the snapshot. */
const DRAIN_MS = 3000;

/**
 * Move a site between servers. Hostnames never change (DNS records flip instead), so
 * no URL rewriting is needed. The source is never touched destructively before the
 * target passes its probe; a failure at any point rolls the target back and resumes
 * the source. Re-running after a failure is the designed recovery path - preflight
 * removes any leftovers of a previous attempt on the target.
 */
export async function siteMove(ctx: JobContext<z.infer<typeof siteMovePayload>>, s: CoreServices): Promise<void> {
  const p = ctx.payload;
  let site = loadSite(s.db, p.siteId);
  if (site.serverId !== p.sourceServerId) {
    throw new Error(`Site "${site.slug}" is on server #${site.serverId}, not #${p.sourceServerId} - re-run the move`);
  }
  const source = s.servers.handleFor(p.sourceServerId);
  const target = s.servers.handleFor(p.targetServerId);
  // Maintenance mode is WordPress's: a PHP site freezes by stopping, or not at all.
  if (p.quiesce === 'maintenance' && site.app !== 'wordpress') throw new Error(isPhpSite(site) ? PHP_NO_MAINTENANCE(site.slug) : APP_MOVES_STOPPED(site.slug));
  if (p.quiesce === 'none' && isContainerApp(site)) throw new Error(APP_MOVES_STOPPED(site.slug));
  // Its drop-in would stay behind with no Redis to talk to, and no wp-cache.php to say what to do then.
  if (site.objectCache === 1 && (await target.docker.imageStack(siteImage(site.phpVersion))) === 1) {
    throw new Error(`"${target.name}" has no object cache yet, because it still has the old site image. Update that server first, or switch this site's object cache off.`);
  }
  const paths = sitePaths(s.config, site.slug);
  const domains = siteDomains(site);
  const primary = domains[0]!;

  s.monitor.busySlugs.add(site.slug);
  let quiesced = false;
  let committed = false;
  let keepalive: NodeJS.Timeout | null = null;
  const stopKeepalive = (): void => {
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
  };
  // A stopped site must come back stopped: the target container has to run for the probe,
  // so remember what to restore after cutover.
  const wasStopped = site.status === 'stopped';
  let resumeFtp: (() => void) | null = null;
  // The site's rules on the target, from before it starts there until the row says it lives
  // there - the moment the source's go (docs/security.md).
  const protection: ProtectionHold = { release: null };
  try {
    // ------------------------------------------------------------ 0: preflight
    ctx.info(`Moving "${site.slug}" from "${source.name}" to "${target.name}"…`);
    const alive = await target.exec.run('true', [], { timeoutMs: 30_000 });
    if (alive.exitCode !== 0) throw new Error(`Target server check failed: ${alive.stderr.trim().slice(0, 200)}`);
    if ((await target.docker.containerState('wpl7-mariadb')) !== 'running') {
      throw new Error(`MariaDB is not running on "${target.name}"`);
    }
    // The request asked the target's Traefik too, but a route saved while it waited for the
    // answer was not among the ones it asked about. Routes are frozen from here (AppsService
    // setRoutes refuses an app that is moving), so this is the last word.
    if (isContainerApp(site)) {
      const enabled = s.db.select({ scheme: appRoutes.scheme }).from(appRoutes).where(and(eq(appRoutes.siteId, site.id), eq(appRoutes.enabled, 1))).all();
      await s.apps.assertHttpRoutesOn(p.targetServerId, enabled);
    }

    // Leftovers from a previous failed attempt are provably garbage (slugs are unique).
    if ((await target.docker.containerState(site.containerName)) !== 'missing') {
      ctx.warn(`Removing leftover container ${site.containerName} on "${target.name}" (previous attempt)`);
    }
    await removeSiteContainers(target.docker, site.containerName, isContainerApp(site) ? { volumes: true } : undefined);
    if (await target.files.exists(paths.root)) {
      ctx.warn(`Removing leftover files on "${target.name}" (previous attempt)`);
      await rmOn(target, s.config.paths.sites, site.slug);
    }
    if (hasDatabase(site)) await target.dbAdmin.dropSiteDb(site.dbName, site.dbUser);
    // The site's other databases must land on names that are free there. Unlike its own (named for
    // its unique slug), one of those names on the target is not provably a leftover of this move:
    // it may hold someone's data, so the move stops rather than drop it.
    const extraNames = s.databases.extraNames(site.id);
    if (extraNames.length > 0) {
      const onTarget = new Set((await target.dbAdmin.inventory()).map((r) => r.name));
      const taken = extraNames.filter((n) => onTarget.has(n));
      if (taken.length > 0) {
        throw new Error(
          `"${target.name}" already has a database called ${taken.join(', ')}; ` +
            'delete it under Databases if no site needs it, then move again',
        );
      }
    }
    // Everything the transfer stages goes under the TARGET's backup location, which is not
    // necessarily the source's or the panel's default - that is the whole point of the
    // per-server setting, and a preflight that checked the wrong disk would clear a move
    // onto a full one.
    const targetBackupRoot = s.backup.rootFor(target);
    const staleStaging = (await target.files.readdir(path.join(targetBackupRoot, site.slug))).filter((e) =>
      e.startsWith('staging-'),
    );
    for (const entry of staleStaging) {
      ctx.warn(`Removing leftover staging dir ${entry} on "${target.name}"`);
      await rmOn(target, targetBackupRoot, site.slug, entry);
    }

    const need = (site.diskBytes ?? 0) * 2.5;
    const disk = await target.files.statvfs(targetBackupRoot).catch(() => null);
    if (disk && need > 0 && disk.freeBytes < need) {
      throw new Error(
        `Not enough free disk on "${target.name}": ${Math.round(disk.freeBytes / 1e6)}MB free, ~${Math.round(need / 1e6)}MB needed`,
      );
    }
    if (!disk) ctx.warn('Could not determine free disk space on the target; continuing.');

    // A container app's own image goes to the target first, while the source still serves.
    if (!isContainerApp(site)) await ensureSiteImage(ctx, target, s.config, site.phpVersion);
    const appImage = isContainerApp(site) ? await carryAppImage(ctx, s, source, target, site) : null;
    // Before anything is copied: the target's image may be from before PHP sites.
    if (isPhpSite(site)) await assertPhpImage(target, siteImage(site.phpVersion));
    await target.files.mkdirp(s.config.paths.plugins);
    ctx.checkCanceled();

    // ------------------------------------------------------------ 1: quiesce source
    // FTP stops for the whole move, whatever the quiesce mode: an upload that lands on the
    // source after the snapshot never reaches the target, and nothing would say it was lost.
    // It comes back on whichever server the site ends up on (services/ftp.ts).
    resumeFtp = await s.ftp.suspendSite(site);
    if (s.ftp.hasLogins(site.id)) ctx.info('FTP/SFTP paused until the move is over.');
    if (p.quiesce === 'maintenance') {
      if ((await source.docker.containerState(site.containerName)) === 'running') {
        ctx.info('Enabling maintenance mode on the source (no writes during the copy)…');
        await source.wp.maintenance(site.containerName, true);
        quiesced = true;
        // WordPress stops honouring the .maintenance marker 10 minutes after it was written
        // (wp_is_maintenance_mode), and dump + transfer + verify + restore easily take longer:
        // a single activation silently expired part-way and the source took writes again that
        // never reached the target - lost at cutover. Re-arm the marker for as long as the
        // freeze is ours. Should the panel die mid-move, the marker expires by itself, so the
        // source can never stay dark for good.
        const refreshMs = s.config.nodeEnv === 'test' ? 50 : MAINTENANCE_REFRESH_MS;
        keepalive = setInterval(() => {
          source.wp
            .maintenance(site.containerName, true, { force: true })
            .catch((err) => ctx.warn(`Could not refresh maintenance mode on the source: ${errMsg(err)}`));
        }, refreshMs);
        keepalive.unref();
        ctx.pushCompensation('disable maintenance mode on source', async () => {
          stopKeepalive();
          await source.wp.maintenance(site.containerName, false);
        });
        const drainMs = s.config.nodeEnv === 'test' ? 0 : DRAIN_MS;
        if (drainMs > 0) {
          ctx.info('Letting in-flight requests finish…');
          await sleep(drainMs);
        }
      } else {
        ctx.warn('Source container is not running; skipping maintenance mode.');
      }
    } else if (p.quiesce === 'stop') {
      ctx.info('Stopping the source site…');
      await source.docker.stopContainer(site.containerName, stopGraceOf(s.db, site));
      quiesced = true;
      // Only a site that ran starts again: a stopped one stays as its row says, with no routes.
      if (!wasStopped) {
        ctx.pushCompensation('restart source container', async () => {
          await startSiteContainer(source, s, site, ctx);
        });
      }
    } else {
      ctx.info('Copying while the source keeps serving (writes made during the copy will not transfer).');
    }
    ctx.checkCanceled();

    // ------------------------------------------------------------ 2: snapshot on source
    ctx.info('Taking the transfer snapshot on the source…');
    const snapshot = await s.backup.createOn(source, site, 'move', {
      note: `pre-move to ${target.name}`,
      jobId: ctx.jobId,
      log: (l, m) => ctx.log(l, m),
    });
    ctx.checkCanceled();

    // ------------------------------------------------------------ 3: transfer + verify
    const tsName = snapshot.path.split('/').pop()!;
    const stagingDir = path.join(targetBackupRoot, site.slug, `staging-${tsName}`);
    const finalDir = path.join(targetBackupRoot, site.slug, tsName);
    await target.files.mkdirp(stagingDir, { mode: 0o700 });
    ctx.pushCompensation('remove staged copy on target', async () => {
      await rmOn(target, targetBackupRoot, site.slug, `staging-${tsName}`);
      await rmOn(target, targetBackupRoot, site.slug, tsName);
    });

    ctx.info(`Streaming the snapshot to "${target.name}"…`);
    let lastLogged = 0;
    await pipeBetweenServers({
      source,
      sourceCmd: ['tar', ['-C', snapshot.path, '-cf', '-', '.']], // contents already gzipped
      target,
      targetCmd: ['tar', ['-xf', '-', '-C', stagingDir]],
      timeoutMs: 60 * 60_000,
      onBytes: (total) => {
        if (ctx.cancelRequested) throw new Error('canceled during transfer');
        if (total - lastLogged >= 256 * 1024 * 1024) {
          lastLogged = total;
          ctx.info(`… ${(total / 1024 / 1024).toFixed(0)} MiB transferred`);
        }
      },
    });

    ctx.info('Verifying checksums on the target…');
    const sums = await target.exec.run('sh', ['-c', `cd ${shq(stagingDir)} && exec sha256sum -c --strict sha256sums`], {
      timeoutMs: 30 * 60_000,
    });
    if (sums.exitCode !== 0) throw new Error(`Checksum verification failed: ${sums.stderr.slice(0, 300)}`);
    if (!(await target.files.exists(path.join(stagingDir, 'manifest.json')))) {
      throw new Error('Transferred snapshot is missing manifest.json');
    }
    await target.files.rename(stagingDir, finalDir);
    const stagedBackup = insertStagedBackupRow(s, site, target, snapshot, finalDir);
    ctx.pushCompensation('remove staged backup record', async () => {
      s.db.delete(backups).where(eq(backups.id, stagedBackup.id)).run();
    });
    ctx.info(`Snapshot staged on "${target.name}" (${((snapshot.sizeBytes ?? 0) / 1024 / 1024).toFixed(1)} MiB).`);
    ctx.checkCanceled();

    // ------------------------------------------------------------ 4: restore-as-new on target
    // Hostnames are unchanged, so no URL rewrite is needed.
    await restoreSiteOnServer(
      ctx,
      s,
      target,
      site,
      domains,
      {
        kind: 'archive',
        filesTarGz: path.join(finalDir, 'files.tar.gz'),
        dbSqlGz: hasDatabase(site) ? path.join(finalDir, 'db.sql.gz') : null,
        extraDbs: extraNames.map((name) => ({ name, sqlGz: path.join(finalDir, extraDbFile(name)) })),
        ranOnFpm: (await source.docker.containerStack(site.containerName).catch(() => null))?.stack === 2,
      },
      {
        routing: true,
        requireWpConfig: site.app === 'wordpress',
        protection,
        // Quarantined files travel with the site: they are restorable, and evidence. Not in the
        // snapshot - a backup restores a site's files, and must never put these back among them.
        afterFiles: async () => {
          // A container app's mounts kept out of its backups are not in the snapshot either.
          const unbacked = isContainerApp(site) ? mountsOutOfBackups(s, site) : [];
          if (unbacked.length > 0) {
            ctx.info(`Copying the mounts kept out of backups to the target (${unbacked.join(', ')})…`);
            await pipeBetweenServers({
              source,
              sourceCmd: ['tar', ['-C', paths.root, '-cf', '-', ...unbacked.map((name) => `mounts/${name}`)]],
              target,
              targetCmd: ['tar', ['-xpf', '-', '-C', paths.root]],
              timeoutMs: 60 * 60_000,
            });
          }
          if (!(await source.files.exists(paths.quarantine))) return;
          ctx.info('Copying the quarantined files to the target…');
          await pipeBetweenServers({
            source,
            sourceCmd: ['tar', ['-C', paths.root, '-cf', '-', 'quarantine']],
            target,
            targetCmd: ['tar', ['-xpf', '-', '-C', paths.root]],
            timeoutMs: 30 * 60_000,
          });
        },
        afterStart: async () => {
          if (p.quiesce !== 'maintenance' || !quiesced) return;
          // The .maintenance marker traveled with the files; clear it on the target.
          // (The source stays frozen - it is removed or proxied at cutover.)
          await target.wp
            .maintenance(site.containerName, false)
            .catch((err) => ctx.warn(`Could not clear maintenance mode on the target: ${errMsg(err)}`));
        },
        probe: {
          host: primary,
          timeoutMs: Math.max(s.config.probeTimeoutMs, 60_000),
          message: wasStopped
            ? 'Probing the site on the target (it is started briefly for this)…'
            : 'Probing the site on the target…',
        },
        ...(appImage ? { appImage: appImage.ref } : {}),
      },
    );
    // That was the last cancel point - beyond here the move commits.

    if (wasStopped) {
      ctx.info('Site was stopped before the move; stopping it again on the target…');
      await target.docker.stopContainer(site.containerName, stopGraceOf(s.db, site));
    }

    // ------------------------------------------------------------ 5: cutover
    // The old server keeps answering for EVERY hostname (dev alias included) and forwards to
    // the new one until the deferred cleanup removes the forwarder - see decommission above.
    const proxyPath = proxyConfigPathFor(s.config.srvRoot, site.slug);
    let cleanupId = 0;
    s.db.transaction(() => {
      updateSiteRow(s.db, site.id, { serverId: p.targetServerId });
      // An uploaded image has the id the target gave it; a registry one is the same digest there.
      if (appImage) s.db.update(appSettings).set({ imageId: appImage.imageId, updatedAt: Date.now() }).where(eq(appSettings.siteId, site.id)).run();
      // serverId is the only field that moves; status must survive (a stopped site that
      // came back stopped above would otherwise be listed as running for ever).
      cleanupId = s.db
        .insert(moveCleanups)
        .values({
          siteId: site.id,
          siteSlug: site.slug,
          sourceServerId: p.sourceServerId,
          targetServerId: p.targetServerId,
          containerName: site.containerName,
          dbName: site.dbName,
          dbUser: site.dbUser,
          extraDbs: extraNames.length > 0 ? JSON.stringify(extraNames) : null,
          filesPath: paths.root,
          // Every hostname must resolve to the target before the source copy goes - the dev
          // alias too, or a dev URL whose record was never updated died with the source.
          verifyHosts: JSON.stringify(domains),
          targetIp: target.row.publicIp,
          proxyConfigPath: proxyPath,
          status: 'pending',
          createdAt: Date.now(),
        })
        .returning({ id: moveCleanups.id })
        .get().id;
    });
    ctx.clearCompensations(); // the target is authoritative now - never tear it down below
    committed = true;
    ctx.info(`Cutover committed - "${site.slug}" now lives on "${target.name}".`);
    site = loadSite(s.db, site.id);
    await writeSiteJson(target, s, site);
    // The row points at the target now: the pin is redundant there, and the source's file goes.
    protection.release?.();
    protection.release = null;
    await s.security.kick(p.sourceServerId);
    // An app's routes go with it: written on the target by its row now, taken off the source.
    if (isContainerApp(site)) {
      await s.appRoutes.kick(p.targetServerId);
      await s.appRoutes.kick(p.sourceServerId);
    }

    const dns = await repointSiteDns(ctx, s, site, target, { fromName: source.name });

    // ------------------------------------------------------------ 6: source handover
    // Traefik on the old server keeps terminating TLS for all of the site's hostnames and
    // forwards to the new server: clients on cached DNS answers, and hostnames whose records
    // were not (or could not be) updated, keep working until the deferred cleanup runs.
    ctx.info('Old server will forward traffic to the new one until DNS has moved…');
    await writeForwarding(ctx, s, site, source, target.row.publicIp);
    stopKeepalive();
    try {
      await removeSiteContainers(source.docker, site.containerName, isContainerApp(site) ? { volumes: true } : undefined);
      ctx.info('Source container removed.');
    } catch (err) {
      ctx.warn(`Could not remove the source container (${errMsg(err)}); finalize will retry.`);
    }
    ctx.info(
      'The source copy is kept until every hostname verifiably resolves to the new server and resolver ' +
        'caches have expired (checked daily; or use "Finalize move" on the site page).',
    );

    ctx.setResult({
      slug: site.slug,
      fromServerId: p.sourceServerId,
      toServerId: p.targetServerId,
      url: siteUrl(s.config, primary),
      preMoveBackupId: snapshot.id,
      stagedBackupId: stagedBackup.id,
      cleanupId,
      decommission: 'deferred',
      dns,
    });
    ctx.info('Move complete.');
  } catch (err) {
    ctx.error(`Move failed: ${errMsg(err)}`);
    if (committed) {
      // Past the cutover there is nothing to roll back - the compensations were cleared and
      // the site row already points at the target. Saying "rolled back" here would send the
      // operator looking at the wrong machine.
      ctx.error(
        `The move itself SUCCEEDED - "${site.slug}" is live on "${target.name}" - but a follow-up ` +
          `step (DNS / source handover / cleanup) failed. Nothing was rolled back. Check the DNS ` +
          `records above and use "Finalize move" on the site page once they point at ${target.row.publicIp}.`,
      );
      throw err;
    }
    await ctx.runCompensations();
    ctx.info(`Target rolled back; the site ${wasStopped ? 'stays stopped' : 'keeps running'} on the source. Re-running the move is safe.`);
    throw err;
  } finally {
    stopKeepalive();
    s.monitor.busySlugs.delete(site.slug);
    resumeFtp?.();
    // Rolled back: the target serves nothing of this site, so it keeps no rules for it.
    if (protection.release) {
      protection.release();
      await s.security.kick(p.targetServerId);
      if (isContainerApp(site)) await s.appRoutes.kick(p.targetServerId);
    }
  }
}

function insertStagedBackupRow(
  s: CoreServices,
  site: ReturnType<typeof loadSite>,
  target: ServerHandle,
  snapshot: { sizeBytes: number | null; wpVersion: string | null; hasDatabase: number },
  finalDir: string,
) {
  return s.db
    .insert(backups)
    .values({
      siteId: site.id,
      siteSlug: site.slug,
      serverId: target.id,
      type: 'move',
      status: 'complete',
      path: finalDir,
      rootPath: s.backup.rootFor(target),
      sizeBytes: snapshot.sizeBytes,
      wpVersion: snapshot.wpVersion,
      phpVersion: site.phpVersion,
      // What the snapshot it is a copy of holds: a site without a database has no dump in it.
      hasDatabase: snapshot.hasDatabase,
      note: 'staged copy (move)',
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------

export const siteMoveFinalizePayload = z.object({
  cleanupId: z.number().int(),
});

export async function siteMoveFinalize(
  ctx: JobContext<z.infer<typeof siteMoveFinalizePayload>>,
  s: CoreServices,
): Promise<void> {
  const cleanup = s.db.select().from(moveCleanups).where(eq(moveCleanups.id, ctx.payload.cleanupId)).get();
  if (!cleanup) throw new Error(`Move cleanup #${ctx.payload.cleanupId} not found`);
  if (cleanup.status === 'done') {
    ctx.info('Cleanup already finalized; nothing to do.');
    return;
  }
  await finalizeCleanup(ctx, s, cleanup);
  ctx.setResult({ cleanupId: cleanup.id });
}

/** Absence-tolerant source teardown; safe to re-run. */
export async function finalizeCleanup(ctx: JobContext<unknown>, s: CoreServices, cleanup: MoveCleanupRow): Promise<void> {
  // Resources are addressed by NAME (container, database, directory), and names are reused
  // whenever a slug is re-created. Never tear down what a site currently living on the source
  // server owns: a cleanup that outlived its site would otherwise delete the replacement
  // site's container, database and files.
  // A site hosted elsewhere owns no container, database or folder by its name: only a hosted one counts.
  const owner = s.db.select().from(sites).where(eq(sites.slug, cleanup.siteSlug)).get();
  if (owner && owner.kind !== 'external' && owner.serverId === cleanup.sourceServerId) {
    s.db
      .update(moveCleanups)
      .set({ status: 'done', finalizedAt: Date.now() })
      .where(eq(moveCleanups.id, cleanup.id))
      .run();
    ctx.warn(
      `Skipping move cleanup #${cleanup.id}: "${cleanup.siteSlug}" (site #${owner.id}) now lives on the source ` +
        `server #${cleanup.sourceServerId} itself, so the container, database and files there belong to it.`,
    );
    return;
  }
  const source = s.servers.handleFor(cleanup.sourceServerId);
  ctx.info(`Removing the old copy of "${cleanup.siteSlug}" from "${source.name}"…`);
  // A container app's anonymous volumes (an image VOLUME the panel does not keep) go with it.
  await removeSiteContainers(source.docker, cleanup.containerName, owner && isContainerApp(owner) ? { volumes: true } : undefined);
  // '' for a site that has no database of its own.
  if (cleanup.dbName !== '') await source.dbAdmin.dropSiteDb(cleanup.dbName, cleanup.dbUser);
  for (const name of parseNames(cleanup.extraDbs)) {
    // Its name may since belong to a database of a site on the source server: then it is not ours.
    const claim = s.databases.claimOf(cleanup.sourceServerId, name);
    if (claim && claim.kind !== 'moveCopy') {
      ctx.warn(`Keeping database ${name} on "${source.name}": it belongs to ${claim.slug} now.`);
      continue;
    }
    await source.dbAdmin.dropDb(name);
  }
  // A container app's images there, now that it runs on the other server.
  if (owner && isContainerApp(owner)) {
    const rows = appRows(s.db, owner.id);
    if (rows) await cleanAppImages(ctx, s, source, owner, rows.settings, { all: true }).catch((err: unknown) => ctx.warn(`Could not remove the app's images there: ${errMsg(err)}`));
  }
  await rmOn(source, s.config.paths.sites, cleanup.siteSlug);
  // The network outlives the container it was made for; left behind, every stack redeploy
  // would keep re-attaching Traefik, the relay and MariaDB to a bridge with nothing on it.
  await removeSiteNetwork(source.docker, cleanup.siteSlug);
  if (cleanup.proxyConfigPath) {
    await source.files.rm(cleanup.proxyConfigPath).catch(() => undefined);
  }
  // Nothing of the site is left there, so neither are its rules (the cutover took them away;
  // this catches a sync that failed at the time).
  void s.security.kick(cleanup.sourceServerId);
  s.db
    .update(moveCleanups)
    .set({ status: 'done', finalizedAt: Date.now() })
    .where(eq(moveCleanups.id, cleanup.id))
    .run();
  // After the row says done: until then the source counts the hosts it forwarded (appHttpHosts),
  // and the block list keeps their twins there.
  if (owner && isContainerApp(owner)) void s.appRoutes.kick(cleanup.sourceServerId);
  ctx.info('Source cleanup done.');
}

/** Pending cleanup for a site, if any (drives the SiteDetail banner + delete hook). */
export function pendingCleanupFor(s: CoreServices, siteId: number): MoveCleanupRow | undefined {
  return s.db
    .select()
    .from(moveCleanups)
    .where(and(eq(moveCleanups.siteId, siteId), eq(moveCleanups.status, 'pending')))
    .get();
}
