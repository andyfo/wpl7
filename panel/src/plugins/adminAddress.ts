import type { FastifyInstance } from 'fastify';
import { PROXY_HEADERS } from '../../shared/security.js';
import { resolveClient, type ProxyHeaders } from '../lib/clientIp.js';
import type { BlocklistService } from '../services/blocklist.js';
import type { ProxyRangesService } from '../services/proxyRanges.js';

/**
 * Write down where the panel is used from: the address of every request that proved who it
 * is, with the admin (or API key) behind it. Blocked addresses never include one of these for
 * 30 days - an operator locked out by their own panel's detection has no panel left to lift
 * the block with.
 *
 * `req.ip` is what Traefik saw (it replaces X-Forwarded-For from anyone it does not trust), and
 * behind Cloudflare that is Cloudflare - so it is resolved the same way the access log is.
 * Recorded after the response, and at most every few minutes per address (services/blocklist.ts).
 */
export function registerAdminAddresses(app: FastifyInstance, blocklist: BlocklistService, proxyRanges: ProxyRangesService): void {
  app.addHook('onResponse', async (req) => {
    if (!req.authVia) return;
    const who = req.user?.username ?? (req.apiKeyUsed?.id ? `API key "${req.apiKeyUsed.name}"` : null);
    if (!who) return;
    const headers: ProxyHeaders = {};
    for (const header of PROXY_HEADERS) {
      const value = req.headers[header.toLowerCase()];
      if (typeof value === 'string') headers[header] = value;
    }
    try {
      blocklist.recordAdmin(resolveClient(req.ip, headers, proxyRanges.trusted()).clientIp, who);
    } catch (err) {
      req.log.warn({ err }, 'Could not record the admin address');
    }
  });
}
