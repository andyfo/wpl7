import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every query on the `sites` table, reviewed for sites hosted elsewhere (sites.kind external).
 * Such a row fills the container columns with nothing, so a query that hands its rows to Docker,
 * the site's database, its files, the mail relay or FTP must leave external rows out - by
 * `hostedSites()`, or by a status they never have ('running', 'stopped', 'provisioning'). The
 * rest take both kinds, for a reason written next to them.
 *
 * A query this list does not know fails the test: review it, then add it here.
 */

type Verdict = { both: string } | { hosted: string };

/** The query takes both kinds, because... */
const both = (reason: string): Verdict => ({ both: reason });
/** Hosted sites only: the query's text holds `token`, which is how it leaves external rows out. */
const hosted = (token: string): Verdict => ({ hosted: token });

const IMPORT_SITE = both("an import's own site, which an import makes hosted");
const FTP_ROWS = both('keyed by FTP logins, which only hosted sites have');
const NAMES = both('reads names and ids only');

const SITE_QUERY_REVIEW: Record<string, Record<string, Verdict>> = {
  'adminer/index.ts': { siteOf: hosted('hostedSites()') },
  'jobs/actions.ts': {
    checkTarget: both('checks that named sites exist, of either kind'),
    resolveSites: both('`all` and `server` filter by kind (hostedSites, externalSites); `sites` is checked by ineligible()'),
  },
  'jobs/handlers/backups.ts': { backupRestore: hosted('isExternal(site)') },
  'jobs/handlers/import.ts': { siteImportQueuedCancel: hosted("'provisioning'") },
  'jobs/handlers/move.ts': { finalizeCleanup: hosted("owner.kind !== 'external'") },
  'jobs/handlers/servers.ts': { serverApplySiteLimits: hosted('hostedSites()') },
  'jobs/handlers/shared.ts': {
    loadSite: both('the guard itself: refuses an external site unless the job takes either kind'),
    ensureSiteMountSources: both('reads the row of the site it was handed, which only a job on a hosted site does'),
  },
  'jobs/handlers/sites.ts': { siteCreateQueuedCancel: hosted("'provisioning'") },
  'jobs/handlers/wp.ts': { wpScanAll: both('external sites are scanned in a group of their own (isExternal)') },
  'jobs/schedulers.ts': {
    backupTick: both('connected external sites are backed up too'),
    siteLimitsTick: both("only asks whether a site lifts a CPU cap of its own, and whether a deferred site's lane is free"),
    wpCronTick: hosted("'running'"),
    wpScanIsDue: both('connected external sites are scanned too'),
    wpScanNextDue: both('connected external sites are scanned too'),
    dtoContext: NAMES,
  },
  'jobs/worker.ts': {
    clearCaches: both('clearAfterChange leaves a site hosted elsewhere alone'),
    enqueue: both("reads the kind, to put an external site's jobs in the external lanes"),
    rereadDatabases: both("reads the server of a site whose job changed a database; an external site's kick reads its backup server, which harms nothing"),
  },
  'routes/backups.ts': {
    'GET /api/backups': both('backups of either kind'),
    'POST /api/backups/:id/fetch': both('a fetch lands on the server that keeps the site now, of either kind'),
    'GET /api/backups/ids': both('backups of either kind'),
  },
  'routes/security.ts': { 'POST /api/security/scans': hosted("'running', 'stopped'") },
  'servers/registry.ts': {
    sitesCountFor: hosted('hostedSites()'),
    externalCountFor: both('counts the external sites a server keeps the backups of'),
  },
  'services/siteCaches.ts': { sweepSiteRuntime: hosted('hostedSites()') },
  'services/reminders.ts': { siteRows: both('reads domains, PHP versions and reminder links for both hosted and external sites; never invokes a container') },
  'services/alerts.ts': { vulnerabilities: both('alerts are for every site') },
  'services/backup.ts': {
    expire: both("reads each site's own keep period: the backups of either kind are deleted by age"),
    daysFor: both("one site's own keep period, as expire reaches its backups"),
  },
  'services/blocklist.ts': { block: NAMES, toDto: NAMES },
  'services/connections.ts': {
    enroll: both('the site a reconnect is for'),
    slugTaken: both('a slug is taken by a site of either kind'),
    update: both('an external site'),
    heartbeat: both('external sites only (externalSites)'),
    toSummary: NAMES,
  },
  'services/databases.ts': {
    assertNameFree: both("joins site_databases, which only hosted sites have rows in"),
    claims: hosted('hostedSites()'),
    userClaimed: hosted('hostedSites()'),
    pruneUploads: hosted('hostedSites()'),
  },
  'services/dockerCleanup.ts': { needsOn: hosted('hostedSites()') },
  'services/domainGuard.ts': { assertDomainsFree: both('a domain belongs to one site, of either kind') },
  'services/externalBackup.ts': { pruneOrphans: both('external sites only (externalSites)') },
  'services/ftp.ts': {
    expireDue: FTP_ROWS,
    suspendSite: FTP_ROWS,
    serversWanting: FTP_ROWS,
    plan: hosted('hostedSites()'),
    serverView: FTP_ROWS,
  },
  'services/imports.ts': { retry: IMPORT_SITE, refresh: IMPORT_SITE, toSummary: IMPORT_SITE, siteUrlOf: IMPORT_SITE, releaseSiteRow: IMPORT_SITE },
  'services/legacyRename.ts': { sweepLegacyRename: hosted('hostedSites()') },
  'services/mail.ts': {
    senderOwners: hosted('hostedSites()'),
    blockedLogins: both('suspended mail: only a hosted site sends through the relay'),
    syncMailAuthTo: hosted('hostedSites()'),
    setSiteMailSuspended: both('by the id of a site the relay knows, which is hosted'),
    enforceVolumeLimits: both("by the slugs in the relay's log, which are hosted"),
    sendingDomains: hosted('hostedSites()'),
    stats: NAMES,
  },
  'services/malwareScan.ts': {
    schedulePass: hosted("'running', 'stopped'"),
    scan: hosted('isExternal(site)'),
    overtaken: both("a scan's own site, which is hosted"),
    finish: both("a scan's own site, which is hosted"),
    followUp: both("a scan's own site, which is hosted"),
  },
  'services/monitor.ts': {
    activeSites: hosted('MONITORED'),
    tickUptime: both('external sites are probed directly (checkExternal)'),
    recheck: both('an external site is probed directly (isExternal)'),
  },
  'services/offsite.ts': { reconcileDestination: both('backups of either kind'), fetchBackup: both('backups of either kind') },
  'services/quarantine.ts': { prune: both('quarantined files, which only hosted sites have') },
  'services/security.ts': {
    plan: hosted("s.status === 'running'"),
    hardeningPlan: hosted("'running'"),
    prepareHardening: both('reads the row of the site it was handed, which only a job on a hosted site does'),
    policyFor: both("reads the app of the site whose policy is asked for"),
  },
  'services/securityEvents.ts': { fold: NAMES, recent: NAMES },
  'services/securityViews.ts': { securityOverview: hosted('hostedSites()'), fleetScans: hosted('hostedSites()') },
  'services/phpReleases.ts': { readSitePhp: hosted('isExternal(site)'), sweepPhpReleases: hosted('hostedSites()') },
  'services/siteHardening.ts': { sweepHardening: hosted('hostedSites()') },
  'services/siteImages.ts': { sweepSiteImages: hosted('hostedSites()') },
  'services/sites.ts': {
    bySlug: both('the guard itself: refuses an external site unless the caller takes either kind'),
    reconcileAll: hosted('hostedSites()'),
    applyLimits: hosted('hostedSites()'),
    ownSiteLimits: hosted('hostedSites()'),
    list: both('the site list shows both kinds'),
    ownBackupKeepDays: NAMES,
    ownBackupBeforeUpdates: NAMES,
  },
  'services/traffic.ts': { apply: both("slugs from Traefik's log, which only hosted sites are in") },
  'services/wildcardSites.ts': { sweepWildcardSites: hosted('hostedSites()') },
  'services/wpBulk.ts': { createBatch: both('bulk runs reach both kinds') },
  'services/siteCron.ts': { tick: hosted('hostedSites()'), runningOn: both('by its cron lines, which only a PHP site has, and PHP sites are hosted') },
  'services/wpInventory.ts': { fleetInventory: both('Bulk management shows both kinds') },
  'updates/hooks.ts': { run: hosted('hostedSites()') },
};

