/**
 * The sites: twelve on three servers, live, dev-only and stopped, one of them a PHP site with
 * cron lines of its own, each with its container in the state its row says, a day of uptime and
 * resource samples, and its disk use. Every server has a site image of each PHP branch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { siteCron, siteStats, sites } from '../../src/db/schema.js';
import { nextCronRun } from '../../src/services/schedules.js';
import { SITE_APP_LABEL, siteImage, sitePaths } from '../../src/services/siteSpec.js';
import { SITE_STACK_LABEL } from '../../src/services/siteStack.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, MINUTE, ago, DEMO_NOW } from './clock.js';
import { ADMIN_EMAIL, PHP_RELEASES, SERVERS, SITES, devHostname, isPhp, rng, seedOf, siteDomains, type DemoSite } from './data.js';
import { onDisk } from './paths.js';

const MB = 1024 * 1024;

/** The site row's id by slug, filled in by seedSites. */
export const siteIds = new Map<string, number>();

export const createdAt = (site: DemoSite): number => (site.ageDays === 0 ? ago(10 * MINUTE) : ago(site.ageDays * DAY + 3 * 3600_000));

/** "2026-10-05 09:55:00", as Laravel writes the time in its own output. */
const laravelTime = (ts: number): string => new Date(ts).toISOString().slice(0, 19).replace('T', ' ');

interface DemoCronLine {
  expr: string;
  command: string;
  timeoutMin: number;
  /** The last run, which ended well. */
  last: { startedAt: number; ms: number; output: string };
}

/**
 * The last time the built-in `site-cron` task started a line, as the minute turned: the five-minute
 * line's last run, and the task's own last run (jobs.ts).
 */
export const LAST_CRON_TICK = ago(5 * MINUTE);

/**
 * The PHP site's cron lines, as the `site-cron` task left them (services/siteCron.ts): Laravel's
 * scheduler every five minutes, and every night the reminders for the day's bookings, of which
 * its database holds two that were made by then (databases.ts).
 */
const CRON_LINES: Record<string, DemoCronLine[]> = {
  'bayside-bikes': [
    {
      expr: '*/5 * * * *',
      command: 'php artisan schedule:run',
      timeoutMin: 5,
      last: {
        startedAt: LAST_CRON_TICK,
        ms: 1_420,
        output: `   INFO  Running scheduled tasks.\n\n  ${laravelTime(LAST_CRON_TICK)} Running ['artisan' bookings:release-holds] 318ms DONE\n`,
      },
    },
    {
      expr: '15 2 * * *',
      command: 'php artisan bookings:send-reminders',
      timeoutMin: 15,
      last: {
        startedAt: Math.floor(DEMO_NOW / DAY) * DAY + 2 * HOUR + 15 * MINUTE,
        ms: 3_870,
        output: `Sent 2 reminders for the bookings of ${laravelTime(DEMO_NOW).slice(0, 10)}.\n`,
      },
    },
  ],
};

export function seedSites(world: TestWorld): void {
  // As setup.sh pulls them: one site image per branch on every server.
  for (const server of SERVERS) {
    const docker = server.id === 1 ? world.docker : world.remote(server.id).docker;
    for (const [branch, release] of Object.entries(PHP_RELEASES)) {
      docker.images.add(siteImage(branch));
      docker.phpOf(siteImage(branch), release);
    }
  }
  for (const site of SITES) {
    // A PHP site as site.create makes one: no WordPress administrator, and here a database of its
    // own, named as the panel names every site's.
    const php = isPhp(site);
    const row = world.db
      .insert(sites)
      .values({
        slug: site.slug,
        serverId: site.server,
        title: site.title,
        domains: JSON.stringify(siteDomains(site)),
        devHostname: devHostname(site.slug),
        isLive: site.state === 'dev' ? 0 : 1,
        keepDevAlias: 1,
        phpVersion: site.php,
        phpRelease: PHP_RELEASES[site.php] ?? null,
        locale: 'en_US',
        app: php ? 'php' : 'wordpress',
        webRoot: site.webRoot ?? '',
        status: site.state === 'stopped' ? 'stopped' : 'running',
        dbName: `wp_${site.slug.replace(/-/g, '_')}`,
        dbUser: `wp_${site.slug.replace(/-/g, '_')}`.slice(0, 32),
        dbPassword: 'demo-database-password',
        wpAdminUser: php ? null : 'admin',
        wpAdminEmail: php ? null : ADMIN_EMAIL,
        containerName: `wp-${site.slug}`,
        mailPassword: 'demo-relay-password',
        diskBytes: site.diskMb * MB,
        cpuLimit: site.limits?.cpuLimit ?? null,
        memoryLimitMb: site.limits?.memoryLimitMb ?? null,
        pidsLimit: site.limits?.pidsLimit ?? null,
        objectCache: site.redis ? 1 : 0,
        createdAt: createdAt(site),
        updatedAt: createdAt(site),
      })
      .returning()
      .get();
    siteIds.set(site.slug, row.id);

    const docker = site.server === 1 ? world.docker : world.remote(site.server).docker;
    docker.containers.set(`wp-${site.slug}`, site.state === 'stopped' ? 'exited' : 'running');
    docker.labelsByContainer.set(`wp-${site.slug}`, { [SITE_STACK_LABEL]: '2', ...(php ? { [SITE_APP_LABEL]: 'php' } : {}) });
    docker.imageByContainer.set(`wp-${site.slug}`, `sha256:${site.slug}`);
    // The site's folder, which the Files tab and the backup views look at, and a PHP site's web root in it.
    fs.mkdirSync(onDisk(path.join(sitePaths(world.config, site.slug).wordpress, site.webRoot ?? '')), { recursive: true });
  }
  seedCron(world);
  seedMonitoring(world);
}

