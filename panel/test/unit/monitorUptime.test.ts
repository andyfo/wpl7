import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { jobs, siteStats, sites, type JobRow } from '../../src/db/schema.js';
import { getRegistry } from '../../src/jobs/registry.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

let edge: http.Server | null = null;

afterEach(() => {
  edge?.close();
  edge = null;
});

/** The real probeUrlFor goes through Traefik on :80, which no test can bind. */
async function edgeAnswering(w: TestWorld, status: number): Promise<void> {
  await edgeServing(w, (_host, res) => res.writeHead(status).end(''));
}

/** An edge that answers each request through `answer`, with the Host header it was sent. */
async function edgeServing(
  w: TestWorld,
  answer: (host: string, res: http.ServerResponse) => void | Promise<void>,
): Promise<void> {
  edge = http.createServer((req, res) => void answer(req.headers.host ?? '', res));
  await new Promise<void>((r) => edge!.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(edge!.address() as AddressInfo).port}/`;
  w.servers.handleFor(1).probeUrlFor = () => url;
}

function addSite(w: TestWorld, slug: string, status: string): number {
  const now = Date.now();
  const id = w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status,
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

/** Run the worker until the job has ended, and return its row. */
async function runJob(w: TestWorld, jobId: number): Promise<JobRow> {
  const row = () => w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
  w.worker.start();
  try {
    await waitFor(() => row().status !== 'queued' && row().status !== 'running', 15_000);
  } finally {
    await w.worker.stop();
  }
  return row();
}

describe('uptime probe', () => {
  /**
   * Regression: `error` is not a statement about whether the site serves. A delete whose
   * final backup fails marks the row `error` with the container still up and still
   * answering - and the tick used to write `up: false` for every non-running row without
   * making a request, which the site page then reported as a measured "not serving pages".
   */
  it('probes a site marked error rather than assuming it is down', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'half-deleted', 'error');
    await edgeAnswering(w, 200);

    await w.core.monitor.tickUptime();

    const entry = w.core.monitor.latestFor(siteId)!;
    expect(entry.up).toBe(true);
    expect(entry.httpStatus).toBe(200);
  });

  it('still reports an error-state site that really is down', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'broken', 'error');
    await edgeAnswering(w, 404); // Traefik's catch-all: no router for this hostname

    await w.core.monitor.tickUptime();

    expect(w.core.monitor.latestFor(siteId)!.up).toBe(false);
    expect(w.core.monitor.latestFor(siteId)!.httpStatus).toBe(404);
  });

  it('does not spend a request on a site the panel stopped itself', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'parked', 'stopped');
    let hits = 0;
    edge = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200).end('');
    });
    await new Promise<void>((r) => edge!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(edge!.address() as AddressInfo).port}/`;
    w.servers.handleFor(1).probeUrlFor = () => url;

    await w.core.monitor.tickUptime();

    expect(hits).toBe(0);
    expect(w.core.monitor.latestFor(siteId)!.up).toBe(false);
  });
});

