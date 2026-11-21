// @docs servers/recover, backups/restore
import path from 'node:path';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { backupCopies, backupDestinations, backups, jobs, sites, type BackupRow, type JobRow, type ServerRow, type SiteRow } from '../db/schema.js';
import type { CoreServices } from './index.js';
import { externalSites, hasDatabase, hostedSites, isContainerApp, isExternal } from '../lib/siteKind.js';
import { sitePaths } from './siteSpec.js';
import { assertDomainsFree } from './domainGuard.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { generateSecret } from '../lib/crypto.js';
import { containerName, dbIdentifier } from '../lib/slug.js';
import { jobLabel } from '../../shared/jobTypes.js';
import {
  MAX_BACKUP_KEEP_DAYS,
  TABLE_PREFIX_RE,
  backupBeforeUpdatesValues,
  cpuLimitSchema,
  domainSchema,
  localeSchema,
  memoryLimitMbSchema,
  pidsLimitSchema,
  webRootSchema,
} from '../../shared/schemas.js';
import { parseSiteCacheRules } from '../../shared/cacheRules.js';
import type {
  RecoveryBackupDto,
  RecoveryState,
  RecoveryTargetDto,
  ServerRecoveryDto,
  SiteRecoveryDto,
} from '../../shared/types.js';

/**
 * Recovery: a site comes back from one of its backups on a server it is not on, because its own
 * server does not answer, or on its own server once it is gone from there. The job is
 * `site.recover` (jobs/handlers/recover.ts); this is what decides whether a site may go, from
 * which backup, and onto which servers, for the dialogs and for the job's own preflight.
 *
 * A site that is still where it was never qualifies. Move takes a fresh copy of it and Restore
 * puts one of its backups back in place, and both keep what it has now. A recovery starts from a
 * backup, so anything written since is not in it.
 */

/** How long a server gets to answer before it counts as gone. A connect that hangs gets 5 s more. */
const ANSWER_TIMEOUT_MS = 15_000;
/** The backups the server dialog lists per site: it only offers each site's newest. */
const SERVER_REPORT_BACKUPS = 5;
/** The backups the site dialog lists. */
const SITE_REPORT_BACKUPS = 50;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Whether the server answers now, whatever its row says, which it then says too. Server 1 is the
 * panel's own machine: it always answers.
 */
