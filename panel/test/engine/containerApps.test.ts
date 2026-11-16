/**
 * Container apps: what Traefik and Docker do with them, settled against the real thing before
 * anything is built on it. Numbered as the plan's settle-first list.
 *
 * Real: Traefik, started from the flag list of deploy/docker-compose.yml itself (test/composeFile.ts)
 * and its image; Docker and dockerode; the panel's own labels for a site (buildSiteContainerSpec),
 * its own protection file (buildSiteSecurityConfig), block list (buildBlockedFile) and move file
 * (proxyConfigYaml); an ACME server, Pebble, that issues real certificates over HTTP-01.
 *
 * Stand-ins, all of them:
 * - the WordPress and PHP sites run a small test app (test/fixtures/container-app) under the panel's
 *   own labels: what Traefik routes is decided by the labels and the files, not by what answers;
 * - the app's routes file is written by this test, in the form the plan proposes: nothing in the
 *   panel writes one yet;
 * - Traefik gets flags the compose file does not have, none of which routes anything: a
 *   constraint, so that it sees only this test's containers; Pebble as the CA of `letsencrypt`;
 *   `accesslog.addinternals`, so that the access log names the redirect and the ACME challenge too,
 *   which a server's leaves out; and, for the run that shows what the plan changes, the redirect's
 *   priority;
 * - Pebble's DNS (pebble-challtestsrv) answers every name with Traefik's address.
 *
 * Opt-in: needs Docker and Docker Hub and ghcr.io for the images.
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/containerApps.test.ts
 *
 * WPL7_ENGINE_KEEP=1 leaves everything running at the end, and prints what to remove.
 * WPL7_ENGINE_FACTS=<file> appends what the tests measured (timings, Docker's own words) to a file,
 * one JSON line each.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { CidrSet, parseCidr } from '../../shared/cidr.js';
import { MAX_CUSTOM_RULES, effectivePolicy } from '../../shared/security.js';
import { proxyConfigYaml } from '../../src/jobs/handlers/moveHelpers.js';
import { DockerService } from '../../src/services/docker.js';
import { BLOCKED_FILE, buildBlockedFile } from '../../src/services/firewallRender.js';
import { RANGE_SOURCES } from '../../src/services/proxyRanges.js';
import {
  PRIORITY,
  buildSiteSecurityConfig,
  bypassList,
  renderDynamicFile,
  securityFileName,
  type DynamicConfig,
} from '../../src/services/securityConfig.js';
import { siteNetworkName } from '../../src/services/siteNetwork.js';
import { appLogLines } from '../../src/services/appSpec.js';
import { askApp, healthGate } from '../../src/services/appProbe.js';
import { MOUNT_UNPACK_LOCKDOWN, mountEntryProblem, mountListScript, mountUnpackScript, zipListNames } from '../../src/jobs/handlers/apps.js';
import { buildSiteContainerSpec } from '../../src/services/siteSpec.js';
import { interpolate, traefikFlags, traefikImage, traefikList } from '../composeFile.js';
import { makeTestConfig, zipOf } from '../helpers.js';
import { route as simRoute } from '../traefikSim.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const KEEP = process.env.WPL7_ENGINE_KEEP === '1';
const PID = process.pid;
const APP_FOLDER = fileURLToPath(new URL('../fixtures/container-app', import.meta.url));

const APP_IMAGE = `wpl7-engine-app:${PID}`;
const TRAEFIK_IMAGE = traefikImage();
const PEBBLE_IMAGE = 'ghcr.io/letsencrypt/pebble:latest';
const CHALLTESTSRV_IMAGE = 'ghcr.io/letsencrypt/pebble-challtestsrv:latest';

const EDGE = `wpl7-engine-apps-edge-${PID}`;
const EDGE_TODAY = `wpl7-engine-apps-today-${PID}`;
const PEBBLE = `wpl7-engine-apps-pebble-${PID}`;
const PEBBLE_DNS = `wpl7-engine-apps-dns-${PID}`;
const ACME_NET = `wpl7-engine-apps-acme-${PID}`;
const ENGINE_LABEL = 'wpl7.engine';

/** The redirect flag the plan adds to deploy/docker-compose.yml. */
const REDIRECT_PRIORITY = '--entrypoints.web.http.redirections.entrypoint.priority=1';

/** A WordPress site and a PHP site, as the panel labels them, and the app that routes into the first. */
const SHOP = `shop${PID}`;
const SHOP_HOSTS = ['shop.example.com', 'www.shop.example.com'];
const BLOG = `blog${PID}`;
const BLOG_HOSTS = ['blog.example.com'];
const APP = `app${PID}`;
const APP_HOST = 'app.example.net';
const container = (slug: string) => `wp-${slug}`;

/**
 * Where an app's routes would sit: above every router of a site's protection file (the highest is
 * PRIORITY.allow plus one per custom rule) and below the block list.
 */
const APP_ROUTE_PRIORITY = 950_000;

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const dockerService = new DockerService('none', 'none', docker);
const root = path.join(fs.realpathSync(os.tmpdir()), `wpl7-container-apps-${PID}`);
/** Each Traefik's SRV_ROOT, where the compose file's volumes put its ACME storage and its rules folder. */
const srvRoot = (edge: string) => path.join(root, `srv-${edge}`);
const dynamicDir = (edge: string) => path.join(srvRoot(edge), 'traefik', 'dynamic');

// ---------------------------------------------------------------------------
// Running things

interface Done {
  status: number;
  stdout: Buffer;
  stderr: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Something measured, for WPL7_ENGINE_FACTS. */
function fact(key: string, value: unknown): void {
  const file = process.env.WPL7_ENGINE_FACTS;
  if (file) fs.appendFileSync(file, `${JSON.stringify({ test: 'containerApps', key, value })}\n`);
}

function run(command: string, args: string[], input?: string | Buffer): Promise<Done> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
    if (input !== undefined) child.stdin!.end(input);
  });
}

const dockerCli = (...args: string[]) => run('docker', args);

