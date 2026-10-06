/**
 * The plugin inventory of every site, what wpvulnerability.net knows about each plugin, and
 * the plugin catalog with its two premium zips. The counts on the Sites list and the fleet
 * tiles are worked out by the panel itself (wpInventory.recount), not written here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pluginZipChecks, plugins, siteWpComponents, siteWpStatus, vulnFeed } from '../../src/db/schema.js';
import { zipOf, type TestWorld } from '../../test/helpers.js';
import { HOUR, MINUTE, ago } from './clock.js';
import { CATALOG, DEMO_ADVISORY, INVENTORY, LATEST } from './plugins.js';
import { siteIds } from './sites.js';
import { onDisk } from './paths.js';

/** wpvulnerability.net has no record of this theme: it answers "no such slug". It knows the rest, the premium plugins too. */
const UNKNOWN_TO_FEED = new Set(['breakdance-zero']);

export function seedInventory(world: TestWorld): void {
  const db = world.db;
  const slugs = new Map<string, 'plugin' | 'theme'>();
  db.transaction((tx) => {
    for (const [slug, inv] of Object.entries(INVENTORY)) {
      const siteId = siteIds.get(slug)!;
      const scannedAt = ago((slug === 'oak-and-ivy' ? 7 : 52) * MINUTE);
      tx.insert(siteWpStatus)
        .values({
          siteId,
          coreVersion: inv.core,
          coreUpdateVersion: inv.coreUpdate?.version ?? null,
          coreUpdateType: inv.coreUpdate?.type ?? null,
          scannedAt,
        })
        .run();
      for (const c of inv.components) {
        slugs.set(c.slug, c.kind);
        tx.insert(siteWpComponents)
          .values({
            siteId,
            kind: c.kind,
            slug: c.slug,
            title: c.title,
            status: c.status,
            version: c.version,
            updateVersion: c.updateVersion ?? null,
            updateState: c.updateVersion ? 'available' : 'none',
            autoUpdate: 0,
            file: c.kind === 'plugin' ? `${c.slug}/${c.slug}.php` : null,
            seenAt: scannedAt,
          })
          .run();
      }
    }
    const fetchedAt = ago(5 * HOUR);
    for (const [slug, kind] of slugs) {
      const advisories = slug === DEMO_ADVISORY.slug ? [DEMO_ADVISORY.advisory] : [];
      tx.insert(vulnFeed)
        .values({ kind, slug, fetchedAt, attemptedAt: fetchedAt, known: UNKNOWN_TO_FEED.has(slug) ? 0 : 1, advisories: JSON.stringify(advisories) })
        .run();
    }
    for (const core of new Set(Object.values(INVENTORY).map((i) => i.core))) {
      tx.insert(vulnFeed).values({ kind: 'core', slug: core, fetchedAt, attemptedAt: fetchedAt, known: 1, advisories: '[]' }).run();
    }
  });
  world.core.wpInventory.recount();
  seedCatalog(world);
}

function seedCatalog(world: TestWorld): void {
  // The real path, not /srv: the panel opens a catalog zip itself to read its folder name.
  const dir = onDisk(world.config.paths.plugins);
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of CATALOG) {
    let zipPath: string | null = null;
    if (entry.kind === 'zip') {
      zipPath = path.join(dir, `${entry.slug}-demo.zip`);
      fs.writeFileSync(
        zipPath,
        zipOf({
          [`${entry.slug}/`]: '',
          [`${entry.slug}/${entry.slug}.php`]: `<?php\n/*\n * Plugin Name: ${entry.name}\n * Version: ${LATEST[entry.slug]}\n */\n`,
        }),
      );
    }
    const row = world.db
      .insert(plugins)
      .values({ kind: entry.kind, slug: entry.slug, name: entry.name, zipPath, isDefault: entry.isDefault, createdAt: ago(60 * 24 * HOUR) })
      .returning()
      .get();
    if (entry.kind === 'zip') {
      world.db
        .insert(pluginZipChecks)
        .values({
          pluginId: row.id,
          status: 'done',
          zipSha256: '0'.repeat(64),
          scanner: '0.21.12',
          folder: entry.slug,
          version: LATEST[entry.slug],
          files: entry.slug === 'breakdance' ? 2140 : 1385,
          manifest: '{}',
          findings: '[]',
          confirmed: 0,
          checkedAt: ago(59 * 24 * HOUR),
        })
        .run();
    }
  }
}
