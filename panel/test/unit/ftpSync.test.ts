import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { servers, siteFtp, siteFtpUsers, sites, type SiteRow } from '../../src/db/schema.js';
import {
  FTP_EDGE_NETWORK,
  FTP_GATEWAY_CONTAINER,
  FTP_NETWORK,
  ftpFileServerContainer,
} from '../../src/services/ftpConfig.js';
import { ServerUnreachableError } from '../../src/servers/sshConnection.js';
import { FtpService } from '../../src/services/ftp.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, waitFor, type FakeDocker, type TestWorld } from '../helpers.js';

/**
 * FtpService against the fake Docker: what a server ends up running for the logins its sites
 * have, and what each kind of change does to it. The containers themselves are exercised for
 * real by test/e2e/ftp.sh.
 */

async function world(): Promise<TestWorld> {
  const w = await makeWorld();
  w.db.update(servers).set({ publicIp: '203.0.113.10' }).where(eq(servers.id, 1)).run();
  return w;
}

function addSite(w: TestWorld, slug: string, serverId = 1): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug,
      serverId,
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
  fs.mkdirSync(sitePaths(w.config, slug).wordpress, { recursive: true });
  return site;
}

const login = (username: string, over: { password?: string; folder?: string; expiresAt?: number | null } = {}) => ({
  username,
  folder: over.folder ?? '',
  expiresAt: over.expiresAt ?? null,
  ...(over.password !== undefined ? { password: over.password } : {}),
});

const specHash = (d: FakeDocker, name: string) => d.serviceSpecs.get(name)?.hash;
const calls = (d: FakeDocker, method: string) => d.calls.filter((c) => c.method === method);
const ftpRoot = (w: TestWorld) => path.join(w.config.srvRoot, 'wpl7-ftp');

describe('FTP on a server without logins', () => {
  it('runs nothing, pulls nothing, and is left alone after the first look', async () => {
    const w = await world();
    addSite(w, 'alpha');
    await w.core.ftp.tick();
    await w.core.ftp.idle();
    expect(calls(w.docker, 'pullImage')).toHaveLength(0);
    expect(calls(w.docker, 'ensureServiceContainer')).toHaveLength(0);
    expect(calls(w.docker, 'ensureNetwork')).toHaveLength(0);
    expect(fs.existsSync(ftpRoot(w))).toBe(false);

    w.docker.calls.length = 0;
    await w.core.ftp.tick();
    await w.core.ftp.idle();
    expect(w.docker.calls).toEqual([]);
  });
});

describe('the first login on a server', () => {
  it("brings up the gateway and that site's file server", async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const created = await w.core.ftp.createUser(site, login('alpha'), 'admin');
    await w.core.ftp.idle();

    expect(created.password).toMatch(/^[A-Za-z0-9]{24}$/);
    // An install from released images pulls the published build, under the local name.
    expect(calls(w.docker, 'pullImage').map((c) => c.args[0])).toEqual([w.config.sftpgoPublishedImage]);
    expect(calls(w.docker, 'tagImage').map((c) => c.args)).toEqual([[w.config.sftpgoPublishedImage, w.config.sftpgoImage]]);
    expect(calls(w.docker, 'buildImage')).toHaveLength(0);
    expect(w.docker.networks.get(FTP_NETWORK)).toMatchObject({ internal: true });
    expect(w.docker.networks.get(FTP_EDGE_NETWORK)).toMatchObject({ options: { 'com.docker.network.bridge.enable_icc': 'false' } });

    const files = w.docker.serviceSpecs.get(ftpFileServerContainer('alpha'))!;
    expect(files.user).toBe('33:33');
    expect(files.binds).toEqual([
      `${sitePaths(w.config, 'alpha').wordpress}:/var/www/html`,
      `${ftpRoot(w)}/sites/alpha:/etc/wpl7-ftp:ro`,
    ]);
    expect(files.networks).toEqual([FTP_NETWORK]);
    expect(files.ports).toBeUndefined();

    const gateway = w.docker.serviceSpecs.get(FTP_GATEWAY_CONTAINER)!;
    expect(gateway.binds).toEqual([`${ftpRoot(w)}/gateway:/etc/wpl7-ftp:ro`]);
    expect(gateway.ports!.map((p) => p.hostPort).slice(0, 3)).toEqual([2222, 21, 30000]);
    expect(gateway.ports!.every((p) => p.hostIp === '0.0.0.0')).toBe(true);

    // The gateway knows the login, by hash, and points it at alpha's file server.
    const users = JSON.parse(fs.readFileSync(`${ftpRoot(w)}/gateway/users.json`, 'utf8')).users;
    expect(users.map((u: { username: string }) => u.username)).toEqual(['alpha']);
    expect(users[0].password).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
    expect(JSON.stringify(users)).not.toContain(created.password!);
    expect(users[0].filesystem.sftpconfig.endpoint).toBe('wpl7-ftp-alpha:2022');
    // ...and the file server takes exactly the key the gateway was given.
    const link = w.db.select().from(siteFtp).where(eq(siteFtp.siteId, site.id)).get()!;
    const fileUsers = JSON.parse(fs.readFileSync(`${ftpRoot(w)}/sites/alpha/users.json`, 'utf8')).users;
    expect(users[0].filesystem.sftpconfig.private_key.payload).toBe(link.clientKey);
    expect(fileUsers[0].public_keys).toHaveLength(1);

    for (const f of ['gateway/users.json', 'gateway/host_ed25519', 'gateway/ftps.key', 'sites/alpha/host_ed25519']) {
      expect(fs.statSync(`${ftpRoot(w)}/${f}`).mode & 0o777).toBe(0o600);
    }

    const view = w.core.ftp.siteView(site);
    expect(view.status.state).toBe('ready');
    expect(view.applied).toBe(true);
    expect(view.endpoint.host).toBe('203.0.113.10');
    expect(view.endpoint.sftp.hostKeys.map((k) => k.type)).toEqual(['ssh-ed25519', 'ssh-rsa']);
    expect(view.endpoint.ftp).toMatchObject({ available: true, port: 21, certFingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}/) });
    expect(view.users).toEqual([expect.objectContaining({ username: 'alpha', createdBy: 'admin', expired: false })]);
  });

  it('offers SFTP alone on a server without a public IPv4, and says why', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    expect(w.docker.serviceSpecs.get(FTP_GATEWAY_CONTAINER)!.ports).toEqual([
      { hostIp: '0.0.0.0', hostPort: 2222, containerPort: 2022 },
    ]);
    const view = w.core.ftp.siteView(site);
    expect(view.endpoint.ftp.available).toBe(false);
    expect(view.endpoint.ftp.reason).toMatch(/public IPv4/);
    expect(view.status.state).toBe('ready');
  });
});