/** The PHP site's cron lines, each with its last run and its next, worked out from it as the task does. */
function seedCron(world: TestWorld): void {
  for (const [slug, lines] of Object.entries(CRON_LINES)) {
    const site = SITES.find((s) => s.slug === slug)!;
    const added = createdAt(site) + DAY;
    for (const line of lines) {
      world.db
        .insert(siteCron)
        .values({
          siteId: siteIds.get(slug)!,
          expr: line.expr,
          command: line.command,
          enabled: 1,
          timeoutMin: line.timeoutMin,
          nextRunAt: nextCronRun(line.expr, new Date(line.last.startedAt)),
          lastStartedAt: line.last.startedAt,
          lastMs: line.last.ms,
          lastExit: 0,
          lastOutput: line.last.output,
          lastError: null,
          createdAt: added,
          updatedAt: added,
        })
        .run();
    }
  }
}

/** The uptime probe's and the container sampler's last day, and their latest readings. */
function seedMonitoring(world: TestWorld): void {
  const latest = (world.core.monitor as unknown as { latest: Map<number, object> }).latest;
  const rows: (typeof siteStats.$inferInsert)[] = [];
  for (const site of SITES) {
    const id = siteIds.get(site.slug)!;
    const next = rng(seedOf(`site:${site.slug}`));
    const stopped = site.state === 'stopped';
    const baseMs = 90 + Math.round(next() * 140) + (site.dailyVisitors > 1000 ? 60 : 0);
    const memBase = (110 + next() * 160) * MB;
    let last = { httpMs: baseMs, cpuPct: 0, memBytes: memBase };
    const steps = DAY / (5 * MINUTE);
    for (let i = steps; i >= 0; i--) {
      const ts = ago(i * 5 * MINUTE);
      if (site.ageDays === 0 && ts < ago(8 * MINUTE)) continue;
      const hour = new Date(ts).getUTCHours();
      const daily = 0.5 + 0.5 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
      const httpMs = Math.round(baseMs * (0.85 + 0.3 * next()) + daily * 25);
      const cpuPct = +(((site.dailyVisitors / 3000) * 18 + 0.6) * (0.4 + daily) * (0.8 + 0.4 * next())).toFixed(1);
      const memBytes = Math.round(memBase * (0.92 + 0.12 * daily + 0.04 * next()));
      if (!stopped) {
        rows.push({ siteId: id, ts, up: 1, httpMs });
        rows.push({ siteId: id, ts: ts + 1000, cpuPct, memBytes });
        last = { httpMs, cpuPct, memBytes };
      }
    }
    latest.set(id, {
      slug: site.slug,
      serverId: site.server,
      up: !stopped,
      httpStatus: stopped ? null : 200,
      httpMs: stopped ? null : last.httpMs,
      lastCheckedAt: ago(40_000),
      cpuPct: stopped ? null : last.cpuPct,
      memBytes: stopped ? null : last.memBytes,
      diskBytes: site.diskMb * MB,
    });
  }
  world.db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 500) tx.insert(siteStats).values(rows.slice(i, i + 500)).run();
  });
}

/** A site's WordPress folder on this machine's disk. */
export function siteFolder(world: TestWorld, slug: string): string {
  return onDisk(path.join(sitePaths(world.config, slug).wordpress));
}
