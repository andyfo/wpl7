/**
 * A container app's container, as the panel makes it (services/appSpec.ts), and what the way in
 * reads off busybox wget (services/appProbe.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ServerHandle } from '../../src/servers/registry.js';
import {
  appLabels,
  buildAppContainerSpec,
  containerPathProblem,
  dataDirFor,
  envProblem,
  placeholdersIn,
  resolveEnv,
  unkeptVolumes,
  usesMail,
  withImageVolumes,
} from '../../src/services/appSpec.js';
import { healthGate, readWgetAnswer } from '../../src/services/appProbe.js';
import type { EphemeralOpts, RunResult } from '../../src/services/docker.js';
import { mailLogin } from '../../src/services/mailAuth.js';
import { makeTestConfig } from '../helpers.js';

const site = {
  slug: 'shop',
  containerName: 'wp-shop',
  domains: JSON.stringify(['shop.example.com', 'shop.dev.example.test']),
  dbName: 'wp_shop',
  dbUser: 'wp_shop',
  dbPassword: 'db-secret',
  mailPassword: 'mail-secret',
};

const settings = {
  runAs: '',
  dropAllCaps: 0,
  readOnlyRoot: 0,
  extraHosts: '[]',
  dataPaths: JSON.stringify([{ path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: true }]),
  stopGraceSec: 20,
};

describe('a container app’s environment', () => {
  it('fills the placeholders at every create, and leaves the rest of a value as it is', () => {
    const config = makeTestConfig();
    const env = resolveEnv(config, site, [
      { name: 'DATABASE_URL', value: 'mysql://{{db.user}}:{{db.password}}@{{db.host}}:{{db.port}}/{{db.name}}' },
      { name: 'SMTP', value: '{{ mail.user }}@{{mail.host}}:{{mail.port}}' },
      { name: 'BASE', value: 'https://{{site.domain}}/' },
      { name: 'LITERAL', value: 'a {{ not one }} b' },
    ]);
    expect(env).toEqual({
      DATABASE_URL: `mysql://wp_shop:db-secret@${config.mariadb.host}:3306/wp_shop`,
      SMTP: `${mailLogin('shop')}@mail:587`,
      BASE: 'https://shop.example.com/',
      LITERAL: 'a {{ not one }} b',
    });
  });

  it('refuses a placeholder it does not fill, and the database’s for an app without one', () => {
    expect(envProblem([{ name: 'X', value: '{{db.port}}' }], { database: true })).toBeNull();
    expect(envProblem([{ name: 'X', value: '{{site.url}}' }], { database: true })).toMatch(/^X: \{\{site\.url\}\} is not one the panel fills\. It fills \{\{db\.host\}\}/);
    expect(envProblem([{ name: 'DB', value: '{{db.name}}' }], { database: false })).toBe("DB: {{db.name}} needs the app's database, and it has none.");
    expect(placeholdersIn('{{a}} and {{ b.c }}')).toEqual(['a', 'b.c']);
    expect(usesMail([{ value: 'x' }, { value: '{{mail.password}}' }])).toBe(true);
    expect(usesMail([{ value: '{{db.password}}' }])).toBe(false);
  });
});

describe('a container app’s paths', () => {
  it('keeps every path in a folder of its own, named after it', () => {
    expect(dataDirFor('/var/lib/app', [])).toBe('var-lib-app');
    expect(dataDirFor('/var/lib/app', ['var-lib-app'])).toBe('var-lib-app-2');
    expect(dataDirFor('/var/lib/app', ['var-lib-app', 'var-lib-app-2'])).toBe('var-lib-app-3');
    expect(dataDirFor('/', [])).toBe('root');
  });

  it('refuses a path that is not a folder of the app’s own', () => {
    expect(containerPathProblem('/data')).toBeNull();
    expect(containerPathProblem('/srv/app/uploads')).toBeNull();
    expect(containerPathProblem('data')).toBe('data is not an absolute path.');
    expect(containerPathProblem('/')).toBe('/: name a folder, without a / at the end.');
    expect(containerPathProblem('/data/')).toBe('/data/: name a folder, without a / at the end.');
    expect(containerPathProblem('/data/../etc')).toBe('/data/../etc has an empty, . or .. part.');
    expect(containerPathProblem('/data//x')).toBe('/data//x has an empty, . or .. part.');
    expect(containerPathProblem('/etc/ssl')).toBe("/etc/ssl is in /etc, which belongs to the container's own system.");
    expect(containerPathProblem('/proc')).toBe("/proc is in /proc, which belongs to the container's own system.");
    expect(containerPathProblem('/data dir')).toBe('/data dir may hold only letters, digits and . _ @ + - /.');
  });

  it('adds each new VOLUME of an image, and keeps one the image dropped', () => {
    const current = [{ path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: true }, { path: '/cache', dir: 'cache', fromImage: false }];
    expect(withImageVolumes(current, ['/var/lib/shop/', '/uploads', '/mnt/secrets'], ['/mnt/secrets'])).toEqual([
      ...current,
      { path: '/uploads', dir: 'uploads', fromImage: true },
    ]);
    // The image dropped /var/lib/shop: what it holds stays where it is, no longer the image's.
    expect(withImageVolumes(current, [], [])).toEqual([{ ...current[0], fromImage: false }, current[1]]);
    // A path of the app's own that the image declares now is the image's.
    expect(withImageVolumes(current, ['/var/lib/shop', '/cache'], [])).toEqual([current[0], { ...current[1], fromImage: true }]);
    // As Docker reads a VOLUME: /data//x/ is /data/x.
    expect(withImageVolumes([], ['/data//x/'], [])).toEqual([{ path: '/data/x', dir: 'data-x', fromImage: true }]);
  });

  it('names each VOLUME no data path or mount keeps, and why', () => {
    const data = [{ path: '/var/lib/shop', dir: 'var-lib-shop', fromImage: true }];
    expect(unkeptVolumes(['/var/lib/shop/', '/mnt/secrets', '/usr/share/shop/data', '/etc/shop', '/data dir'], data, ['/mnt/secrets'])).toEqual([
      { path: '/usr/share/shop/data', why: "it is in /usr, which belongs to the container's own system." },
      { path: '/etc/shop', why: "it is in /etc, which belongs to the container's own system." },
      { path: '/data dir', why: 'it may hold only letters, digits and . _ @ + - /.' },
    ]);
    expect(unkeptVolumes([], data, [])).toEqual([]);
  });
});

describe('a container app’s container', () => {
  it('has no Traefik label but the one that keeps Traefik off it, and the panel’s own', () => {
    expect(appLabels('shop')).toEqual({ 'traefik.enable': 'false', 'wpl7.managed': 'true', 'wpl7.site': 'shop', 'wpl7.role': 'app' });
  });

  it('is made from the pinned image, on its own network, with its folders and nothing else of the host', () => {
    const config = makeTestConfig();
    const spec = buildAppContainerSpec(config, {
      site,
      settings,
      env: [{ name: 'PORT', value: '8000' }],
      mounts: [
        { name: 'secrets', containerPath: '/run/secrets/app', writable: 0 },
        { name: 'uploads', containerPath: '/srv/uploads', writable: 1 },
      ],
      runtime: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1e9, pidsLimit: 200 },
      image: 'ghcr.io/example/shop@sha256:' + 'a'.repeat(64),
    });
    const root = `${config.paths.sites}/shop`;
    expect(spec).toEqual({
      name: 'wp-shop',
      image: 'ghcr.io/example/shop@sha256:' + 'a'.repeat(64),
      env: { PORT: '8000' },
      labels: appLabels('shop'),
      binds: [`${root}/data/var-lib-shop:/var/lib/shop`, `${root}/mounts/secrets:/run/secrets/app:ro`, `${root}/mounts/uploads:/srv/uploads`],
      networks: ['wpl7_site_shop', 'wpl7_egress'],
      memoryBytes: 256 * 1024 * 1024,
      nanoCpus: 1e9,
      pidsLimit: 200,
      extraHosts: [],
      stopTimeout: 20,
    });
  });

  it('runs as the user asked, with no capability and a read-only root when asked, and knows the hosts given', () => {
    const spec = buildAppContainerSpec(makeTestConfig(), {
      site,
      settings: { ...settings, runAs: '1000:1000', dropAllCaps: 1, readOnlyRoot: 1, stopGraceSec: 90, extraHosts: JSON.stringify([{ host: 'api.internal', address: '192.0.2.10' }]) },
      env: [],
      mounts: [],
      runtime: { memoryBytes: 512 * 1024 * 1024 },
      image: 'sha256:' + 'b'.repeat(64),
    });
    expect(spec).toMatchObject({
      user: '1000:1000',
      capDrop: ['ALL'],
      readOnlyRootfs: true,
      tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m' },
      extraHosts: ['api.internal:192.0.2.10'],
      stopTimeout: 90,
    });
    expect(spec.labels['traefik.enable']).toBe('false');
  });
});

describe('the health gate', () => {
  const app = { slug: 'shop', containerName: 'wp-shop', domains: JSON.stringify(['shop.example.com']) };
  const gateSettings = { healthPath: '/healthz', healthHost: '', healthTimeoutSec: 30, deployCheckPath: '/ready?deep=1' };

  /** A way in that answers as `answer` says (null: no answer at all): each question's URL, and how long wget is let wait (-T). */
  function probe(answer: (url: string) => number | null) {
    const asked: { url: string; wait: number }[] = [];
    const runEphemeral = async (o: EphemeralOpts): Promise<RunResult> => {
      const url = o.cmd.at(-1)!;
      asked.push({ url, wait: Number(o.cmd[o.cmd.indexOf('-T') + 1]) });
      const status = answer(url);
      if (status === null) return { stdout: '', stderr: `wget: can't connect to remote host: Connection refused\n`, exitCode: 1 };
      return { stdout: '', stderr: `  HTTP/1.1 ${status} ${status < 400 ? 'OK' : 'Error'}\n`, exitCode: status < 400 ? 0 : 1 };
    };
    const server = { name: 'local', docker: { containerImage: async () => 'traefik:v3', runEphemeral } } as unknown as Pick<ServerHandle, 'docker' | 'name'>;
    return { server, asked };
  }
  /** The app listens on `port` alone, and answers 200 there. */
  const listensOn = (port: number) => (url: string) => (new URL(url).port === String(port) ? 200 : null);

  it('asks the health path for at most 10 s a try, and the deploy check for the app’s whole timeout', async () => {
    let now = Date.parse('2026-11-15T12:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const first = probe(() => 200);
      expect(await healthGate(first.server, app, gateSettings, [8000], { deployCheck: true, intervalMs: 0 })).toEqual({ port: 8000, failed: null });
      // The deploy check is one argument to wget, its query and all.
      expect(first.asked).toEqual([
        { url: 'http://wp-shop:8000/healthz', wait: 10 },
        { url: 'http://wp-shop:8000/ready?deep=1', wait: 30 },
      ]);

      // The health path answers with half a second left: its last try gets that, the deploy check its own wait.
      let tries = 0;
      const late = probe((url) => {
        if (!url.endsWith('/healthz')) return 200;
        if (++tries > 1) return 200;
        now += 29_500;
        return 503;
      });
      expect(await healthGate(late.server, app, gateSettings, [8000], { deployCheck: true, intervalMs: 0 })).toEqual({ port: 8000, failed: null });
      expect(late.asked.map((a) => a.wait)).toEqual([10, 1, 30]);
    } finally {
      clock.mockRestore();
    }
  });

  it('asks each port in turn every round, passes on the first that answers, and asks the deploy check there', async () => {
    // The staged port first: an image that listens on it passes there, though the next one answers too.
    const both = probe(() => 200);
    expect(await healthGate(both.server, app, gateSettings, [9000, 8000], { deployCheck: true, intervalMs: 0 })).toEqual({ port: 9000, failed: null });
    expect(both.asked.map((a) => a.url)).toEqual(['http://wp-shop:9000/healthz', 'http://wp-shop:9000/ready?deep=1']);

    // One that does not listen there passes on the next, in the same round; nothing staged and nothing known (0) is no port.
    const old = probe(listensOn(8000));
    const lines: string[] = [];
    expect(await healthGate(old.server, app, gateSettings, [9000, 0, 8000, 9000], { deployCheck: true, intervalMs: 0, log: (l) => lines.push(l) })).toEqual({
      port: 8000,
      failed: null,
    });
    expect(old.asked.map((a) => a.url)).toEqual(['http://wp-shop:9000/healthz', 'http://wp-shop:8000/healthz', 'http://wp-shop:8000/ready?deep=1']);
    expect(lines).toEqual(['/healthz answered 200 OK on port 8000.', 'The deploy check /ready?deep=1 answered 200 OK.']);

    // A deploy check that fails on the port that answered fails the gate.
    const failing = probe((url) => (url.includes('/ready') ? 500 : listensOn(8000)(url)));
    expect((await healthGate(failing.server, app, gateSettings, [9000, 8000], { deployCheck: true, intervalMs: 0 })).failed).toBe('The deploy check /ready?deep=1 answered 500 Error.');
    expect(failing.asked.at(-1)!.url).toBe('http://wp-shop:8000/ready?deep=1');
  });

  it('keeps one timeout for every port, and names each port it asked when none answered', async () => {
    let now = Date.parse('2026-11-15T12:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      // Each question takes 4 s: two ports, two rounds, and the 10 s are over.
      const none = probe(() => {
        now += 4000;
        return null;
      });
      const result = await healthGate(none.server, app, { ...gateSettings, healthTimeoutSec: 10 }, [9000, 8000], { deployCheck: true, intervalMs: 0 });
      expect(result).toEqual({
        port: null,
        failed: "/healthz did not answer 2xx on port 9000 or 8000 within 10 s (2 tries each; last: 9000 no answer: can't connect to remote host: Connection refused; 8000 no answer: can't connect to remote host: Connection refused).",
      });
      // Each try waits what is left of the one timeout, at most 10 s and at least 1.
      expect(none.asked.map((a) => [new URL(a.url).port, a.wait])).toEqual([
        ['9000', 10],
        ['8000', 6],
        ['9000', 2],
        ['8000', 1],
      ]);

      // One port: the message it always had.
      const one = probe(() => {
        now += 4000;
        return 503;
      });
      expect((await healthGate(one.server, app, { ...gateSettings, healthTimeoutSec: 10 }, [0, 8000, 8000], { deployCheck: false, intervalMs: 0 })).failed).toBe(
        '/healthz did not answer 2xx within 10 s (3 tries; last: 503 Error).',
      );
      expect((await healthGate(one.server, app, gateSettings, [0], { deployCheck: false })).failed).toBe('The app has no port to ask: give the port it listens on.');
    } finally {
      clock.mockRestore();
    }
  });
});

describe('the way in', () => {
  it('goes by the first status line wget prints', () => {
    expect(readWgetAnswer({ stdout: '', stderr: '  HTTP/1.1 200 OK\n  Content-Type: text/plain\n', exitCode: 0 })).toEqual({ status: 200, detail: '200 OK' });
    expect(readWgetAnswer({ stdout: '', stderr: '  HTTP/1.1 302 Found\n  Location: /login\n  HTTP/1.1 200 OK\n', exitCode: 0 })).toEqual({ status: 302, detail: '302 Found' });
    expect(readWgetAnswer({ stdout: '', stderr: '  HTTP/1.1 503 Service Unavailable\nwget: server returned error: HTTP/1.1 503 Service Unavailable\n', exitCode: 1 })).toEqual({
      status: 503,
      detail: '503 Service Unavailable',
    });
    expect(readWgetAnswer({ stdout: '', stderr: "wget: bad address 'wp-shop:8000'\n", exitCode: 1 })).toEqual({ status: null, detail: "no answer: bad address 'wp-shop:8000'" });
    expect(readWgetAnswer({ stdout: '', stderr: '', exitCode: 137 })).toEqual({ status: null, detail: 'no answer: exit 137' });
  });
});
