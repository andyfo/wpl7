/**
 * Three servers: fra1 runs the panel and sites, nyc1 and sin1 are workers the panel drives over
 * SSH. A week of load, memory and disk samples each, and the latest sample the charts and the
 * fleet tiles read.
 */
import { eq } from 'drizzle-orm';
import { serverStats, servers } from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, MINUTE, ago } from './clock.js';
import { DEV_DOMAIN, SERVERS, rng, seedOf } from './data.js';
import { MAIL_HOSTNAMES } from './dnsRecords.js';
import { demoExec } from './world.js';

const GB = 1024 ** 3;

export function seedServers(world: TestWorld): void {
  const [fra1, nyc1, sin1] = SERVERS as [(typeof SERVERS)[0], (typeof SERVERS)[0], (typeof SERVERS)[0]];
  world.db
    .update(servers)
    .set({ name: fra1.name, publicIp: fra1.ip, devDomain: DEV_DOMAIN, status: 'ok', lastSeenAt: ago(MINUTE), createdAt: ago(320 * DAY), updatedAt: ago(2 * DAY) })
    .where(eq(servers.id, 1))
    .run();
  world.docker.relayHostnames = { live: MAIL_HOSTNAMES.fra1!, fallback: `mail.${DEV_DOMAIN}` };

  for (const [server, ageDays] of [
    [nyc1, 190],
    [sin1, 101],
  ] as const) {
    const ports = world.addSshServer(server.name, { publicIp: server.ip, devDomain: DEV_DOMAIN });
    if (ports.id !== server.id) throw new Error(`expected ${server.name} to be server ${server.id}, got ${ports.id}`);
    world.remote(server.id).exec = demoExec(server);
    ports.docker.relayHostnames = { live: MAIL_HOSTNAMES[server.name]!, fallback: `mail.${DEV_DOMAIN}` };
    world.db
      .update(servers)
      .set({ sshHost: server.ip, sshUser: 'wpl7-panel', status: 'ok', lastSeenAt: ago(MINUTE), createdAt: ago(ageDays * DAY), updatedAt: ago(3 * DAY) })
      .where(eq(servers.id, server.id))
      .run();
  }

  // A week of samples every 10 minutes: a daily rhythm, a little noise, disk creeping up.
  const latest = (world.core.monitor as unknown as { latestServers: Map<number, object> }).latestServers;
  const rows: (typeof serverStats.$inferInsert)[] = [];
  for (const server of SERVERS) {
    const next = rng(seedOf(`stats:${server.name}`));
    const busy = { fra1: 1.4, nyc1: 0.9, sin1: 1.1 }[server.name] ?? 1;
    const memBase = { fra1: 0.58, nyc1: 0.46, sin1: 0.71 }[server.name] ?? 0.5;
    const diskBase = { fra1: 0.31, nyc1: 0.24, sin1: 0.52 }[server.name] ?? 0.3;
    const memTotal = server.memGb * GB;
    const diskTotal = server.diskGb * GB;
    // Every 10 minutes for the week, every minute (as the panel samples) for the last day.
    const times: number[] = [];
    for (let t = ago(7 * DAY); t < ago(DAY); t += 10 * MINUTE) times.push(t);
    for (let t = ago(DAY); t <= ago(0); t += MINUTE) times.push(t);
    const steps = times.length - 1;
    for (let i = steps; i >= 0; i--) {
      const ts = times[steps - i]!;
      const hour = new Date(ts).getUTCHours();
      const daily = 0.55 + 0.45 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
      const load1 = +(busy * daily + next() * 0.35).toFixed(2);
      const sample = {
        serverId: server.id,
        ts,
        load1,
        load5: +(load1 * 0.92).toFixed(2),
        load15: +(load1 * 0.85).toFixed(2),
        memTotal,
        memUsed: Math.round(memTotal * (memBase + 0.06 * daily + next() * 0.02)),
        diskTotal,
        diskUsed: Math.round(diskTotal * (diskBase + 0.01 * ((steps - i) / steps))),
      };
      rows.push(sample);
      if (i === 0) {
        const { serverId: _id, ts: _ts, ...stats } = sample;
        latest.set(server.id, stats);
      }
    }
  }
  world.db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 500) tx.insert(serverStats).values(rows.slice(i, i + 500)).run();
  });
}
