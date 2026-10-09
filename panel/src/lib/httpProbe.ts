// @docs servers/overview, sites/overview, sites/external
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { assertAllowedSource, type LookupFn } from './outboundGuard.js';

export interface ProbeAttempt {
  ok: boolean;
  status: number | null;
  ms: number;
}

/**
 * `Host`-header-accurate liveness probe.
 *
 * Why not `fetch`: undici treats `host` as a forbidden request header and drops it
 * silently, so every remote probe arrived at Traefik as `Host: <ip>`, matched no
 * router, and got the catch-all 404 back - which the old `status < 500` rule then
 * reported as "up". Both halves are fixed here: the header is set for real, and a
 * 404 (Traefik's "no router for this host") counts as DOWN.
 *
 * Certificates are deliberately not verified: the probe only asks "did Traefik route
 * this hostname to a live backend", and a site being probed may still be waiting for
 * its ACME certificate (or running under the staging CA).
 */
export function httpProbeOnce(url: string, hostHeader: string, timeoutMs = 8000): Promise<ProbeAttempt> {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const started = Date.now();
  return new Promise((resolve) => {
    const done = (status: number | null) =>
      resolve({ ok: status !== null && isUp(status), status, ms: Date.now() - started });
    const req = (secure ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        // node:http honours an explicit Host (and SNI), unlike fetch.
        headers: { host: hostHeader, 'user-agent': 'wpl7-probe/1' },
        ...(secure ? { servername: hostHeader, rejectUnauthorized: false } : {}),
        // No keep-alive pool: probes are one-shot and spread across every site on every
        // server, so pooled sockets would only accumulate.
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume(); // drain so the socket can be released
        done(res.statusCode ?? null);
      },
    );
    req.on('timeout', () => req.destroy(new Error('probe timed out')));
    req.on('error', () => done(null));
    req.end();
  });
}

/**
 * 2xx/3xx = served (a redirect still proves the router matched). 401/403 = the site
 * answered and chose to protect itself. Everything else - notably 404 and 5xx - is down.
 */
export function isUp(status: number): boolean {
  return status < 400 || status === 401 || status === 403;
}

/** Retry `httpProbeOnce` until it succeeds or `timeoutMs` elapses (0 = a single attempt). */
export async function httpProbe(
  url: string,
  hostHeader: string,
  timeoutMs: number,
  opts: { attemptTimeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await httpProbeOnce(url, hostHeader, opts.attemptTimeoutMs ?? 8000);
    if (attempt.ok) return true;
    // >= not >: with timeoutMs 0 (the test setting) a failure inside the same millisecond
    // would otherwise sleep and retry instead of returning immediately.
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
  }
}

/** What a probe of a site hosted elsewhere found. `certExpiresAt`: when its TLS certificate expires. */
export interface ExternalProbeResult {
  ok: boolean;
  status: number | null;
  ms: number;
  certExpiresAt: number | null;
  /** Why nothing answered: refused, timed out, a certificate that is not valid. */
  error?: string;
}

export type ExternalProbe = (url: string) => Promise<ExternalProbeResult>;

/**
 * A site hosted elsewhere, asked directly: a GET of its home page, from the panel. Unlike the
 * probe above it goes through the outbound guard - the address is the site's, which its plugin
 * reported - pinned to the address the guard checked, with the certificate verified against
 * the name: a visitor's browser would refuse a bad one too. A redirect is an answer (the home
 * page of a site behind a login, or one that moved), and is never followed. The certificate's
 * expiry comes back with the answer, for the alert a week before it.
 */
export function probeExternal(url: string, opts: { lookup?: LookupFn; timeoutMs?: number } = {}): Promise<ExternalProbeResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return assertAllowedSource(url, { allowHttp: true, lookup: opts.lookup }).then(
    (target) =>
      new Promise<ExternalProbeResult>((resolve) => {
        const secure = target.url.protocol === 'https:';
        const lookup: LookupFunction = (_hostname, options, callback) => {
          if ((options as { all?: boolean }).all) {
            (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: target.address, family: target.family }]);
          } else callback(null, target.address, target.family);
        };
        let settled = false;
        const done = (result: Omit<ExternalProbeResult, 'ms'>) => {
          if (settled) return;
          settled = true;
          resolve({ ...result, ms: Date.now() - started });
        };
        const req = (secure ? https : http).request(
          {
            method: 'GET',
            hostname: target.url.hostname.replace(/^\[|\]$/g, ''),
            port: target.url.port || (secure ? 443 : 80),
            path: `${target.url.pathname}${target.url.search}`,
            headers: { 'user-agent': 'wpl7-probe/1', accept: 'text/html' },
            lookup,
            agent: false,
            timeout: timeoutMs,
            ...(secure ? { servername: target.url.hostname, rejectUnauthorized: true } : {}),
          },
          (res) => {
            let certExpiresAt: number | null = null;
            const socket = res.socket as TLSSocket;
            if (secure && typeof socket.getPeerCertificate === 'function') {
              const validTo = socket.getPeerCertificate()?.valid_to;
              const at = validTo ? Date.parse(validTo) : NaN;
              certExpiresAt = Number.isFinite(at) ? at : null;
            }
            res.resume();
            const status = res.statusCode ?? null;
            done({ ok: status !== null && isUp(status), status, certExpiresAt });
          },
        );
        req.on('timeout', () => req.destroy(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s`)));
        req.on('error', (err) => done({ ok: false, status: null, certExpiresAt: null, error: err.message }));
        req.end();
      }),
    (err: unknown) => ({ ok: false, status: null, ms: Date.now() - started, certExpiresAt: null, error: err instanceof Error ? err.message : String(err) }),
  );
}