/**
 * And reviewed for PHP sites (sites.app php): hosted, with no WordPress in them. A query whose rows
 * go to WordPress - WP-CLI, wp-cron, the inventory, wordpress.org - must leave them out with
 * `wordpressSites()` or skip them with `isPhpSite(`, in the query's own text. The rest take both
 * apps, for a reason written next to them. A query this list does not know fails the test too.
 */
type AppVerdict = { apps: string } | { wordpress: 'wordpressSites()' | 'isPhpSite(' };

/** The query takes PHP sites too, because... */
const apps = (reason: string): AppVerdict => ({ apps: reason });
/** WordPress sites only: the query's text holds `token`. */
const wordpress = (token: 'wordpressSites()' | 'isPhpSite('): AppVerdict => ({ wordpress: token });

const ANY_SITE = apps('nothing it does is WordPress');
const APP_NAMES = apps('reads names and ids only');
const EXTERNAL_ONLY = apps('external sites, which are always WordPress');
const IMPORT_ROW = apps("an import's own site, which an import makes as a WordPress site");
const RELAY = apps('a PHP site sends through the relay as its own domains too');
const SCANNED = apps('a PHP site is scanned too: its files are checked, it has no WordPress to compare');
const EITHER_BACKUP = apps('backups of either app');

const SITE_APP_REVIEW: Record<string, Record<string, AppVerdict>> = {
  'adminer/index.ts': { siteOf: apps("a PHP site's database is browsed like any other; the routes refuse one with none") },
  'jobs/actions.ts': {
    checkTarget: apps('checks that named sites exist; ineligible() skips a PHP site for a WordPress action'),
    resolveSites: apps('serves every action: `all` and `server` add wordpressSites() for the WordPress ones'),
  },
  'jobs/handlers/backups.ts': { backupRestore: apps("restores either app; WordPress's steps inside ask isPhpSite") },
  'jobs/handlers/import.ts': { siteImportQueuedCancel: IMPORT_ROW },
  'jobs/handlers/move.ts': { finalizeCleanup: apps('who owns a source copy, by slug') },
  'jobs/handlers/servers.ts': { serverApplySiteLimits: apps('container limits and runtime files for every hosted site') },
  'jobs/handlers/shared.ts': {
    loadSite: apps("the guard itself: refuses a PHP site where the job asks for { app: 'wordpress' }"),
    ensureSiteMountSources: ANY_SITE,
  },
  'jobs/handlers/sites.ts': { siteCreateQueuedCancel: ANY_SITE },
  'jobs/handlers/wp.ts': { wpScanAll: wordpress('wordpressSites()') },
  'jobs/schedulers.ts': {
    backupTick: apps('scheduled backups include PHP sites'),
    siteLimitsTick: ANY_SITE,
    wpCronTick: wordpress('wordpressSites()'),
    wpScanIsDue: wordpress('wordpressSites()'),
    wpScanNextDue: wordpress('wordpressSites()'),
    dtoContext: APP_NAMES,
  },
  'jobs/worker.ts': {
    clearCaches: apps('clearAfterChange leaves a PHP site alone itself'),
    enqueue: apps('reads the kind, for the lanes'),
    rereadDatabases: ANY_SITE,
  },
  'routes/backups.ts': {
    'GET /api/backups': EITHER_BACKUP,
    'POST /api/backups/:id/fetch': EITHER_BACKUP,
    'GET /api/backups/ids': EITHER_BACKUP,
  },
  'routes/security.ts': { 'POST /api/security/scans': SCANNED },
  'servers/registry.ts': { sitesCountFor: ANY_SITE, externalCountFor: EXTERNAL_ONLY },
  'services/siteCaches.ts': { sweepSiteRuntime: apps('a PHP site has runtime files too: the pass-through, its pool, mail-from') },
  'services/reminders.ts': { siteRows: apps('domain and PHP reminders are for PHP sites too') },
  'services/alerts.ts': { vulnerabilities: apps('the WordPress inventory, which has no rows for a PHP site') },
  'services/backup.ts': { expire: EITHER_BACKUP, daysFor: EITHER_BACKUP },
  'services/blocklist.ts': { block: APP_NAMES, toDto: APP_NAMES },
  'services/connections.ts': {
    enroll: EXTERNAL_ONLY,
    slugTaken: apps('a slug is taken by a site of either app'),
    update: EXTERNAL_ONLY,
    heartbeat: EXTERNAL_ONLY,
    toSummary: APP_NAMES,
  },
  'services/databases.ts': {
    assertNameFree: ANY_SITE,
    claims: apps('a database is claimed by whether the site has one (hasDatabase), not by its app'),
    userClaimed: ANY_SITE,
    pruneUploads: ANY_SITE,
  },
  'services/dockerCleanup.ts': { needsOn: apps('a PHP site runs the same site images, which must be kept') },
  'services/domainGuard.ts': { assertDomainsFree: apps('a domain belongs to one site, of either app') },
  'services/externalBackup.ts': { pruneOrphans: EXTERNAL_ONLY },
  'services/ftp.ts': { expireDue: ANY_SITE, suspendSite: ANY_SITE, serversWanting: ANY_SITE, plan: apps('a PHP site has FTP and SFTP too'), serverView: ANY_SITE },
  'services/imports.ts': { retry: IMPORT_ROW, refresh: IMPORT_ROW, toSummary: IMPORT_ROW, siteUrlOf: IMPORT_ROW, releaseSiteRow: IMPORT_ROW },
  'services/legacyRename.ts': { sweepLegacyRename: ANY_SITE },
  'services/mail.ts': {
    senderOwners: RELAY,
    blockedLogins: RELAY,
    syncMailAuthTo: RELAY,
    setSiteMailSuspended: RELAY,
    enforceVolumeLimits: RELAY,
    sendingDomains: RELAY,
    stats: APP_NAMES,
  },
  'services/malwareScan.ts': {
    schedulePass: SCANNED,
    scan: SCANNED,
    overtaken: SCANNED,
    finish: apps('"No WordPress was found" asks isPhpSite inside, not the query'),
    followUp: SCANNED,
  },
  'services/monitor.ts': { activeSites: apps('a PHP site has an uptime check too'), tickUptime: ANY_SITE, recheck: ANY_SITE },
  'services/offsite.ts': { reconcileDestination: EITHER_BACKUP, fetchBackup: EITHER_BACKUP },
  'services/quarantine.ts': { prune: ANY_SITE },
  'services/security.ts': {
    plan: apps('effectivePolicy takes the app, and leaves WordPress\'s rules out for a PHP site'),
    hardeningPlan: apps("a PHP site's Apache file has its HTTPS line and web root"),
    prepareHardening: apps("a PHP site's Apache file has its HTTPS line and web root"),
    policyFor: apps('reads the app the policy depends on'),
  },
  'services/securityEvents.ts': { fold: APP_NAMES, recent: APP_NAMES },
  'services/securityViews.ts': { securityOverview: apps('each site with its own policy, by its app'), fleetScans: SCANNED },
  'services/phpReleases.ts': { readSitePhp: ANY_SITE, sweepPhpReleases: ANY_SITE },
  'services/siteHardening.ts': { sweepHardening: ANY_SITE },
  'services/siteImages.ts': { sweepSiteImages: apps('a PHP site follows its image too, once the image can run it (isPhpSite in canRun)') },
  'services/sites.ts': {
    bySlug: apps("the guard itself: refuses a PHP site where the caller asks for { app: 'wordpress' }"),
    reconcileAll: ANY_SITE,
    applyLimits: ANY_SITE,
    ownSiteLimits: ANY_SITE,
    list: apps('the site list shows both apps'),
    ownBackupKeepDays: APP_NAMES,
    ownBackupBeforeUpdates: APP_NAMES,
  },
  'services/traffic.ts': { apply: apps('a PHP site has visitor statistics too') },
  'services/wildcardSites.ts': { sweepWildcardSites: ANY_SITE },
  'services/wpBulk.ts': { createBatch: wordpress('isPhpSite(') },
  'services/siteCron.ts': {
    tick: apps("PHP sites' own cron lines: the query asks for app php itself"),
    runningOn: apps('by its cron lines, which only a PHP site has'),
  },
  'services/wpInventory.ts': { fleetInventory: wordpress('wordpressSites()') },
  'updates/hooks.ts': { run: ANY_SITE },
};

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const QUERY = /\.from\(sites\)|\.(?:left|inner|right|full)Join\(sites,/;

const DECLARATIONS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, (m) => m[1]!],
  [/^\s*(?:r|app)\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*[`'"]([^`'"]+)/, (m) => `${m[1]!.toUpperCase()} ${m[2]}`],
  [/^\s*(?:(?:private|public|protected|static|async|override)\s+)*(\w+)\s*(?:<[^>]*>)?\(.*\)\s*(?::.*)?\{\s*$/, (m) => m[1]!],
  [/^\s*(?:(?:private|public|protected|static|async|override)\s+)*(\w+)\s*(?:<[^>]*>)?\($/, (m) => m[1]!],
  [/^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(.*=>/, (m) => m[1]!],
];
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'function', 'else']);
const indent = (line: string) => line.length - line.trimStart().length;

/** The function, method or route a line is in: the nearest declaration above it, less indented. */
function scopeOf(lines: string[], i: number): { name: string; start: number } {
  let depth = indent(lines[i]!);
  for (let j = i - 1; j >= 0; j--) {
    const line = lines[j]!;
    // A multi-line signature's closing line belongs to the declaration above it.
    if (!line.trim() || indent(line) >= depth || /^\s*\)/.test(line)) continue;
    for (const [re, name] of DECLARATIONS) {
      const m = re.exec(line);
      if (m && !NOT_NAMES.has(m[1]!)) return { name: name(m), start: j };
    }
    depth = Math.min(depth, indent(line));
  }
  return { name: '(top)', start: 0 };
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'migrations' ? [] : sourceFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

interface Found {
  file: string;
  scope: string;
  line: number;
  text: string;
}

function findQueries(): Found[] {
  const out: Found[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!QUERY.test(line)) return;
      const { name, start } = scopeOf(lines, i);
      out.push({ file: path.relative(SRC, file), scope: name, line: i + 1, text: lines.slice(start, i + 8).join('\n') });
    });
  }
  return out;
}

