/**
 * A container app: the bakery's order service, its own image from a registry, with a host of its
 * own, three paths on the bakery's WordPress domain (the payment provider's webhook over plain
 * http too), a database, a secret in its environment, a mount with its signing key, five deploys of
 * which one failed, and a log.
 */
import { appDeploys, appEnv, appMounts, appRoutes, appSettings, siteStats, sites } from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, MINUTE, ago } from './clock.js';
import { devHostname, rng, seedOf } from './data.js';

export const DEMO_APP = 'orders-api';
const REFERENCE = 'ghcr.io/northwind-example/orders-api:stable';
const MB = 1024 * 1024;

/** A digest that reads like one, the same on every run. */
const digest = (n: number) => `sha256:${(seedOf(`orders-api-image-${n}`) >>> 0).toString(16).padStart(8, '0').repeat(8)}`;

/** The deploys, oldest first: the create, two new images, a broken one and the fix. */
const DEPLOYS = [
  { at: ago(38 * DAY), n: 1, origin: 'create', actor: 'admin', result: 'ok', took: 41_000, gap: null },
  { at: ago(21 * DAY + 4 * HOUR), n: 2, origin: 'hook', actor: 'hook', result: 'ok', took: 18_400, gap: 4_200 },
  { at: ago(9 * DAY + 2 * HOUR), n: 3, origin: 'auto', actor: null, result: 'ok', took: 16_900, gap: 3_800 },
  { at: ago(2 * DAY + 5 * HOUR), n: 4, origin: 'hook', actor: 'hook', result: 'failed', took: 64_300, gap: null },
  { at: ago(2 * DAY + 3 * HOUR), n: 5, origin: 'user', actor: 'priya', result: 'ok', took: 17_600, gap: 3_500 },
] as const;

const FAILED_TAIL = [
  'orders-api 2.14.0 starting',
  'connecting to mariadb:3306/wp_orders_api',
  'Error: migration 0042_add_pickup_slots failed: Unknown column \'slot_id\' in \'field list\'',
  '    at Migrator.run (/app/dist/db/migrate.js:88:13)',
  'exiting with code 1',
].join('\n');

