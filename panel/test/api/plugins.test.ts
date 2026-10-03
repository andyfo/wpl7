import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '../../src/db/schema.js';
import { makeApp, makeWorld, zipOf } from '../helpers.js';

/** A multipart upload of `file` under the field name the route reads. */
function multipart(file: Buffer, filename: string) {
  const boundary = '----wpl7-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function authedApp(world?: Awaited<ReturnType<typeof makeWorld>>) {
  const w = world ?? (await makeWorld());
  const { app } = await makeApp(w);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world: w, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

describe('plugin catalog API', () => {
  it('rejects an empty patch with 400 instead of a drizzle 500', async () => {
    const { app, headers } = await authedApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      headers,
      payload: { kind: 'wporg', slug: 'akismet' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json().plugin as { id: number };

    const empty = await app.inject({ method: 'PUT', url: `/api/plugins/${id}`, headers, payload: {} });
    expect(empty.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/plugins/${id}`,
      headers,
      payload: { isDefault: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().plugin.isDefault).toBe(true);
  });
});

describe('wordpress.org plugin search', () => {
  it('returns directory matches for the typeahead', async () => {
    const { app, headers, world } = await authedApp();
    world.wporg.add('wordpress-seo', { name: 'Yoast SEO' });

    const res = await app.inject({ method: 'GET', url: '/api/plugins/search?q=seo', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((p: { slug: string }) => p.slug)).toContain('wordpress-seo');
  });

  it('rejects a one-character query rather than searching the whole directory', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/api/plugins/search?q=s', headers });
    expect(res.statusCode).toBe(400);
  });

  it('needs a session like every other panel route', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/api/plugins/search?q=seo' });
    expect(res.statusCode).toBe(401);
  });

  it('surfaces an unreachable directory as 502', async () => {
    const { app, headers, world } = await authedApp();
    world.wporg.goOffline();

    const res = await app.inject({ method: 'GET', url: '/api/plugins/search?q=seo', headers });

    expect(res.statusCode).toBe(502);
  });
});

describe('adding a wordpress.org plugin to the catalog', () => {
  it('rejects a slug that is not in the directory and leaves the catalog empty', async () => {
    const { app, headers } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      headers,
      payload: { kind: 'wporg', slug: 'woo-comerce' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/not a plugin on wordpress.org/);
    const list = await app.inject({ method: 'GET', url: '/api/plugins', headers });
    expect(list.json().items).toHaveLength(0);
  });

  it('fills in the directory name when none is given', async () => {
    const { app, headers, world } = await authedApp();
    world.wporg.add('wordpress-seo', { name: 'Yoast SEO – Advanced SEO' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      headers,
      payload: { kind: 'wporg', slug: 'wordpress-seo' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().plugin.name).toBe('Yoast SEO – Advanced SEO');
  });

  it('answers 502 when the directory is unreachable, and accepts force as the way through', async () => {
    const { app, headers, world } = await authedApp();
    world.wporg.goOffline();

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      headers,
      payload: { kind: 'wporg', slug: 'akismet' },
    });
    expect(blocked.statusCode).toBe(502);

    const forced = await app.inject({
      method: 'POST',
      url: '/api/plugins',
      headers,
      payload: { kind: 'wporg', slug: 'akismet', force: true },
    });
    expect(forced.statusCode).toBe(201);
  });
});

describe("an uploaded zip's malware check", () => {
  const ZIP = zipOf({ 'premium-pro/': '', 'premium-pro/premium-pro.php': '<?php\n/* Plugin Name: Premium Pro\nVersion: 2.0 */\n', 'premium-pro/lib/rsa.php': '<?php' });
  const line = (o: object) => JSON.stringify(o);

  it('is queued by the upload, shown with the catalog, and reviewed by a person', async () => {
    const { app, world: w, headers } = await authedApp();
    const up = multipart(ZIP, 'premium-pro-2.0.zip');
    const uploaded = await app.inject({ method: 'POST', url: '/api/plugins/upload', headers: { ...headers, ...up.headers }, payload: up.payload });
    expect(uploaded.statusCode).toBe(201);
    const { id } = uploaded.json().plugin as { id: number };
    const queued = w.db.select().from(jobs).where(eq(jobs.type, 'plugin.zipCheck')).all();
    expect(queued.map((j) => [JSON.parse(j.payload), j.lane])).toEqual([[{ pluginId: id }, 'scan:1']]);

    const listed = (await app.inject({ method: 'GET', url: '/api/plugins', headers })).json().items as { id: number; check: unknown }[];
    expect(listed.find((p) => p.id === id)!.check).toMatchObject({ status: 'pending', checking: true, needsReview: false });

    w.docker.ephemeral = () => ({
      stdout: [
        line({ t: 'zipfile', path: 'premium-pro.php', sha256: 'a'.repeat(64) }),
        line({ t: 'zipfile', path: 'lib/rsa.php', sha256: 'b'.repeat(64) }),
        line({ t: 'zipsummary', folder: 'premium-pro', found: true, files: 2, unreadable: 0, truncated: false, name: 'Premium Pro', version: '2.0', unzip: 0 }),
        line({ t: 'finding', path: 'premium-pro/lib/rsa.php', rule: 'sign:e8cdb6a1', severity: 'danger', message: 'Malware Signature', line: 230, match: '.ssh/authorized_keys' }),
        line({ t: 'summary', engine: 'signatures', exit: 1, report: true, scanned: 2, complete: true, errors: 0, unreadable: 0, findings: 1, truncated: false }),
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });
    await w.core.pluginZipChecks.run({ info: () => undefined, warn: () => undefined, checkCanceled: () => undefined }, id);
    w.db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.type, 'plugin.zipCheck')).run();

    const details = await app.inject({ method: 'GET', url: `/api/plugins/${id}/check`, headers });
    expect(details.json()).toMatchObject({
      check: { status: 'done', checking: false, folder: 'premium-pro', version: '2.0', files: 2, flagged: 1, confirmed: 1, needsReview: true },
      findings: [{ path: 'lib/rsa.php', kind: 'signature', label: 'Known malware', severity: 'high', line: 230, detail: 'Malware Signature: .ssh/authorized_keys' }],
    });
    const reviewed = await app.inject({ method: 'POST', url: `/api/plugins/${id}/check/review`, headers });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().check).toMatchObject({ needsReview: false, reviewed: { by: 'admin' } });

    const again = await app.inject({ method: 'POST', url: `/api/plugins/${id}/check`, headers });
    expect(again.statusCode).toBe(202);
    expect(again.headers.location).toBe(`/api/jobs/${again.json().job.id}`);
    expect(again.json().job).toMatchObject({ type: 'plugin.zipCheck', status: 'queued' });
  });

  it("is not a wordpress.org plugin's, and is not queued while scans are off", async () => {
    const { app, world: w, headers } = await authedApp();
    w.wporg.add('akismet', { name: 'Akismet' });
    const created = await app.inject({ method: 'POST', url: '/api/plugins', headers, payload: { kind: 'wporg', slug: 'akismet' } });
    const { id } = created.json().plugin as { id: number };
    expect((await app.inject({ method: 'GET', url: `/api/plugins/${id}/check`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/plugins/${id}/check`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/plugins/${id}/check/review`, headers })).statusCode).toBe(400);

    w.core.settings.set('scanEnabled', false);
    const up = multipart(ZIP, 'premium-pro-2.0.zip');
    expect((await app.inject({ method: 'POST', url: '/api/plugins/upload', headers: { ...headers, ...up.headers }, payload: up.payload })).statusCode).toBe(201);
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'plugin.zipCheck')).all()).toEqual([]);
  });
});
