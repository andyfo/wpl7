import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, sites } from '../../src/db/schema.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { FakeExec, makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

/**
 * A PHP site from New site: the same job as a WordPress site, without WordPress's part, and with
 * the folder handed to the site's user by the job, since no entrypoint does it.
 */

type Spec = { image: string; labels: Record<string, string>; env: Record<string, string>; binds: string[] };

async function runCreate(w: TestWorld, body: Parameters<TestWorld['deps']['sites']['create']>[0]) {
  const { site, job } = w.deps.sites.create(body);
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  return { site, job: w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()! };
}

const phpBody = { title: 'Plain <PHP>', slug: 'plain', domainMode: 'dev' as const, app: 'php' as const };

const creates = (w: TestWorld) => w.docker.calls.filter((c) => c.method === 'createSiteContainer').map((c) => c.args[0] as Spec);
const dockerExecs = (w: TestWorld) => w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));

describe('site.create for a PHP site', () => {
  it('makes a site with no WordPress, no database, a placeholder page and a folder its user owns', async () => {
    const exec = new FakeExec();
    const w = await makeWorld({ exec });
    const { site, job } = await runCreate(w, phpBody);

    expect(job.status, job.error ?? '').toBe('succeeded');
    const row = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect([row.status, row.app, row.webRoot, row.dbName, row.dbUser, row.dbPassword]).toEqual(['running', 'php', '', '', '', '']);
    expect([row.wpAdminUser, row.wpAdminEmail]).toEqual([null, null]);

    // One container, routed from the start: no unrouted phase, which is for WordPress's installer.
    const [spec, ...more] = creates(w);
    expect(more).toEqual([]);
    expect(spec!.labels['traefik.http.routers.wp-plain.rule']).toBe('Host(`plain.dev.example.test`)');
    expect(spec!.labels['wpl7.app']).toBe('php');
    expect(spec!.labels['wpl7.role']).toBe('wordpress');
    expect(Object.keys(spec!.env).filter((k) => k.startsWith('WORDPRESS_'))).toEqual([]);
    expect(spec!.binds.some((b) => b.startsWith(`${w.config.paths.plugins}:`))).toBe(false);

    // Nothing WordPress, and no database.
    expect(dockerExecs(w).filter((c) => c.startsWith('wp '))).toEqual([]);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'createSiteDb')).toEqual([]);

    const p = sitePaths(w.config, 'plain');
    const page = fs.readFileSync(path.join(p.wordpress, 'index.html'), 'utf8');
    expect(page).toContain('<h1>Plain &#60;PHP&#62;</h1>');
    expect(page).toContain('This site is ready. Upload your files to replace this page.');
    expect(fs.readdirSync(p.wordpress)).toEqual(['index.html']);
    expect(exec.calls.find((c) => c.cmd === 'chown')).toEqual({ method: 'run', cmd: 'chown', args: ['-R', '33:33', p.wordpress] });

    // The address and nothing to hand over.
    expect(JSON.parse(job.result!)).toEqual({ url: 'http://plain.dev.example.test', slug: 'plain' });
    // The site's own Apache file: HTTPS for PHP, no web root, no uploads rule.
    const apache = fs.readFileSync(p.securityApacheConf, 'utf8');
    expect(apache).toContain('SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on');
    expect(apache).not.toContain('<VirtualHost');
    expect(apache).not.toContain('wp-content/uploads');
  });

  it('makes its database when asked, and the web root with the page in it', async () => {
    const w = await makeWorld();
    const { site, job } = await runCreate(w, { ...phpBody, database: true, webRoot: 'public' });

    expect(job.status, job.error ?? '').toBe('succeeded');
    const row = w.db.select().from(sites).where(eq(sites.id, site.id)).get()!;
    expect([row.dbName, row.dbUser, row.webRoot]).toEqual(['wp_plain', 'wp_plain', 'public']);
    expect(row.dbPassword).toMatch(/^.{24,}$/);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'createSiteDb').map((c) => c.args.slice(0, 2))).toEqual([['wp_plain', 'wp_plain']]);

    const p = sitePaths(w.config, 'plain');
    expect(fs.readdirSync(p.wordpress)).toEqual(['public']);
    expect(fs.existsSync(path.join(p.wordpress, 'public', 'index.html'))).toBe(true);
    expect(fs.readFileSync(p.securityApacheConf, 'utf8')).toContain('<VirtualHost *:80>\n    DocumentRoot "/var/www/html/public"\n</VirtualHost>');
  });

  it('is refused on an image from before PHP sites, and leaves nothing behind', async () => {
    const w = await makeWorld();
    w.docker.appsOf('wpl7-wordpress:php8.3', ['wordpress']);
    const { site, job } = await runCreate(w, { ...phpBody, database: true });

    expect(job.status).toBe('failed');
    expect(job.error).toBe('The site image on "local" is from before PHP sites. Update the server, then try again.');
    expect(w.db.select().from(sites).where(eq(sites.id, site.id)).get()).toBeUndefined();
    expect(creates(w)).toEqual([]);
    expect(fs.existsSync(sitePaths(w.config, 'plain').root)).toBe(false);
    expect(w.dbAdmin.calls.filter((c) => c.method === 'dropSiteDb').map((c) => c.args[0])).toEqual(['wp_plain']);
  });
});

