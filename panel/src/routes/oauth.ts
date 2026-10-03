import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { AppError, forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { OAuthProblem } from '../services/oauth.js';
import { oauthCheckBody, oauthDecisionBody } from '../../shared/schemas.js';
import { SCOPE_OF } from '../../shared/oauth.js';
import { accessLevels } from '../../shared/access.js';
import type { OAuthCheckDto } from '../../shared/types.js';
import { mcpAvailable, mcpUrls } from './mcp.js';
import type { AppDeps } from './deps.js';

/** A form body, as parsed here: every field once, and the names of any sent more than once. */
interface FormBody {
  params: Record<string, string>;
  repeated: string[];
}

const SCOPES = accessLevels.map((level) => SCOPE_OF[level]);

/**
 * OAuth for MCP (services/oauth.ts): the metadata an app discovers the panel by, and the
 * registration, token and revocation endpoints it calls. Their own scope: OAuth answers errors
 * as `{error, error_description}` (RFC 6749), not in the panel's envelope; it takes form bodies,
 * which nothing else here does; and like every MCP route it answers 404 while MCP is off.
 *
 * The authorization endpoint is not here. `/oauth/authorize` is a page of the panel
 * (web/src/pages/OAuthAuthorize.tsx) whose two API calls are below: the session cookie is
 * strict, so it is not sent with the navigation arriving from an app's site - but the page's
 * own requests carry it.
 */
export async function registerOAuthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await app.register(async (scope) => {
    // Unknown fields are ignored, as the RFCs require; a field sent twice is refused
    // (RFC 6749 section 3.1), so it is kept track of here rather than silently overwritten.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16 * 1024 },
      (_req, body, done) => {
        const params: Record<string, string> = Object.create(null);
        const repeated: string[] = [];
        for (const [k, v] of new URLSearchParams(body as string)) {
          if (Object.hasOwn(params, k)) repeated.push(k);
          params[k] = v;
        }
        done(null, { params, repeated } satisfies FormBody);
      },
    );

    scope.setErrorHandler((err: unknown, req, reply) => {
      reply.header('cache-control', 'no-store');
      if (err instanceof OAuthProblem) {
        req.apiErrorCode = err.error;
        return reply.status(err.status).send({ error: err.error, error_description: err.message });
      }
      if (err instanceof AppError && err.code === 'not_found') {
        return reply.status(404).send({ error: { code: 'not_found', message: err.message } });
      }
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 429) {
        return reply.status(429).send({ error: 'temporarily_unavailable', error_description: 'Too many requests; slow down' });
      }
      if (status && status < 500) {
        return reply.status(status).send({ error: 'invalid_request', error_description: (err as Error).message });
      }
      req.log.error(err);
      return reply.status(500).send({ error: 'server_error', error_description: 'Internal error' });
    });

    scope.addHook('onRequest', async (req) => {
      if (!mcpAvailable(deps)) throw new AppError('not_found', 404, `Route ${req.method} ${req.url.split('?')[0]} not found`);
      if (req.method === 'POST') refuseForeignOrigin(req, deps.oauth.origin()!);
    });

    // ---------------------------------------------------------------- discovery

    const protectedResource = async (_req: FastifyRequest, reply: FastifyReply) => {
      const origin = deps.oauth.origin()!;
      return reply.header('cache-control', 'no-cache').send({
        resource: mcpUrls(origin).resource,
        authorization_servers: [origin],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
        resource_name: 'WPL7',
      });
    };
    // RFC 9728: the path of the resource after the well-known name - and the bare one, which
    // some clients try first.
    scope.get('/.well-known/oauth-protected-resource/mcp', protectedResource);
    scope.get('/.well-known/oauth-protected-resource', protectedResource);

    scope.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
      const origin = deps.oauth.origin()!;
      return reply.header('cache-control', 'no-cache').send({
        // The same string, byte for byte, as the `iss` of every authorization response.
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        scopes_supported: SCOPES,
        authorization_response_iss_parameter_supported: true,
      });
    });

    // ---------------------------------------------------------------- the protocol

    scope.post(
      '/oauth/register',
      { bodyLimit: 16 * 1024, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
      async (req, reply) => {
        if (isForm(req.body)) throw new OAuthProblem(400, 'invalid_client_metadata', 'Send the client metadata as JSON');
        const client = deps.oauth.register(req.body, req.ip || null);
        return reply.status(201).header('cache-control', 'no-store').send(client);
      },
    );

    scope.post('/oauth/token', { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }, async (req, reply) => {
      const p = formOf(req.body);
      const tokens =
        p.grant_type === 'authorization_code'
          ? deps.oauth.exchangeCode(p)
          : p.grant_type === 'refresh_token'
            ? deps.oauth.refresh(p)
            : (() => {
                throw new OAuthProblem(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are offered');
              })();
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(tokens);
    });

    scope.post('/oauth/revoke', { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }, async (req, reply) => {
      deps.oauth.revoke(formOf(req.body));
      return reply.status(200).header('cache-control', 'no-store').send({});
    });
  });

  // ------------------------------------------------------------------ the approval page's calls

  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Only an admin in the browser, on the panel's own page: an API key could never have seen
   * the page, and a request another site's page started is exactly the attack this refuses.
   */
  const fromThePage = (req: FastifyRequest) => {
    if (req.authVia !== 'session' || !req.user) throw forbidden('An app can only be approved by an admin signed in to the panel');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') throw forbidden('An app can only be approved from the panel itself');
    return req.user;
  };

  r.post('/api/oauth/authorize/check', { schema: { body: oauthCheckBody } }, async (req): Promise<OAuthCheckDto> => {
    const user = fromThePage(req);
    if (!mcpAvailable(deps)) return { status: 'error', message: 'MCP is switched off on this panel', returnTo: null };
    return deps.oauth.check(req.body.query, user.id);
  });

  r.post(
    '/api/oauth/authorize/decision',
    { schema: { body: oauthDecisionBody }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req) => {
      const user = fromThePage(req);
      if (!mcpAvailable(deps)) throw new AppError('conflict', 409, 'MCP is switched off on this panel');
      const decided = deps.oauth.decide(req.body.query, user.id, req.body.approve, req.body.access);
      audit(req, 'mcp', '-', req.body.approve ? 'approve app' : 'decline app', {
        access: req.body.approve ? req.body.access : null,
        to: new URL(decided.redirectTo).host || new URL(decided.redirectTo).protocol,
      });
      return decided;
    },
  );
}

function isForm(body: unknown): body is FormBody {
  return !!body && typeof body === 'object' && 'params' in body && 'repeated' in body && Array.isArray((body as FormBody).repeated);
}

/** The token and revocation endpoints take forms only, each field once. */
function formOf(body: unknown): Record<string, string> {
  if (!isForm(body)) throw new OAuthProblem(400, 'invalid_request', 'Send the request as application/x-www-form-urlencoded');
  if (body.repeated.length > 0) throw new OAuthProblem(400, 'invalid_request', `Sent more than once: ${body.repeated.join(', ')}`);
  return body.params;
}

/** As at /mcp: a web page elsewhere must not drive these; apps and programs send no such Origin. */
function refuseForeignOrigin(req: FastifyRequest, origin: string): void {
  const sent = req.headers.origin;
  if (sent === undefined) return;
  let url: URL | null = null;
  try {
    url = sent === 'null' ? null : new URL(sent);
  } catch {
    url = null;
  }
  if (!url || ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== new URL(origin).origin)) {
    throw new OAuthProblem(403, 'access_denied', 'Requests from other web pages are refused');
  }
}
