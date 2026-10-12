import { eq } from 'drizzle-orm';
import { jobLogs, jobs, siteConnections, sites, type SiteRow } from '../src/db/schema.js';
import { hostExec } from '../src/lib/exec.js';
import { makeWorld, waitFor, type TestWorld } from './helpers.js';
import { FakeConnectedSite } from './connectFake.js';
import { fakeTable, type FakeFile } from './importFake.js';

/** A site hosted elsewhere, added to the panel through WPL7 Connect, with a fake behind it. */

export function shopFiles(): Record<string, FakeFile> {
  return {
    'index.php': "<?php define('WP_USE_THEMES', true); require __DIR__ . '/wp-blog-header.php';",
    'wp-config.php': "<?php define('DB_PASSWORD', 'stays-on-the-site'); $table_prefix = 'wp_';",
    'wp-includes/version.php': "<?php $wp_version = '7.1.2';",
    'wp-content/plugins/akismet/akismet.php': '<?php /* Plugin Name: Akismet Anti-spam */',
    'wp-content/plugins/wpl7-connect/wpl7-connect.php': '<?php /* Plugin Name: WPL7 Connect */',
    'wp-content/uploads/2026/10/photo.jpg': Buffer.alloc(150 * 1024, 7),
    'wp-content/uploads/empty': 'dir',
  };
}

export function shopTables() {
  return [
    fakeTable('wp_options', [
      [1, 'https://shop.example.org'],
      [2, "Shop's; options"],
      [3, 'line\nbreak'],
    ]),
    fakeTable('wp_posts', [[1, 'Hello'], [2, 'World'], [3, 'Third']]),
    fakeTable('other_app_table', [[1, 'not the site']]),
  ];
}

/**
 * A world with "shop" connected and added. `real` gives server 1 a real exec (tar, gzip), which a
 * backup needs. The add's own first jobs are canceled: each test runs what it is about.
 */
export async function externalWorld(opts: { real?: boolean; fake?: Partial<ConstructorParameters<typeof FakeConnectedSite>[0]>; world?: TestWorld } = {}) {
  const w = opts.world ?? (await makeWorld(opts.real ? { exec: hostExec } : {}));
  const row = w.core.connections.create({ allowHttp: false }, 'admin');
  const fake = new FakeConnectedSite({
    connectionId: row.id,
    publicKey: row.publicKey,
    files: shopFiles(),
    tables: shopTables(),
    ...opts.fake,
  });
  w.core.connections.transport = fake.transport;
  w.core.connections.probe = fake.probe;
  await w.core.connections.enroll(row, fake.report());
  await w.core.connections.check(row.id);
  const { site } = w.core.connections.add(row.id, { slug: 'shop', backups: true });
  w.db.update(jobs).set({ status: 'canceled' }).where(eq(jobs.status, 'queued')).run();
  return { w, fake, site, connectionId: row.id };
}

export const siteRow = (w: TestWorld, slug = 'shop'): SiteRow => w.db.select().from(sites).where(eq(sites.slug, slug)).get()!;

export const connectionRow = (w: TestWorld, siteId: number) =>
  w.db.select().from(siteConnections).where(eq(siteConnections.siteId, siteId)).get()!;

/** Run the queue until the job is over, and return it with its log. */
export async function runJob(w: TestWorld, jobId: number, timeoutMs = 30_000) {
  w.worker.start();
  try {
    await waitFor(() => {
      const job = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      return job !== undefined && ['succeeded', 'failed', 'canceled'].includes(job.status);
    }, timeoutMs);
  } finally {
    await w.worker.stop();
  }
  const job = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
  const log = w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).all().map((l) => `${l.level}: ${l.message}`);
  return { job, log, result: job.result ? (JSON.parse(job.result) as Record<string, unknown>) : null };
}
