import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobs, sitePanelFiles, sites } from '../../src/db/schema.js';
import { LOGIN_TOKEN_TTL_SECONDS, MU_PLUGIN_FILE, MU_PLUGIN_PATH, MU_PLUGIN_SOURCE } from '../../src/services/adminLogin.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeApp, makeWorld } from '../helpers.js';

/** A created site whose container the fake Docker reports as running. */
async function siteReady() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  await app.inject({
    method: 'POST',
    url: '/api/sites',
    headers,
    payload: { title: 'My Blog', domainMode: 'dev', adminUser: 'boss', adminEmail: 'boss@example.com' },
  });
  // The worker never runs in API tests; settle the queued create by hand.
  world.db.update(jobs).set({ status: 'succeeded', finishedAt: Date.now() }).run();
  world.db.update(sites).set({ status: 'running' }).run();
  world.docker.containers.set('wp-my-blog', 'running');
  return { app, world, headers };
}

/** What wp-cli answers, in the order createAdminLoginLink asks: user list, transient set, siteurl. */
function scriptWpCli(world: Awaited<ReturnType<typeof makeWorld>>, admins: { ID: number; user_login: string }[]): void {
  world.docker.administrators = admins;
  world.docker.execQueue.push(
    { stdout: 'Success: Transient added.', stderr: '', exitCode: 0 },
    { stdout: 'http://my-blog.dev.example.test\n', stderr: '', exitCode: 0 },
  );
}

const execArgs = (world: Awaited<ReturnType<typeof makeWorld>>): string[][] =>
  world.docker.calls.filter((c) => c.method === 'exec').map((c) => c.args[1] as string[]);

describe('one-click WordPress admin login', () => {
  it('mints a single-use link and keeps only the hash of its secret in WordPress', async () => {
    const { app, world, headers } = await siteReady();
    scriptWpCli(world, [
      { ID: 7, user_login: 'boss' },
      { ID: 9, user_login: 'agency' },
    ]);
    // A site that predates the rename still has the old drop-in on disk.
    const muPlugins = sitePaths(world.config, 'my-blog').muPlugins;
    fs.mkdirSync(muPlugins, { recursive: true });
    fs.writeFileSync(path.join(muPlugins, 'ceo-login.php'), '<?php // the old one');

    const res = await app.inject({ method: 'POST', url: '/api/sites/my-blog/wp/admin-login', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; user: string; expiresInSeconds: number };
    expect(body.user).toBe('boss'); // the site's own administrator, not merely the first one
    expect(body.expiresInSeconds).toBe(LOGIN_TOKEN_TTL_SECONDS);

    const url = new URL(body.url);
    expect(url.origin).toBe('http://my-blog.dev.example.test'); // where WordPress says it lives
    const token = url.searchParams.get('wpl7-login')!;
    const [selector, verifier] = token.split('.') as [string, string];

    const transient = execArgs(world).find((a) => a[1] === 'transient' && a[2] === 'set')!;
    expect(transient[3]).toBe(`wpl7_login_${selector}`);
    expect(transient[5]).toBe(String(LOGIN_TOKEN_TTL_SECONDS));
    const claim = JSON.parse(transient[4]!) as { u: number; h: string };
    expect(claim.u).toBe(7);
    expect(claim.h).toBe(crypto.createHash('sha256').update(verifier).digest('hex'));
    // The secret half of the token exists only in the URL handed to the browser: a dump of
    // the site's database must not be enough to log in.
    expect(JSON.stringify(execArgs(world))).not.toContain(verifier);

    // The drop-in is installed (and refreshed) as part of minting - inside the site's
    // container, never through the host's copy of its files.
    const file = path.join(muPlugins, MU_PLUGIN_FILE);
    expect(fs.readFileSync(file, 'utf8')).toBe(MU_PLUGIN_SOURCE);
    const write = world.docker.calls.find((c) => c.method === 'execWithInput')!;
    expect(write.args[0]).toBe('wp-my-blog');
    expect(write.args[2]).toMatchObject({ user: '0:0' });
    // Noted as the panel's own, so a malware scan holds the file to it.
    const site = world.db.select().from(sites).all().find((s) => s.slug === 'my-blog')!;
    expect(world.core.panelFiles.expected(site.id)[MU_PLUGIN_PATH]).toEqual([crypto.createHash('sha256').update(MU_PLUGIN_SOURCE).digest('hex')]);
    expect(world.db.select().from(sitePanelFiles).all().map((r) => r.path)).toEqual([MU_PLUGIN_PATH]);
    // LEGACY(ceo) - delete in 0.3.0. The pre-rename drop-in answers a query parameter the
    // panel no longer mints, so it goes when the new one is written.
    expect(fs.existsSync(path.join(muPlugins, 'ceo-login.php'))).toBe(false);

    // The drop-in accepts exactly this token shape. A mangled escape in the embedded PHP
    // (it is stored through String.raw) would turn every minted link into a silent no-op.
    const phpPattern = /preg_match\('\/(.+?)\/'/.exec(MU_PLUGIN_SOURCE)![1]!;
    expect(new RegExp(phpPattern).test(token)).toBe(true);
  });

  it('falls back to the oldest administrator when the site admin is gone', async () => {
    const { app, world, headers } = await siteReady();
    scriptWpCli(world, [
      { ID: 4, user_login: 'customer' },
      { ID: 12, user_login: 'someone-else' },
    ]);

    const res = await app.inject({ method: 'POST', url: '/api/sites/my-blog/wp/admin-login', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toBe('customer');
  });

  it('409s when the site has no administrator left', async () => {
    const { app, world, headers } = await siteReady();
    scriptWpCli(world, []);

    const res = await app.inject({ method: 'POST', url: '/api/sites/my-blog/wp/admin-login', headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('409s while the container is not running, without touching the site files', async () => {
    const { app, world, headers } = await siteReady();
    world.docker.containers.set('wp-my-blog', 'exited');

    const res = await app.inject({ method: 'POST', url: '/api/sites/my-blog/wp/admin-login', headers });
    expect(res.statusCode).toBe(409);
    expect(fs.existsSync(sitePaths(world.config, 'my-blog').muPlugins)).toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = await siteReady();
    const res = await app.inject({ method: 'POST', url: '/api/sites/my-blog/wp/admin-login' });
    expect(res.statusCode).toBe(401);
  });
});
