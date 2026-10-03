import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiActivityService } from '../services/apiActivity.js';
import type { ApiKeysService } from '../services/apiKeys.js';

type UsedKey = NonNullable<FastifyRequest['apiKeyUsed']>;

/** Who made a request, as the log names it - and, for a tool call, which MCP caller and tool. */
interface Caller {
  key: UsedKey;
  mcp: { connectionId: number | null; tool: string | null } | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The error envelope's `code`, stashed by the error handler for the activity log. */
    apiErrorCode: string | null;
  }
}

const BEARER = 'Bearer ';

/**
 * The API request log: one row per request that presented a Bearer token or came from an MCP
 * tool, written after the response has gone out.
 *
 * `onResponse` rather than `onSend` or the handler itself, for three reasons: the status
 * is final by then, the client is no longer waiting on the write, and requests that never
 * reached a handler are recorded too - which is most of what the log is for. That last
 * case is also why the key is resolved here when the auth gate did not get to run: schema
 * validation happens BEFORE `preHandler`, so a malformed body is rejected before anything
 * has identified the caller, and an unmatched path never identifies one at all.
 *
 * Session requests are deliberately not recorded. The panel polls itself every fifteen
 * seconds; logging that would bury the handful of rows an integration writes and answer a
 * question nobody asks.
 */
export function registerApiActivity(
  app: FastifyInstance,
  activity: ApiActivityService,
  apiKeys: ApiKeysService,
): void {
  app.decorateRequest('apiErrorCode', null);

  app.addHook('onResponse', async (req, reply) => {
    const caller = callerOf(req, apiKeys);
    if (!caller) return;
    write(activity, req, {
      caller,
      status: reply.statusCode,
      errorCode: req.apiErrorCode ?? (reply.statusCode === 404 ? 'not_found' : null),
      durationMs: reply.elapsedTime,
      jobId: jobIdOf(reply.getHeader('location')),
    });
  });
}

/**
 * Record a request `onResponse` will never see.
 *
 * @fastify/websocket hijacks the reply the moment an upgrade succeeds, so the terminal
 * route - a root shell, reachable with a key - would otherwise be the one thing a key can
 * do that leaves no trace. Called once the socket is open, which is why the row is written
 * at the start of the session rather than at its end: a security log that only appears
 * after the session closes (or never, if the panel restarts) is the wrong way round.
 */
export function recordUpgrade(activity: ApiActivityService, req: FastifyRequest, apiKeys: ApiKeysService): void {
  const caller = callerOf(req, apiKeys);
  if (!caller) return;
  // 101 Switching Protocols, and no duration: the row marks the shell opening, and how
  // long the handshake took is not the interesting number about a root shell.
  write(activity, req, { caller, status: 101, errorCode: null, durationMs: 0, jobId: null });
}

/**
 * Record a token the MCP endpoint refused. `/mcp` is not an /api/ route, so the hook above
 * never sees it - and an unknown token knocking on the MCP endpoint is exactly what this log
 * is for. A request with no token at all is not recorded: every client's first request is one,
 * sent to be told where to sign in.
 */
export function recordMcpRefusal(activity: ApiActivityService, req: FastifyRequest, token: string): void {
  write(activity, req, {
    caller: { key: { id: null, name: '', prefix: token.slice(0, 12) }, mcp: { connectionId: null, tool: null } },
    status: 401,
    errorCode: 'unauthorized',
    durationMs: 0,
    jobId: null,
  });
}

/** The caller of a tool call is its MCP principal; anyone else is whatever key they sent. */
function callerOf(req: FastifyRequest, apiKeys: ApiKeysService): Caller | null {
  if (req.mcp) {
    const { principal, tool } = req.mcp;
    const key: UsedKey = principal.apiKey
      ? { id: principal.apiKey.id, name: principal.apiKey.name, prefix: principal.apiKey.prefix }
      : { id: null, name: principal.connection?.client ?? '', prefix: '' };
    return { key, mcp: { connectionId: principal.connection?.id ?? null, tool } };
  }
  const key = resolveKey(req, apiKeys);
  return key ? { key, mcp: null } : null;
}

/** The key behind this request, resolving the token again when the gate never ran. */
function resolveKey(req: FastifyRequest, apiKeys: ApiKeysService): UsedKey | null {
  if (req.apiKeyUsed) return req.apiKeyUsed;

  // The gate never identified anyone - a rejected body, an unmatched path, a public route
  // - but a token was presented, and which key called a path that has moved (or sent a
  // body the panel refuses) is exactly what somebody debugging needs.
  //
  // The matched route decides what counts as an API call, and a decoded path only stands
  // in when nothing matched: find-my-way decodes percent-escapes before routing, so
  // `/%61pi/sites` reaches the real handler and a raw-string test would skip it - the same
  // trap the auth gate itself is written around (plugins/auth.ts).
  const routeUrl = req.routeOptions?.url;
  const isApi = routeUrl ? routeUrl.startsWith('/api/') : looksLikeApi(pathOf(req));
  if (!isApi) return null;

  const header = req.headers.authorization;
  if (!header?.startsWith(BEARER)) return null;
  const token = header.slice(BEARER.length).trim();
  const key = apiKeys.verify(token);
  return key ? { id: key.id, name: key.name, prefix: key.prefix } : { id: null, name: '', prefix: token.slice(0, 12) };
}

function write(
  activity: ApiActivityService,
  req: FastifyRequest,
  event: { caller: Caller; status: number; errorCode: string | null; durationMs: number; jobId: number | null },
): void {
  try {
    activity.record({
      keyId: event.caller.key.id,
      keyName: event.caller.key.name,
      keyPrefix: event.caller.key.prefix,
      method: req.method,
      // As sent, not as routed: an escaped path is worth seeing verbatim, and `route`
      // carries the canonical pattern for anyone grouping by endpoint.
      path: pathOf(req),
      route: req.routeOptions?.url ?? null,
      status: event.status,
      errorCode: event.errorCode,
      durationMs: event.durationMs,
      ip: req.ip || null,
      userAgent: req.headers['user-agent'] ?? null,
      jobId: event.jobId,
      mcp: event.caller.mcp,
    });
  } catch (err) {
    // A log that cannot be written must not turn a successful call into an error; the
    // response has already been sent either way.
    req.log.warn({ err }, 'api activity not recorded');
  }
}

const pathOf = (req: FastifyRequest): string => req.url.split('?')[0] ?? req.url;

/** For paths that matched nothing: `/%61pi/nope` is an API call the router just missed. */
function looksLikeApi(path: string): boolean {
  if (path.startsWith('/api/')) return true;
  try {
    return decodeURIComponent(path).startsWith('/api/');
  } catch {
    return false; // malformed escape; it matched no route either way
  }
}

/** `Location: /api/jobs/17` -> 17, so an async call's row links straight to its job. */
function jobIdOf(location: number | string | string[] | undefined): number | null {
  if (typeof location !== 'string') return null;
  const match = /^\/api\/jobs\/(\d+)$/.exec(location);
  return match ? Number(match[1]) : null;
}
