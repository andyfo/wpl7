// @docs integrations/mcp
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { AccessLevel } from '../../shared/access.js';
import { mcpGroupReachable, type McpToolGroup } from '../../shared/apiDocs.js';
import { SLUG_RE } from '../../shared/schemas.js';
import { jobs } from '../db/schema.js';
import type { AppDeps } from '../routes/deps.js';
import { injectAs, type McpCall, type McpPrincipal } from './call.js';
import { docsOverview, endpointDocs, searchDocs, type RouteSchemas } from './docs.js';
import { ANSWER_BUDGET, fitAnswer, project } from './shape.js';

/**
 * The MCP server's tools: the whole REST API through a handful of generic ones, one per kind of
 * call - reading, changing, destroying - so that an AI client can let the reading tool run on
 * its own and still ask before every change, and before every destructive one. Which of them a
 * connection sees follows from its level: a tool is listed when the level reaches anything
 * through it. Every tool is a client of the API (src/mcp/call.ts), never a second way to do
 * what it does - the auth gate decides what each call may do, in the one place it always has.
 */

export interface ToolContext {
  app: FastifyInstance;
  deps: AppDeps;
  schemas: RouteSchemas;
  principal: McpPrincipal;
  /** The MCP client's address and user agent, which every call it makes carries into the log. */
  ip: string;
  userAgent: string | undefined;
}

// ------------------------------------------------------------------ inputs

/**
 * An API path, as the router will see it. No `%`: find-my-way decodes escapes before matching,
 * and the gate has to judge the path the router matches. No `?` or `#` either (the query has
 * its own field), and no `.` or `..` segments.
 */
const apiPath = z
  .string()
  .max(400)
  .regex(/^\/api(\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)+$/, 'an API path such as /api/sites/my-shop: no query string, no %-escapes')
  .refine((p) => !p.split('/').some((s) => s === '.' || s === '..'), 'no "." or ".." in the path')
  .describe('The endpoint path, e.g. /api/sites or /api/sites/my-shop/backups');

const queryField = z
  .record(z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/), z.union([z.string().max(2000), z.number(), z.boolean()]))
  .describe('Query string parameters, e.g. {"limit": 20, "status": "failed"}');

const selectField = z
  .array(z.string().regex(/^[A-Za-z0-9_.]{1,60}$/))
  .max(20)
  .describe('Keep only these fields (dotted paths allowed) of each item in the lists the answer holds, e.g. ["slug", "status"]');

const bodyField = z.record(z.string(), z.unknown()).describe('The JSON body; wpl7_api_docs gives its schema');

const siteField = z.string().regex(SLUG_RE, 'a site slug, e.g. my-shop').describe("The site's slug");
const filePath = z
  .string()
  .min(1)
  .max(4096)
  .describe("Relative to the site's WordPress folder, e.g. wp-config.php or wp-content/themes/mytheme/style.css");

// ------------------------------------------------------------------ calling the API

interface ApiAnswer {
  status: number;
  /** `METHOD /api/pattern` as the router matched it, or the path as sent when nothing matched. */
  endpoint: string;
  matched: boolean;
  body: unknown;
  raw: Buffer;
  headers: Record<string, string | string[] | number | undefined>;
}

async function callApi(
  c: ToolContext,
  tool: string,
  group: McpToolGroup,
  req: {
    method: string;
    path: string;
    query?: Record<string, string | number | boolean>;
    body?: unknown;
    raw?: Buffer;
    headers?: Record<string, string>;
  },
): Promise<ApiAnswer> {
  const qs = req.query ? new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)])).toString() : '';
  const call: McpCall = { principal: c.principal, group, tool, matched: null };
  const headers: Record<string, string> = { ...(c.userAgent ? { 'user-agent': c.userAgent } : {}), ...req.headers };
  let payload: string | Buffer | undefined;
  if (req.raw) {
    payload = req.raw;
    headers['content-type'] = 'application/octet-stream';
  } else if (req.body !== undefined) {
    payload = JSON.stringify(req.body);
    headers['content-type'] = 'application/json';
  }
  const res = await injectAs(c.app, call, {
    method: req.method as 'GET',
    url: qs ? `${req.path}?${qs}` : req.path,
    headers,
    ...(payload !== undefined ? { payload } : {}),
    remoteAddress: c.ip,
  });
  const json = String(res.headers['content-type'] ?? '').includes('application/json');
  let body: unknown = null;
  if (json) {
    try {
      body = JSON.parse(res.body);
    } catch {
      body = res.body;
    }
  }
  return {
    status: res.statusCode,
    endpoint: `${req.method} ${call.matched ?? req.path}`,
    matched: call.matched !== null,
    body,
    raw: res.rawPayload,
    headers: res.headers,
  };
}

