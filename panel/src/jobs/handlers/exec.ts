// @docs automations/custom-jobs
import { z } from 'zod';
import { siteShellCommand, wpCliArgs, wpCliStdin, wpRestAuth, wpRestMethods, wpRestRoute } from '../../../shared/schemas.js';
import type { SiteRow } from '../../db/schema.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { RunResult } from '../../services/docker.js';
import type { CoreServices } from '../../services/index.js';
import { redactorFor } from '../../services/offsite.js';
import { asSiteUser } from '../../services/wp.js';
import { wpErrorOf, type WpRestResponse } from '../../services/wpRest.js';
import { ContainerBackend, backendFor, type SiteBackend } from '../../services/siteBackend.js';
import { isExternal } from '../../lib/siteKind.js';
import type { JobContext } from '../context.js';
import { maskCliArgs, maskRestRoute, maskShell, sizeText, stdinNote } from '../summaries.js';
import { loadSite } from './shared.js';

/**
 * Commands in a site's container, as jobs: `wp.cli` (a WP-CLI command), `site.shell`
 * (`sh -c` as www-data) and `wp.rest` (a request to the site's REST API, from inside).
 * Queued from `POST /sites/:slug/wp/cli {async: true}`, `POST /sites/:slug/shell`,
 * `POST /sites/:slug/wp/rest {async: true}` and custom schedules; they run in the server's
 * `exec:<id>` lane (src/jobs/lanes.ts), so a long command never holds up the Docker and
 * MariaDB work of the other sites on the machine.
 */

const timeoutMin = z.number().int().min(1).max(60).default(10);

/**
 * `stdin` rides in the payload, like a REST job's application password: the job needs it, nothing
 * that shows a job - its summary, its DTO, its log - ever reads it back out, and the worker drops
 * it from the stored payload once the job has ended (SECRET_PAYLOAD_KEYS, src/jobs/registry.ts).
 */
export const wpCliPayload = z.object({
  siteId: z.number().int(),
  args: wpCliArgs,
  stdin: wpCliStdin.optional(),
  timeoutMin,
});

export const siteShellPayload = z.object({
  siteId: z.number().int(),
  command: siteShellCommand,
  timeoutMin,
});

/** The application password rides in the payload, like a new site's admin password: jobs never show theirs. */
export const wpRestPayload = z.object({
  siteId: z.number().int(),
  method: z.enum(wpRestMethods),
  route: wpRestRoute,
  body: z.unknown().optional(),
  auth: wpRestAuth.optional(),
  timeoutMin,
});

/** Lines of output kept in the job log; the rest is counted, not stored. */
const MAX_LOG_LINES = 1000;
/** Output held in memory per stream while the command runs. */
const OUTPUT_CAP = 64 * 1024;
const MAX_LINE = 2000;

/**
 * The container has to be running already. Starting a stopped site to run a command in it -
 * and possibly leaving it running - is a decision; a scheduled `wp cache flush` should not
 * be the thing that makes it.
 */
async function runningSite(ctx: JobContext<{ siteId: number }>, s: CoreServices): Promise<{ site: SiteRow; server: ServerHandle }> {
  const site = loadSite(s.db, ctx.payload.siteId);
  const server = s.servers.handleFor(site.serverId);
  const state = await server.docker.containerState(site.containerName);
  if (state !== 'running') {
    throw new Error(
      state === 'missing'
        ? `The container of "${site.slug}" does not exist`
        : `"${site.slug}" is not running; start the site first`,
    );
  }
  return { site, server };
}

