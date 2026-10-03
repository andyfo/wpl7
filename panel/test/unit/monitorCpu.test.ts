import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { siteStats, sites } from '../../src/db/schema.js';
import { makeWorld, type TestWorld } from '../helpers.js';

const MS = 1e6; // nanoseconds per millisecond

function addRunningSite(w: TestWorld, slug: string): number {
  const now = Date.now();
  const id = w.db
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
  w.docker.containers.set(`wp-${slug}`, 'running');
  return id;
}

/**
 * The monitor's clock, standing still until the test moves it: the interval a CPU figure is
 * averaged over is then exactly the one the test chose, however busy the machine running it.
 */
function frozenClock() {
  let now = Date.now();
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    advance: (ms: number) => void (now += ms),
    restore: () => spy.mockRestore(),
  };
}

/** Tick with a gap: two reads inside the same millisecond have no interval to average over. */
async function tick(w: TestWorld): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
  await w.core.monitor.tickContainerStats();
}

const cpuSamples = (w: TestWorld, siteId: number) =>
  w.db
    .select()
    .from(siteStats)
    .where(eq(siteStats.siteId, siteId))
    .all()
    .map((r) => r.cpuPct)
    .filter((v): v is number => v !== null);

/**
 * Regression: an idle WordPress site reported ~30% CPU with ~95% spikes every five
 * minutes, while its cgroup said 0.32% of one core.
 *
 * Nothing was wrong with the site. Docker's one-shot CPU percentage compares two samples
 * about a second apart, and every scheduler here ticks on a multiple of a minute from the
 * same start - so that second contained the panel's own uptime probe on every tick, and
 * its wp-cron run on every fifth. The panel was charting its own monitoring.
 */
describe('site CPU measurement', () => {
  it('spreads a burst across the whole interval instead of reporting the burst', async () => {
    const w = await makeWorld();
    const siteId = addRunningSite(w, 'acme');
    w.docker.cpuNsPerSample = 0;
    const clock = frozenClock();
    try {
      await w.core.monitor.tickContainerStats(); // baseline read; nothing to difference yet
      expect(cpuSamples(w, siteId)).toEqual([]);

      // What an idle site actually does: nothing, then one request pegging a core for 20ms,
      // then nothing. Docker's own number for a window that happens to contain the request
      // would be ~100%; the honest figure for the interval is 20ms over the 200ms gap.
      clock.advance(200);
      w.docker.cpuNsPerSample = 20 * MS;
      await w.core.monitor.tickContainerStats();
    } finally {
      clock.restore();
    }
    const [pct] = cpuSamples(w, siteId);
    expect(pct).toBe(10);
    expect(w.core.monitor.latestFor(siteId)!.cpuPct).toBe(pct);
  });

  it('is a percentage of one core, so half a core reads as 50%', async () => {
    const w = await makeWorld();
    const siteId = addRunningSite(w, 'acme');
    w.docker.cpuNsPerSample = 0;
    const clock = frozenClock();
    try {
      await w.core.monitor.tickContainerStats();
      clock.advance(120);
      w.docker.cpuNsPerSample = 60 * MS;
      await w.core.monitor.tickContainerStats();
    } finally {
      clock.restore();
    }
    expect(cpuSamples(w, siteId)).toEqual([50]);
  });

  it('records nothing rather than a wrong number when the counter resets', async () => {
    const w = await makeWorld();
    const siteId = addRunningSite(w, 'acme');
    w.docker.cpuNsPerSample = 10 * MS;

    await tick(w);
    await tick(w);
    expect(cpuSamples(w, siteId)).toHaveLength(1);

    // The container restarted: its cgroup counter starts from zero again, so the stored
    // baseline is higher than the new reading and differencing them would be nonsense.
    w.docker.cpuNs = 0;
    await tick(w);
    expect(cpuSamples(w, siteId)).toHaveLength(1);

    // …and the tick after that has a valid baseline again.
    await tick(w);
    expect(cpuSamples(w, siteId)).toHaveLength(2);
  });

  it('drops the baseline while a site is stopped', async () => {
    const w = await makeWorld();
    const siteId = addRunningSite(w, 'acme');
    w.docker.cpuNsPerSample = 10 * MS;

    await tick(w);
    w.db.update(sites).set({ status: 'stopped' }).where(eq(sites.id, siteId)).run();
    await tick(w);

    // Back up, with a counter that restarted at zero. Charting the time it was off as CPU
    // the site had used would be the same mistake in a different disguise.
    w.db.update(sites).set({ status: 'running' }).where(eq(sites.id, siteId)).run();
    w.docker.cpuNs = 0;
    await tick(w);
    expect(cpuSamples(w, siteId)).toEqual([]);
  });
});
