import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpProbe, httpProbeOnce, isUp } from '../../src/lib/httpProbe.js';

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

  it('reports a 404 site as down instead of up', async () => {
    const url = await serve((_req, res) => res.writeHead(404).end('404 page not found'));
    expect(await httpProbe(url, 'nope.example.com', 0)).toBe(false);
  });

  it('resolves false (never throws) when nothing is listening', async () => {
    expect(await httpProbe('http://127.0.0.1:1/', 'x.example.com', 0)).toBe(false);
  });
});