describe('changing logins', () => {
  it('reloads the gateway for a new login, and recreates nothing', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    const before = { gw: specHash(w.docker, FTP_GATEWAY_CONTAINER), files: specHash(w.docker, ftpFileServerContainer('alpha')) };

    await w.core.ftp.createUser(site, login('alpha-dev'), null);
    await w.core.ftp.idle();
    expect(specHash(w.docker, FTP_GATEWAY_CONTAINER)).toBe(before.gw);
    expect(specHash(w.docker, ftpFileServerContainer('alpha'))).toBe(before.files);
    expect(w.docker.signals).toContainEqual({ name: FTP_GATEWAY_CONTAINER, signal: 'SIGHUP' });
  });

  it("takes access away by replacing only that site's key", async () => {
    const w = await world();
    const alpha = addSite(w, 'alpha');
    const beta = addSite(w, 'beta');
    const a = await w.core.ftp.createUser(alpha, login('alpha'), null);
    await w.core.ftp.createUser(beta, login('beta'), null);
    await w.core.ftp.idle();
    const keyBefore = w.db.select().from(siteFtp).where(eq(siteFtp.siteId, alpha.id)).get()!.clientKey;
    const hashes = { a: specHash(w.docker, ftpFileServerContainer('alpha')), b: specHash(w.docker, ftpFileServerContainer('beta')) };
    w.docker.signals.length = 0;

    const reset = await w.core.ftp.resetPassword(alpha, a.user.id);
    await w.core.ftp.idle();
    expect(reset.password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(w.db.select().from(siteFtp).where(eq(siteFtp.siteId, alpha.id)).get()!.clientKey).not.toBe(keyBefore);
    // alpha's file server is a new container (its open connections end); beta's is untouched.
    expect(specHash(w.docker, ftpFileServerContainer('alpha'))).not.toBe(hashes.a);
    expect(specHash(w.docker, ftpFileServerContainer('beta'))).toBe(hashes.b);
    expect(w.docker.signals).toEqual([{ name: FTP_GATEWAY_CONTAINER, signal: 'SIGHUP' }]);
  });

  it('rotates on a changed folder or expiry, and on a delete that leaves others', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const a = await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.createUser(site, login('alpha-2'), null);
    await w.core.ftp.idle();
    const rotated = () => w.db.select().from(siteFtp).where(eq(siteFtp.siteId, site.id)).get()!.clientKey;
    let key = rotated();
    await w.core.ftp.updateUser(site, a.user.id, { folder: 'wp-content' });
    expect(rotated()).not.toBe(key);
    key = rotated();
    await w.core.ftp.deleteUser(site, a.user.id);
    expect(rotated()).not.toBe(key);
    await w.core.ftp.idle();
    const users = JSON.parse(fs.readFileSync(`${ftpRoot(w)}/gateway/users.json`, 'utf8')).users;
    expect(users.map((u: { username: string }) => u.username)).toEqual(['alpha-2']);
  });

  it('removes everything once the last login is gone', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const a = await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    await w.core.ftp.deleteUser(site, a.user.id);
    await w.core.ftp.idle();
    expect(w.docker.containers.has(FTP_GATEWAY_CONTAINER)).toBe(false);
    expect(w.docker.containers.has(ftpFileServerContainer('alpha'))).toBe(false);
    expect(w.docker.networks.has(FTP_NETWORK)).toBe(false);
    expect(w.docker.networks.has(FTP_EDGE_NETWORK)).toBe(false);
    expect(fs.existsSync(ftpRoot(w))).toBe(false);
    expect(w.db.select().from(siteFtp).all()).toEqual([]);
    expect(w.core.ftp.siteView(site).status.state).toBe('off');
  });

  it('refuses a username another site already has, without naming the site', async () => {
    const w = await world();
    await w.core.ftp.createUser(addSite(w, 'alpha'), login('shared'), null);
    await expect(w.core.ftp.createUser(addSite(w, 'beta'), login('shared'), null)).rejects.toThrow(/"shared" is taken/);
  });

  it("gives a login a link even if the site's went away just before (its last login deleted meanwhile)", async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    w.db.delete(siteFtp).where(eq(siteFtp.siteId, site.id)).run();
    await w.core.ftp.createUser(site, login('alpha-2'), null);
    expect(w.db.select().from(siteFtp).where(eq(siteFtp.siteId, site.id)).get()).toBeDefined();
    await w.core.ftp.idle();
    expect(w.docker.containers.get(ftpFileServerContainer('alpha'))).toBe('running');
  });

  it('keeps a password it was given to itself, and hands back only a generated one', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const mine = await w.core.ftp.createUser(site, login('alpha', { password: 'my own password 123' }), null);
    expect(mine.password).toBeNull();
    const row = w.db.select().from(siteFtpUsers).where(eq(siteFtpUsers.id, mine.user.id)).get()!;
    expect(row.passwordHash).not.toContain('my own password');
  });
});

