import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestConfig } from '../helpers.js';
import { FTP_ARGON2 } from '../../src/services/ftpKeys.js';
import {
  FILE_SERVER_USER,
  FTP_EDGE_NETWORK,
  FTP_GATEWAY_UID,
  FTP_NETWORK,
  fileServerSpec,
  ftpPortsProblem,
  gatewayLoginProblem,
  gatewaySpec,
  renderFileServerConfig,
  renderFileServerUsers,
  renderGatewayConfig,
  renderGatewayUsers,
  type FtpPaths,
  type GatewayLogin,
} from '../../src/services/ftpConfig.js';

/**
 * The files SFTPGo is handed. The fixtures under test/fixtures/ftp are the contract with it:
 * the real-container check (test/e2e/ftp.sh) starts SFTPGo on exactly this output, so a
 * change here that SFTPGo would refuse shows up as a changed fixture first.
 */

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n';
const FP = `SHA256:${'A'.repeat(43)}`;
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

const login = (over: Partial<GatewayLogin> = {}): GatewayLogin => ({
  username: 'acme',
  passwordHash: HASH,
  folder: '',
  expiresAt: null,
  siteSlug: 'acme',
  clientKey: KEY,
  fileServerFingerprint: FP,
  ...over,
});

const paths: FtpPaths = {
  root: '/srv/ftp',
  gateway: '/srv/ftp/gateway',
  sites: '/srv/ftp/sites',
  site: (slug) => `/srv/ftp/sites/${slug}`,
};

const FTP_ON = { port: 21, passiveStart: 30000, passiveEnd: 30015, passiveIp: '203.0.113.9' };

describe('gateway config', () => {
  it('matches the fixture', async () => {
    await expect(`${JSON.stringify(renderGatewayConfig(FTP_ON), null, 2)}\n`).toMatchFileSnapshot(
      '../fixtures/ftp/gateway-sftpgo.json',
    );
  });

  it('turns off everything but SFTP and FTPS, and bans brute force', () => {
    const c = renderGatewayConfig(FTP_ON) as Record<string, Record<string, unknown>>;
    expect(c.httpd).toEqual({ bindings: [expect.objectContaining({ port: 0 })] });
    expect(c.webdavd).toEqual({ bindings: [{ port: 0 }] });
    expect(c.telemetry).toEqual({ bind_port: 0 });
    expect(c.common).toMatchObject({ upload_mode: 1, symlink_mode: 0, defender: { enabled: true } });
    expect(c.data_provider).toMatchObject({ driver: 'memory', name: '/etc/wpl7-ftp/users.json', create_default_admin: false });
  });

  it('requires TLS on FTP and hands out the server address for passive mode', () => {
    const c = renderGatewayConfig(FTP_ON) as { ftpd: Record<string, unknown> & { bindings: Record<string, unknown>[] } };
    expect(c.ftpd.bindings[0]).toMatchObject({ port: 2121, tls_mode: 1, force_passive_ip: '203.0.113.9', min_tls_version: 12 });
    expect(c.ftpd.passive_port_range).toEqual({ start: 30000, end: 30015 });
    expect(c.ftpd.disable_active_mode).toBe(true);
    expect(c.ftpd.enable_site).toBe(true);
  });

  it('has no FTP listener at all when FTP is off', () => {
    const c = renderGatewayConfig(null) as { ftpd: { bindings: Record<string, unknown>[] } };
    expect(c.ftpd.bindings).toEqual([{ port: 0 }]);
  });
});

