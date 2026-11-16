/**
 * The way in to a container app that needs no route: a short-lived container of the image the
 * server's Traefik runs (on every server, never pulled), on the app's own network alone, asking
 * the app by its container name with busybox `wget` (test/engine/containerApps.test.ts, item 8).
 *
 * What the deploy's health gate asks while every route is held, and what the uptime check asks.
 * Not an exec in `wpl7-traefik`, which is ten times faster: that container holds the Docker
 * socket, and an answer from an app that was broken into would be read there. This one has no
 * capability, no writable root, no way to gain privileges, 32 MB and 32 processes, and sees
 * nothing but the app's network, where only the app and the stack are.
 */
// @docs sites/container
import type { AppSettingsRow, SiteRow } from '../db/schema.js';
import type { ServerHandle } from '../servers/registry.js';
import type { RunResult } from './docker.js';
import { siteNetworkName } from './siteNetwork.js';
import { TRAEFIK_CONTAINER } from './stack.js';

/** The label a probe's container carries: the app it asks. */
export const PROBE_LABEL = 'wpl7.probe';

export interface AppAnswer {
  /** The status of the first answer; null when none came. */
  status: number | null;
  /** In a few words: `200 OK`, `no answer: bad address 'wp-shop:8000'`. */
  detail: string;
}

export const isHealthy = (answer: AppAnswer): boolean => answer.status !== null && answer.status >= 200 && answer.status < 300;

const STATUS_RE = /HTTP\/\d(?:\.\d)?\s+(\d{3})([^\r\n]*)/;

/** What `wget -S` printed: the first status line, which decides; or why there was none. */
export function readWgetAnswer(res: Pick<RunResult, 'stdout' | 'stderr' | 'exitCode'>): AppAnswer {
  const m = STATUS_RE.exec(res.stderr) ?? STATUS_RE.exec(res.stdout);
  if (m) return { status: Number(m[1]), detail: `${m[1]}${(m[2] ?? '').trimEnd()}` };
  const lines = res.stderr.trim().split('\n').filter(Boolean);
  const why = (lines.at(-1) ?? '').replace(/^wget:\s*/, '').trim() || `exit ${res.exitCode}`;
  return { status: null, detail: `no answer: ${why.slice(0, 200)}` };
}

export interface AskOpts {
  port: number;
  path: string;
  host: string;
  timeoutSec: number;
}