describe('POST /api/sites for a PHP site', () => {
  async function authed(w: TestWorld) {
    const { app } = await makeApp(w);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
  }

  it('takes the PHP fields, and refuses the WordPress ones by name', async () => {
    const w = await makeWorld();
    const { app, headers } = await authed(w);
    const refused = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers,
      payload: { ...phpBody, adminUser: 'boss', locale: 'de_DE', discourageSearchEngines: true },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details).toEqual([
      { path: '/locale', message: 'locale is for WordPress sites only' },
      { path: '/adminUser', message: 'adminUser is for WordPress sites only' },
      { path: '/discourageSearchEngines', message: 'discourageSearchEngines is for WordPress sites only' },
    ]);

    const wordpress = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: { title: 'Blog', domainMode: 'dev', database: true, webRoot: 'public' } });
    expect(wordpress.statusCode).toBe(400);
    expect(wordpress.json().error.details).toEqual([
      { path: '/database', message: 'database is for PHP sites only' },
      { path: '/webRoot', message: 'webRoot is for PHP sites only' },
      { path: '/adminUser', message: 'adminUser is required for a WordPress site' },
    ]);

    for (const webRoot of ['../etc', '/public', 'public/', 'a//b', '.', 'pub lic', 'pub"lic', 'x'.repeat(101)]) {
      const bad = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: { ...phpBody, webRoot } });
      expect([webRoot, bad.statusCode]).toEqual([webRoot, 400]);
    }

    const ok = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: { ...phpBody, database: true, webRoot: 'app/public' } });
    expect(ok.statusCode).toBe(202);
    const row = w.db.select().from(sites).where(eq(sites.slug, 'plain')).get()!;
    expect([row.app, row.webRoot, row.dbName]).toEqual(['php', 'app/public', 'wp_plain']);
    const job = w.db.select().from(jobs).where(eq(jobs.type, 'site.create')).get()!;
    expect(JSON.parse(job.payload)).toEqual({ siteId: row.id });
  });

  it('a WordPress body from before PHP sites works as it did', async () => {
    const w = await makeWorld();
    const { app, headers } = await authed(w);
    const res = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: { title: 'Blog', domainMode: 'dev', adminUser: 'boss', adminEmail: 'boss@example.com' } });
    expect(res.statusCode).toBe(202);
    const row = w.db.select().from(sites).where(eq(sites.slug, 'blog')).get()!;
    expect([row.app, row.webRoot, row.dbName, row.wpAdminUser]).toEqual(['wordpress', '', 'wp_blog', 'boss']);
    const payload = JSON.parse(w.db.select().from(jobs).where(eq(jobs.type, 'site.create')).get()!.payload);
    expect(payload.discourageSearchEngines).toBe(true);
  });

  it('is refused before anything is made on a server whose image is older, and taken where the image is not there yet', async () => {
    const w = await makeWorld();
    const { app, headers } = await authed(w);
    w.docker.appsOf('wpl7-wordpress:php8.3', ['wordpress']);
    const old = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: phpBody });
    expect(old.statusCode).toBe(409);
    expect(old.json().error.message).toBe('The site image on "local" is from before PHP sites. Update the server, then try again.');
    expect(w.db.select().from(sites).all()).toEqual([]);

    // The panel builds or pulls the image at its own version, which can run one.
    w.docker.images.delete('wpl7-wordpress:php8.3');
    const missing = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: phpBody });
    expect(missing.statusCode).toBe(202);
  });
});
