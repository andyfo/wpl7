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
  'jobs/actions.ts': {
    checkTarget: both('checks that named sites exist, of either kind'),
    resolveSites: both('`all` and `server` filter by kind (hostedSites, externalSites); `sites` is checked by ineligible()'),
  },
  'jobs/handlers/backups.ts': { backupRestore: hosted('isExternal(site)') },
  'jobs/handlers/import.ts': { siteImportQueuedCancel: hosted("'provisioning'") },
  'jobs/handlers/move.ts': { finalizeCleanup: hosted("owner.kind !== 'external'") },
  'jobs/handlers/servers.ts': { serverApplySiteLimits: hosted('hostedSites()') },
  'jobs/handlers/shared.ts': { loadSite: both('the guard itself: refuses an external site unless the job takes either kind') },
  'jobs/handlers/sites.ts': { siteCreateQueuedCancel: hosted("'provisioning'") },
  'jobs/handlers/wp.ts': { wpScanAll: both('external sites are scanned in a group of their own (isExternal)') },
  'jobs/schedulers.ts': {
    backupTick: both('connected external sites are backed up too'),
    siteLimitsTick: both("only asks whether a deferred site's lane is free"),
    wpCronTick: hosted("'running'"),
    wpScanIsDue: both('connected external sites are scanned too'),
    wpScanNextDue: both('connected external sites are scanned too'),
    dtoContext: NAMES,
  },
  'jobs/worker.ts': { enqueue: both("reads the kind, to put an external site's jobs in the external lanes") },
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
  'services/alerts.ts': { vulnerabilities: both('alerts are for every site') },
  'services/blocklist.ts': { block: NAMES, toDto: NAMES },
  'services/connections.ts': {
    enroll: both('the site a reconnect is for'),
    slugTaken: both('a slug is taken by a site of either kind'),
    update: both('an external site'),
    heartbeat: both('external sites only (externalSites)'),
    toSummary: NAMES,
  },
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
  'services/security.ts': { plan: hosted("s.status === 'running'"), hardeningPlan: hosted("'running'") },
  'services/securityEvents.ts': { fold: NAMES, recent: NAMES },
  'services/securityViews.ts': { securityOverview: hosted('hostedSites()'), fleetScans: hosted('hostedSites()') },
  'services/siteHardening.ts': { sweepHardening: hosted('hostedSites()') },
  'services/sites.ts': {
    bySlug: both('the guard itself: refuses an external site unless the caller takes either kind'),
    reconcileAll: hosted('hostedSites()'),
    applyLimits: hosted('hostedSites()'),
    list: both('the site list shows both kinds'),
  },
  'services/traffic.ts': { apply: both("slugs from Traefik's log, which only hosted sites are in") },
  'services/wildcardSites.ts': { sweepWildcardSites: hosted('hostedSites()') },
  'services/wpBulk.ts': { createBatch: both('bulk runs reach both kinds') },
  'services/wpInventory.ts': { fleetInventory: both('Bulk management shows both kinds') },
  'updates/hooks.ts': { run: hosted('hostedSites()') },
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

  it('leaves external sites out of every hosted-only query', () => {
    const missing = found
      .map((f) => ({ f, verdict: SITE_QUERY_REVIEW[f.file]?.[f.scope] }))
      .filter(({ f, verdict }) => verdict && 'hosted' in verdict && !f.text.includes(verdict.hosted))
      .map(({ f, verdict }) => `${f.file}:${f.line} (${f.scope}) does not say ${(verdict as { hosted: string }).hosted}`);
    expect(missing).toEqual([]);
  });
});
