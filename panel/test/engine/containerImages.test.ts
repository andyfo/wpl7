/**
 * Container apps: their images and their containers, settled against the real Docker before
 * anything is built on them. Numbered as the plan's settle-first list. The Traefik half is
 * test/engine/containerApps.test.ts; the same image checks over SSH, on both of Docker's image
 * stores, are in test/e2e/sshTransport.ts (test/e2e/ssh-transport.sh).
 *
 * Real: Docker and dockerode; a registry (registry:2) with a login, on this Docker's own
 * localhost, the only place a daemon takes plain http from; Docker Hub's busybox, a multi-platform
 * image.
 *
 * Stand-ins:
 * - the app is the small test app (test/fixtures/container-app), which says what it sees;
 * - the archives that are not a `docker save` of their own (one with no name, one whose two places
 *   disagree) are made here with tar; the check and the rename are the panel's own
 *   (services/imageArchive.ts), and so are the platform check and the user lookup
 *   (services/appImages.ts);
 * - chown on a folder of the host runs as root in a throwaway container: the panel is root on its
 *   server, and a test runner isn't.
 *
 * Docker Desktop lets any user in a container read and write a shared folder, so what a file's
 * owner and mode keep out is checked on Linux only, where CI runs this.
 *
 * Opt-in: needs Docker, and Docker Hub for the images.
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/containerImages.test.ts
 *
 * WPL7_ENGINE_FACTS=<file> appends what the tests saw (the image store, Docker's own words) to a
 * file, one JSON line each.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerService } from '../../src/services/docker.js';
import { imageUserIds, platformRefusal } from '../../src/services/appImages.js';
import { appLabels, buildAppContainerSpec } from '../../src/services/appSpec.js';
import type { Config } from '../../src/config.js';
import { inspectArchive, renamedArchive } from '../../src/services/imageArchive.js';
import { ARCH, disagreeingArchive, imageStore, namesOf, renameArchive, unpackArchive } from '../containerAppChecks.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
/** Docker Desktop lets anyone read and write a shared folder; a Linux daemon checks the owner. */
const PERMISSIONS_HOLD = process.platform === 'linux';
const PID = process.pid;
const APP_FOLDER = fileURLToPath(new URL('../fixtures/container-app', import.meta.url));

const APP_IMAGE = `wpl7-engine-image-app:${PID}`;
const BUSYBOX = 'busybox:1.37';
const REGISTRY = `wpl7-engine-images-registry-${PID}`;
const LOGIN = { username: 'engine', password: 'engine-registry-password' };
const ENGINE_LABEL = 'wpl7.engine';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const dockerService = new DockerService('none', 'none', docker);
const root = path.join(fs.realpathSync(os.tmpdir()), `wpl7-container-images-${PID}`);

// ---------------------------------------------------------------------------
// Running things

interface Done {
  status: number;
  stdout: Buffer;
  stderr: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Something seen, for WPL7_ENGINE_FACTS. */
function fact(key: string, value: unknown): void {
  const file = process.env.WPL7_ENGINE_FACTS;
  if (file) fs.appendFileSync(file, `${JSON.stringify({ test: 'containerImages', key, value })}\n`);
}

/** Every message of a pull, a push or a load, and the error one ends with, if it does. */
function follow(stream: NodeJS.ReadableStream): Promise<{ messages: string[]; error: string | null }> {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null, output: { stream?: string; status?: string; error?: string; errorDetail?: { message?: string } }[]) => {
      if (err) return reject(err);
      const failed = output.find((o) => o.error);
      resolve({
        messages: output.map((o) => (o.stream ?? o.status ?? o.error ?? '').trim()).filter(Boolean),
        error: failed ? (failed.errorDetail?.message ?? failed.error ?? 'error') : null,
      });
    });
  });
}