/** Feeds output into the job log line by line, up to MAX_LOG_LINES; the rest is only counted. */
function lineLog(ctx: JobContext<unknown>) {
  let lines = 0;
  let dropped = 0;
  return {
    line: (line: string) => {
      if (lines >= MAX_LOG_LINES) {
        dropped++;
        return;
      }
      lines++;
      ctx.info(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    },
    /** Lines seen in all, and how many of them the log did not keep. */
    counts: () => {
      if (dropped > 0) ctx.warn(`${dropped} more line(s) of output were not kept (the log keeps ${MAX_LOG_LINES}).`);
      return { lines: lines + dropped, dropped };
    },
  };
}

/** Streams a command's output into the job log as it arrives. */
function outputLog(ctx: JobContext<unknown>) {
  const log = lineLog(ctx);
  return {
    onOutput: log.line,
    finish: (res: RunResult) => {
      const { lines, dropped } = log.counts();
      ctx.setResult({ exitCode: res.exitCode, lines, truncated: dropped > 0 });
      if (res.exitCode !== 0) throw new Error(`The command exited with code ${res.exitCode}`);
      ctx.info('Finished (exit code 0).');
    },
  };
}

/**
 * What a command handed values through `--prompt` would put in its log: WP-CLI echoes each
 * answer after its question (`1/14 [--user_pass=<password>]: hunter2`) and then prints the whole
 * command it ran, the answers shell-quoted in it. Those answers are stdin's lines, so they are
 * masked in every line the log keeps - down to four characters, since a prompted value is
 * nearly always a password. Without `--prompt`, stdin is a message or a script, and a line of the
 * output that happens to repeat a line of it is no leak.
 */
function promptedValues(args: readonly string[], stdin: string | undefined): (line: string) => string {
  if (stdin === undefined || !args.some((a) => a === '--prompt' || a.startsWith('--prompt='))) return (line) => line;
  // As typed, as WP-CLI trims it, and as the echoed command line quotes it.
  const answers = stdin.split(/\r?\n/).flatMap((line) => [line, line.trim()]);
  return redactorFor([...answers, ...answers.map((a) => a.replace(/'/g, "'\\''"))], 4);
}

export async function wpCli(ctx: JobContext<z.infer<typeof wpCliPayload>>, s: CoreServices): Promise<void> {
  const backend = await commandBackend(ctx, s);
  try {
    ctx.checkCanceled();
    const { args, stdin, timeoutMin } = ctx.payload;
    ctx.info(`$ wp ${maskCliArgs(args).join(' ')}${stdin === undefined ? '' : ` ${stdinNote(stdin)}`}`);
    const log = outputLog(ctx);
    const mask = promptedValues(args, stdin);
    // A site hosted elsewhere runs only the commands its plugins registered with WPL7 Connect,
    // and answers when it is done: its output lands in the log then.
    const res = await backend.run(args, {
      timeoutMs: timeoutMin * 60_000,
      onOutput: (line) => log.onOutput(mask(line)),
      outputCap: OUTPUT_CAP,
      stdin,
    });
    log.finish(res);
  } finally {
    backend.close();
  }
}

/** Where a command of a site runs: its running container, or WPL7 Connect for a site hosted elsewhere. */
async function commandBackend(ctx: JobContext<{ siteId: number }>, s: CoreServices): Promise<SiteBackend> {
  const site = loadSite(s.db, ctx.payload.siteId, { kinds: 'any' });
  if (isExternal(site)) {
    if (site.status !== 'connected') throw new Error(`"${site.slug}" is disconnected. Reconnect it from its Settings tab.`);
    return backendFor(s, site);
  }
  const { server } = await runningSite(ctx, s);
  return new ContainerBackend(s, site, server);
}

export async function siteShell(ctx: JobContext<z.infer<typeof siteShellPayload>>, s: CoreServices): Promise<void> {
  const { site, server } = await runningSite(ctx, s);
  ctx.checkCanceled();
  ctx.info(`$ ${maskShell(ctx.payload.command)}`);
  const log = outputLog(ctx);
  // As www-data, like wp-cli and Web FTP (services/wp.ts asSiteUser).
  const res = await server.docker.exec(site.containerName, ['sh', '-c', ctx.payload.command], {
    ...asSiteUser(ctx.payload.timeoutMin * 60_000),
    onOutput: log.onOutput,
    outputCap: OUTPUT_CAP,
  });
  log.finish(res);
}

/**
 * Of a REST answer's body, kept: enough to pretty-print a big JSON listing whole. A compact
 * JSON answer is one line, so cutting it at OUTPUT_CAP would leave the log a single clipped
 * line instead of the first thousand readable ones.
 */
const REST_BODY_CAP = 1024 * 1024;

/** Headers worth a line of their own: a listing's totals, where a redirect points. */
const REST_HEADERS: Record<string, string> = {
  'x-wp-total': 'X-WP-Total',
  'x-wp-totalpages': 'X-WP-TotalPages',
  location: 'Location',
  'retry-after': 'Retry-After',
};

/** A JSON answer indented, one value per line; anything else as it came. */
function bodyLines(res: WpRestResponse): string[] {
  if (!res.truncated && res.contentType?.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(res.body), null, 2).split('\n');
    } catch {
      // Not JSON after all; shown as text.
    }
  }
  return res.body.split(/\r?\n/).filter((line) => line.trim() !== '');
}

export async function wpRest(ctx: JobContext<z.infer<typeof wpRestPayload>>, s: CoreServices): Promise<void> {
  const backend = await commandBackend(ctx, s);
  try {
    await sendRest(ctx, backend);
  } finally {
    backend.close();
  }
}

async function sendRest(ctx: JobContext<z.infer<typeof wpRestPayload>>, backend: SiteBackend): Promise<void> {
  ctx.checkCanceled();
  const { method, route, body, auth, timeoutMin } = ctx.payload;
  // Nothing an endpoint echoes back - a debug route printing its request headers - puts the
  // password in the log: as typed, as WordPress reads it (without the spaces), and encoded.
  const redact = redactorFor(
    auth
      ? [
          auth.applicationPassword,
          auth.applicationPassword.replace(/\s+/g, ''),
          Buffer.from(`${auth.username}:${auth.applicationPassword}`).toString('base64'),
        ]
      : [],
  );
  const external = backend.kind === 'external';
  ctx.info(
    [
      `${method} ${maskRestRoute(route)}`,
      auth ? (external ? `as "${auth.username}"` : `as "${auth.username}" (application password)`) : 'not signed in',
      body !== undefined ? `JSON body, ${sizeText(Buffer.byteLength(JSON.stringify(body)))}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const res = await backend.rest({ method, route, body, auth }, { timeoutMs: timeoutMin * 60_000, bodyCap: REST_BODY_CAP });
  if (res.status === null) throw new Error(`The request did not complete: ${redact(res.error ?? 'no answer came back')}`);

  ctx.info(
    [`HTTP ${res.status} ${res.statusText}`.trim(), res.contentType, sizeText(res.sizeBytes), `${res.durationMs} ms`]
      .filter(Boolean)
      .join(' · '),
  );
  const notable = Object.entries(REST_HEADERS)
    .filter(([name]) => res.headers[name] !== undefined)
    .map(([name, label]) => `${label}: ${res.headers[name]}`);
  if (notable.length > 0) ctx.info(redact(notable.join(' · ')));
  const log = lineLog(ctx);
  for (const line of bodyLines(res)) log.line(redact(line));
  log.counts();
  if (res.truncated) ctx.warn(`Only the first ${sizeText(REST_BODY_CAP)} of the answer was kept.`);
  ctx.setResult({ status: res.status, contentType: res.contentType, sizeBytes: res.sizeBytes, truncated: res.truncated });

  if (res.error) throw new Error(`The answer did not arrive in full: ${redact(res.error)}`);
  if (res.status < 200 || res.status > 299) {
    const why = wpErrorOf(res);
    // WordPress answers a password it rejects as if none had been sent ("You are not currently
    // logged in"), which reads like the sign-in was never tried.
    const rejected =
      auth && res.status === 401 && !external ? ` - WordPress did not accept the application password for "${auth.username}"` : '';
    throw new Error(`The site answered HTTP ${res.status} ${res.statusText}${why ? `: ${redact(why)}` : ''}${rejected}`.trim());
  }
  ctx.info(`Finished (HTTP ${res.status}).`);
}
