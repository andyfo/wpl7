// @docs sites/domains
import { ne } from 'drizzle-orm';
import { sites } from '../db/schema.js';
import { badRequest, conflict } from '../lib/errors.js';
import { isUnderDevDomain } from '../jobs/handlers/shared.js';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { ServerRegistry } from '../servers/registry.js';

export interface DomainGuardDeps {
  db: Db;
  config: Config;
  servers: ServerRegistry;
}

/**
 * Hostname uniqueness across every site, plus the "don't squat a dev domain" rule.
 *
 * Shared rather than duplicated because it runs twice for the same request: once at
 * enqueue time (so the caller gets a 409 instead of a job that fails minutes later) and
 * again inside the job right before the domains column is written - the gap between the
 * two is long enough (certificate issuance) for a second go-live to claim the same host.
 */
export function assertDomainsFree(
  deps: DomainGuardDeps,
  domains: string[],
  opts: { excludeSiteId?: number; allowDevHostname?: string | null } = {},
): void {
  const taken = new Set<string>();
  const rows =
    opts.excludeSiteId === undefined
      ? deps.db.select().from(sites).all()
      : deps.db.select().from(sites).where(ne(sites.id, opts.excludeSiteId)).all();
  for (const row of rows) {
    for (const d of JSON.parse(row.domains) as string[]) taken.add(d);
    if (row.devHostname) taken.add(row.devHostname);
  }
  if (deps.config.panelDomain) taken.add(deps.config.panelDomain);

  const devDomains = deps.servers
    .listRows()
    .map((r) => r.devDomain)
    .filter(Boolean);

  for (const domain of domains) {
    if (taken.has(domain)) throw conflict(`Domain ${domain} is already in use`);
    if (devDomains.includes(domain)) throw badRequest(`${domain} is a dev domain itself`);
    if (devDomains.some((d) => isUnderDevDomain(domain, d)) && domain !== opts.allowDevHostname) {
      throw badRequest(`${domain} is under a dev domain; dev hostnames are assigned automatically from the site name`);
    }
  }
  if (new Set(domains).size !== domains.length) throw badRequest('Duplicate domains in request');
}
