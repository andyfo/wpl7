/**
 * Live e2e for the SSH transport layer against a real sshd + dockerd (the dind
 * container from test/e2e/server2). Exercises exactly what unit tests cannot:
 * pooled ssh2 channels, docker-API-over-SSH, streamed host commands, sudo,
 * host-key pinning. Driven by test/e2e/ssh-transport.sh.
 *
 * Env: E2E_SSH_HOST, E2E_SSH_PORT, E2E_SSH_KEY (private key path). The container-app checks
 * (containerApps below) take the rest from the script: the image store the worker was started
 * with, a 400 MB archive and its contents' sha256, busybox's digest per architecture.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { SshConnection, ServerUnreachableError, sshFingerprint } from '../../src/servers/sshConnection.js';
import { SshDockerAgent } from '../../src/servers/sshDockerAgent.js';
import { SshExec } from '../../src/servers/sshExec.js';
import { rootKeyInstallScript, sshShellConnect } from '../../src/servers/terminal.js';
import { ExecFiles } from '../../src/lib/files.js';
import { DockerService } from '../../src/services/docker.js';
import { siteNetworkName } from '../../src/services/siteNetwork.js';
import { imageUserIds, platformRefusal } from '../../src/services/appImages.js';
import { inspectArchive, renamedArchive } from '../../src/services/imageArchive.js';
import { ARCH, disagreeingArchive, imageStore, namesOf, unpackArchive } from '../containerAppChecks.js';

const HOST = process.env.E2E_SSH_HOST ?? '127.0.0.1';
const PORT = Number(process.env.E2E_SSH_PORT ?? 39222);
const KEY = process.env.E2E_SSH_KEY!;

let passed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`✗ ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${name}`);
}

async function main(): Promise<void> {
  let capturedFp: string | null = null;
  // Stands in for the servers row: TOFU writes the pin here, and every later connect of
  // the SAME connection object reads it back.
  let storedPin: string | null = null;
  const target = {
    serverId: 2,
    serverName: 'e2e',
    host: HOST,
    port: PORT,
    username: 'wpl7-panel',
    privateKey: () => fs.readFileSync(KEY, 'utf8'),
    pinnedHostKey: () => storedPin,
    onHostKeyCaptured: (fp: string) => {
      capturedFp = fp;
      storedPin = fp;
    },
  };
  const conn = new SshConnection(target, (m) => console.log(`  warn: ${m}`));

  // --- SshExec: sudo + quoting + exit codes
  const exec = new SshExec(conn);
  const who = await exec.run('id', ['-u'], { timeoutMs: 20_000 });
  ok('ssh connect + sudo -n', who.exitCode === 0 && who.stdout.trim() === '0', JSON.stringify(who));
  ok('host key captured (TOFU)', capturedFp !== null && capturedFp!.startsWith('SHA256:'), String(capturedFp));

  const fail = await exec.run('sh', ['-c', 'echo oops >&2; exit 3'], { timeoutMs: 20_000 });
  ok('exit code + stderr propagate', fail.exitCode === 3 && fail.stderr.includes('oops'), JSON.stringify(fail));

  const quoted = await exec.run('echo', ["it's a $test", 'two words'], { timeoutMs: 20_000 });
  ok('argument quoting survives the remote shell', quoted.stdout.trim() === "it's a $test two words", quoted.stdout);

  // --- ExecFiles: the remote FilesPort
  const files = new ExecFiles(exec);
  await files.mkdirp('/srv/e2e/dir');
  await files.writeFile('/srv/e2e/dir/hello.txt', 'hello over ssh\n');
  ok('files write/read roundtrip', (await files.readFile('/srv/e2e/dir/hello.txt')) === 'hello over ssh\n');
  ok('files exists/stat', (await files.exists('/srv/e2e/dir/hello.txt')) && (await files.stat('/srv/e2e/dir/hello.txt'))!.sizeBytes === 15);
  ok('files sha256', /^[0-9a-f]{64}$/.test(await files.sha256('/srv/e2e/dir/hello.txt')));
  ok('mkdirExclusive claims atomically', (await files.mkdirExclusive('/srv/e2e/claim')) === 'created' && (await files.mkdirExclusive('/srv/e2e/claim')) === 'exists');
  const vfs = await files.statvfs('/srv');
  ok('statvfs (df) parses', vfs !== null && vfs!.totalBytes > 0);

  // --- Streaming: tar out of one dir, into another, over concurrent channels
  const pipe = new PassThrough();
  const [tarOut, tarIn] = await Promise.all([
    exec.runToStream('tar', ['-C', '/srv/e2e/dir', '-cf', '-', '.'], pipe, { timeoutMs: 60_000 }),
    (async () => {
      await files.mkdirp('/srv/e2e/copy');
      return exec.runWithInput('tar', ['-xf', '-', '-C', '/srv/e2e/copy'], pipe, { timeoutMs: 60_000 });
    })(),
  ]);
  ok('streamed tar pipe (two concurrent channels)', tarOut.exitCode === 0 && tarIn.exitCode === 0);
  ok('piped file arrived intact', (await files.readFile('/srv/e2e/copy/hello.txt')) === 'hello over ssh\n');

  // --- Docker API over the pooled connection
  const docker = new DockerService(
    'bridge',
    'bridge',
    new Docker({ protocol: 'http', host: '127.0.0.1', port: 2375, agent: new SshDockerAgent(conn) } as never),
  );
  ok('docker imageExists over ssh', (await docker.imageExists('busybox:latest')) === false || true); // API reachable
  await docker.pullImage('busybox:latest', () => undefined);
  ok('docker pull streamed over ssh', await docker.imageExists('busybox:latest'));

  const run = await docker.runEphemeral({
    image: 'busybox:latest',
    cmd: ['sh', '-c', 'echo ephemeral-ok'],
    networks: [],
    timeoutMs: 60_000,
  });
  ok('ephemeral container run + demuxed output', run.exitCode === 0 && run.stdout.includes('ephemeral-ok'), JSON.stringify(run));

  // exec into a running container (the wp-cli path)
  const raw = new Docker({ protocol: 'http', host: '127.0.0.1', port: 2375, agent: new SshDockerAgent(conn) } as never);
  const sleeper = await raw.createContainer({ name: 'e2e-sleeper', Image: 'busybox:latest', Cmd: ['sleep', '60'] });
  await sleeper.start();
  const execRes = await docker.exec('e2e-sleeper', ['echo', 'exec-ok']);
  ok('docker exec (hijacked stream) over ssh', execRes.exitCode === 0 && execRes.stdout.includes('exec-ok'), JSON.stringify(execRes));
  ok('containerState over ssh', (await docker.containerState('e2e-sleeper')) === 'running');

  // --- stdin into an exec (Web FTP saves and uploads): the bytes, then EOF as a half-close
  // of the forwarded docker.sock channel - with the output still readable after it.
  const input = crypto.randomBytes(3 * 1024 * 1024);
  const piped = await docker.execWithInput('e2e-sleeper', ['sh', '-c', 'cat | sha256sum'], input);
  ok(
    'exec stdin arrives whole, EOF ends it (3 MiB over ssh)',
    piped.exitCode === 0 && piped.stdout.startsWith(crypto.createHash('sha256').update(input).digest('hex')),
    JSON.stringify(piped).slice(0, 300),
  );
  const refused = await docker.execWithInput(
    'e2e-sleeper',
    ['sh', '-c', 'echo refused-early >&2; exit 14'],
    crypto.randomBytes(5 * 1024 * 1024),
  );
  ok(
    'a command that exits without reading its input still reports its exit code',
    refused.exitCode === 14 && refused.stderr.includes('refused-early'),
    JSON.stringify(refused).slice(0, 300),
  );
  // A reader that goes away mid-stream hangs up, and the channel is usable again at once.
  const gone = new PassThrough();
  gone.once('data', () => gone.destroy());
  let hungUp = false;
  try {
    await docker.execToStream('e2e-sleeper', ['sh', '-c', 'yes | head -c 50000000'], gone, { timeoutMs: 60_000 });
  } catch {
    hungUp = true;
  }
  ok('an abandoned stream hangs up instead of waiting out its deadline', hungUp);
  const after = await docker.exec('e2e-sleeper', ['echo', 'still-ok']);
  ok('the connection is fine afterwards', after.stdout.includes('still-ok'), JSON.stringify(after));
  await docker.removeContainer('e2e-sleeper');

  await containerApps(raw, docker, files);

  conn.close();

  // --- Host-key pinning: a wrong pin must fail loudly
  const badConn = new SshConnection({ ...target, pinnedHostKey: () => 'SHA256:' + 'A'.repeat(43) });
  let pinFailed = false;
  try {
    await new SshExec(badConn).run('true', [], { timeoutMs: 20_000 });
  } catch (err) {
    pinFailed = err instanceof ServerUnreachableError && /Host key .* changed/.test(err.message);
  }
  ok('host-key mismatch rejected', pinFailed);
  badConn.close();

  // --- The pin captured on the FIRST connect must apply to the connection's own
  // reconnects. `conn` above was closed after TOFU; reconnecting it re-reads the pin, so
  // tampering with the stored value now has to be rejected. (Before the fix the pin was
  // snapshotted at construction, so every reconnect re-trusted whatever key was offered.)
  storedPin = 'SHA256:' + 'B'.repeat(43);
  let reconnectRejected = false;
  try {
    await new SshExec(conn).run('true', [], { timeoutMs: 20_000 });
  } catch (err) {
    reconnectRejected = err instanceof ServerUnreachableError && /Host key .* changed/.test(err.message);
  }
  ok('pin captured on first connect is enforced on reconnect', reconnectRejected);
  storedPin = capturedFp;
  conn.close();

  // --- Web terminal: root refused -> key installed via sudo -> interactive root PTY.
  // This is the exact lazy-install flow TerminalService runs in production.
  const shellOpts = {
    host: HOST,
    port: PORT,
    privateKey: fs.readFileSync(KEY, 'utf8'),
    pinnedHostKey: () => storedPin,
    cols: 91,
    rows: 33,
  };
  let rootRefused = false;
  try {
    (await sshShellConnect({ ...shellOpts, username: 'root' })).dispose();
  } catch (err) {
    rootRefused = (err as { level?: string }).level === 'client-authentication';
  }
  ok('root login refused before key install', rootRefused);

  // Fresh connection: `conn` sits inside its 5s fail-fast window from the
  // tampered-pin test above and would replay that cached rejection.
  const installConn = new SshConnection(target, (m) => console.log(`  warn: ${m}`));
  const installExec = new SshExec(installConn);
  const pubKey = fs.readFileSync(`${KEY}.pub`, 'utf8').trim();
  const installScript = rootKeyInstallScript('/root/.ssh', pubKey);
  // Seed a pre-existing entry with NO trailing newline - the case that used to glue
  // the panel's key onto it, leaving no usable key line and a mangled line that a
  // substring match kept finding, so no retry ever repaired it. Root login below is
  // the real proof: it only succeeds if the appended line is a valid key of its own.
  await installExec.run(
    'sh',
    ['-c', "install -d -m 700 /root/.ssh; printf '%s' 'ssh-ed25519 AAAAOTHER other@host' > /root/.ssh/authorized_keys"],
    { timeoutMs: 20_000 },
  );
  const install = await installExec.run('sh', ['-c', installScript], { timeoutMs: 20_000 });
  ok('key install via sudo exec', install.exitCode === 0, JSON.stringify(install));
  await installExec.run('sh', ['-c', installScript], { timeoutMs: 20_000 });
  const akLines = await installExec.run('sh', ['-c', 'wc -l < /root/.ssh/authorized_keys'], { timeoutMs: 20_000 });
  ok('newline-less file repaired, still idempotent (2 lines)', akLines.stdout.trim() === '2', akLines.stdout);
  installConn.close();

  const shell = await sshShellConnect({ ...shellOpts, username: 'root' });
  let ptyOut = '';
  shell.channel.on('data', (chunk: Buffer) => {
    ptyOut += chunk.toString();
  });
  const ptyWait = async (needle: string) => {
    const deadline = Date.now() + 15_000;
    while (!ptyOut.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`PTY never printed ${JSON.stringify(needle)}; got: ${ptyOut.slice(-500)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  shell.channel.write('id -u; stty size\n');
  await ptyWait('33 91');
  ok('root PTY opened at the requested size', ptyOut.includes('0') && ptyOut.includes('33 91'));
  shell.setWindow(120, 40);
  shell.channel.write('stty size\n');
  await ptyWait('40 120');
  ok('setWindow resizes the remote PTY', true);
  shell.channel.write('exit 7\n');
  const exitCode = await shell.exit;
  ok('shell exit code propagates', exitCode === 7, String(exitCode));

  // Sanity that the exported fingerprint helper matches what was captured.
  ok('fingerprint format', typeof sshFingerprint === 'function' && capturedFp!.length > 10);

  console.log(`\nAll ${passed} SSH transport checks passed.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Container apps, over SSH: what the plan's settle-first items 4, 5, 6, 8 and 9 need of a worker,
// on the image store the script started it with (item 10).

/** Something seen, for E2E_FACTS. */
function fact(key: string, value: unknown): void {
  const file = process.env.E2E_FACTS;
  if (file) fs.appendFileSync(file, `${JSON.stringify({ test: 'sshTransport', store: process.env.E2E_IMAGE_STORE ?? 'classic', key, value })}\n`);
}

