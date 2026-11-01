/**
 * A site moving from stack 1 to stack 2 on a real Docker daemon, through the panel's own
 * replaceContainer: a stack 1 container on a real image whose tag then moves, a real WordPress with
 * the real WooCommerce, and a way back that only works if the old image is really still there and
 * by id. The panel's database is a test world's, and its other servers and Traefik aren't there,
 * so "does the site answer" is the container's state here, as in every unit test of a job. The same
 * move with a real answer, through a real Traefik: the last part of test/engine/siteStack.test.ts.
 *
 * Opt-in: needs Docker and the internet (wordpress.org). It needs a stack 1 image and a stack 2 one,
 * and tags and removes images of its own only.
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/siteSwitch.test.ts
 *
 * WPL7_ENGINE_SITE_IMAGE is the stack 2 image (test/engine/siteStack.test.ts leaves one), and
 * WPL7_ENGINE_OLD_SITE_IMAGE one from before stack 2.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSiteCacheRules } from '../../shared/cacheRules.js';
import { sites, type SiteRow } from '../../src/db/schema.js';
import { JobContext } from '../../src/jobs/context.js';
import { GEOLOCATE_OFF_REASON, replaceContainer } from '../../src/jobs/handlers/sites.js';
import { DockerService, type NetworkSpec, type SiteContainerSpec } from '../../src/services/docker.js';
import { siteNetworkName, EGRESS_NETWORK } from '../../src/services/siteNetwork.js';
import { SITE_ROLLBACK_REPO, siteImage, sitePaths, siteRollbackImage, siteRuntimeFrom } from '../../src/services/siteSpec.js';
import { SITE_STACK_PORT } from '../../src/services/siteStack.js';
import { WpService } from '../../src/services/wp.js';
import { makeTestConfig, makeWorld, type TestWorld } from '../helpers.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const NEW_IMAGE = process.env.WPL7_ENGINE_SITE_IMAGE ?? 'wpl7-wordpress:php8.4-engine';
const OLD_IMAGE = process.env.WPL7_ENGINE_OLD_SITE_IMAGE ?? 'wpl7-wordpress:php8.4-stack1';

const SLUG = `engineswitch${process.pid}`;
const PHP = `switch${process.pid}`;
const TAG = siteImage(PHP);
const ROLLBACK_TAG = siteRollbackImage(SLUG);
const CONTAINER = `wp-${SLUG}`;
const DATABASE = `wpl7-engine-switch-db-${process.pid}`;
const SITE_NETWORK = siteNetworkName(SLUG);
const OWN_EGRESS = `wpl7-engine-switch-egress-${process.pid}`;
const BROKEN_IMAGE = `wpl7-engine-switch-broken:${process.pid}`;
const HOST = 'switch.example.com';
const DB_PASSWORD = 'engine-db-password';
const PHP_LINE = 'php_value max_input_vars 4321';

interface Done {
  status: number;
  stdout: string;
  stderr: string;
}

function dockerCli(args: string[], input?: string): Promise<Done> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function must(args: string[], input?: string): Promise<string> {
  const done = await dockerCli(args, input);
  if (done.status !== 0) throw new Error(`docker ${args.join(' ')} failed (${done.status}): ${done.stderr}${done.stdout.slice(-2000)}`);
  return done.stdout.trim();
}

const wp = (...args: string[]) => must(['exec', '-u', '33:33', '-e', 'HOME=/tmp', '-w', '/var/www/html', CONTAINER, 'wp', ...args]);
const readInSite = (file: string) => must(['exec', CONTAINER, 'cat', file]);

/** What a page answers from inside the container, on Apache's port or nginx's. */
const pageStatus = (port: number) =>
  must(['exec', CONTAINER, 'curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Host: ${HOST}`, '-H', 'X-Forwarded-Proto: https', `http://127.0.0.1:${port}/wp-login.php`]);

/** Build an image with an id of its own from a Dockerfile, and answer that id. */
async function build(tag: string, dockerfile: string): Promise<string> {
  await must(['build', '-q', '-t', tag, '-'], dockerfile);
  return must(['image', 'inspect', '-f', '{{.Id}}', tag]);
}

/** As a pull or a rebuild moves it: the image it left may have no name any more. */
async function moveTag(id: string): Promise<void> {
  await must(['tag', id, TAG]);
}

const namesOf = async (id: string): Promise<string[] | null> => {
  const done = await dockerCli(['image', 'inspect', '-f', '{{json .RepoTags}}', id]);
  return done.status === 0 ? (JSON.parse(done.stdout) as string[]) : null;
};

/**
 * The site's networks, with the way out one of this test's own: wpl7_egress may be in use by a
 * stack on this Docker. A create that should fail can be lined up.
 */
class TestDocker extends DockerService {
  failNextCreate: string | null = null;

  override async ensureNetwork(spec: NetworkSpec) {
    if (spec.name === EGRESS_NETWORK) return { outcome: 'existing' as const, detached: [] };
    return super.ensureNetwork(spec);
  }

  override async createSiteContainer(spec: SiteContainerSpec): Promise<void> {
    if (this.failNextCreate) {
      const message = this.failNextCreate;
      this.failNextCreate = null;
      throw new Error(message);
    }
    await super.createSiteContainer({ ...spec, networks: [SITE_NETWORK, OWN_EGRESS] });
  }
}

describe.skipIf(!ENABLED)('a site moving to stack 2, on real Docker', { timeout: 600_000 }, () => {
  const docker = new TestDocker('wpl7_proxy', 'wpl7_db');
  let w: TestWorld;
  let row: SiteRow;
  let oldId: string;
  let newId: string;
  let brokenId: string;
  let root: string;

  const server = () => ({ ...w.servers.handleFor(1), docker, wp: new WpService(docker) });
  const fresh = () => w.db.select().from(sites).where(eq(sites.id, row.id)).get()!;
  const inspect = (format: string) => must(['inspect', '-f', format, CONTAINER]);

  /** What a recreate does, as the reconcile job calls it. */
  function recreate(run = true) {
    // As Retry does: a site that failed on this image otherwise stays on its old one.
    w.db.update(sites).set({ stackSwitchImage: null }).where(eq(sites.id, row.id)).run();
    const site = fresh();
    const ctx = new JobContext(w.worker.enqueue('demo', {}).id, {}, w.db);
    const domains = [HOST];
    return replaceContainer(ctx, server(), w.core, siteRuntimeFrom(w.core.settings, site), site, { site, domains }, { site, domains }, run);
  }

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-switch-')));
    const config = makeTestConfig({ SRV_ROOT: root });
    w = await makeWorld({ config });
    const now = Date.now();
    row = w.db
      .insert(sites)
      .values({
        slug: SLUG,
        title: 'Engine switch',
        serverId: 1,
        domains: JSON.stringify([HOST]),
        phpVersion: PHP,
        status: 'running',
        dbName: 'wp_engine',
        dbUser: 'wp_engine',
        dbPassword: DB_PASSWORD,
        containerName: CONTAINER,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    fs.mkdirSync(sitePaths(config, SLUG).wordpress, { recursive: true });
    fs.mkdirSync(config.paths.plugins, { recursive: true });

    // Built here so that its id is this test's alone, and nothing else keeps it alive.
    oldId = await build(TAG, `FROM ${OLD_IMAGE}\nLABEL wpl7.engine.switch="${process.pid}"\n`);
    newId = await must(['image', 'inspect', '-f', '{{.Id}}', NEW_IMAGE]);
    // Stack 2 with PHP in it, so that the migration runs, and a container from it can't start.
    brokenId = await build(BROKEN_IMAGE, `FROM ${NEW_IMAGE}\nLABEL wpl7.engine.switch="${process.pid}"\nENTRYPOINT ["/no/such/command"]\nCMD []\n`);

    await docker.ensureNetwork({ name: SITE_NETWORK, internal: true, labels: { 'wpl7.role': 'site-network', 'wpl7.site': SLUG } });
    await must(['network', 'create', '-o', 'com.docker.network.bridge.enable_icc=false', OWN_EGRESS]);
    await must(['run', '-d', '--name', DATABASE, '--network', SITE_NETWORK, '--network-alias', 'mariadb', '-e', 'MARIADB_ROOT_PASSWORD=engine-root', 'mariadb:11.4']);
    const deadline = Date.now() + 120_000;
    while ((await dockerCli(['exec', DATABASE, 'healthcheck.sh', '--connect', '--innodb_initialized'])).status !== 0) {
      if (Date.now() > deadline) throw new Error('MariaDB did not come up');
      await new Promise((r) => setTimeout(r, 500));
    }
    await must(
      ['exec', '-i', DATABASE, 'mariadb', '-uroot', '-pengine-root'],
      `CREATE DATABASE wp_engine CHARACTER SET utf8mb4; CREATE USER 'wp_engine'@'%' IDENTIFIED BY '${DB_PASSWORD}'; GRANT ALL PRIVILEGES ON wp_engine.* TO 'wp_engine'@'%';`,
    );
  }, 300_000);

  afterAll(async () => {
    await dockerCli(['exec', CONTAINER, 'find', '/var/www/html', '-mindepth', '1', '-delete']);
    await dockerCli(['rm', '-f', '-v', CONTAINER, DATABASE]);
    await dockerCli(['network', 'rm', SITE_NETWORK, OWN_EGRESS]);
    await dockerCli(['rmi', '-f', TAG, ROLLBACK_TAG, BROKEN_IMAGE]);
    await dockerCli(['rmi', '-f', oldId]);
    // A build without BuildKit leaves a nameless image for each of its steps, all with this label.
    await dockerCli(['image', 'prune', '-f', '--filter', `label=wpl7.engine.switch=${process.pid}`]);
    fs.rmSync(root, { recursive: true, force: true });
  }, 180_000);

  it('starts as a stack 1 container on an old image, with a real store on it', async () => {
    const replaced = await recreate();
    expect(replaced).toEqual({ previous: null, switched: false });
    expect(await docker.containerStack(CONTAINER)).toEqual({ imageId: oldId, stack: 1 });
    expect(await docker.imageStack(TAG)).toBe(1);
    expect(await inspect(`{{index .Config.Labels "traefik.http.services.wp-${SLUG}.loadbalancer.server.port"}}`)).toBe('80');

    const deadline = Date.now() + 120_000;
    while ((await dockerCli(['exec', CONTAINER, 'test', '-f', '/var/www/html/wp-config.php'])).status !== 0) {
      if (Date.now() > deadline) throw new Error('WordPress did not populate its files');
      await new Promise((r) => setTimeout(r, 500));
    }
    await must(['exec', CONTAINER, 'chown', '33:33', '/var/www/html']);
    await wp('core', 'install', `--url=https://${HOST}`, '--title=Switch', '--admin_user=boss', '--admin_password=engine-admin-password', '--admin_email=boss@example.com', '--skip-email');
    await wp('plugin', 'install', 'woocommerce', '--activate');
    await wp('option', 'update', 'woocommerce_default_customer_address', 'geolocation');
    // What mod_php reads and PHP-FPM can't: this is a 500 on stack 2 unless it is moved.
    await must(['exec', '-i', '-u', '33:33', CONTAINER, 'sh', '-c', 'cat >> /var/www/html/.htaccess'], `${PHP_LINE}\n`);
    await must(['exec', '-u', '33:33', CONTAINER, 'sh', '-c', 'chmod 644 /var/www/html/.htaccess']);
    expect(await pageStatus(80)).toBe('200');
  });

  it('goes back to its own image, by id, when the new one cannot start, after the tag has moved', async () => {
    await moveTag(brokenId);
    expect(await namesOf(oldId)).toEqual([]);
    expect(await docker.imageStack(TAG)).toBe(2);

    await expect(recreate()).rejects.toThrow(/^This site still runs the old PHP setup: the new container could not start: /);

    expect(await inspect('{{.State.Status}}')).toBe('running');
    expect(await inspect('{{.Image}}')).toBe(oldId);
    expect(await docker.containerStack(CONTAINER)).toEqual({ imageId: oldId, stack: 1 });
    expect(await inspect(`{{index .Config.Labels "traefik.http.services.wp-${SLUG}.loadbalancer.server.port"}}`)).toBe('80');
    // The site itself is back: Apache with mod_php, on its database, with the store's plugins.
    expect(await wp('option', 'get', 'woocommerce_default_customer_address')).toBe('geolocation');
    expect(await pageStatus(80)).toBe('200');
    expect(await must(['exec', CONTAINER, 'apache2ctl', '-M'])).toContain('php_module');
    // And so is what mod_php reads.
    expect((await readInSite('/var/www/html/.htaccess')).split('\n')).toContain(PHP_LINE);
    const row2 = fresh();
    expect(row2.stackSwitchError).toMatch(/^the new container could not start: /);
    expect(row2.stackSwitchImage).toBe(brokenId);
    // The name is off, and the image stays with the container that runs it.
    expect(await docker.imageId(ROLLBACK_TAG)).toBeNull();
    expect(await namesOf(oldId)).toEqual([]);
  });

  it('asked real WP-CLI whether this store is on plain Geolocate, in the old container', () => {
    const site = fresh();
    expect(site.pageCache).toBe('off');
    expect(parseSiteCacheRules(site.cacheRules).offReason).toBe(GEOLOCATE_OFF_REASON);
  });

  it('does not count WooCommerce that is switched off, or the other Geolocate', async () => {
    const reset = () => w.db.update(sites).set({ pageCache: null, cacheRules: null }).where(eq(sites.id, row.id)).run();
    reset();
    await wp('plugin', 'deactivate', 'woocommerce');
    await expect(recreate()).rejects.toThrow(/still runs the old PHP setup/);
    expect(fresh()).toMatchObject({ pageCache: null, cacheRules: null });

    await wp('plugin', 'activate', 'woocommerce');
    await wp('option', 'update', 'woocommerce_default_customer_address', 'geolocation_ajax');
    await expect(recreate()).rejects.toThrow(/still runs the old PHP setup/);
    expect(fresh()).toMatchObject({ pageCache: null, cacheRules: null });
  });

  it('puts a stopped site back stopped, with the name left on, because forcing it could cost the image', async () => {
    await must(['stop', '-t', '5', CONTAINER]);
    docker.failNextCreate = 'no room left';
    await expect(recreate(false)).rejects.toThrow(/still runs the old PHP setup: the new container could not be created: no room left/);

    expect(await inspect('{{.State.Status}}')).toBe('created');
    expect(await inspect('{{.Image}}')).toBe(oldId);
    expect(await docker.imageId(ROLLBACK_TAG)).toBe(oldId);
    // Where the nightly clean-up looks for such a name.
    expect(await docker.imageTags(SITE_ROLLBACK_REPO)).toContain(ROLLBACK_TAG);

    // Started, its container holds the image by itself, and the name can go.
    await docker.startContainer(CONTAINER);
    expect(await docker.untagImage(ROLLBACK_TAG)).toBe(true);
    expect(await docker.imageId(ROLLBACK_TAG)).toBeNull();
    expect(await namesOf(oldId)).toEqual([]);
    expect(await inspect('{{.State.Status}}')).toBe('running');
  });

  it('moves to the real stack 2 image, serves through nginx, and leaves nothing behind', async () => {
    await moveTag(newId);
    const replaced = await recreate();
    expect(replaced).toEqual({ previous: { imageId: oldId, stack: 1 }, switched: true });

    expect(await docker.containerStack(CONTAINER)).toEqual({ imageId: newId, stack: 2 });
    expect(await inspect(`{{index .Config.Labels "traefik.http.services.wp-${SLUG}.loadbalancer.server.port"}}`)).toBe('8080');
    expect(fresh()).toMatchObject({ stackSwitchError: null, stackSwitchImage: null });

    // Moved, where PHP-FPM reads it, and no 500 for the folder.
    expect(await readInSite('/var/www/html/.htaccess')).toContain(`# Moved to .user.ini by WPL7: ${PHP_LINE}`);
    expect(await readInSite('/var/www/html/.user.ini')).toMatch(/^max_input_vars\s*=\s*'?4321'?$/m);
    expect(await pageStatus(SITE_STACK_PORT)).toBe('200');

    // nginx in front, with this site's file and its cache on: the store is not on plain Geolocate.
    const deadline = Date.now() + 60_000;
    let headers = '';
    while (!/x-cache-status/i.test(headers)) {
      if (Date.now() > deadline) throw new Error(`nginx did not answer: ${headers}`);
      await new Promise((r) => setTimeout(r, 500));
      headers = (await dockerCli(['exec', CONTAINER, 'curl', '-sS', '-o', '/dev/null', '-D', '-', '-H', `Host: ${HOST}`, 'http://127.0.0.1:8080/'])).stdout;
    }
    expect(headers).not.toMatch(/x-cache-skipped: off/i);
    expect(await must(['exec', CONTAINER, 'cat', '/etc/wpl7-runtime/php-fpm-pool.conf'])).toContain('pm.max_children');

    // No other name, and no container: the old image went with its temporary name.
    expect(await docker.imageId(ROLLBACK_TAG)).toBeNull();
    expect(await namesOf(oldId)).toBeNull();
  });
});