async function must(done: Done | Promise<Done>, what: string): Promise<string> {
  const result = await done;
  if (result.status !== 0) throw new Error(`${what} failed (${result.status}): ${result.stderr}${result.stdout.toString('utf8').slice(-2000)}`);
  return result.stdout.toString('utf8').trim();
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000, everyMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Waited ${timeoutMs} ms for ${what}`);
    await sleep(everyMs);
  }
}

/** A file as the panel writes one into traefik/dynamic: whole, by a rename, so Traefik never reads half of it. */
function writeDynamic(edge: string, name: string, content: string): void {
  const file = path.join(dynamicDir(edge), name);
  fs.writeFileSync(`${file}.tmp`, content);
  fs.renameSync(`${file}.tmp`, file);
}

function removeDynamic(edge: string, name: string): void {
  fs.rmSync(path.join(dynamicDir(edge), name), { force: true });
}

// ---------------------------------------------------------------------------
// Traefik, as deploy/docker-compose.yml starts it

interface Edge {
  name: string;
  http: number;
  https: number;
}

/** What .env would give the compose file for one of these Traefiks. */
const composeEnv = (edge: string) => ({ ACME_EMAIL: 'engine@example.com', SRV_ROOT: srvRoot(edge) });

/** The compose file's flags, with .env's values for what they interpolate. */
function composeFlags(edge: string): string[] {
  return traefikFlags('docker-compose.yml').map((flag) => interpolate(flag, composeEnv(edge)));
}

/** The compose file's volumes and environment for Traefik, as `docker run` arguments. */
function composeRunArgs(edge: string): string[] {
  const env = composeEnv(edge);
  const volumes = traefikList('docker-compose.yml', 'volumes').map((v) => interpolate(v, env));
  const environment = traefikList('docker-compose.yml', 'environment').map((line) => {
    const colon = line.indexOf(':');
    return `${line.slice(0, colon).trim()}=${interpolate(line.slice(colon + 1).trim(), env)}`;
  });
  return [...volumes.flatMap((v) => ['-v', v]), ...environment.flatMap((e) => ['-e', e]), '--security-opt', 'no-new-privileges:true'];
}

/** What the compose file has of the redirect's priority: nothing yet, or the plan's 1. */
function withoutRedirectPriority(flags: string[]): string[] {
  const priority = flags.filter((f) => f.startsWith('--entrypoints.web.http.redirections.entrypoint.priority'));
  expect(priority.length === 0 || (priority.length === 1 && priority[0] === REDIRECT_PRIORITY), String(priority)).toBe(true);
  return flags.filter((f) => !priority.includes(f));
}

async function startEdge(name: string, opts: { redirectPriority: boolean; caServer: string; network: string; caFile?: string }): Promise<Edge> {
  fs.mkdirSync(dynamicDir(name), { recursive: true });
  const flags = [
    ...withoutRedirectPriority(composeFlags(name)),
    ...(opts.redirectPriority ? [REDIRECT_PRIORITY] : []),
    // Test-only, see the header: none of these routes anything.
    `--providers.docker.constraints=Label(\`${ENGINE_LABEL}\`,\`${PID}\`)`,
    `--certificatesresolvers.letsencrypt.acme.caserver=${opts.caServer}`,
    '--accesslog.addinternals=true',
  ];
  await must(
    dockerCli(
      'run', '-d', '--name', name, '--network', opts.network,
      '-p', '127.0.0.1::80', '-p', '127.0.0.1::443',
      ...composeRunArgs(name),
      ...(opts.caFile ? ['-v', `${opts.caFile}:/pebble/ca.pem:ro`, '-e', 'LEGO_CA_CERTIFICATES=/pebble/ca.pem'] : []),
      TRAEFIK_IMAGE, ...flags,
    ),
    `Traefik ${name}`,
  );
  const port = async (p: string) => Number((await must(dockerCli('port', name, p), 'its port')).split('\n')[0]!.split(':').pop());
  return { name, http: await port('80/tcp'), https: await port('443/tcp') };
}

interface Answer {
  status: number;
  headers: Map<string, string>;
  body: string;
  /** The User-Agent it was sent with: how its line in the access log is found. */
  agent: string;
}

let asked = 0;

/** A request the way a visitor makes it, to `url`'s host and scheme, at this Traefik. */
async function visit(edge: Edge, url: string, opts: { method?: string; maxTime?: number } = {}): Promise<Answer> {
  const u = new URL(url);
  const https = u.protocol === 'https:';
  const agent = `wpl7-engine/${PID}/${++asked}`;
  const args = ['-sS', '-i', '--http1.1', '-k', '--path-as-is', '--max-time', String(opts.maxTime ?? 20), '-A', agent];
  args.push('--connect-to', `${u.hostname}:${https ? 443 : 80}:127.0.0.1:${https ? edge.https : edge.http}`);
  if (opts.method) args.push('-X', opts.method);
  args.push(url);
  const done = await run('curl', args);
  if (done.status !== 0) throw new Error(`curl ${url} failed (${done.status}): ${done.stderr}`);
  const raw = done.stdout.toString('utf8');
  const end = raw.indexOf('\r\n\r\n');
  const lines = raw.slice(0, end).split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) headers.set(line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim());
  return { status: Number(/^HTTP\/[\d.]+ (\d+)/.exec(lines[0] ?? '')?.[1] ?? 0), headers, body: raw.slice(end + 4), agent };
}

/** What the test app says it is, or null when something else answered. */
const appOf = (answer: Answer): string | null => {
  try {
    return (JSON.parse(answer.body) as { app?: string }).app ?? null;
  } catch {
    return null;
  }
};

/** The router Traefik's access log names for a request. */
async function routerOf(edge: Edge, answer: Answer): Promise<string> {
  let found: string | undefined;
  await waitFor(`the access log line of ${answer.agent}`, async () => {
    const done = await dockerCli('logs', edge.name);
    for (const line of done.stdout.toString('utf8').split('\n')) {
      if (!line.startsWith('{') || !line.includes(answer.agent)) continue;
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry['request_User-Agent'] === answer.agent) found = String(entry.RouterName ?? '');
    }
    return found !== undefined;
  }, 10_000, 200);
  return found!;
}

/** The issuer of the certificate Traefik shows for a host. */
function issuerOf(edge: Edge, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: edge.https, servername: host, rejectUnauthorized: false }, () => {
      const issuer = socket.getPeerCertificate().issuer?.CN ?? '';
      socket.end();
      resolve(Array.isArray(issuer) ? issuer.join(',') : issuer);
    });
    socket.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// The sites, the app, and their files

/** A container of the test app, with the labels and networks given. */
async function startApp(name: string, opts: { labels?: Record<string, string>; networks: string[]; env?: Record<string, string> }): Promise<void> {
  const c = await docker.createContainer({
    name,
    Image: APP_IMAGE,
    Env: Object.entries({ APP_NAME: name, ...opts.env }).map(([k, v]) => `${k}=${v}`),
    Labels: { [ENGINE_LABEL]: String(PID), ...opts.labels },
    HostConfig: { Tmpfs: { '/data': 'rw,size=1m,uid=10001' } },
    NetworkingConfig: { EndpointsConfig: { [opts.networks[0]!]: {} } },
  });
  for (const net of opts.networks.slice(1)) await docker.getNetwork(net).connect({ Container: c.id });
  await c.start();
}

/** Made in beforeAll, so that a run with the test switched off leaves nothing behind. */
let config: Config;

/** The labels the panel gives a site's container, on stack 2. */
function siteLabels(slug: string, app: 'wordpress' | 'php', domains: string[]): Record<string, string> {
  const site = { slug, app, phpVersion: '8.4', dbName: `wp_${slug}`, dbUser: `wp_${slug}`, dbPassword: 'x', containerName: container(slug), tablePrefix: 'wp_' };
  const spec = buildSiteContainerSpec(config, site, domains, { devDomain: 'dev.example.net', wildcardProvider: '' }, { memoryBytes: 256 * 1024 * 1024 }, { stack: 2 });
  return spec.labels;
}

