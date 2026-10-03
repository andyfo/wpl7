/**
 * Live e2e for FTP/SFTP logins against a real worker: the sshd + dind container from
 * test/e2e/server2, reached over SSH exactly as the panel reaches any worker. FtpService sets
 * up the real SFTPGo gateway and file servers from its own rendering; real clients then log in.
 *
 * What unit tests cannot show, and this does:
 * - SFTPGo accepts the rendered config, users file, keys, argon2 hashes and certificate;
 * - SFTP from outside, and FTPS through Docker's NAT with passive mode (both PASV and EPSV);
 * - a login cannot reach another site's files, even through symlinks its site planted, even
 *   racing them;
 * - taking a login away ends its open sessions and leaves other sites' sessions alone.
 *
 * Driven by test/e2e/ftp.sh. Env: E2E_SSH_HOST, E2E_SSH_PORT, E2E_SSH_KEY, E2E_SFTP_PORT.
 */
import fs from 'node:fs';
import Docker from 'dockerode';
import { Client, type ClientChannel, type OpenMode, type SFTPWrapper } from 'ssh2';
import { SshConnection, sshFingerprint } from '../../src/servers/sshConnection.js';
import { SshDockerAgent } from '../../src/servers/sshDockerAgent.js';
import { SshExec } from '../../src/servers/sshExec.js';
import { ExecFiles } from '../../src/lib/files.js';
import { DockerService } from '../../src/services/docker.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/db/seed.js';
import { servers as serversTable, sites, type SiteRow } from '../../src/db/schema.js';
import { ServerRegistry } from '../../src/servers/registry.js';
import { SettingsService } from '../../src/services/settings.js';
import { FtpService } from '../../src/services/ftp.js';

const HOST = process.env.E2E_SSH_HOST ?? '127.0.0.1';
const PORT = Number(process.env.E2E_SSH_PORT ?? 39223);
const KEY = process.env.E2E_SSH_KEY!;
const SFTP_PORT = Number(process.env.E2E_SFTP_PORT ?? 39224);

