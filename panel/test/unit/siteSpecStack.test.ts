/**
 * The container a site gets, by stack. A stack 1 container has to come out exactly as it did before
 * there were stacks, or the image sweep would see no change and a recreate would still change a
 * running site: the specs below are what the code before the stacks wrote, byte for byte (the order
 * of labels too, hence JSON.stringify). What a stack 2 container adds is then spelled out on top.
 */
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { traefikLabels } from '../../src/services/labels.js';
import { RUNTIME_DIR_IN_CONTAINER, SITE_STACK_LABEL, stackFromLabels } from '../../src/services/siteStack.js';
import { WORDPRESS_CONFIG_EXTRA, WORDPRESS_CONFIG_EXTRA_STACK_2, buildSiteContainerSpec, sitePaths } from '../../src/services/siteSpec.js';

const config = {
  paths: { sites: '/srv/sites', plugins: '/srv/plugins' },
  mariadb: { host: 'mariadb' },
  tlsMode: 'letsencrypt',
  acmeResolver: 'letsencrypt',
} as unknown as Config;

const site = {
  slug: 'demo',
  phpVersion: '8.4',
  dbName: 'wp_demo',
  dbUser: 'wp_demo',
  dbPassword: 'db-secret',
  containerName: 'wp-demo',
  tablePrefix: 'wp_',
};

const tls = { devDomain: 'dev.example.com', wildcardProvider: '' };
const runtime = { memoryBytes: 536_870_912, nanoCpus: 2_000_000_000, pidsLimit: 512 };

const STACK_1_EXTRA = [
  `if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }`,
  `define('DISABLE_WP_CRON', true);`,
  `if (is_readable('/etc/wpl7/wp-config-extra.php')) { require_once '/etc/wpl7/wp-config-extra.php'; }`,
].join('\n');

const STACK_1_ROUTED = {
  name: 'wp-demo',
  image: 'wpl7-wordpress:php8.4',
  env: {
    WORDPRESS_DB_HOST: 'mariadb',
    WORDPRESS_DB_NAME: 'wp_demo',
    WORDPRESS_DB_USER: 'wp_demo',
    WORDPRESS_DB_PASSWORD: 'db-secret',
    WORDPRESS_TABLE_PREFIX: 'wp_',
    WORDPRESS_CONFIG_EXTRA: STACK_1_EXTRA,
  },
  labels: {
    'traefik.enable': 'true',
    'traefik.http.routers.wp-demo.rule': 'Host(`example.com`) || Host(`www.example.com`)',
    'traefik.http.routers.wp-demo.entrypoints': 'websecure',
    'traefik.http.services.wp-demo.loadbalancer.server.port': '80',
    'traefik.http.routers.wp-demo.tls.certresolver': 'letsencrypt',
    'traefik.http.middlewares.wp-demo-canonical.redirectregex.regex': '^https?://(?:www\\.example\\.com)(?::\\d+)?/(.*)',
    'traefik.http.middlewares.wp-demo-canonical.redirectregex.replacement': 'https://example.com/${1}',
    'traefik.http.middlewares.wp-demo-canonical.redirectregex.permanent': 'true',
    'traefik.http.routers.wp-demo.middlewares': 'wp-demo-canonical',
    'wpl7.managed': 'true',
    'wpl7.site': 'demo',
    'wpl7.role': 'wordpress',
    'wpl7.php': '8.4',
    'wpl7.routing': 'public',
    'wpl7.hardening': '1',
    'traefik.docker.network': 'wpl7_site_demo',
  },
  binds: [
    '/srv/sites/demo/wordpress:/var/www/html',
    '/srv/sites/demo/config/uploads.ini:/usr/local/etc/php/conf.d/zz-site.ini:ro',
    '/srv/sites/demo/config/msmtprc:/etc/msmtprc:ro',
    '/srv/sites/demo/config/security-apache.conf:/etc/apache2/conf-enabled/zz-wpl7-security.conf:ro',
    '/srv/sites/demo/config/security:/etc/wpl7:ro',
    '/srv/plugins:/srv/plugins:ro',
  ],
  networks: ['wpl7_site_demo', 'wpl7_egress'],
  memoryBytes: 536_870_912,
  nanoCpus: 2_000_000_000,
  pidsLimit: 512,
};

const STACK_1_UNROUTED = {
  name: 'wp-demo',
  image: 'wpl7-wordpress:php8.4',
  env: STACK_1_ROUTED.env,
  labels: {
    'traefik.enable': 'false',
    'wpl7.managed': 'true',
    'wpl7.site': 'demo',
    'wpl7.role': 'wordpress',
    'wpl7.php': '8.4',
    'wpl7.routing': 'none',
    'wpl7.hardening': '1',
  },
  binds: STACK_1_ROUTED.binds,
  networks: STACK_1_ROUTED.networks,
  memoryBytes: 268_435_456,
};

