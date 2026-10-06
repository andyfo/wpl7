// @docs sites/move
import { Transform } from 'node:stream';
import type { ServerHandle } from '../../servers/registry.js';
import { safeJoin } from '../../lib/slug.js';

/**
 * Stream a command's stdout on one server into a command's stdin on another,
 * through the panel, with constant memory (bounded by stream highWaterMarks).
 * Either side failing destroys the pipe so the other side terminates too.
 */
export async function pipeBetweenServers(opts: {
  source: ServerHandle;
  sourceCmd: [string, string[]];
  target: ServerHandle;
  targetCmd: [string, string[]];
  timeoutMs: number;
  onBytes?: (total: number) => void;
}): Promise<{ bytes: number }> {
  let bytes = 0;
  // Counting via a Transform, NOT a 'data' listener: a listener switches the stream to
  // flowing mode immediately, and everything the source emits before the target's SSH
  // channel is attached is emitted to nobody and lost. The target side needs a network
  // round trip to attach, so local -> remote moves dropped their first chunks almost
  // every time — a silently truncated tar. A Transform stays paused and buffers.
  const pipe = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      try {
        opts.onBytes?.(bytes);
      } catch (err) {
        cb(err as Error); // e.g. cancellation requested mid-transfer
        return;
      }
      cb(null, chunk);
    },
  });
  // The real error is reported through the rejected promise below; this listener only
  // stops the destroy() further down from raising an *uncaught* 'error' event when the
  // other side has already detached.
  pipe.on('error', () => undefined);

  const sourceRun = opts.source.exec
    .runToStream(opts.sourceCmd[0], opts.sourceCmd[1], pipe, { timeoutMs: opts.timeoutMs })
    .then((res) => {
      if (res.exitCode !== 0) {
        throw new Error(`source ${opts.sourceCmd[0]} failed (exit ${res.exitCode}): ${res.stderr.slice(0, 300)}`);
      }
    });
  const targetRun = opts.target.exec
    .runWithInput(opts.targetCmd[0], opts.targetCmd[1], pipe, { timeoutMs: opts.timeoutMs })
    .then((res) => {
      if (res.exitCode !== 0) {
        throw new Error(`target ${opts.targetCmd[0]} failed (exit ${res.exitCode}): ${res.stderr.slice(0, 300)}`);
      }
    });

  try {
    await Promise.all([sourceRun, targetRun]);
  } catch (err) {
    // Destroy WITH the error: both exec adapters tear their side down on the pipe's
    // 'error' event, and a bare destroy() emits no such event — the surviving side
    // would then sit idle until its own (hour-long) timeout.
    pipe.destroy(err instanceof Error ? err : new Error(String(err)));
    // Let the surviving side settle so its rejection doesn't go unhandled.
    await Promise.allSettled([sourceRun, targetRun]);
    throw err;
  }
  return { bytes };
}

/** rm -rf with the same safeJoin guard the rest of the codebase uses. */
export async function rmOn(h: ServerHandle, base: string, ...segments: string[]): Promise<void> {
  await h.files.rm(safeJoin(base, ...segments));
}

/**
 * Traefik file-provider config written on the SOURCE server after cutover: it keeps
 * terminating TLS with its existing certificate (renewals still work - DNS points here)
 * and forwards to the target until the customer's DNS propagates.
 */
export function proxyConfigYaml(opts: {
  slug: string;
  hosts: string[];
  targetIp: string;
  tlsMode: 'letsencrypt' | 'staging' | 'none';
  acmeResolver: string;
  /** Source server's dev domain / DNS provider: pure dev-domain host lists reuse its wildcard cert. */
  devDomain?: string;
  dnsProvider?: string;
}): string {
  const name = `move-${opts.slug}`;
  const rule = opts.hosts.map((h) => `Host(\`${h}\`)`).join(' || ');
  const https = opts.tlsMode !== 'none';
  const lines = [
    `# Written by the panel while "${opts.slug}" moves servers; removed by the move finalize step.`,
    `http:`,
    `  routers:`,
    `    ${name}:`,
    `      rule: ${JSON.stringify(rule)}`,
    `      entryPoints: [${https ? 'websecure' : 'web'}]`,
    `      service: ${name}`,
  ];
  if (https) {
    // Same resolver choice as services/labels.ts, so a dev hostname keeps the *.devDomain
    // wildcard certificate instead of triggering a fresh per-host HTTP-01 issuance.
    const dev = opts.devDomain;
    const underDev = (h: string) => !!dev && (h === dev || h.endsWith(`.${dev}`));
    if (dev && opts.dnsProvider && opts.hosts.every(underDev)) {
      const dnsResolver = opts.acmeResolver === 'letsencrypt-staging' ? 'letsencrypt-dns-staging' : 'letsencrypt-dns';
      lines.push(
        `      tls:`,
        `        certResolver: ${dnsResolver}`,
        `        domains:`,
        `          - main: ${dev}`,
        `            sans:`,
        `              - "*.${dev}"`,
      );
    } else {
      lines.push(`      tls:`, `        certResolver: ${opts.acmeResolver}`);
    }
  }
  lines.push(
    `  services:`,
    `    ${name}:`,
    `      loadBalancer:`,
    `        servers:`,
    `          - url: "${https ? 'https' : 'http'}://${opts.targetIp}:${https ? 443 : 80}"`,
    `        passHostHeader: true`,
  );
  if (https) {
    lines.push(
      `        serversTransport: ${name}`,
      `  serversTransports:`,
      `    ${name}:`,
      `      # The target may not hold this domain's certificate until DNS points there.`,
      `      insecureSkipVerify: true`,
    );
  }
  return lines.join('\n') + '\n';
}

export function proxyConfigPathFor(srvRoot: string, slug: string): string {
  return `${srvRoot}/traefik/dynamic/move-${slug}.yml`;
}