/** One question to the app, on its own network. Never throws: a probe that could not run is no answer. */
export async function askApp(
  server: Pick<ServerHandle, 'docker' | 'name'>,
  app: Pick<SiteRow, 'slug' | 'containerName'>,
  opts: AskOpts,
): Promise<AppAnswer> {
  const image = await server.docker.containerImage(TRAEFIK_CONTAINER).catch(() => null);
  if (!image) return { status: null, detail: `no answer: Traefik is not running on "${server.name}"` };
  const t = Math.max(1, Math.round(opts.timeoutSec));
  try {
    const res = await server.docker.runEphemeral({
      image,
      entrypoint: ['wget'],
      cmd: ['-q', '-S', '-T', String(t), '-O', '/dev/null', '--header', `Host: ${opts.host}`, `http://${app.containerName}:${opts.port}${opts.path}`],
      labels: { [PROBE_LABEL]: app.slug },
      timeoutMs: (t + 15) * 1000,
      outputCap: 64 * 1024,
      lockdown: { network: siteNetworkName(app.slug), memoryBytes: 32 * 1024 * 1024, nanoCpus: 250_000_000, pidsLimit: 32, tmpfs: { '/tmp': 1 } },
    });
    return readWgetAnswer(res);
  } catch (err) {
    return { status: null, detail: `no answer: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
  }
}

/**
 * Whether a container app's image can run a command: `sh`, and `timeout`, which every exec is
 * wrapped in (services/docker.ts). Asked before a shell job is queued, as the user it would run as.
 */
export async function hasShell(docker: Pick<ServerHandle['docker'], 'exec'>, container: string, runAs: string): Promise<boolean> {
  try {
    const res = await docker.exec(container, ['sh', '-c', 'command -v timeout >/dev/null'], { timeoutMs: 15_000, ...(runAs ? { user: runAs } : {}) });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

export interface GateOpts {
  /** Ask the deploy check path once after the health path answered: a deploy's, never a restart's. */
  deployCheck: boolean;
  /** Between two rounds of questions; 2 s. */
  intervalMs?: number;
  log?: (line: string) => void;
  canceled?: () => void;
}

/** What the gate came to: the port the app passed on, or why it did not pass. */
export type GateResult = { port: number; failed: null } | { port: null; failed: string };

/** `9000`, `9000 or 8000`, `9000, 7000 or 8000`. */
const portList = (ports: number[]): string => (ports.length === 1 ? String(ports[0]) : `${ports.slice(0, -1).join(', ')} or ${ports.at(-1)}`);

/**
 * The health gate: the health path, every 2 s, until it answers 2xx or the app's timeout passes,
 * each try waiting at most 10 s and never past that timeout; then the deploy check path once, when
 * there is one, with a wait of its own: the app's whole timeout. A check that does real work (a
 * database, a queue) may take longer than a health answer, and one asked after a late health
 * answer would otherwise get what little of the timeout was left.
 *
 * `ports`, in the order they are preferred: a port staged for the new container first, then the
 * ones its image is known to listen on (services/apps.ts patch). Each round asks every one in that
 * order, and the first that answers 2xx is the port the app passed on; the deploy check is asked
 * there. The timeout is the whole gate's, not one per port.
 */
export async function healthGate(
  server: Pick<ServerHandle, 'docker' | 'name'>,
  app: Pick<SiteRow, 'slug' | 'containerName' | 'domains'>,
  settings: Pick<AppSettingsRow, 'healthPath' | 'healthHost' | 'healthTimeoutSec' | 'deployCheckPath'>,
  ports: number[],
  opts: GateOpts,
): Promise<GateResult> {
  const candidates = [...new Set(ports.filter((p) => p > 0))];
  if (candidates.length === 0) return { port: null, failed: 'The app has no port to ask: give the port it listens on.' };
  const host = settings.healthHost || (JSON.parse(app.domains) as string[])[0] || app.slug;
  const deadline = Date.now() + settings.healthTimeoutSec * 1000;
  const ask = (port: number, p: string, timeoutSec: number) => askApp(server, app, { port, path: p, host, timeoutSec });
  const several = candidates.length > 1;
  const where = several ? ` on port ${portList(candidates)}` : '';
  // The last answer on each port, in the order asked.
  const last = new Map<number, AppAnswer>();
  const lastText = () => (several ? [...last].map(([port, a]) => `${port} ${a.detail}`).join('; ') : last.get(candidates[0]!)!.detail);
  let rounds = 0;
  let passed: { port: number; answer: AppAnswer } | null = null;
  for (;;) {
    for (const port of candidates) {
      opts.canceled?.();
      const answer = await ask(port, settings.healthPath, Math.min(10, Math.max(1, (deadline - Date.now()) / 1000)));
      last.set(port, answer);
      if (isHealthy(answer)) {
        passed = { port, answer };
        break;
      }
    }
    rounds++;
    if (passed) break;
    if (Date.now() >= deadline) {
      const tries = several ? `${rounds} ${rounds === 1 ? 'try' : 'tries'} each` : `${rounds} ${rounds === 1 ? 'try' : 'tries'}`;
      return { port: null, failed: `${settings.healthPath} did not answer 2xx${where} within ${settings.healthTimeoutSec} s (${tries}; last: ${lastText()}).` };
    }
    if (rounds === 1 || rounds % 5 === 0) opts.log?.(`Waiting for ${settings.healthPath}${where} (${lastText()})…`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
  }
  opts.log?.(`${settings.healthPath} answered ${passed.answer.detail}${several ? ` on port ${passed.port}` : ''}.`);
  if (opts.deployCheck && settings.deployCheckPath) {
    const check = await ask(passed.port, settings.deployCheckPath, settings.healthTimeoutSec);
    if (!isHealthy(check)) return { port: null, failed: `The deploy check ${settings.deployCheckPath} answered ${check.detail}.` };
    opts.log?.(`The deploy check ${settings.deployCheckPath} answered ${check.detail}.`);
  }
  return { port: passed.port, failed: null };
}