describe('the minute tick', () => {
  it('leaves a server alone once it is off - FTP switched off, or only expired logins left', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const a = await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();

    w.core.settings.set('ftpEnabled', false);
    await w.core.ftp.kickAll();
    w.docker.calls.length = 0;
    await w.core.ftp.tick();
    await w.core.ftp.idle();
    await w.core.ftp.tick();
    await w.core.ftp.idle();
    expect(w.docker.calls).toEqual([]);

    w.core.settings.set('ftpEnabled', true);
    w.db.update(siteFtpUsers).set({ expiresAt: Date.now() - 1000 }).where(eq(siteFtpUsers.id, a.user.id)).run();
    await w.core.ftp.tick(); // rotates, syncs, tears down: no live login left
    await w.core.ftp.idle();
    expect(w.docker.containers.has(FTP_GATEWAY_CONTAINER)).toBe(false);
    w.docker.calls.length = 0;
    await w.core.ftp.tick();
    await w.core.ftp.idle();
    expect(w.docker.calls).toEqual([]);
  });
});

describe('the FTP switch', () => {
  it('tears every server down when switched off, and brings it back when on', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    w.core.settings.set('ftpEnabled', false);
    await w.core.ftp.kickAll();
    expect(w.docker.containers.has(FTP_GATEWAY_CONTAINER)).toBe(false);
    // The logins stay; switching back on brings them back.
    expect(w.db.select().from(siteFtpUsers).all()).toHaveLength(1);
    w.core.settings.set('ftpEnabled', true);
    await w.core.ftp.kickAll();
    expect(w.docker.containers.get(FTP_GATEWAY_CONTAINER)).toBe('running');
  });

  it('closes FTP but keeps SFTP when FTPS is switched off', async () => {
    const w = await world();
    await w.core.ftp.createUser(addSite(w, 'alpha'), login('alpha'), null);
    await w.core.ftp.idle();
    w.core.settings.set('ftpOfferFtps', false);
    await w.core.ftp.kickAll();
    expect(w.docker.serviceSpecs.get(FTP_GATEWAY_CONTAINER)!.ports).toEqual([
      { hostIp: '0.0.0.0', hostPort: 2222, containerPort: 2022 },
    ]);
  });
});

