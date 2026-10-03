import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DockerService, SPEC_LABEL, serviceSpecHash, type ServiceContainerSpec } from '../../src/services/docker.js';
import { ExecFiles, LocalFiles } from '../../src/lib/files.js';
import { hostExec } from '../../src/lib/exec.js';

/**
 * A dockerode stand-in that remembers containers the way the daemon would: enough for
 * ensureServiceContainer's create / keep / replace / start decisions and the wire format.
 */
function fakeDaemon() {
  interface C {
    id: string;
    opts: Record<string, unknown> & { Labels: Record<string, string>; HostConfig: Record<string, unknown> };
    running: boolean;
    networks: Set<string>;
  }
  const byName = new Map<string, C>();
  const log: string[] = [];
  const notFound = () => Object.assign(new Error('no such container'), { statusCode: 404 });
  let seq = 0;
  const api = {
    createContainer: async (opts: C['opts'] & { name: string; NetworkingConfig: { EndpointsConfig: Record<string, unknown> } }) => {
      const c: C = { id: `id${++seq}`, opts, running: false, networks: new Set(Object.keys(opts.NetworkingConfig.EndpointsConfig)) };
      byName.set(opts.name, c);
      log.push(`create ${opts.name}`);
      return { id: c.id, remove: async () => byName.delete(opts.name) };
    },
    getContainer: (name: string) => ({
      inspect: async () => {
        const c = byName.get(name);
        if (!c) throw notFound();
        return {
          Config: { Labels: c.opts.Labels },
          State: { Running: c.running, Status: c.running ? 'running' : 'exited', Restarting: false, StartedAt: '2026-09-25T10:00:00Z' },
          RestartCount: 3,
          NetworkSettings: { Networks: Object.fromEntries([...c.networks].map((n) => [n, {}])) },
        };
      },
      start: async () => {
        const c = byName.get(name);
        if (!c) throw notFound();
        if (c.running) throw Object.assign(new Error('already started'), { statusCode: 304 });
        c.running = true;
        log.push(`start ${name}`);
      },
      remove: async () => {
        if (!byName.delete(name)) throw notFound();
        log.push(`remove ${name}`);
      },
      kill: async ({ signal }: { signal: string }) => {
        const c = byName.get(name);
        if (!c) throw notFound();
        if (!c.running) throw Object.assign(new Error('not running'), { statusCode: 409 });
        log.push(`kill ${name} ${signal}`);
      },
    }),
    getNetwork: (network: string) => ({
      connect: async ({ Container }: { Container: string }) => {
        const c = [...byName.values()].find((x) => x.id === Container) ?? byName.get(Container);
        c?.networks.add(network);
        log.push(`connect ${network}`);
      },
      disconnect: async ({ Container }: { Container: string }) => {
        byName.get(Container)?.networks.delete(network);
        log.push(`disconnect ${network}`);
      },
    }),
  };
  return { api, byName, log };
}

const spec = (over: Partial<ServiceContainerSpec> = {}): ServiceContainerSpec => ({
  name: 'wpl7-ftp',
  image: 'drakkan/sftpgo:v2.7.6-distroless-slim',
  cmd: ['sftpgo', 'serve'],
  user: '60021:60021',
  env: { GOMEMLIMIT: '400MiB' },
  labels: { 'wpl7.role': 'ftp-gateway' },
  binds: ['/srv/ftp/gateway:/etc/wpl7-ftp:ro'],
  tmpfs: { '/tmp': 'size=16m' },
  readOnlyRootfs: true,
  networks: ['wpl7_ftp_edge', 'wpl7_ftp'],
  ports: [
    { hostIp: '0.0.0.0', hostPort: 2222, containerPort: 2022 },
    { hostIp: '0.0.0.0', hostPort: 30000, containerPort: 30000 },
  ],
  memoryBytes: 512 * 1024 * 1024,
  nanoCpus: 2e9,
  pidsLimit: 256,
  inputs: 'config-v1',
  ...over,
});