describe('a stack 1 container', () => {
  it('comes out as it did before there were stacks', () => {
    const domains = ['example.com', 'www.example.com'];
    expect(JSON.stringify(buildSiteContainerSpec(config, site, domains, tls, runtime, { stack: 1 }))).toBe(JSON.stringify(STACK_1_ROUTED));
  });

  it('stays the same with no router', () => {
    const spec = buildSiteContainerSpec(config, site, ['demo.dev.example.com'], tls, { memoryBytes: 268_435_456 }, { routing: false, stack: 1 });
    expect(JSON.stringify(spec)).toBe(JSON.stringify(STACK_1_UNROUTED));
  });

  it('has no stack label, which is what makes it stack 1', () => {
    const spec = buildSiteContainerSpec(config, site, ['example.com'], tls, runtime, { stack: 1 });
    expect(spec.labels).not.toHaveProperty(SITE_STACK_LABEL);
    expect(stackFromLabels(spec.labels)).toBe(1);
  });

  it('takes a particular image and nothing else with it', () => {
    const spec = buildSiteContainerSpec(config, site, ['example.com', 'www.example.com'], tls, runtime, { stack: 1, image: 'sha256:abc' });
    expect(JSON.stringify(spec)).toBe(JSON.stringify({ ...STACK_1_ROUTED, image: 'sha256:abc' }));
  });
});

describe('a stack 2 container', () => {
  const domains = ['example.com', 'www.example.com'];
  const spec = buildSiteContainerSpec(config, site, domains, tls, runtime, { stack: 2 });

  it('sends Traefik to nginx, not to the Apache behind it', () => {
    expect(spec.labels['traefik.http.services.wp-demo.loadbalancer.server.port']).toBe('8080');
  });

  it('says what it is', () => {
    expect(spec.labels[SITE_STACK_LABEL]).toBe('2');
    expect(stackFromLabels(spec.labels)).toBe(2);
  });

  it('mounts the runtime folder read-only', () => {
    expect(sitePaths(config, 'demo').runtimeDir).toBe('/srv/sites/demo/config/runtime');
    expect(spec.binds).toEqual([...STACK_1_ROUTED.binds, `/srv/sites/demo/config/runtime:${RUNTIME_DIR_IN_CONTAINER}:ro`]);
  });

  it('loads the WordPress side of the caches when it can read it', () => {
    expect(spec.env.WORDPRESS_CONFIG_EXTRA).toBe(WORDPRESS_CONFIG_EXTRA_STACK_2);
    expect(WORDPRESS_CONFIG_EXTRA_STACK_2).toBe(
      `${WORDPRESS_CONFIG_EXTRA}\nif (is_readable('/etc/wpl7-runtime/wp-cache.php')) { require_once '/etc/wpl7-runtime/wp-cache.php'; }`,
    );
  });

  it('differs from stack 1 in nothing else', () => {
    const { binds, env, labels, ...rest } = spec;
    const { binds: _binds, env: stack1Env, labels: stack1Labels, ...stack1Rest } = STACK_1_ROUTED;
    expect(rest).toEqual(stack1Rest);
    expect({ ...env, WORDPRESS_CONFIG_EXTRA: '' }).toEqual({ ...stack1Env, WORDPRESS_CONFIG_EXTRA: '' });
    expect({ ...labels, 'traefik.http.services.wp-demo.loadbalancer.server.port': '80', [SITE_STACK_LABEL]: undefined }).toEqual({
      ...stack1Labels,
      [SITE_STACK_LABEL]: undefined,
    });
    expect(binds.slice(0, -1)).toEqual(STACK_1_ROUTED.binds);
  });

  it('has the same label with no router, and no port to say', () => {
    const unrouted = buildSiteContainerSpec(config, site, ['demo.dev.example.com'], tls, runtime, { routing: false, stack: 2 });
    expect(unrouted.labels[SITE_STACK_LABEL]).toBe('2');
    expect(unrouted.labels['traefik.enable']).toBe('false');
    expect(Object.keys(unrouted.labels).filter((name) => name.includes('loadbalancer'))).toEqual([]);
  });

  it('takes a particular image', () => {
    expect(buildSiteContainerSpec(config, site, domains, tls, runtime, { stack: 2, image: 'sha256:def' }).image).toBe('sha256:def');
  });
});

describe('the port on the Traefik labels', () => {
  const base = { slug: 'demo', primary: 'example.com', aliases: [], tlsMode: 'none' as const, acmeResolver: 'letsencrypt', devDomain: 'dev.example.com', dnsProvider: '' };

  it('is 80 unless a call says otherwise', () => {
    expect(traefikLabels(base)['traefik.http.services.wp-demo.loadbalancer.server.port']).toBe('80');
    expect(traefikLabels({ ...base, port: 8080 })['traefik.http.services.wp-demo.loadbalancer.server.port']).toBe('8080');
  });
});
