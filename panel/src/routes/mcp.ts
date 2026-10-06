// @docs integrations/mcp
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { recordMcpRefusal } from '../plugins/apiActivity.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { mcpOrigin, mcpUnavailableReason } from '../lib/panelUrl.js';
import { mcpConnectionUpdateBody } from '../../shared/schemas.js';
import type { McpPageDto } from '../../shared/types.js';
import type { McpPrincipal } from '../mcp/call.js';
import { ACCESS_TOKEN_PREFIX } from '../services/oauth.js';
import type { RouteSchemas } from '../mcp/docs.js';
import { mcpHandler, type McpRequestInfo } from '../mcp/server.js';
import type { AppDeps } from './deps.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who a request to /mcp is, once its bearer token has been accepted. */
    mcpPrincipal: McpPrincipal | null;
  }
}

/** A tool call can carry a whole file; nobody's body is read before their token is. */
const MCP_BODY_LIMIT = 4 * 1024 * 1024;

/** Connection-level headers of the SDK's answer, which Fastify sets for itself. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding']);

/** The MCP server's own URL, and where a client is told to look to sign in. */
export const mcpUrls = (origin: string) => ({
  resource: `${origin}/mcp`,
  resourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
});

/**
 * Is MCP on here? Switched on, and - in production - a PANEL_DOMAIN with TLS to put in the URLs
 * it hands out. Anything else answers 404, as if none of it existed.
 */
export function mcpAvailable(deps: AppDeps): boolean {
  return deps.settings.get('mcpEnabled') === true && mcpOrigin(deps.config) !== null;
}

/**
 * `POST /mcp`: the MCP server for AI apps (docs/mcp.md), on the panel's own origin.
 *
 * Bearer tokens only - an API key, or an access token an app got through OAuth. The session
 * cookie is never looked at: a browser that is signed in to the panel must not become an MCP
 * client by visiting a page. Everything is decided in onRequest, before a body is read.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: AppDeps, schemas: RouteSchemas): void {
  const handler = mcpHandler(app, deps, schemas);
  app.decorateRequest('mcpPrincipal', null);

  const available = async (req: FastifyRequest) => {
    if (!mcpAvailable(deps)) throw notFound(`Route ${req.method} ${req.url.split('?')[0]} not found`);
  };

  // The 2025 protocol's session stream and session end. This server keeps no session, so
  // there is nothing to open or close - and nothing to sign in for.
  app.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    onRequest: available,
    handler: async (_req, reply) =>
      reply
        .status(405)
        .header('allow', 'POST')
        .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }),
  });

  app.post(
    '/mcp',
    {
      bodyLimit: MCP_BODY_LIMIT,
      onRequest: [
        available,
        async (req, reply) => {
          const origin = mcpOrigin(deps.config)!;
          refuseForeignOrigin(req, origin);
          req.mcpPrincipal = authenticate(req, reply, deps, origin);
        },
      ],
    },
    async (req, reply) => {
      const origin = mcpOrigin(deps.config)!;
      const principal = req.mcpPrincipal!;
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
      }
      const info: McpRequestInfo = { principal, ip: req.ip, userAgent: req.headers['user-agent'] };
      const res = await handler().fetch(new Request(mcpUrls(origin).resource, { method: 'POST', headers }), {
        parsedBody: req.body,
        authInfo: {
          token: '',
          clientId: principal.connection ? `connection:${principal.connection.id}` : `api-key:${principal.apiKey!.id}`,
          scopes: [`wpl7:${principal.access}`],
          extra: { info },
        },
      });
      reply.status(res.status);
      res.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name)) reply.header(name, value);
      });
      // An event stream comes with its own (no-cache, no-transform); nothing here is for a cache.
      if (!res.headers.has('cache-control')) reply.header('cache-control', 'no-store');
      return reply.send(res.body ? Readable.fromWeb(res.body as WebReadableStream) : '');
    },
  );
}

/**
 * The MCP page (Integrations -> MCP): its data, the connection window, and the connected apps.
 * The window is a browser-only thing - it is an admin saying "I am connecting an app now" -
 * so an API key can neither open nor close one.
 */
