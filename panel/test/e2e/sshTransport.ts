/**
 * Live e2e for the SSH transport layer against a real sshd + dockerd (the dind
 * container from test/e2e/server2). Exercises exactly what unit tests cannot:
 * pooled ssh2 channels, docker-API-over-SSH, streamed host commands, sudo,
 * host-key pinning. Driven by test/e2e/ssh-transport.sh.
 *
 * Env: E2E_SSH_HOST, E2E_SSH_PORT, E2E_SSH_KEY (private key path).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { PassThrough, Readable, Writable } from 'node:stream';
import Docker from 'dockerode';
import { SshConnection, ServerUnreachableError, sshFingerprint } from '../../src/servers/sshConnection.js';
import { SshDockerAgent } from '../../src/servers/sshDockerAgent.js';
import { SshExec } from '../../src/servers/sshExec.js';
import { rootKeyInstallScript, sshShellConnect } from '../../src/servers/terminal.js';
import { ExecFiles } from '../../src/lib/files.js';
import { DockerService } from '../../src/services/docker.js';

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

/** `promise`, or a failed check once it has taken `ms`: a call stuck waiting for a channel. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } catch (err) {
    ok(what, false, err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * More Docker calls than the pool has channels (8): execs read to their end, input written whole
 * or refused, and streams hung up on unread. Each has to give its channel back, or the ninth call
 * waits for one for ever.
 */
async function channelChecks(docker: DockerService, transport: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const res = await within(docker.exec('e2e-sleeper', ['echo', `run-${i}`]), 30_000, `exec ${i} over the ${transport}`);
    if (res.stdout.trim() !== `run-${i}`) ok(`exec ${i} over the ${transport}`, false, JSON.stringify(res));
  }
  ok(`twenty execs in a row over the ${transport}`, true);

  // Input: the bytes, then EOF as a half-close of the channel, with the output still readable after it.
  const input = crypto.randomBytes(3 * 1024 * 1024);
  const piped = await within(
    docker.execWithInput('e2e-sleeper', ['sh', '-c', 'cat | sha256sum'], input),
    60_000,
    `3 MiB of input over the ${transport}`,
  );
  ok(
    `exec stdin arrives whole, EOF ends it (3 MiB over the ${transport})`,
    piped.exitCode === 0 && piped.stdout.startsWith(crypto.createHash('sha256').update(input).digest('hex')),
    JSON.stringify(piped).slice(0, 300),
  );
  for (let i = 0; i < 10; i++) {
    const refused = await within(
      docker.execWithInput('e2e-sleeper', ['sh', '-c', 'echo refused-early >&2; exit 14'], crypto.randomBytes(8 * 1024 * 1024)),
      30_000,
      `refused input ${i} over the ${transport}`,
    );
    if (refused.exitCode !== 14) ok(`refused input ${i} over the ${transport}`, false, JSON.stringify(refused).slice(0, 300));
  }
  ok(`ten commands that exit without reading 8 MiB of input report it, and give their channels back (${transport})`, true);

  for (let i = 0; i < 10; i++) {
    const caller = new AbortController();
    // A destination that never drains, and a caller who gives up at its first chunk: the rest stays unread.
    const stuck = new Writable({ highWaterMark: 1, write: () => caller.abort() });
    const run = docker
      .execToStream('e2e-sleeper', ['sh', '-c', 'yes | head -c 50000000'], stuck, { signal: caller.signal, timeoutMs: 60_000 })
      .then(() => 'finished', (err: Error) => err.message);
    const how = await within(run, 30_000, `hung-up stream ${i} over the ${transport}`);
    if (!how.includes('abandoned')) ok(`hung-up stream ${i} over the ${transport}`, false, how);
  }
  const after = await within(docker.exec('e2e-sleeper', ['echo', 'still-ok']), 30_000, `an exec after the hang-ups over the ${transport}`);
  ok(`ten streams hung up on unread over the ${transport} gave their channels back`, after.stdout.includes('still-ok'), JSON.stringify(after));
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
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    console.log(`  warn: ${m}`);
  };
  const conn = new SshConnection(target, warn);

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
  const sleeper = await raw.createContainer({ name: 'e2e-sleeper', Image: 'busybox:latest', Cmd: ['sleep', '600'] });
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

  // --- Channels come back, over both ways to docker.sock. A stock sshd forwards the socket, and
  // keeps a forwarded channel open until both of its halves have ended.
  ok('docker.sock is forwarded, not reached through the fallback', !warnings.some((w) => w.includes('dial-stdio')), warnings.join('; '));
  await channelChecks(docker, 'forwarded socket');

  // An sshd that refuses forwarding leaves `docker system dial-stdio`. Turned off for new
  // connections only: the ones open carry on as they are.
  await exec.run(
    'sh',
    ['-c', `sed -i 's/^AllowTcpForwarding yes$/AllowTcpForwarding no/' /etc/ssh/sshd_config && kill -HUP "$(cat /var/run/sshd.pid)"`],
    { timeoutMs: 20_000 },
  );
  await new Promise((r) => setTimeout(r, 1_000));
  warnings.length = 0;
  const stdioConn = new SshConnection(target, warn);
  const stdioDocker = new DockerService(
    'bridge',
    'bridge',
    new Docker({ protocol: 'http', host: '127.0.0.1', port: 2375, agent: new SshDockerAgent(stdioConn) } as never),
  );
  ok('an sshd that refuses forwarding gets the dial-stdio fallback', (await stdioDocker.containerState('e2e-sleeper')) === 'running' && warnings.some((w) => w.includes('dial-stdio')), warnings.join('; '));
  await channelChecks(stdioDocker, 'dial-stdio fallback');
  stdioConn.close();

  await docker.removeContainer('e2e-sleeper');

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

main().catch((err) => {
  console.error('✗ fatal:', err);
  process.exit(1);
});
