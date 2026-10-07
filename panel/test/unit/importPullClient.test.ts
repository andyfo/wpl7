import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ImportPullClient,
  ImportSourceError,
  actionUrl,
  canonicalRequest,
  createPinnedTransport,
  signRequest,
  type PullResponse,
  type PullTransport,
} from '../../src/services/importPull.js';
import { FakeSourceSite, fakeTable } from '../importFake.js';

const TOKEN = 'n3Q8m1X0pR6tYv2Lk9Hs4Wd7Fg5Jc0Bz1Ae8Uq3Ti6O';
const lookup = async () => [{ address: '203.0.113.80', family: 4 }];

function clientOf(transport: PullTransport, extra: Partial<ConstructorParameters<typeof ImportPullClient>[0]> = {}) {
  const sleeps: number[] = [];
  const client = new ImportPullClient({
    importId: 7,
    token: TOKEN,
    home: 'https://willow-pediatrics.example',
    endpoint: 'https://willow-pediatrics.example/wp-json/wpl7-migrate/v1/',
    allowHttp: false,
    transport,
    lookup,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { client, sleeps };
}

const plugin = (status: number, body: unknown, headers: Record<string, string> = {}): PullResponse => ({
  status,
  headers: { 'content-type': 'application/json', 'x-wpl7-protocol': '1', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});

const PING = { protocol: 1, plugin: '0.3.0', time: Math.floor(Date.now() / 1000), limits: { max_ms: 10000, max_bytes: 65536, max_row_bytes: 1e6 }, encodings: ['raw', 'base64', 'gzip'], actions: ['ping', 'bundle'] };

describe('signing a request', () => {
  it('covers the import, the action, the time, the nonce and the exact body', () => {
    const body = Buffer.from('{"op":"start"}');
    const canonical = canonicalRequest(7, 'snapshot', 1759843200, 'ab'.repeat(16), body);
    expect(canonical).toBe(
      `WPL7-MIGRATE-V1\n7\nsnapshot\n1759843200\n${'ab'.repeat(16)}\n${crypto.createHash('sha256').update(body).digest('hex')}`,
    );
    expect(signRequest(TOKEN, canonical)).toBe(crypto.createHmac('sha256', TOKEN).update(canonical).digest('hex'));
  });

  it('finds an action through each transport, plain permalinks included', () => {
    expect(actionUrl('rest', 'https://a.example/wp-json/wpl7-migrate/v1/', 'https://a.example', 'files').toString()).toBe(
      'https://a.example/wp-json/wpl7-migrate/v1/files',
    );
    expect(actionUrl('rest', 'https://a.example/?rest_route=/wpl7-migrate/v1/', 'https://a.example', 'files').searchParams.get('rest_route')).toBe(
      '/wpl7-migrate/v1/files',
    );
    expect(actionUrl('query', 'https://a.example/wp-json/wpl7-migrate/v1/', 'https://a.example', 'files').toString()).toBe(
      'https://a.example/?wpl7-migrate=files',
    );
  });
});

describe('the pull client', () => {
  it('signs every request in headers and in the query string, and the plugin accepts it', async () => {
    const fake = new FakeSourceSite({ token: TOKEN, importId: 7, files: { 'a.txt': 'hello' }, tables: [fakeTable('wpx_options', [[1, 'x']])] });
    const { client } = clientOf(fake.transport);
    expect((await client.ping()).plugin).toBe('0.3.0');
    expect(client.answers('bundle')).toBe(true);
    const seen: URL[] = [];
    const { client: spy } = clientOf(async (req) => {
      seen.push(req.url);
      return fake.transport(req);
    });
    await spy.ping();
    expect([...seen[0]!.searchParams.keys()].sort()).toEqual(['_id', '_nonce', '_sig', '_ts']);
  });

  it('waits and tries again on a bad moment, as long as Retry-After says', async () => {
    const answers = [plugin(503, { error: { code: 'internal' } }, { 'retry-after': '7' }), plugin(429, {}), plugin(200, PING)];
    const { client, sleeps } = clientOf(async () => answers.shift()!);
    await client.ping();
    // Slept in one-second slices: 7 s for the first, the back-off's 4 s for the second.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(11_000);
  });

  it('gives up after its attempts on something that does not come back', async () => {
    let calls = 0;
    const { client } = clientOf(async () => {
      calls++;
      throw new Error('socket hang up');
    }, { attempts: 3 });
    await expect(client.ping()).rejects.toThrow(/did not answer ping after 3 attempts \(socket hang up\)/);
    expect(calls).toBe(3);
  });

  it('gives up at once on a refusal', async () => {
    let calls = 0;
    const { client } = clientOf(async () => {
      calls++;
      return plugin(401, { error: { code: 'unauthorized' } });
    });
    const err = await client.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportSourceError);
    expect((err as ImportSourceError).fatal).toBe(true);
    expect(calls).toBe(1);
  });

  it('says what answered instead of the plugin, and how to get past it', async () => {
    const { client } = clientOf(async (req) =>
      req.url.searchParams.has('wpl7-migrate')
        ? { status: 302, headers: { location: 'https://willow-pediatrics.example/login' }, body: Buffer.alloc(0) }
        : { status: 403, headers: { 'content-type': 'text/html' }, body: Buffer.from('<h1>Blocked</h1>') },
    );
    await expect(client.ping()).rejects.toThrow(/answered with something else \(HTTP 403, text\/html\).*skips \/wp-json\/wpl7-migrate\//);
  });

  it('takes the query string way in when /wp-json/ is blocked, and keeps to it', async () => {
    const fake = new FakeSourceSite({ token: TOKEN, importId: 7, files: { 'a.txt': 'hello' }, tables: [] });
    fake.blockRest = true;
    const { client } = clientOf(fake.transport);
    await client.ping();
    expect(client.state.transport).toBe('query');
    await client.snapshot('start');
    expect(fake.count('snapshot')).toBe(1);
  });

  it('switches to base64 when the host alters binary bodies', async () => {
    const fake = new FakeSourceSite({ token: TOKEN, importId: 7, files: { 'a.bin': Buffer.from([1, 2, 3, 0, 255]) }, tables: [] });
    fake.mangleRaw = true;
    const { client } = clientOf(fake.transport);
    const snap = await client.snapshot('start');
    const page = await client.files(snap.snapshot_id, 0, 10);
    const file = page.entries.find((e) => e.p === 'a.bin')!;
    const answer = await client.range(file.id, 0, 100, 'refresh');
    expect(answer).toMatchObject({ kind: 'data', size: 5 });
    expect(answer.kind === 'data' && answer.data.equals(Buffer.from([1, 2, 3, 0, 255]))).toBe(true);
    expect(client.state.encoding).toBe('base64');
  });

  it('signs with the old site’s clock once it says the panel’s is off', async () => {
    const fake = new FakeSourceSite({ token: TOKEN, importId: 7, files: {}, tables: [] });
    fake.clockSkewS = -3600;
    const { client } = clientOf(fake.transport);
    await client.snapshot('start');
    expect(client.state.skewS).toBeLessThanOrEqual(-3599);
    expect(fake.count('snapshot')).toBe(2);
  });

  it('refuses an address in the panel’s own network before sending anything', async () => {
    let sent = false;
    const { client } = clientOf(
      async () => {
        sent = true;
        return plugin(200, PING);
      },
      { lookup: async () => [{ address: '10.0.0.5', family: 4 }] },
    );
    await expect(client.ping()).rejects.toThrow(/will not connect to the old site/);
    expect(sent).toBe(false);
  });
});

describe('the pinned transport', () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function listen(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('connects to the vetted address, whatever the name resolves to', async () => {
    const port = await listen((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ host: req.headers.host, path: req.url, body: req.headers['content-length'] }));
    });
    const transport = createPinnedTransport();
    // .invalid never resolves: the request can only have gone to the pinned address.
    const res = await transport({
      url: new URL(`http://old-site.invalid:${port}/wp-json/x?y=1`),
      address: '127.0.0.1',
      family: 4,
      headers: {},
      body: Buffer.from('{}'),
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    transport.close();
    expect(JSON.parse(res.body.toString())).toEqual({ host: `old-site.invalid:${port}`, path: '/wp-json/x?y=1', body: '2' });
  });

  it('never follows a redirect, and cuts off an answer that is too large', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
        res.end();
        return;
      }
      res.end(Buffer.alloc(10_000));
    });
    const transport = createPinnedTransport();
    const base = { address: '127.0.0.1', family: 4 as const, headers: {}, body: Buffer.alloc(0), timeoutMs: 5000 };
    const redirect = await transport({ ...base, url: new URL(`http://old-site.invalid:${port}/redirect`), maxBytes: 1024 });
    expect(redirect.status).toBe(302);
    await expect(transport({ ...base, url: new URL(`http://old-site.invalid:${port}/big`), maxBytes: 1024 })).rejects.toThrow(/larger than 1024/);
    transport.close();
  });
});
