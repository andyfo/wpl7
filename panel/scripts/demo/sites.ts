/**
 * The sites: eleven on three servers, live, dev-only and stopped, each with its container in
 * the state its row says, a day of uptime and resource samples, and its disk use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { siteStats, sites } from '../../src/db/schema.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, MINUTE, ago } from './clock.js';
import { ADMIN_EMAIL, SITES, devHostname, rng, seedOf, siteDomains, type DemoSite } from './data.js';
import { onDisk } from './paths.js';

const MB = 1024 * 1024;

/** The site row's id by slug, filled in by seedSites. */
export const siteIds = new Map<string, number>();

export const createdAt = (site: DemoSite): number => (site.ageDays === 0 ? ago(10 * MINUTE) : ago(site.ageDays * DAY + 3 * 3600_000));

export function seedSites(world: TestWorld): void {
  for (const site of SITES) {
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
        locale: 'en_US',
        status: site.state === 'stopped' ? 'stopped' : 'running',
        dbName: `wp_${site.slug.replace(/-/g, '_')}`,
        dbUser: `wp_${site.slug.replace(/-/g, '_')}`.slice(0, 32),
        dbPassword: 'demo-database-password',
        wpAdminUser: 'admin',
        wpAdminEmail: ADMIN_EMAIL,
        containerName: `wp-${site.slug}`,
        mailPassword: 'demo-relay-password',
        diskBytes: site.diskMb * MB,
        createdAt: createdAt(site),
        updatedAt: createdAt(site),
      })
      .returning()
      .get();
    siteIds.set(site.slug, row.id);

    const docker = site.server === 1 ? world.docker : world.remote(site.server).docker;
    docker.containers.set(`wp-${site.slug}`, site.state === 'stopped' ? 'exited' : 'running');
    docker.images.add(`wpl7-wordpress:php${site.php}`);
    // The site's folder, which the Files tab and the backup views look at.
    fs.mkdirSync(onDisk(sitePaths(world.config, site.slug).wordpress), { recursive: true });
  }
  seedMonitoring(world);
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