describe('pausing a site', () => {
  it("stops its file server until the job that paused it is over, whatever syncs meanwhile", async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();

    const resume = await w.core.ftp.suspendSite(site);
    expect(w.docker.containers.has(ftpFileServerContainer('alpha'))).toBe(false);
    expect(w.core.ftp.siteView(site).paused).toBe(true);
    await w.core.ftp.kick(1);
    expect(w.docker.containers.has(ftpFileServerContainer('alpha'))).toBe(false);
    // Its logins stay on the gateway: a login fails for the file server being gone, and says so.
    expect(fs.readFileSync(`${ftpRoot(w)}/gateway/users.json`, 'utf8')).toContain('"alpha"');

    resume();
    resume(); // idempotent
    await w.core.ftp.idle();
    expect(w.docker.containers.get(ftpFileServerContainer('alpha'))).toBe('running');
    expect(w.core.ftp.siteView(site).paused).toBe(false);
  });

  it('costs nothing for a site without logins', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const resume = await w.core.ftp.suspendSite(site);
    resume();
    await w.core.ftp.idle();
    expect(w.docker.calls).toEqual([]);
  });

  it('serves the new folder after it was swapped, not the one set aside', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    const before = specHash(w.docker, ftpFileServerContainer('alpha'));
    // What a restore does: the folder is renamed away and another takes its name.
    const folder = sitePaths(w.config, 'alpha').wordpress;
    fs.renameSync(folder, `${folder}.pre-restore-x`);
    fs.mkdirSync(folder);
    await w.core.ftp.kick(1);
    expect(specHash(w.docker, ftpFileServerContainer('alpha'))).not.toBe(before);
  });
});

describe('expiry', () => {
  it("ends an expired login's sessions and leaves it out of the gateway", async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const soon = Date.now() + 60_000;
    const a = await w.core.ftp.createUser(site, login('alpha', { expiresAt: soon }), null);
    await w.core.ftp.createUser(site, login('alpha-2'), null);
    await w.core.ftp.idle();
    const key = w.db.select().from(siteFtp).where(eq(siteFtp.siteId, site.id)).get()!.clientKey;

    expect(await w.core.ftp.expireDue(soon + 1)).toBe(1);
    expect(await w.core.ftp.expireDue(soon + 2)).toBe(0); // once, not every minute
    expect(w.db.select().from(siteFtp).where(eq(siteFtp.siteId, site.id)).get()!.clientKey).not.toBe(key);

    w.db.update(siteFtpUsers).set({ expiresAt: Date.now() - 1 }).where(eq(siteFtpUsers.id, a.user.id)).run();
    await w.core.ftp.kick(1);
    const users = JSON.parse(fs.readFileSync(`${ftpRoot(w)}/gateway/users.json`, 'utf8')).users;
    expect(users.map((u: { username: string }) => u.username)).toEqual(['alpha-2']);
    expect(w.core.ftp.siteView(site).users.find((u) => u.username === 'alpha')!.expired).toBe(true);
  });
});

describe('when things go wrong', () => {
  it('names the port that is taken', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    w.docker.failOn.set(
      'ensureServiceContainer',
      'driver failed programming external connectivity on endpoint wpl7-ftp (abc): Bind for 0.0.0.0:21 failed: port is already allocated',
    );
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    const view = w.core.ftp.siteView(site);
    expect(view.status.state).toBe('error');
    expect(view.status.message).toMatch(/port 21 is already in use on "local"/);
    expect(view.applied).toBe(false);
  });

  it('reports a gateway that keeps dying, with what it said', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    w.docker.serviceTrouble.set(FTP_GATEWAY_CONTAINER, { restarting: true, restartCount: 4 });
    w.docker.logs.set(FTP_GATEWAY_CONTAINER, '{"level":"error","message":"unable to load users"}\n');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    const view = w.core.ftp.siteView(site);
    expect(view.status.state).toBe('error');
    expect(view.status.message).toMatch(/gateway keeps stopping: unable to load users/);
  });

  it('marks an unreachable server as such, and does not throw', async () => {
    const w = await world();
    const remote = w.addSshServer('web-2');
    const site = addSite(w, 'alpha', remote.id);
    remote.docker.imageExists = async () => {
      throw new ServerUnreachableError(remote.id, 'web-2', new Error('connect ETIMEDOUT'));
    };
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    const view = w.core.ftp.siteView(site);
    expect(view.status.state).toBe('unreachable');
    expect(view.applied).toBe(false);
  });

  it("sets each server up with its own sites' logins only", async () => {
    const w = await world();
    const remote = w.addSshServer('web-2');
    await w.core.ftp.createUser(addSite(w, 'alpha'), login('alpha'), null);
    // One server at a time: here web-2 has server 1's disk (addSshServer), and a sync clears
    // the FTP folders of sites it does not serve - which on real servers are not its own.
    await w.core.ftp.idle();
    await w.core.ftp.createUser(addSite(w, 'beta', remote.id), login('beta'), null);
    await w.core.ftp.idle();
    expect(w.docker.containers.has(ftpFileServerContainer('beta'))).toBe(false);
    expect(remote.docker.containers.get(ftpFileServerContainer('beta'))).toBe('running');
    expect(remote.docker.serviceSpecs.get(FTP_GATEWAY_CONTAINER)).toBeDefined();
  });
});

