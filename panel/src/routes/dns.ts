// @docs integrations/cloudflare
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { z } from 'zod';
import { servers } from '../db/schema.js';
import { dnsCheckBody, dnsTokenBody, dnsWildcardBody } from '../../shared/schemas.js';
import type { DnsServerDto, DnsStatusDto } from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { CLOUDFLARE } from '../services/dns.js';
import { sweepWildcardSites, wildcardProblem, wildcardProviderFor } from '../services/wildcardSites.js';
import type { AppDeps } from './deps.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * Settings -> DNS: the Cloudflare token, never in any answer, and each server's wildcard
 * certificate. docs/dns.md.
 */
export function registerDnsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const status = (): DnsStatusDto => ({
    provider: CLOUDFLARE,
    token: deps.dnsAccount.status(),
    wildcardServerId: deps.settings.get('dnsWildcardServerId') ?? 1,
    servers: deps.servers.listRows().map((row) => ({
      id: row.id,
      name: row.name,
      devDomain: row.devDomain,
      status: row.status as DnsServerDto['status'],
      dnsProvider: row.dnsProvider,
      wildcardProvider: deps.dns.wildcardProvider(row.dnsProvider),
      traefik: deps.traefikDns.statusOf(row.id),
    })),
  });

  r.get('/api/dns', async () => status());

  /** What a token reaches - the one given, or the stored one - without keeping it. Reads only. */
  r.post('/api/dns/check', { schema: { body: dnsCheckBody } }, async (req) => deps.dnsAccount.check(req.body.token));

  /**
   * Keep a new token. Checked first: one Cloudflare refuses, or that reaches no zone, is not
   * stored - the panel's records and every server's wildcard certificate would go with it.
   * Every server's Traefik is given the new one in the background (services/traefikDns.ts).
   */
  r.put('/api/dns/token', { schema: { body: dnsTokenBody } }, async (req) => {
    const check = await deps.dnsAccount.check(req.body.token);
    if (!check.ok) throw badRequest(check.error ?? 'Cloudflare did not take the token');
    deps.dnsAccount.set(req.body.token);
    return { ...status(), check };
  });

  /**
   * Forget the token. A dev site sharing a wildcard certificate from Cloudflare would keep it
   * only until it expires - nothing can renew it now - so those are rebuilt onto certificates
   * of their own.
   */
  r.delete('/api/dns/token', async () => {
    deps.dnsAccount.set('');
    const sweep = await sweepWildcardSites(deps, deps.worker);
    return { ...status(), rebuilding: sweep.queued, busy: sweep.busy };
  });

  /**
   * A server's wildcard certificate, on or off - from the provider its Traefik runs, Cloudflare
   * unless that server's .env names another. On reaches the dev sites created or rebuilt from
   * now on; a site with a certificate of its own keeps it. Off rebuilds the dev sites sharing it
   * onto their own, one job each.
   */
  r.put('/api/dns/servers/:id/wildcard', { schema: { params: idParams, body: dnsWildcardBody } }, async (req) => {
    const row = deps.servers.rowById(req.params.id);
    if (!row) throw notFound(`Server #${req.params.id} not found`);
    const provider = req.body.on ? wildcardProviderFor(deps.traefikDns, row.id) : '';
    if (provider) {
      const problem = await wildcardProblem(deps, row, provider);
      // `reason` alone too, for the server's row in Settings -> DNS.
      if (problem) throw conflict(`"${row.name}" can't use a wildcard certificate. ${problem}`, { reason: problem });
    }
    if (provider !== row.dnsProvider) {
      deps.db.update(servers).set({ dnsProvider: provider, updatedAt: Date.now() }).where(eq(servers.id, row.id)).run();
      deps.servers.invalidate(row.id);
    }
    const sweep = await sweepWildcardSites(deps, deps.worker, [row.id]);
    return { ...status(), rebuilding: sweep.queued, busy: sweep.busy };
  });
}