describe('the SFTPGo image', () => {
  it('is the one deploy/sftpgo-image builds, with the patch that stages overwrites', () => {
    const dir = new URL('../../../deploy/sftpgo-image/', import.meta.url);
    const version = fs.readFileSync(new URL('VERSION', dir), 'utf8').trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+-wpl7\.\d+$/);
    // Each server has it under its own name; installs from released images pull it from the
    // registry of the repository they update from, which is where CI publishes it.
    const config = makeTestConfig();
    expect(config.sftpgoImage).toBe(`wpl7-sftpgo:${version}`);
    expect(config.sftpgoPublishedImage).toBe(`ghcr.io/andyfo/wpl7/sftpgo:${version}`);
    expect(config.sftpgoImagePinned).toBe(false);
    expect(makeTestConfig({ WPL7_REPO: 'Someone/Fork' }).sftpgoPublishedImage).toBe(`ghcr.io/someone/fork/sftpgo:${version}`);
    expect(makeTestConfig({ WPL7_SFTPGO_IMAGE: 'mirror.example/sftpgo:x' })).toMatchObject({
      sftpgoImage: 'mirror.example/sftpgo:x',
      sftpgoImagePinned: true,
    });
    // The release VERSION names is the one the Dockerfile builds (it refuses to build otherwise too).
    expect(fs.readFileSync(new URL('Dockerfile', dir), 'utf8')).toContain(`ARG SFTPGO_VERSION=v${version.split('-')[0]}`);
    // Only the gateway stages uploads; the file servers write where they are told.
    expect(renderGatewayConfig(FTP_ON)).toMatchObject({ common: { upload_mode: 1 } });
    expect(renderFileServerConfig()).toMatchObject({ common: { upload_mode: 0 } });
  });
});

describe('password hashing', () => {
  it("keeps SFTPGo on the panel's argon2id, so it never re-hashes a login's password as bcrypt", () => {
    for (const c of [renderGatewayConfig(FTP_ON), renderFileServerConfig()] as Record<string, Record<string, unknown>>[]) {
      expect(c.data_provider!.password_hashing).toEqual({
        algo: 'argon2id',
        argon2_options: { memory: FTP_ARGON2.memoryCost, iterations: FTP_ARGON2.timeCost, parallelism: FTP_ARGON2.parallelism },
      });
    }
  });
});

describe('ftpPortsProblem', () => {
  const ok = { sftpPort: 2222, offerFtps: true, ftpPort: 21, passiveStart: 30000, passiveEnd: 30015 };
  const taken = [22, 80, 443];
  it('accepts the defaults', () => {
    expect(ftpPortsProblem(ok, taken)).toBeNull();
  });
  it('refuses what cannot work', () => {
    expect(ftpPortsProblem({ ...ok, sftpPort: 22 }, taken)).toMatch(/SFTP cannot use port 22/);
    expect(ftpPortsProblem({ ...ok, ftpPort: 443 }, taken)).toMatch(/FTP cannot use port 443/);
    expect(ftpPortsProblem({ ...ok, ftpPort: 2222 }, taken)).toMatch(/different ports/);
    // SFTPGo ignores a range whose end is not above its start.
    expect(ftpPortsProblem({ ...ok, passiveEnd: 30000 }, taken)).toMatch(/at least two ports/);
    expect(ftpPortsProblem({ ...ok, passiveEnd: 30100 }, taken)).toMatch(/at most 100/);
    expect(ftpPortsProblem({ ...ok, sftpPort: 30001 }, taken)).toMatch(/outside the passive range/);
    // Published 1:1, a passive port equal to one of the gateway's own would steal its binding.
    expect(ftpPortsProblem({ ...ok, passiveStart: 2000, passiveEnd: 2099 }, taken)).toMatch(/cannot include 2022/);
    expect(ftpPortsProblem({ ...ok, passiveStart: 2100, passiveEnd: 2199 }, taken)).toMatch(/cannot include 2121/);
    expect(ftpPortsProblem({ ...ok, passiveStart: 30000, passiveEnd: 30099 }, [...taken, 30050])).toMatch(/includes port 30050/);
  });
  it('checks only the SFTP port when FTP is not offered', () => {
    expect(ftpPortsProblem({ ...ok, offerFtps: false, ftpPort: 443, passiveEnd: 1 }, taken)).toBeNull();
  });
});

