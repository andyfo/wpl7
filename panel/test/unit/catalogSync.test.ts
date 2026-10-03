import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CatalogSyncService } from '../../src/services/catalogSync.js';
import { RecipeCatalog } from '../../src/services/catalog.js';
import { makeTestConfig, makeWorld } from '../helpers.js';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const INDEX_URL = 'https://catalog.test/v1/index.json';

/** A signing key of the test's own; the panel is told its public half through the env. */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  return { privateKey, pem: publicKey.export({ type: 'spki', format: 'pem' }) as string, keyId };
}

const bundledLike = (id: string, plugin: string, extra: Record<string, unknown> = {}) => ({
  type: 'plugin-recipe',
  typeVersion: 1,
  id,
  name: id,
  plugin,
  inputs: [{ id: 'key', label: 'License key' }],
  hooks: { afterInstall: [{ run: 'wp', args: ['x', 'license', '{{inputs.key}}'] }] },
  ...extra,
});

function publish(entries: unknown[], privateKey: crypto.KeyObject, keyId: string, opts: { commit?: string } = {}) {
  const index = { format: 'wpl7-catalog', formatVersion: 1, generatedAt: '2026-09-22T10:00:00Z', commit: opts.commit ?? 'abc1234', entries };
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + '\n');
  const signature = crypto.sign(null, bytes, privateKey).toString('base64');
  return { bytes, sig: { alg: 'ed25519', keyId, signature } };
}

/** Serves one published index (+ signature) with an ETag, like GitHub Pages does. */
function serve(pub: { bytes: Buffer; sig: unknown }, opts: { etag?: string; indexStatus?: number } = {}): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('.sig')) return new Response(JSON.stringify(pub.sig), { status: 200 });
    const inm = new Headers(init?.headers).get('if-none-match');
    if (opts.etag && inm === opts.etag) return new Response(null, { status: 304 });
    return new Response(pub.bytes, { status: opts.indexStatus ?? 200, headers: opts.etag ? { etag: opts.etag } : {} });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

const configFor = (pem: string, url = INDEX_URL) => makeTestConfig({ WPL7_CATALOG_URL: url, WPL7_CATALOG_PUBLIC_KEY: pem });

