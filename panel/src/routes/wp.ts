// @docs automations/custom-jobs, sites/wordpress
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import {
  GODMODE_WAIT_REFUSAL,
  godmodeChatId,
  godmodeChatListQuery,
  godmodeChatQuery,
  siteShellBody,
  siteSlugParam,
  wpBulkOpsBody,
  wpCliBody,
  wpMaintenanceBody,
  wpPluginInstallBody,
  wpPluginNameSchema,
  wpResetPasswordBody,
  wpRestBody,
  wpTestEmailBody,
  waitsOnGodmode,
  wpCliHelpQuery,
} from '../../shared/schemas.js';
import { badGateway, badRequest, conflict, notFound } from '../lib/errors.js';
import { createAdminLoginLink } from '../services/adminLogin.js';
import { jobToDto, viewerOf } from '../lib/dto.js';
import { audit } from '../lib/audit.js';
import { execLane } from '../jobs/lanes.js';
import { maskRestRoute } from '../jobs/summaries.js';
import type { RunResult } from '../services/docker.js';
import { godmodeAnswer } from '../services/wp.js';
import { restTargetOf, sendWpRest } from '../services/wpRest.js';
import type { AppDeps } from './deps.js';
import type { SiteRow } from '../db/schema.js';
import type { ServerHandle } from '../servers/registry.js';

// Addressing an existing site: no reserved-name check, see siteSlugParam.
const slugParams = z.object({ slug: siteSlugParam });
const pluginParams = z.object({ slug: siteSlugParam, name: wpPluginNameSchema });
const godmodeChatParams = z.object({ slug: siteSlugParam, chatId: godmodeChatId });

/** A synchronous wp-cli call's deadline, inside the ~55 s a request is given. */
const SYNC_WP_MS = 55_000;

/**
 * What the panel adds when an AI app reads a plugin's WP-CLI help: how to reach those commands
 * through it, where that differs from running them - a wait the Godmode endpoints do without an
 * approval prompt, where `wp godmode chat wait` through `/wp/cli` would ask each time.
 */
const HELP_NOTES: Record<string, string> = {
  godmode:
    'Through the WPL7 panel: send, answer and cancel with POST /api/sites/{slug}/wp/cli (args as above; a long ' +
    '--message=- or --answers=- goes in "stdin"). Wait on a chat and read it with GET ' +
    '/api/sites/{slug}/godmode/chats/<chat_id>?wait=40&after=<after> (wait=0 reads; pending=true reads the waiting ' +
    'cards in full), list with GET /api/sites/{slug}/godmode/chats and /godmode/agents: those need no approval, where ' +
    '`wp godmode chat wait` or `read` through /wp/cli would ask every time. Never queue a wait (async: true).',
};

/**
 * WP-CLI ends every command's help with its global parameters (--url, --user, --skip-plugins, …):
 * some 1.5 KB, the same each time, left out. The section comes last, so the last such heading is
 * WP-CLI's own, whatever a plugin's text holds.
 */
function withoutGlobalParameters(help: string): string {
  const at = help.lastIndexOf('\nGLOBAL PARAMETERS\n');
  return at === -1 ? help : help.slice(0, at);
}

