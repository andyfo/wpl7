/**
 * What a PHP site has that a WordPress site does not, while it runs: its web root, its default
 * sender, its own test mail, and an uptime check that takes its own 404 for an answer.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { jobs, sites } from '../../src/db/schema.js';
import { httpProbeOnce } from '../../src/lib/httpProbe.js';
import { defaultMailFrom } from '../../src/services/mailAuth.js';
import { runtimeFilePaths } from '../../src/services/siteCaches.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { addPhpSite, makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

async function authed(w: TestWorld) {
  const { app } = await makeApp(w);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status), 20_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

/** A running PHP site with its mount sources written, as a start leaves them. */
async function runningPhpSite(w: TestWorld, slug = 'plain') {
  const site = addPhpSite(w, slug);
  await w.core.security.prepareHardening(w.servers.handleFor(1), site);
  return site;
}

describe('the web root', () => {
  it('goes into the site’s own Apache file in a virtual host, which is checked and reloaded in place', async () => {
    const w = await makeWorld();
    const site = await runningPhpSite(w);
    const { app, headers } = await authed(w);
    const res = await app.inject({ method: 'PUT', url: '/api/sites/plain/web-root', headers, payload: { webRoot: 'public' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ webRoot: 'public' });
    const apache = fs.readFileSync(sitePaths(w.config, 'plain').securityApacheConf, 'utf8');
    expect(apache).toContain('<VirtualHost *:80>\n    DocumentRoot "/var/www/html/public"\n</VirtualHost>');
    expect(apache).toContain('SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on');
    expect(w.docker.calls.some((c) => c.method === 'exec' && (c.args[1] as string[])[0] === 'apache2ctl')).toBe(true);
    expect(w.docker.signals).toContainEqual({ name: site.containerName, signal: 'SIGUSR1' });

    const back = await app.inject({ method: 'PUT', url: '/api/sites/plain/web-root', headers, payload: { webRoot: '' } });
    expect(back.json()).toMatchObject({ webRoot: '', webRootMissing: false });
    expect(fs.readFileSync(sitePaths(w.config, 'plain').securityApacheConf, 'utf8')).not.toContain('<VirtualHost');
  });

  it('is put back, with Apache’s words, when Apache refuses the file', async () => {
    const w = await makeWorld();
    await runningPhpSite(w);
    const { app, headers } = await authed(w);
    w.docker.apacheCheck = { stdout: '', stderr: 'AH00526: Syntax error on line 9 of /etc/apache2/conf-enabled/zz-wpl7-security.conf:\nInvalid command', exitCode: 1 };
    const res = await app.inject({ method: 'PUT', url: '/api/sites/plain/web-root', headers, payload: { webRoot: 'public' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/^Apache refused it, so the web root is as it was: AH00526: Syntax error on line 9/);
    expect(w.db.select().from(sites).get()!.webRoot).toBe('');
    expect(fs.readFileSync(sitePaths(w.config, 'plain').securityApacheConf, 'utf8')).not.toContain('<VirtualHost');
  });

  it('is a PHP site’s only, and a folder in it', async () => {
    const w = await makeWorld();
    await runningPhpSite(w);
    const { app, headers } = await authed(w);
    for (const webRoot of ['../x', 'a/../b', '/public', 'pub lic']) {
      expect((await app.inject({ method: 'PUT', url: '/api/sites/plain/web-root', headers, payload: { webRoot } })).statusCode).toBe(400);
    }
    w.db.update(sites).set({ app: 'wordpress' }).run();
    const wp = await app.inject({ method: 'PUT', url: '/api/sites/plain/web-root', headers, payload: { webRoot: 'public' } });
    expect([wp.statusCode, wp.json().error.message]).toEqual([409, '"plain" is a WordPress site: a web root is for PHP sites.']);
  });

  it('that is missing shows on the site’s detail, asked inside the container', async () => {
    const w = await makeWorld();
    addPhpSite(w, 'plain', { webRoot: 'public' });
    const { app, headers } = await authed(w);
    w.docker.execDefault = { stdout: '', stderr: '', exitCode: 1 };
    expect((await app.inject({ method: 'GET', url: '/api/sites/plain', headers })).json()).toMatchObject({ webRoot: 'public', webRootMissing: true });
    const ask = w.docker.calls.filter((c) => c.method === 'exec').at(-1)!;
    expect(ask.args[1]).toEqual(['test', '-d', '/var/www/html/public']);
    expect(ask.args[2]).toMatchObject({ user: '33:33' });
    w.docker.execDefault = { stdout: '', stderr: '', exitCode: 0 };
    expect((await app.inject({ method: 'GET', url: '/api/sites/plain', headers })).json()).toMatchObject({ webRootMissing: false });
    w.docker.containers.set('wp-plain', 'exited');
    expect((await app.inject({ method: 'GET', url: '/api/sites/plain', headers })).json()).toMatchObject({ webRootMissing: null });
  });
});

describe('the default sender', () => {
  it('is noreply@ a PHP site’s domain and wordpress@ a WordPress site’s, without www.', () => {
    expect(defaultMailFrom('php', 'www.Example.com')).toBe('noreply@example.com');
    expect(defaultMailFrom('wordpress', 'www.example.com')).toBe('wordpress@example.com');
    expect(defaultMailFrom('php', 'shop.dev.example.test')).toBe('noreply@shop.dev.example.test');
  });

  it('is written with the runtime files before a start, and again after a domain change', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain', { domains: ['plain.dev.example.test'] });
    const file = runtimeFilePaths(w.config, 'plain').mailFrom;
    const { ensureSiteMountSources } = await import('../../src/jobs/handlers/shared.js');
    await ensureSiteMountSources(w.servers.handleFor(1), w.core, site);
    expect(fs.readFileSync(file, 'utf8')).toBe('noreply@plain.dev.example.test\n');

    const job = w.deps.sites.updateDomains('plain', ['www.example.com'], true, true, { manageDns: false, allowSearchEngines: true });
    const done = await runJob(w, job.id);
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(fs.readFileSync(file, 'utf8')).toBe('noreply@example.com\n');
    // No WordPress to rewrite, and nothing told to search engines.
    expect(w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[])[0])).not.toContain('wp');
  });
});

