import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { sites } from '../../src/db/schema.js';
import { makeWorld, type TestWorld } from '../helpers.js';

let edge: http.Server | null = null;

afterEach(() => {
  edge?.close();
  edge = null;
});

/** The real probeUrlFor goes through Traefik on :80, which no test can bind. */
async function edgeAnswering(w: TestWorld, status: number): Promise<void> {
  edge = http.createServer((_req, res) => res.writeHead(status).end(''));
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