export function registerWpRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const requireRunningSite = async (slug: string): Promise<{ site: SiteRow; server: ServerHandle }> => {
    const site = deps.sites.bySlug(slug);
    const server = deps.servers.handleFor(site.serverId);
    const state = await server.docker.containerState(site.containerName);
    if (state !== 'running') throw conflict(`Site container is ${state}; start the site first`);
    return { site, server };
  };

  r.get('/api/sites/:slug/wp/plugins', { schema: { params: slugParams } }, async (req) => {
    const { site, server } = await requireRunningSite(req.params.slug);
    return { items: await server.wp.listPlugins(site.containerName) };
  });

  r.get('/api/sites/:slug/wp/version', { schema: { params: slugParams } }, async (req) => {
    const { site, server } = await requireRunningSite(req.params.slug);
    return { version: await server.wp.coreVersion(site.containerName) };
  });

  /**
   * The site's WordPress snapshot: plugins, themes, core and the vulnerability verdict.
   *
   * A database read, deliberately: the numbers come from the last scan rather than from a
   * `docker exec` per page load, so this answers instantly, answers for a stopped site,
   * and answers the same thing the fleet page shows. `scannedAt: null` means "never
   * scanned", which the UI shows as such.
   */
  r.get('/api/sites/:slug/wp/status', { schema: { params: slugParams } }, async (req) => {
    const site = deps.sites.bySlug(req.params.slug);
    return deps.wpInventory.statusFor(site);
  });

  /**
   * Re-read this one site now. Synchronous (a handful of wp-cli calls, ~5-20 s) because
   * "Check now" is a question, not an operation - and rate-limited so a held-down button
   * cannot turn into a wp.org hammer.
   */
  r.post(
    '/api/sites/:slug/wp/scan',
    { schema: { params: slugParams }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req) => {
      const { site, server } = await requireRunningSite(req.params.slug);
      await deps.wpInventory.scanSite(site, server, {
        log: (level, message) => req.log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](message),
      });
      return deps.wpInventory.statusFor(site);
    },
  );

  for (const action of ['activate', 'update'] as const) {
    r.post(`/api/sites/:slug/wp/themes/:name/${action}`, { schema: { params: pluginParams } }, async (req, reply) => {
      const site = deps.sites.bySlug(req.params.slug);
      const job = deps.worker.enqueue(
        'wp.themeTask',
        { siteId: site.id, action, name: req.params.name },
        { id: site.id, slug: site.slug, serverId: site.serverId },
      );
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    });
  }

  r.delete('/api/sites/:slug/wp/themes/:name', { schema: { params: pluginParams } }, async (req, reply) => {
    const site = deps.sites.bySlug(req.params.slug);
    const job = deps.worker.enqueue(
      'wp.themeTask',
      { siteId: site.id, action: 'delete', name: req.params.name },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  /**
   * Several operations on one site as a single job: what "Update all" and "Fix vulnerable"
   * post. `ops: []` is not accepted - an empty run that "succeeds" reads as a lie.
   */
  r.post(
    '/api/sites/:slug/wp/bulk',
    { schema: { params: slugParams, body: wpBulkOpsBody } },
    async (req, reply) => {
      const site = deps.sites.bySlug(req.params.slug);
      // Validated against the snapshot, exactly as the fleet endpoint does: an op that
      // cannot possibly work is a 400 now rather than a failed job in two minutes.
      const ops = deps.wpBulk.validateOps(site, req.body.ops);
      const job = deps.worker.enqueue(
        'wp.bulkTask',
        {
          siteId: site.id,
          ops,
          backupFirst: req.body.backupFirst,
          healthCheck: req.body.healthCheck,
        },
        { id: site.id, slug: site.slug, serverId: site.serverId },
      );
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    },
  );

  r.post('/api/sites/:slug/wp/core-update', { schema: { params: slugParams } }, async (req, reply) => {
    const site = deps.sites.bySlug(req.params.slug);
    const job = deps.worker.enqueue(
      'wp.coreUpdate',
      { siteId: site.id },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post(
    '/api/sites/:slug/wp/plugins',
    { schema: { params: slugParams, body: wpPluginInstallBody } },
    async (req, reply) => {
      const site = deps.sites.bySlug(req.params.slug);
      const job = deps.worker.enqueue(
        'wp.pluginTask',
        { siteId: site.id, action: 'install', source: req.body.source, activate: req.body.activate },
        { id: site.id, slug: site.slug, serverId: site.serverId },
      );
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    },
  );

  for (const action of ['activate', 'deactivate', 'update'] as const) {
    r.post(`/api/sites/:slug/wp/plugins/:name/${action}`, { schema: { params: pluginParams } }, async (req, reply) => {
      const site = deps.sites.bySlug(req.params.slug);
      const job = deps.worker.enqueue(
        'wp.pluginTask',
        { siteId: site.id, action, name: req.params.name },
        { id: site.id, slug: site.slug, serverId: site.serverId },
      );
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    });
  }

  r.delete('/api/sites/:slug/wp/plugins/:name', { schema: { params: pluginParams } }, async (req, reply) => {
    const site = deps.sites.bySlug(req.params.slug);
    const job = deps.worker.enqueue(
      'wp.pluginTask',
      { siteId: site.id, action: 'delete', name: req.params.name },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post(
    '/api/sites/:slug/wp/users/reset-password',
    { schema: { params: slugParams, body: wpResetPasswordBody } },
    async (req) => {
      const { site, server } = await requireRunningSite(req.params.slug);
      const newPassword = await server.wp.resetPassword(site.containerName, req.body.user);
      return { user: req.body.user, newPassword };
    },
  );

  r.get('/api/sites/:slug/wp/maintenance', { schema: { params: slugParams } }, async (req) => {
    const { site, server } = await requireRunningSite(req.params.slug);
    return { enabled: await server.wp.maintenanceStatus(site.containerName) };
  });

  r.put(
    '/api/sites/:slug/wp/maintenance',
    { schema: { params: slugParams, body: wpMaintenanceBody } },
    async (req) => {
      const { site, server } = await requireRunningSite(req.params.slug);
      await server.wp.maintenance(site.containerName, req.body.enabled);
      return { enabled: req.body.enabled };
    },
  );

  r.post(
    '/api/sites/:slug/wp/test-email',
    { schema: { params: slugParams, body: wpTestEmailBody } },
    async (req) => {
      const { site, server } = await requireRunningSite(req.params.slug);
      const res = await server.wp.testEmail(site.containerName, req.body.to, site.title);
      const accepted = res.stdout.includes('true');
      return {
        accepted,
        detail: accepted
          ? `wp_mail() accepted the message for ${req.body.to} - check the inbox (and the relay logs if it never arrives)`
          : `wp_mail() returned false: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
      };
    },
  );

  /**
   * One-click WordPress login: mints a single-use token and returns the URL that spends
   * it. Deliberately a POST - it changes state on the site, and the token must not end up
   * in a link a browser can be tricked into following.
   */
  r.post('/api/sites/:slug/wp/admin-login', { schema: { params: slugParams } }, async (req) => {
    const { site, server } = await requireRunningSite(req.params.slug);
    const link = await createAdminLoginLink(server, site, deps.config, deps.panelFiles);
    req.log.info(`Site "${site.slug}": minted a one-click WordPress login for "${link.user}"`);
    return link;
  });

  r.post('/api/sites/:slug/wp/cli', { schema: { params: slugParams, body: wpCliBody } }, async (req, reply) => {
    const { async: queued, timeoutMin, ...command } = req.body;
    if (queued && waitsOnGodmode(command.args)) {
      throw badRequest(GODMODE_WAIT_REFUSAL, [{ path: 'async', message: 'a WP Godmode wait cannot be queued' }]);
    }
    const { site, server } = await requireRunningSite(req.params.slug);
    if (queued) {
      // A job in the server's exec lane: its output lands in the job log as it runs, and
      // nothing else on the machine waits for it (src/jobs/handlers/exec.ts).
      const job = deps.worker.enqueue(
        'wp.cli',
        { siteId: site.id, ...command, timeoutMin },
        { id: site.id, slug: site.slug, serverId: site.serverId },
        { lane: execLane(site.serverId), siteSlug: site.slug },
      );
      audit(req, 'wpCli', site.slug, 'queue', { job: job.id });
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    }
    const res = await server.wp.run(site.containerName, command.args, SYNC_WP_MS, { input: command.stdin });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
  });

  /**
   * `wp help`, for a command or for all of them: how a plugin's own WP-CLI commands work, in its own
   * words and for the version this site runs. A GET with nothing but words to pass, so an AI app
   * can read it before running a command it has not met, without being asked each time.
   */
  r.get(
    '/api/sites/:slug/wp/cli/help',
    { schema: { params: slugParams, querystring: wpCliHelpQuery }, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (req) => {
      const { site, server } = await requireRunningSite(req.params.slug);
      const words = req.query.command ? req.query.command.split(' ') : [];
      const args = ['help', ...words];
      const res = await server.wp.run(site.containerName, args, 30_000, { outputCap: 256 * 1024 });
      if (res.exitCode !== 0 && /is not a registered (wp command|subcommand)/.test(`${res.stderr}\n${res.stdout}`)) {
        throw notFound(
          `This site has no \`wp ${words.join(' ')}\`: neither WP-CLI nor a plugin here adds it. ` +
            `GET /api/sites/${site.slug}/wp/cli/help lists what does exist.`,
        );
      }
      if (res.exitCode !== 0) {
        throw badGateway(`wp ${args.join(' ')} failed (exit ${res.exitCode})`, {
          stdout: res.stdout.trim().slice(0, 2000),
          stderr: res.stderr.trim().slice(0, 2000),
        });
      }
      const note = words[0] ? HELP_NOTES[words[0]] : undefined;
      return {
        command: words.length > 0 ? words.join(' ') : null,
        help: withoutGlobalParameters(res.stdout).trimEnd(),
        ...(note ? { panel: note.replaceAll('{slug}', site.slug) } : {}),
      };
    },
  );

  // ---------------------------------------------------------------- WP Godmode

  const godmodeRuns = new Map<string, { result: Promise<RunResult>; callers: number; hangUp: AbortController }>();

  /**
   * Run a `wp godmode` command the panel built, for a caller who will poll it again and again:
   * - the same command already running for someone else - an app retrying a wait its client gave
   *   up on - is joined, not run a second time;
   * - a caller who hangs up is not waited for, and once the last one has, the command is hung up
   *   on too, which frees its connection (the command itself ends at its deadline).
   */
  async function askGodmode(slug: string, args: string[], timeoutMs: number, reply: FastifyReply): Promise<Record<string, unknown>> {
    const { site, server } = await requireRunningSite(slug);
    const key = `${site.containerName}\0${args.join('\0')}`;
    let run = godmodeRuns.get(key);
    if (!run) {
      const hangUp = new AbortController();
      const result = server.wp.run(site.containerName, args, timeoutMs, { signal: hangUp.signal });
      const started = { result, callers: 0, hangUp };
      godmodeRuns.set(key, started);
      const done = () => {
        if (godmodeRuns.get(key) === started) godmodeRuns.delete(key);
      };
      result.then(done, done);
      run = started;
    }
    const joined = run;
    joined.callers++;
    let waiting = true;
    const leave = () => {
      if (!waiting) return;
      waiting = false;
      joined.callers--;
    };
    // 'close' before the answer went out: the caller hung up. The last one to go hangs up on the
    // command, which then takes no one new: a caller arriving now starts it afresh.
    const onClose = () => {
      if (reply.raw.writableFinished) return;
      leave();
      if (joined.callers > 0) return;
      joined.hangUp.abort();
      if (godmodeRuns.get(key) === joined) godmodeRuns.delete(key);
    };
    reply.raw.once('close', onClose);
    try {
      return godmodeAnswer(await joined.result, args.slice(0, 3).join(' '));
    } finally {
      leave();
      reply.raw.off('close', onClose);
    }
  }

  /**
   * WP Godmode's chats and agents on this site, through the plugin's own WP-CLI commands with
   * arguments the panel builds - which is what lets an AI app read and wait on them without being
   * asked each time, where `/wp/cli` above runs whatever it is given. The plugin's JSON comes back
   * as it printed it, an `ok: false` answer included (services/wp.ts godmodeAnswer), capped at
   * WP Godmode's own 20,000 characters whatever a wp-cli.yml says.
   *
   * Always synchronous: a wait sits out up to 40 s of a chat working, and as a job it would hold
   * the server's exec lane - one command at a time for every site on the machine - all along.
   */
  const MAX_CHARS = '--max-chars=20000';
  /** Reads and lists; a wait gets its seconds on top, up to the synchronous deadline. */
  const GODMODE_READ_MS = 30_000;

  r.get(
    '/api/sites/:slug/godmode/chats',
    { schema: { params: slugParams, querystring: godmodeChatListQuery } },
    async (req, reply) => {
      const { parent } = req.query;
      const args = ['godmode', 'chat', 'list', ...(parent ? [`--parent=${parent}`] : [])];
      return askGodmode(req.params.slug, args, GODMODE_READ_MS, reply);
    },
  );

  r.get('/api/sites/:slug/godmode/agents', { schema: { params: slugParams } }, async (req, reply) =>
    askGodmode(req.params.slug, ['godmode', 'agent', 'list'], GODMODE_READ_MS, reply),
  );

  r.get(
    '/api/sites/:slug/godmode/chats/:chatId',
    { schema: { params: godmodeChatParams, querystring: godmodeChatQuery } },
    async (req, reply) => {
      const { chatId } = req.params;
      const { wait, after, last, pending } = req.query;
      const cursor = after === undefined ? [] : [`--after=${after}`];
      if (wait > 0) {
        const args = ['godmode', 'chat', 'wait', chatId, `--timeout=${wait}`, ...cursor, MAX_CHARS];
        return askGodmode(req.params.slug, args, Math.min(SYNC_WP_MS, GODMODE_READ_MS + wait * 1000), reply);
      }
      const args = [
        'godmode',
        'chat',
        'read',
        chatId,
        ...cursor,
        ...(last === undefined ? [] : [`--last=${last}`]),
        ...(pending ? ['--pending'] : []),
        MAX_CHARS,
      ];
      return askGodmode(req.params.slug, args, GODMODE_READ_MS, reply);
    },
  );

  r.post('/api/sites/:slug/shell', { schema: { params: slugParams, body: siteShellBody } }, async (req, reply) => {
    const { site } = await requireRunningSite(req.params.slug);
    const job = deps.worker.enqueue(
      'site.shell',
      { siteId: site.id, command: req.body.command, timeoutMin: req.body.timeoutMin },
      { id: site.id, slug: site.slug, serverId: site.serverId },
      { lane: execLane(site.serverId), siteSlug: site.slug },
    );
    audit(req, 'shell', site.slug, 'queue', { job: job.id });
    return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
  });

  r.post('/api/sites/:slug/wp/rest', { schema: { params: slugParams, body: wpRestBody } }, async (req, reply) => {
    const { site, server } = await requireRunningSite(req.params.slug);
    const { async: queued, timeoutMin, ...request } = req.body;
    const what = { method: request.method, route: maskRestRoute(request.route), user: request.auth?.username ?? null };
    if (queued) {
      const job = deps.worker.enqueue(
        'wp.rest',
        { siteId: site.id, ...request, timeoutMin },
        { id: site.id, slug: site.slug, serverId: site.serverId },
        { lane: execLane(site.serverId), siteSlug: site.slug },
      );
      audit(req, 'wpRest', site.slug, 'queue', { ...what, job: job.id });
      return reply.status(202).header('location', `/api/jobs/${job.id}`).send({ job: jobToDto(job, viewerOf(req)) });
    }
    // Answered within this request, like a synchronous wp-cli call: curl gives up at 45 s,
    // and the exec behind it ten seconds later - inside the ~55 s a request is given.
    const res = await sendWpRest(server.docker, site.containerName, {
      ...request,
      ...restTargetOf(site, deps.config),
      timeoutMs: 45_000,
      bodyCap: 1024 * 1024,
    });
    audit(req, 'wpRest', site.slug, 'request', { ...what, status: res.status });
    if (res.status === null) throw badGateway(`The site did not answer: ${res.error ?? 'no answer came back'}`);
    return res;
  });
}
