import { describe, expect, it } from 'vitest';
import { serverStats } from '../../src/db/schema.js';
import { makeApp, makeWorld } from '../helpers.js';

const stats = { load1: 0.25, load5: 0.2, load15: 0.1, memTotal: 8192, memUsed: 2048, diskTotal: 10000, diskUsed: 5000 };

describe('server resource history', () => {
  it('returns ordered, bounded samples scoped to the server and requested time window', async () => {
    const world = await makeWorld();
    const other = world.addSshServer('other');
    const now = Date.now();
    world.db
      .insert(serverStats)
      .values([
        { ...stats, serverId: 1, ts: now - 7200_000 },
        { ...stats, serverId: other.id, ts: now - 1000, load1: 99 },
        { ...stats, serverId: 1, ts: now + 7200_000 },
        ...Array.from({ length: 1000 }, (_, i) => ({ ...stats, serverId: 1, ts: now - 3500_000 + i * 3500 })),
        // Duplicate collection timestamps must not bypass the point cap.
        { ...stats, serverId: 1, ts: now - 3500, load1: 0.5 },
      ])
      .run();
    const result = world.core.monitor.serverHistory(1, 1);
    expect(result.samples.length).toBeGreaterThan(200);
    expect(result.samples.length).toBeLessThanOrEqual(240);
    expect(result.samples.every((s) => s.ts >= result.since && s.ts <= result.until && s.load1 < 1)).toBe(true);
    expect(result.samples.map((s) => s.ts)).toEqual(result.samples.map((s) => s.ts).sort((a, b) => a - b));
    expect(result.samples.at(-1)).toMatchObject({ ...stats, load1: 0.5 });
    expect(world.core.monitor.serverHistory(other.id, 1).samples).toHaveLength(1);
  });

  it('requires authentication, validates inputs and exposes the configured sampling interval', async () => {
    const world = await makeWorld();
    const { app } = await makeApp(world);
    try {
      expect((await app.inject('/api/monitor/servers/1/history')).statusCode).toBe(401);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'correct-horse-battery' },
      });
      const c = login.cookies.find((cookie) => cookie.name === 'panel.sid')!;
      const headers = { cookie: `${c.name}=${c.value}` };
      world.core.settings.update({ monitorStatsIntervalSec: 30 });
      const response = await app.inject({ url: '/api/monitor/servers/1/history?hours=6', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ samples: [], sampleIntervalMs: 30_000 });
      expect(response.json().until - response.json().since).toBe(6 * 3600_000);
      for (const url of [
        '/api/monitor/servers/1/history?hours=0',
        '/api/monitor/servers/1/history?hours=169',
        '/api/monitor/servers/nope/history',
      ]) {
        expect((await app.inject({ url, headers })).statusCode).toBe(400);
      }
      expect((await app.inject({ url: '/api/monitor/servers/999/history', headers })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