export function seedApps(world: TestWorld): void {
  const created = ago(38 * DAY);
  const dev = devHostname(DEMO_APP);
  const site = world.db
    .insert(sites)
    .values({
      slug: DEMO_APP,
      serverId: 1,
      title: 'Northwind Orders',
      domains: JSON.stringify(['orders.northwindbakery.example', dev]),
      devHostname: dev,
      isLive: 1,
      keepDevAlias: 1,
      phpVersion: '',
      app: 'container',
      webRoot: '',
      status: 'running',
      dbName: 'wp_orders_api',
      dbUser: 'wp_orders_api',
      dbPassword: 'demo-database-password',
      containerName: `wp-${DEMO_APP}`,
      mailPassword: 'demo-relay-password',
      diskBytes: 214 * MB,
      createdAt: created,
      updatedAt: created,
    })
    .returning()
    .get();
  world.db
    .insert(appSettings)
    .values({
      siteId: site.id,
      source: 'registry',
      reference: REFERENCE,
      registryUser: 'northwind-ci',
      registryToken: 'demo-registry-token',
      digest: digest(5),
      imageId: 'sha256:orders5',
      port: 8080,
      stopGraceSec: 30,
      imageUid: 10001,
      imageGid: 10001,
      dropAllCaps: 1,
      readOnlyRoot: 1,
      dataPaths: JSON.stringify([{ path: '/var/lib/orders', dir: 'var-lib-orders', fromImage: true }]),
      healthPath: '/healthz',
      deployCheckPath: '/readyz',
      healthTimeoutSec: 60,
      updateMode: 'auto',
      checkMinutes: 15,
      checkedAt: ago(6 * MINUTE),
      deployTokenHash: 'demo-hash-only',
      deployTokenSetAt: ago(37 * DAY),
      createdAt: created,
      updatedAt: ago(2 * DAY),
    })
    .run();
  const env = [
    { name: 'DATABASE_URL', value: 'mysql://{{db.user}}:{{db.password}}@{{db.host}}:{{db.port}}/{{db.name}}', secret: 0 },
    { name: 'PUBLIC_URL', value: 'https://{{site.domain}}', secret: 0 },
    { name: 'SMTP_URL', value: 'smtp://{{mail.user}}:{{mail.password}}@{{mail.host}}:{{mail.port}}', secret: 0 },
    { name: 'PAYMENTS_WEBHOOK_SECRET', value: 'demo-webhook-secret', secret: 1 },
    { name: 'LOG_LEVEL', value: 'info', secret: 0 },
  ];
  env.forEach((v, position) => world.db.insert(appEnv).values({ siteId: site.id, position, ...v }).run());
  const routes = [
    { host: 'orders.northwindbakery.example', match: 'none', path: '', scheme: 'https' },
    { host: dev, match: 'none', path: '', scheme: 'https' },
    { host: 'northwindbakery.example', match: 'prefix', path: '/api/orders', scheme: 'https' },
    { host: 'northwindbakery.example', match: 'exact', path: '/webhooks/payments', scheme: 'both' },
    { host: 'northwindbakery.example', match: 'prefix', path: '/pickup', scheme: 'https' },
  ] as const;
  routes.forEach((r, position) =>
    world.db
      .insert(appRoutes)
      .values({ siteId: site.id, position, ...r, enabled: 1, createdAt: created, updatedAt: created })
      .run(),
  );
  world.db
    .insert(appMounts)
    .values({ siteId: site.id, name: 'signing', containerPath: '/run/secrets/orders', writable: 0, inBackups: 0, filledAt: ago(37 * DAY) })
    .run();
  for (const d of DEPLOYS) {
    world.db
      .insert(appDeploys)
      .values({
        siteId: site.id,
        reference: REFERENCE,
        digest: digest(d.n),
        imageId: `sha256:orders${d.n}`,
        startedAt: d.at,
        tookMs: d.took,
        result: d.result,
        origin: d.origin,
        actor: d.actor,
        gapMs: d.gap,
        ...(d.result === 'failed'
          ? { error: '/healthz did not answer 2xx within 60 s (30 tries; last: no answer: bad address \'wp-orders-api:8080\').', logTail: FAILED_TAIL }
          : {}),
      })
      .run();
  }

  // Its container, its image, and the registry that names it.
  world.docker.containers.set(`wp-${DEMO_APP}`, 'running');
  world.docker.labelsByContainer.set(`wp-${DEMO_APP}`, { 'traefik.enable': 'false', 'wpl7.managed': 'true', 'wpl7.site': DEMO_APP, 'wpl7.role': 'app' });
  world.docker.imageByContainer.set(`wp-${DEMO_APP}`, 'sha256:orders5');
  world.docker.publish(REFERENCE, digest(5), { imageId: 'sha256:orders5' });
  world.docker.logs.set(`wp-${DEMO_APP}`, logLines());

  // A day of its uptime and resources, as the sites have.
  const next = rng(seedOf('site:orders-api'));
  const rows: (typeof siteStats.$inferInsert)[] = [];
  for (let i = DAY / (5 * MINUTE); i >= 0; i--) {
    const ts = ago(i * 5 * MINUTE);
    rows.push({ siteId: site.id, ts, up: 1, httpMs: Math.round(8 + next() * 9) });
    rows.push({ siteId: site.id, ts: ts + 1000, cpuPct: +(1.2 + next() * 3).toFixed(1), memBytes: Math.round((96 + next() * 12) * MB) });
  }
  world.db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 500) tx.insert(siteStats).values(rows.slice(i, i + 500)).run();
  });
  const latest = (world.core.monitor as unknown as { latest: Map<number, object> }).latest;
  latest.set(site.id, { slug: DEMO_APP, serverId: 1, up: true, httpStatus: 200, httpMs: 11, lastCheckedAt: ago(40_000), cpuPct: 2.1, memBytes: 101 * MB, diskBytes: 214 * MB });
}

/** The last few minutes of what it prints, with Docker's timestamps. */
function logLines(): string {
  const next = rng(seedOf('orders-api-log'));
  const lines: string[] = [];
  const paths = ['GET /api/orders/today 200', 'POST /api/orders 201', 'GET /pickup/slots 200', 'GET /healthz 200', 'POST /webhooks/payments 200'];
  for (let i = 40; i >= 0; i--) {
    const ts = new Date(ago(i * 9_000 + Math.round(next() * 4_000))).toISOString().replace('Z', '123456Z');
    lines.push(`${ts} ${paths[Math.floor(next() * paths.length)]} ${Math.round(4 + next() * 30)}ms`);
  }
  return `${lines.join('\n')}\n`;
}