describe('review regressions', () => {
  it("keeps one site's broken file server that site's problem, not the whole server's", async () => {
    const w = await world();
    const alpha = addSite(w, 'alpha');
    const beta = addSite(w, 'beta');
    await w.core.ftp.createUser(alpha, login('alpha'), null);
    await w.core.ftp.createUser(beta, login('beta'), null);
    await w.core.ftp.idle();
    fs.rmSync(sitePaths(w.config, 'alpha').wordpress, { recursive: true });
    await w.core.ftp.createUser(beta, login('beta-2'), null);
    await w.core.ftp.idle();

    const a = w.core.ftp.siteView(alpha);
    expect(a.status.state).toBe('error');
    expect(a.status.message).toMatch(/its files are missing/);
    const b = w.core.ftp.siteView(beta);
    expect(b.status.state).toBe('ready');
    expect(b.applied).toBe(true);
    expect(w.core.ftp.serverView(1).status.state).toBe('ready');
  });

  it('shows the last login as still being removed until the server has taken it', async () => {
    const w = await world();
    const remote = w.addSshServer('web-2');
    const site = addSite(w, 'alpha', remote.id);
    const a = await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    const reachable = remote.docker.imageExists.bind(remote.docker);
    remote.docker.imageExists = async () => {
      throw new ServerUnreachableError(remote.id, 'web-2', new Error('connect ETIMEDOUT'));
    };
    remote.docker.listManaged = async () => {
      throw new ServerUnreachableError(remote.id, 'web-2', new Error('connect ETIMEDOUT'));
    };
    await w.core.ftp.deleteUser(site, a.user.id);
    await w.core.ftp.idle();
    let view = w.core.ftp.siteView(site);
    expect(view.users).toEqual([]);
    expect(view.applied).toBe(false);
    expect(view.status.state).toBe('unreachable');

    remote.docker.imageExists = reachable;
    delete (remote.docker as { listManaged?: unknown }).listManaged;
    await w.core.ftp.kick(remote.id);
    view = w.core.ftp.siteView(site);
    expect(view.applied).toBe(true);
    expect(w.db.select().from(siteFtp).all()).toEqual([]);
  });

  it("holds back a site's first login while a restore or move of it runs", async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const resume = await w.core.ftp.suspendSite(site);
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    expect(w.docker.containers.has(ftpFileServerContainer('alpha'))).toBe(false);
    resume();
    await w.core.ftp.idle();
    expect(w.docker.containers.get(ftpFileServerContainer('alpha'))).toBe('running');
  });

  it('falls back to SFTP alone when only an FTP port is taken, and tries again when the settings change', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const ensure = w.docker.ensureServiceContainer.bind(w.docker);
    let port21Taken = true;
    w.docker.ensureServiceContainer = async (spec) => {
      if (port21Taken && spec.name === FTP_GATEWAY_CONTAINER && spec.ports?.some((p) => p.hostPort === 21)) {
        throw new Error('driver failed programming external connectivity on endpoint wpl7-ftp: Bind for 0.0.0.0:21 failed: port is already allocated');
      }
      return ensure(spec);
    };
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    let view = w.core.ftp.siteView(site);
    expect(view.status.state).toBe('ready');
    expect(view.endpoint.ftp.available).toBe(false);
    expect(view.endpoint.ftp.reason).toMatch(/Port 21 is already in use on "local", so it offers SFTP only/);
    expect(w.docker.serviceSpecs.get(FTP_GATEWAY_CONTAINER)!.ports).toEqual([{ hostIp: '0.0.0.0', hostPort: 2222, containerPort: 2022 }]);
    // No flapping: the next sync keeps SFTP alone rather than trying (and failing) again.
    const hash = w.docker.serviceSpecs.get(FTP_GATEWAY_CONTAINER)!.hash;
    await w.core.ftp.kick(1);
    expect(w.docker.serviceSpecs.get(FTP_GATEWAY_CONTAINER)!.hash).toBe(hash);

    port21Taken = false;
    await w.core.ftp.kickAll();
    view = w.core.ftp.siteView(site);
    expect(view.endpoint.ftp.available).toBe(true);
  });

  it('does not let an SFTP port that is taken hide behind the fallback', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    w.docker.failOn.set('ensureServiceContainer', 'Bind for 0.0.0.0:2222 failed: port is already allocated');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    expect(w.core.ftp.siteView(site).status.message).toMatch(/port 2222 is already in use/);
  });

  it('treats an address that is not IPv4 like a missing one: SFTP alone, and it says why', async () => {
    const w = await world();
    w.db.update(servers).set({ publicIp: '1.2.3.256' }).where(eq(servers.id, 1)).run();
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    const view = w.core.ftp.siteView(site);
    expect(view.status.state).toBe('ready');
    expect(view.endpoint.host).toBeNull();
    expect(view.endpoint.ftp.reason).toMatch(/"1.2.3.256" is not one/);
  });

  it('takes FTP off a server that is being removed from the panel', async () => {
    const w = await world();
    const remote = w.addSshServer('web-2');
    const site = addSite(w, 'alpha', remote.id);
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    expect(remote.docker.containers.get(FTP_GATEWAY_CONTAINER)).toBe('running');
    expect(await w.core.ftp.forgetServer(remote.id)).toBeNull();
    expect(remote.docker.containers.has(FTP_GATEWAY_CONTAINER)).toBe(false);
    expect(remote.docker.containers.has(ftpFileServerContainer('alpha'))).toBe(false);

    const gone = w.addSshServer('web-3');
    gone.docker.listManaged = async () => {
      throw new ServerUnreachableError(gone.id, 'web-3', new Error('connect ETIMEDOUT'));
    };
    expect(await w.core.ftp.forgetServer(gone.id)).toMatch(/FTP could not be removed from it/);
  });

  it("does not hold the next minute's expiry for one slow server", async () => {
    const w = await world();
    const remote = w.addSshServer('web-2');
    addSite(w, 'beta', remote.id);
    await w.core.ftp.createUser(w.db.select().from(sites).where(eq(sites.slug, 'beta')).get()!, login('beta'), null);
    remote.docker.imageExists = () => new Promise(() => undefined); // a pull that never ends
    const settled = await Promise.race([w.core.ftp.tick().then(() => 'returned'), new Promise((r) => setTimeout(() => r('stuck'), 2000))]);
    expect(settled).toBe('returned');
  });
});