describe('DockerService.ensureServiceContainer', () => {
  it('creates a locked-down container with its ports, labels and networks, then starts it', async () => {
    const d = fakeDaemon();
    const docker = new DockerService('p', 'db', d.api as never);
    expect(await docker.ensureServiceContainer(spec())).toBe('created');

    const c = d.byName.get('wpl7-ftp')!;
    expect(c.running).toBe(true);
    expect(c.opts.User).toBe('60021:60021');
    expect(c.opts.Labels).toEqual({ 'wpl7.managed': 'true', 'wpl7.role': 'ftp-gateway', [SPEC_LABEL]: serviceSpecHash(spec()) });
    expect(c.opts.ExposedPorts).toEqual({ '2022/tcp': {}, '30000/tcp': {} });
    const host = c.opts.HostConfig;
    expect(host.PortBindings).toEqual({
      '2022/tcp': [{ HostIp: '0.0.0.0', HostPort: '2222' }],
      '30000/tcp': [{ HostIp: '0.0.0.0', HostPort: '30000' }],
    });
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Tmpfs).toEqual({ '/tmp': 'size=16m' });
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.Mounts).toEqual([{ Type: 'bind', Source: '/srv/ftp/gateway', Target: '/etc/wpl7-ftp', ReadOnly: true }]);
    expect([...c.networks]).toEqual(['wpl7_ftp_edge', 'wpl7_ftp']);
  });

  it('leaves a matching running container alone, and restarts a stopped one', async () => {
    const d = fakeDaemon();
    const docker = new DockerService('p', 'db', d.api as never);
    await docker.ensureServiceContainer(spec());
    d.log.length = 0;
    expect(await docker.ensureServiceContainer(spec())).toBe('unchanged');
    expect(d.log).toEqual([]);

    d.byName.get('wpl7-ftp')!.running = false;
    expect(await docker.ensureServiceContainer(spec())).toBe('started');
    expect(d.log).toEqual(['start wpl7-ftp']);
  });

  it('replaces the container when anything in the spec changes - including what it reads at start', async () => {
    const d = fakeDaemon();
    const docker = new DockerService('p', 'db', d.api as never);
    await docker.ensureServiceContainer(spec());
    d.log.length = 0;
    expect(await docker.ensureServiceContainer(spec({ inputs: 'config-v2' }))).toBe('recreated');
    expect(d.log).toEqual(['remove wpl7-ftp', 'create wpl7-ftp', 'connect wpl7_ftp', 'start wpl7-ftp']);
  });

  it('puts a container back on a network it lost without replacing it', async () => {
    const d = fakeDaemon();
    const docker = new DockerService('p', 'db', d.api as never);
    await docker.ensureServiceContainer(spec());
    d.byName.get('wpl7-ftp')!.networks.delete('wpl7_ftp');
    d.byName.get('wpl7-ftp')!.networks.add('bridge');
    d.log.length = 0;
    expect(await docker.ensureServiceContainer(spec())).toBe('unchanged');
    expect(d.log).toEqual(['connect wpl7_ftp', 'disconnect bridge']);
  });

  it('hashes the same spec the same way whatever order it was written in', () => {
    const a = spec();
    const b = { ...spec(), env: { GOMEMLIMIT: '400MiB' }, labels: { 'wpl7.role': 'ftp-gateway' } };
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as ServiceContainerSpec;
    expect(serviceSpecHash(reordered)).toBe(serviceSpecHash(a));
    expect(serviceSpecHash(spec({ inputs: 'other' }))).not.toBe(serviceSpecHash(a));
  });

  it('signals a running container, and says so when there is nothing to signal', async () => {
    const d = fakeDaemon();
    const docker = new DockerService('p', 'db', d.api as never);
    expect(await docker.signalContainer('wpl7-ftp', 'SIGHUP')).toBe(false);
    await docker.ensureServiceContainer(spec());
    expect(await docker.signalContainer('wpl7-ftp', 'SIGHUP')).toBe(true);
    expect(d.log).toContain('kill wpl7-ftp SIGHUP');
    d.byName.get('wpl7-ftp')!.running = false;
    expect(await docker.signalContainer('wpl7-ftp', 'SIGHUP')).toBe(false);
  });

  it('reports the restart count, and a missing container as missing', async () => {
    const d = fakeDaemon();
    const docker = new DockerService('p', 'db', d.api as never);
    expect(await docker.serviceState('wpl7-ftp')).toEqual({ state: 'missing', restarting: false, restartCount: 0, startedAt: null });
    await docker.ensureServiceContainer(spec());
    expect(await docker.serviceState('wpl7-ftp')).toEqual({
      state: 'running',
      restarting: false,
      restartCount: 3,
      startedAt: Date.parse('2026-09-25T10:00:00Z'),
    });
  });
});