export async function serverAnswers(s: Pick<CoreServices, 'servers'>, serverId: number): Promise<boolean> {
  const row = s.servers.rowById(serverId);
  if (!row) return false;
  if (row.kind === 'local') return true;
  // A session that is up answers: its keepalives would have closed it within a minute otherwise.
  // A command would queue behind the server's busy channels, and a busy server is not a lost one.
  if (s.servers.sessionUp(serverId)) {
    s.servers.markReachable(serverId);
    return true;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      s.servers.handleFor(serverId).exec.run('true', [], { timeoutMs: ANSWER_TIMEOUT_MS }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ANSWER_TIMEOUT_MS / 1000} s`)), ANSWER_TIMEOUT_MS + 5_000);
      }),
    ]);
    if (res.exitCode !== 0) throw new Error(`exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
    s.servers.markReachable(serverId);
    return true;
  } catch (err) {
    s.servers.markUnreachable(serverId, err instanceof Error ? err : new Error(String(err)));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The database names on a server that answers; null when MariaDB there cannot be asked. */
async function databasesOn(s: CoreServices, serverId: number): Promise<{ names: Set<string> } | { error: string }> {
  try {
    const rows = await s.servers.handleFor(serverId).dbAdmin.inventory();
    return { names: new Set(rows.map((r) => r.name)) };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

/**
 * Whether a site is gone from its server, which answers. With a database of its own: that
 * database is not there, whatever else is (a container made again by hand runs an empty
 * WordPress). Without one: its container and its folder are both gone.
 */
async function missingOn(s: CoreServices, site: SiteRow, dbs: { names: Set<string> } | { error: string }): Promise<boolean | string> {
  if (hasDatabase(site)) {
    if ('error' in dbs) return dbs.error;
    return !dbs.names.has(site.dbName);
  }
  const h = s.servers.handleFor(site.serverId);
  try {
    if ((await h.docker.containerState(site.containerName)) !== 'missing') return false;
    const p = sitePaths(s.config, site.slug);
    return !(await h.files.exists(isContainerApp(site) ? path.join(p.root, 'data') : p.wordpress));
  } catch (err) {
    return errMsg(err);
  }
}

interface StateInput {
  /** Whether the site's server answers, asked once per server by the caller. */
  answers: boolean;
  /** Its server's databases, asked once per server; only when it answers. */
  dbs?: { names: Set<string> } | { error: string };
  /** The job asking, which is the site's active job itself (jobs/handlers/recover.ts). */
  exceptJobId?: number;
}

/** Where a site stands, and why it can't be recovered when it can't. */
export async function siteRecoveryState(
  s: CoreServices,
  site: SiteRow,
  input: StateInput,
): Promise<{ state: RecoveryState; refusal: string | null }> {
  if (isExternal(site)) {
    return { state: 'external', refusal: 'It is hosted elsewhere: only where its backups are kept can change.' };
  }
  if (site.status === 'provisioning' || site.status === 'deleting') {
    return { state: 'busy', refusal: site.status === 'provisioning' ? 'It is being made.' : 'It is being deleted.' };
  }
  const job = s.worker.activeSiteJob(site.id);
  if (job && job.id !== input.exceptJobId) {
    return {
      state: 'busy',
      refusal: `Job #${job.id} (${jobLabel(job.type)}) is ${job.type === 'site.recover' ? 'bringing it back' : 'on it'}. Wait for it, or cancel it under Jobs.`,
    };
  }
  const serverName = s.servers.rowById(site.serverId)?.name ?? `server #${site.serverId}`;
  if (!input.answers) return { state: 'unreachable', refusal: null };
  const missing = await missingOn(s, site, input.dbs ?? (await databasesOn(s, site.serverId)));
  if (typeof missing === 'string') {
    return { state: 'present', refusal: `"${serverName}" answers, but the panel could not check the site there: ${missing}` };
  }
  if (missing) return { state: 'missing', refusal: null };
  return { state: 'present', refusal: `It is still on "${serverName}". Use Change server, or Restore.` };
}

/** A complete backup the site can come back from, with where it can come from. */
export interface UsableBackup {
  row: BackupRow;
  copies: { destinationId: number; name: string }[];
}

/**
 * The site's complete backups that a recovery can use, newest first: each has an offsite copy, or
 * its files on a server. A panel snapshot is not a site's, and one being deleted is left out.
 */
export function usableBackups(s: CoreServices, slug: string, limit = SITE_REPORT_BACKUPS): UsableBackup[] {
  const rows = s.db
    .select()
    .from(backups)
    .where(and(eq(backups.siteSlug, slug), eq(backups.status, 'complete'), ne(backups.type, 'panel')))
    .orderBy(desc(backups.createdAt), desc(backups.id))
    .all();
  if (rows.length === 0) return [];
  const copyRows = s.db
    .select({ backupId: backupCopies.backupId, destinationId: backupCopies.destinationId, name: backupDestinations.name })
    .from(backupCopies)
    .innerJoin(backupDestinations, eq(backupDestinations.id, backupCopies.destinationId))
    .where(and(inArray(backupCopies.backupId, rows.map((r) => r.id)), eq(backupCopies.status, 'complete')))
    .orderBy(asc(backupCopies.destinationId))
    .all();
  const out: UsableBackup[] = [];
  for (const row of rows) {
    try {
      s.backup.assertNotBeingDeleted(row);
    } catch {
      continue;
    }
    const copies = copyRows.filter((c) => c.backupId === row.id).map(({ destinationId, name }) => ({ destinationId, name }));
    if (copies.length === 0 && row.filesPresent !== 1) continue;
    out.push({ row, copies });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Where a backup comes from for a recovery onto `targetServerId`: null for its own files there,
 * a destination id for a copy, undefined when it can't reach that server at all.
 */
export function sourceFor(backup: UsableBackup, targetServerId: number): number | null | undefined {
  if (backup.row.filesPresent === 1 && backup.row.serverId === targetServerId) return null;
  return backup.copies[0]?.destinationId;
}

function targetDto(row: ServerRow): RecoveryTargetDto {
  return { id: row.id, name: row.name, publicIp: row.publicIp };
}

/** The servers a site in `state` can come back on: ok ones, and its own only while it is gone from it. */
function targetsFor(s: CoreServices, siteServerId: number, state: RecoveryState): ServerRow[] {
  return s.servers
    .listRows()
    .filter((row) => row.status === 'ok' && (row.id !== siteServerId || state === 'missing'))
    .sort((a, b) => (a.id === siteServerId ? -1 : b.id === siteServerId ? 1 : a.id - b.id));
}

function backupDto(u: UsableBackup): RecoveryBackupDto {
  return {
    id: u.row.id,
    createdAt: u.row.createdAt,
    type: u.row.type as RecoveryBackupDto['type'],
    sizeBytes: u.row.sizeBytes,
    phpVersion: u.row.phpVersion,
    note: u.row.note,
    copies: u.copies,
    localServerId: u.row.filesPresent === 1 ? u.row.serverId : null,
  };
}

/**
 * The newest `limit`, and besides them the backup each target would get: the newest with a copy,
 * and each server's newest with its files there. The dialog picks among them as the server does
 * (lib/recovery.ts newestFor, sourceFor here), so it says what the button will do.
 */
function reportBackups(s: CoreServices, slug: string, limit: number): UsableBackup[] {
  const all = usableBackups(s, slug, Number.MAX_SAFE_INTEGER);
  const picked = new Set(all.slice(0, limit));
  const copied = all.find((u) => u.copies.length > 0);
  if (copied) picked.add(copied);
  const localOn = new Set<number>();
  for (const u of all) {
    if (u.row.filesPresent !== 1 || localOn.has(u.row.serverId)) continue;
    localOn.add(u.row.serverId);
    picked.add(u);
  }
  return all.filter((u) => picked.has(u));
}

async function siteReport(s: CoreServices, site: SiteRow, input: StateInput, backupLimit: number): Promise<SiteRecoveryDto> {
  const { state, refusal } = await siteRecoveryState(s, site, input);
  const usable = reportBackups(s, site.slug, backupLimit);
  const targets = targetsFor(s, site.serverId, state);
  return {
    slug: site.slug,
    title: site.title,
    app: site.app as SiteRecoveryDto['app'],
    serverId: site.serverId,
    serverName: s.servers.rowById(site.serverId)?.name ?? `server #${site.serverId}`,
    state,
    refusal: refusal ?? (usable.length === 0 ? 'It has no complete backup with an offsite copy.' : null),
    backups: usable.map(backupDto),
    targets: targets.map(targetDto),
  };
}

/** `GET /api/sites/:slug/recovery`. */
export async function siteRecoveryReport(s: CoreServices, site: SiteRow): Promise<SiteRecoveryDto> {
  const answers = isExternal(site) ? false : await serverAnswers(s, site.serverId);
  if (answers) await s.backup.checkFiles(site.serverId).catch(() => undefined);
  return siteReport(s, site, { answers }, SITE_REPORT_BACKUPS);
}

/** `GET /api/servers/:id/recovery`. */
export async function serverRecoveryReport(s: CoreServices, serverId: number): Promise<ServerRecoveryDto> {
  const server = s.servers.rowById(serverId);
  if (!server) throw notFound(`Server #${serverId} not found`);
  const answers = await serverAnswers(s, serverId);
  // Backups that left with a reinstalled disk read as remote only before anyone picks them.
  if (answers) await s.backup.checkFiles(serverId).catch(() => undefined);
  const dbs = answers ? await databasesOn(s, serverId) : undefined;
  const hosted = s.db.select().from(sites).where(and(eq(sites.serverId, serverId), hostedSites())).orderBy(asc(sites.slug)).all();
  const reports: SiteRecoveryDto[] = [];
  for (const site of hosted) reports.push(await siteReport(s, site, { answers, dbs }, SERVER_REPORT_BACKUPS));
  const external = s.db
    .select({ slug: sites.slug, title: sites.title })
    .from(sites)
    .where(and(eq(sites.serverId, serverId), externalSites()))
    .orderBy(asc(sites.slug))
    .all();
  const fresh = s.servers.rowById(serverId) ?? server;
  return {
    server: { id: fresh.id, name: fresh.name, status: fresh.status as ServerRecoveryDto['server']['status'], answers },
    sites: reports,
    external,
    targets: targetsFor(s, serverId, answers ? 'missing' : 'unreachable').map(targetDto),
  };
}

/** What `site.recover` is asked to do. */
export interface RecoverRequest {
  backupId: number;
  /** Omitted: chosen as `sourceFor` chooses. */
  destinationId?: number | null;
  targetServerId: number;
}

/**
 * The target, the backup and where it comes from, checked: what the routes queue and what the job
 * checks again before it changes anything. Throws the 4xx the request deserves.
 */
export function checkRecoverRequest(
  s: CoreServices,
  site: SiteRow,
  state: RecoveryState,
  req: RecoverRequest,
): { target: ServerRow; backup: UsableBackup; destinationId: number | null } {
  const target = s.servers.rowById(req.targetServerId);
  if (!target) throw notFound(`Server #${req.targetServerId} not found`);
  if (target.status !== 'ok') throw conflict(`"${target.name}" is ${target.status}: pick a server that is ok.`);
  if (target.id === site.serverId && state !== 'missing') {
    throw conflict(`"${target.name}" does not answer, so "${site.slug}" can't come back there. Pick another server.`);
  }
  const backup = usableBackups(s, site.slug, Number.MAX_SAFE_INTEGER).find((u) => u.row.id === req.backupId);
  if (!backup) throw badRequest(`Backup #${req.backupId} is not a complete backup of "${site.slug}" with an offsite copy or its files on a server.`);
  let destinationId: number | null | undefined;
  if (req.destinationId === undefined) {
    destinationId = sourceFor(backup, target.id);
  } else if (req.destinationId === null) {
    destinationId = backup.row.filesPresent === 1 && backup.row.serverId === target.id ? null : undefined;
  } else {
    destinationId = backup.copies.some((c) => c.destinationId === req.destinationId) ? req.destinationId : undefined;
  }
  if (destinationId === undefined) {
    throw conflict(
      req.destinationId === undefined || req.destinationId === null
        ? `Backup #${backup.row.id} has no complete offsite copy, and its files are not on "${target.name}".`
        : `Backup #${backup.row.id} has no complete copy at that destination.`,
    );
  }
  return { target, backup, destinationId };
}

/** `POST /api/sites/:slug/recover`: one site, from the backup asked for. */
export async function queueSiteRecovery(s: CoreServices, site: SiteRow, req: RecoverRequest): Promise<JobRow> {
  const answers = isExternal(site) ? false : await serverAnswers(s, site.serverId);
  const { state, refusal } = await siteRecoveryState(s, site, { answers });
  if (refusal) throw conflict(refusal);
  // A backup whose files left with a reinstalled disk must not be picked as one that is there.
  if (s.servers.rowById(req.targetServerId)?.status === 'ok') await s.backup.checkFiles(req.targetServerId).catch(() => undefined);
  const { target, backup, destinationId } = checkRecoverRequest(s, site, state, req);
  return s.worker.enqueue(
    'site.recover',
    { siteId: site.id, backupId: backup.row.id, destinationId, targetServerId: target.id, asNew: false },
    { id: site.id, slug: site.slug },
    { serverId: target.id },
  );
}

/**
 * `POST /api/servers/:id/recover`: every site of the server that can come back on the target, each
 * from its newest backup that reaches it, one job each in the target's lane. The sites hosted
 * elsewhere whose backups the server kept keep them on the target from now on, when the target is
 * another server. What can't go is listed with its reason, and nothing about it changes.
 */
export async function queueServerRecovery(
  s: CoreServices,
  serverId: number,
  body: { targetServerId: number; slugs?: string[] },
): Promise<{ jobs: JobRow[]; skipped: { slug: string; reason: string }[]; external: string[] }> {
  const server = s.servers.rowById(serverId);
  if (!server) throw notFound(`Server #${serverId} not found`);
  const target = s.servers.rowById(body.targetServerId);
  if (!target) throw notFound(`Server #${body.targetServerId} not found`);
  if (target.status !== 'ok') throw conflict(`"${target.name}" is ${target.status}: pick a server that is ok.`);
  const answers = await serverAnswers(s, serverId);
  if (target.id === serverId && !answers) {
    throw conflict(`"${server.name}" does not answer, so its sites can't come back there. Pick another server.`);
  }
  if (answers) await s.backup.checkFiles(serverId).catch(() => undefined);
  if (target.id !== serverId) await s.backup.checkFiles(target.id).catch(() => undefined);
  const dbs = answers ? await databasesOn(s, serverId) : undefined;

  let hosted = s.db.select().from(sites).where(and(eq(sites.serverId, serverId), hostedSites())).orderBy(asc(sites.slug)).all();
  if (body.slugs) {
    const wanted = new Set(body.slugs);
    const keptHere = s.db.select({ slug: sites.slug }).from(sites).where(and(eq(sites.serverId, serverId), externalSites())).all();
    const unknown = body.slugs.filter((slug) => !hosted.some((site) => site.slug === slug) && !keptHere.some((site) => site.slug === slug));
    if (unknown.length > 0) throw badRequest(`Not a site hosted on "${server.name}": ${unknown.join(', ')}`);
    hosted = hosted.filter((site) => wanted.has(site.slug));
  }

  const jobs: JobRow[] = [];
  const skipped: { slug: string; reason: string }[] = [];
  for (const site of hosted) {
    const { state, refusal } = await siteRecoveryState(s, site, { answers, dbs });
    if (refusal) {
      skipped.push({ slug: site.slug, reason: refusal });
      continue;
    }
    const newest = usableBackups(s, site.slug, Number.MAX_SAFE_INTEGER).find((u) => sourceFor(u, target.id) !== undefined);
    if (!newest) {
      skipped.push({ slug: site.slug, reason: 'It has no complete backup with an offsite copy.' });
      continue;
    }
    try {
      const checked = checkRecoverRequest(s, site, state, { backupId: newest.row.id, targetServerId: target.id });
      jobs.push(
        s.worker.enqueue(
          'site.recover',
          { siteId: site.id, backupId: checked.backup.row.id, destinationId: checked.destinationId, targetServerId: target.id, asNew: false },
          { id: site.id, slug: site.slug },
          { serverId: target.id },
        ),
      );
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped.push({ slug: site.slug, reason: err.message });
    }
  }

  const external: string[] = [];
  if (target.id !== serverId) {
    const kept = s.db.select().from(sites).where(and(eq(sites.serverId, serverId), externalSites())).all();
    for (const site of kept) {
      if (body.slugs && !body.slugs.includes(site.slug)) continue;
      const updated = await s.connections.update(site, { storageServerId: target.id });
      // A copy on the old server is no longer the one the next backup builds on: it starts over.
      await s.externalBackups.forgetMirror(site).catch(() => undefined);
      if (updated.serverId === target.id) external.push(site.slug);
    }
  }
  return { jobs, skipped, external };
}

// ---------------------------------------------------------------------------
// A deleted site, made again from one of its backups

/** What a backup's manifest.json says, as far as a recovery reads it (BackupService.createOn writes it). */
export interface BackupManifest {
  format?: number;
  kind?: string;
  slug?: string;
  title?: string;
  app?: string;
  domains?: unknown;
  devHostname?: unknown;
  phpVersion?: string;
  locale?: string;
  database?: boolean;
  dbName?: string;
  dbUser?: string;
  tablePrefix?: string;
  webRoot?: unknown;
  databases?: unknown;
  stack?: unknown;
  /** Format 2: the site's own settings. Older backups have none, and the defaults stand in. */
  site?: {
    isLive?: boolean;
    keepDevAlias?: boolean;
    wpAdminUser?: string | null;
    wpAdminEmail?: string | null;
    pageCache?: string | null;
    objectCache?: boolean;
    cacheRules?: string | null;
    cpuLimit?: number | null;
    memoryLimitMb?: number | null;
    pidsLimit?: number | null;
    backupsEnabled?: boolean;
    offsiteEnabled?: boolean;
    backupKeepDays?: number | null;
    backupBeforeUpdates?: string | null;
  };
}

const DB_NAME_RE = /^[a-z0-9_]{1,64}$/;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * The row of a deleted site, made from its backup's manifest, on `target`. Its name is the
 * backup's. Its domains are those no other site holds now, and a dev address on the target's dev
 * domain when none is left. New passwords for its database and its mail login: neither is in a
 * backup. `warn` hears what comes back other than it was.
 */
export function siteRowFromManifest(
  s: CoreServices,
  slug: string,
  manifest: BackupManifest,
  target: ServerRow,
  warn: (message: string) => void,
): typeof sites.$inferInsert {
  if (manifest.kind === 'external') {
    throw new Error('This is a backup of a site hosted elsewhere: it is restored by hand, from its download. Nothing was changed.');
  }
  if (manifest.app === 'container') {
    throw new Error(
      "A container app's settings, secrets and routes are not in its backups. Create the app again, then restore this backup into it. Nothing was changed.",
    );
  }
  if (manifest.slug !== undefined && manifest.slug !== slug) {
    throw new Error(`The backup's manifest names "${manifest.slug}", not "${slug}". Nothing was changed.`);
  }
  const app = manifest.app === 'php' ? 'php' : 'wordpress';
  const offered = s.settings.get('phpVersions') ?? [];
  const phpVersion = manifest.phpVersion && offered.includes(manifest.phpVersion) ? manifest.phpVersion : s.settings.get('defaultPhpVersion');
  if (manifest.phpVersion && phpVersion !== manifest.phpVersion) {
    warn(`The backup was taken on PHP ${manifest.phpVersion}, which is no longer offered; the site comes back on PHP ${phpVersion}.`);
  }

  // A manifest comes out of a bucket: every value that reaches a label, a config file or a
  // container goes through the schema the panel holds the same value to everywhere else.
  const hostname = (v: unknown): string | null => {
    const parsed = domainSchema.safeParse(v);
    return parsed.success ? parsed.data : null;
  };
  const dev = hostname(manifest.devHostname);
  // A name under a dev domain is only ever the site's own dev hostname: the one it had, or the one it gets.
  const free = (domain: string, ownDev: string | null = dev): boolean => {
    try {
      assertDomainsFree(s, [domain], { allowDevHostname: ownDev });
      return true;
    } catch {
      return false;
    }
  };
  const raw = Array.isArray(manifest.domains) ? manifest.domains : [];
  const listed = raw.map(hostname).filter((d): d is string => d !== null);
  if (listed.length < raw.length) warn('The backup lists a domain that is not a valid hostname: the site comes back without it.');
  const domains = [...new Set(listed)].filter((domain) => free(domain));
  for (const domain of listed.filter((d) => !domains.includes(d))) warn(`${domain} is another site's now: the site comes back without it.`);
  let devHostname = dev && domains.includes(dev) ? dev : null;
  if (domains.length === 0) {
    devHostname = `${slug}.${target.devDomain || s.config.devDomain}`;
    if (!free(devHostname, devHostname)) throw new Error(`${devHostname} is another site's now, and the backup's domains are too. Nothing was changed.`);
    domains.push(devHostname);
    warn(`It comes back on ${devHostname}.`);
  }
  const own = manifest.site && typeof manifest.site === 'object' ? manifest.site : {};
  const valid = <T,>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: unknown): T | null => {
    const parsed = schema.safeParse(v);
    return parsed.success ? parsed.data : null;
  };
  const webRoot = app === 'php' ? valid(webRootSchema, manifest.webRoot) : '';
  if (app === 'php' && webRoot === null) warn("The backup's web root is not one the panel takes: the site's folder is its web root.");
  const keepDays = num(own.backupKeepDays);
  const isLive = typeof own.isLive === 'boolean' ? own.isLive : devHostname === null || domains[0] !== devHostname;
  // A WordPress site always has a database; a PHP site has one when its backup says so.
  const withDatabase = app === 'wordpress' || manifest.database === true;
  // A PHP site's own config names its database and user, so they keep their names.
  const dbName = withDatabase ? (manifest.dbName && DB_NAME_RE.test(manifest.dbName) ? manifest.dbName : dbIdentifier(slug)) : '';
  const dbUser = withDatabase ? (manifest.dbUser && DB_NAME_RE.test(manifest.dbUser) ? manifest.dbUser : dbIdentifier(slug)) : '';
  if (withDatabase && app === 'php') {
    warn("The site's database user gets a new password, which its own config can't know: put it there from the Database tab.");
  }
  const now = Date.now();
  return {
    slug,
    serverId: target.id,
    title: str(manifest.title) || slug,
    domains: JSON.stringify(domains),
    devHostname,
    isLive: isLive ? 1 : 0,
    keepDevAlias: own.keepDevAlias === false ? 0 : 1,
    phpVersion,
    app,
    webRoot: webRoot ?? '',
    locale: valid(localeSchema, manifest.locale) ?? s.settings.get('defaultLocale') ?? 'en_US',
    status: 'provisioning',
    dbName,
    dbUser,
    dbPassword: withDatabase ? generateSecret(24) : '',
    mailPassword: generateSecret(24),
    wpAdminUser: app === 'php' ? null : (str(own.wpAdminUser)?.slice(0, 60) ?? null),
    wpAdminEmail: app === 'php' ? null : (str(own.wpAdminEmail)?.slice(0, 254) ?? null),
    containerName: containerName(slug),
    tablePrefix: manifest.tablePrefix && TABLE_PREFIX_RE.test(manifest.tablePrefix) ? manifest.tablePrefix : 'wp_',
    pageCache: own.pageCache === 'on' || own.pageCache === 'off' ? own.pageCache : null,
    objectCache: own.objectCache === true ? 1 : 0,
    // Read back through the parser the renderers use, which drops what can't be a rule.
    cacheRules: str(own.cacheRules) ? JSON.stringify(parseSiteCacheRules(own.cacheRules)) : null,
    cpuLimit: valid(cpuLimitSchema, own.cpuLimit),
    memoryLimitMb: valid(memoryLimitMbSchema, own.memoryLimitMb),
    pidsLimit: valid(pidsLimitSchema, own.pidsLimit),
    backupsEnabled: own.backupsEnabled === false ? 0 : 1,
    offsiteEnabled: own.offsiteEnabled === false ? 0 : 1,
    backupKeepDays: keepDays !== null && Number.isInteger(keepDays) && keepDays >= 0 && keepDays <= MAX_BACKUP_KEEP_DAYS ? keepDays : null,
    backupBeforeUpdates: (backupBeforeUpdatesValues as readonly string[]).includes(String(own.backupBeforeUpdates)) ? String(own.backupBeforeUpdates) : null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * `POST /api/backups/:id/restore-site`: a deleted site made again from this backup, under its own
 * name, on `targetServerId`. The job reads the manifest once the backup is on the target and
 * makes the site's row from it (siteRowFromManifest), so a backup kept only offsite can do it too.
 */
export function queueDeletedSiteRestore(s: CoreServices, backupId: number, targetServerId: number): JobRow {
  const row = s.db.select().from(backups).where(eq(backups.id, backupId)).get();
  if (!row) throw notFound(`Backup #${backupId} not found`);
  if (row.type === 'panel') throw badRequest("A panel snapshot is not a site's backup.");
  if (row.status !== 'complete') throw conflict('Only a complete backup can make a site again.');
  if (s.db.select({ id: sites.id }).from(sites).where(eq(sites.slug, row.siteSlug)).get()) {
    throw conflict(`"${row.siteSlug}" is a site already: restore the backup from its Backups tab.`);
  }
  const target = s.servers.rowById(targetServerId);
  if (!target) throw notFound(`Server #${targetServerId} not found`);
  if (target.status !== 'ok') throw conflict(`"${target.name}" is ${target.status}: pick a server that is ok.`);
  const usable = usableBackups(s, row.siteSlug, Number.MAX_SAFE_INTEGER).find((u) => u.row.id === row.id);
  const destinationId = usable ? sourceFor(usable, target.id) : undefined;
  if (destinationId === undefined) {
    throw conflict(`Backup #${row.id} has no complete offsite copy, and its files are not on "${target.name}".`);
  }
  const waiting = s.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, 'site.recover'), eq(jobs.siteSlug, row.siteSlug), inArray(jobs.status, ['queued', 'running'])))
    .get();
  if (waiting) throw conflict(`Job #${waiting.id} is making "${row.siteSlug}" again already.`);
  return s.worker.enqueue(
    'site.recover',
    { siteId: 0, backupId: row.id, destinationId, targetServerId: target.id, asNew: true },
    undefined,
    { serverId: target.id, siteSlug: row.siteSlug },
  );
}
