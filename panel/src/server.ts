// @docs reference/architecture, security/accounts
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { SqliteSessionStore } from './plugins/sessionStore.js';
import { registerAuth } from './plugins/auth.js';
import { registerMaintenanceGuard } from './plugins/maintenance.js';
import { registerJobActor } from './plugins/jobActor.js';
import { registerApiActivity } from './plugins/apiActivity.js';
import { registerAdminAddresses } from './plugins/adminAddress.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerSiteRoutes } from './routes/sites.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerBackupDestinationRoutes } from './routes/backupDestinations.js';
import { registerWpRoutes } from './routes/wp.js';
import { registerFileRoutes } from './routes/files.js';
import { registerFtpRoutes } from './routes/ftp.js';
import { registerWpFleetRoutes } from './routes/wpFleet.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerRecipeRoutes } from './routes/recipes.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerDnsRoutes } from './routes/dns.js';
import { registerTerminalRoutes } from './routes/terminal.js';
import { registerMailRoutes } from './routes/mail.js';
import { registerSecurityRoutes } from './routes/security.js';
import { registerBlocklistRoutes } from './routes/blocklist.js';
import { registerMcpPanelRoutes, registerMcpRoutes } from './routes/mcp.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { collectRouteSchemas } from './mcp/docs.js';
import type { AppDeps } from './routes/deps.js';

const WEEK_MS = 7 * 24 * 3600_000;

/** Where a signed-out browser is sent. */
const LOGIN_PATH = '/login';

/**
 * The pages of the panel a signed-out browser is allowed to load: signing in, the two an
 * emailed link opens - often on a phone that has never signed in to the panel at all - and
 * the page an AI app sends its admin to for approval, which signs them in and comes back
 * (web/src/lib/loginNext.ts) rather than losing the request on the way.
 */
const SIGNED_OUT_PAGES = new Set([LOGIN_PATH, '/reset-password', '/confirm-email', '/oauth/authorize']);

export async function buildServer(
  deps: AppDeps,
  /**
   * Where the built web app is. Left out, it is looked for on disk; `null` is a panel
   * serving the API alone, which is what the test suite builds.
   */
  opts: { webDist?: string | null } = {},
): Promise<FastifyInstance> {
  const { config } = deps;
  const app = fastify({
    logger: config.nodeEnv === 'test' ? false : { level: 'info' },
    trustProxy: true, // behind Traefik: real client IPs + correct protocol for Secure cookies
    bodyLimit: 1024 * 1024, // JSON stays small; the multipart route enforces its own 100MB cap
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: config.sessionSecret,
    cookieName: 'panel.sid',
    cookie: {
      httpOnly: true,
      secure: config.tlsMode !== 'none',
      sameSite: 'strict',
      path: '/',
      maxAge: WEEK_MS,
    },
    store: new SqliteSessionStore(deps.db, deps.users),
    saveUninitialized: false,
    rolling: true,
  });
  await app.register(fastifyRateLimit, { global: true, max: 300, timeWindow: 60_000 });
  await app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
  // Web terminal upgrades; bounds a single paste from the browser, not PTY output.
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  registerAuth(app, deps.apiKeys, deps.users);
  registerApiActivity(app, deps.apiActivity, deps.apiKeys);
  // Where the panel is used from is never blocked (services/blocklist.ts).
  registerAdminAddresses(app, deps.blocklist, deps.proxyRanges);
  registerMaintenanceGuard(app, deps.system);
  // Before any route: it wraps the handlers of the routes registered after it.
  registerJobActor(app);
  // Also before any route, for the same reason: the MCP docs tool reads every route's schemas.
  const routeSchemas = collectRouteSchemas(app);
  registerAuthRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerSiteRoutes(app, deps);
  registerImportRoutes(app, deps);
  registerConnectionRoutes(app, deps);
  registerBackupRoutes(app, deps);
  registerBackupDestinationRoutes(app, deps);
  registerWpRoutes(app, deps);
  await registerFileRoutes(app, deps);
  registerFtpRoutes(app, deps);
  registerWpFleetRoutes(app, deps);
  registerPluginRoutes(app, deps);
  registerRecipeRoutes(app, deps);
  registerJobRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerMiscRoutes(app, deps);
  registerSystemRoutes(app, deps);
  registerServerRoutes(app, deps);
  registerDnsRoutes(app, deps);
  registerTerminalRoutes(app, deps);
  registerMailRoutes(app, deps);
  registerSecurityRoutes(app, deps);
  registerBlocklistRoutes(app, deps);
  registerMcpPanelRoutes(app, deps);
  registerMcpRoutes(app, deps, routeSchemas);
  await registerOAuthRoutes(app, deps);

  // ------------------------------------------------------------------ SPA
  const webDist = opts.webDist === undefined ? findWebDist() : opts.webDist;
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      // index.html is deliberately not servable as a file, and '/' is not a directory
      // index: every request for a page of the panel falls through to the not-found
      // handler below, which is then the single place deciding who gets the app.
      index: false,
      globIgnore: ['index.html'],
      setHeaders: (reply, filePath) => {
        // Hashed assets are immutable; index.html must always revalidate.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('cache-control', 'no-cache');
        }
      },
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    const url = req.url.split('?')[0] ?? req.url;
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (webDist && req.method === 'GET' && !url.startsWith('/api/') && wantsHtml) {
      return sendApp(reply, webDist, url, {
        signedIn: req.session?.authenticated === true,
        cookieCarried: cookieSurvivesNavigation(req),
      });
    }
    return reply
      .status(404)
      .send({ error: { code: 'not_found', message: `Route ${req.method} ${url} not found` } });
  });

  return app;
}