describe('queries on the sites table, and sites hosted elsewhere', () => {
  const found = findQueries();

  it('finds the queries', () => {
    expect(found.length).toBeGreaterThan(60);
  });

  it('knows every one of them: a new query has to be reviewed', () => {
    const unknown = found.filter((f) => SITE_QUERY_REVIEW[f.file]?.[f.scope] === undefined).map((f) => `${f.file}:${f.line} (${f.scope})`);
    expect(unknown).toEqual([]);
  });

  it('lists no query that is gone', () => {
    const present = new Set(found.map((f) => `${f.file}#${f.scope}`));
    const stale = Object.entries(SITE_QUERY_REVIEW).flatMap(([file, scopes]) =>
      Object.keys(scopes)
        .filter((scope) => !present.has(`${file}#${scope}`))
        .map((scope) => `${file}#${scope}`),
    );
    expect(stale).toEqual([]);
  });

  it('knows every one of them for PHP sites too', () => {
    const unknown = found.filter((f) => SITE_APP_REVIEW[f.file]?.[f.scope] === undefined).map((f) => `${f.file}:${f.line} (${f.scope})`);
    expect(unknown).toEqual([]);
    const present = new Set(found.map((f) => `${f.file}#${f.scope}`));
    const stale = Object.entries(SITE_APP_REVIEW).flatMap(([file, scopes]) => Object.keys(scopes).map((scope) => `${file}#${scope}`)).filter((key) => !present.has(key));
    expect(stale).toEqual([]);
  });

  it('leaves PHP sites out of every WordPress-only query', () => {
    const missing = found
      .map((f) => ({ f, verdict: SITE_APP_REVIEW[f.file]?.[f.scope] }))
      .filter(({ f, verdict }) => verdict && 'wordpress' in verdict && !f.text.includes(verdict.wordpress))
      .map(({ f, verdict }) => `${f.file}:${f.line} (${f.scope}) does not say ${(verdict as { wordpress: string }).wordpress}`);
    expect(missing).toEqual([]);
  });

  it('leaves external sites out of every hosted-only query', () => {
    const missing = found
      .map((f) => ({ f, verdict: SITE_QUERY_REVIEW[f.file]?.[f.scope] }))
      .filter(({ f, verdict }) => verdict && 'hosted' in verdict && !f.text.includes(verdict.hosted))
      .map(({ f, verdict }) => `${f.file}:${f.line} (${f.scope}) does not say ${(verdict as { hosted: string }).hosted}`);
    expect(missing).toEqual([]);
  });
});