describe('file server config', () => {
  it('matches the fixture', async () => {
    await expect(`${JSON.stringify(renderFileServerConfig(), null, 2)}\n`).toMatchFileSnapshot(
      '../fixtures/ftp/files-sftpgo.json',
    );
  });

  it('takes keys only, never bans (every connection is the gateway), and does not re-stage uploads', () => {
    const c = renderFileServerConfig() as Record<string, Record<string, unknown>>;
    expect(c.sftpd).toMatchObject({ password_authentication: false, keyboard_interactive_authentication: false, enabled_ssh_commands: [] });
    expect(c.common).toMatchObject({ upload_mode: 0, symlink_mode: 0, max_per_host_connections: 0, defender: { enabled: false } });
    expect(c.ftpd).toEqual({ bindings: [{ port: 0 }] });
  });
});

describe('gateway users', () => {
  it('matches the fixture', async () => {
    const { json, skipped } = renderGatewayUsers([
      login({ username: 'zed', siteSlug: 'shop', folder: 'wp-content/themes/child', expiresAt: 1_800_000_000_000 }),
      login(),
    ]);
    expect(skipped).toEqual([]);
    await expect(json).toMatchFileSnapshot('../fixtures/ftp/gateway-users.json');
  });

  it("points each login at its own site's file server, pinned, and keeps a folder login inside it", () => {
    const users = JSON.parse(renderGatewayUsers([login({ folder: 'wp-content' })]).json).users;
    expect(users).toHaveLength(1);
    expect(users[0].filesystem).toEqual({
      provider: 5,
      sftpconfig: expect.objectContaining({
        endpoint: 'wpl7-ftp-acme:2022',
        username: FILE_SERVER_USER,
        private_key: { status: 'Plain', payload: KEY },
        fingerprints: [FP],
        prefix: '/wp-content',
        buffer_size: 0,
      }),
    });
    expect(users[0].expiration_date).toBe(0);
  });

  it('never grants symlinks or ownership changes', () => {
    const perms: string[] = JSON.parse(renderGatewayUsers([login()]).json).users[0].permissions['/'];
    expect(perms).not.toContain('*');
    expect(perms).not.toContain('create_symlinks');
    expect(perms).not.toContain('chown');
    expect(perms).toContain('upload');
  });

  it('leaves a row SFTPGo would refuse out of the file, and says so', () => {
    const { json, skipped } = renderGatewayUsers([
      login({ username: 'good' }),
      // A hash straight from node-argon2 (m,p,t): SFTPGo cannot parse it.
      login({ username: 'bad', passwordHash: '$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA' }),
    ]);
    expect(JSON.parse(json).users.map((u: { username: string }) => u.username)).toEqual(['good']);
    expect(skipped).toEqual([{ username: 'bad', problem: 'password hash SFTPGo cannot read' }]);
  });

  it('checks what SFTPGo checks', () => {
    expect(gatewayLoginProblem(login())).toBeNull();
    expect(gatewayLoginProblem(login({ username: 'a b' }))).toMatch(/username/);
    expect(gatewayLoginProblem(login({ folder: 'a/../b' }))).toMatch(/folder/);
    expect(gatewayLoginProblem(login({ folder: '/abs' }))).toMatch(/folder/);
    expect(gatewayLoginProblem(login({ folder: 'a//b' }))).toMatch(/folder/);
    expect(gatewayLoginProblem(login({ expiresAt: -1 }))).toMatch(/expiry/);
    expect(gatewayLoginProblem(login({ clientKey: '' }))).toMatch(/key/);
    expect(gatewayLoginProblem(login({ fileServerFingerprint: 'MD5:aa' }))).toMatch(/fingerprint/);
  });

  it('writes a version-17 dump even with no logins', () => {
    const d = JSON.parse(renderGatewayUsers([]).json);
    expect(d.version).toBe(17);
    expect(d.users).toEqual([]);
  });
});