let passed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`✗ ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${name}`);
}
const info = (msg: string) => console.log(`  · ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ SFTP client

interface Session {
  sftp: SFTPWrapper;
  client: Client;
  hostKey: string;
  end(): void;
}

async function login(username: string, password: string): Promise<Session> {
  const client = new Client();
  let hostKey = '';
  await new Promise<void>((resolve, reject) => {
    client
      .on('ready', () => resolve())
      .on('error', reject)
      .connect({
        host: '127.0.0.1',
        port: SFTP_PORT,
        username,
        password,
        readyTimeout: 30_000,
        hostVerifier: (key: Buffer) => {
          hostKey = sshFingerprint(key);
          return true;
        },
      });
  });
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((e, s) => (e ? reject(e) : resolve(s))));
  return { sftp, client, hostKey, end: () => client.end() };
}

async function loginFails(username: string, password: string): Promise<boolean> {
  try {
    (await login(username, password)).end();
    return false;
  } catch {
    return true;
  }
}

const read = (s: SFTPWrapper, p: string) =>
  new Promise<string>((resolve, reject) => s.readFile(p, (e, b) => (e ? reject(e) : resolve(b.toString()))));
const write = (s: SFTPWrapper, p: string, data: string) =>
  new Promise<void>((resolve, reject) => s.writeFile(p, data, (e) => (e ? reject(e) : resolve())));
const list = (s: SFTPWrapper, p: string) =>
  new Promise<string[]>((resolve, reject) => s.readdir(p, (e, l) => (e ? reject(e) : resolve(l.map((x) => x.filename).sort()))));
const symlink = (s: SFTPWrapper, target: string, p: string) =>
  new Promise<void>((resolve, reject) => s.symlink(target, p, (e) => (e ? reject(e) : resolve())));
const open = (s: SFTPWrapper, p: string, flags: OpenMode) =>
  new Promise<Buffer>((resolve, reject) => s.open(p, flags, (e, h) => (e ? reject(e) : resolve(h))));
const writeAt = (s: SFTPWrapper, handle: Buffer, data: Buffer, position: number) =>
  new Promise<void>((resolve, reject) => s.write(handle, data, 0, data.length, position, (e) => (e ? reject(e) : resolve())));

/** SCP's sink side, as `scp` itself speaks it: start a file, then send its bytes. */
async function scpUpload(client: Client, target: string, data: Buffer, send: number): Promise<void> {
  const ch = await new Promise<ClientChannel>((resolve, reject) =>
    client.exec(`scp -t ${target}`, (e, c) => (e ? reject(e) : resolve(c))),
  );
  const ack = () =>
    new Promise<void>((resolve, reject) =>
      ch.once('data', (d: Buffer) => (d[0] === 0 ? resolve() : reject(new Error(d.toString().trim())))),
    );
  await ack();
  ch.write(`C0644 ${data.length} ${target.split('/').pop()}\n`);
  await ack();
  ch.write(data.subarray(0, send));
  if (send < data.length) return; // the caller drops the connection mid-file
  ch.write(Buffer.from([0]));
  await ack();
  ch.end();
}
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
};

async function main(): Promise<void> {
  // ---------------------------------------------------------------- the worker, over SSH
  let pin: string | null = null;
  const conn = new SshConnection(
    {
      serverId: 2,
      serverName: 'e2e',
      host: HOST,
      port: PORT,
      username: 'wpl7-panel',
      privateKey: () => fs.readFileSync(KEY, 'utf8'),
      pinnedHostKey: () => pin,
      onHostKeyCaptured: (fp) => {
        pin = fp;
      },
    },
    (m) => info(`ssh: ${m}`),
  );
  const exec = new SshExec(conn);
  const files = new ExecFiles(exec);
  const docker = new DockerService(
    'wpl7_proxy',
    'wpl7_db',
    new Docker({ protocol: 'http', host: '127.0.0.1', port: 2375, agent: new SshDockerAgent(conn) } as never),
  );
  const sh = async (script: string, timeoutMs = 120_000) => exec.run('sh', ['-c', script], { timeoutMs });
  const ip = (await sh("ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1")).stdout.trim();
  ok('worker reachable over ssh', /^\d+\.\d+\.\d+\.\d+$/.test(ip), ip);

  // ---------------------------------------------------------------- the panel's side
  const config = loadConfig({
    NODE_ENV: 'test',
    SRV_ROOT: '/srv',
    TLS_MODE: 'none',
    DEV_DOMAIN: 'dev.example.test',
    PANEL_DOMAIN: 'panel.example.test',
    PANEL_ADMIN_USER: 'admin',
    PANEL_ADMIN_PASSWORD: 'correct-horse-battery',
    PANEL_SESSION_SECRET: 'x'.repeat(40),
    // Like the servers of an install built from source: a missing SFTPGo image is built there.
    WPL7_SOURCE: 'build',
    ...(process.env.WPL7_SFTPGO_IMAGE ? { WPL7_SFTPGO_IMAGE: process.env.WPL7_SFTPGO_IMAGE } : {}),
  });
  const db = openDb(':memory:');
  runMigrations(db);
  await seed(db, config);
  const now = Date.now();
  const server = db
    .insert(serversTable)
    .values({
      name: 'e2e',
      kind: 'ssh',
      sshHost: HOST,
      sshPort: PORT,
      sshUser: 'wpl7-panel',
      publicIp: ip,
      devDomain: 'dev.example.test',
      status: 'ok',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  const log = { info: (m: string) => info(m), warn: (m: string) => info(`WARN ${m}`), error: (m: string) => info(`ERROR ${m}`) };
  const registry = new ServerRegistry(db, config, log, {
    makeSsh: () => ({ docker, exec, files, dbAdmin: null as never }),
  });
  const settings = new SettingsService(db);
  const ftp = new FtpService(db, config, registry, settings, log, { debounceMs: 0 });
  // Default settle time: the checks log in right after a sync, as a person clicking would.

  const addSite = async (slug: string): Promise<SiteRow> => {
    const secret = `${slug.toUpperCase()}-SECRET`;
    const res = await sh(
      `set -e; d=/srv/sites/${slug}/wordpress; mkdir -p $d/wp-content/themes/child; ` +
        `printf '<?php // ${secret}\\n' > $d/wp-config.php; echo '/* ${slug} theme */' > $d/wp-content/themes/child/style.css; ` +
        `chown -R 33:33 /srv/sites/${slug}`,
    );
    if (res.exitCode !== 0) throw new Error(res.stderr);
    return db
      .insert(sites)
      .values({
        slug,
        serverId: server.id,
        title: slug,
        domains: JSON.stringify([`${slug}.test`]),
        phpVersion: '8.3',
        status: 'running',
        dbName: slug,
        dbUser: slug,
        dbPassword: 'x',
        containerName: `wp-${slug}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  };
  const alpha = await addSite('alpha');
  const beta = await addSite('beta');

  // ---------------------------------------------------------------- nothing until a login
  await ftp.tick();
  await ftp.idle();
  ok('no logins: nothing FTP runs', !(await sh('docker ps -a --format "{{.Names}}"')).stdout.includes('wpl7-ftp'));

  const t0 = Date.now();
  const a = await ftp.createUser(alpha, { username: 'alpha', folder: '', expiresAt: null }, 'e2e');
  const b = await ftp.createUser(beta, { username: 'beta', folder: '', expiresAt: null }, 'e2e');
  await ftp.idle();
  const view = ftp.siteView(alpha);
  ok('gateway and file servers come up', view.status.state === 'ready' && view.applied, JSON.stringify(view.status));
  info(`first setup took ${Math.round((Date.now() - t0) / 1000)} s (getting the image included)`);
  if (process.env.E2E_SFTPGO === 'build') {
    const images = (await sh('docker images --format "{{.Repository}}:{{.Tag}}"')).stdout;
    ok('the panel built the SFTPGo image on the worker', images.includes(config.sftpgoImage), images);
    const left = (await sh('docker images -q --filter label=wpl7.build=sftpgo; docker images -q golang')).stdout.trim();
    ok('and left nothing of the build behind: no build stage, no Go image', left === '', left);
    const version = (await sh(`docker run --rm ${config.sftpgoImage} sftpgo --version`)).stdout;
    ok('it is the patched build', /\+wpl7\.\d+/.test(version), version);
  }
  const names = (await sh('docker ps --format "{{.Names}}"')).stdout.split('\n');
  ok('one file server per site with logins', ['wpl7-ftp', 'wpl7-ftp-alpha', 'wpl7-ftp-beta'].every((n) => names.includes(n)));

  // ---------------------------------------------------------------- locked down
  const inspect = async (name: string) =>
    JSON.parse((await sh(`docker inspect ${name}`)).stdout)[0] as {
      Config: { User: string };
      HostConfig: { ReadonlyRootfs: boolean; CapDrop: string[]; SecurityOpt: string[] };
      Mounts: { Source: string; Destination: string; RW: boolean }[];
    };
  const gw = await inspect('wpl7-ftp');
  ok(
    'gateway: unprivileged, read-only root, no capabilities',
    gw.Config.User === '60021:60021' && gw.HostConfig.ReadonlyRootfs && gw.HostConfig.CapDrop.includes('ALL') &&
      gw.HostConfig.SecurityOpt.includes('no-new-privileges:true'),
  );
  ok('gateway mounts no site files', gw.Mounts.every((m) => !m.Source.startsWith('/srv/sites')), JSON.stringify(gw.Mounts));
  const fsA = await inspect('wpl7-ftp-alpha');
  ok(
    "file server: the site's user, only that site's folder",
    fsA.Config.User === '33:33' &&
      fsA.Mounts.filter((m) => m.Source.startsWith('/srv/sites')).map((m) => m.Source).join() === '/srv/sites/alpha/wordpress',
    JSON.stringify(fsA.Mounts),
  );

  // ---------------------------------------------------------------- SFTP
  const sa = await login('alpha', a.password!);
  ok('SFTP login with a generated password', true);
  ok('SFTP host key is the one the panel shows', view.endpoint.sftp.hostKeys.some((k) => k.fingerprint === sa.hostKey), sa.hostKey);
  ok("lists the site's own files", (await list(sa.sftp, '/')).includes('wp-config.php'));
  ok("reads the site's own files", (await read(sa.sftp, '/wp-config.php')).includes('ALPHA-SECRET'));
  await write(sa.sftp, '/wp-content/uploaded.txt', 'hello from sftp');
  const owner = (await sh('stat -c %u:%g /srv/sites/alpha/wordpress/wp-content/uploaded.txt')).stdout.trim();
  ok('an upload is owned by the site user on the host', owner === '33:33', owner);
  ok('creating a symlink is refused', await fails(symlink(sa.sftp, '/etc/passwd', '/link')));
  ok('a wrong password is refused', await loginFails('alpha', 'not-the-password'));
  ok("one site's login cannot sign in to another's name", await loginFails('beta', a.password!));

  // ---------------------------------------------------------------- FTPS through NAT
  const curl = (args: string) => sh(`curl -sS --max-time 30 ${args}`);
  const ftpUrl = `ftp://${ip}:21`;
  const cred = `alpha:${a.password}`;
  const epsv = await curl(`--ssl-reqd -k -u '${cred}' ${ftpUrl}/wp-config.php`);
  ok('FTPS download (EPSV)', epsv.stdout.includes('ALPHA-SECRET'), epsv.stderr);
  const pasv = await curl(`--ssl-reqd -k --disable-epsv -u '${cred}' ${ftpUrl}/wp-config.php`);
  ok('FTPS download (PASV, the server address it announces)', pasv.stdout.includes('ALPHA-SECRET'), pasv.stderr);
  await sh('echo "hello from ftps" > /tmp/up.txt');
  const up = await curl(`--ssl-reqd -k -T /tmp/up.txt -u '${cred}' ${ftpUrl}/wp-content/ftps.txt`);
  const upOwner = (await sh('stat -c %u:%g /srv/sites/alpha/wordpress/wp-content/ftps.txt')).stdout.trim();
  ok('FTPS upload lands as the site user', up.exitCode === 0 && upOwner === '33:33', up.stderr + upOwner);
  const plain = await curl(`-u '${cred}' ${ftpUrl}/wp-config.php`);
  ok('plain FTP is refused', plain.exitCode !== 0 && !plain.stdout.includes('ALPHA-SECRET'), plain.stderr);
  const certFp = (
    await sh(`echo | openssl s_client -starttls ftp -connect ${ip}:21 2>/dev/null | openssl x509 -noout -fingerprint -sha256`)
  ).stdout.trim();
  ok('FTPS certificate is the one the panel shows', certFp.endsWith(view.endpoint.ftp.certFingerprint ?? '-'), certFp);

  // ---------------------------------------------------------------- overwriting a live file
  // A replacement goes to a temporary name and is renamed over the file only once complete
  // (deploy/sftpgo-image): the site keeps its old file for the whole transfer - a WordPress
  // without its wp-config.php shows the install screen - and for good if it breaks off.
  const docroot = '/srv/sites/alpha/wordpress';
  const onHost = async (p: string) => (await sh(`cat ${docroot}/${p}`)).stdout;
  const leftovers = async () => (await sh(`find ${docroot} -name '.sftpgo-upload.*'`)).stdout.trim();
  await sh(`chmod 640 ${docroot}/wp-config.php`);
  const config0 = await onHost('wp-config.php');

  const cut = await login('alpha', a.password!);
  const h = await open(cut.sftp, '/wp-config.php', 'w');
  await writeAt(cut.sftp, h, Buffer.from('<?php // half of a new'), 0);
  ok('SFTP: the file being overwritten stays in place meanwhile', (await onHost('wp-config.php')) === config0);
  cut.client.destroy();
  await sleep(1500);
  ok('SFTP: an overwrite cut off mid-file leaves the file as it was', (await onHost('wp-config.php')) === config0);
  ok('and no temporary file behind', (await leftovers()) === '', await leftovers());
  const whole = await login('alpha', a.password!);
  await write(whole.sftp, '/wp-config.php', "<?php // ALPHA-SECRET, rewritten\n");
  ok('SFTP: a complete overwrite replaces the file', (await onHost('wp-config.php')).includes('rewritten'));
  const kept = (await sh(`stat -c '%a %u:%g' ${docroot}/wp-config.php`)).stdout.trim();
  ok('keeping its mode and owner', kept === '640 33:33', kept);

  const style = 'wp-content/themes/child/style.css';
  const style0 = await onHost(style);
  const bytes = Buffer.alloc(256 * 1024, 'x');
  await scpUpload(whole.client, `/${style}`, bytes, 64 * 1024).catch(() => undefined);
  await sleep(500);
  ok('SCP: the file being overwritten stays in place meanwhile', (await onHost(style)) === style0);
  whole.client.destroy();
  await sleep(1500);
  ok('SCP: an overwrite cut off mid-file leaves the file as it was', (await onHost(style)) === style0);
  ok('and no temporary file behind', (await leftovers()) === '', await leftovers());
  const scp = await login('alpha', a.password!);
  await scpUpload(scp.client, `/${style}`, Buffer.from('/* over scp */\n'), 15);
  ok('SCP: a complete overwrite replaces the file', (await onHost(style)) === '/* over scp */\n');
  scp.end();

  // FTP has no way to say "done" but closing the data connection, so a cut one is told apart
  // by TLS: a client killed mid-file never sends close_notify.
  const style1 = await onHost(style);
  const during = await sh(
    'head -c 4000000 /dev/zero > /tmp/big.bin; ' +
      `curl -sS --ssl-reqd -k --limit-rate 200k -T /tmp/big.bin -u '${cred}' ${ftpUrl}/${style} & pid=$!; ` +
      `sleep 3; cat ${docroot}/${style}; kill -9 $pid; wait $pid 2>/dev/null; true`,
  );
  ok('FTPS: the file being overwritten stays in place meanwhile', during.stdout === style1, during.stdout.slice(0, 80));
  await sleep(1500);
  ok('FTPS: an overwrite cut off mid-file leaves the file as it was', (await onHost(style)) === style1);
  ok('and no temporary file behind', (await leftovers()) === '', await leftovers());
  const full = await curl(`--ssl-reqd -k -T /tmp/up.txt -u '${cred}' ${ftpUrl}/${style}`);
  ok('FTPS: a complete overwrite replaces the file', full.exitCode === 0 && (await onHost(style)) === 'hello from ftps\n', full.stderr);

  // ---------------------------------------------------------------- a folder login
  const themes = await ftp.createUser(alpha, { username: 'alpha-themes', folder: 'wp-content/themes', expiresAt: null }, 'e2e');
  await ftp.idle();
  const st = await login('alpha-themes', themes.password!);
  ok('a folder login sees only its folder', (await list(st.sftp, '/')).join() === 'child');
  ok('and cannot climb out of it', await fails(read(st.sftp, '/../wp-config.php')) || !(await read(st.sftp, '/../wp-config.php')).includes('SECRET'));
  st.end();

  // ---------------------------------------------------------------- planted symlinks
  // What a compromised site's PHP can do: point links anywhere, by name.
  await sh(
    'cd /srv/sites/alpha/wordpress && ln -s /srv/sites/beta/wordpress/wp-config.php steal && ln -s ../../ up && ' +
      'ln -s / root && ln -s /etc/wpl7-ftp cfg && ln -s /proc/self/root p && chown -h 33:33 steal up root cfg p',
  );
  const sa2 = await login('alpha', a.password!);
  ok("a link to another site's file leads nowhere", await fails(read(sa2.sftp, '/steal')));
  for (const link of ['up', 'root', 'cfg', 'p']) {
    const listed = await list(sa2.sftp, `/${link}`).catch(() => null);
    ok(`a link out of the site (${link}) is not followed`, listed === null, JSON.stringify(listed));
  }
  ok('no write through a planted link', await fails(write(sa2.sftp, '/root/tmp/pwned', 'x')));

  // The race SFTPGo's own path checks cannot win: a folder swapped for a link to / while
  // the login reads through it. Inside the file server there is nothing of beta's to find.
  await sh('mkdir -p /srv/sites/alpha/wordpress/race && cp /srv/sites/alpha/wordpress/wp-config.php /srv/sites/alpha/wordpress/race/ && chown -R 33:33 /srv/sites/alpha/wordpress/race');
  const swapper = sh(
    'cd /srv/sites/alpha/wordpress; end=$(( $(date +%s) + 12 )); while [ $(date +%s) -lt $end ]; do ' +
      'mv race race.d 2>/dev/null; ln -s / race; rm -f race; mv race.d race 2>/dev/null; ' +
      'mv race race.d 2>/dev/null; ln -s /srv/sites/beta/wordpress race; rm -f race; mv race.d race 2>/dev/null; done',
    60_000,
  );
  let reads = 0;
  let leaked = false;
  let outside = 0;
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const got = await read(sa2.sftp, '/race/wp-config.php').catch(() => '');
    if (got.includes('BETA-SECRET')) leaked = true;
    const escaped = await read(sa2.sftp, '/race/etc/wpl7-ftp/sftpgo.json').catch(() => '');
    if (escaped) outside++;
    reads++;
  }
  await swapper;
  ok(`racing a swapped link never reaches another site (${reads} reads)`, !leaked);
  info(
    outside > 0
      ? `SFTPGo's userspace check lost the race ${outside} time(s) - inside the file server, which holds nothing but this site's own files and config`
      : 'SFTPGo never followed the swapped link either',
  );
  ok('nothing was written outside the site', !(await sh('ls /srv/sites/beta/wordpress')).stdout.includes('pwned'));
  sa2.end();

  // ---------------------------------------------------------------- taking access away
  const sb = await login('beta', b.password!);
  const sa3 = await login('alpha', a.password!);
  ok('sessions open on both sites', (await list(sb.sftp, '/')).includes('wp-config.php') && (await list(sa3.sftp, '/')).length > 0);
  const reset = await ftp.resetPassword(alpha, a.user.id);
  await ftp.idle();
  await sleep(1000);
  ok("a password reset ends the site's open sessions", await fails(list(sa3.sftp, '/')));
  ok("and leaves another site's session alone", (await list(sb.sftp, '/')).includes('wp-config.php'));
  ok('the old password is refused', await loginFails('alpha', a.password!));
  const sa4 = await login('alpha', reset.password!);
  ok('the new one works', (await read(sa4.sftp, '/wp-config.php')).includes('ALPHA-SECRET'));
  sa4.end();

  // Expiry: refused once it has passed, and a session open at that moment ends too.
  const temp = await ftp.createUser(alpha, { username: 'alpha-temp', folder: '', expiresAt: Date.now() + 6000 }, 'e2e');
  await ftp.idle();
  const stemp = await login('alpha-temp', temp.password!);
  ok('a login works until it expires', (await list(stemp.sftp, '/')).length > 0);
  await sleep(6500);
  await ftp.tick();
  await ftp.idle();
  await sleep(1000);
  ok('an expired login is refused', await loginFails('alpha-temp', temp.password!));
  ok("an expired login's open session ends", await fails(list(stemp.sftp, '/')));

  // ---------------------------------------------------------------- a folder swapped (restore)
  const resume = await ftp.suspendSite(alpha);
  await sh(
    'cd /srv/sites/alpha && mv wordpress wordpress.pre-restore-e2e && mkdir -p wordpress && ' +
      "printf '<?php // RESTORED\\n' > wordpress/wp-config.php && chown -R 33:33 wordpress",
  );
  resume();
  await ftp.idle();
  const sa5 = await login('alpha', reset.password!);
  ok('after a restore, the restored folder is served', (await read(sa5.sftp, '/wp-config.php')).includes('RESTORED'));
  sa5.end();
  sb.end();

  // ---------------------------------------------------------------- FTP's port taken on the server
  // As after a reboot where another FTP server got to port 21 first: SFTP must stay up.
  await sh('docker rm -f wpl7-ftp >/dev/null; docker run -d --name squat-21 -p 0.0.0.0:21:21 alpine:3 sleep 600 >/dev/null');
  await ftp.kickAll();
  const squatted = ftp.siteView(alpha);
  ok(
    'port 21 taken: the gateway falls back to SFTP alone, and says why',
    squatted.status.state === 'ready' && !squatted.endpoint.ftp.available && /Port 21 is already in use/.test(squatted.endpoint.ftp.reason ?? ''),
    JSON.stringify({ status: squatted.status, ftp: squatted.endpoint.ftp }),
  );
  const sq = await login('alpha', reset.password!);
  ok('and SFTP keeps working', (await read(sq.sftp, '/wp-config.php')).includes('RESTORED'));
  sq.end();
  await sh('docker rm -f squat-21 >/dev/null');
  await ftp.kickAll();
  const back = await curl(`--ssl-reqd -k -u 'alpha:${reset.password}' ftp://${ip}:21/wp-config.php`);
  ok('once the port is free, FTP comes back', ftp.siteView(alpha).endpoint.ftp.available && back.stdout.includes('RESTORED'), back.stderr);

  // ---------------------------------------------------------------- resources
  const stats = (await sh('docker stats --no-stream --format "{{.Name}} {{.MemUsage}}"')).stdout.trim();
  for (const line of stats.split('\n').filter((l) => l.startsWith('wpl7-ftp'))) info(`memory: ${line}`);

  // ---------------------------------------------------------------- the last login gone
  for (const site of [alpha, beta]) for (const u of ftp.usersOf(site.id)) await ftp.deleteUser(site, u.id);
  await ftp.idle();
  const left = (await sh('docker ps -a --format "{{.Names}}"')).stdout;
  ok('no logins left: the containers are gone', !left.includes('wpl7-ftp'), left);
  const listening = await exec.run('bash', ['-c', `exec 3<>/dev/tcp/${ip}/2222`], { timeoutMs: 10_000 });
  ok('and nothing listens on the SFTP port', listening.exitCode !== 0);
  ok('and their files are gone', !(await files.exists('/srv/wpl7-ftp')));

  console.log(`\n${passed} checks passed`);
  conn.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