const text = (value: Record<string, unknown>, isError = false): CallToolResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: 'text', text: fitAnswer(value) }],
});

/** A 2xx as `{status, endpoint, body}`, and where a job was queued, what to call next. */
function answer(a: ApiAnswer, select?: string[]): CallToolResult {
  if (a.status >= 400) return failure(a);
  const location = typeof a.headers.location === 'string' ? a.headers.location : '';
  const job = /^\/api\/jobs\/(\d+)$/.exec(location);
  return text({
    status: a.status,
    endpoint: a.endpoint,
    body: project(a.body, select),
    ...(a.status === 202 && job ? { next: `Follow it with wpl7_wait_for_job {"jobId": ${job[1]}} until done is true` } : {}),
  });
}

/** The panel's own error envelope, as it came, with a line on what to do about it. */
function failure(a: ApiAnswer): CallToolResult {
  const envelope = (a.body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  const error = envelope ?? { code: 'internal', message: `HTTP ${a.status}` };
  const hint = hintFor(error.code ?? '', error.message ?? '', a);
  return text({ status: a.status, endpoint: a.endpoint, error, ...(hint ? { hint } : {}) }, true);
}

function hintFor(code: string, message: string, a: ApiAnswer): string | null {
  switch (code) {
    case 'job_conflict': {
      const id = /#(\d+)/.exec(message)?.[1];
      return `Another job has this site right now. Wait for it with wpl7_wait_for_job${id ? ` {"jobId": ${id}}` : ''}, then retry.`;
    }
    case 'rate_limited': {
      const after = a.headers['retry-after'];
      return `Over a rate limit (the panel's 300 requests a minute, or an endpoint's own). Wait${after ? ` ${after} seconds` : ' a minute'} before the next call; do not retry in a loop.`;
    }
    case 'maintenance':
      return 'The panel is updating itself. Reading still works; try changes again in a few minutes.';
    case 'validation_error':
      return `The input is not what the endpoint takes; details says where. wpl7_api_docs {"endpoint": "${a.endpoint}"} gives its exact schema.`;
    case 'forbidden':
      return 'Refused, and retrying will not change that. Where the message names a level, an admin can raise it on the MCP page of the panel.';
    case 'not_found':
      return a.matched
        ? 'Nothing by that id or slug. List what exists first (e.g. GET /api/sites).'
        : 'No such endpoint. Find the right path with wpl7_api_docs.';
    case 'precondition_failed':
      return 'The file changed since it was read. Read it again with wpl7_read_site_file, redo the change on the new text, and save with the new etag.';
    case 'syntax_error':
      return 'The PHP does not parse, so nothing was saved; details has the line. Fix it and save again.';
    case 'bad_gateway':
      return 'A server the panel talks to did not answer. Try again later, or look at GET /api/servers.';
    case 'timeout':
      return (
        'The command ran out of time and was stopped. A read can simply be asked again; after a change (a send, an ' +
        'answer), read the result first - it may have happened - before doing it again.'
      );
    default:
      return null;
  }
}

/** Whatever went wrong outside the API: never a stack trace, and never silence. */
async function guarded(run: () => Promise<CallToolResult>, c: ToolContext): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    c.deps.log.warn(`MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`);
    return text({ error: { code: 'internal', message: 'The panel could not complete this call; its log has the details' } }, true);
  }
}

// ------------------------------------------------------------------ the tools

const FINISHED = new Set(['succeeded', 'failed', 'canceled']);
/** A job's log is cut to its newest lines past this, so its outcome always fits in the answer. */
const LOG_BUDGET = 30_000;

/** The last sentence of the change and destroy tools: what this connection's level reaches. */
function reachNote(access: AccessLevel): string {
  return access === 'full'
    ? 'This connection has Full access: the panel itself too.'
    : "This connection has Manage access: everything inside the sites, but not the panel's own servers, mail, " +
        'offsite destinations, catalog, recipes and settings, nor the backup policy (built-in schedules, schedules ' +
        'that take backups, deleting backups) or deleting sites.';
}

