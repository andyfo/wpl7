import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { securityAdminAddresses, securityBlocks } from '../../src/db/schema.js';
import { parseCidr } from '../../shared/cidr.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';

const HOUR = 3600_000;
const ATTACKER = '198.18.9.9';

function blockAuto(w: TestWorld, address = ATTACKER, now = Date.now()) {
  return w.core.blocklist.block({ address, source: 'detector', rule: 'login', reason: 'test' }, now);
}

describe('blocking an address', () => {
  it('blocks for an hour, then four times as long per repeat, never beyond 30 days', async () => {
    const w = await makeWorld();
    const t0 = Date.now();
    const first = blockAuto(w, ATTACKER, t0);
    expect(first.expiresAt! - t0).toBe(HOUR);
    expect(first.strike).toBe(1);
    w.core.blocklist.expire(t0 + HOUR + 1);

    const second = blockAuto(w, ATTACKER, t0 + 2 * HOUR);
    expect(second.strike).toBe(2);
    expect(second.expiresAt! - (t0 + 2 * HOUR)).toBe(4 * HOUR);

    expect(w.core.blocklist.durationFor(3)).toBe(16 * HOUR);
    expect(w.core.blocklist.durationFor(10)).toBe(30 * 24 * HOUR);
  });

  it('does not count a block lifted by hand as a repeat', async () => {
    const w = await makeWorld();
    const first = blockAuto(w);
    w.core.blocklist.lift(first.id, 'alice');
    expect(blockAuto(w).strike).toBe(1);
  });

  it('keeps one block in force per address, and says what covers it', async () => {
    const w = await makeWorld();
    blockAuto(w);
    expect(() => blockAuto(w)).toThrow(/already blocked/);
    w.core.blocklist.block({ address: '2001:db8:1:2::/64', source: 'manual', reason: 'by hand', durationMs: null });
    expect(() => blockAuto(w, '2001:db8:1:2::77')).toThrow(/already covered by the block of 2001:db8:1:2::\/64/);
    // The database agrees: a second open row for one address is refused outright.
    expect(() =>
      w.db
        .insert(securityBlocks)
        .values({ address: ATTACKER, family: 4, source: 'manual', reason: 'x', createdAt: Date.now() })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('takes the slot back from a block whose time is up but was not swept yet', async () => {
    const w = await makeWorld();
    const t0 = Date.now();
    blockAuto(w, ATTACKER, t0);
    const again = blockAuto(w, ATTACKER, t0 + 2 * HOUR);
    expect(again.strike).toBe(2);
    const rows = w.db.select().from(securityBlocks).where(eq(securityBlocks.address, ATTACKER)).all();
    expect(rows.map((r) => r.endReason)).toEqual(['expired', null]);
  });

  it('records what observe mode would have done without taking the slot', async () => {
    const w = await makeWorld();
    const observed = w.core.blocklist.block({ address: ATTACKER, source: 'detector', rule: 'login', reason: 'x', observe: true });
    expect(observed.endReason).toBe('observed');
    expect(w.core.blocklist.activeCount()).toBe(0);
    expect(blockAuto(w).strike).toBe(1);
  });

  it('stops the detector at the most the list holds, and not a person', async () => {
    const w = await makeWorld();
    w.core.settings.set('securityMaxActiveBlocks', 1);
    blockAuto(w, '198.18.0.1');
    expect(() => blockAuto(w, '198.18.0.2')).toThrow(/most the list holds/);
    expect(w.core.blocklist.block({ address: '198.18.0.3', source: 'manual', reason: 'x', durationMs: HOUR }).id).toBeGreaterThan(0);
  });

  it('tells the firewall when the list in force changes', async () => {
    const w = await makeWorld();
    let changes = 0;
    w.core.blocklist.onChange = () => changes++;
    const t0 = Date.now();
    const row = blockAuto(w, ATTACKER, t0);
    w.core.blocklist.lift(row.id, null, t0 + 1);
    blockAuto(w, '198.18.0.5', t0 + 2);
    expect(w.core.blocklist.expire(t0 + 2 * HOUR)).toBe(1);
    expect(changes).toBe(4);
  });
});

describe('who is never blocked', () => {
  it('refuses, with the reason, every address the fleet depends on', async () => {
    const w = await makeWorld();
    w.addSshServer('berlin', { publicIp: '203.0.113.9' });
    w.core.blocklist.addNeverBlock('192.0.2.0/24', 'agency office', 'alice');
    w.core.blocklist.recordAdmin('198.51.100.77', 'alice');
    w.core.blocklist.setPanelAddress(2, '198.51.100.200');
    const why = (address: string) => w.core.blocklist.protection(parseCidr(address)!);
    expect(why('10.0.0.8')).toMatch(/private/);
    expect(why('203.0.113.9')).toMatch(/server "berlin"/);
    expect(why('198.51.100.200')).toMatch(/panel's own address/);
    expect(why('173.245.48.1')).toMatch(/Cloudflare, a trusted proxy/);
    expect(why('192.0.80.1')).toMatch(/Jetpack/);
    // The AI companies' published addresses, from the copies this version ships with.
    expect(why('9.129.1.1')).toMatch(/OpenAI's bots \(ChatGPT, GPTBot\), and AI assistants are never blocked/);
    expect(why('216.73.216.9')).toMatch(/Anthropic's bots \(Claude\)/);
    expect(why('136.122.40.1')).toMatch(/Google's fetchers and agents \(Gemini\)/);
    expect(why('192.0.2.7')).toMatch(/never-block list \(agency office\)/);
    expect(why('198.51.100.77')).toMatch(/alice used the panel from it/);
    // A range that would take a protected address with it is refused as well.
    expect(why('203.0.113.0/24')).toMatch(/server "berlin"/);
    expect(why(ATTACKER)).toBeNull();
    expect(() => w.core.blocklist.block({ address: '192.0.2.7', source: 'manual', reason: 'x', durationMs: null })).toThrow(/never blocked: it is on the never-block list/);
  });

  it('forgets an administrator address after 30 days', async () => {
    const w = await makeWorld();
    const t0 = Date.now();
    w.core.blocklist.recordAdmin('198.51.100.77', 'alice', t0 - 31 * 24 * HOUR);
    expect(w.core.blocklist.protection(parseCidr('198.51.100.77')!, t0)).toBeNull();
    expect(w.core.blocklist.prune(t0)).toBe(1);
  });

  it('lifts the blocks a new never-block entry overlaps', async () => {
    const w = await makeWorld();
    const row = blockAuto(w);
    w.core.blocklist.addNeverBlock('198.18.9.0/24', null, 'alice');
    expect(w.core.blocklist.byId(row.id)).toMatchObject({ endReason: 'lifted', endedBy: 'alice' });
    expect(() => w.core.blocklist.addNeverBlock('198.18.9.0/24', null, 'alice')).toThrow(/already/);
    expect(() => w.core.blocklist.addNeverBlock('10.0.0.0/4', null, 'alice')).toThrow(/too wide/);
  });

  it('writes down where the panel is used from, behind Cloudflare too', async () => {
    const world = await makeWorld();
    const { app } = await makeApp(world);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct-horse-battery' },
      remoteAddress: '198.51.100.33',
    });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: `${c.name}=${c.value}` }, remoteAddress: '198.51.100.33' });
    await app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: { cookie: `${c.name}=${c.value}`, 'cf-connecting-ip': '203.0.113.50' },
      remoteAddress: '173.245.48.9',
    });
    // Not signed in: nobody to protect.
    await app.inject({ method: 'GET', url: '/api/sites', remoteAddress: '198.18.1.1' });
    const rows = world.db.select().from(securityAdminAddresses).all();
    expect(rows.map((r) => [r.address, r.username]).sort()).toEqual([
      ['198.51.100.33', 'admin'],
      ['203.0.113.50', 'admin'],
    ]);
  });
});

describe('the list', () => {
  it('pages the blocks in force and the history apart, and finds by address or reason', async () => {
    const w = await makeWorld();
    const t0 = Date.now();
    const a = blockAuto(w, '198.18.0.1', t0);
    blockAuto(w, '198.18.0.2', t0);
    w.core.blocklist.lift(a.id, 'alice', t0 + 1);
    const active = w.core.blocklist.list({ state: 'active', limit: 10, offset: 0 }, t0 + 2);
    expect(active.items.map((i) => i.address)).toEqual(['198.18.0.2']);
    expect(active).toMatchObject({ total: 1, activeCount: 1, maxActive: 10_000 });
    const history = w.core.blocklist.list({ state: 'history', limit: 10, offset: 0 }, t0 + 2);
    expect(history.items).toMatchObject([{ address: '198.18.0.1', endReason: 'lifted', endedBy: 'alice', active: false }]);
    expect(w.core.blocklist.list({ state: 'active', q: '0.2', limit: 10, offset: 0 }, t0 + 2).total).toBe(1);
    expect(w.core.blocklist.list({ state: 'active', q: 'nothing', limit: 10, offset: 0 }, t0 + 2).total).toBe(0);
  });
});