describe('second review: access is only gone once the server says so', () => {
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  // What a panel that just started knows: the database, and nothing it looked at before.
  const restarted = (w: TestWorld) => new FtpService(w.db, w.config, w.servers, w.core.settings, quiet, { debounceMs: 0, settleMs: 0 });
  const unreachable = (remote: FakeDocker, id: number) => {
    const fail = async () => {
      throw new ServerUnreachableError(id, 'web-2', new Error('connect ETIMEDOUT'));
    };
    remote.imageExists = fail;
    remote.listManaged = fail;
  };

  it('does not report FTP as off on a server it could not take it off', async () => {
    const w = await world();
    const remote = w.addSshServer('web-2');
    const site = addSite(w, 'alpha', remote.id);
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    const reachable = { imageExists: remote.docker.imageExists, listManaged: remote.docker.listManaged };
    unreachable(remote.docker, remote.id);

    w.core.settings.set('ftpEnabled', false);
    await w.core.ftp.kickAll();
    // The gateway is still there, and so are the logins it serves.
    expect(remote.docker.containers.get(FTP_GATEWAY_CONTAINER)).toBe('running');
    let view = w.core.ftp.siteView(site);
    expect(view.enabled).toBe(false);
    expect(view.status.state).toBe('unreachable');
    expect(w.core.ftp.serverView(remote.id).status.state).toBe('unreachable');

    Object.assign(remote.docker, reachable);
    await w.core.ftp.kick(remote.id);
    expect(remote.docker.containers.has(FTP_GATEWAY_CONTAINER)).toBe(false);
    view = w.core.ftp.siteView(site);
    expect(view.status).toMatchObject({ state: 'off', checkedAt: expect.any(Number) });
  });

  it('only dates "off" once a sync has found it so', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    w.core.settings.set('ftpEnabled', false);
    await w.core.ftp.kickAll();
    expect(w.core.ftp.siteView(site).status).toMatchObject({ state: 'off', checkedAt: expect.any(Number) });

    // A panel that just started has looked at nothing yet.
    const fresh = restarted(w);
    expect(fresh.siteView(site).status).toMatchObject({ state: 'off', checkedAt: null });
    // Nor while its first look is still under way.
    let answer: () => void = () => undefined;
    let asked = false;
    const listManaged = w.docker.listManaged.bind(w.docker);
    w.docker.listManaged = (labels) =>
      new Promise((r) => {
        asked = true;
        answer = () => {
          w.docker.listManaged = listManaged;
          r(listManaged(labels));
        };
      });
    void fresh.kick(1);
    await waitFor(() => asked);
    expect(fresh.siteView(site).status).toMatchObject({ state: 'off', checkedAt: null });
    answer();
    await fresh.idle();
    expect(fresh.siteView(site).status).toMatchObject({ state: 'off', checkedAt: expect.any(Number) });
  });

  it('calls a server the tick leaves alone unreachable, where FTP ran, rather than off', async () => {
    const w = await world();
    const remote = w.addSshServer('web-2');
    const site = addSite(w, 'alpha', remote.id);
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    w.db.update(servers).set({ status: 'unreachable' }).where(eq(servers.id, remote.id)).run();
    const fresh = restarted(w);
    await fresh.tick();
    await fresh.idle();
    expect(fresh.siteView(site).status.state).toBe('unreachable');
    // A server FTP never ran on is simply off.
    const other = w.addSshServer('web-3');
    w.db.update(servers).set({ status: 'unreachable' }).where(eq(servers.id, other.id)).run();
    expect(fresh.serverView(other.id).status.state).toBe('off');
  });

  it('settles a site whose logins have all expired: off and applied, not stuck setting up', async () => {
    const w = await world();
    const site = addSite(w, 'alpha');
    const a = await w.core.ftp.createUser(site, login('alpha', { expiresAt: Date.now() + 60_000 }), null);
    await w.core.ftp.idle();
    expect(w.core.ftp.siteView(site).applied).toBe(true);

    // Past its expiry, before the tick has ended its sessions: not applied yet.
    const expiresAt = Date.now() - 1;
    w.db.update(siteFtpUsers).set({ expiresAt }).where(eq(siteFtpUsers.id, a.user.id)).run();
    w.db.update(siteFtp).set({ rotatedAt: expiresAt - 1000 }).where(eq(siteFtp.siteId, site.id)).run();
    expect(w.core.ftp.siteView(site).applied).toBe(false);

    await w.core.ftp.tick();
    await w.core.ftp.idle();
    expect(w.docker.containers.has(FTP_GATEWAY_CONTAINER)).toBe(false);
    const view = w.core.ftp.siteView(site);
    expect(view.applied).toBe(true);
    expect(view.status).toMatchObject({ state: 'off', checkedAt: expect.any(Number) });
    expect(view.users).toEqual([expect.objectContaining({ username: 'alpha', expired: true })]);
    expect(w.core.ftp.serverView(1)).toMatchObject({ logins: 1, activeLogins: 0, status: { state: 'off' } });
  });
});

