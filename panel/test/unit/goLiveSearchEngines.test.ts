import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '../../src/db/schema.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

function seedCoreFilesOnStart(w: TestWorld): void {
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const p = sitePaths(w.config, name.slice(3));
    fs.mkdirSync(path.join(p.wordpress, 'wp-includes'), { recursive: true });
    fs.writeFileSync(path.join(p.wordpress, 'wp-config.php'), '<?php // config');
    fs.writeFileSync(path.join(p.wordpress, 'wp-includes', 'version.php'), "<?php $wp_version = '7.1.2';");
  };
}

async function runJob(w: TestWorld, jobId: number) {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    return row.status !== 'queued' && row.status !== 'running';
  }, 20_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

async function createSite(w: TestWorld, slug = 'launch') {
  seedCoreFilesOnStart(w);
  const { job } = w.deps.sites.create({
    title: 'Launch',
    slug,
    domainMode: 'dev',
    adminUser: 'boss',
    adminEmail: 'boss@example.test',
    discourageSearchEngines: true,
    plugins: { catalogIds: [], extraWporgSlugs: [] },
  });
  expect((await runJob(w, job.id)).status).toBe('succeeded');
  w.docker.calls.length = 0;
  return w.deps.sites.bySlug(slug);
}

/** Every command run in the site's container, and the container's starts and stops, in order. */
function timeline(w: TestWorld, container: string): string[] {
  return w.docker.calls
    .filter((c) => c.args[0] === container && ['exec', 'startContainer', 'stopContainer'].includes(c.method))
    .map((c) => (c.method === 'exec' ? (c.args[1] as string[]).join(' ') : c.method));
}

const ALLOW = 'wp option update blog_public 1';

describe('going live and search engines', () => {
  it('allows them by default, after the URLs are rewritten', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const done = await runJob(w, w.deps.sites.updateDomains(site.slug, ['launch.example.test'], true, true, { allowSearchEngines: true }).id);
    expect(done.error).toBeNull();
    const steps = timeline(w, site.containerName);
    const replaced = steps.findIndex((s) => s.startsWith('wp search-replace'));
    expect(replaced).toBeGreaterThan(-1);
    expect(steps.indexOf(ALLOW)).toBeGreaterThan(replaced);
  });

  it('leaves them alone when the box was unticked', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const done = await runJob(w, w.deps.sites.updateDomains(site.slug, ['launch.example.test'], true, true, { allowSearchEngines: false }).id);
    expect(done.error).toBeNull();
    expect(timeline(w, site.containerName)).not.toContain(ALLOW);
  });

  it('never touches them on a plain domain change', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const job = w.deps.sites.updateDomains(site.slug, ['launch.example.test'], true, false, { allowSearchEngines: true });
    expect(JSON.parse(job.payload).allowSearchEngines).toBe(false);
    expect((await runJob(w, job.id)).error).toBeNull();
    expect(timeline(w, site.containerName)).not.toContain(ALLOW);
  });

  it('starts a stopped site for it and stops it again', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    w.docker.containers.set(site.containerName, 'exited');
    const done = await runJob(w, w.deps.sites.updateDomains(site.slug, ['launch.example.test'], true, true, { allowSearchEngines: true }).id);
    expect(done.error).toBeNull();
    const steps = timeline(w, site.containerName);
    const allowed = steps.indexOf(ALLOW);
    expect(allowed).toBeGreaterThan(-1);
    // Started for the rewrite (the last start before it, with no stop in between), stopped after.
    const before = steps.slice(0, allowed);
    expect(before.lastIndexOf('startContainer')).toBeGreaterThan(before.lastIndexOf('stopContainer'));
    expect(steps.at(-1)).toBe('stopContainer');
    expect(w.docker.containers.get(site.containerName)).toBe('exited');
  });

  it('a failure to allow them is a warning, not a failed go-live', async () => {
    const w = await makeWorld();
    const site = await createSite(w);
    const wp = w.servers.handleFor(1).wp;
    const real = wp.searchEngineVisibility.bind(wp);
    wp.searchEngineVisibility = async (container, visible) => {
      if (visible) throw new Error('wp option update failed');
      return real(container, visible);
    };
    const done = await runJob(w, w.deps.sites.updateDomains(site.slug, ['launch.example.test'], true, true, { allowSearchEngines: true }).id);
    expect(done.status).toBe('succeeded');
    expect(w.deps.sites.bySlug(site.slug).isLive).toBe(1);
  });

  it('the API allows them unless asked not to, on go-live only', async () => {
    const { app, world } = await makeApp();
    await createSite(world);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    const sid = login.cookies.find((x) => x.name === 'panel.sid')!;
    const headers = { cookie: `${sid.name}=${sid.value}`, 'x-csrf': '1' };
    const payloadOf = (id: number) => JSON.parse(world.db.select().from(jobs).where(eq(jobs.id, id)).get()!.payload);

    const goLive = await app.inject({ method: 'POST', url: '/api/sites/launch/go-live', headers, payload: { domains: ['launch.example.test'] } });
    expect(goLive.statusCode, goLive.body).toBe(202);
    expect(payloadOf(goLive.json().job.id)).toMatchObject({ goLive: true, allowSearchEngines: true });
    world.db.update(jobs).set({ status: 'canceled' }).where(eq(jobs.id, goLive.json().job.id)).run();

    const unticked = await app.inject({
      method: 'POST',
      url: '/api/sites/launch/go-live',
      headers,
      payload: { domains: ['launch.example.test'], allowSearchEngines: false },
    });
    expect(payloadOf(unticked.json().job.id)).toMatchObject({ allowSearchEngines: false });
    world.db.update(jobs).set({ status: 'canceled' }).where(eq(jobs.id, unticked.json().job.id)).run();

    const edit = await app.inject({ method: 'PUT', url: '/api/sites/launch/domains', headers, payload: { domains: ['launch.example.test'] } });
    expect(edit.statusCode, edit.body).toBe(202);
    expect(payloadOf(edit.json().job.id)).toMatchObject({ goLive: false, allowSearchEngines: false });
  });
});
