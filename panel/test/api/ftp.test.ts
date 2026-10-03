import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { apiEvents, servers, siteFtp, siteFtpUsers, sites } from '../../src/db/schema.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeApp, makeWorld } from '../helpers.js';
import type { SiteFtpDto, SiteFtpUserCreatedDto } from '../../shared/types.js';

async function signedIn() {
  const world = await makeWorld();
  world.db.update(servers).set({ publicIp: '203.0.113.10' }).where(eq(servers.id, 1)).run();
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  const addSite = (slug: string, status = 'running') => {
    const now = Date.now();
    fs.mkdirSync(sitePaths(world.config, slug).wordpress, { recursive: true });
    return world.db
      .insert(sites)
      .values({
        slug,
        title: slug,
        domains: JSON.stringify([`${slug}.test`]),
        phpVersion: '8.3',
        status,
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
  return { app, world, headers, addSite };
}

describe('FTP logins API', () => {
  it('starts with no logins and nothing running', async () => {
    const { app, headers, addSite } = await signedIn();
    addSite('alpha');
    const res = await app.inject({ method: 'GET', url: '/api/sites/alpha/ftp', headers });
    expect(res.statusCode).toBe(200);
    const view = res.json() as SiteFtpDto;
    expect(view.users).toEqual([]);
    expect(view.enabled).toBe(true);
    expect(view.status.state).toBe('off');
    expect(view.applied).toBe(true);
    expect(view.endpoint).toMatchObject({ host: '203.0.113.10', sftp: { port: 2222, hostKeys: [] }, ftp: { available: true, port: 21 } });
  });

  it('hands out a generated password once, and never again', async () => {
    const { app, world, headers, addSite } = await signedIn();
    const site = addSite('alpha');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/ftp/users',
      headers,
      payload: { username: ' Alpha ', folder: '/wp-content/', expiresAt: null },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as SiteFtpUserCreatedDto;
    expect(created.user).toMatchObject({ username: 'alpha', folder: 'wp-content', expiresAt: null, createdBy: 'admin' });
    expect(created.password).toMatch(/^[A-Za-z0-9]{24}$/);

    await world.core.ftp.idle();
    const again = await app.inject({ method: 'GET', url: '/api/sites/alpha/ftp', headers });
    const body = again.body;
    expect(body).not.toContain(created.password);
    expect(body).not.toContain('argon2');
    expect(body).not.toContain('PRIVATE KEY');
    const view = again.json() as SiteFtpDto;
    expect(view.users.map((u) => u.username)).toEqual(['alpha']);
    expect(view.status.state).toBe('ready');
    expect(view.endpoint.sftp.hostKeys).toHaveLength(2);
    expect(world.db.select().from(siteFtpUsers).where(eq(siteFtpUsers.siteId, site.id)).all()).toHaveLength(1);
  });

  it('keeps a chosen password out of the answer', async () => {
    const { app, headers, addSite } = await signedIn();
    addSite('alpha');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/ftp/users',
      headers,
      payload: { username: 'alpha', password: 'a long chosen password' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as SiteFtpUserCreatedDto).password).toBeNull();
    expect(res.body).not.toContain('a long chosen password');
  });

  it('refuses what cannot become a login', async () => {
    const { app, headers, addSite } = await signedIn();
    addSite('alpha');
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/sites/alpha/ftp/users', headers, payload });
    for (const payload of [
      { username: 'a b' },
      { username: 'ab' },
      { username: '-alpha' },
      { username: 'x'.repeat(33) },
      { username: 'alpha', password: 'short' },
      { username: 'alpha', password: 'has a\nnewline in it' },
      { username: 'alpha', folder: 'wp-content/../..' },
      { username: 'alpha', expiresAt: Date.now() - 1000 },
      { username: 'alpha', readOnly: true },
    ]) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("refuses a username another site has, without saying whose", async () => {
    const { app, headers, addSite } = await signedIn();
    addSite('alpha');
    addSite('beta');
    await app.inject({ method: 'POST', url: '/api/sites/alpha/ftp/users', headers, payload: { username: 'shared' } });
    const res = await app.inject({ method: 'POST', url: '/api/sites/beta/ftp/users', headers, payload: { username: 'shared' } });
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain('alpha');
  });

  it("changes a login's folder and expiry, taking open sessions away", async () => {
    const { app, world, headers, addSite } = await signedIn();
    const site = addSite('alpha');
    const created = (
      await app.inject({ method: 'POST', url: '/api/sites/alpha/ftp/users', headers, payload: { username: 'alpha' } })
    ).json() as SiteFtpUserCreatedDto;
    const key = world.db.select().from(siteFtp).where(eq(siteFtp.siteId, site.id)).get()!.clientKey;
    const expiresAt = Date.now() + 86_400_000;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sites/alpha/ftp/users/${created.user.id}`,
      headers,
      payload: { folder: 'wp-content/themes', expiresAt },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ folder: 'wp-content/themes', expiresAt });
    expect(world.db.select().from(siteFtp).where(eq(siteFtp.siteId, site.id)).get()!.clientKey).not.toBe(key);

    const empty = await app.inject({ method: 'PATCH', url: `/api/sites/alpha/ftp/users/${created.user.id}`, headers, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it('resets a password: generated when none is sent, even with no body at all', async () => {
    const { app, headers, addSite } = await signedIn();
    addSite('alpha');
    const created = (
      await app.inject({ method: 'POST', url: '/api/sites/alpha/ftp/users', headers, payload: { username: 'alpha' } })
    ).json() as SiteFtpUserCreatedDto;
    const url = `/api/sites/alpha/ftp/users/${created.user.id}/password`;

    const generated = await app.inject({ method: 'POST', url, headers });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(generated.json().password).not.toBe(created.password);

    const chosen = await app.inject({ method: 'POST', url, headers, payload: { password: 'another long password' } });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json().password).toBeNull();
  });

  it("deletes a login, and never reaches one of another site's", async () => {
    const { app, headers, addSite } = await signedIn();
    addSite('alpha');
    addSite('beta');
    const created = (
      await app.inject({ method: 'POST', url: '/api/sites/alpha/ftp/users', headers, payload: { username: 'alpha' } })
    ).json() as SiteFtpUserCreatedDto;
    const cross = await app.inject({ method: 'DELETE', url: `/api/sites/beta/ftp/users/${created.user.id}`, headers });
    expect(cross.statusCode).toBe(404);
    const crossReset = await app.inject({ method: 'POST', url: `/api/sites/beta/ftp/users/${created.user.id}/password`, headers });
    expect(crossReset.statusCode).toBe(404);

    const res = await app.inject({ method: 'DELETE', url: `/api/sites/alpha/ftp/users/${created.user.id}`, headers });
    expect(res.statusCode).toBe(204);
    const view = (await app.inject({ method: 'GET', url: '/api/sites/alpha/ftp', headers })).json() as SiteFtpDto;
    expect(view.users).toEqual([]);
  });

  it('leaves the logins of a site being created or deleted alone', async () => {
    const { app, headers, addSite } = await signedIn();
    addSite('alpha', 'deleting');
    const res = await app.inject({ method: 'POST', url: '/api/sites/alpha/ftp/users', headers, payload: { username: 'alpha' } });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/sites/alpha/ftp', headers })).statusCode).toBe(200);
  });

  it('needs the CSRF header on a change', async () => {
    const { app, headers, addSite } = await signedIn();
    addSite('alpha');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/ftp/users',
      headers: { cookie: headers.cookie },
      payload: { username: 'alpha' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('works with an API key, which is recorded as the creator and in the activity log', async () => {
    const { app, world, headers, addSite } = await signedIn();
    addSite('alpha');
    const key = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'deployer' } });
    const { token } = key.json() as { token: string };
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/ftp/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: 'ci-deploy' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as SiteFtpUserCreatedDto).user.createdBy).toBe('API key "deployer"');
    const rows = world.db.select().from(apiEvents).all();
    expect(rows.map((r) => [r.method, r.route, r.status])).toContainEqual(['POST', '/api/sites/:slug/ftp/users', 201]);
  });

  it("reports a server's gateway", async () => {
    const { app, world, headers, addSite } = await signedIn();
    addSite('alpha');
    await app.inject({ method: 'POST', url: '/api/sites/alpha/ftp/users', headers, payload: { username: 'alpha' } });
    await app.inject({ method: 'POST', url: '/api/sites/alpha/ftp/users', headers, payload: { username: 'alpha-2' } });
    await world.core.ftp.idle();
    const res = await app.inject({ method: 'GET', url: '/api/servers/1/ftp', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ serverId: 1, enabled: true, sites: 1, logins: 2, status: { state: 'ready' } });
    expect((await app.inject({ method: 'GET', url: '/api/servers/99/ftp', headers })).statusCode).toBe(404);
  });
});

describe('FTP settings', () => {
  it('refuses ports that cannot work', async () => {
    const { app, headers } = await signedIn();
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/settings', headers, payload });
    expect((await put({ ftpSftpPort: 22 })).statusCode).toBe(400);
    expect((await put({ ftpPort: 443 })).statusCode).toBe(400);
    expect((await put({ ftpPort: 2222 })).statusCode).toBe(400);
    expect((await put({ ftpPassivePortStart: 30000, ftpPassivePortEnd: 30200 })).statusCode).toBe(400);
    expect((await put({ ftpPassivePortStart: 30010, ftpPassivePortEnd: 30000 })).statusCode).toBe(400);
    expect((await put({ ftpSftpPort: 30005 })).statusCode).toBe(400);
    expect((await put({ ftpPassivePortStart: 1023 })).statusCode).toBe(400);
    // One port is not a range SFTPGo will use; 2022 and 2121 are the gateway's own inside.
    expect((await put({ ftpPassivePortStart: 30000, ftpPassivePortEnd: 30000 })).statusCode).toBe(400);
    expect((await put({ ftpPassivePortStart: 2000, ftpPassivePortEnd: 2099 })).statusCode).toBe(400);
    // SFTP only: the FTP ports are not checked against anything, as nothing listens on them.
    expect((await put({ ftpOfferFtps: false, ftpPort: 443 })).statusCode).toBe(200);
  });

  it('always lets FTP be switched off, whatever else is wrong with the ports', async () => {
    const { app, world, headers } = await signedIn();
    // A worker whose own SSH is on the SFTP port.
    world.addSshServer('web-2');
    world.db.update(servers).set({ sshPort: 2222 }).where(eq(servers.name, 'web-2')).run();
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/settings', headers, payload });
    expect((await put({ ftpOfferFtps: false })).statusCode).toBe(400);
    expect((await put({ ftpEnabled: false })).statusCode).toBe(200);
    expect((await put({ ftpEnabled: true, ftpSftpPort: 2200 })).statusCode).toBe(200);
  });

  it('applies new ports to every server with logins', async () => {
    const { app, world, headers, addSite } = await signedIn();
    addSite('alpha');
    await app.inject({ method: 'POST', url: '/api/sites/alpha/ftp/users', headers, payload: { username: 'alpha' } });
    await world.core.ftp.idle();
    const res = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { ftpSftpPort: 2022 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.ftpSftpPort).toBe(2022);
    await world.core.ftp.idle();
    expect(world.docker.serviceSpecs.get('wpl7-ftp')!.ports![0]).toEqual({ hostIp: '0.0.0.0', hostPort: 2022, containerPort: 2022 });
  });
});