describe('uptime checks around a job that changes the site', () => {
  /**
   * Regression: going live replaces the site's container twice, and a check that landed in one
   * of those swaps read Traefik's 404. The site page then said Offline - with "Recreate
   * container" offered as the repair - for a site that was serving, until the next check.
   */
  it('leaves a site alone while a job is changing it, and checks it as the job ends', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'going-live', 'running');
    const hosts: string[] = [];
    await edgeServing(w, (host, res) => {
      hosts.push(host);
      res.writeHead(200).end('');
    });

    const release = w.core.monitor.holdChecks(siteId);
    await w.core.monitor.tickUptime();
    expect(hosts).toEqual([]);
    expect(w.core.monitor.latestFor(siteId)).toBeNull();

    await release();
    expect(hosts).toEqual(['going-live.test']);
    expect(w.core.monitor.latestFor(siteId)).toMatchObject({ up: true, httpStatus: 200 });
  });

  it('drops an answer that came back after a job began on the site', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'swapping', 'running');
    await edgeServing(w, (_host, res) => {
      // The job takes the container away while the request is out; Traefik has no route.
      w.core.monitor.holdChecks(siteId);
      res.writeHead(404).end('');
    });

    await w.core.monitor.tickUptime();

    expect(w.core.monitor.latestFor(siteId)?.up ?? null).toBeNull();
    expect(w.db.select().from(siteStats).where(eq(siteStats.siteId, siteId)).all()).toEqual([]);
  });

  it('does not probe a site from a row that a job changed after the tick listed it', async () => {
    const w = await makeWorld();
    const firstId = addSite(w, 'first', 'running');
    const secondId = addSite(w, 'second', 'running');
    const hosts: string[] = [];
    await edgeServing(w, async (host, res) => {
      hosts.push(host);
      // While the tick waits on the first site, a job on the second begins and ends - going
      // live, say, so the domain the tick listed for it is no longer its own.
      if (host === 'first.test') await w.core.monitor.holdChecks(secondId)();
      res.writeHead(200).end('');
    });

    await w.core.monitor.tickUptime();

    // The second site was checked once, by the job's end; the tick did not ask again.
    expect(hosts).toEqual(['first.test', 'second.test']);
    expect(w.core.monitor.latestFor(firstId)).toMatchObject({ up: true });
    expect(w.core.monitor.latestFor(secondId)).toMatchObject({ up: true });
  });

  it('ends a restart with a reading taken after it, before the job reads as finished', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'restarted', 'running');
    let status = 404;
    await edgeServing(w, (_host, res) => res.writeHead(status).end(''));
    await w.core.monitor.tickUptime();
    expect(w.core.monitor.latestFor(siteId)).toMatchObject({ up: false, httpStatus: 404 });

    status = 200;
    const job = w.worker.enqueue('site.restart', { siteId }, { id: siteId, slug: 'restarted', serverId: 1 });
    const done = await runJob(w, job.id);

    expect(done.status).toBe('succeeded');
    const entry = w.core.monitor.latestFor(siteId)!;
    expect(entry).toMatchObject({ up: true, httpStatus: 200 });
    expect(entry.lastCheckedAt).toBeGreaterThanOrEqual(done.startedAt!);
    expect(entry.lastCheckedAt).toBeLessThanOrEqual(done.finishedAt!);
  });

  it('shows a started site as answering once Start is done, not as the stopped site it was', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'parked', 'stopped');
    w.docker.containers.set('wp-parked', 'exited');
    await edgeAnswering(w, 200);
    await w.core.monitor.tickUptime();
    expect(w.core.monitor.latestFor(siteId)!.up).toBe(false);

    const job = w.worker.enqueue('site.start', { siteId }, { id: siteId, slug: 'parked', serverId: 1 });

    expect((await runJob(w, job.id)).status).toBe('succeeded');
    expect(w.core.monitor.latestFor(siteId)).toMatchObject({ up: true, httpStatus: 200 });
  });

  /**
   * Regression: the hold used to end before the final check ran. A scheduled check could then
   * start beside it, fail on the container still settling, and answer after it - leaving the
   * site Offline once the job had ended, and a down sample in its history.
   */
  it('keeps scheduled checks off the site until its final check is in', async () => {
    const w = await makeWorld();
    const siteId = addSite(w, 'settling', 'running');
    let requests = 0;
    let tick: Promise<void> | null = null;
    let tickDone = false;
    let late: http.ServerResponse | null = null;
    await edgeServing(w, (_host, res) => {
      if (++requests === 1) {
        // The final check is out, and the minute comes round.
        tick = w.core.monitor.tickUptime().then(() => void (tickDone = true));
        setImmediate(() => res.writeHead(200).end(''));
      } else {
        late = res; // only the tick asks twice, and its answer comes last
      }
    });

    await w.core.monitor.holdChecks(siteId)();
    await waitFor(() => tickDone || late !== null);
    (late as http.ServerResponse | null)?.writeHead(503).end('');
    await tick;

    expect(requests).toBe(1);
    expect(w.core.monitor.latestFor(siteId)).toMatchObject({ up: true, httpStatus: 200 });
    expect(w.db.select().from(siteStats).where(eq(siteStats.siteId, siteId)).all().map((r) => r.up)).toEqual([1]);
  });
});

describe('the check at the end of a job, against the job', () => {
  const restart = getRegistry()['site.restart']!;
  const timeoutMs = restart.timeoutMs;

  afterEach(() => {
    restart.timeoutMs = timeoutMs;
  });

  /** A site whose final check answers only after the job's time limit has passed. */
  async function slowSite(w: TestWorld): Promise<number> {
    const siteId = addSite(w, 'slow', 'running');
    restart.timeoutMs = 500;
    await edgeServing(w, (_host, res) => void setTimeout(() => res.writeHead(200).end(''), 900));
    return siteId;
  }

  it('does not count against the time limit of a job that ended within it', async () => {
    const w = await makeWorld();
    const siteId = await slowSite(w);

    const job = w.worker.enqueue('site.restart', { siteId }, { id: siteId, slug: 'slow', serverId: 1 });
    const done = await runJob(w, job.id);

    expect(done).toMatchObject({ status: 'succeeded', error: null });
    expect(w.core.monitor.latestFor(siteId)).toMatchObject({ up: true });
  });

  it("leaves a failed job's own error as the reason, not a timeout", async () => {
    const w = await makeWorld();
    const siteId = await slowSite(w);
    w.docker.failOn.set('restartContainer', 'restart refused');

    const job = w.worker.enqueue('site.restart', { siteId }, { id: siteId, slug: 'slow', serverId: 1 });
    const done = await runJob(w, job.id);

    expect(done).toMatchObject({ status: 'failed', error: 'restart refused' });
    expect(w.core.monitor.latestFor(siteId)).toMatchObject({ up: true });
  });
});