describe('file server users', () => {
  it('matches the fixture', async () => {
    await expect(renderFileServerUsers('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKE wpl7-ftp')).toMatchFileSnapshot(
      '../fixtures/ftp/files-users.json',
    );
  });

  it("is the gateway's key and nothing else", () => {
    const [u] = JSON.parse(renderFileServerUsers('ssh-ed25519 AAAA x')).users;
    expect(u.username).toBe(FILE_SERVER_USER);
    expect(u.public_keys).toEqual(['ssh-ed25519 AAAA x']);
    expect(u.password).toBeUndefined();
    expect(u.home_dir).toBe('/var/www/html');
    expect(u.filters.denied_login_methods).toEqual(['password', 'password-over-SSH', 'keyboard-interactive']);
  });
});

describe('container specs', () => {
  it('publishes the gateway on IPv4 only, passive ports 1:1, and mounts no site files', () => {
    const spec = gatewaySpec({ image: 'sftpgo', paths, ports: { sftp: 2222, ftp: FTP_ON }, inputs: 'x' });
    expect(spec.user).toBe(`${FTP_GATEWAY_UID}:${FTP_GATEWAY_UID}`);
    expect(spec.networks).toEqual([FTP_EDGE_NETWORK, FTP_NETWORK]);
    expect(spec.readOnlyRootfs).toBe(true);
    expect(spec.binds).toEqual(['/srv/ftp/gateway:/etc/wpl7-ftp:ro']);
    expect(spec.binds.some((b) => b.includes('/sites'))).toBe(false);
    const ports = spec.ports!;
    expect(ports.every((p) => p.hostIp === '0.0.0.0')).toBe(true);
    expect(ports.slice(0, 2)).toEqual([
      { hostIp: '0.0.0.0', hostPort: 2222, containerPort: 2022 },
      { hostIp: '0.0.0.0', hostPort: 21, containerPort: 2121 },
    ]);
    expect(ports.slice(2)).toHaveLength(16);
    expect(ports.slice(2).every((p) => p.hostPort === p.containerPort)).toBe(true);
  });

  it('publishes SFTP alone when FTP is off', () => {
    const spec = gatewaySpec({ image: 'sftpgo', paths, ports: { sftp: 2222, ftp: null }, inputs: 'x' });
    expect(spec.ports).toEqual([{ hostIp: '0.0.0.0', hostPort: 2222, containerPort: 2022 }]);
  });

  it('sets no CPU ceiling (Docker refuses one above the host CPU count), only memory and processes', () => {
    const gw = gatewaySpec({ image: 'sftpgo', paths, ports: { sftp: 2222, ftp: FTP_ON }, inputs: 'x' });
    const fs = fileServerSpec({ image: 'sftpgo', paths, slug: 'acme', siteFolder: '/s', inputs: 'x' });
    for (const spec of [gw, fs]) {
      expect(spec.nanoCpus).toBeUndefined();
      expect(spec.memoryBytes).toBeGreaterThan(0);
      expect(spec.pidsLimit).toBeGreaterThan(0);
    }
  });

  it("gives a file server its own site's folder, as the site's user, on the internal network only", () => {
    const spec = fileServerSpec({ image: 'sftpgo', paths, slug: 'acme', siteFolder: '/srv/sites/acme/wordpress', inputs: 'x' });
    expect(spec.name).toBe('wpl7-ftp-acme');
    expect(spec.user).toBe('33:33');
    expect(spec.binds).toEqual(['/srv/sites/acme/wordpress:/var/www/html', '/srv/ftp/sites/acme:/etc/wpl7-ftp:ro']);
    expect(spec.networks).toEqual([FTP_NETWORK]);
    expect(spec.ports).toBeUndefined();
    expect(spec.labels).toEqual({ 'wpl7.role': 'ftp-files', 'wpl7.site': 'acme' });
    expect(Object.values(spec.tmpfs!).every((o) => o.includes('uid=33'))).toBe(true);
  });
});
