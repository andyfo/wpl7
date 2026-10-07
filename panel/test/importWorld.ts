import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { eq } from 'drizzle-orm';
import { imports, jobLogs, jobs } from '../src/db/schema.js';
import { hostExec } from '../src/lib/exec.js';
import { sitePaths } from '../src/services/siteSpec.js';
import type { ImportRunBody } from '../shared/schemas.js';
import { makeWorld, waitFor, type TestWorld } from './helpers.js';
import { sampleReport } from './importFixtures.js';
import { FakeSourceSite, fakeTable, type FakeFile } from './importFake.js';

/** An old site to import: a few files of every kind, and three tables, one without its prefix. */

export const PHOTO = Buffer.alloc(200 * 1024, 3);
export const BIG = Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251));

export function oldSiteFiles(): Record<string, FakeFile> {
  return {
    'index.php': "<?php define('WP_USE_THEMES', true); require __DIR__ . '/wp-blog-header.php';",
    'wp-config.php': "<?php define('DB_PASSWORD', 'never-leaves');",
    'wp-includes/version.php': "<?php $wp_version = '7.1.2';",
    'wp-content/object-cache.php': '<?php // Redis drop-in',
    'wp-content/plugins/redis-cache/redis-cache.php': '<?php /* Plugin Name: Redis Object Cache */',
    'wp-content/uploads/2024/01/photo.jpg': PHOTO,
    'wp-content/uploads/big.bin': BIG,
    'wp-content/uploads/empty': 'dir',
    'wp-content/shortcut': { link: '../index.php' },
  };
}

export function oldSiteTables() {
  return [
    fakeTable('wpx_options', [
      [1, 'https://willow-pediatrics.example'],
      [2, "Willow's; Pediatrics"],
      [3, null],
      [4, 'line\nbreak'],
      [5, 'back\\slash'],
    ]),
    fakeTable('wpx_posts', [[1, 'Hello']], { binary: [Buffer.from([0, 1, 2, 255])] }),
    fakeTable('other_stats', [[1, 'left behind']]),
  ];
}

export const CHOICES: ImportRunBody = {
  title: 'Willow Pediatrics',
  slug: 'willow',
  carryConstants: ['WP_MEMORY_LIMIT', 'WP_POST_REVISIONS'],
  deactivatePlugins: ['redis-cache'],
  removeDropins: ['object-cache.php'],
  removeMuPlugins: [],
  rewritePaths: true,
};

/** A world with an import connected to a fake old site, ready to start. */
export async function connected(opts: { fake?: Partial<ConstructorParameters<typeof FakeSourceSite>[0]>; world?: TestWorld } = {}) {
  const w = opts.world ?? (await makeWorld({ exec: hostExec }));
  // The image's entrypoint: wp-config.php, from the container's settings, at its first start.
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const p = sitePaths(w.config, name.slice(3));
    const config = path.join(p.wordpress, 'wp-config.php');
    if (fs.existsSync(p.wordpress) && !fs.existsSync(config)) fs.writeFileSync(config, '<?php // written by the image');
  };
  const row = w.core.imports.create({ allowHttp: false }, 'admin');
  const fake = new FakeSourceSite({ token: row.token!, importId: row.id, files: oldSiteFiles(), tables: oldSiteTables(), ...opts.fake });
  w.core.imports.transport = fake.transport;
  // Its own size, not the sample's 1.4 GB: the free-disk check runs against this machine's disk.
  const base = sampleReport();
  const report = sampleReport({
    files: { count: 9, bytes: 4_000_000, dirs: 5, links: 1, unreadable: 0, excluded: [] },
    db: { ...(base.db as object), bytes: 100_000 },
  });
  await w.core.imports.connect(w.core.imports.get(row.id), report);
  // What the database restore was handed, read before the staging folder goes.
  const dumps: string[] = [];
  const importFromAs = w.dbAdmin.importFromAs.bind(w.dbAdmin);
  w.dbAdmin.importFromAs = async (src, db, user, password) => {
    dumps.push(zlib.gunzipSync(fs.readFileSync(src)).toString('utf8'));
    return importFromAs(src, db, user, password);
  };
  return { w, id: row.id, fake, dumps };
}

export const importRow = (w: TestWorld, id: number) => w.db.select().from(imports).where(eq(imports.id, id)).get()!;

/** Run the queue until no import job is queued or running, and the import has settled. */
export async function settle(w: TestWorld, id: number, timeoutMs = 30_000) {
  w.worker.start();
  try {
    await waitFor(() => {
      const row = importRow(w, id);
      const active = w.db
        .select()
        .from(jobs)
        .all()
        .filter((j) => j.type.startsWith('site.import') && (j.status === 'queued' || j.status === 'running'));
      return active.length === 0 && ['done', 'failed', 'connected'].includes(row.status);
    }, timeoutMs);
  } finally {
    await w.worker.stop();
  }
  return importRow(w, id);
}

export const logOf = (w: TestWorld, jobId: number) =>
  w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => `${l.level}: ${l.message}`);

export const wpCalls = (w: TestWorld, container: string) =>
  w.docker.calls.filter((c) => c.method === 'exec' && c.args[0] === container).map((c) => (c.args[1] as string[]).join(' '));
