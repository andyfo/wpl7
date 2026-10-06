/**
 * The people and the programs: the owner and two admins (one with two-factor authentication),
 * two API keys and what they did, MCP switched on with two connected apps (Claude and Cursor)
 * and their recent calls, and the settings a well-used install has filled in.
 */
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { apiEvents, apiKeys, oauthClients, oauthGrants, users } from '../../src/db/schema.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, MINUTE, ago } from './clock.js';
import { ADMIN_EMAIL, ADMIN_USER, PANEL_DOMAIN, PEOPLE, rng, seedOf } from './data.js';

/** Never a password anyone can sign in with: the demo signs in as the owner only. */
const NO_PASSWORD = '$argon2id$v=19$m=65536,t=3,p=4$ZGVtbw$ZGVtby1hY2NvdW50LW5vdC1hLXBhc3N3b3Jk';

export function seedAccounts(world: TestWorld): void {
  const db = world.db;
  const owner = db.select().from(users).where(eq(users.username, ADMIN_USER)).get()!;
  db.update(users).set({ email: ADMIN_EMAIL, createdAt: ago(320 * DAY), lastLoginAt: ago(3 * HOUR) }).where(eq(users.id, owner.id)).run();
  for (const person of PEOPLE.filter((p) => !p.owner)) {
    db.insert(users)
      .values({
        username: person.username,
        passwordHash: NO_PASSWORD,
        isOwner: 0,
        email: person.email,
        totp: person.twoFactor
          ? JSON.stringify({ secret: 'DEMOSECRETNOTREAL', confirmedAt: ago(120 * DAY), lastStep: 0, recoveryCodes: Array.from({ length: 8 }, (_, i) => sha256Hex(`demo-recovery-${i}`)) })
          : null,
        createdAt: ago((person.username === 'sam' ? 200 : 75) * DAY),
        updatedAt: ago(20 * DAY),
        lastLoginAt: ago(person.username === 'sam' ? 22 * HOUR : 9 * MINUTE),
      })
      .run();
  }

  // The panel's own SSH key, as the Add server dialog shows it: the shape of one, not a real key.
  fs.writeFileSync(
    world.config.paths.sshPubKey,
    `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGRlbW8ta2V5LW5vdC1yZWFsLXdwbDctcGFuZWwtZGVtbw wpl7-panel@${PANEL_DOMAIN}\n`,
  );

  // Two API keys and what they did over the last day.
  const deploy = db
    .insert(apiKeys)
    .values({ name: 'Deploy script', tokenHash: sha256Hex('wpl7_demo-deploy-script'), prefix: 'wpl7_Qm3dT8x', access: 'manage', createdAt: ago(48 * DAY), lastUsedAt: ago(5 * HOUR) })
    .returning()
    .get();
  const monitor = db
    .insert(apiKeys)
    .values({ name: 'Uptime monitor', tokenHash: sha256Hex('wpl7_demo-uptime-monitor'), prefix: 'wpl7_Vk72pLa', access: 'read', createdAt: ago(130 * DAY), lastUsedAt: ago(3 * MINUTE) })
    .returning()
    .get();
  const next = rng(seedOf('api-events'));
  const events: (typeof apiEvents.$inferInsert)[] = [];
  for (let t = ago(DAY); t < ago(2 * MINUTE); t += 10 * MINUTE) {
    events.push({ ts: t + Math.round(next() * 20_000), keyId: monitor.id, keyName: monitor.name, keyPrefix: monitor.prefix, method: 'GET', path: '/api/monitor/overview', route: '/api/monitor/overview', status: 200, durationMs: 8 + Math.round(next() * 14), ip: '198.51.100.9', userAgent: 'uptime-checker/2.4' });
  }
  events.push({ ts: ago(5 * HOUR), keyId: deploy.id, keyName: deploy.name, keyPrefix: deploy.prefix, method: 'POST', path: '/api/sites/ridge-outfitters/wp/cli', route: '/api/sites/:slug/wp/cli', status: 202, durationMs: 41, ip: '203.0.113.50', userAgent: 'curl/8.17.0' });
  events.push({ ts: ago(5 * HOUR + 2 * MINUTE), keyId: deploy.id, keyName: deploy.name, keyPrefix: deploy.prefix, method: 'GET', path: '/api/sites/ridge-outfitters', route: '/api/sites/:slug', status: 200, durationMs: 23, ip: '203.0.113.50', userAgent: 'curl/8.17.0' });
  events.push({ ts: ago(4 * HOUR + 47 * MINUTE), keyId: monitor.id, keyName: monitor.name, keyPrefix: monitor.prefix, method: 'POST', path: '/api/sites/ridge-outfitters/backups', route: '/api/sites/:slug/backups', status: 403, errorCode: 'forbidden', durationMs: 6, ip: '198.51.100.9', userAgent: 'uptime-checker/2.4' });
  events.push({ ts: ago(31 * HOUR), keyId: null, keyName: '', keyPrefix: 'wpl7_ZZr0x1Q', method: 'GET', path: '/api/sites', route: '/api/sites', status: 401, errorCode: 'unauthorized', durationMs: 4, ip: '192.0.2.77', userAgent: 'python-requests/2.33' });

  // MCP: on, and two apps connected by signing in.
  world.core.settings.set('mcpEnabled', true);
  db.insert(oauthClients).values({ clientId: 'demo-client-claude', name: 'Claude', redirectUris: JSON.stringify(['https://claude.ai/api/mcp/auth_callback']), createdAt: ago(21 * DAY), lastUsedAt: ago(2 * HOUR) }).run();
  db.insert(oauthClients).values({ clientId: 'demo-client-cursor', name: 'Cursor', redirectUris: JSON.stringify(['cursor://anysphere.cursor-mcp/oauth/callback']), createdAt: ago(9 * DAY), lastUsedAt: ago(26 * HOUR) }).run();
  const sam = db.select().from(users).where(eq(users.username, 'sam')).get()!;
  const resource = `https://${PANEL_DOMAIN}/mcp`;
  const claude = db.insert(oauthGrants).values({ clientId: 'demo-client-claude', userId: owner.id, access: 'manage', resource, redirectUri: 'https://claude.ai/api/mcp/auth_callback', createdAt: ago(21 * DAY), lastUsedAt: ago(2 * HOUR) }).returning().get();
  const cursor = db.insert(oauthGrants).values({ clientId: 'demo-client-cursor', userId: sam.id, access: 'read', resource, redirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback', createdAt: ago(9 * DAY), lastUsedAt: ago(26 * HOUR) }).returning().get();
  // A call over a connection is recorded under the app's name (plugins/apiActivity.ts callerOf).
  const appName = new Map([[claude.id, 'Claude'], [cursor.id, 'Cursor']]);
  const mcp = (ts: number, connectionId: number, tool: string, method: string, path: string, route: string, status: number, extra: Partial<typeof apiEvents.$inferInsert> = {}) =>
    events.push({ ts, keyId: null, keyName: appName.get(connectionId) ?? '', keyPrefix: '', method, path, route, status, durationMs: 12 + Math.round(next() * 60), ip: '192.0.2.120', userAgent: 'mcp', via: 'mcp', connectionId, tool, ...extra });
  mcp(ago(2 * HOUR + 15 * MINUTE), claude.id, 'wpl7_api_get', 'GET', '/api/sites', '/api/sites', 200);
  mcp(ago(2 * HOUR + 14 * MINUTE + 30_000), claude.id, 'wpl7_api_get', 'GET', '/api/sites/harbor-yoga', '/api/sites/:slug', 200);
  mcp(ago(2 * HOUR + 14 * MINUTE), claude.id, 'wpl7_api_change', 'POST', '/api/sites/harbor-yoga/restart', '/api/sites/:slug/restart', 202);
  mcp(ago(2 * HOUR + 13 * MINUTE), claude.id, 'wpl7_wait_for_job', 'GET', '/api/jobs/30', '/api/jobs/:id', 200);
  mcp(ago(26 * HOUR), cursor.id, 'wpl7_api_get', 'GET', '/api/wp/inventory', '/api/wp/inventory', 200);
  mcp(ago(26 * HOUR - 40_000), cursor.id, 'wpl7_api_change', 'POST', '/api/sites/blue-fern/wp/plugins/update', '/api/sites/:slug/wp/plugins/update', 403, { errorCode: 'forbidden' });
  events.sort((a, b) => a.ts - b.ts);
  db.transaction((tx) => {
    for (let i = 0; i < events.length; i += 300) tx.insert(apiEvents).values(events.slice(i, i + 300)).run();
  });

  // Settings a well-used install has filled in.
  const s = world.core.settings;
  s.set('alertEmail', ADMIN_EMAIL);
  s.set('defaultAdminEmail', ADMIN_EMAIL);
}
