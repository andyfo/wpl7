/**
 * Jobs in every state, with their logs: last night's backups and scans, yesterday's bulk update
 * over five sites, a malware scan that failed on the stopped site, the site created ten minutes
 * ago, a backup running now and an offsite copy waiting behind it. The built-in schedules carry
 * their last run, and there is one schedule of the operator's own (a weekly WP-CLI command).
 */
import { eq } from 'drizzle-orm';
import { batches, jobLogs, jobs, schedules } from '../../src/db/schema.js';
import { summarizeJob } from '../../src/jobs/summaries.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, MINUTE, ago, DEMO_NOW } from './clock.js';
import { SITES, rng, seedOf } from './data.js';
import { BULK_AT, BULK_UPDATED } from './backups.js';
import { LATEST } from './plugins.js';
import { siteIds } from './sites.js';

type Origin = 'user' | 'api' | 'mcp' | 'schedule' | 'system';

interface DemoJob {
  type: string;
  site?: string;
  serverId?: number | null;
  lane?: string | null;
  batchId?: number | null;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  createdAt: number;
  durationMs?: number;
  origin: Origin;
  createdBy: string;
  error?: string;
  result?: Record<string, unknown>;
  logs?: [level: 'info' | 'warn' | 'error', message: string, offsetMs: number][];
}

const server = (slug: string) => SITES.find((s) => s.slug === slug)!.server;

/** The site.create log as the handler writes it (jobs/handlers/sites.ts). */
function createLog(slug: string, dbName: string): DemoJob['logs'] {
  const url = `https://${slug}.dev.example.com`;
  return [
    ['info', `Creating site "${slug}" at ${url} on server "fra1"`, 0],
    ['info', 'Preparing directories…', 400],
    ['info', 'Creating the site network…', 900],
    ['info', `Creating database ${dbName}…`, 1600],
    ['info', 'Registering the site with the mail relay…', 2300],
    ['info', 'Creating and starting container (unrouted until WordPress is installed)…', 3100],
    ['info', 'Waiting for WordPress files…', 6200],
    ['info', 'Installing WordPress…', 9800],
    ['info', 'Setting pretty permalinks…', 17400],
    ['info', 'Asking search engines not to index this site…', 18900],
    ['info', 'Removing the plugins WordPress bundles (Akismet, Hello Dolly)…', 20100],
    ['info', 'Installing plugin wordpress-seo…', 22600],
    ['info', 'Installing plugin contact-form-7…', 29800],
    ['info', 'Installing plugin redirection…', 34100],
    ['info', 'Publishing the site (enabling its router)…', 38700],
    ['info', 'Verifying site responds…', 41200],
    ['info', 'HTTPS certificate is issued on first request; allow up to a minute after DNS is in place.', 42000],
    ['info', `Site created: ${url}`, 42600],
  ];
}

function backupLog(slug: string, done: boolean): DemoJob['logs'] {
  const db = `wp_${slug.replace(/-/g, '_')}`;
  const lines: DemoJob['logs'] = [
    ['info', `Dumping database ${db}…`, 0],
    ['info', 'Archiving wp-content and the site configuration…', 4200],
  ];
  if (done) {
    lines.push(['info', 'Writing manifest.json and checksums…', 61_000], ['info', 'Backup complete.', 63_500]);
  }
  return lines;
}