export function registerTools(server: McpServer, c: ToolContext): void {
  const access = c.principal.access;

  server.registerTool(
    'wpl7_api_docs',
    {
      title: 'WPL7 API reference',
      description:
        "The reference for the WPL7 hosting panel's REST API, which the other wpl7_ tools call. With no arguments: how the " +
        'API works, its groups of endpoints and worked examples. {query: "backup"} searches; {group: "wp"} lists a group; ' +
        '{endpoint: "POST /api/sites"} gives one endpoint in full, with the exact JSON Schema of its path, query and body. ' +
        'Each endpoint names the tool that reaches it.',
      inputSchema: z
        .object({
          query: z.string().max(200).optional().describe('Words to search the endpoints for, e.g. "plugin update"'),
          group: z.string().max(40).optional().describe('A group id from the overview, e.g. "sites", "wp", "backups"'),
          endpoint: z.string().max(400).optional().describe('One endpoint, e.g. "POST /api/sites/:slug/backups"'),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, group, endpoint }) =>
      guarded(async () => {
        if (endpoint) return text(endpointDocs(access, c.schemas, endpoint));
        if (query || group) return text(searchDocs(access, query, group));
        return text(docsOverview(access));
      }, c),
  );

  server.registerTool(
    'wpl7_api_get',
    {
      title: 'Read from WPL7',
      description:
        "Read from the WPL7 hosting panel's REST API: sites, servers, jobs, backups, the WordPress inventory, mail, " +
        'visitor traffic and settings. Takes an API path such as /api/sites or /api/sites/my-shop/wp/status (find paths ' +
        'with wpl7_api_docs). Changes nothing. Answers {status, endpoint, body}; `select` trims long lists to the fields ' +
        'you need.',
      inputSchema: z.object({ path: apiPath, query: queryField.optional(), select: selectField.optional() }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, query, select }) =>
      guarded(async () => answer(await callApi(c, 'wpl7_api_get', 'get', { method: 'GET', path, query }), select), c),
  );

  server.registerTool(
    'wpl7_wait_for_job',
    {
      title: 'Wait for a WPL7 job',
      description:
        'Wait for a job of the WPL7 hosting panel - what every 202 answer names - to finish, for up to timeoutSeconds ' +
        '(default 25, at most 50). Answers with its status, whether it is done, its result, the log lines after logAfter, ' +
        'and lastSeq to pass as the next logAfter. Call it again while done is false.',
      inputSchema: z
        .object({
          jobId: z.number().int().positive().describe('The job id from a 202 answer'),
          logAfter: z.number().int().min(0).default(0).describe('Only log lines after this lastSeq'),
          timeoutSeconds: z.number().int().min(1).max(50).default(25).describe('How long to wait at most'),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ jobId, logAfter, timeoutSeconds }) =>
      guarded(async () => {
        // Watch the row - one read of a column - and read through the API once at the end, so
        // a wait is one row in the activity log rather than fifty.
        const deadline = Date.now() + timeoutSeconds * 1000;
        const statusOf = () => c.deps.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get()?.status;
        let status = statusOf();
        while (status !== undefined && !FINISHED.has(status) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
          status = statusOf();
        }
        const a = await callApi(c, 'wpl7_wait_for_job', 'get', {
          method: 'GET',
          path: `/api/jobs/${jobId}`,
          query: { logAfter },
        });
        if (a.status >= 400) return failure(a);
        return text(jobAnswer(a.body as JobDetail));
      }, c),
  );

  if (mcpGroupReachable('change', access)) {
    server.registerTool(
      'wpl7_api_change',
      {
        title: 'Change something in WPL7',
        description:
          "Make a change through the WPL7 hosting panel's REST API that deletes and overwrites nothing and runs no " +
          'command: create sites, take backups, install, activate and update plugins, themes and WordPress core, start ' +
          'and restart sites, switch PHP, add FTP logins, sign in to wp-admin, create folders. Whatever runs a ' +
          'command, deletes, overwrites or goes live goes through wpl7_api_dangerous. Slow work answers 202 with a ' +
          'job to follow with wpl7_wait_for_job. Find endpoints and their input with wpl7_api_docs; each names the ' +
          `tool that reaches it. ${reachNote(access)}`,
        inputSchema: z
          .object({
            method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
            path: apiPath,
            query: queryField.optional(),
            body: bodyField.optional(),
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ method, path, query, body }) =>
        guarded(async () => {
          // The routes' body schemas are objects; an omitted body is an empty one, except on DELETE.
          const sent = body ?? (method === 'DELETE' ? undefined : {});
          return answer(await callApi(c, 'wpl7_api_change', 'change', { method, path, query, body: sent }));
        }, c),
    );
  }

  if (mcpGroupReachable('dangerous', access)) {
    server.registerTool(
      'wpl7_api_dangerous',
      {
        title: 'Destructive WPL7 call',
        description:
          "Call the endpoints of the WPL7 hosting panel's REST API that it marks destructive - whatever runs a " +
          'command, deletes, overwrites or takes a safety net away: WP-CLI, shell commands and WordPress REST ' +
          'requests in a site, and schedules of them; deleting plugins, themes, files, FTP logins and schedules; bulk ' +
          'runs, which can delete; moving, extracting or compressing files over others, or saving over them; resetting ' +
          "a WordPress or FTP password; going live or changing a site's domains, which rewrites its address " +
          'throughout its database; applying recipes; stopping sites; restoring backups; cancelling jobs - and, with ' +
          'Full access, deleting sites, backups, servers and offsite destinations, settings, DNS records and mail ' +
          'keys, setting servers up, switching backups off and updating the panel. Much of this cannot be undone: ' +
          `tell the user exactly what you are about to do before you do it. ${reachNote(access)}`,
        inputSchema: z
          .object({
            method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
            path: apiPath,
            query: queryField.optional(),
            body: bodyField.optional(),
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ method, path, query, body }) =>
        guarded(async () => {
          const sent = body ?? (method === 'DELETE' ? undefined : {});
          return answer(await callApi(c, 'wpl7_api_dangerous', 'dangerous', { method, path, query, body: sent }));
        }, c),
    );
  }

  if (mcpGroupReachable('file', access)) {
    server.registerTool(
      'wpl7_read_site_file',
      {
        title: "Read a site's file",
        description:
          "Read a text file of a WPL7 site - relative to its WordPress folder, e.g. wp-config.php or " +
          'wp-content/themes/mytheme/functions.php - by line range, up to 2000 lines a call. Answers with the lines, ' +
          'the total count and an etag: pass the etag to wpl7_write_site_file, so a save never overwrites a change made ' +
          'in between. List a folder with wpl7_api_get /api/sites/{site}/files and query {path}.',
        inputSchema: z
          .object({
            site: siteField,
            path: filePath,
            startLine: z.number().int().min(1).default(1).describe('First line to return, counting from 1'),
            maxLines: z.number().int().min(1).max(2000).default(500).describe('How many lines at most'),
          })
          .strict(),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ site, path, startLine, maxLines }) =>
        guarded(async () => {
          const a = await callApi(c, 'wpl7_read_site_file', 'file', {
            method: 'GET',
            path: `/api/sites/${site}/files/content`,
            query: { path },
          });
          if (a.status >= 400) return failure(a);
          return text(fileAnswer(site, path, a, startLine, maxLines));
        }, c),
    );

    server.registerTool(
      'wpl7_write_site_file',
      {
        title: "Save a site's file",
        description:
          "Save a whole text file of a WPL7 site, relative to its WordPress folder. Needs either the etag " +
          'wpl7_read_site_file gave - refused if the file changed since - or createOnly: true for a new file, refused if ' +
          'one exists. There is no blind overwrite. A .php file is syntax-checked first and refused if it does not ' +
          'parse, so a typo cannot take the site down. `content` is the entire file.',
        inputSchema: z
          .object({
            site: siteField,
            path: filePath,
            content: z.string().max(1_000_000).describe('The whole file'),
            etag: z.string().regex(/^[0-9a-f]{64}$/, 'the etag wpl7_read_site_file returned').optional(),
            createOnly: z.boolean().optional().describe('A new file: refused if the path exists'),
            crlf: z.boolean().optional().describe('Save with Windows line endings, as the read said the file had'),
          })
          .strict()
          .refine((v) => (v.etag !== undefined) !== (v.createOnly === true), {
            message: 'Send exactly one of etag (to replace a file you read) or createOnly: true (for a new file)',
          }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ site, path, content, etag, createOnly, crlf }) =>
        guarded(async () => {
          const bytes = Buffer.from(crlf ? content.replace(/\r?\n/g, '\r\n') : content, 'utf8');
          const a = await callApi(c, 'wpl7_write_site_file', 'file', {
            method: 'PUT',
            path: `/api/sites/${site}/files/content`,
            query: { path, ...(/\.php$/i.test(path) ? { lint: 'php' } : {}) },
            raw: bytes,
            headers: createOnly ? { 'if-none-match': '*' } : { 'if-match': `"${etag}"` },
          });
          if (a.status >= 400) return failure(a);
          const saved = a.body as { path: string; etag: string };
          return text({ status: a.status, site, path: saved.path, etag: saved.etag, bytes: bytes.length });
        }, c),
    );
  }
}

// ------------------------------------------------------------------ answers

interface JobDetail {
  job: {
    id: number;
    type: string;
    status: string;
    siteSlug: string | null;
    summary: string | null;
    error: string | null;
    result: Record<string, unknown> | null;
    createdBy: string | null;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
  };
  logs: { seq: number; ts: number; level: string; message: string }[];
  lastSeq: number;
  logsWithheld?: boolean;
}

/** A job as a wait answers with it: the outcome first, then as much of the newest log as fits. */
function jobAnswer(detail: JobDetail): Record<string, unknown> {
  const { job } = detail;
  const lines = detail.logs.map((l) => (l.level === 'info' ? l.message : `[${l.level}] ${l.message}`));
  let omitted = 0;
  let size = lines.reduce((n, l) => n + l.length + 4, 0);
  while (size > LOG_BUDGET && omitted < lines.length) size -= lines[omitted++]!.length + 4;
  return {
    done: FINISHED.has(job.status),
    status: job.status,
    job: {
      id: job.id,
      type: job.type,
      site: job.siteSlug,
      summary: job.summary,
      startedBy: job.createdBy,
      error: job.error,
      result: job.result,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    },
    log: lines.slice(omitted),
    ...(omitted > 0 ? { logsOmitted: omitted } : {}),
    lastSeq: detail.lastSeq,
    ...(detail.logsWithheld ? { logsWithheld: "A command's output is not shown at Read only access" } : {}),
  };
}

/**
 * A file's lines, or - for anything that is not UTF-8 text - what it is instead.
 *
 * The text always arrives whole: never clipped by the answer's budget (mcp/shape.ts), and with
 * `endLine` saying exactly how far it goes. An app edits this text and saves it back with the
 * etag, which the file still matches - so text cut short in the answer would be a file cut short
 * on the disk.
 */
function fileAnswer(site: string, path: string, a: ApiAnswer, startLine: number, maxLines: number): Record<string, unknown> {
  const etag = String(a.headers.etag ?? '').replace(/"/g, '');
  const bytes = a.raw;
  // No etag with an answer that shows no text: an etag is what lets wpl7_write_site_file replace
  // a file, and replacing one nobody has read is the blind overwrite that tool refuses.
  const unread = { site, path, sizeBytes: bytes.length };
  const base = { ...unread, etag };
  if (bytes.subarray(0, 8192).includes(0)) return { ...unread, binary: true, note: 'A binary file; its bytes are not shown' };
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ...unread, binary: true, note: 'Not UTF-8 text; its bytes are not shown' };
  }
  const crlf = /\r\n/.test(decoded) && !/(^|[^\r])\n/.test(decoded);
  // The decoder drops a byte-order mark, and a save writes none: in front of <?php it is the
  // classic "headers already sent", so losing it is the fix more often than the damage.
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const lines = decoded.split(/\r?\n/);
  const from = Math.min(startLine - 1, lines.length);
  const envelope = (picked: string[]) => {
    const end = from + picked.length;
    return {
      ...base,
      totalLines: lines.length,
      startLine: from + 1,
      endLine: end,
      ...(crlf ? { crlf: true } : {}),
      ...(bom ? { bom: 'The file starts with a byte-order mark; text leaves it out, and a save does not write it back' } : {}),
      text: picked.join('\n'),
      ...(end < lines.length ? { more: `Lines ${end + 1}-${lines.length} not shown; call again with startLine ${end + 1}` } : {}),
    };
  };
  // What the rest of the answer costs, then as many whole lines as fit beside it - counted as
  // JSON, where every quote and backslash takes two characters and every line break two more.
  const room = ANSWER_BUDGET - JSON.stringify(envelope([])).length - 200;
  const picked: string[] = [];
  let size = 0;
  for (const line of lines.slice(from, from + maxLines)) {
    const cost = JSON.stringify(line).length;
    if (size + cost > room) break;
    picked.push(line);
    size += cost;
  }
  if (picked.length === 0 && from < lines.length) {
    return {
      ...unread,
      totalLines: lines.length,
      startLine: from + 1,
      text: null,
      tooLong: `Line ${from + 1} alone is longer than one answer can carry, so this file cannot be read or edited here`,
    };
  }
  return envelope(picked);
}
