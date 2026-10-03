import { describe, expect, it } from 'vitest';
import { sites, siteWpComponents } from '../../src/db/schema.js';
import { makeApp, makeWorld } from '../helpers.js';

async function authedApp() {
  const w = await makeWorld();
  const { app } = await makeApp(w);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world: w, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

type Item = { id: string; installed: boolean; enabled: boolean; source: string; inputs: { id: string; set: boolean; display: string | null }[] };

describe('recipes API', () => {
  it('installs a recipe, stores its key masked, switches it off, and uninstalls it with the key', async () => {
    const { app, headers } = await authedApp();

    const before = await app.inject({ method: 'GET', url: '/api/recipes', headers });
    expect(before.statusCode).toBe(200);
    const items = before.json().items as Item[];
    expect(items.map((i) => i.id)).toEqual(['acf-pro', 'breakdance']);
    expect(items.every((i) => !i.installed && i.inputs.every((input) => !input.set))).toBe(true);

    // A key needs an installed recipe.
    expect((await app.inject({ method: 'PUT', url: '/api/recipes/breakdance/inputs/key', headers, payload: { value: 'abc123def456ghi7' } })).statusCode).toBe(400);

    const install = await app.inject({ method: 'POST', url: '/api/recipes/breakdance/install', headers });
    expect(install.statusCode).toBe(200);
    expect(install.json().recipe).toMatchObject({ id: 'breakdance', installed: true, enabled: true, source: 'bundled' });

    const put = await app.inject({ method: 'PUT', url: '/api/recipes/breakdance/inputs/key', headers, payload: { value: 'abc123def456ghi7' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().recipe.inputs).toEqual([expect.objectContaining({ id: 'key', label: 'License key', secret: true, set: true })]);
    expect(put.json().recipe.inputs[0].display).toMatch(/ghi7$/);
    expect(put.body).not.toContain('abc123def456ghi7');

    const off = await app.inject({ method: 'PUT', url: '/api/recipes/breakdance/enabled', headers, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().recipe.enabled).toBe(false);

    const definition = await app.inject({ method: 'GET', url: '/api/recipes/breakdance/definition', headers });
    expect(definition.json().recipe).toMatchObject({ id: 'breakdance', plugin: 'breakdance', type: 'plugin-recipe' });

    expect((await app.inject({ method: 'DELETE', url: '/api/recipes/breakdance/install', headers })).statusCode).toBe(204);
    const after = (await app.inject({ method: 'GET', url: '/api/recipes', headers })).json().items as Item[];
    expect(after.find((i) => i.id === 'breakdance')).toMatchObject({ installed: false, enabled: false, inputs: [expect.objectContaining({ set: false })] });
  });

  it('takes a local recipe and rejects one that does not validate', async () => {
    const { app, headers } = await authedApp();
    const bad = await app.inject({ method: 'POST', url: '/api/recipes/local', headers, payload: { recipe: { type: 'plugin-recipe', typeVersion: 1, id: 'x' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/Not a valid recipe/);

    const good = await app.inject({
      method: 'POST',
      url: '/api/recipes/local',
      headers,
      payload: { recipe: { type: 'plugin-recipe', typeVersion: 1, id: 'my-plugin', name: 'My plugin', plugin: 'my-plugin', hooks: { afterUrlChange: [{ run: 'wp', args: ['cache', 'flush'] }] } } },
    });
    expect(good.statusCode).toBe(201);
    expect(good.json().recipe).toMatchObject({ id: 'my-plugin', source: 'local', installed: true, enabled: true, description: 'Its steps when a site moves to its own domain.' });
    expect((await app.inject({ method: 'DELETE', url: '/api/recipes/my-plugin/install', headers })).statusCode).toBe(204);
    expect(((await app.inject({ method: 'GET', url: '/api/recipes', headers })).json().items as Item[]).map((i) => i.id)).toEqual(['acf-pro', 'breakdance']);
  });

  it('rejects unknown recipes, unknown inputs and empty values', async () => {
    const { app, headers } = await authedApp();
    expect((await app.inject({ method: 'POST', url: '/api/recipes/nope/install', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/recipes/nope/inputs/key', headers, payload: { value: 'abc123def456' } })).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: '/api/recipes/breakdance/install', headers });
    expect((await app.inject({ method: 'PUT', url: '/api/recipes/breakdance/inputs/email', headers, payload: { value: 'me@example.com' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/recipes/breakdance/inputs/key', headers, payload: { value: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/recipes/breakdance/inputs/Not-An-Id', headers, payload: { value: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/recipes/breakdance/inputs/key', headers })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/recipes' })).statusCode).toBe(401);
  });

  it('shows per-site status for installed recipes and queues an activation job', async () => {
    const { app, headers, world } = await authedApp();
    const now = Date.now();
    const site = world.db
      .insert(sites)
      .values({
        slug: 'shop',
        title: 'Shop',
        domains: JSON.stringify(['shop.test']),
        phpVersion: '8.3',
        status: 'running',
        dbName: 'shop',
        dbUser: 'shop',
        dbPassword: 'x',
        containerName: 'wp-shop',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    world.db
      .insert(siteWpComponents)
      .values({ siteId: site.id, kind: 'plugin', slug: 'breakdance', title: 'Breakdance', status: 'active', version: '2.7.0', seenAt: Date.now() })
      .run();

    // Not installed: nothing to show, even though the plugin is there.
    expect((await app.inject({ method: 'GET', url: `/api/sites/${site.slug}/wp/recipes`, headers })).json().items).toEqual([]);
    await app.inject({ method: 'POST', url: '/api/recipes/breakdance/install', headers });
    const status = await app.inject({ method: 'GET', url: `/api/sites/${site.slug}/wp/recipes`, headers });
    expect(status.statusCode).toBe(200);
    expect(status.json().items).toEqual([
      expect.objectContaining({ recipeId: 'breakdance', installed: true, pluginStatus: 'active', ready: false, status: 'unknown' }),
    ]);

    const apply = await app.inject({ method: 'POST', url: `/api/sites/${site.slug}/wp/recipes/apply`, headers, payload: { recipeId: 'breakdance' } });
    expect(apply.statusCode).toBe(202);
    expect(apply.json().job.type).toBe('wp.recipes');
    expect((await app.inject({ method: 'POST', url: `/api/sites/${site.slug}/wp/recipes/apply`, headers, payload: { recipeId: 'nope' } })).statusCode).toBe(404);
  });
});
