import { asc } from 'drizzle-orm';
import { sites, type ServerRow } from '../db/schema.js';
import type { JobWorker } from '../jobs/worker.js';
import type { CoreServices } from './index.js';
import { CLOUDFLARE, type DnsService } from './dns.js';
import type { DnsAccount } from './dnsAccount.js';
import type { TraefikDnsSync } from './traefikDns.js';
import { traefikLabels } from './labels.js';
import { queueReconcile, type HardeningSweep } from './siteHardening.js';

/**
 * Why a server cannot share a wildcard certificate from `provider`, or null when it can. Every
 * new dev site there would otherwise be labelled for a certificate nobody can get. A sentence
 * of its own: Settings -> DNS shows it on the server's row, where the server is already named.
 *
 * Its Traefik first, as last read off the container: one started without the DNS resolver, or
 * with it and no credentials at all, cannot answer the challenge whatever the panel holds. Then
 * Cloudflare's own: the challenge is a record in the dev domain's zone, written with the panel's
 * token - which has to reach that zone's records, not only find the zone, as Settings -> DNS ->
 * Check says. Another provider's credentials are in that server's deploy/.env, out of the
 * panel's sight.
 */
export async function wildcardProblem(
  s: { dns: DnsService; dnsAccount: Pick<DnsAccount, 'reach'>; traefikDns: Pick<TraefikDnsSync, 'statusOf'> },
  server: Pick<ServerRow, 'id' | 'devDomain'>,
  provider: string,
): Promise<string | null> {
  const traefik = s.traefikDns.statusOf(server.id);
  // Without the DNS resolver, or with it and no credentials at all: a stack from before this.
  if (traefik.state === 'ok' && (traefik.mode === 'none' || (traefik.mode === 'env' && !traefik.envToken))) {
    return 'Update this server first: it was set up before this feature.';
  }
  if (provider !== CLOUDFLARE) return null;
  if (!s.dns.enabled) return 'Add a Cloudflare token first (Settings → DNS).';
  if (!server.devDomain) return 'The server has no dev domain.';
  const reach = await s.dnsAccount.reach(server.devDomain);
  if (reach.records === 'readable') return null;
  if (reach.records === 'refused') {
    return `The Cloudflare token can't edit the DNS records of ${reach.zone}: give it Zone → DNS → Edit there. ${reach.detail}`;
  }
  if (reach.detail) return `Couldn't look up ${server.devDomain} in Cloudflare. ${reach.detail}`;
  return `${server.devDomain} isn't under any domain the Cloudflare token can see.`;
}

/**
 * The provider a server's wildcard certificate comes from when it is switched on: the one its
 * Traefik's DNS resolver runs - DNS_PROVIDER in that server's .env - and Cloudflare otherwise.
 */
export function wildcardProviderFor(traefikDns: Pick<TraefikDnsSync, 'statusOf'>, serverId: number): string {
  const traefik = traefikDns.statusOf(serverId);
  return traefik.mode === 'other' && traefik.provider ? traefik.provider : CLOUDFLARE;
}

const resolverLabel = (slug: string) => `traefik.http.routers.wp-${slug}.tls.certresolver`;
const isDnsResolver = (resolver: string | undefined) => resolver?.startsWith('letsencrypt-dns') ?? false;

/**
 * Rebuild the dev sites whose certificate comes from a DNS resolver they can no longer count
 * on: their server's wildcard certificate was switched off, or the Cloudflare token behind it
 * removed - without the token the shared certificate is not renewed, and it expires. Each gets
 * a `site.reconcile`, which recreates its container from the current spec: a certificate of its
 * own, over HTTP.
 *
 * Only that direction. A site with a certificate of its own keeps a working one when the
 * wildcard is switched on, and moves to the shared one whenever something rebuilds it anyway;
 * rebuilding every dev site only to share would be downtime nobody needs. Busy sites are left
 * for the next pass (the hourly site network repair runs this too).
 */
export async function sweepWildcardSites(
  s: Pick<CoreServices, 'db' | 'servers' | 'dns' | 'config' | 'log'>,
  worker: Pick<JobWorker, 'enqueue' | 'activeSiteJob'>,
  serverIds?: number[],
): Promise<HardeningSweep> {
  const sweep: HardeningSweep = { queued: [], busy: [] };
  const rows = s.db.select().from(sites).orderBy(asc(sites.id)).all();
  for (const server of s.servers.listRows()) {
    if (serverIds && !serverIds.includes(server.id)) continue;
    if (server.status === 'unreachable' || server.status === 'provisioning') continue;
    let containers: { name: string; labels: Record<string, string> }[];
    try {
      containers = await s.servers.handleFor(server.id).docker.listManaged(['wpl7.role=wordpress']);
    } catch (err) {
      s.log.warn(`Wildcard certificate sweep on "${server.name}" failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const wildcardProvider = s.dns.wildcardProvider(server.dnsProvider);
    for (const container of containers) {
      const site = rows.find((r) => r.containerName === container.name && r.serverId === server.id);
      if (!site || !isDnsResolver(container.labels[resolverLabel(site.slug)])) continue;
      const [primary, ...aliases] = JSON.parse(site.domains) as string[];
      if (!primary) continue;
      const wanted = traefikLabels({
        slug: site.slug,
        primary,
        aliases,
        tlsMode: s.config.tlsMode,
        acmeResolver: s.config.acmeResolver,
        devDomain: server.devDomain,
        dnsProvider: wildcardProvider,
      })[resolverLabel(site.slug)];
      if (isDnsResolver(wanted)) continue;
      queueReconcile(worker, site, sweep);
    }
  }
  if (sweep.queued.length > 0) {
    s.log.info(`DNS: ${sweep.queued.length} dev site(s) queued to be rebuilt with a certificate of their own: ${sweep.queued.join(', ')}`);
  }
  if (sweep.busy.length > 0) {
    s.log.warn(`DNS: ${sweep.busy.length} dev site(s) were busy and keep the wildcard certificate until the next pass: ${sweep.busy.join(', ')}`);
  }
  return sweep;
}
