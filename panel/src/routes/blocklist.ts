/**
 * Blocked addresses (docs/security.md): the list in force on every server, the addresses that
 * are never blocked, each server's firewall, and what the detector decided and why.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { blockCreateBody, blocksQuery, neverBlockCreateBody, securityCheckQuery } from '../../shared/schemas.js';
import { cidrInputProblem, parseCidr } from '../../shared/cidr.js';
import type { SecurityCheckDto } from '../../shared/types.js';
import { actorName, actorOf } from '../lib/audit.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export function registerBlocklistRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/security/blocks', { schema: { querystring: blocksQuery } }, async (req) => deps.blocklist.list(req.query));

  r.post('/api/security/blocks', { schema: { body: blockCreateBody } }, async (req, reply) => {
    const { address, minutes, note, siteSlug } = req.body;
    const row = deps.blocklist.block({
      address,
      source: req.user && !req.mcp ? 'manual' : 'api',
      reason: 'Blocked by hand',
      note: note || null,
      ...(siteSlug ? { siteSlug } : {}),
      createdBy: actorName(req),
      durationMs: minutes ? minutes * 60_000 : null,
    });
    req.log.info({ security: { op: 'block', address: row.address, minutes: minutes ?? null }, ...actorOf(req) }, `security: blocked ${row.address}`);
    return reply.status(201).send(deps.blocklist.toDto(row));
  });

  r.delete('/api/security/blocks/:id', { schema: { params: idParams } }, async (req) => {
    const row = deps.blocklist.lift(req.params.id, actorName(req));
    req.log.info({ security: { op: 'unblock', address: row.address }, ...actorOf(req) }, `security: unblocked ${row.address}`);
    return deps.blocklist.toDto(row);
  });

  /** The never-block list, and the addresses that are protected because an admin used them. */
  r.get('/api/security/never-block', async () => ({ items: deps.blocklist.neverBlockList(), admins: deps.blocklist.adminAddresses() }));

  r.post('/api/security/never-block', { schema: { body: neverBlockCreateBody } }, async (req, reply) => {
    const added = deps.blocklist.addNeverBlock(req.body.address, req.body.note || null, actorName(req));
    req.log.info({ security: { op: 'never block', address: added.address }, ...actorOf(req) }, `security: never block ${added.address}`);
    return reply.status(201).send(added);
  });

  r.delete('/api/security/never-block/:id', { schema: { params: idParams } }, async (req, reply) => {
    deps.blocklist.removeNeverBlock(req.params.id);
    req.log.info({ security: { op: 'remove never block', id: req.params.id }, ...actorOf(req) }, 'security: removed a never-block entry');
    return reply.status(204).send();
  });

  r.get('/api/security/firewall', async () => deps.firewall.overview());

  r.post('/api/security/firewall/sync', async () => {
    await deps.firewall.kickAll();
    return deps.firewall.overview();
  });

  /** Could this address be blocked - and if not, why not; is it now, and by which block. */
  r.get('/api/security/check', { schema: { querystring: securityCheckQuery } }, async (req): Promise<SecurityCheckDto> => {
    const problem = cidrInputProblem(req.query.address);
    const cidr = problem ? null : parseCidr(req.query.address);
    if (!cidr) return { address: req.query.address, valid: false, problem: problem ?? 'Not an address', protectedBecause: null, blockedBy: null, country: null };
    const blocking = deps.blocklist.covering(cidr);
    return {
      address: cidr.text,
      valid: true,
      problem: null,
      protectedBecause: deps.blocklist.protection(cidr),
      blockedBy: blocking ? deps.blocklist.toDto(blocking) : null,
      country: deps.geoip.lookup(cidr.text.split('/')[0]!),
    };
  });

  r.get('/api/security/detection', async () => deps.detector.status());
}
