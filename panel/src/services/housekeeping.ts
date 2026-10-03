import dns from 'node:dns/promises';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { batches, jobs, moveCleanups, serverStats, sessions, siteStats } from '../db/schema.js';
import type { JobWorker } from '../jobs/worker.js';
import { ApiActivityService } from './apiActivity.js';
import { pruneOAuth } from './oauth.js';
import type { CoreServices } from './index.js';

/**
 * The nightly pruning run, as the `system.housekeeping` job (queued at 04:00 by the
 * `housekeeping` schedule, or by "Run now"). It used to run inline in the scheduler, where
 * all anyone ever saw of it was a few lines in `docker logs`; as a job its steps are in the
 * Jobs list, with a log and an outcome.
 */

export type Resolver = (host: string) => Promise<string[]>;

export interface HousekeepingLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface HousekeepingResolvers {
  resolve4?: Resolver;
  resolve6?: Resolver;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runHousekeeping(
  s: CoreServices,
  log: HousekeepingLog,
  checkCanceled: () => void = () => undefined,
  resolvers: HousekeepingResolvers = {},
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  const retention = s.settings.get('backupRetention') || 10;
  const { deleted, offsiteOnly } = await s.backup.prune(retention);
  result.backupsPruned = deleted;
  log.info(
    deleted > 0
      ? `Backup retention: removed ${deleted} old scheduled backups (keeping ${retention} per site)`
      : `Backup retention: nothing to remove (keeping ${retention} per site)`,
  );
  if (offsiteOnly > 0) {
    log.info(
      `Backup retention: ${offsiteOnly} backup(s) past local retention kept as offsite-only ` +
        `(their files were removed, the offsite copies remain)`,
    );
  }
  checkCanceled();

  // After the local prune, never before: an offsite copy is what allows a local file to
  // be dropped, so removing it first would turn a pruned backup into a deleted one.
  const purged = await s.offsite.applyRetention().catch((err: unknown) => {
    log.warn(`Offsite retention failed: ${errorText(err)}`);
    return 0;
  });
  result.offsiteCopiesPurged = purged;
  if (purged > 0) log.info(`Offsite retention: removed ${purged} old copies`);
  await s.offsite.alertOnFailures().catch(() => undefined);
  await s.backup.gcSafetyCopies();
  checkCanceled();

  result.movesFinalized = await autoFinalizeMoves(s, s.worker, log, resolvers);
  checkCanceled();

  const statsCutoff = Date.now() - (s.settings.get('monitorRetentionDays') || 7) * 24 * 3600_000;
  s.db.delete(siteStats).where(lt(siteStats.ts, statsCutoff)).run();
  s.db.delete(serverStats).where(lt(serverStats.ts, statsCutoff)).run();

  const mailRemoved = s.mail.prune(s.settings.get('mailRetentionDays') || 30);
  result.mailRowsPruned = mailRemoved;
  if (mailRemoved > 0) log.info(`Mail retention: removed ${mailRemoved} old traffic rows`);

  // Retention plus the row cap, which is what stops one client polling every second
  // from turning "keep 90 days" into a multi-million-row table inside the nightly
  // panel snapshot.
  const apiRemoved = new ApiActivityService(s.db).prune(s.settings.get('apiActivityRetentionDays') || 30);
  result.apiRequestsPruned = apiRemoved;
  if (apiRemoved > 0) log.info(`API activity retention: removed ${apiRemoved} old request rows`);

  // Blocked requests follow the statistics' retention, and their addresses the statistics'
  // address retention; ended blocks go after `security.historyDays`.
  const securityRemoved = s.securityEvents.prune() + s.blocklist.prune();
  result.securityRowsPruned = securityRemoved;
  if (securityRemoved > 0) log.info(`Security retention: removed or blanked ${securityRemoved} old rows`);

  // Malware scans: each site keeps its last hundred scans and a year of resolved findings;
  // quarantined copies go after `scan.quarantineKeepDays`, and 0 keeps them until deleted.
  const scansRemoved = s.malwareScan.prune();
  const quarantineRemoved = await s.quarantine.prune(s.settings.get('scanQuarantineKeepDays') || 0);
  result.scanRowsPruned = scansRemoved;
  result.quarantineDeleted = quarantineRemoved;
  if (scansRemoved > 0) log.info(`Malware scan history: removed ${scansRemoved} old rows`);
  if (quarantineRemoved > 0) log.info(`Quarantine: deleted ${quarantineRemoved} copies past their keep period`);
  checkCanceled();

  // MCP sign-in: expired tokens, connections left with none, apps nobody approved or used.
  const oauthRemoved = pruneOAuth(s.db);
  result.oauthRowsPruned = oauthRemoved;
  if (oauthRemoved > 0) log.info(`MCP sign-in: removed ${oauthRemoved} expired tokens, idle connections and unused apps`);

  const trafficRemoved = s.traffic.prune(
    s.settings.get('trafficRetentionDays') || 90,
    s.settings.get('trafficIpRetentionDays') || 7,
  );
  result.trafficRowsPruned = trafficRemoved;
  if (trafficRemoved > 0) log.info(`Visitor statistics retention: removed ${trafficRemoved} old rows`);
  checkCanceled();

  // Weekly, off the back of the nightly run rather than on a timer of its own: a
  // registry having a bad day just means tomorrow night tries again.
  if (await s.geoip.isStale()) {
    log.info('Refreshing the GeoIP database…');
    await s.geoip.refresh();
  }
  // The published ranges - Cloudflare's, Jetpack's, the AI assistants' - on the same weekly
  // footing. A failed fetch keeps the last good copy - or the one this version shipped with -
  // so nothing stops working.
  if (s.proxyRanges.isStale()) {
    const ranges = await s.proxyRanges.refresh();
    if (ranges.refreshed.length > 0) log.info(`Published address ranges refreshed: ${ranges.refreshed.join(', ')}`);
    if (ranges.failed.length > 0) log.warn(`Published address ranges not refreshed: ${ranges.failed.join(', ')} (the previous copy stays in use)`);
  }

  // Keep the vulnerability verdicts current even if today's scans were cancelled: a new
  // advisory against a version nobody upgraded still has to show up. Then forget the
  // slugs no site has installed any more.
  if (s.vulnerabilities.enabled) {
    const feed = await s.vulnerabilities.refreshReferenced();
    if (feed.fetched > 0 || feed.failed > 0) {
      log.info(`Vulnerability feed: ${feed.fetched} slug(s) refreshed${feed.failed > 0 ? `, ${feed.failed} failed` : ''}`);
    }
    if (feed.fetched > 0) s.wpInventory.recount();
  }
  const forgotten = s.vulnerabilities.pruneUnreferenced();
  if (forgotten > 0) log.info(`Vulnerability feed: dropped ${forgotten} unreferenced slug(s)`);
  checkCanceled();

  const retentionDays = s.settings.get('jobsRetentionDays') || 90;
  const jobsCutoff = Date.now() - retentionDays * 24 * 3600_000;
  const jobsRemoved = s.db
    .delete(jobs)
    .where(and(inArray(jobs.status, ['succeeded', 'failed', 'canceled']), lt(jobs.finishedAt, jobsCutoff)))
    .run().changes;
  result.jobsPruned = jobsRemoved;
  if (jobsRemoved > 0) log.info(`Job retention: removed ${jobsRemoved} finished job(s) older than ${retentionDays} days`);
  // A bulk run is only its jobs; once retention has taken those, the batch row is an empty
  // shell that would sit in "Recent bulk runs" forever showing nothing.
  s.db
    .delete(batches)
    .where(sql`not exists (select 1 from jobs where jobs.batch_id = ${batches.id})`)
    .run();

  s.db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
  log.info('Housekeeping done.');
  return result;
}

/**
 * Tear down the parked source copy of moved sites once every hostname resolves ONLY to
 * the target IP and the move is at least 24h old (resolver caches). Returns how many
 * finalize jobs it queued.
 */
export async function autoFinalizeMoves(
  s: CoreServices,
  worker: JobWorker,
  log: HousekeepingLog,
  resolvers: HousekeepingResolvers = {},
): Promise<number> {
  const resolve4 = resolvers.resolve4 ?? ((h: string) => dns.resolve4(h));
  const resolve6 = resolvers.resolve6 ?? ((h: string) => dns.resolve6(h));
  const pending = s.db.select().from(moveCleanups).where(eq(moveCleanups.status, 'pending')).all();
  const minAge = Date.now() - 24 * 3600_000;
  let queued = 0;
  for (const cleanup of pending) {
    if (cleanup.createdAt > minAge) continue;
    // move_cleanups deliberately has no FK on source_server_id. Registering a job for a
    // server row that is gone would just fail every night, so say so once per run and
    // leave the record for a human.
    if (!s.servers.rowById(cleanup.sourceServerId)) {
      log.warn(
        `Move cleanup #${cleanup.id} for "${cleanup.siteSlug}" points at server ` +
          `#${cleanup.sourceServerId}, which no longer exists - clean that machine up by hand ` +
          `(docs/multi-server.md) and delete the cleanup record.`,
      );
      continue;
    }
    const hosts = JSON.parse(cleanup.verifyHosts) as string[];
    let allPointAtTarget = true;
    for (const host of hosts) {
      const a = await resolve4(host).catch(() => [] as string[]);
      // "Includes the target" was not enough: an answer that still lists the old address
      // as well keeps sending some clients to the copy about to be destroyed. And a host
      // with AAAA records is served over IPv6 by whatever they point at, which the panel
      // cannot verify (servers are registered by IPv4 only) - leave it to "Finalize move".
      const aaaa = await resolve6(host).catch(() => [] as string[]);
      if (a.length === 0 || a.some((ip) => ip !== cleanup.targetIp) || aaaa.length > 0) {
        allPointAtTarget = false;
        break;
      }
    }
    if (!allPointAtTarget) continue;
    try {
      worker.enqueue(
        'site.moveFinalize',
        { cleanupId: cleanup.id },
        { id: cleanup.siteId, slug: cleanup.siteSlug, serverId: cleanup.sourceServerId },
        { serverId: cleanup.sourceServerId },
      );
      queued++;
      log.info(`Move cleanup for "${cleanup.siteSlug}" queued (DNS verified on target)`);
    } catch {
      /* site busy with another job; the next run retries */
    }
  }
  return queued;
}
