import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { servers } from '../../src/db/schema.js';
import {
  MAX_TERMINALS,
  TerminalService,
  defaultGatewayFromRouteTable,
  rootKeyInstallScript,
} from '../../src/servers/terminal.js';
import { parseSize } from '../../src/routes/terminal.js';
import { FakeExec, makeWorld, sshAuthFailure } from '../helpers.js';
import type { EphemeralOpts } from '../../src/services/docker.js';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('defaultGatewayFromRouteTable', () => {
  const table = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  ].join('\n');

  it('decodes the little-endian default gateway', () => {
    expect(defaultGatewayFromRouteTable(table)).toBe('172.17.0.1');
  });

  it('returns null without a default route', () => {
    expect(defaultGatewayFromRouteTable(table.split('\n').filter((l) => !l.includes('010011AC')).join('\n'))).toBeNull();
    expect(defaultGatewayFromRouteTable('')).toBeNull();
  });
});

describe('rootKeyInstallScript', () => {
  it('creates the dir/file with tight modes and appends idempotently', () => {
    const script = rootKeyInstallScript('/root/.ssh', 'ssh-ed25519 AAAA test@host');
    expect(script).toContain('install -d -m 700 /root/.ssh');
    expect(script).toContain('chmod 600 /root/.ssh/authorized_keys');
    expect(script).toContain(
      "grep -qxF -- 'ssh-ed25519 AAAA test@host' /root/.ssh/authorized_keys || " +
        "printf '%s\\n' 'ssh-ed25519 AAAA test@host' >> /root/.ssh/authorized_keys",
    );
  });

  it('terminates an existing last line before appending', () => {
    // Without this the key is glued onto the previous line: root login keeps
    // failing, and a substring match would then find the key in that mangled
    // line forever, so no retry could repair it.
    const script = rootKeyInstallScript('/root/.ssh', 'ssh-ed25519 AAAA test@host');
    expect(script).toContain(
      `if [ -s /root/.ssh/authorized_keys ] && [ -n "$(tail -c1 /root/.ssh/authorized_keys)" ]; ` +
        `then printf '\\n' >> /root/.ssh/authorized_keys; fi`,
    );
    // Whole-line match, so a damaged file self-heals instead of matching forever.
    expect(script).toContain('grep -qxF --');
  });

  it('runs against a real shell: repairs a newline-less file, then no-ops', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-ak-'));
    const key = 'ssh-ed25519 AAAAPANEL wpl7-panel@test';
    // Pre-existing entry with no trailing newline - what a hand-edited file looks like.
    fs.writeFileSync(path.join(dir, 'authorized_keys'), 'ssh-ed25519 AAAAOTHER other@host');
    const script = rootKeyInstallScript(dir, key);
    execFileSync('sh', ['-c', script]);
    let lines = fs.readFileSync(path.join(dir, 'authorized_keys'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toEqual(['ssh-ed25519 AAAAOTHER other@host', key]);
    // Second run must change nothing.
    execFileSync('sh', ['-c', script]);
    lines = fs.readFileSync(path.join(dir, 'authorized_keys'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toEqual(['ssh-ed25519 AAAAOTHER other@host', key]);
    expect(fs.statSync(path.join(dir, 'authorized_keys')).mode & 0o777).toBe(0o600);
  });
});

describe('parseSize', () => {
  it('defaults to 80x24 and clamps out-of-range values', () => {
    expect(parseSize({})).toEqual({ cols: 80, rows: 24 });
    expect(parseSize({ cols: 'garbage', rows: undefined })).toEqual({ cols: 80, rows: 24 });
    expect(parseSize({ cols: '100', rows: '30' })).toEqual({ cols: 100, rows: 30 });
    expect(parseSize({ cols: '99999', rows: '1' })).toEqual({ cols: 500, rows: 5 });
  });
});

describe('TerminalService', () => {
  it('connects as root and retries once after installing the key on an ssh server', async () => {
    const world = await makeWorld();
    const s2 = world.addSshServer('s2');
    const rec = new FakeExec();
    world.remote(s2.id).exec = rec;
    world.shell.failQueue.push(sshAuthFailure());

    const statuses: string[] = [];
    const handle = await world.deps.terminal.open(s2.id, { cols: 80, rows: 24 }, { onStatus: (m) => statuses.push(m) });

    expect(world.shell.connects).toHaveLength(2);
    expect(world.shell.connects[0]).toMatchObject({ host: 's2.test', port: 22, username: 'root' });
    // The install ran through the existing sudo-wrapped exec channel.
    const install = rec.calls.find((c) => c.cmd === 'sh');
    expect(install?.args[0]).toBe('-c');
    expect(install?.args[1]).toContain("grep -qxF -- 'ssh-ed25519 AAAAFAKEKEY wpl7-panel@test' /root/.ssh/authorized_keys");
    expect(statuses.some((s) => s.includes('installing'))).toBe(true);
    expect(world.deps.terminal.count()).toBe(1);
    handle.close();
    expect(world.deps.terminal.count()).toBe(0);
    expect(world.shell.opened[0]!.disposed).toBe(true);
  });

  it('does not touch authorized_keys on non-auth failures', async () => {
    const world = await makeWorld();
    const s2 = world.addSshServer('s2');
    const rec = new FakeExec();
    world.remote(s2.id).exec = rec;
    world.shell.failQueue.push(new Error('connect ECONNREFUSED'));

    await expect(world.deps.terminal.open(s2.id, { cols: 80, rows: 24 })).rejects.toThrow('ECONNREFUSED');
    expect(world.shell.connects).toHaveLength(1);
    expect(rec.calls).toHaveLength(0);
  });

  it('installs the key on the local host via a throwaway container', async () => {
    const world = await makeWorld();
    // The panel clones whatever image it is itself running - a released tag here. A
    // hardcoded local name broke the moment a box stopped building its own panel.
    world.docker.containers.set('wpl7-panel', 'running');
    const svc = new TerminalService(world.db, world.config, world.servers, silentLog, {
      connect: world.shell.connect,
      inContainer: () => true,
    });
    world.shell.failQueue.push(sshAuthFailure());

    const handle = await svc.open(1, { cols: 80, rows: 24 });
    const call = world.docker.calls.find((c) => c.method === 'runEphemeral');
    expect(call).toBeDefined();
    const opts = call!.args[0] as EphemeralOpts;
    expect(opts.image).toBe('ghcr.io/andyfo/wpl7/panel:0.3.0');
    expect(opts.binds).toEqual(['/root:/hostroot']);
    expect(opts.networks).toEqual([]);
    expect(opts.cmd[2]).toContain('/hostroot/.ssh/authorized_keys');
    handle.close();
  });

  it('falls back to a local build tag when it cannot see its own container', async () => {
    const world = await makeWorld();
    const svc = new TerminalService(world.db, world.config, world.servers, silentLog, {
      connect: world.shell.connect,
      inContainer: () => true,
    });
    world.shell.failQueue.push(sshAuthFailure());

    const handle = await svc.open(1, { cols: 80, rows: 24 });
    const opts = world.docker.calls.find((c) => c.method === 'runEphemeral')!.args[0] as EphemeralOpts;
    expect(opts.image).toBe('wpl7-panel:dev');
    handle.close();
  });

  it('refuses to self-install outside a container (dev mode)', async () => {
    const world = await makeWorld();
    const svc = new TerminalService(world.db, world.config, world.servers, silentLog, {
      connect: world.shell.connect,
      inContainer: () => false,
    });
    world.shell.failQueue.push(sshAuthFailure());
    await expect(svc.open(1, { cols: 80, rows: 24 })).rejects.toThrow(/authorized_keys yourself/);
  });

  it('TOFU-pins the host key of server 1 through the servers table', async () => {
    const world = await makeWorld();
    const handle = await world.deps.terminal.open(1, { cols: 80, rows: 24 });
    const opts = world.shell.connects[0]!;
    expect(opts.pinnedHostKey()).toBeNull();
    opts.onHostKeyCaptured?.('SHA256:abcdef');
    expect(world.db.select().from(servers).where(eq(servers.id, 1)).get()?.hostKeySha256).toBe('SHA256:abcdef');
    expect(opts.pinnedHostKey()).toBe('SHA256:abcdef');
    handle.close();
  });

  it('holds the cap when many opens race (slot reserved before the first await)', async () => {
    const world = await makeWorld();
    // Every open blocks mid-connect, so all of them are in flight together -
    // exactly the window a check that only counted registered sessions missed.
    world.shell.hold();
    const attempts = Array.from({ length: MAX_TERMINALS + 4 }, () =>
      world.deps.terminal.open(1, { cols: 80, rows: 24 }),
    );
    const settled = attempts.map((p) => p.catch((err: Error) => err));
    world.shell.release();
    const results = await Promise.all(settled);

    const rejected = results.filter((r) => r instanceof Error);
    expect(rejected).toHaveLength(4);
    expect(rejected.every((e) => (e as Error).message.includes('Terminal limit'))).toBe(true);
    expect(world.deps.terminal.count()).toBe(MAX_TERMINALS);
    // Nothing was connected beyond the cap - no orphaned SSH session left behind.
    expect(world.shell.opened).toHaveLength(MAX_TERMINALS);
    world.deps.terminal.closeAll();
  });

  it('frees the reserved slot when an open fails', async () => {
    const world = await makeWorld();
    world.shell.failQueue.push(new Error('connect ECONNREFUSED'));
    await expect(world.deps.terminal.open(1, { cols: 80, rows: 24 })).rejects.toThrow('ECONNREFUSED');
    expect(world.deps.terminal.count()).toBe(0);
  });

  it('caps concurrent sessions and closeAll disposes everything', async () => {
    const world = await makeWorld();
    for (let i = 0; i < MAX_TERMINALS; i++) {
      await world.deps.terminal.open(1, { cols: 80, rows: 24 });
    }
    await expect(world.deps.terminal.open(1, { cols: 80, rows: 24 })).rejects.toThrow(/Terminal limit/);
    world.deps.terminal.closeAll();
    expect(world.deps.terminal.count()).toBe(0);
    expect(world.shell.opened.every((t) => t.disposed)).toBe(true);
  });
});
