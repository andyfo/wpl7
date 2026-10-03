import http from 'node:http';
import https from 'node:https';

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