describe('the SFTPGo image on a server', () => {
  const goImage = 'golang:1.26-trixie';

  it('is built there by an install built from source, which keeps only the image', async () => {
    const w = await makeWorld({ env: { WPL7_SOURCE: 'build' } });
    const site = addSite(w, 'alpha');
    let during: string | null = null;
    const build = w.docker.buildImage.bind(w.docker);
    w.docker.buildImage = async (...args) => {
      during = w.core.ftp.siteView(site).status.message;
      return build(...args);
    };
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();

    expect(calls(w.docker, 'pullImage')).toHaveLength(0);
    expect(calls(w.docker, 'buildImage').map((c) => c.args.slice(0, 2))).toEqual([[w.config.sftpgoImage, w.config.sftpgoImageContext]]);
    expect(during).toMatch(/^Building SFTPGo on "local" - a few minutes/);
    // Its build stage and the Go image it started from go again; the server had no Go before.
    expect(calls(w.docker, 'pruneImages').map((c) => c.args[0])).toEqual([['wpl7.build=sftpgo']]);
    expect(calls(w.docker, 'removeImage').map((c) => c.args[0])).toEqual([goImage]);
    expect(w.docker.serviceSpecs.get(FTP_GATEWAY_CONTAINER)!.image).toBe(w.config.sftpgoImage);
    expect(w.core.ftp.siteView(site).status.state).toBe('ready');

    // Built once: the next change finds it there.
    w.docker.calls.length = 0;
    await w.core.ftp.createUser(site, login('alpha-2'), null);
    await w.core.ftp.idle();
    expect(calls(w.docker, 'buildImage')).toHaveLength(0);
  });

  it('leaves a Go image alone that the server already had', async () => {
    const w = await makeWorld({ env: { WPL7_SOURCE: 'build' } });
    w.docker.images.add(goImage);
    await w.core.ftp.createUser(addSite(w, 'alpha'), login('alpha'), null);
    await w.core.ftp.idle();
    expect(calls(w.docker, 'buildImage')).toHaveLength(1);
    expect(calls(w.docker, 'removeImage')).toHaveLength(0);
    expect(w.docker.images.has(goImage)).toBe(true);
  });

  it('is built by an install from released images too, when the published one cannot be pulled', async () => {
    const w = await world();
    w.docker.failOn.set('pullImage', '(HTTP code 500) server error - error from registry: denied');
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    expect(calls(w.docker, 'buildImage')).toHaveLength(1);
    expect(w.core.ftp.siteView(site).status.state).toBe('ready');
  });

  it('pulls an image given by WPL7_SFTPGO_IMAGE and never builds one in its place', async () => {
    const w = await makeWorld({ env: { WPL7_SFTPGO_IMAGE: 'mirror.example/sftpgo:x', WPL7_SOURCE: 'build' } });
    w.docker.failOn.set('pullImage', 'manifest unknown');
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    expect(calls(w.docker, 'pullImage').map((c) => c.args[0])).toEqual(['mirror.example/sftpgo:x']);
    expect(calls(w.docker, 'buildImage')).toHaveLength(0);
    expect(w.core.ftp.siteView(site).status).toMatchObject({ state: 'error', message: expect.stringContaining('manifest unknown') });
  });

  it('says why a build failed, cleans up after it, and has the tick wait before the next try', async () => {
    const w = await makeWorld({ env: { WPL7_SOURCE: 'build' } });
    w.db.update(servers).set({ publicIp: '203.0.113.10' }).where(eq(servers.id, 1)).run();
    w.docker.failOn.set('buildImage', "The command '/bin/sh -c go build' returned a non-zero code: 2");
    const site = addSite(w, 'alpha');
    await w.core.ftp.createUser(site, login('alpha'), null);
    await w.core.ftp.idle();
    expect(w.core.ftp.siteView(site).status).toMatchObject({
      state: 'error',
      message: expect.stringMatching(/^building SFTPGo failed: The command .* returned a non-zero code: 2\. It is tried again in 15 minutes/),
    });
    expect(calls(w.docker, 'pruneImages')).toHaveLength(1);

    // The tick leaves it for a while: a compile that fails minutes in must not run back to back.
    w.docker.calls.length = 0;
    await w.core.ftp.tick();
    await w.core.ftp.idle();
    expect(calls(w.docker, 'buildImage')).toHaveLength(0);

    // A change to a login tries at once - and this time it builds.
    w.docker.failOn.delete('buildImage');
    await w.core.ftp.createUser(site, login('alpha-2'), null);
    await w.core.ftp.idle();
    expect(calls(w.docker, 'buildImage')).toHaveLength(1);
    expect(w.core.ftp.siteView(site).status.state).toBe('ready');
  });

  it('does not start another build from a tick that came while the failed one was running', async () => {
    const w = await makeWorld({ env: { WPL7_SOURCE: 'build' } });
    const site = addSite(w, 'alpha');
    let builds = 0;
    let fail: (err: Error) => void = () => undefined;
    w.docker.buildImage = () => {
      builds++;
      // The first build is held until the test fails it; any other one is counted and done.
      if (builds > 1) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
    };
    // Resolves once the login is saved and its sync queued; the sync itself is held by the build.
    await w.core.ftp.createUser(site, login('alpha'), null);
    await waitFor(() => builds === 1);
    // A minute passes mid-build: the tick sees a server that is not ready, and queues a sync.
    await w.core.ftp.tick();
    // So does a change made while it builds - which is not one made after the build failed.
    await w.core.ftp.createUser(site, login('alpha-2'), null);
    fail(new Error("The command '/bin/sh -c go mod download' returned a non-zero code: 1"));
    await w.core.ftp.idle();
    expect(builds).toBe(1);
    expect(w.core.ftp.siteView(site).status).toMatchObject({ state: 'error', message: expect.stringMatching(/^building SFTPGo failed/) });

    // A change after the failure tries again at once.
    w.docker.buildImage = async () => {
      builds++;
    };
    await w.core.ftp.createUser(site, login('alpha-3'), null);
    await w.core.ftp.idle();
    expect(builds).toBe(2);
  });

  it('is not needed where nothing FTP runs', async () => {
    const w = await makeWorld({ env: { WPL7_SOURCE: 'build' } });
    addSite(w, 'alpha');
    await w.core.ftp.tick();
    await w.core.ftp.idle();
    expect(calls(w.docker, 'buildImage')).toHaveLength(0);
    expect(calls(w.docker, 'pullImage')).toHaveLength(0);
  });
});
