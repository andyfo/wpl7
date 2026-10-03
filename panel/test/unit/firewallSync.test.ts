import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostPortFor } from '../../src/servers/hostPort.js';
import { FirewallSyncService } from '../../src/services/firewallSync.js';
import { makeWorld, type TestWorld } from '../helpers.js';

const HOUR = 3600_000;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const blockedFile = (root: string) => path.join(root, 'traefik', 'dynamic', 'wpl7-blocked.yml');

function block(w: TestWorld, address: string, durationMs: number | null = HOUR) {
  return w.core.blocklist.block({ address, source: 'manual', reason: 'test', durationMs });
}

async function settle(w: TestWorld): Promise<void> {
  await w.core.firewall.idle();
}

describe('blocked addresses on a server', () => {
  it('loads the list into the network layer, and refuses visitors behind Cloudflare in Traefik', async () => {
    const w = await makeWorld();
    block(w, '198.18.9.9');
    block(w, '2001:db8:1:2::/64', null);
    await settle(w);
    const host = w.firewallHost(1);
    expect(host.applied).toHaveLength(1);
    expect(host.applied[0]).toMatch(/198\.18\.9\.9 timeout \d+s/);
    expect(host.applied[0]).toContain('2001:db8:1:2::/64');
    expect(w.core.firewall.status(1)).toMatchObject({ state: 'ok', networkEntries: 2, httpProxied: 2, httpDirect: 0 });
    const http = fs.readFileSync(blockedFile(w.config.srvRoot), 'utf8');
    expect(http).toContain('wpl7blk_p0');
    expect(http).not.toContain('wpl7blk_direct');
  });

  it('loads again only when the list changed, the table went missing, or the server rebooted', async () => {
    const w = await makeWorld();
    block(w, '198.18.9.9');
    await settle(w);
    const host = w.firewallHost(1);
    expect(host.applied).toHaveLength(1);

    await w.core.firewall.syncServer(1);
    expect(host.applied).toHaveLength(1);

    host.reboot();
    await w.core.firewall.syncServer(1);
    expect(host.applied).toHaveLength(2);

    host.table = false;
    await w.core.firewall.syncServer(1);
    expect(host.applied).toHaveLength(3);

    block(w, '198.18.9.10');
    await settle(w);
    expect(host.applied).toHaveLength(4);
  });

  it('loads a burst of blocks once', async () => {
    const w = await makeWorld();
    for (let i = 1; i <= 5; i++) block(w, `198.18.9.${i}`);
    await settle(w);
    expect(w.firewallHost(1).applied).toHaveLength(1);
    expect(w.firewallHost(1).applied[0]!.match(/198\.18\.9\.\d/g)).toHaveLength(5);
  });

  it('refuses direct visitors in Traefik where the helper is not installed yet', async () => {
    const w = await makeWorld();
    w.firewallHost(1).installed = false;
    block(w, '198.18.9.9');
    await settle(w);
    expect(w.core.firewall.status(1)).toMatchObject({ state: 'not-installed', httpDirect: 1 });
    expect(fs.readFileSync(blockedFile(w.config.srvRoot), 'utf8')).toContain('wpl7blk_direct');
  });

  it('refuses direct visitors in Traefik on a host without the helper, run there directly', async () => {
    const w = await makeWorld();
    block(w, '198.18.9.9');
    await settle(w);
    // The runner of a panel outside any container, asked for a command this machine lacks.
    const local = hostPortFor(1, { servers: w.servers, hostShell: null, inContainer: () => false });
    const missing = { run: (cmd: string, args: string[], opts?: { timeoutMs?: number }) => local.run(`${cmd}-not-installed`, args, opts) };
    const sync = new FirewallSyncService(w.config, w.servers, w.core.settings, w.core.blocklist, w.core.proxyRanges, () => missing, quiet, { debounceMs: 0 });
    await sync.syncServer(1);
    expect(sync.status(1)).toMatchObject({ state: 'not-installed', httpDirect: 1 });
    expect(fs.readFileSync(blockedFile(w.config.srvRoot), 'utf8')).toContain('wpl7blk_direct');
  });

  it('still refuses in Traefik when the helper gives no answer at all', async () => {
    const w = await makeWorld();
    w.firewallHost(1).failRun = 'wpl7-firewall timed out after 30000ms';
    block(w, '198.18.9.9');
    await settle(w);
    expect(w.core.firewall.status(1)).toMatchObject({ state: 'http-only', httpDirect: 1, message: expect.stringContaining('timed out') });
    expect(fs.readFileSync(blockedFile(w.config.srvRoot), 'utf8')).toContain('wpl7blk_direct');
  });

  it('falls back to Traefik alone when the network layer refuses the list', async () => {
    const w = await makeWorld();
    w.firewallHost(1).failApply = 'nft -c: Error: Could not process rule';
    block(w, '198.18.9.9');
    await settle(w);
    expect(w.core.firewall.status(1)).toMatchObject({ state: 'http-only', httpDirect: 1, message: expect.stringContaining('Could not process rule') });
  });

  it('respects a server switched off by hand', async () => {
    const w = await makeWorld();
    w.firewallHost(1).off = true;
    block(w, '198.18.9.9');
    await settle(w);
    expect(w.firewallHost(1).applied).toHaveLength(0);
    expect(w.core.firewall.status(1)).toMatchObject({ state: 'off', httpDirect: 1 });
  });

  it('empties every server when enforcement is switched off, and keeps the list', async () => {
    const w = await makeWorld();
    block(w, '198.18.9.9');
    await settle(w);
    w.core.settings.set('securityEnforcement', false);
    await w.core.firewall.kickAll();
    const host = w.firewallHost(1);
    expect(host.applied.at(-1)).not.toContain('198.18.9.9');
    expect(fs.existsSync(blockedFile(w.config.srvRoot))).toBe(false);
    expect(w.core.blocklist.activeCount()).toBe(1);
  });

  it('takes a block off when it ends, and keeps the protected ranges allowed', async () => {
    const w = await makeWorld();
    const t0 = Date.now();
    w.core.blocklist.block({ address: '198.18.9.9', source: 'manual', reason: 'x', durationMs: 60_000 }, t0);
    await settle(w);
    const host = w.firewallHost(1);
    expect(host.applied.at(-1)).toContain('198.18.9.9');
    expect(host.applied.at(-1)).toMatch(/allow4 \{[\s\S]*173\.245\.48\.0\/20/);
    expect(w.core.blocklist.expire(t0 + 61_000)).toBe(1);
    await settle(w);
    expect(host.applied.at(-1)).not.toContain('198.18.9.9');
  });

  it('writes the list to every server, and catches up one that was unreachable', async () => {
    const w = await makeWorld();
    const s2 = w.addSshServer('s2', { real: true });
    const unreachable = s2.files.writeFile.bind(s2.files);
    s2.files.writeFile = async () => {
      const { ServerUnreachableError } = await import('../../src/servers/sshConnection.js');
      throw new ServerUnreachableError(s2.id, 's2', new Error('ETIMEDOUT'));
    };
    block(w, '198.18.9.9');
    await settle(w);
    expect(w.core.firewall.status(s2.id).state).toBe('unreachable');
    expect(w.firewallHost(1).applied).toHaveLength(1);

    s2.files.writeFile = unreachable;
    expect(w.core.firewall.tick().kicked).toBeGreaterThan(0);
    await settle(w);
    expect(w.core.firewall.status(s2.id).state).toBe('ok');
    expect(w.firewallHost(s2.id).applied[0]).toContain('198.18.9.9');
    expect(fs.existsSync(blockedFile(s2.root!))).toBe(true);
  });
});