/** A pull through the Engine API, as the panel's would go: with a login, and a platform, when given. */
async function pull(ref: string, opts: { authconfig?: object; platform?: string } = {}): Promise<{ messages: string[]; error: string | null }> {
  try {
    return await follow(await docker.pull(ref, { ...(opts.authconfig ? { authconfig: opts.authconfig } : {}), ...(opts.platform ? { platform: opts.platform } : {}) }));
  } catch (err) {
    return { messages: [], error: (err as Error).message };
  }
}

/** A push through the Engine API, with the login. */
async function push(ref: string, authconfig: object): Promise<{ messages: string[]; error: string | null }> {
  const stream = (await docker.getImage(ref).push({ authconfig } as never)) as unknown as NodeJS.ReadableStream;
  return follow(stream);
}

const inspectImage = (ref: string) => docker.getImage(ref).inspect();
const imageIdOf = async (ref: string) => (await inspectImage(ref).catch(() => null))?.Id ?? null;
const tagsOf = async (id: string) => (await inspectImage(id).catch(() => null))?.RepoTags ?? null;

/** Every name this daemon has. */
const serverNames = async () => namesOf(await docker.listImages());

/** A load through the Engine API, as the panel's would go: the archive streamed to POST /images/load. */
/** A load of an archive this test made itself. */
async function load(archive: string): Promise<{ messages: string[]; error: string | null }> {
  return follow((await docker.loadImage(fs.createReadStream(archive))) as unknown as NodeJS.ReadableStream);
}

/** A small image of its own: the app with a label nothing else has, so its id is new. */
async function buildMarked(tag: string, mark: string, from = APP_IMAGE): Promise<string> {
  await must(run('docker', ['build', '-q', '-t', tag, '-'], `FROM ${from}\nLABEL wpl7.engine.mark=${mark}\n`), `building ${tag}`);
  return (await imageIdOf(tag))!;
}

// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('container apps: images and containers on the real Docker', { timeout: 300_000 }, () => {
  let server: { os: string; arch: string };
  let registry = '';
  const images: string[] = [];
  const containers: string[] = [];

  beforeAll(async () => {
    fs.mkdirSync(root, { recursive: true });
    await must(dockerCli('build', '-q', '-t', APP_IMAGE, APP_FOLDER), 'the test app');
    images.push(APP_IMAGE);

    // A registry with a login. Its password file must be bcrypt, and registry:2 has no htpasswd.
    const htpasswd = await must(dockerCli('run', '--rm', '--entrypoint', 'htpasswd', 'httpd:2-alpine', '-Bbn', LOGIN.username, LOGIN.password), 'htpasswd');
    fs.mkdirSync(path.join(root, 'auth'));
    fs.writeFileSync(path.join(root, 'auth', 'htpasswd'), `${htpasswd}\n`);
    // On the daemon's own network, so that it is the daemon's localhost: Docker Desktop's daemon
    // runs in a VM, which a port published on the Mac's 127.0.0.1 is not on. Not 5000: macOS holds it.
    const port = 40_000 + (PID % 20_000);
    await must(
      dockerCli('run', '-d', '--name', REGISTRY, '--network', 'host', '-v', `${path.join(root, 'auth')}:/auth:ro`,
        '-e', `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`,
        '-e', 'REGISTRY_AUTH=htpasswd', '-e', 'REGISTRY_AUTH_HTPASSWD_REALM=engine', '-e', 'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd', 'registry:2'),
      'the registry',
    );
    containers.push(REGISTRY);
    registry = `127.0.0.1:${port}`;
    await waitFor('the registry', async () => {
      const done = await dockerCli('logs', REGISTRY);
      return `${done.stdout.toString('utf8')}${done.stderr}`.includes('listening on');
    });

    const info = await docker.info();
    server = { os: info.OSType, arch: ARCH[info.Architecture] ?? info.Architecture };
    // 10: which image store this run is on.
    fact('10. local Docker', { version: info.ServerVersion, driver: info.Driver, store: imageStore(info), os: info.OSType, architecture: info.Architecture });
  }, 300_000);

  afterAll(async () => {
    await dockerCli('rm', '-f', '-v', ...containers);
    for (const image of images) await dockerCli('rmi', '-f', image);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const login = () => ({ ...LOGIN, serveraddress: registry });

  describe('4. a registry with a login, from the Engine API', () => {
    let repo = '';

    beforeAll(async () => {
      repo = `${registry}/engine/app`;
      await buildMarked(`${repo}:stable`, 'first');
      images.push(`${repo}:stable`);
      const pushed = await push(`${repo}:stable`, login());
      expect(pushed.error).toBeNull();
      await dockerCli('rmi', `${repo}:stable`);
    });

    it('without the login the pull is refused, and nothing is pulled', async () => {
      const refused = await pull(`${repo}:stable`);
      expect(refused.error).toMatch(/no basic auth credentials|unauthorized|authentication required/i);
      fact('4. pull without the login', refused.error);
      expect(await imageIdOf(`${repo}:stable`)).toBeNull();
    });

    it('the registry answers a tag’s digest and platforms without a pull, with the login', async () => {
      const dist = (await docker.getImage(`${repo}:stable`).distribution({ authconfig: login() })) as {
        Descriptor: { mediaType: string; digest: string; size: number };
        Platforms: { os: string; architecture: string; variant?: string }[];
      };
      expect(dist.Descriptor.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(dist.Platforms.map((p) => `${p.os}/${ARCH[p.architecture] ?? p.architecture}`)).toContain(`${server.os}/${server.arch}`);
      fact('4. distribution inspect with the login', dist);
      expect(await imageIdOf(`${repo}:stable`)).toBeNull();
      const without = await docker.getImage(`${repo}:stable`).distribution().then(() => 'answered', (err: Error) => err.message);
      fact('4. distribution inspect without the login', without);
      expect(without).not.toBe('answered');
    });

    it('a pull by digest leaves the name alone; a pull by tag moves it', async () => {
      // The server pulls `stable`: the first build.
      expect((await pull(`${repo}:stable`, { authconfig: login() })).error).toBeNull();
      const firstHere = (await imageIdOf(`${repo}:stable`))!;
      // CI pushes its next build under the same tag.
      await buildMarked(`${repo}:next`, 'second');
      await must(dockerCli('tag', `${repo}:next`, `${repo}:stable`), 'the next build as stable');
      expect((await push(`${repo}:stable`, login())).error).toBeNull();
      // ...and the server is as it was: `stable` is the first build, and the next one is not here.
      await must(dockerCli('tag', firstHere, `${repo}:stable`), 'the server as it was');
      await must(dockerCli('rmi', `${repo}:next`), 'the next build gone');

      const dist = (await docker.getImage(`${repo}:stable`).distribution({ authconfig: login() })) as { Descriptor: { digest: string } };
      const byDigest = `${repo}@${dist.Descriptor.digest}`;
      expect((await pull(byDigest, { authconfig: login() })).error).toBeNull();
      expect(await imageIdOf(`${repo}:stable`), 'the tag stays on the image it had').toBe(firstHere);
      const nextHere = (await imageIdOf(byDigest))!;
      expect(nextHere).not.toBe(firstHere);
      fact('4. pulled by digest', { id: nextHere, registryDigest: dist.Descriptor.digest, tags: await tagsOf(nextHere), digests: (await inspectImage(nextHere)).RepoDigests });

      expect((await pull(`${repo}:stable`, { authconfig: login() })).error).toBeNull();
      expect(await imageIdOf(`${repo}:stable`), 'a pull by tag moves it').toBe(nextHere);
      fact('4. the first build once the tag moved', { id: firstHere, tags: await tagsOf(firstHere), stillThere: (await imageIdOf(firstHere)) !== null });
      images.push(firstHere, nextHere);
    });
  });

  describe('5. the image’s user and volumes, and the container’s hardening', () => {
    // The panel's own layout (services/appSpec.ts appPaths): data/<dir> and mounts/<name>, under the app's folder.
    const data = path.join(root, 'app5', 'data', 'data');
    const secret = path.join(root, 'app5', 'mounts', 'secret');
    const NETWORK = `wpl7-engine-images-net-${PID}`;
    const NAME = `wpl7-engine-images-app5-${PID}`;
    const alias = 'www.shop.example.com';
    /** As root on the host, which the panel is: here, a throwaway container with the folder mounted. */
    const asRoot = (dir: string, script: string) => must(dockerCli('run', '--rm', '-v', `${dir}:/x`, BUSYBOX, 'sh', '-c', script), script);
    let uid = 0;
    let gid = 0;

    /** What the app's own check says, asked inside its container (as the image's user). */
    const ask = async (name: string, p: string) => must(dockerCli('exec', name, 'wget', '-qO-', `http://127.0.0.1:80${p}`), `GET ${p}`);

    /**
     * The container as the panel makes an app's (services/appSpec.ts buildAppContainerSpec, through
     * DockerService.createSiteContainer): every capability dropped, a read-only root, the host alias.
     */
    async function startApp(name: string, opts: { env?: Record<string, string> } = {}) {
      const spec = buildAppContainerSpec(
        { paths: { sites: root } as Config['paths'], mariadb: { host: 'mariadb' } as Config['mariadb'] },
        {
          site: { slug: 'app5', containerName: name, domains: JSON.stringify(['shop.example.com']), dbName: '', dbUser: '', dbPassword: '', mailPassword: null },
          settings: {
            runAs: '',
            dropAllCaps: 1,
            readOnlyRoot: 1,
            extraHosts: JSON.stringify([{ host: alias, address: '127.0.0.1' }]),
            dataPaths: JSON.stringify([{ path: '/data', dir: 'data', fromImage: true }]),
            stopGraceSec: 20,
          },
          env: Object.entries({ APP_ALIAS: alias, ...opts.env }).map(([k, v]) => ({ name: k, value: v })),
          mounts: [{ name: 'secret', containerPath: '/mnt/secret', writable: 0 }],
          runtime: { memoryBytes: 256 * 1024 * 1024 },
          image: APP_IMAGE,
        },
      );
      expect(spec.labels).toEqual(appLabels('app5'));
      await dockerService.createSiteContainer({ ...spec, labels: { ...spec.labels, [ENGINE_LABEL]: String(PID) }, networks: [NETWORK] });
      containers.push(name);
      await dockerService.startContainer(name);
      return docker.getContainer(name);
    }

    async function startHardened(name: string, opts: { sysctls?: Record<string, string>; extraEnv?: string[]; mounts?: boolean } = {}) {
      const c = await docker.createContainer({
        name,
        Image: APP_IMAGE,
        Env: [`APP_ALIAS=${alias}`, ...(opts.extraEnv ?? [])],
        Labels: { [ENGINE_LABEL]: String(PID) },
        HostConfig: {
          Mounts:
            opts.mounts === false
              ? []
              : [
                  { Type: 'bind', Source: data, Target: '/data', ReadOnly: false },
                  { Type: 'bind', Source: secret, Target: '/mnt/secret', ReadOnly: true },
                ],
          ReadonlyRootfs: true,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          ExtraHosts: [`${alias}:127.0.0.1`],
          ...(opts.sysctls ? { Sysctls: opts.sysctls } : {}),
        },
      });
      containers.push(name);
      await c.start();
      return c;
    }

    afterAll(async () => {
      await dockerCli('rm', '-f', '-v', ...containers.filter((c) => c.startsWith(NAME)));
      await dockerCli('network', 'rm', NETWORK);
    });

    beforeAll(async () => {
      await must(dockerCli('network', 'create', '--label', `${ENGINE_LABEL}=${PID}`, NETWORK), 'its network');
      fs.mkdirSync(data, { recursive: true });
      fs.mkdirSync(secret, { recursive: true });
      fs.writeFileSync(path.join(secret, 'key.txt'), 'the signing key\n');
      // The folders as a bind starts them: owned by root, as the panel makes them.
      await asRoot(path.join(root, 'app5'), 'chown -R 0:0 /x && chmod 700 /x/mounts/secret && chmod 600 /x/mounts/secret/key.txt');
    });

    it('the image names its user, its volume and its port; inspect has a name, not a uid', async () => {
      const image = await inspectImage(APP_IMAGE);
      expect(image.Config.User).toBe('app');
      expect(image.Config.Volumes).toEqual({ '/data': {} });
      expect(image.Config.ExposedPorts).toEqual({ '80/tcp': {} });
    });

    it('the uid is in the image’s /etc/passwd, read from a container created and never started', async () => {
      const probe = await docker.createContainer({ Image: APP_IMAGE, Labels: { [ENGINE_LABEL]: String(PID) } });
      try {
        const state = (await probe.inspect()).State;
        expect(state.Status).toBe('created');
        expect(state.StartedAt).toBe('0001-01-01T00:00:00Z');
        // The panel's own lookup does the same: a container of its own, created and never started.
        const ids = await imageUserIds({ docker: dockerService }, APP_IMAGE, (await inspectImage(APP_IMAGE)).Config.User);
        expect(ids).toEqual({ uid: 10001, gid: 10001 });
        ({ uid, gid } = ids);
        // Created, the container already has an anonymous volume for the image's VOLUME.
        const mounts = (await probe.inspect()).Mounts;
        fact('5. a created container’s mounts', mounts.map((m) => ({ type: m.Type, destination: m.Destination })));
      } finally {
        await probe.remove({ v: true });
      }
    });

    it('a VOLUME with nothing mapped onto it becomes an anonymous volume', async () => {
      const c = await startHardened(`${NAME}-unmapped`, { mounts: false });
      const mounts = (await c.inspect()).Mounts;
      expect(mounts.find((m) => m.Destination === '/data')?.Type).toBe('volume');
    });

    it.skipIf(!PERMISSIONS_HOLD)('before the folders are its own, the app can neither write its data nor read its secret', async () => {
      const c = await startHardened(`${NAME}-before`);
      await waitFor('the app', async () => (await dockerCli('exec', c.id, 'wget', '-qO-', 'http://127.0.0.1/health')).status === 0, 20_000);
      expect(JSON.parse(await ask(c.id, '/write')).data).toBe('Permission denied');
      expect((await dockerCli('exec', c.id, 'wget', '-qO-', 'http://127.0.0.1/secret')).status).not.toBe(0);
    });

    it('runs as that uid, with no capability, no new privileges, a read-only root and its host alias', async () => {
      await asRoot(path.join(root, 'app5'), `chown -R ${uid}:${gid} /x/data /x/mounts`);
      const c = await startApp(NAME);
      await waitFor('the app', async () => (await dockerCli('exec', NAME, 'wget', '-qO-', 'http://127.0.0.1/health')).status === 0, 20_000);
      const who = JSON.parse(await ask(NAME, '/whoami')) as Record<string, unknown>;
      expect(who).toMatchObject({ uid: 10001, gid: 10001, capEff: '0000000000000000', noNewPrivs: '1', alias: '127.0.0.1' });
      // Port 80 as uid 10001 with no capability at all: Docker sets this sysctl to 0 itself.
      expect(who.unprivilegedPortStart).toBe('0');
      fact('5. what the app sees', who);
      expect(await ask(NAME, '/secret')).toBe('the signing key');
      expect(JSON.parse(await ask(NAME, '/write'))).toEqual({ data: true, tmp: true, root: 'Read-only file system' });
      expect(await ask(NAME, '/self')).toBe('ok');
      // Docker Desktop's file sharing shows every file as root's; a Linux daemon, the writer's.
      if (PERMISSIONS_HOLD) expect(await asRoot(data, 'stat -c %u:%g /x/note.txt')).toBe(`${uid}:${gid}`);
      // The data folder takes the VOLUME's place: no anonymous volume.
      const info = await c.inspect();
      expect(info.Mounts.map((m) => m.Type).sort()).toEqual(['bind', 'bind']);
      // A `docker stop` from a shell waits the app's grace too.
      expect((info.Config as { StopTimeout?: number }).StopTimeout).toBe(20);
      expect(info.Config.Labels['traefik.enable']).toBe('false');
    });

    it('the port is the sysctl’s: with it at 1024 the app cannot listen on 80', async () => {
      const c = await startHardened(`${NAME}-1024`, { sysctls: { 'net.ipv4.ip_unprivileged_port_start': '1024' } });
      await waitFor('it to stop', async () => !(await c.inspect()).State.Running, 20_000);
      const logs = (await dockerCli('logs', c.id)).stderr;
      expect(logs).toMatch(/Permission denied/);
    });

    it('the stop it is given decides whether its worker finishes: none, then ten seconds', async () => {
      const name = `${NAME}-drain`;
      const c = await startApp(name, { env: { APP_DRAIN_SECONDS: '2' } });
      await waitFor('the app', async () => (await dockerCli('exec', name, 'wget', '-qO-', 'http://127.0.0.1/health')).status === 0, 20_000);
      fs.rmSync(path.join(data, 'drained'), { force: true });
      // What setAside does to a site's container today.
      await dockerService.stopContainer(name, 0);
      expect(fs.existsSync(path.join(data, 'drained'))).toBe(false);
      await c.start();
      await waitFor('the app', async () => (await dockerCli('exec', name, 'wget', '-qO-', 'http://127.0.0.1/health')).status === 0, 20_000);
      const t0 = Date.now();
      await dockerService.stopContainer(name, 10);
      expect(fs.readFileSync(path.join(data, 'drained'), 'utf8')).toBe('15');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2_000);
    });
  });

  describe('6. the platform', () => {
    const other = () => (server.arch === 'amd64' ? 'arm64' : 'amd64');
    let otherDigest = '';

    beforeAll(async () => {
      expect((await pull(BUSYBOX)).error).toBeNull();
      const list = JSON.parse(await must(dockerCli('manifest', 'inspect', BUSYBOX), 'its manifest list')) as {
        manifests: { digest: string; platform: { os: string; architecture: string } }[];
      };
      otherDigest = list.manifests.find((m) => m.platform.os === 'linux' && m.platform.architecture === other())!.digest;
    }, 120_000);

    it('the server says aarch64 or x86_64, an image arm64 or amd64', async () => {
      const info = await docker.info();
      expect(['aarch64', 'x86_64']).toContain(info.Architecture);
      const app = await inspectImage(APP_IMAGE);
      expect(platformRefusal((await dockerService.imageConfig(APP_IMAGE))!, server)).toBeNull();
      expect(await dockerService.serverPlatform()).toEqual(server);
      fact('6. platform fields', { server: { OSType: info.OSType, Architecture: info.Architecture }, built: { Os: app.Os, Architecture: app.Architecture, Variant: (app as { Variant?: string }).Variant } });
    });

    it('a multi-platform image pulled for the server reads as the server’s', async () => {
      const image = await inspectImage(BUSYBOX);
      expect(platformRefusal((await dockerService.imageConfig(BUSYBOX))!, server)).toBeNull();
      fact('6. a multi-platform image, as inspect has it', { Id: image.Id, Os: image.Os, Architecture: image.Architecture, Variant: (image as { Variant?: string }).Variant, RepoDigests: image.RepoDigests });
    });

    it('the other platform’s image, pulled by its digest, reads as that platform, and the check refuses it naming both', async () => {
      const ref = `busybox@${otherDigest}`;
      const plain = await pull(ref);
      fact('6. a pull of the other platform’s manifest, no platform asked', plain.error ?? 'pulled');
      if (plain.error) expect((await pull(ref, { platform: `linux/${other()}` })).error).toBeNull();
      const image = await inspectImage(ref);
      expect(ARCH[image.Architecture]).toBe(other());
      expect(platformRefusal((await dockerService.imageConfig(ref))!, server)).toBe(
        `The image is for linux/${other()}, and this server is linux/${server.arch}. Build it for linux/${server.arch}.`,
      );
      images.push(ref);
    });

    it('the registry gives a list’s platforms before a pull, and none for a single image', async () => {
      const single = `${registry}/engine/other:1`;
      await must(dockerCli('tag', `busybox@${otherDigest}`, single), 'tagging');
      images.push(single);
      expect((await push(single, login())).error).toBeNull();
      // A single image's platform is in its config, which the registry's answer does not read: it
      // gives no platform at all. Only a list says what it holds before a pull.
      const one = (await docker.getImage(single).distribution({ authconfig: login() })) as { Descriptor: { mediaType: string }; Platforms: { os: string; architecture: string }[] | null };
      expect(one.Platforms ?? []).toEqual([]);
      const list = (await docker.getImage(BUSYBOX).distribution()) as { Descriptor: { mediaType: string }; Platforms: { os: string; architecture: string }[] };
      const all = list.Platforms.map((p) => `${p.os}/${p.architecture}`);
      expect(all).toContain(`linux/${server.arch}`);
      expect(all).toContain(`linux/${other()}`);
      fact('6. distribution inspect', { single: one, list: { mediaType: list.Descriptor.mediaType, platforms: all } });
    });

    it('a tag whose list has no image for the server: the registry says so before a pull, and the pull fails', async () => {
      // An index with only the other platform's image in it, put into the registry by the API, from
      // the daemon's own network, where the registry is.
      const single = (await docker.getImage(`${registry}/engine/other:1`).distribution({ authconfig: login() })) as { Descriptor: { mediaType: string; digest: string; size: number } };
      const index = {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [{ ...single.Descriptor, platform: { os: 'linux', architecture: other() } }],
      };
      const put = String.raw`
import base64, sys, urllib.request
req = urllib.request.Request(sys.argv[1], data=sys.argv[2].encode(), method='PUT')
req.add_header('Content-Type', 'application/vnd.oci.image.index.v1+json')
req.add_header('Authorization', 'Basic ' + base64.b64encode(sys.argv[3].encode()).decode())
print(urllib.request.urlopen(req).status)
`;
      await must(
        dockerCli('run', '--rm', '--network', 'host', '--entrypoint', 'python', APP_IMAGE, '-c', put,
          `http://${registry}/v2/engine/other/manifests/index`, JSON.stringify(index), `${LOGIN.username}:${LOGIN.password}`),
        'putting the index',
      );
      const dist = (await docker.getImage(`${registry}/engine/other:index`).distribution({ authconfig: login() })) as { Platforms: { os: string; architecture: string }[] };
      expect(dist.Platforms.map((p) => `${p.os}/${p.architecture}`)).toEqual([`linux/${other()}`]);
      const refused = await pull(`${registry}/engine/other:index`, { authconfig: login() });
      fact('6. a pull of a list without the server’s platform', refused.error ?? 'pulled');
      expect(refused.error).toMatch(/no matching manifest/);
    });
  });

  describe('9. the names an archive carries', () => {
    const VICTIM = `wpl7-engine-victim:${PID}`;
    const UPLOAD = `wpl7-engine-upload:${PID}`;
    let victimId = '';
    let uploadId = '';
    let archive = '';

    beforeAll(async () => {
      victimId = await buildMarked(VICTIM, 'victim');
      uploadId = await buildMarked(UPLOAD, 'upload');
      images.push(VICTIM, UPLOAD, victimId, uploadId);
      // An upload whose archive carries the name of something this server already has.
      archive = path.join(root, 'named.tar');
      await must(dockerCli('tag', uploadId, VICTIM), 'naming it');
      await must(dockerCli('save', '-o', archive, VICTIM), 'saving it');
      await must(dockerCli('tag', victimId, VICTIM), 'the name back');
      expect(await imageIdOf(VICTIM)).toBe(victimId);
    });

    it('the names are in the archive, in up to three places, before it is loaded', async () => {
      const u = await unpackArchive(archive);
      fact('9. an archive’s files', u.files);
      fact('9. the names in it', { manifest: u.manifest?.map((m) => m.RepoTags), index: u.index?.manifests.map((m) => m.annotations), repositories: u.repositories });
      const info = await inspectArchive(archive);
      expect({ images: info.images, names: info.names, problem: info.problem }).toEqual({ images: 1, names: [VICTIM], problem: null });
    });

    it('docker load gives the name to the archive’s image, without a refusal', async () => {
      const loaded = await load(archive);
      expect(loaded.error).toBeNull();
      fact('9. what a load says when it takes a name', loaded.messages);
      expect(await imageIdOf(VICTIM)).toBe(uploadId);
      fact('9. the image that lost its name', { id: victimId, tags: await tagsOf(victimId), stillThere: (await imageIdOf(victimId)) !== null });
      await must(dockerCli('tag', victimId, VICTIM), 'the name back');
    });

    it('the check finds the clash before the load, and an archive of two images is refused', async () => {
      const { names } = await inspectArchive(archive);
      const taken = await serverNames();
      expect(names.filter((n) => taken.has(n))).toEqual([VICTIM]);
      const two = path.join(root, 'two.tar');
      await must(dockerCli('save', '-o', two, VICTIM, UPLOAD), 'saving two');
      const both = await inspectArchive(two);
      expect(both.images).toBe(2);
      expect(both.problem).toBe('The archive holds 2 images; upload one at a time.');
    });

    it('renamed inside the archive, only the panel’s own name lands', async () => {
      const own = `wpl7-app-engine${PID}:upload-1`;
      // The panel's own rename, streamed into the panel's own load.
      const { loaded } = await dockerService.loadImage(renamedArchive(archive, await inspectArchive(archive), own));
      expect(loaded).toEqual([own]);
      fact('9. what a load of the renamed archive says', loaded);
      images.push(own);
      expect(await imageIdOf(VICTIM)).toBe(victimId);
      expect(await imageIdOf(own)).toBe(uploadId);
    });

    it('with no name at all: what a load makes of it', async () => {
      await dockerCli('rmi', UPLOAD);
      const bare = path.join(root, 'bare.tar');
      await renameArchive(await unpackArchive(archive), null, bare);
      const loaded = await load(bare);
      fact('9. a load of an archive with no name', { error: loaded.error, messages: loaded.messages, tags: await tagsOf(uploadId) });
      expect(await imageIdOf(VICTIM)).toBe(victimId);
    });

    it('when the two places disagree, which one a load goes by', async () => {
      const a = `wpl7-engine-manifest:${PID}`;
      const b = `wpl7-engine-index:${PID}`;
      const mixed = path.join(root, 'mixed.tar');
      await disagreeingArchive(await unpackArchive(archive), a, b, mixed);
      const loaded = await load(mixed);
      images.push(a, b);
      const byManifest = (await imageIdOf(a)) !== null;
      const byIndex = (await imageIdOf(b)) !== null;
      fact('9. two places that disagree', { messages: loaded.messages, error: loaded.error, byManifest, byIndex });
      expect(byManifest || byIndex).toBe(true);
    });
  });
});
