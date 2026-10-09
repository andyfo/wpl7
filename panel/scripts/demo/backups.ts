/**
 * Backups: ten nights of scheduled backups for every site that has been around that long, a
 * manual one, the safety copies a bulk update took, and a deleted site whose backups remain.
 * One offsite destination, "Archive bucket" (S3-compatible, encrypted), holding a copy of each
 * scheduled backup, with last night's copies from sin1 still waiting. Disk space is fixed, so the
 * Storage page does not show whatever machine the demo runs on.
 */
import path from 'node:path';
import { backupCopies, backupDestinations, backups } from '../../src/db/schema.js';
import { tsStamp } from '../../src/services/backup.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, MINUTE, ago, DEMO_NOW } from './clock.js';
import { DELETED_SITE, EXTERNAL_SITES, SERVERS, SITES, rng, seedOf } from './data.js';
import { INVENTORY, WORDPRESS } from './plugins.js';
import { siteIds } from './sites.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The bulk update of yesterday afternoon took a backup of these sites first (see jobs.ts). */
export const BULK_UPDATED = ['northwind-bakery', 'alpine-dental', 'harbor-yoga', 'lumen-law', 'pixel-press'];
export const BULK_AT = ago(DAY - 3 * HOUR);

export const DESTINATION_NAME = 'Archive bucket';

export function seedBackups(world: TestWorld): void {
  const root = world.config.paths.backups;
  const today3am = Math.floor(DEMO_NOW / DAY) * DAY + 3 * HOUR;
  const rows: (typeof backups.$inferInsert & { offsite?: 'complete' | 'pending' })[] = [];
  const add = (slug: string, serverId: number, type: (typeof backups.$inferInsert)['type'], createdAt: number, sizeBytes: number, extra: Partial<typeof backups.$inferInsert> = {}) => {
    const site = SITES.find((s) => s.slug === slug);
    rows.push({
      siteId: siteIds.get(slug) ?? null,
      siteSlug: slug,
      serverId,
      type,
      status: 'complete',
      path: path.join(root, slug, tsStamp(new Date(createdAt))),
      rootPath: root,
      filesPresent: 1,
      sizeBytes,
      wpVersion: INVENTORY[slug]?.core ?? WORDPRESS,
      phpVersion: site?.php ?? '8.2',
      createdAt,
      ...extra,
    });
  };

  for (const site of SITES) {
    const next = rng(seedOf(`backups:${site.slug}`));
    const nights = Math.min(10, site.ageDays);
    for (let n = nights - 1; n >= 0; n--) {
      const createdAt = today3am - n * DAY + Math.round(next() * 9 * MINUTE);
      add(site.slug, site.server, 'scheduled', createdAt, Math.round(site.diskMb * MB * (0.52 + next() * 0.04)));
    }
  }
  // Sites hosted elsewhere, pulled through WPL7 Connect onto fra1 with the others.
  for (const site of EXTERNAL_SITES) {
    const next = rng(seedOf(`backups:${site.slug}`));
    for (let n = Math.min(10, site.ageDays) - 1; n >= 0; n--) {
      const createdAt = today3am - n * DAY + Math.round(next() * 9 * MINUTE);
      add(site.slug, site.storage, 'scheduled', createdAt, Math.round(1115 * MB * (0.5 + next() * 0.04)), { phpVersion: site.php });
    }
  }
  add('northwind-bakery', 1, 'manual', ago(2 * DAY + 4 * HOUR), Math.round(1840 * MB * 0.55), { note: 'Before the menu redesign' });
  for (const slug of BULK_UPDATED) {
    const site = SITES.find((s) => s.slug === slug)!;
    add(slug, site.server, 'pre_update', BULK_AT + BULK_UPDATED.indexOf(slug) * 2 * MINUTE, Math.round(site.diskMb * MB * 0.55));
  }
  // The deleted site: its last nightly backups, and the final one taken when it was deleted.
  for (let n = 3; n >= 1; n--) add(DELETED_SITE.slug, DELETED_SITE.server, 'scheduled', ago(12 * DAY + n * DAY - 3 * HOUR), 690 * MB);
  add(DELETED_SITE.slug, DELETED_SITE.server, 'final', ago(12 * DAY - 2 * HOUR), 702 * MB);

  rows.sort((a, b) => a.createdAt - b.createdAt);
  const inserted = world.db.transaction((tx) => rows.map((row) => tx.insert(backups).values(row).returning().get()));

  // The offsite destination, and a copy of every backup it takes since it was added.
  const destination = world.db
    .insert(backupDestinations)
    .values({
      name: DESTINATION_NAME,
      provider: 's3-compatible',
      config: JSON.stringify({
        vendor: 'b2',
        endpoint: 's3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        bucket: 'northwind-agency-backups',
        prefix: 'panel.example.com',
        accessKeyId: '004a1b2c3d4e5f60000000001',
      }),
      secrets: JSON.stringify({ secretAccessKey: 'demo-secret-not-real' }),
      enabled: 1,
      copyTypes: JSON.stringify(['scheduled', 'manual', 'final', 'panel']),
      copyFromTs: ago(40 * DAY),
      retentionScheduled: 30,
      retentionMode: 'panel',
      encryption: 'crypt',
      cryptPassword: 'demo-crypt-password',
      cryptSalt: 'demo-crypt-salt',
      lastSuccessAt: today3am + 41 * MINUTE,
      createdAt: ago(40 * DAY),
      updatedAt: ago(40 * DAY),
    })
    .returning()
    .get();
  const sin1 = SERVERS.find((s) => s.name === 'sin1')!.id;
  world.db.transaction((tx) => {
    for (const row of inserted) {
      if (!['scheduled', 'manual', 'final'].includes(row.type)) continue;
      const lastNightOnSin1 = row.serverId === sin1 && row.createdAt >= today3am && row.siteSlug !== DELETED_SITE.slug;
      tx.insert(backupCopies)
        .values({
          backupId: row.id,
          destinationId: destination.id,
          status: lastNightOnSin1 ? 'pending' : 'complete',
          remotePath: `panel.example.com/${row.siteSlug}/${path.basename(row.path)}`,
          sizeBytes: lastNightOnSin1 ? null : row.sizeBytes,
          attempts: lastNightOnSin1 ? 0 : 1,
          startedAt: lastNightOnSin1 ? null : row.createdAt + 6 * MINUTE,
          completedAt: lastNightOnSin1 ? null : row.createdAt + 14 * MINUTE,
          createdAt: row.createdAt + MINUTE,
        })
        .run();
    }
  });

  // Each server's disk, as the Storage page and the free-space check see it.
  const disks: Record<number, { totalBytes: number; freeBytes: number }> = {
    1: { totalBytes: 160 * GB, freeBytes: 109 * GB },
    2: { totalBytes: 160 * GB, freeBytes: 120 * GB },
    3: { totalBytes: 80 * GB, freeBytes: 38 * GB },
  };
  for (const server of SERVERS) {
    const files = world.servers.handleFor(server.id).files;
    files.statvfs = async () => disks[server.id] ?? null;
  }
}
