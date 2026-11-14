/**
 * A container app's container, as the panel makes it (services/appSpec.ts), and what the way in
 * reads off busybox wget (services/appProbe.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  appLabels,
  buildAppContainerSpec,
  containerPathProblem,
  dataDirFor,
  envProblem,
  placeholdersIn,
  resolveEnv,
  usesMail,
  withImageVolumes,
} from '../../src/services/appSpec.js';
import { readWgetAnswer } from '../../src/services/appProbe.js';
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
    // The image dropped /var/lib/shop: what it holds stays where it is.
    expect(withImageVolumes(current, [], [])).toEqual(current);
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