/**
 * Hand over a page of the panel - or the sign-in page, when nobody is signed in.
 *
 * Whether there is a session is already known here, on the request for the document
 * itself, and this is the only moment where answering it is free. Handing the app shell
 * to a signed-out browser meant the entire panel loaded and painted, and only then learnt
 * from the first 401 of its own data queries that it had to bounce to /login: a flash of
 * a UI the visitor was never signed in to.
 *
 * The other direction matters too. A browser that IS signed in is told so in the document
 * (`data-session`), so the app can paint on its first frame rather than hold everything
 * back until /api/auth/me answers - which would trade the old flash for a blank screen.
 * It is a hint for painting and nothing else; every route still proves itself against the
 * session cookie, and a forged attribute buys a browser nothing but an empty shell.
 */
async function sendApp(
  reply: FastifyReply,
  webDist: string,
  url: string,
  session: { signedIn: boolean; cookieCarried: boolean },
) {
  if (!session.signedIn && session.cookieCarried && !SIGNED_OUT_PAGES.has(url)) {
    return reply.redirect(LOGIN_PATH);
  }
  const html = await fsp.readFile(path.join(webDist, 'index.html'), 'utf8');
  return reply
    .header('cache-control', 'no-cache')
    // Never inside someone else's frame. A dev site shares the panel's registrable domain,
    // so its pages are "same-site" and the strict session cookie would go along with a
    // framed panel - one invisible frame and a lured click away from Delete, in the Files
    // tab or anywhere else.
    .header('content-security-policy', "frame-ancestors 'none'")
    .header('x-frame-options', 'DENY')
    .type('text/html')
    .send(session.signedIn ? html.replace('<html', '<html data-session="signed-in"') : html);
}

/**
 * Was the session cookie, if this browser has one, sent along with this navigation? It is
 * `sameSite: strict`, so a link followed from anywhere off the panel arrives without it
 * even for someone signed in, and their absence proves nothing: the panel serves them the
 * app, whose own same-origin requests do carry the cookie and sort it out in a moment.
 * Only a navigation the browser calls its own - typed, bookmarked, followed from a panel
 * page - can be answered with the sign-in page. A browser too old to say so (Safari only
 * started in 16.4) counts as the ambiguous case and keeps the behaviour it always had.
 */
function cookieSurvivesNavigation(req: FastifyRequest): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === 'none' || site === 'same-origin' || site === 'same-site';
}

function findWebDist(): string | null {
  for (const candidate of [
    path.resolve(process.cwd(), 'web/dist'),
    path.resolve(process.cwd(), 'panel/web/dist'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}
