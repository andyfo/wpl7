import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConnectClient, connectCanonical, connectKeyPair, connectSignature } from '../../src/services/connectClient.js';
import { PluginSourceError, type PullResponse, type PullTransport } from '../../src/services/pluginClient.js';

/** The panel's side of the Connect protocol, held to the shared vectors (panel/test/fixtures/connectProtocol.json). */

const vectors = JSON.parse(fs.readFileSync(new URL('../fixtures/connectProtocol.json', import.meta.url), 'utf8')) as {
  keyPair: { publicKey: string; privateKeyPem: string };
  signature: { connectionId: string; home: string; homeHeader: string; action: string; timestamp: number; nonce: string; body: string; canonical: string; signature: string }[];
  homes: { header: string; home: string }[];
};

const lookup = async () => [{ address: '203.0.113.80', family: 4 }];

const plugin = (status: number, body: unknown, headers: Record<string, string> = {}): PullResponse => ({
  status,
  headers: { 'content-type': 'application/json', 'x-wpl7-connect': '1', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});

const PING = { protocol: 1, plugin: '0.4.0', time: Math.floor(Date.now() / 1000), limits: { max_ms: 10000, max_bytes: 65536, max_row_bytes: 1e6 }, encodings: ['raw', 'base64', 'gzip'] };

function clientOf(transport: PullTransport) {
  return new ConnectClient({
    connectionId: 7,
    privateKey: vectors.keyPair.privateKeyPem,
    home: 'https://example.com',
    endpoint: 'https://example.com/wp-json/wpl7-connect/v1/',
    allowHttp: false,
    transport,
    lookup,
    sleep: async () => undefined,
  });
}

describe('signing a Connect request', () => {
  it('builds the canonical string and the Ed25519 signature of every vector', () => {
    for (const v of vectors.signature) {
      const canonical = connectCanonical(Number(v.connectionId), v.home, v.action, v.timestamp, v.nonce, Buffer.from(v.body, 'utf8'));
      expect(canonical).toBe(v.canonical);
      expect(connectSignature(vectors.keyPair.privateKeyPem, canonical)).toBe(v.signature);
      expect(encodeURIComponent(v.home)).toBe(v.homeHeader);
    }
  });

  it('encodes the home as every vector decodes it', () => {
    for (const v of vectors.homes) expect(decodeURIComponent(v.header.replace(/\+/g, '%2B'))).toBe(v.home);
  });

  it('makes key pairs the plugin can verify: 32 raw bytes of public key', () => {
    const { privateKey, publicKey } = connectKeyPair();
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(32);
    const sig = connectSignature(privateKey, 'hello');
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    expect(crypto.verify(null, Buffer.from('hello'), key, Buffer.from(sig.slice('ed25519='.length), 'base64url'))).toBe(true);
  });

  it('signs in headers and the query string, the home percent-encoded in both', async () => {
    const seen: { url: URL; headers: Record<string, string> }[] = [];
    const client = clientOf(async (req) => {
      seen.push({ url: req.url, headers: req.headers });
      return plugin(200, PING);
    });
    await client.ping();
    const { url, headers } = seen[0]!;
    expect(url.pathname).toBe('/wp-json/wpl7-connect/v1/ping');
    expect(headers['x-wpl7-site']).toBe('7');
    expect(headers['x-wpl7-home']).toBe('https%3A%2F%2Fexample.com');
    expect(url.searchParams.get('_home')).toBe('https%3A%2F%2Fexample.com');
    expect(headers['x-wpl7-signature']).toMatch(/^ed25519=[A-Za-z0-9_-]{86}$/);
    expect(url.searchParams.get('_sig')).toBe(headers['x-wpl7-signature']);
  });
});

describe('the Connect client', () => {
  it('reports a site whose address changed, with the new one', async () => {
    const client = clientOf(async () => plugin(409, { error: { code: 'home_changed', home: 'https://www.example.com' } }));
    const err = await client.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginSourceError);
    expect(err).toMatchObject({ code: 'home_changed', fatal: true, details: { home: 'https://www.example.com' } });
  });

  it('asks for half the time per request after two gateway timeouts, down to two seconds', async () => {
    let timeouts = 2;
    const bodies: Record<string, unknown>[] = [];
    const client = clientOf(async (req) => {
      const action = req.url.pathname.split('/').pop();
      if (action === 'ping') return plugin(200, PING);
      bodies.push(JSON.parse(req.body.toString('utf8')) as Record<string, unknown>);
      if (timeouts-- > 0) return { status: 504, headers: { 'content-type': 'text/html' }, body: Buffer.from('Gateway Timeout') };
      return plugin(200, { sql: '', next: null, rows: 0, skipped: [] });
    });
    await client.ping();
    await client.sql('wp_posts', '', 65536);
    expect(client.state.budgetMs).toBe(5000);
    expect(bodies.map((b) => b.budget_ms)).toEqual([undefined, undefined, 5000]);
  });

  it('turns a command nobody registered into its own error, and polls an update that runs on', async () => {
    let polls = 0;
    const client = clientOf(async (req) => {
      const action = req.url.pathname.split('/').pop();
      if (action === 'run') return plugin(404, { error: { code: 'not_found', detail: 'command' } });
      if (action === 'update') return plugin(200, { op: 'a'.repeat(16), state: 'running' });
      if (action === 'op') {
        polls++;
        return plugin(200, polls < 3 ? { op: 'a'.repeat(16), state: 'running' } : { op: 'a'.repeat(16), state: 'done', result: { ok: true, from: '7.1.2', to: '7.1.3', rollback: false } });
      }
      return plugin(200, PING);
    });
    await expect(client.run(['plugin', 'list'])).rejects.toMatchObject({ name: 'UnknownCommandError', command: 'plugin' });
    const answer = await client.update({ op: 'a'.repeat(16), kind: 'core', version: '7.1.3' }, { pollMs: 0 });
    expect(answer).toMatchObject({ state: 'done', result: { ok: true, to: '7.1.3' } });
    expect(polls).toBe(3);
  });
});