describe('DockerService.buildImage', () => {
  it('sends every file of the context, and has a failed step leave no container behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-ctx-'));
    for (const f of ['Dockerfile', 'VERSION', 'staged-overwrite.patch']) fs.writeFileSync(path.join(dir, f), f);
    fs.mkdirSync(path.join(dir, 'not-a-file'));
    let sent: { ctx: { context: string; src: string[] }; opts: Record<string, unknown> } | null = null;
    const api = {
      buildImage: async (ctx: { context: string; src: string[] }, opts: Record<string, unknown>) => {
        sent = { ctx, opts };
        return new PassThrough();
      },
      modem: { followProgress: (_s: unknown, done: (err: Error | null, out: unknown[]) => void) => done(null, []) },
    };
    await new DockerService('p', 'db', api as never).buildImage('wpl7-sftpgo:1', dir, { A: 'b' });
    expect(sent!.ctx.context).toBe(dir);
    expect([...sent!.ctx.src].sort()).toEqual(['Dockerfile', 'VERSION', 'staged-overwrite.patch']);
    // A failed RUN's stopped container would hold the image it ran in, and nothing of the
    // build could be pruned.
    expect(sent!.opts).toMatchObject({ t: 'wpl7-sftpgo:1', buildargs: { A: 'b' }, rm: true, forcerm: true });
  });
});

describe('atomic writes with an owner', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-files-'));

  it('LocalFiles renames a finished file into place and leaves no temporary behind', async () => {
    const dir = tmp();
    const target = path.join(dir, 'users.json');
    fs.writeFileSync(target, 'old');
    await new LocalFiles().writeFile(target, 'new', { mode: 0o640, atomic: true, owner: { uid: 60021, gid: 60021 } });
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir)).toEqual(['users.json']);
  });

  it('ExecFiles does the same in one shell round trip', async () => {
    const dir = tmp();
    const target = path.join(dir, "it's here.json");
    const owner = { uid: process.getuid!(), gid: process.getgid!() };
    await new ExecFiles(hostExec).writeFile(target, 'content', { mode: 0o600, atomic: true, owner });
    expect(fs.readFileSync(target, 'utf8')).toBe('content');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["it's here.json"]);
  });

  it('ExecFiles cleans up after a write that fails half-way', async () => {
    const dir = tmp();
    const target = path.join(dir, 'x.json');
    // Nobody can chown to a uid as a normal user - unless the suite runs as root.
    if (process.getuid!() === 0) return;
    await expect(
      new ExecFiles(hostExec).writeFile(target, 'content', { atomic: true, owner: { uid: 60021, gid: 60021 } }),
    ).rejects.toThrow(/write .* failed/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('stat names the directory entry, which a replaced folder does not share', async () => {
    const dir = tmp();
    const folder = path.join(dir, 'wordpress');
    fs.mkdirSync(folder);
    const files = new LocalFiles();
    const before = (await files.stat(folder))!.id;
    fs.renameSync(folder, `${folder}.pre-restore`);
    fs.mkdirSync(folder);
    const after = (await files.stat(folder))!.id;
    expect(before).toMatch(/^\d+:\d+$/);
    expect(after).not.toBe(before);
    // ExecFiles speaks GNU stat, which every server has and macOS does not.
    if (process.platform === 'linux') {
      expect((await new ExecFiles(hostExec).stat(folder))?.id).toMatch(/^\d+:\d+$/);
    }
  });
});