export function seedJobs(world: TestWorld): void {
  const list: DemoJob[] = [];
  const today3am = Math.floor(DEMO_NOW / DAY) * DAY + 3 * HOUR;

  // A week ago: Lumen Law Partners moved from nyc1 to fra1.
  list.push({
    type: 'site.move',
    site: 'lumen-law',
    serverId: 2,
    payload: { siteId: siteIds.get('lumen-law'), sourceServerId: 2, targetServerId: 1, quiesce: 'maintenance' },
    status: 'succeeded',
    createdAt: ago(7 * DAY + 5 * HOUR),
    durationMs: 6 * MINUTE + 12_000,
    origin: 'user',
    createdBy: 'sam',
    logs: [
      ['info', 'Checking fra1: reachable, MariaDB healthy, 112 GB free (needs 2.9 GB)', 0],
      ['info', 'Putting the site in maintenance mode on nyc1 while it is copied…', 4000],
      ['info', 'Snapshot taken (backup type move), 1.1 GB', 95_000],
      ['info', 'Copied to fra1 and verified (sha256)', 260_000],
      ['info', 'Restored on fra1; the site answers there', 330_000],
      ['info', 'Traffic switched to fra1. nyc1 forwards visitors until DNS has caught up.', 365_000],
    ],
  });
  list.push({
    type: 'site.moveFinalize',
    site: 'lumen-law',
    serverId: 2,
    payload: { siteId: siteIds.get('lumen-law') },
    status: 'succeeded',
    createdAt: ago(6 * DAY - 2 * HOUR),
    durationMs: 21_000,
    origin: 'system',
    createdBy: 'panel',
    logs: [
      ['info', 'Every hostname resolves to fra1 only; removing the copy parked on nyc1…', 0],
      ['info', 'Removed the container, database and files left on nyc1.', 19_000],
    ],
  });

  // Last night's scheduled backups, one job per site.
  for (const site of SITES) {
    if (site.ageDays < 1) continue;
    const at = today3am + Math.round(rng(seedOf(`job:${site.slug}`))() * 9 * MINUTE);
    list.push({
      type: 'backup.create',
      site: site.slug,
      serverId: site.server,
      payload: { siteId: siteIds.get(site.slug), type: 'scheduled' },
      status: 'succeeded',
      createdAt: at,
      durationMs: 40_000 + Math.round(site.diskMb * 9),
      origin: 'schedule',
      createdBy: 'Backups',
      logs: backupLog(site.slug, true),
    });
  }
  list.push({ type: 'wp.scanAll', payload: {}, status: 'succeeded', createdAt: ago(52 * MINUTE + 30_000), durationMs: 48_000, origin: 'schedule', createdBy: 'WordPress scan', logs: [['info', 'Scanning 10 running sites…', 0], ['info', 'Scanned 10 sites: 6 updates, 1 known vulnerability.', 47_000]] });
  list.push({ type: 'system.housekeeping', payload: {}, status: 'succeeded', createdAt: today3am + 45 * MINUTE, durationMs: 3_200, origin: 'schedule', createdBy: 'Housekeeping', logs: [['info', 'Pruned 1,204 job log lines and 38 old jobs.', 0], ['info', 'Nothing else to remove.', 3_000]] });

  // Malware scans of the night; the stopped site's fails.
  for (const site of SITES) {
    if (site.ageDays < 1) continue;
    const stopped = site.state === 'stopped';
    list.push({
      type: 'site.malwareScan',
      serverId: site.server,
      lane: `scan:${site.server}`,
      payload: { siteId: siteIds.get(site.slug), trigger: 'schedule' },
      status: stopped ? 'failed' : 'succeeded',
      createdAt: today3am + 70 * MINUTE + SITES.indexOf(site) * 4 * MINUTE,
      durationMs: stopped ? 2_000 : 95_000 + Math.round(site.diskMb * 12),
      origin: 'schedule',
      createdBy: 'Malware scans',
      ...(stopped ? { error: 'The site is stopped: its files were not scanned. Start it, then choose Scan now.' } : {}),
      logs: stopped
        ? [['error', 'The site is stopped: its files were not scanned. Start it, then choose Scan now.', 1_500]]
        : [['info', 'Checking core, plugin and theme files against wordpress.org checksums…', 0], ['info', 'Looking for known malware in the rest…', 40_000], ['info', site.slug === 'pixel-press' ? 'Done: 1 finding, moved to quarantine.' : 'Done: nothing found.', 90_000]],
    });
  }

  // Yesterday afternoon: one bulk update over five sites, a backup first and a health check after.
  const batchId = world.db
    .insert(batches)
    .values({ kind: 'wp.bulk', action: 'update', options: JSON.stringify({ backupFirst: true, healthCheck: true }), skipped: '[]', targetCount: 7, totalJobs: BULK_UPDATED.length, createdAt: BULK_AT })
    .returning()
    .get().id;
  BULK_UPDATED.forEach((slug, i) => {
    list.push({
      type: 'wp.bulkTask',
      site: slug,
      serverId: server(slug),
      batchId,
      payload: { siteId: siteIds.get(slug), batchId, ops: [{ kind: 'plugin', slug: 'wordpress-seo', action: 'update' }], backupFirst: true, healthCheck: true },
      status: 'succeeded',
      createdAt: BULK_AT + i * 2 * MINUTE,
      durationMs: 75_000,
      origin: 'user',
      createdBy: 'sam',
      logs: [
        ['info', 'Backing up first…', 0],
        ['info', 'Backup complete.', 52_000],
        ['info', `Updating plugin wordpress-seo 28.5 → ${LATEST['wordpress-seo']}…`, 53_000],
        ['info', 'Health check: the home page answers 200.', 73_000],
      ],
    });
  });

  // From the API key and from an AI app.
  list.push({ type: 'wp.cli', site: 'ridge-outfitters', serverId: 3, lane: 'exec:3', payload: { siteId: siteIds.get('ridge-outfitters'), args: ['wc', 'tool', 'run', 'clear_transients', '--user=1'] }, status: 'succeeded', createdAt: ago(5 * HOUR), durationMs: 4_100, origin: 'api', createdBy: 'API key "Deploy script"', logs: [['info', '$ wp wc tool run clear_transients --user=1', 0], ['info', 'Success: Updated clear_transients.', 3_900]] });
  list.push({ type: 'site.restart', site: 'harbor-yoga', serverId: 2, payload: { siteId: siteIds.get('harbor-yoga') }, status: 'succeeded', createdAt: ago(2 * HOUR + 14 * MINUTE), durationMs: 6_300, origin: 'mcp', createdBy: 'Claude via MCP (approved by admin)', logs: [['info', 'Restarting wp-harbor-yoga…', 0], ['info', 'The site answers again.', 6_000]] });

  // Ten minutes ago: Oak & Ivy Interiors was created.
  list.push({
    type: 'site.create',
    site: 'oak-and-ivy',
    serverId: 1,
    payload: { siteId: siteIds.get('oak-and-ivy'), adminPassword: '[redacted]', passwordGenerated: true, pluginSlugs: ['wordpress-seo', 'contact-form-7', 'redirection'], pluginZipPaths: [], discourageSearchEngines: true },
    status: 'succeeded',
    createdAt: ago(10 * MINUTE + 20_000),
    durationMs: 43_000,
    origin: 'user',
    createdBy: 'priya',
    result: { url: 'https://oak-and-ivy.dev.example.com' },
    logs: createLog('oak-and-ivy', 'wp_oak_and_ivy'),
  });

  // Right now: a manual backup of the biggest site is running, and an offsite copy waits.
  list.push({ type: 'backup.create', site: 'ridge-outfitters', serverId: 3, payload: { siteId: siteIds.get('ridge-outfitters'), type: 'manual', note: 'Before the autumn catalog import' }, status: 'running', createdAt: ago(3 * MINUTE + 10_000), origin: 'user', createdBy: 'priya', logs: backupLog('ridge-outfitters', false) });
  list.push({ type: 'backup.offsite', lane: 'offsite', payload: { backupId: 1 }, status: 'queued', createdAt: ago(2 * MINUTE + 40_000), origin: 'schedule', createdBy: 'Offsite copies' });

  list.sort((a, b) => a.createdAt - b.createdAt);
  const names = { server: (id: number) => world.servers.rowById(id)?.name ?? null };
  world.db.transaction((tx) => {
    for (const job of list) {
      const startedAt = job.status === 'queued' ? null : job.createdAt + 1_000;
      const finishedAt = job.status === 'queued' || job.status === 'running' ? null : (startedAt ?? job.createdAt) + (job.durationMs ?? 1_000);
      const row = tx
        .insert(jobs)
        .values({
          type: job.type,
          siteId: job.site ? siteIds.get(job.site)! : null,
          siteSlug: job.site ?? null,
          serverId: job.serverId ?? (job.site ? server(job.site) : null),
          batchId: job.batchId ?? null,
          lane: job.lane ?? null,
          payload: JSON.stringify(job.payload),
          status: job.status,
          error: job.error ?? null,
          result: job.result ? JSON.stringify(job.result) : null,
          attempts: job.status === 'queued' ? 0 : 1,
          createdAt: job.createdAt,
          startedAt,
          finishedAt,
          origin: job.origin,
          createdBy: job.createdBy,
          summary: summarizeJob(job.type, job.payload, names),
        })
        .returning()
        .get();
      for (const [level, message, offset] of job.logs ?? []) {
        tx.insert(jobLogs).values({ jobId: row.id, ts: (startedAt ?? job.createdAt) + offset, level, message }).run();
      }
    }
  });
  seedSchedules(world);
}

