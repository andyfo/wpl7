import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { backups, moveCleanups, sites, type MoveCleanupRow } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { buildSiteContainerSpec, sitePaths, siteRuntimeFrom, siteTlsFor } from '../../services/siteSpec.js';
import { ensureSiteNetwork, removeSiteNetwork } from '../../services/siteNetwork.js';
import {
  ensureSiteMountSources,
  loadSite,
  probeSite,
  runLicenseHook,
  siteDomains,
  siteUrl,
  startSiteContainer,
  syncRelayAuth,
  updateSiteRow,
  writeSiteJson,
} from './shared.js';
import { ensureSiteImage } from './sites.js';
import { pipeBetweenServers, proxyConfigPathFor, proxyConfigYaml, rmOn } from './moveHelpers.js';

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
  const paths = sitePaths(s.config, site.slug);
  const domains = siteDomains(site);
  const primary = domains[0]!;
  const customHosts = domains.filter((d) => !(site.devHostname && d === site.devHostname));

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
  let releaseProtection: (() => void) | null = null;
  try {
    // ------------------------------------------------------------ 0: preflight
    ctx.info(`Moving "${site.slug}" from "${source.name}" to "${target.name}"…`);
    const alive = await target.exec.run('true', [], { timeoutMs: 30_000 });
    if (alive.exitCode !== 0) throw new Error(`Target server check failed: ${alive.stderr.trim().slice(0, 200)}`);
    if ((await target.docker.containerState('wpl7-mariadb')) !== 'running') {
      throw new Error(`MariaDB is not running on "${target.name}"`);
    }

    // Leftovers from a previous failed attempt are provably garbage (slugs are unique).
    if ((await target.docker.containerState(site.containerName)) !== 'missing') {
      ctx.warn(`Removing leftover container ${site.containerName} on "${target.name}" (previous attempt)`);
      await target.docker.removeContainer(site.containerName);
    }
    if (await target.files.exists(paths.root)) {
      ctx.warn(`Removing leftover files on "${target.name}" (previous attempt)`);
      await rmOn(target, s.config.paths.sites, site.slug);
    }
    await target.dbAdmin.dropSiteDb(site.dbName, site.dbUser);
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

    await ensureSiteImage(ctx, target, s.config, site.phpVersion);
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
      await source.docker.stopContainer(site.containerName);
      quiesced = true;
      ctx.pushCompensation('restart source container', async () => {
        await startSiteContainer(source, s, site, ctx);
      });
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
    ctx.info('Restoring files on the target…');
    await target.files.mkdirp(paths.root);
    ctx.pushCompensation('remove site files on target', async () => {
      await rmOn(target, s.config.paths.sites, site.slug);
    });
    const untar = await target.exec.run('tar', ['-xzf', path.join(finalDir, 'files.tar.gz'), '-C', paths.root], {
      timeoutMs: 60 * 60_000,
    });
    if (untar.exitCode !== 0) throw new Error(`File extraction failed: ${untar.stderr.slice(0, 300)}`);
    if (!(await target.files.exists(path.join(paths.wordpress, 'wp-config.php')))) {
      throw new Error('Extracted tree has no wordpress/wp-config.php');
    }
    // The archive carries the site's config directory, but one taken before these mounts
    // existed does not - and a bind mount with no source on the target costs the site its
    // container there (see ensureSiteMountSources).
    await ensureSiteMountSources(target, s, site, ctx);
    await s.backup.chownWordpress(target, site.slug, (l, m) => ctx.log(l, m));

    // Quarantined files travel with the site: they are restorable, and evidence. Not in the
    // snapshot - a backup restores a site's files, and must never put these back among them.
    if (await source.files.exists(paths.quarantine)) {
      ctx.info('Copying the quarantined files to the target…');
      await pipeBetweenServers({
        source,
        sourceCmd: ['tar', ['-C', paths.root, '-cf', '-', 'quarantine']],
        target,
        targetCmd: ['tar', ['-xpf', '-', '-C', paths.root]],
        timeoutMs: 30 * 60_000,
      });
    }

    ctx.info(`Creating database ${site.dbName} on the target…`);
    await target.dbAdmin.createSiteDb(site.dbName, site.dbUser, site.dbPassword);
    ctx.pushCompensation('drop database on target', async () => {
      await target.dbAdmin.dropSiteDb(site.dbName, site.dbUser);
    });
    ctx.info('Importing the database…');
    await target.dbAdmin.importFrom(path.join(finalDir, 'db.sql.gz'), site.dbName);
    ctx.checkCanceled();

    ctx.info('Creating the site network on the target…');
    ctx.pushCompensation('remove site network on target', () => removeSiteNetwork(target.docker, site.slug));
    const attached = await ensureSiteNetwork(target.docker, site.slug);
    if (attached.missing.length > 0) {
      ctx.warn(`Not attached to the site network on "${target.name}": ${attached.missing.join(', ')}.`);
    }
    // The snapshot carried the site's msmtp credential across, but a target that has never
    // seen this site has no matching SASL login yet - without this, wp_mail() on the new
    // server authenticates against nothing.
    await syncRelayAuth(ctx, s, site.slug);

    ctx.info('Starting the site on the target…');
    releaseProtection = s.security.pin(target.id, site.id);
    await s.security.kick(target.id);
    await target.docker.createSiteContainer(
      buildSiteContainerSpec(s.config, site, domains, siteTlsFor(s.dns, target.row), siteRuntimeFrom(s.settings)),
    );
    ctx.pushCompensation('remove container on target', async () => {
      await target.docker.removeContainer(site.containerName);
    });
    await startSiteContainer(target, s, site, ctx);

    if (p.quiesce === 'maintenance' && quiesced) {
      // The .maintenance marker traveled with the files; clear it on the target.
      // (The source stays frozen - it is removed or proxied at cutover.)
      await target.wp
        .maintenance(site.containerName, false)
        .catch((err) => ctx.warn(`Could not clear maintenance mode on the target: ${errMsg(err)}`));
    }

    // Hostnames are unchanged, so no URL rewrite is needed; guard stays for safety.
    const manifestPrimary = domains[0];
    if (manifestPrimary && manifestPrimary !== primary) {
      const oldUrl = siteUrl(s.config, manifestPrimary);
      const newUrl = siteUrl(s.config, primary);
      await target.wp.optionUpdate(site.containerName, 'home', newUrl);
      await target.wp.optionUpdate(site.containerName, 'siteurl', newUrl);
      await target.wp.searchReplace(site.containerName, oldUrl, newUrl);
      await runLicenseHook(ctx, s, target, site, 'afterUrlChange', { url: newUrl, oldUrl, newUrl });
    }

    ctx.info(wasStopped ? 'Probing the site on the target (it is started briefly for this)…' : 'Probing the site on the target…');
    if (s.config.nodeEnv === 'test') {
      // No live HTTP in unit tests; the container state is the gate there.
      const state = await target.docker.containerState(site.containerName);
      if (state !== 'running') throw new Error('Site container is not running on the target - rolling back');
    } else {
      const up = await probeSite(target, site.containerName, primary, Math.max(s.config.probeTimeoutMs, 60_000));
      if (!up) throw new Error('Site did not answer on the target - rolling back (source untouched)');
    }
    ctx.checkCanceled(); // last cancel point - beyond here the move commits

    if (wasStopped) {
      ctx.info('Site was stopped before the move; stopping it again on the target…');
      await target.docker.stopContainer(site.containerName);
    }

    // ------------------------------------------------------------ 5: cutover
    // The old server keeps answering for EVERY hostname (dev alias included) and forwards to
    // the new one until the deferred cleanup removes the forwarder - see decommission above.
    const proxyPath = proxyConfigPathFor(s.config.srvRoot, site.slug);
    let cleanupId = 0;
    s.db.transaction(() => {
      updateSiteRow(s.db, site.id, { serverId: p.targetServerId });
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
    await writeSiteJson(target, s.config, site);
    // The row points at the target now: the pin is redundant there, and the source's file goes.
    releaseProtection?.();
    releaseProtection = null;
    await s.security.kick(p.sourceServerId);

    const dns = { updated: [] as string[], manual: [] as { host: string; ip: string }[] };
    if (site.devHostname && !s.dns.enabled) {
      // Silence here used to mean the dev hostname kept resolving to the old server right
      // up until finalizeCleanup destroyed it.
      const wildcardServerId = s.settings.get('dnsWildcardServerId') ?? 1;
      if (p.targetServerId !== wildcardServerId) {
        dns.manual.push({ host: site.devHostname, ip: target.row.publicIp });
        ctx.warn(
          `DNS management is off, so ${site.devHostname} still points at "${source.name}". ` +
            `Create an A record to ${target.row.publicIp}; the old server forwards traffic until then.`,
        );
      }
    }
    if (site.devHostname && s.dns.enabled) {
      const wildcardServerId = s.settings.get('dnsWildcardServerId') ?? 1;
      try {
        if (p.targetServerId === wildcardServerId) {
          await s.dns.deleteA(site.devHostname); // wildcard covers it again
          dns.updated.push(site.devHostname);
          ctx.info(`DNS: removed explicit record for ${site.devHostname} (wildcard server covers it)`);
        } else if (target.row.publicIp) {
          const res = await s.dns.upsertA(site.devHostname, target.row.publicIp);
          if (res === 'updated') {
            dns.updated.push(site.devHostname);
            ctx.info(`DNS: ${site.devHostname} -> ${target.row.publicIp}`);
          } else {
            dns.manual.push({ host: site.devHostname, ip: target.row.publicIp });
          }
        }
      } catch (err) {
        ctx.error(`DNS update for ${site.devHostname} failed (fix manually): ${errMsg(err)}`);
        dns.manual.push({ host: site.devHostname, ip: target.row.publicIp });
      }
    }
    for (const host of customHosts) {
      if (s.dns.enabled && target.row.publicIp && (await s.dns.canManage(host))) {
        try {
          await s.dns.upsertA(host, target.row.publicIp);
          dns.updated.push(host);
          ctx.info(`DNS: ${host} -> ${target.row.publicIp}`);
          continue;
        } catch (err) {
          ctx.error(`DNS update for ${host} failed: ${errMsg(err)}`);
        }
      }
      dns.manual.push({ host, ip: target.row.publicIp });
    }
    if (dns.manual.length > 0) {
      ctx.warn(
        `Update these A records to ${target.row.publicIp}: ${dns.manual.map((d) => d.host).join(', ')}` +
          (s.config.mailMode === 'direct' ? ' - and add the new server IP to their SPF records (docs/dns.md).' : ''),
      );
    }

    // ------------------------------------------------------------ 6: source handover
    // Traefik on the old server keeps terminating TLS for all of the site's hostnames and
    // forwards to the new server: clients on cached DNS answers, and hostnames whose records
    // were not (or could not be) updated, keep working until the deferred cleanup runs.
    ctx.info('Old server will forward traffic to the new one until DNS has moved…');
    try {
      await source.files.mkdirp(path.dirname(proxyPath));
      await source.files.writeFile(
        proxyPath,
        proxyConfigYaml({
          slug: site.slug,
          hosts: domains,
          targetIp: target.row.publicIp,
          tlsMode: s.config.tlsMode,
          acmeResolver: s.config.acmeResolver,
          devDomain: source.row.devDomain,
          dnsProvider: s.dns.wildcardProvider(source.row.dnsProvider),
        }),
      );
    } catch (err) {
      ctx.warn(
        `Could not write the forwarding config on the source (${errMsg(err)}); ` +
          `stragglers on old DNS will get errors until it propagates.`,
      );
    }
    stopKeepalive();
    try {
      await source.docker.removeContainer(site.containerName);
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
    ctx.info('Target rolled back; the site keeps running on the source. Re-running the move is safe.');
    throw err;
  } finally {
    stopKeepalive();
    s.monitor.busySlugs.delete(site.slug);
    resumeFtp?.();
    // Rolled back: the target serves nothing of this site, so it keeps no rules for it.
    if (releaseProtection) {
      releaseProtection();
      await s.security.kick(p.targetServerId);
    }
  }
}

function insertStagedBackupRow(
  s: CoreServices,
  site: ReturnType<typeof loadSite>,
  target: ServerHandle,
  snapshot: { sizeBytes: number | null; wpVersion: string | null },
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
  const owner = s.db.select().from(sites).where(eq(sites.slug, cleanup.siteSlug)).get();
  if (owner && owner.serverId === cleanup.sourceServerId) {
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
  await source.docker.removeContainer(cleanup.containerName);
  await source.dbAdmin.dropSiteDb(cleanup.dbName, cleanup.dbUser);
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