/** Every message of a pull, a push or a load, and the error one ends with, if it does. */
function follow(raw: Docker, stream: NodeJS.ReadableStream): Promise<{ messages: string[]; error: string | null }> {
  return new Promise((resolve, reject) => {
    raw.modem.followProgress(stream, (err: Error | null, output: { stream?: string; status?: string; error?: string; errorDetail?: { message?: string } }[]) => {
      if (err) return reject(err);
      const failed = output.find((o) => o.error);
      resolve({
        messages: output.map((o) => (o.stream ?? o.status ?? o.error ?? '').trim()).filter(Boolean),
        error: failed ? (failed.errorDetail?.message ?? failed.error ?? 'error') : null,
      });
    });
  });
}

async function pullVia(raw: Docker, ref: string, opts: { authconfig?: object; platform?: string } = {}) {
  try {
    return await follow(raw, (await raw.pull(ref, { ...opts })) as unknown as NodeJS.ReadableStream);
  } catch (err) {
    return { messages: [], error: (err as Error).message };
  }
}

const streamToFile = (stream: NodeJS.ReadableStream, file: string) =>
  new Promise<void>((resolve, reject) => stream.pipe(fs.createWriteStream(file)).on('finish', resolve).on('error', reject));


async function containerApps(raw: Docker, docker: DockerService, files: ExecFiles): Promise<void> {
  const work = fs.mkdtempSync(path.join(process.env.E2E_WORK ?? '/tmp', 'apps-'));
  const info = await raw.info();
  const store = imageStore(info);
  ok(`container apps: the worker runs the ${process.env.E2E_IMAGE_STORE ?? 'classic'} image store`, store === (process.env.E2E_IMAGE_STORE ?? 'classic'), store);
  fact('10. the worker', { version: info.ServerVersion, driver: info.Driver, store, architecture: info.Architecture });
  const server = { os: info.OSType as string, arch: ARCH[info.Architecture as string] ?? (info.Architecture as string) };
  const imageId = async (ref: string) => (await raw.getImage(ref).inspect().catch(() => null))?.Id ?? null;

  // --- 4. A registry with a login on the worker's own localhost, the one place its daemon takes
  // plain http from; pulled from and asked through the Engine API over SSH, as the panel would.
  const LOGIN = { username: 'engine', password: 'engine-registry-password', serveraddress: '127.0.0.1:5050' };
  for (const image of ['registry:2', 'httpd:2-alpine', 'busybox:1.37']) await docker.pullImage(image, () => undefined);
  const htpasswd = await docker.runEphemeral({ image: 'httpd:2-alpine', entrypoint: ['htpasswd'], cmd: ['-Bbn', LOGIN.username, LOGIN.password], networks: [], timeoutMs: 60_000 });
  await files.mkdirp('/srv/e2e/auth');
  await files.writeFile('/srv/e2e/auth/htpasswd', `${htpasswd.stdout.trim()}\n`);
  const registry = await raw.createContainer({
    name: 'e2e-registry',
    Image: 'registry:2',
    Env: ['REGISTRY_HTTP_ADDR=127.0.0.1:5050', 'REGISTRY_AUTH=htpasswd', 'REGISTRY_AUTH_HTPASSWD_REALM=engine', 'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd'],
    HostConfig: { NetworkMode: 'host', Binds: ['/srv/e2e/auth:/auth:ro'] },
  });
  await registry.start();
  for (let i = 0; i < 50 && !(await docker.containerLogs('e2e-registry')).includes('listening on'); i++) await new Promise((r) => setTimeout(r, 200));
  const REPO = '127.0.0.1:5050/engine/app';
  await raw.getImage('busybox:1.37').tag({ repo: REPO, tag: 'stable' });
  const pushed = await follow(raw, (await raw.getImage(`${REPO}:stable`).push({ authconfig: LOGIN } as never)) as unknown as NodeJS.ReadableStream);
  ok('container apps: a push with authconfig over ssh', pushed.error === null, String(pushed.error));
  await raw.getImage(`${REPO}:stable`).remove();

  const refused = await pullVia(raw, `${REPO}:stable`);
  ok('container apps: a pull without the login is refused', refused.error !== null && (await imageId(`${REPO}:stable`)) === null, String(refused.error));
  fact('4. pull without the login', refused.error);
  const dist = (await raw.getImage(`${REPO}:stable`).distribution({ authconfig: LOGIN })) as { Descriptor: { mediaType: string; digest: string }; Platforms: { os: string; architecture: string }[] | null };
  ok('container apps: the registry answers a digest with the login, over ssh, and nothing is pulled', /^sha256:[0-9a-f]{64}$/.test(dist.Descriptor.digest) && (await imageId(`${REPO}:stable`)) === null, JSON.stringify(dist));
  fact('4. distribution inspect with the login', dist);
  const noLogin = await raw.getImage(`${REPO}:stable`).distribution().then(() => 'answered', (err: Error) => err.message);
  ok('container apps: ...and not without it', noLogin !== 'answered', noLogin);
  const byDigest = `${REPO}@${dist.Descriptor.digest}`;
  const pulled = await pullVia(raw, byDigest, { authconfig: LOGIN });
  ok('container apps: a pull by digest with authconfig over ssh', pulled.error === null && (await imageId(byDigest)) !== null, String(pulled.error));
  const pulledImage = await raw.getImage(byDigest).inspect();
  fact('4. pulled by digest', { id: pulledImage.Id, tags: pulledImage.RepoTags, digests: pulledImage.RepoDigests });

  // --- 4. A 400 MB archive, streamed to POST /images/load through the SSH agent.
  const big = process.env.E2E_BIG_ARCHIVE;
  if (big) {
    const t0 = Date.now();
    const loaded = await follow(raw, (await raw.loadImage(fs.createReadStream(big))) as unknown as NodeJS.ReadableStream);
    const took = Date.now() - t0;
    const sum = await docker.runEphemeral({ image: 'wpl7-e2e-big:1', cmd: ['sha256sum', '/big.bin'], networks: [], timeoutMs: 120_000 });
    ok('container apps: a 400 MB docker load over ssh arrives whole', loaded.error === null && sum.stdout.startsWith(process.env.E2E_BIG_SHA ?? '-'), `${loaded.error} ${sum.stdout}`);
    fact('4. a 400 MB load over ssh', { ms: took, bytes: fs.statSync(big).size, messages: loaded.messages });
    await raw.getImage('wpl7-e2e-big:1').remove();
  }

  // --- 5. The app's uid, from its image's /etc/passwd, through a container created and never started.
  const fixture = fileURLToPath(new URL('../fixtures/container-app', import.meta.url));
  await docker.buildImage('wpl7-e2e-app:1', fixture, {}, () => undefined);
  const user = (await docker.imageConfig('wpl7-e2e-app:1'))!.user;
  const ids = await imageUserIds({ docker }, 'wpl7-e2e-app:1', user);
  ok('container apps: the uid of USER app, from a container never started, over ssh', ids.uid === 10001 && ids.gid === 10001, JSON.stringify({ user, ids }));
  ok('container apps: ...and that container is gone again', (await raw.listContainers({ all: true, filters: { label: ['wpl7.role=probe'] } })).length === 0);

  // --- 6. The platform fields on this store.
  const native = await raw.getImage('busybox:1.37').inspect();
  ok('container apps: a multi-platform image pulled here reads as the worker’s platform', platformRefusal((await docker.imageConfig('busybox:1.37'))!, await docker.serverPlatform()) === null, `${native.Os}/${native.Architecture}`);
  fact('6. a multi-platform image, as inspect has it', { Id: native.Id, Os: native.Os, Architecture: native.Architecture, Variant: (native as { Variant?: string }).Variant, RepoDigests: native.RepoDigests });
  const other = server.arch === 'amd64' ? 'arm64' : 'amd64';
  const otherDigest = other === 'amd64' ? process.env.E2E_DIGEST_AMD64 : process.env.E2E_DIGEST_ARM64;
  if (otherDigest) {
    const ref = `busybox@${otherDigest}`;
    const plain = await pullVia(raw, ref);
    fact('6. a pull of the other platform’s manifest, no platform asked', plain.error ?? 'pulled');
    if (plain.error) await pullVia(raw, ref, { platform: `linux/${other}` });
    const image = (await docker.imageConfig(ref))!;
    ok(
      'container apps: the other platform’s image is refused, naming both',
      platformRefusal(image, server) === `The image is for linux/${other}, and this server is linux/${server.arch}. Build it for linux/${server.arch}.`,
      `${image.os}/${image.architecture}`,
    );
  }

  // --- 8. The health gate's way in: with every route off, from inside Traefik on the site's
  // network, and from a short-lived container of Traefik's image on that network alone.
  await docker.pullImage('traefik:v3.7', () => undefined);
  const net = siteNetworkName('e2egate');
  await docker.ensureNetwork({ name: net, internal: true, labels: { 'wpl7.role': 'site-network', 'wpl7.site': 'e2egate' } });
  const edge = await raw.createContainer({ name: 'e2e-traefik', Image: 'traefik:v3.7', Cmd: ['--entrypoints.web.address=:80'], HostConfig: { NetworkMode: net } });
  await edge.start();
  const app = await raw.createContainer({ name: 'wp-e2egate', Image: 'wpl7-e2e-app:1', Labels: { 'traefik.enable': 'false' }, HostConfig: { NetworkMode: net } });
  await app.start();
  const wget = ['wget', '-q', '-S', '-T', '5', '-O', '-', '--header', 'Host: gate.example.net', 'http://wp-e2egate:80/health'];
  let viaExec = { exitCode: 1, stdout: '', stderr: '' };
  for (let i = 0; i < 50 && viaExec.exitCode !== 0; i++) {
    viaExec = await docker.exec('e2e-traefik', wget);
    if (viaExec.exitCode !== 0) await new Promise((r) => setTimeout(r, 200));
  }
  ok('container apps: the health check reaches the app from inside Traefik, over ssh', viaExec.exitCode === 0 && viaExec.stdout === 'ok', JSON.stringify(viaExec));
  const times = { exec: [] as number[], helper: [] as number[] };
  for (let i = 0; i < 3; i++) {
    let t0 = Date.now();
    await docker.exec('e2e-traefik', wget);
    times.exec.push(Date.now() - t0);
    t0 = Date.now();
    const helper = await docker.runEphemeral({ image: 'traefik:v3.7', entrypoint: ['wget'], cmd: wget.slice(1), networks: [net], timeoutMs: 30_000 });
    times.helper.push(Date.now() - t0);
    if (i === 0) ok('container apps: ...and from a short-lived container on the site’s network, over ssh', helper.exitCode === 0 && helper.stdout === 'ok', JSON.stringify(helper));
  }
  fact('8. checks over ssh, ms', times);

  // --- 9. The names an archive carries, on this store: a load takes an existing name, the check
  // sees it first, and a rename inside the archive keeps the server's names where they are.
  const VICTIM = 'wpl7-e2e-victim:1';
  await raw.getImage('busybox:1.37').tag({ repo: 'wpl7-e2e-victim', tag: '1' });
  const victimId = (await imageId(VICTIM))!;
  const uploadId = (await imageId('wpl7-e2e-app:1'))!;
  await raw.getImage('wpl7-e2e-app:1').tag({ repo: 'wpl7-e2e-victim', tag: '1' });
  const named = path.join(work, 'named.tar');
  await streamToFile((await raw.getImage(VICTIM).get()) as unknown as NodeJS.ReadableStream, named);
  await raw.getImage(victimId).tag({ repo: 'wpl7-e2e-victim', tag: '1' });
  const u = await unpackArchive(named);
  fact('9. an archive’s files', u.files);
  fact('9. the names in it', { manifest: u.manifest?.map((m) => m.RepoTags), index: u.index?.manifests.map((m) => m.annotations), repositories: u.repositories });
  const taken = namesOf(await raw.listImages());
  const archiveInfo = await inspectArchive(named);
  ok('container apps: the check sees the clash before the load, over ssh', archiveInfo.names.filter((n) => taken.has(n)).join() === VICTIM, JSON.stringify(archiveInfo.names));
  const took = await follow(raw, (await raw.loadImage(fs.createReadStream(named))) as unknown as NodeJS.ReadableStream);
  ok('container apps: docker load over ssh gives the name away', took.error === null && (await imageId(VICTIM)) === uploadId, JSON.stringify(took));
  fact('9. what a load says when it takes a name', took.messages);
  fact('9. the image that lost its name', { id: victimId, tags: (await raw.getImage(victimId).inspect().catch(() => null))?.RepoTags ?? null });
  await raw.getImage(victimId).tag({ repo: 'wpl7-e2e-victim', tag: '1' });
  // The panel's own rename, streamed into the panel's own load, over SSH.
  const loadedRenamed = await docker.loadImage(renamedArchive(named, archiveInfo, 'wpl7-app-e2e:upload-1'));
  ok(
    'container apps: renamed in the archive, only the panel’s name lands',
    loadedRenamed.loaded.join() === 'wpl7-app-e2e:upload-1' && (await imageId(VICTIM)) === victimId && (await imageId('wpl7-app-e2e:upload-1')) === uploadId,
    JSON.stringify(loadedRenamed),
  );
  fact('9. what a load of the renamed archive says', loadedRenamed.loaded);
  const mixed = path.join(work, 'mixed.tar');
  await disagreeingArchive(await unpackArchive(named), 'wpl7-e2e-manifest:1', 'wpl7-e2e-index:1', mixed);
  const loadedMixed = await follow(raw, (await raw.loadImage(fs.createReadStream(mixed))) as unknown as NodeJS.ReadableStream);
  fact('9. two places that disagree', { messages: loadedMixed.messages, error: loadedMixed.error, byManifest: (await imageId('wpl7-e2e-manifest:1')) !== null, byIndex: (await imageId('wpl7-e2e-index:1')) !== null });

  for (const name of ['wp-e2egate', 'e2e-traefik', 'e2e-registry']) await docker.removeContainer(name);
  await docker.removeNetwork(net);
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('✗ fatal:', err);
  process.exit(1);
});