/** A site's protection file as the panel writes it, at the level most sites have. */
function siteProtection(slug: string, app: 'wordpress' | 'php', domains: string[]): DynamicConfig {
  return buildSiteSecurityConfig({
    slug,
    app,
    domains,
    policy: effectivePolicy({ level: 'standard', overrides: {} }, { level: null, overrides: {}, customRules: [] }, app),
    tlsMode: 'letsencrypt',
    proxies: [{ name: 'cloudflare', header: 'Cf-Connecting-Ip', ranges: new CidrSet(RANGE_SOURCES.cloudflare.builtin) }],
    bypass: bypassList({ fleet: ['203.0.113.10'], neverBlock: [], bypassPrivate: false }),
    fleet: ['203.0.113.10'],
    jetpack: RANGE_SOURCES.jetpack.builtin,
  })!;
}

interface AppRoute {
  /** Its number among the app's routes: the router's name carries it. */
  n: number;
  host: string;
  path?: { match: 'prefix' | 'exact'; value: string };
  scheme: 'https' | 'http' | 'both';
}

/**
 * The plan's routes file for an app: a router per route and scheme, named so no slug can be read
 * into it, all sharing one service that reaches the container by its name on the site's network.
 * `held` keeps every router and gives the service no server: what a deploy does while the new
 * container is not yet through its check.
 */
function appRoutes(slug: string, port: number, routes: AppRoute[], opts: { held?: boolean } = {}): DynamicConfig & { http: { services: object } } {
  const service = `wpl7app_svc_${slug}`;
  const routers: DynamicConfig['http']['routers'] = {};
  for (const r of routes) {
    const host = `Host(\`${r.host}\`)`;
    const rule = r.path ? `${host} && ${r.path.match === 'exact' ? 'Path' : 'PathPrefix'}(\`${r.path.value}\`)` : host;
    if (r.scheme !== 'http') {
      routers[`wpl7app_r${r.n}_${slug}`] = { rule, priority: APP_ROUTE_PRIORITY, entryPoints: ['websecure'], service, tls: { certResolver: 'letsencrypt' } as never };
    }
    if (r.scheme !== 'https') {
      routers[`wpl7app_r${r.n}h_${slug}`] = { rule, priority: APP_ROUTE_PRIORITY, entryPoints: ['web'], service };
    }
  }
  // No empty section: Traefik refuses a whole file with one ("middlewares cannot be a standalone element").
  return {
    http: {
      routers,
      services: { [service]: { loadBalancer: { servers: opts.held ? [] : [{ url: `http://${container(slug)}:${port}` }] } } },
    },
  } as DynamicConfig & { http: { services: object } };
}

const appFile = (slug: string) => `app-${slug}.yml`;

/** JSON is YAML too: the panel's emitter knows only the keys its own files use, and this file is the plan's. */
const writeAppRoutes = (edge: string, slug: string, routes: AppRoute[], opts: { held?: boolean } = {}) =>
  writeDynamic(edge, appFile(slug), `${JSON.stringify(appRoutes(slug, 80, routes, opts), null, 2)}\n`);

const startedAt = async (name: string) => (await docker.getContainer(name).inspect()).State.StartedAt;

/** The requests a container of the test app has had. */
async function requestsTo(name: string): Promise<string[]> {
  const done = await dockerCli('logs', name);
  return done.stdout.toString('utf8').split('\n').filter((line) => line.startsWith('request '));
}

// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('container apps against the real Traefik and Docker', { timeout: 300_000 }, () => {
  let edge: Edge;
  let today: Edge;
  const networks = [SHOP, BLOG, APP].map(siteNetworkName);

  beforeAll(async () => {
    fs.mkdirSync(root, { recursive: true });
    config = makeTestConfig({ TLS_MODE: 'letsencrypt', ACME_RESOLVER: 'letsencrypt', DEV_DOMAIN: 'dev.example.net', SRV_ROOT: path.join(root, 'panel') });
    await must(dockerCli('build', '-q', '-t', APP_IMAGE, APP_FOLDER), 'the test app');
    await must(dockerCli('network', 'create', ACME_NET), 'the ACME network');
    for (const net of networks) await must(dockerCli('network', 'create', '--internal', '--label', `${ENGINE_LABEL}=${PID}`, net), net);

    // Pebble's own TLS certificate is for the name `pebble`, signed by a CA in its image.
    const caFile = path.join(root, 'pebble-ca.pem');
    const probe = await must(dockerCli('create', PEBBLE_IMAGE), 'reading Pebble');
    fs.writeFileSync(caFile, await must(run('sh', ['-c', 'docker cp "$1":/test/certs/pebble.minica.pem - | tar -xO', 'sh', probe]), 'its CA'));
    await dockerCli('rm', probe);

    edge = await startEdge(EDGE, { redirectPriority: true, caServer: 'https://pebble:14000/dir', network: ACME_NET, caFile });
    // The same, as the compose file has it today; its CA is nowhere, so it never asks one.
    today = await startEdge(EDGE_TODAY, { redirectPriority: false, caServer: 'https://127.0.0.1:1/dir', network: 'bridge' });
    for (const net of networks) {
      await must(dockerCli('network', 'connect', net, EDGE), `Traefik on ${net}`);
      await must(dockerCli('network', 'connect', net, EDGE_TODAY), `Traefik on ${net}`);
    }

    const edgeIp = await must(dockerCli('inspect', '-f', `{{(index .NetworkSettings.Networks "${ACME_NET}").IPAddress}}`, EDGE), 'its address');
    await must(
      dockerCli('run', '-d', '--name', PEBBLE_DNS, '--network', ACME_NET, CHALLTESTSRV_IMAGE,
        '-defaultIPv4', edgeIp, '-defaultIPv6', '', '-http01', '', '-https01', '', '-tlsalpn01', '', '-doh', ''),
      'Pebble’s DNS',
    );
    const pebbleConfig = path.join(root, 'pebble.json');
    fs.writeFileSync(pebbleConfig, JSON.stringify({
      pebble: {
        listenAddress: '0.0.0.0:14000',
        managementListenAddress: '0.0.0.0:15000',
        certificate: 'test/certs/localhost/cert.pem',
        privateKey: 'test/certs/localhost/key.pem',
        httpPort: 80,
        tlsPort: 443,
        ocspResponderURL: '',
        externalAccountBindingRequired: false,
      },
    }));
    await must(
      dockerCli('run', '-d', '--name', PEBBLE, '--network', ACME_NET, '--network-alias', 'pebble',
        '-e', 'PEBBLE_VA_NOSLEEP=1', '-e', 'PEBBLE_WFE_NONCEREJECT=0', '-v', `${pebbleConfig}:/pebble.json:ro`,
        PEBBLE_IMAGE, '-config', '/pebble.json', '-strict=false', '-dnsserver', `${PEBBLE_DNS}:8053`),
      'Pebble',
    );
    await waitFor('Pebble', async () => (await dockerCli('logs', PEBBLE)).stdout.toString('utf8').includes('ACME directory available'), 30_000);

    // A WordPress site and a PHP site, each with the panel's labels and protection file, and an app.
    await startApp(container(SHOP), { labels: siteLabels(SHOP, 'wordpress', SHOP_HOSTS), networks: [siteNetworkName(SHOP)], env: { APP_PORT: '8080' } });
    await startApp(container(BLOG), { labels: siteLabels(BLOG, 'php', BLOG_HOSTS), networks: [siteNetworkName(BLOG)], env: { APP_PORT: '8080' } });
    await startApp(container(APP), { labels: { 'traefik.enable': 'false' }, networks: [siteNetworkName(APP)] });
    for (const e of [EDGE, EDGE_TODAY]) {
      writeDynamic(e, securityFileName(SHOP), renderDynamicFile(siteProtection(SHOP, 'wordpress', SHOP_HOSTS)));
      writeDynamic(e, securityFileName(BLOG), renderDynamicFile(siteProtection(BLOG, 'php', BLOG_HOSTS)));
    }
  }, 300_000);

  afterAll(async () => {
    const containers = [EDGE, EDGE_TODAY, PEBBLE, PEBBLE_DNS, ...[SHOP, BLOG, APP].map(container), ...extraContainers];
    if (KEEP) {
      console.log(`Kept. Remove with:\n  docker rm -f ${containers.join(' ')}\n  docker network rm ${[...networks, ACME_NET].join(' ')}\n  docker rmi ${APP_IMAGE}\n  rm -rf ${root}`);
      return;
    }
    await dockerCli('rm', '-f', '-v', ...containers);
    await dockerCli('network', 'rm', ...networks, ACME_NET);
    await dockerCli('rmi', '-f', APP_IMAGE, ...extraImages);
    // A Linux daemon keeps the owners containers gave files (uid 10001's 0700 folders): give them back first.
    if (process.platform === 'linux' && fs.existsSync(root)) {
      await dockerCli('run', '--rm', '-v', `${root}:/x`, 'busybox:1.37', 'chown', '-R', `${process.getuid!()}:${process.getgid!()}`, '/x');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** What a test made beyond the above, removed at the end. */
  const extraContainers: string[] = [];
  const extraImages: string[] = [];

  describe('1. plain http beside the redirect', () => {
    const routes: AppRoute[] = [{ n: 1, host: APP_HOST, scheme: 'both' }];

    beforeAll(() => {
      for (const e of [EDGE, EDGE_TODAY]) writeAppRoutes(e, APP, routes);
    });

    it('today, no router on web answers: the redirect does, an app’s http router too', async () => {
      await waitFor('Traefik today to route the app over https', async () => appOf(await visit(today, `https://${APP_HOST}/`)) === container(APP));
      const plain = await visit(today, `http://${APP_HOST}/x`);
      expect(plain.status).toBe(301);
      expect(plain.headers.get('location')).toBe(`https://${APP_HOST}/x`);
      expect(await routerOf(today, plain)).toBe('web-to-websecure@internal');
    });

    it('with the redirect at priority 1, the app’s http router answers plain http', async () => {
      await waitFor('Traefik to route the app over http', async () => appOf(await visit(edge, `http://${APP_HOST}/x`)) === container(APP));
      const plain = await visit(edge, `http://${APP_HOST}/x`);
      expect(plain.status).toBe(200);
      expect(await routerOf(edge, plain)).toBe(`wpl7app_r1h_${APP}@file`);
    });

    it('every other request on port 80 still redirects: a WordPress site, a PHP site, a host nobody has', async () => {
      await waitFor('the sites over https', async () => appOf(await visit(edge, `https://${SHOP_HOSTS[0]}/`)) === container(SHOP) && appOf(await visit(edge, `https://${BLOG_HOSTS[0]}/`)) === container(BLOG));
      for (const url of [`http://${SHOP_HOSTS[0]}/`, `http://${SHOP_HOSTS[1]}/wp-login.php`, `http://${BLOG_HOSTS[0]}/index.php?x=1`, 'http://nobody.example.org/']) {
        const plain = await visit(edge, url);
        const u = new URL(url);
        expect(plain.status, url).toBe(301);
        expect(plain.headers.get('location'), url).toBe(`https://${u.host}${u.pathname}${u.search}`);
        expect(await routerOf(edge, plain), url).toBe('web-to-websecure@internal');
      }
    });

    it('a request that is not GET is redirected with 308, which keeps its method', async () => {
      const post = await visit(edge, `http://${SHOP_HOSTS[0]}/wp-login.php`, { method: 'POST' });
      expect(post.status).toBe(308);
    });

    it('the ACME challenge still goes to Traefik, on a host with an http route for every path too', async () => {
      for (const host of [APP_HOST, SHOP_HOSTS[0]]) {
        const challenge = await visit(edge, `http://${host}/.well-known/acme-challenge/not-a-token`);
        expect(await routerOf(edge, challenge), host).toBe('acme-http@internal');
      }
    });

    it('and HTTP-01 passes end to end: Pebble issues the certificates', async () => {
      for (const host of [APP_HOST, ...SHOP_HOSTS, ...BLOG_HOSTS]) {
        await waitFor(`a certificate for ${host}`, async () => (await issuerOf(edge, host)).startsWith('Pebble Intermediate CA'), 120_000, 1000);
      }
    });

    it('nothing the panel writes sits on web: protection, block list, move forwarding', async () => {
      const blocked = buildBlockedFile({
        blocks: [{ cidr: parseCidr('198.51.100.7/32')!, expiresAt: null, createdAt: 1 }],
        proxies: [],
        direct: true,
        panelHost: 'panel.example.net',
        tlsMode: 'letsencrypt',
      }).config!;
      // The new server is an address where nothing listens: Traefik's answer is a quick 502.
      const nowhere = await must(dockerCli('inspect', '-f', `{{(index .NetworkSettings.Networks "${ACME_NET}").IPAddress}}`, PEBBLE_DNS), 'an address');
      const move = proxyConfigYaml({ slug: 'moving', hosts: ['moving.example.org'], targetIp: nowhere, tlsMode: 'letsencrypt', acmeResolver: 'letsencrypt' });
      for (const file of [siteProtection(SHOP, 'wordpress', SHOP_HOSTS), siteProtection(BLOG, 'php', BLOG_HOSTS), blocked]) {
        for (const [name, router] of Object.entries(file.http.routers)) expect(router.entryPoints, name).toEqual(['websecure']);
      }
      expect(move).toContain('entryPoints: [websecure]');
      expect(move).not.toMatch(/entryPoints: \[[^\]]*\bweb\b/);
      writeDynamic(EDGE, BLOCKED_FILE, renderDynamicFile(blocked));
      writeDynamic(EDGE, 'move-moving.yml', move);
      await waitFor('the move file', async () => (await visit(edge, 'https://moving.example.org/')).status === 502);
      for (const url of ['http://moving.example.org/', `http://${SHOP_HOSTS[0]}/`]) {
        const plain = await visit(edge, url);
        expect(plain.status, url).toBe(301);
      }
      removeDynamic(EDGE, 'move-moving.yml');
    });
  });

  describe('2. a path route on another site’s domain', () => {
    const SHARED: AppRoute[] = [
      { n: 1, host: APP_HOST, scheme: 'both' },
      { n: 2, host: SHOP_HOSTS[0]!, path: { match: 'prefix', value: '/api/' }, scheme: 'https' },
      { n: 3, host: SHOP_HOSTS[0]!, path: { match: 'prefix', value: '/plain/' }, scheme: 'both' },
      { n: 4, host: SHOP_HOSTS[0]!, path: { match: 'exact', value: '/wp-login.php' }, scheme: 'https' },
    ];

    beforeAll(() => writeAppRoutes(EDGE, APP, SHARED));

    /** The site's own routers and the app's, for the simulator: what it says has to be what Traefik does. */
    const merged = (): DynamicConfig => {
      const protection = siteProtection(SHOP, 'wordpress', SHOP_HOSTS);
      const app = appRoutes(APP, 80, SHARED);
      const https = Object.fromEntries(Object.entries(app.http.routers).filter(([, r]) => r.entryPoints.includes('websecure')));
      return { http: { routers: { ...protection.http.routers, ...https }, middlewares: protection.http.middlewares } };
    };

    it('sits above every router of a site’s protection file and below the block list', () => {
      const protection = Object.values(siteProtection(SHOP, 'wordpress', SHOP_HOSTS).http.routers).map((r) => r.priority);
      expect(Math.max(...protection)).toBeLessThan(PRIORITY.allow + MAX_CUSTOM_RULES + 1);
      expect(APP_ROUTE_PRIORITY).toBeGreaterThan(PRIORITY.allow + MAX_CUSTOM_RULES);
      expect(APP_ROUTE_PRIORITY).toBeLessThan(PRIORITY.blocked);
    });

    it('wins over the site’s own router and every router of its protection file, over https', async () => {
      await waitFor('the app’s routes on the shop', async () => appOf(await visit(edge, `https://${SHOP_HOSTS[0]}/api/x`)) === container(APP));
      const cases: [string, string | undefined, string, string][] = [
        // path, method, who answers, the router the simulator expects (without its provider)
        ['/api/orders', undefined, container(APP), `wpl7app_r2_${APP}`],
        ['/api/.env', undefined, container(APP), `wpl7app_r2_${APP}`],
        ['/plain/x', undefined, container(APP), `wpl7app_r3_${APP}`],
        ['/wp-login.php', 'POST', container(APP), `wpl7app_r4_${APP}`],
        ['/', undefined, container(SHOP), `wpl7sec_main_${SHOP}`],
        ['/apix', undefined, container(SHOP), `wpl7sec_main_${SHOP}`],
        ['/wp-login.php/other', 'POST', container(SHOP), `wpl7sec_login_${SHOP}`],
      ];
      for (const [p, method, who, simRouter] of cases) {
        const answer = await visit(edge, `https://${SHOP_HOSTS[0]}${p}`, { method });
        expect(appOf(answer), p).toBe(who);
        const router = await routerOf(edge, answer);
        expect(router.replace(/@file$/, ''), p).toBe(simRouter);
        const sim = simRoute(merged(), { host: SHOP_HOSTS[0]!, path: p, method: method ?? 'GET', peer: '198.51.100.200' }, SHOP_HOSTS, SHOP);
        expect(sim.router, `simulator, ${p}`).toBe(simRouter);
      }
      // The protection's refusal of a dot file still holds for the site's own paths.
      const env = await visit(edge, `https://${SHOP_HOSTS[0]}/.env`);
      expect(env.status).toBe(403);
      expect(await routerOf(edge, env)).toBe(`wpl7sec_deny-files_${SHOP}@file`);
    });

    it('over plain http only where a route says so; the rest of the domain redirects', async () => {
      const plain = await visit(edge, `http://${SHOP_HOSTS[0]}/plain/x`);
      expect(appOf(plain)).toBe(container(APP));
      for (const p of ['/api/orders', '/', '/wp-login.php']) {
        const other = await visit(edge, `http://${SHOP_HOSTS[0]}${p}`);
        expect(other.status, p).toBe(301);
      }
    });

    it('stays below the block list over https, and the block list has nothing on web', async () => {
      // This test's requests come from Docker's gateway: block exactly that address.
      const answer = await visit(edge, `https://${SHOP_HOSTS[0]}/api/who`);
      const peer = await clientOf(edge, answer);
      const blocked = buildBlockedFile({
        blocks: [{ cidr: parseCidr(`${peer}/32`)!, expiresAt: null, createdAt: 1 }],
        proxies: [],
        direct: true,
        panelHost: 'panel.example.net',
        tlsMode: 'letsencrypt',
      }).config!;
      writeDynamic(EDGE, BLOCKED_FILE, renderDynamicFile(blocked));
      try {
        await waitFor('the block', async () => (await visit(edge, `https://${SHOP_HOSTS[0]}/api/who`)).status === 403);
        const refused = await visit(edge, `https://${SHOP_HOSTS[0]}/api/who`);
        expect(await routerOf(edge, refused)).toBe('wpl7blk_direct@file');
        // ...and on port 80 the app's http route still answers the blocked address: the gap the plan closes.
        const plain = await visit(edge, `http://${SHOP_HOSTS[0]}/plain/x`);
        expect(appOf(plain)).toBe(container(APP));
        // A twin of the block list on web, at the same priority, closes it.
        const twin = structuredClone(blocked);
        for (const [name, r] of Object.entries(blocked.http.routers)) {
          const { tls: _tls, ...plain } = r;
          twin.http.routers[`${name}-web`] = { ...plain, entryPoints: ['web'] };
        }
        writeDynamic(EDGE, BLOCKED_FILE, renderDynamicFile(twin));
        await waitFor('the web twin', async () => (await visit(edge, `http://${SHOP_HOSTS[0]}/plain/x`)).status === 403);
        // A blocked address gets the refusal on port 80 now, for a site's host too, instead of the redirect.
        expect((await visit(edge, `http://${SHOP_HOSTS[0]}/`)).status).toBe(403);
      } finally {
        removeDynamic(EDGE, BLOCKED_FILE);
      }
      await waitFor('the block gone', async () => (await visit(edge, `https://${SHOP_HOSTS[0]}/api/who`)).status === 200);
    });
  });

  describe('3. an image’s labels become its container’s', () => {
    const LABELLED_IMAGE = `wpl7-engine-labelled:${PID}`;
    const LABELLED = `wpl7-engine-apps-labelled-${PID}`;

    beforeAll(async () => {
      // An image that claims the shop's domain for itself, and says it is a site's container.
      const dockerfile = [
        `FROM ${APP_IMAGE}`,
        'LABEL traefik.enable="true"',
        `LABEL traefik.docker.network="${siteNetworkName(APP)}"`,
        `LABEL traefik.http.routers.taken.rule="Host(\`${SHOP_HOSTS[0]}\`)"`,
        'LABEL traefik.http.routers.taken.priority="999999"',
        'LABEL traefik.http.routers.taken.entrypoints="websecure"',
        'LABEL traefik.http.routers.taken.tls="true"',
        'LABEL traefik.http.services.taken.loadbalancer.server.port="80"',
        `LABEL wpl7.managed="true" wpl7.role="wordpress" wpl7.site="${SHOP}" wpl7.stack="2"`,
      ].join('\n');
      await must(run('docker', ['build', '-q', '-t', LABELLED_IMAGE, '-'], `${dockerfile}\n`), 'the labelled image');
      extraImages.push(LABELLED_IMAGE);
      extraContainers.push(LABELLED);
    });

    const startLabelled = async (labels: Record<string, string>) => {
      const c = await docker.createContainer({
        name: LABELLED,
        Image: LABELLED_IMAGE,
        Env: [`APP_NAME=${LABELLED}`],
        Labels: { [ENGINE_LABEL]: String(PID), ...labels },
        NetworkingConfig: { EndpointsConfig: { [siteNetworkName(APP)]: {} } },
      });
      await c.start();
      return c;
    };

    it('a container made with no Traefik labels has the image’s, and Traefik routes another site’s domain to it', async () => {
      const c = await startLabelled({});
      const labels = (await c.inspect()).Config.Labels;
      expect(labels['traefik.http.routers.taken.rule']).toBe(`Host(\`${SHOP_HOSTS[0]}\`)`);
      expect(labels['wpl7.role']).toBe('wordpress');
      await waitFor('the image’s router', async () => appOf(await visit(edge, `https://${SHOP_HOSTS[0]}/`)) === LABELLED);
      // ...and the panel's sweeps, which find site containers by their labels, would count it as the shop's.
      const managed = await dockerService.listManaged(['wpl7.role=wordpress', `wpl7.site=${SHOP}`]);
      expect(managed.map((m) => m.name).sort()).toEqual([container(SHOP), LABELLED].sort());
      // For a moment after the container goes, Traefik still sends to its address, where nothing
      // answers: the request hangs instead of failing.
      await c.remove({ force: true });
      const t0 = Date.now();
      const gone = await visit(edge, `https://${SHOP_HOSTS[0]}/`, { maxTime: 3 }).then((a) => `${a.status}`, (err: Error) => err.message);
      fact('3. a request right after the labelled container went', { answer: gone, ms: Date.now() - t0 });
      await waitFor('the shop back', async () => appOf(await visit(edge, `https://${SHOP_HOSTS[0]}/`, { maxTime: 3 }).catch(() => ({ body: '' }) as Answer)) === container(SHOP));
    });

    it('a label on the container wins over the image’s: traefik.enable=false takes its routers away', async () => {
      const c = await startLabelled({ 'traefik.enable': 'false' });
      const labels = (await c.inspect()).Config.Labels;
      expect(labels['traefik.enable']).toBe('false');
      expect(labels['traefik.http.routers.taken.rule']).toBeDefined();
      for (let i = 0; i < 5; i++) {
        expect(appOf(await visit(edge, `https://${SHOP_HOSTS[0]}/`))).toBe(container(SHOP));
        await sleep(400);
      }
      await c.remove({ force: true });
    });
  });

  describe('7. routes in a file', () => {
    const ROUTES: AppRoute[] = [
      { n: 1, host: 'files.example.net', path: { match: 'prefix', value: '/a/' }, scheme: 'https' },
      { n: 2, host: 'files.example.net', path: { match: 'prefix', value: '/b/' }, scheme: 'https' },
    ];
    const FILES = `files${PID}`;

    beforeAll(async () => {
      await must(dockerCli('network', 'create', '--internal', '--label', `${ENGINE_LABEL}=${PID}`, siteNetworkName(FILES)), 'its network');
      networks.push(siteNetworkName(FILES));
      await must(dockerCli('network', 'connect', siteNetworkName(FILES), EDGE), 'Traefik on it');
      await must(dockerCli('network', 'connect', siteNetworkName(FILES), EDGE_TODAY), 'Traefik today on it');
      extraContainers.push(container(FILES));
    });

    it('a new container gets no request before its routes are written', async () => {
      await startApp(container(FILES), { labels: { 'traefik.enable': 'false' }, networks: [siteNetworkName(FILES)] });
      await waitFor('the app to listen', async () => (await dockerCli('logs', container(FILES))).stdout.toString('utf8').includes('listening'));
      for (let i = 0; i < 5; i++) expect((await visit(edge, 'https://files.example.net/a/x')).status).toBe(404);
      expect(await requestsTo(container(FILES))).toEqual([]);
      writeAppRoutes(EDGE, FILES, ROUTES);
      await waitFor('its routes', async () => appOf(await visit(edge, 'https://files.example.net/a/x')) === container(FILES));
      expect((await requestsTo(container(FILES))).length).toBeGreaterThan(0);
    });

    it('a route switched off and on changes what answers, and the container is not restarted', async () => {
      const before = await startedAt(container(FILES));
      writeAppRoutes(EDGE, FILES, ROUTES.filter((r) => r.n !== 2));
      await waitFor('route 2 off', async () => (await visit(edge, 'https://files.example.net/b/x')).status === 404);
      expect(appOf(await visit(edge, 'https://files.example.net/a/x'))).toBe(container(FILES));
      writeAppRoutes(EDGE, FILES, ROUTES);
      await waitFor('route 2 on', async () => appOf(await visit(edge, 'https://files.example.net/b/x')) === container(FILES));
      expect(await startedAt(container(FILES))).toBe(before);
    });

    it('held: every router stays, the service has no server, and Traefik answers 503 itself', async () => {
      writeAppRoutes(EDGE, FILES, ROUTES, { held: true });
      await waitFor('the routes held', async () => (await visit(edge, 'https://files.example.net/a/x')).status === 503);
      const count = (await requestsTo(container(FILES))).length;
      const held = await visit(edge, 'https://files.example.net/b/x');
      expect(held.status).toBe(503);
      expect(await routerOf(edge, held)).toBe(`wpl7app_r2_${FILES}@file`);
      expect((await requestsTo(container(FILES))).length).toBe(count);
      writeAppRoutes(EDGE, FILES, ROUTES);
      await waitFor('the routes back', async () => appOf(await visit(edge, 'https://files.example.net/a/x')) === container(FILES));
    });

    it('the service follows the container’s name: a replaced container is reached without a new file', async () => {
      const old = container(FILES);
      await must(dockerCli('rename', old, `${old}.previous`), 'set aside');
      await must(dockerCli('stop', '-t', '0', `${old}.previous`), 'stopped');
      extraContainers.push(`${old}.previous`);
      const gone = await visit(edge, 'https://files.example.net/a/x');
      expect([502, 503]).toContain(gone.status);
      await startApp(old, { labels: { 'traefik.enable': 'false' }, networks: [siteNetworkName(FILES)], env: { APP_NAME: 'the next one' } });
      await waitFor('the next container', async () => appOf(await visit(edge, 'https://files.example.net/a/x')) === 'the next one', 30_000);
    });

    it('the Docker provider gives a container with a service and no router a router of its own, on both ports', async () => {
      const name = `wpl7-engine-apps-default-${PID}`;
      extraContainers.push(name);
      await startApp(name, {
        labels: { 'traefik.enable': 'true', 'traefik.docker.network': siteNetworkName(FILES), [`traefik.http.services.${name}.loadbalancer.server.port`]: '80' },
        networks: [siteNetworkName(FILES)],
      });
      // Host(<the container's name>), with no TLS: plain http on port 80, where it beats the
      // redirect at priority 1, and plain http on port 443 as well.
      await waitFor('its default router', async () => appOf(await visit(edge, `http://${name}/`)) === name);
      const plain = await visit(edge, `http://${name}/`);
      expect(await routerOf(edge, plain)).toBe(`${name}@docker`);
      const onTlsPort = await run('curl', ['-sS', '-i', '--max-time', '10', '-H', `Host: ${name}`, `http://127.0.0.1:${edge.https}/`]);
      expect(onTlsPort.stdout.toString('utf8'), onTlsPort.stderr).toContain(`"app": "${name}"`);
      expect((await visit(edge, `https://${name}/`)).status).toBe(404);
      // Today the redirect hides it on port 80; port 443 answers plain http either way.
      const plainOn = async (e: Edge) =>
        (await run('curl', ['-sS', '-i', '--max-time', '10', '-H', `Host: ${name}`, `http://127.0.0.1:${e.https}/`])).stdout.toString('utf8');
      await waitFor('its default router today', async () => (await plainOn(today)).includes(`"app": "${name}"`), 30_000);
      expect((await visit(today, `http://${name}/`)).status).toBe(301);
      fact('7. default router, plain http on port 443, today', (await plainOn(today)).split('\r\n')[0]);
    });

    it('with traefik.enable=false and the service in the file, nothing of the app answers unasked', async () => {
      const name = container(FILES);
      for (const url of [`http://${name}/`, `https://${name}/`]) {
        const answer = await visit(edge, url);
        expect(appOf(answer), url).toBeNull();
      }
      const onTlsPort = await run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', '-H', `Host: ${name}`, `http://127.0.0.1:${edge.https}/`]);
      expect(onTlsPort.stdout.toString('utf8')).toBe('404');
      expect((await visit(edge, `http://${name}/`)).status).toBe(301);
      expect((await visit(edge, `https://${name}/`)).status).toBe(404);
    });
  });

  describe('8. the health gate’s way in', () => {
    const GATE = `gate${PID}`;
    const wget = (url: string, host: string) => ['wget', '-q', '-S', '-T', '5', '-O', '-', '--header', `Host: ${host}`, url];

    beforeAll(async () => {
      await must(dockerCli('network', 'create', '--internal', '--label', `${ENGINE_LABEL}=${PID}`, siteNetworkName(GATE)), 'its network');
      networks.push(siteNetworkName(GATE));
      await must(dockerCli('network', 'connect', siteNetworkName(GATE), EDGE), 'Traefik on it');
      extraContainers.push(container(GATE));
      // Every route off: no file at all.
      await startApp(container(GATE), { labels: { 'traefik.enable': 'false' }, networks: [siteNetworkName(GATE)] });
      await waitFor('the app to listen', async () => (await dockerCli('logs', container(GATE))).stdout.toString('utf8').includes('listening'));
    });

    it('from inside Traefik, which is on every site’s network: busybox wget, with the app’s Host', async () => {
      const ok = await dockerService.exec(EDGE, wget(`http://${container(GATE)}:80/health`, 'gate.example.net'));
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toBe('ok');
      expect(ok.stderr).toMatch(/HTTP\/1\.[01] 200 OK/);
      const who = await dockerService.exec(EDGE, wget(`http://${container(GATE)}:80/whatever`, 'gate.example.net'));
      expect(JSON.parse(who.stdout)).toMatchObject({ host: 'gate.example.net', path: '/whatever' });
      const failing = await dockerService.exec(EDGE, wget(`http://${container(GATE)}:80/fail`, 'gate.example.net'));
      expect(failing.exitCode).toBe(1);
      expect(failing.stderr).toMatch(/HTTP\/1\.[01] 500/);
    });

    it('from a short-lived container of Traefik’s image on the site’s network alone, with nothing else', async () => {
      const t0 = Date.now();
      const ok = await dockerService.runEphemeral({
        image: TRAEFIK_IMAGE,
        entrypoint: ['wget'],
        cmd: wget(`http://${container(GATE)}:80/health`, 'gate.example.net').slice(1),
        networks: [siteNetworkName(GATE)],
        timeoutMs: 30_000,
      });
      const took = Date.now() - t0;
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toBe('ok');
      fact('8. one check from a short-lived container, ms', took);
    });

    /** The panel's own way in (services/appProbe.ts): Traefik's image, locked down, on the app's network alone. */
    const server = () => ({
      name: 'engine',
      docker: Object.assign(Object.create(dockerService) as DockerService, { containerImage: async () => TRAEFIK_IMAGE }),
    });
    const app = { slug: GATE, containerName: container(GATE), domains: JSON.stringify(['gate.example.net']) };

    it('the panel’s own way in: no capability, a read-only root, the app’s network alone, and the first status line', async () => {
      const t0 = Date.now();
      expect(await askApp(server(), app, { port: 80, path: '/health', host: 'gate.example.net', timeoutSec: 5 })).toEqual({ status: 200, detail: '200 OK' });
      fact('8. the panel’s way in, one question, ms', Date.now() - t0);
      expect((await askApp(server(), app, { port: 80, path: '/fail', host: 'gate.example.net', timeoutSec: 5 })).status).toBe(500);
      const gate = { healthPath: '/health', healthHost: '', healthTimeoutSec: 20, deployCheckPath: '/whatever' };
      expect(await healthGate(server(), app, gate, [80], { deployCheck: true })).toEqual({ port: 80, failed: null });
      expect((await healthGate(server(), app, { ...gate, deployCheckPath: '/fail' }, [80], { deployCheck: true })).failed).toMatch(/^The deploy check \/fail answered 500/);
      // A port nothing listens on first, as a staged one the app does not take: refused at once, and the next one answers.
      expect(await healthGate(server(), app, gate, [8080, 80], { deployCheck: true })).toEqual({ port: 80, failed: null });
      // It ran locked down: Docker removed it, and it left nothing behind.
      const left = await dockerCli('ps', '-aq', '--filter', `label=wpl7.probe=${GATE}`);
      expect(left.stdout.toString('utf8').trim()).toBe('');
    });

    it('the log with Docker’s timestamps, as the app’s Logs tab reads it', async () => {
      const raw = await dockerService.containerLogs(container(GATE), { tail: 20, timestamps: true });
      const lines = appLogLines(raw);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(l.ts))).toBe(true);
      expect(lines.some((l) => l.text.includes('listening'))).toBe(true);
      fact('8. a log line with timestamps', raw.split('\n')[0]);
      // From the last line on: nothing new.
      expect(appLogLines(raw, lines.at(-1)!.ts)).toEqual([]);
    });

    it('a stopped container is a quick failure, not a hang', async () => {
      await must(dockerCli('stop', '-t', '0', container(GATE)), 'stopped');
      const t0 = Date.now();
      const down = await dockerService.exec(EDGE, wget(`http://${container(GATE)}:80/health`, 'gate.example.net'));
      expect(down.exitCode).not.toBe(0);
      expect(Date.now() - t0).toBeLessThan(6_000);
      fact('8. a stopped app, from inside Traefik', { exitCode: down.exitCode, stderr: down.stderr.trim(), ms: Date.now() - t0 });
      const panelWay = await askApp(server(), app, { port: 80, path: '/health', host: 'gate.example.net', timeoutSec: 5 });
      expect(panelWay.status).toBeNull();
      fact('8. a stopped app, the panel’s way in', panelWay.detail);
      await must(dockerCli('start', container(GATE)), 'started again');
    });

    it('how long each way takes, five times', async () => {
      const times = { exec: [] as number[], helper: [] as number[] };
      for (let i = 0; i < 5; i++) {
        let t0 = Date.now();
        await waitFor('the app', async () => (await dockerService.exec(EDGE, wget(`http://${container(GATE)}:80/health`, 'gate.example.net'))).exitCode === 0, 10_000, 100);
        times.exec.push(Date.now() - t0);
        t0 = Date.now();
        await dockerService.runEphemeral({ image: TRAEFIK_IMAGE, entrypoint: ['wget'], cmd: wget(`http://${container(GATE)}:80/health`, 'gate.example.net').slice(1), networks: [siteNetworkName(GATE)], timeoutMs: 30_000 });
        times.helper.push(Date.now() - t0);
      }
      fact('8. five checks, ms', times);
    });
  });

  describe('11. a mount filled from an archive, by busybox in Traefik’s image', () => {
    const dir = path.join(root, 'unpack');
    /** As the job runs it (jobs/handlers/apps.ts): the archive read-only, a fresh folder, as the app's user, locked down. */
    const unpack = (archive: string, out: string, script: string) =>
      dockerService.runEphemeral({
        image: TRAEFIK_IMAGE,
        entrypoint: ['sh', '-c'],
        cmd: [script],
        user: '10001:10001',
        binds: [`${archive}:/in/archive:ro`, `${out}:/out`],
        labels: { [ENGINE_LABEL]: String(PID) },
        timeoutMs: 60_000,
        lockdown: MOUNT_UNPACK_LOCKDOWN,
      });
    // As the panel makes it (files.mkdirp with the app's owner, 0700): root does that, in a
    // throwaway container. A Linux daemon keeps owners, so the unpacker, as the app's user, may
    // chmod only a folder of its own, and the runner reads what it made only as root.
    const asRoot = (out: string, script: string) => must(dockerCli('run', '--rm', '-v', `${out}:/x`, 'busybox:1.37', 'sh', '-c', script), script);
    const fresh = async (name: string) => {
      const out = path.join(dir, name);
      fs.mkdirSync(out, { recursive: true });
      await asRoot(out, 'chown 10001:10001 /x && chmod 700 /x');
      return out;
    };
    /** An archive as the upload leaves it on the app's server (routes/apps.ts): root's, 0600. */
    const uploaded = async (name: string) => {
      const file = path.join(dir, `uploaded-${name}`);
      fs.copyFileSync(path.join(dir, name), file);
      await asRoot(file, 'chown 0:0 /x && chmod 600 /x');
      return file;
    };
    /** As the job hands it over before the listing: the app's user's, still 0600. */
    const handOver = (file: string) => asRoot(file, 'chown 10001:10001 /x');

    beforeAll(() => {
      const src = path.join(dir, 'src');
      fs.mkdirSync(path.join(src, 'css'), { recursive: true });
      fs.writeFileSync(path.join(src, 'logo.txt'), 'logo');
      fs.writeFileSync(path.join(src, 'css', 'site.css'), 'body{}');
      execFileSync('tar', ['-C', src, '-czf', path.join(dir, 'good.tar.gz'), '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      fs.symlinkSync('/etc/passwd', path.join(src, 'link'));
      execFileSync('tar', ['-C', src, '-czf', path.join(dir, 'link.tar.gz'), '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      fs.writeFileSync(path.join(dir, 'good.zip'), zipOf({ 'logo.txt': 'logo', 'css/site.css': 'body{}' }));
    });

    it('lists a .tar.gz’s names and unpacks it, folders 0700 and files 0600, once the archive is the app’s user’s', async () => {
      const archive = await uploaded('good.tar.gz');
      // The app's user, with no capability, cannot open it as the upload left it.
      const refused = await unpack(archive, await fresh('r1'), mountListScript('tar.gz'));
      fact('11. a root 0600 archive, listed as the app’s user', { exitCode: refused.exitCode, stderr: refused.stderr.trim() });
      // Docker Desktop's file sharing shows every mode and owner as it likes; a Linux daemon, as they are.
      if (process.platform === 'linux') {
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain('Permission denied');
      }
      await handOver(archive);
      const listed = await unpack(archive, await fresh('l1'), mountListScript('tar.gz'));
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(listed.stdout.split('\n').filter(Boolean).sort()).toEqual(['./', './css/', './css/site.css', './logo.txt']);
      expect(listed.stdout.split('\n').filter(Boolean).map(mountEntryProblem)).toEqual([null, null, null, null]);
      const out = await fresh('t1');
      const done = await unpack(archive, out, mountUnpackScript('tar.gz'));
      expect(done.exitCode, done.stderr).toBe(0);
      expect(await asRoot(out, 'cat /x/css/site.css')).toBe('body{}');
      // Docker Desktop's file sharing shows every mode and owner as it likes; a Linux daemon, as they are.
      if (process.platform === 'linux') {
        expect(await asRoot(out, 'stat -c "%a %u" /x/logo.txt /x/css')).toBe('600 10001\n700 10001');
      }
    });

    it('lists a .zip’s names as unzip -l prints them, and unpacks it, once the archive is the app’s user’s', async () => {
      const archive = await uploaded('good.zip');
      const refused = await unpack(archive, await fresh('r2'), mountListScript('zip'));
      fact('11. a root 0600 .zip, listed as the app’s user', { exitCode: refused.exitCode, stderr: refused.stderr.trim() });
      if (process.platform === 'linux') expect(refused.exitCode).not.toBe(0);
      await handOver(archive);
      const listed = await unpack(archive, await fresh('l2'), mountListScript('zip'));
      expect(listed.exitCode, listed.stderr).toBe(0);
      fact('11. unzip -l, as busybox prints it', listed.stdout);
      expect(zipListNames(listed.stdout).sort()).toEqual(['css/site.css', 'logo.txt']);
      const out = await fresh('z1');
      const done = await unpack(archive, out, mountUnpackScript('zip'));
      expect(done.exitCode, done.stderr).toBe(0);
      expect(await asRoot(out, 'cat /x/logo.txt')).toBe('logo');
    });

    it('refuses an archive with a link in it, after unpacking it where it reaches nothing', async () => {
      const archive = await uploaded('link.tar.gz');
      await handOver(archive);
      const out = await fresh('k1');
      const done = await unpack(archive, out, mountUnpackScript('tar.gz'));
      expect(done.exitCode).toBe(3);
      expect(done.stderr).toContain('links or special files: link');
    });
  });
});

/** The client address Traefik saw for a request (ClientHost in the access log). */
async function clientOf(edge: Edge, answer: Answer): Promise<string> {
  let found: string | undefined;
  await waitFor(`the access log line of ${answer.agent}`, async () => {
    const done = await dockerCli('logs', edge.name);
    for (const line of done.stdout.toString('utf8').split('\n')) {
      if (!line.startsWith('{') || !line.includes(answer.agent)) continue;
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry['request_User-Agent'] === answer.agent) found = String(entry.ClientHost ?? '');
    }
    return found !== undefined;
  }, 10_000, 200);
  return found!;
}