export function registerMcpPanelRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const idParams = z.object({ id: z.coerce.number().int().positive() });

  const inTheBrowser = (req: FastifyRequest) => {
    if (req.authVia !== 'session' || !req.user) throw forbidden('Only an admin signed in to the panel can do this');
    return req.user;
  };

  r.get('/api/mcp', async (req): Promise<McpPageDto> => {
    const origin = mcpOrigin(deps.config);
    return {
      enabled: deps.settings.get('mcpEnabled') === true,
      unavailable: mcpUnavailableReason(deps.config),
      url: origin ? mcpUrls(origin).resource : null,
      window: deps.oauth.windowFor(req.user?.id ?? null),
      connections: deps.oauth.connections(),
      activity: deps.apiActivity.list({ via: 'mcp', sinceHours: 24 * 30, limit: 20, offset: 0 }).items,
    };
  });

  r.post('/api/mcp/connect-window', async (req) => {
    const user = inTheBrowser(req);
    if (!mcpAvailable(deps)) throw conflict('Switch MCP on first');
    deps.oauth.openWindow(user.id);
    audit(req, 'mcp', '-', 'open connection window', {});
    return { window: deps.oauth.windowFor(user.id) };
  });

  r.delete('/api/mcp/connect-window', async (req, reply) => {
    inTheBrowser(req);
    deps.oauth.closeWindow();
    return reply.status(204).send();
  });

  // The app that registered is not the one being connected: forget it, keep the window.
  r.delete('/api/mcp/connect-window/registration', async (req, reply) => {
    const user = inTheBrowser(req);
    if (!deps.oauth.discardRegistration(user.id)) throw conflict('No app has registered in a window of yours');
    audit(req, 'mcp', '-', 'discard registration', {});
    return reply.status(204).send();
  });

  r.patch('/api/mcp/connections/:id', { schema: { params: idParams, body: mcpConnectionUpdateBody } }, async (req) => {
    if (!deps.oauth.setAccess(req.params.id, req.body.access)) throw notFound(`Connection #${req.params.id} not found`);
    audit(req, 'mcp', '-', 'change access', { connection: req.params.id, access: req.body.access });
    return { connection: deps.oauth.connections().find((c) => c.id === req.params.id)! };
  });

  r.delete('/api/mcp/connections/:id', { schema: { params: idParams } }, async (req, reply) => {
    if (!deps.oauth.revokeConnection(req.params.id)) throw notFound(`Connection #${req.params.id} not found`);
    audit(req, 'mcp', '-', 'revoke', { connection: req.params.id });
    return reply.status(204).send();
  });
}

/**
 * A browser page on another site must not reach /mcp - DNS rebinding, a lured tab - so an
 * Origin that is a web page's has to be the panel's own. `null` (a sandboxed frame, a file)
 * is refused too. Other schemes are an app's own webview (vscode-webview://…), and no
 * Origin at all is a program: a bearer token is what those are judged by.
 */
function refuseForeignOrigin(req: FastifyRequest, origin: string): void {
  const sent = req.headers.origin;
  if (sent === undefined) return;
  if (sent === 'null') throw forbidden('Requests from an opaque origin are refused');
  let url: URL;
  try {
    url = new URL(sent);
  } catch {
    throw forbidden('Unreadable Origin header');
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== new URL(origin).origin) {
    throw forbidden(`Requests from ${url.origin} are refused; MCP answers apps, not other web pages`);
  }
}

/**
 * The bearer token's owner, or a 401 whose WWW-Authenticate header points a client at the
 * sign-in it needs (RFC 9728). A token that was presented and refused is written to the API
 * activity log; a request with none is every client's first, sent to be told where to sign in.
 */
function authenticate(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, origin: string): McpPrincipal {
  const challenge = (error?: string) =>
    reply.header(
      'www-authenticate',
      `Bearer resource_metadata="${mcpUrls(origin).resourceMetadata}"${error ? `, error="${error}"` : ''}`,
    );
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token) {
    challenge();
    throw unauthorized('Sign in to use this MCP server, or send an API key as a Bearer token');
  }
  const principal = principalFor(token, deps);
  if (!principal) {
    recordMcpRefusal(deps.apiActivity, req, token);
    challenge('invalid_token');
    throw unauthorized('Invalid, expired or revoked token');
  }
  return principal;
}

/** An app's OAuth access token at its connection's level, or an API key at its own. */
function principalFor(token: string, deps: AppDeps): McpPrincipal | null {
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) return deps.oauth.principalFor(token);
  const key = deps.apiKeys.verify(token);
  if (!key) return null;
  return {
    kind: 'apiKey',
    access: key.access,
    label: `API key "${key.name}" via MCP`,
    apiKey: { id: key.id, name: key.name, prefix: key.prefix },
    connection: null,
  };
}