describe('CatalogSyncService', () => {
  it('applies a verified index over the bundled recipes and counts what it cannot use', async () => {
    const { privateKey, pem, keyId } = keypair();
    const pub = publish(
      [
        bundledLike('breakdance', 'breakdance', { description: 'from the catalog' }),
        bundledLike('example', 'example-pro'),
        { type: 'site-blueprint', typeVersion: 1, id: 'shop-starter' },
      ],
      privateKey,
      keyId,
    );
    const w = await makeWorld({ config: configFor(pem), catalogFetch: serve(pub, { etag: '"v1"' }) });

    expect(await w.core.catalogSync.refresh()).toBe('updated');

    const catalog = w.core.licenses.catalog;
    expect(catalog.byId('breakdance')?.description).toBe('from the catalog');
    expect(catalog.sourceOf('breakdance')).toBe('catalog');
    expect(catalog.sourceOf('acf-pro')).toBe('bundled');
    expect(catalog.byId('example')).not.toBeNull();
    expect(catalog.superseded).toEqual(['breakdance']);
    const state = w.core.catalogSync.state();
    expect(state).toMatchObject({ url: INDEX_URL, entries: 3, unsupported: 1, error: null, keyId, commit: 'abc1234', recipes: { catalog: 2, bundled: 1 } });
    expect(state.fetchedAt).not.toBeNull();
    expect(state.changedAt).not.toBeNull();
    expect(w.core.licenses.list().map((l) => `${l.id}:${l.source}`)).toEqual(['acf-pro:bundled', 'breakdance:catalog', 'example:catalog']);
  });

  it('uses the ETag and reports an unchanged catalog without touching anything', async () => {
    const { privateKey, pem, keyId } = keypair();
    const pub = publish([bundledLike('example', 'example-pro')], privateKey, keyId);
    const fetchImpl = serve(pub, { etag: '"v1"' });
    const w = await makeWorld({ config: configFor(pem), catalogFetch: fetchImpl });
    expect(await w.core.catalogSync.refresh()).toBe('updated');
    const changedAt = w.core.catalogSync.state().changedAt;

    expect(await w.core.catalogSync.refresh()).toBe('unchanged');
    expect(fetchImpl.calls.filter((u) => u.endsWith('.sig'))).toHaveLength(1);
    expect(w.core.catalogSync.state().changedAt).toBe(changedAt);
    // A forced fetch skips the ETag, re-verifies, and finds the same content.
    expect(await w.core.catalogSync.refresh({ force: true })).toBe('unchanged');
    expect(fetchImpl.calls.filter((u) => u.endsWith('.sig'))).toHaveLength(2);
  });

  it('refuses an index whose signature does not verify, and keeps the previous copy', async () => {
    const { privateKey, pem, keyId } = keypair();
    const good = publish([bundledLike('example', 'example-pro')], privateKey, keyId);
    const w = await makeWorld({ config: configFor(pem), catalogFetch: serve(good) });
    expect(await w.core.catalogSync.refresh()).toBe('updated');

    // Same signature, one byte more: what a tampering mirror or a truncating proxy looks like.
    const tampered = { bytes: Buffer.concat([good.bytes, Buffer.from(' ')]), sig: good.sig };
    const sync = new CatalogSyncService(w.db, w.config, w.core.settings, w.core.licenses.catalog, quiet, { fetchImpl: serve(tampered) });
    expect(await sync.refresh()).toBe('failed');
    expect(sync.state().error).toMatch(/signature does not verify/);
    expect(w.core.licenses.catalog.byId('example')).not.toBeNull();
    expect(sync.state().entries).toBe(1);

    // Signed by somebody else entirely.
    const other = keypair();
    const foreign = publish([bundledLike('evil', 'evil')], other.privateKey, other.keyId);
    const sync2 = new CatalogSyncService(w.db, w.config, w.core.settings, w.core.licenses.catalog, quiet, { fetchImpl: serve(foreign) });
    expect(await sync2.refresh()).toBe('failed');
    expect(w.core.licenses.catalog.byId('evil')).toBeNull();
  });

  it('reports an unreachable catalog and a bad answer without losing the bundled recipes', async () => {
    const { pem } = keypair();
    const w = await makeWorld({
      config: configFor(pem),
      catalogFetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND catalog.test');
      },
    });
    expect(await w.core.catalogSync.refresh()).toBe('failed');
    expect(w.core.catalogSync.state().error).toMatch(/could not reach the catalog/);
    expect(w.core.licenses.catalog.list().map((r) => r.id)).toEqual(['acf-pro', 'breakdance']);

    const sync = new CatalogSyncService(w.db, w.config, w.core.settings, w.core.licenses.catalog, quiet, {
      fetchImpl: async () => new Response('nope', { status: 503 }),
    });
    expect(await sync.refresh()).toBe('failed');
    expect(sync.state().error).toMatch(/HTTP 503/);
  });

  it('boots from the stored copy without fetching', async () => {
    const { privateKey, pem, keyId } = keypair();
    const pub = publish([bundledLike('example', 'example-pro')], privateKey, keyId);
    const w = await makeWorld({ config: configFor(pem), catalogFetch: serve(pub) });
    expect(await w.core.catalogSync.refresh()).toBe('updated');

    const catalog = new RecipeCatalog(quiet);
    const sync = new CatalogSyncService(w.db, w.config, w.core.settings, catalog, quiet, {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    sync.rebuild();
    expect(catalog.byId('example')).not.toBeNull();
    expect(catalog.sourceOf('example')).toBe('catalog');
    expect(catalog.byId('acf-pro')).not.toBeNull();
  });

  it('is off when told so, and then uses only the bundled recipes', async () => {
    const w = await makeWorld({ config: makeTestConfig({ WPL7_CATALOG_URL: 'off' }) });
    expect(w.core.catalogSync.enabled).toBe(false);
    expect(await w.core.catalogSync.refresh()).toBe('disabled');
    expect(w.core.catalogSync.state()).toMatchObject({ url: null, entries: 0, error: null, recipes: { catalog: 0, bundled: 2 } });
  });

  it('accepts the public key as a bare base64 body in the env', async () => {
    const { privateKey, pem, keyId } = keypair();
    const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const pub = publish([bundledLike('example', 'example-pro')], privateKey, keyId);
    const w = await makeWorld({ config: configFor(body), catalogFetch: serve(pub) });
    expect(await w.core.catalogSync.refresh()).toBe('updated');
  });

  it('rejects an index in a format it does not read, and one that is not JSON', async () => {
    const { privateKey, pem, keyId } = keypair();
    const v2 = Buffer.from(JSON.stringify({ format: 'wpl7-catalog', formatVersion: 2, generatedAt: 'x', entries: [] }));
    const sigFor = (bytes: Buffer) => ({ alg: 'ed25519', keyId, signature: crypto.sign(null, bytes, privateKey).toString('base64') });
    const w = await makeWorld({ config: configFor(pem), catalogFetch: serve({ bytes: v2, sig: sigFor(v2) }) });
    expect(await w.core.catalogSync.refresh()).toBe('failed');
    expect(w.core.catalogSync.state().error).toMatch(/not in the expected format/);

    const garbage = Buffer.from('<html>');
    const sync = new CatalogSyncService(w.db, w.config, w.core.settings, w.core.licenses.catalog, quiet, {
      fetchImpl: serve({ bytes: garbage, sig: sigFor(garbage) }),
    });
    expect(await sync.refresh()).toBe('failed');
    expect(sync.state().error).toMatch(/not valid JSON/);
  });
});
