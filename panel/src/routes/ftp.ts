import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import {
  ftpPasswordBody,
  ftpUserCreateBody,
  ftpUserParams,
  ftpUserUpdateBody,
  siteSlugParam,
} from '../../shared/schemas.js';
import { badRequest, conflict } from '../lib/errors.js';
import { actorName, audit } from '../lib/audit.js';
import type { SiteRow } from '../db/schema.js';
import type { AppDeps } from './deps.js';

/**
 * FTP & SFTP logins: each one belongs to a site and reaches only that site's files.
 *
 * The routes decide who may change what; services/ftp.ts has the containers, and why a
 * login can do no more than the site's own PHP can.
 */

const slugParams = z.object({ slug: siteSlugParam });
const idParams = z.object({ id: z.coerce.number().int().positive() });
/** A password is set or handed out here: brute-forcing the panel is not the way to find one. */
const passwordLimit = { rateLimit: { max: 30, timeWindow: 60_000 } };

export function registerFtpRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Logins can be looked at any time, and changed while the site has files to serve. */
  const siteForChange = (slug: string): SiteRow => {
    const site = deps.sites.bySlug(slug);
    if (site.status === 'provisioning' || site.status === 'deleting') {
      throw conflict(`Site "${site.slug}" is ${site.status}; its FTP logins cannot be changed now`);
    }
    return site;
  };

  const inFuture = (expiresAt: number | null | undefined): void => {
    if (expiresAt !== null && expiresAt !== undefined && expiresAt <= Date.now()) {
      throw badRequest('The expiry has to be in the future');
    }
  };

  r.get('/api/sites/:slug/ftp', { schema: { params: slugParams } }, async (req) =>
    deps.ftp.siteView(deps.sites.bySlug(req.params.slug)),
  );

  r.post(
    '/api/sites/:slug/ftp/users',
    { schema: { params: slugParams, body: ftpUserCreateBody }, config: passwordLimit },
    async (req, reply) => {
      const site = siteForChange(req.params.slug);
      inFuture(req.body.expiresAt);
      const created = await deps.ftp.createUser(
        site,
        {
          username: req.body.username,
          password: req.body.password,
          folder: req.body.folder,
          expiresAt: req.body.expiresAt,
        },
        actorName(req),
      );
      audit(req, 'ftp', site.slug, 'create login', {
        username: created.user.username,
        folder: created.user.folder,
        expiresAt: created.user.expiresAt,
        password: created.password ? 'generated' : 'chosen',
      });
      // The generated password is in this answer and nowhere else, ever.
      return reply.status(201).send(created);
    },
  );

  r.patch(
    '/api/sites/:slug/ftp/users/:id',
    { schema: { params: ftpUserParams, body: ftpUserUpdateBody } },
    async (req) => {
      const site = siteForChange(req.params.slug);
      inFuture(req.body.expiresAt);
      const user = await deps.ftp.updateUser(site, req.params.id, {
        folder: req.body.folder,
        expiresAt: req.body.expiresAt,
      });
      audit(req, 'ftp', site.slug, 'change login', { username: user.username, folder: user.folder, expiresAt: user.expiresAt });
      return { user };
    },
  );

  // The body may be left out altogether (Fastify then hands over null): "reset it" is
  // a complete request on its own.
  r.post(
    '/api/sites/:slug/ftp/users/:id/password',
    { schema: { params: ftpUserParams, body: ftpPasswordBody.nullish() }, config: passwordLimit },
    async (req) => {
      const site = siteForChange(req.params.slug);
      const reset = await deps.ftp.resetPassword(site, req.params.id, req.body?.password);
      audit(req, 'ftp', site.slug, 'reset password', {
        username: reset.user.username,
        password: reset.password ? 'generated' : 'chosen',
      });
      return reset;
    },
  );

  r.delete('/api/sites/:slug/ftp/users/:id', { schema: { params: ftpUserParams } }, async (req, reply) => {
    const site = siteForChange(req.params.slug);
    const removed = await deps.ftp.deleteUser(site, req.params.id);
    audit(req, 'ftp', site.slug, 'delete login', { username: removed.username });
    return reply.status(204).send();
  });

  r.get('/api/servers/:id/ftp', { schema: { params: idParams } }, async (req) => deps.ftp.serverView(req.params.id));
}