/** The built-ins' last runs, and one schedule of the operator's own. */
function seedSchedules(world: TestWorld): void {
  const today3am = Math.floor(DEMO_NOW / DAY) * DAY + 3 * HOUR;
  const lastRuns: Record<string, [at: number, ms: number]> = {
    backups: [today3am, 11 * MINUTE],
    'wp-scan': [ago(52 * MINUTE), 48_000],
    'malware-scan': [today3am + 70 * MINUTE, 38 * MINUTE],
    offsite: [ago(MINUTE), 900],
    housekeeping: [today3am + 45 * MINUTE, 3_200],
    uptime: [ago(40_000), 2_100],
    'site-stats': [ago(35_000), 900],
    'server-stats': [ago(30_000), 700],
    'disk-usage': [ago(4 * MINUTE), 6_400],
    'traffic-ingest': [ago(50_000), 1_300],
    'update-check': [ago(38 * MINUTE), 600],
    catalog: [ago(38 * MINUTE), 800],
    'mail-ingest': [ago(45_000), 400],
  };
  for (const [key, [at, ms]] of Object.entries(lastRuns)) {
    world.db.update(schedules).set({ lastRunAt: at, lastDurationMs: ms, lastOutcome: 'ok' }).where(eq(schedules.key, key)).run();
  }
  const nextMonday = (() => {
    const d = new Date(DEMO_NOW);
    const day = d.getUTCDay();
    const add = ((8 - day) % 7 || 7) * DAY;
    return Math.floor((DEMO_NOW + add) / DAY) * DAY + 4 * HOUR + 30 * MINUTE;
  })();
  world.db
    .insert(schedules)
    .values({
      name: 'Clear expired transients',
      description: 'Keeps the options table small on the two busiest sites.',
      action: 'wp.cli',
      target: JSON.stringify({ kind: 'sites', slugs: ['pixel-press', 'ridge-outfitters'] }),
      params: JSON.stringify({ args: ['transient', 'delete', '--expired'] }),
      cron: '30 4 * * 1',
      enabled: 1,
      nextRunAt: nextMonday,
      lastRunAt: nextMonday - 7 * DAY,
      lastDurationMs: 7_800,
      lastOutcome: 'ok',
      createdBy: 'admin',
      createdAt: ago(30 * DAY),
      updatedAt: ago(30 * DAY),
    })
    .run();
}
