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
  /** Between two questions; 2 s. */
  intervalMs?: number;
  log?: (line: string) => void;
  canceled?: () => void;
}

/**
 * The health gate: the health path, every 2 s, until it answers 2xx or the app's timeout passes,
 * each try waiting at most 10 s and never past that timeout; then the deploy check path once, when
 * there is one, with a wait of its own: the app's whole timeout. A check that does real work (a
 * database, a queue) may take longer than a health answer, and one asked after a late health
 * answer would otherwise get what little of the timeout was left. The reason it failed, or null.
 */
export async function healthGate(
  server: Pick<ServerHandle, 'docker' | 'name'>,
  app: Pick<SiteRow, 'slug' | 'containerName' | 'domains'>,
  settings: Pick<AppSettingsRow, 'port' | 'healthPath' | 'healthHost' | 'healthTimeoutSec' | 'deployCheckPath'>,
  opts: GateOpts,
): Promise<string | null> {
  const host = settings.healthHost || (JSON.parse(app.domains) as string[])[0] || app.slug;
  const deadline = Date.now() + settings.healthTimeoutSec * 1000;
  const ask = (p: string, timeoutSec: number) => askApp(server, app, { port: settings.port, path: p, host, timeoutSec });
  let last: AppAnswer;
  let tries = 0;
  for (;;) {
    opts.canceled?.();
    last = await ask(settings.healthPath, Math.min(10, Math.max(1, (deadline - Date.now()) / 1000)));
    tries++;
    if (isHealthy(last)) break;
    if (Date.now() >= deadline) {
      return `${settings.healthPath} did not answer 2xx within ${settings.healthTimeoutSec} s (${tries} ${tries === 1 ? 'try' : 'tries'}; last: ${last.detail}).`;
    }
    if (tries === 1 || tries % 5 === 0) opts.log?.(`Waiting for ${settings.healthPath} (${last.detail})…`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
  }
  opts.log?.(`${settings.healthPath} answered ${last.detail}.`);
  if (opts.deployCheck && settings.deployCheckPath) {
    const check = await ask(settings.deployCheckPath, settings.healthTimeoutSec);
    if (!isHealthy(check)) return `The deploy check ${settings.deployCheckPath} answered ${check.detail}.`;
    opts.log?.(`The deploy check ${settings.deployCheckPath} answered ${check.detail}.`);
  }
  return null;
}
