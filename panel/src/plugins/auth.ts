// @docs integrations/api
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKeysService } from '../services/apiKeys.js';
import { userRef, type PanelUserRef, type UsersService } from '../services/users.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { ACCESS_LABELS, allows, type AccessLevel } from '../../shared/access.js';
import { endpointFor, levelFor, levelRefusal, mcpToolGroup } from '../../shared/apiDocs.js';
import { currentMcpCall, TOOL_FOR_GROUP, type McpCall } from '../mcp/call.js';

declare module 'fastify' {
  interface FastifyRequest {
    authVia: 'session' | 'apiKey' | 'mcp' | null;
    /**
     * The key behind a Bearer request, for the activity log. `id` is null when the token
     * was refused; `prefix` is the non-secret first 12 characters as presented, so a
     * rejected token is still identifiable without ever storing the secret itself.
     */
    apiKeyUsed: { id: number | null; name: string; prefix: string } | null;
    /**
     * The admin behind a session request, read from the users table on every request - so a
     * rename shows at once and a deleted account stops working at once. Null for an API key,
     * which belongs to the panel rather than to any one admin - and for an MCP call, even one
     * from an app an admin approved: the app acts as itself.
     */
    user: PanelUserRef | null;
    /**
     * What this request may do, once the gate has let it in: Full for a session, a key's own
     * level, the MCP caller's. Null on the routes that need no sign-in.
     */
    access: AccessLevel | null;
    /** The tool call behind a request the MCP server made into the API (src/mcp/call.ts). */
    mcp: McpCall | null;
  }
  interface Session {
    /**
     * Whose password was accepted. Set at the password step rather than at the end, so a
     * half-login knows whose code it is waiting for and whose guess budget a wrong one spends.
     */
    userId?: number;
    /**
     * The account's session generation when this session signed in. A revocation raises the
     * account's, and a session of an older one no longer counts - see revokeSessions.
     */
    generation?: number;
    authenticated?: boolean;
    /**
     * Set when the password was accepted but 2FA is on: the login is half done and this
     * session may do nothing until POST /api/auth/login/totp sets `authenticated`.
     */
    totpPendingUntil?: number;
  }
}

const PUBLIC_ROUTES = new Set([
  '/api/auth/login',
  '/api/auth/login/totp',
  // The emailed-link routes: whoever holds the link is not signed in, which is the point.
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/confirm-email',
  '/api/health',
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Auth gate for /api/*:
 *  - `Authorization: Bearer wpl7_…` -> API key lookup (CSRF-immune by construction), held to
 *    the level the key was given
 *  - session cookie -> additionally requires the `X-CSRF: 1` header on mutating requests.
 *    With no CORS registered anywhere, cross-origin preflights for that header fail closed.
 *  - a tool call of the MCP server (src/mcp/call.ts) -> held to its caller's level, to the
 *    tool it came through, and to the endpoints MCP may never reach
 *
 * The gate keys off the MATCHED ROUTE (`routeOptions.url`), never the raw request URL:
 * find-my-way decodes percent-escapes before routing, so `GET /%61pi/sites` reaches the
 * real `/api/sites` handler while a raw-string `startsWith('/api/')` test would wave it
 * through unauthenticated. Requests that matched no route (routeOptions.url undefined)
 * fall through to the 404 handler, which serves no data. The level an endpoint needs comes
 * from the API catalog (shared/apiDocs.ts); one the catalog does not know needs Full.
 */
export function registerAuth(app: FastifyInstance, apiKeys: ApiKeysService, users: UsersService): void {
  app.decorateRequest('authVia', null);
  app.decorateRequest('apiKeyUsed', null);
  app.decorateRequest('user', null);
  app.decorateRequest('access', null);
  app.decorateRequest('mcp', null);

  // A tool call is decided here, before its body is parsed - and before the public-route
  // shortcut below, which would otherwise let a tool reach POST /api/auth/login.
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const call = currentMcpCall();
    if (!call) return;
    req.mcp = call;
    const routeUrl = req.routeOptions?.url;
    call.matched = routeUrl ?? null;
    // Matched nothing: the 404 handler answers, and it serves no data.
    if (!routeUrl) return;
    const endpoint = endpointFor(req.method, routeUrl);
    const group = endpoint ? mcpToolGroup(endpoint) : null;
    if (!endpoint || group === null) throw forbidden(`${req.method} ${routeUrl} is not available through MCP`);
    if (group !== call.group) {
      throw forbidden(`${req.method} ${routeUrl} is reached through ${TOOL_FOR_GROUP[group]}, not ${call.tool}`);
    }
    const who = call.principal.kind === 'apiKey' ? 'This key' : 'This connection';
    if (!allows(call.principal.access, endpoint.level)) {
      throw forbidden(levelRefusal(who, call.principal.access, req.method, routeUrl, endpoint.level));
    }
    req.authVia = 'mcp';
    req.access = call.principal.access;
  });

  app.addHook('preHandler', async (req: FastifyRequest, _reply: FastifyReply) => {
    const routeUrl = req.routeOptions?.url;
    if (!routeUrl || !routeUrl.startsWith('/api/')) return; // SPA assets / unmatched
    if (req.authVia === 'mcp') return; // decided in onRequest
    if (PUBLIC_ROUTES.has(routeUrl)) return;

    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice('Bearer '.length).trim();
      const key = apiKeys.verify(token);
      if (key) {
        req.authVia = 'apiKey';
        req.apiKeyUsed = { id: key.id, name: key.name, prefix: key.prefix };
        req.access = key.access;
        const needed = levelFor(req.method, routeUrl);
        if (!allows(key.access, needed)) throw forbidden(levelRefusal('This key', key.access, req.method, routeUrl, needed));
        return;
      }
      req.apiKeyUsed = { id: null, name: '', prefix: token.slice(0, 12) };
      throw unauthorized('Invalid or revoked API key');
    }

    if (req.session?.authenticated) {
      const row = req.session.userId === undefined ? null : users.byId(req.session.userId);
      if (!row || (req.session.generation ?? 0) !== row.sessionGeneration) {
        // The account was removed, or its sessions revoked since this one signed in. The
        // store no longer saves such a session, so this is the second line, not the first.
        await req.session.destroy();
        throw unauthorized();
      }
      req.authVia = 'session';
      req.user = userRef(row);
      req.access = 'full';
      if (!SAFE_METHODS.has(req.method) && req.headers['x-csrf'] !== '1') {
        throw forbidden('Missing X-CSRF header');
      }
      return;
    }

    throw unauthorized();
  });
}

/**
 * For the few handlers whose body decides what a call needs - a bulk run that deletes, say -
 * which a route's one level cannot express. Refuses with both sides named, like the gate.
 */
export function requireAccess(req: FastifyRequest, needed: AccessLevel, what: string): void {
  const granted = req.access ?? 'read';
  if (allows(granted, needed)) return;
  const who = req.mcp ? (req.mcp.principal.kind === 'apiKey' ? 'This key' : 'This connection') : 'This key';
  throw forbidden(`${who} is ${ACCESS_LABELS[granted]}; ${what} needs ${ACCESS_LABELS[needed]}`);
}