describe("a site's test mail", () => {
  it("is PHP's mail() with no From header on a PHP site, with the address in the environment", async () => {
    const w = await makeWorld();
    addPhpSite(w, 'plain');
    const { app, headers } = await authed(w);
    w.docker.execQueue.push({ stdout: 'true', stderr: '', exitCode: 0 });
    const res = await app.inject({ method: 'POST', url: '/api/sites/plain/mail/test', headers, payload: { to: 'someone@example.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true });
    const sent = w.docker.calls.filter((c) => c.method === 'exec').at(-1)!;
    expect(sent.args[1]).toEqual(['php', '-r', "var_export(mail(getenv('WPL7_TO'), getenv('WPL7_SUBJECT'), getenv('WPL7_BODY')));"]);
    expect((sent.args[2] as { env: string[] }).env).toContain('WPL7_TO=someone@example.com');
    expect((sent.args[2] as { user: string }).user).toBe('33:33');
  });

  it('is wp_mail() on a WordPress site, and says what came back when it fails', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'blog');
    w.db.update(sites).set({ app: 'wordpress' }).where(eq(sites.id, site.id)).run();
    const { app, headers } = await authed(w);
    w.docker.execQueue.push({ stdout: 'false', stderr: 'msmtp: envelope-from address is missing', exitCode: 0 });
    const res = await app.inject({ method: 'POST', url: '/api/sites/blog/mail/test', headers, payload: { to: 'someone@example.com' } });
    expect(res.json()).toMatchObject({ accepted: false });
    expect(res.json().detail).toContain('envelope-from address is missing');
    expect((w.docker.calls.filter((c) => c.method === 'exec').at(-1)!.args[1] as string[]).slice(0, 2)).toEqual(['wp', 'eval']);
  });
});

describe('the uptime probe', () => {
  const answers: { status: number; headers: Record<string, string> }[] = [];
  const server = http.createServer((_req, res) => {
    const next = answers.shift() ?? { status: 200, headers: {} };
    res.writeHead(next.status, next.headers);
    res.end('x');
  });
  const ready = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)));
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const probe = async (status: number, headers: Record<string, string>, siteOwn4xx: boolean) => {
    answers.push({ status, headers });
    return (await httpProbeOnce(await ready, 'site.example.com', 2000, { siteOwn4xx })).ok;
  };

  it("takes a PHP site's own 4xx for an answer, and never Traefik's, nor a 5xx", async () => {
    const site = { 'x-cache-status': 'BYPASS' };
    expect(await probe(404, site, true)).toBe(true);
    expect(await probe(405, site, true)).toBe(true);
    // Traefik's own 404 for a host it does not route carries no such header.
    expect(await probe(404, {}, true)).toBe(false);
    expect(await probe(502, site, true)).toBe(false);
    expect(await probe(500, site, true)).toBe(false);
    // A WordPress site is as it was.
    expect(await probe(404, site, false)).toBe(false);
    expect(await probe(200, {}, false)).toBe(true);
  });
});

