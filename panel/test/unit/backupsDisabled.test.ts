import { describe, expect, it } from 'vitest';
import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import { jobs, sites } from '../../src/db/schema.js';
import { Schedulers } from '../../src/jobs/schedulers.js';
import { describeCron } from '../../shared/cron.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';

async function authedApp() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

function addRunningSite(w: TestWorld, slug: string): number {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status: 'running',
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get().id;
}

const scheduledFor = (w: TestWorld, slug: string) =>
  w.db.select().from(jobs).where(eq(jobs.siteSlug, slug)).all().filter((j) => j.type === 'backup.create');

/** Fire the backup cron once, without waiting for 3am: what its timer does when it goes off. */
async function runBackupCron(w: TestWorld): Promise<void> {
  await w.deps.schedulers.run('backups', 'timer');
}

describe('per-site backup schedule', () => {
  it('skips sites with backups switched off, and keeps backing up the rest', async () => {
    const w = await makeWorld();
    addRunningSite(w, 'keeper');
    addRunningSite(w, 'opted-out');
    w.deps.sites.setBackupsEnabled('opted-out', false);

    await runBackupCron(w);

    expect(scheduledFor(w, 'keeper')).toHaveLength(1);
    expect(scheduledFor(w, 'opted-out')).toHaveLength(0);
  });

  it('still takes a backup on demand for a site that is out of the schedule', async () => {
    const { app, world: w, headers } = await authedApp();
    addRunningSite(w, 'opted-out');
    w.deps.sites.setBackupsEnabled('opted-out', false);

    // Switching the schedule off is about the scheduled run, not about refusing to protect
    // the site: the manual button, the pre-restore copy and the final backup on delete are
    // exactly the ones that exist to catch a mistake in progress.
    const res = await app.inject({ method: 'POST', url: '/api/sites/opted-out/backups', headers, payload: {} });
    expect(res.statusCode).toBe(202);
    expect(scheduledFor(w, 'opted-out')).toHaveLength(1);
    await app.close();
  });

  it('is on for new sites, and the API round-trips both ways', async () => {
    const { app, world: w, headers } = await authedApp();
    addRunningSite(w, 'acme');

    expect((await w.deps.sites.detail('acme')).backupsEnabled).toBe(true);

    const off = await app.inject({
      method: 'PUT',
      url: '/api/sites/acme/backups-enabled',
      headers,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    // The response is the fresh site detail, so the UI does not need a second round trip.
    expect(off.json().backupsEnabled).toBe(false);

    const on = await app.inject({
      method: 'PUT',
      url: '/api/sites/acme/backups-enabled',
      headers,
      payload: { enabled: true },
    });
    expect(on.json().backupsEnabled).toBe(true);
    await app.close();
  });

  it('404s for an unknown site rather than silently doing nothing', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sites/nope/backups-enabled',
      headers,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  /**
   * The schedule is an operator-editable cron expression, so the site page describes it
   * instead of calling it "nightly" - which it only is by default.
   */
  it('publishes the backup schedule so the site page can name it rather than guess', async () => {
    const { app, world: w, headers } = await authedApp();

    const meta = await app.inject({ method: 'GET', url: '/api/meta', headers });
    expect(meta.json().backupCron).toBe(w.deps.settings.get('backupCron'));
    expect(describeCron(meta.json().backupCron)).toBe('At 03:00, every day.');

    // Move it to twice a week and the published value follows, so the page's wording does.
    await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { backupCron: '30 2 * * 1,4' } });
    const after = await app.inject({ method: 'GET', url: '/api/meta', headers });
    expect(after.json().backupCron).toBe('30 2 * * 1,4');
    expect(describeCron(after.json().backupCron)).toBe('At 02:30 on Mondays and Thursdays.');
    await app.close();
  });

  it('runs the schedule the operator set, not a nightly one', async () => {
    const w = await makeWorld();
    addRunningSite(w, 'acme');
    w.deps.settings.set('backupCron', '0 * * * *'); // hourly

    const schedulers = new Schedulers(w.core, w.worker);
    schedulers.scheduleBackups(w.deps.settings.get('backupCron'));
    const { cadence } = schedulers.get('backups');
    expect(cadence.cron).toBe('0 * * * *');
    const [a, b] = new Cron(cadence.cron!, { paused: true }).nextRuns(2);
    expect(b!.getTime() - a!.getTime()).toBe(3600_000);
    schedulers.stop();
  });
});
