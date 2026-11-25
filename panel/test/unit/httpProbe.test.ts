import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpProbe, httpProbeAttempts, httpProbeOnce, isUp, noAnswerWithin } from '../../src/lib/httpProbe.js';

let server: http.Server | null = null;

async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
}

afterEach(() => {
  server?.close();
  server = null;
});

describe('httpProbe', () => {
  it('actually sends the Host header (fetch silently drops it)', async () => {
    let seen: string | undefined;
    const url = await serve((req, res) => {
      seen = req.headers.host;
      res.writeHead(200).end('ok');
    });
    const attempt = await httpProbeOnce(url, 'shop.example.com');
    expect(seen).toBe('shop.example.com');
    expect(attempt.ok).toBe(true);
  });

  it('treats Traefik’s catch-all 404 as DOWN, redirects and auth walls as up', async () => {
    expect(isUp(200)).toBe(true);
    expect(isUp(301)).toBe(true);
    expect(isUp(401)).toBe(true);
    expect(isUp(403)).toBe(true);
    expect(isUp(404)).toBe(false); // "no router for this host"
    expect(isUp(502)).toBe(false);
    expect(isUp(500)).toBe(false);
  });

  it('answers with the last attempt, which says what came back', async () => {
    const url = await serve((_req, res) => res.writeHead(503).end(''));
    expect(await httpProbeAttempts(url, 'nope.example.com', 0)).toMatchObject({ ok: false, status: 503 });
    expect(await httpProbeAttempts('http://127.0.0.1:1/', 'x.example.com', 0)).toMatchObject({ ok: false, status: null });
  });

  it('reports a 404 site as down instead of up', async () => {
    const url = await serve((_req, res) => res.writeHead(404).end('404 page not found'));
    expect(await httpProbe(url, 'nope.example.com', 0)).toBe(false);
  });

  it('waits for a slow site as long as it was given, and says when that ran out rather than nothing answering', async () => {
    const url = await serve((_req, res) => void setTimeout(() => res.writeHead(200).end('ok'), 300));
    // Slow is up, while it answers within the time.
    expect(await httpProbeOnce(url, 'shop.example.com', 2000)).toMatchObject({ ok: true, status: 200 });
    const late = await httpProbeOnce(url, 'shop.example.com', 100);
    expect(late).toMatchObject({ ok: false, status: null, timedOut: true, error: 'No answer within 100 ms' });
    expect(noAnswerWithin(15_000)).toBe('No answer within 15 s');
  });

  it('says why when nothing is listening, which is no timeout', async () => {
    const url = await serve((_req, res) => res.end());
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const refused = await httpProbeOnce(url, 'shop.example.com', 2000);
    expect(refused).toMatchObject({ ok: false, status: null });
    expect(refused.timedOut).toBeUndefined();
    expect(refused.error).toMatch(/ECONNREFUSED/);
  });

  it('resolves false (never throws) when nothing is listening', async () => {
    expect(await httpProbe('http://127.0.0.1:1/', 'x.example.com', 0)).toBe(false);
  });
});
