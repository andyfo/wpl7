import type { DockerPort } from './docker.js';
import { MAIL_CONTAINER, MARIADB_CONTAINER, TRAEFIK_CONTAINER } from './stack.js';

/**
 * One network per site, plus one shared egress network.
 *
 * The flat `wpl7_proxy` this replaces put every site container on one bridge with every
 * other, so a compromised site could open TCP straight to its neighbours' Apache -
 * bypassing Traefik, its TLS and its middlewares - and reach the panel's port as well.
 * Docker only isolates *between* networks, so the fix is to give each site a network of
 * its own whose only other members are the infrastructure it must talk to.
 *
 *   wpl7_site_<slug>   internal (no route off the host): the site + Traefik + relay + DB
 *   wpl7_egress        shared, inter-container communication disabled: outbound internet
 *
 * WordPress still needs the internet (updates, wp.org plugin installs), which an internal
 * network cannot give it - hence the second one. `enable_icc=false` makes the kernel drop
 * container-to-container traffic on that bridge while leaving the route out intact, so
 * sharing it costs no isolation. Sites are no longer members of `wpl7_proxy` or `wpl7_db`
 * at all: after this, a site container cannot address the panel.
 */
export const EGRESS_NETWORK = 'wpl7_egress';

/** Marks the networks this module owns, so orphans can be found without guessing at names. */
export const SITE_NETWORK_LABEL = 'wpl7.role=site-network';

const SITE_NETWORK_PREFIX = 'wpl7_site_';

export const siteNetworkName = (slug: string): string => `${SITE_NETWORK_PREFIX}${slug}`;

/**
 * LEGACY(ceo) - delete in 0.3.0. What these networks were called before the rename.
 *
 * A site keeps the networks it was created on until something recreates its container, so
 * between the host migration and the last `site.reconcile` an install has both generations
 * side by side. Discovery has to see both, or the reconciler stops repairing the endpoints
 * of every site that has not been through the migration yet - which is every site, in the
 * minutes right after the stack comes back up.
 */
export const LEGACY_EGRESS_NETWORK = 'ceo_egress';
export const LEGACY_SITE_NETWORK_LABEL = 'ceo.role=site-network';
const LEGACY_SITE_NETWORK_PREFIX = 'ceo_site_';

export const legacySiteNetworkName = (slug: string): string => `${LEGACY_SITE_NETWORK_PREFIX}${slug}`;

/**
 * Every per-site network on a server, both generations. Two calls because Docker ANDs
 * multiple label filters rather than ORing them; the prefix check is what keeps a network
 * somebody else labelled out of the result.
 */
export async function listSiteNetworks(docker: DockerPort): Promise<string[]> {
  const current = (await docker.listNetworkNames([SITE_NETWORK_LABEL])).filter((n) =>
    n.startsWith(SITE_NETWORK_PREFIX),
  );
  return [...new Set([...current, ...(await listLegacySiteNetworks(docker))])];
}

/** LEGACY(ceo) - delete in 0.3.0. Pre-rename per-site networks on this server. */
export async function listLegacySiteNetworks(docker: DockerPort): Promise<string[]> {
  return (await docker.listNetworkNames([LEGACY_SITE_NETWORK_LABEL])).filter((n) =>
    n.startsWith(LEGACY_SITE_NETWORK_PREFIX),
  );
}

/** LEGACY(ceo) - delete in 0.3.0. The slug a pre-rename network belongs to. */
export const slugFromLegacySiteNetwork = (name: string): string => name.slice(LEGACY_SITE_NETWORK_PREFIX.length);

export interface SiteNetworkMember {
  container: string;
  /**
   * DNS names the container answers to on a site network. Compose gives `wpl7-mariadb` the
   * alias `mariadb` and `wpl7-mail` the alias `mail` on the shared networks; per-site
   * endpoints are created through the API, which does not inherit those, so they are
   * repeated here. Without them `WORDPRESS_DB_HOST=mariadb` and msmtp's `host mail` stop
   * resolving the moment a site moves off `wpl7_proxy`.
   */
  aliases?: string[];
}

/** Infrastructure every site must reach, and nothing else. */
export const SITE_NETWORK_MEMBERS: SiteNetworkMember[] = [
  { container: TRAEFIK_CONTAINER },
  { container: MAIL_CONTAINER, aliases: ['mail'] },
  { container: MARIADB_CONTAINER, aliases: ['mariadb'] },
];

export interface AttachReport {
  /** Infra containers that could not be attached (absent on this server, typically). */
  missing: string[];
}

/** The networks a site container is attached to, in the order they are connected. */
export function siteNetworksFor(slug: string): string[] {
  return [siteNetworkName(slug), EGRESS_NETWORK];
}

export async function ensureEgressNetwork(docker: DockerPort): Promise<void> {
  const { detached } = await docker.ensureNetwork({
    name: EGRESS_NETWORK,
    internal: false,
    // The whole point: members get out, but not to each other.
    options: { 'com.docker.network.bridge.enable_icc': 'false' },
    labels: { 'wpl7.role': 'egress-network' },
  });
  // A rebuild (an egress network that predates ICC being switched off, say) would otherwise
  // leave every site without a route to the internet until its container was recreated.
  for (const container of detached) await docker.connectContainer(EGRESS_NETWORK, container);
}

/**
 * Create a site's network and attach the infrastructure to it. Safe to re-run: every step
 * is idempotent, which is what lets the reconciler below repair a stack redeploy.
 */
export async function ensureSiteNetwork(docker: DockerPort, slug: string): Promise<AttachReport> {
  const name = siteNetworkName(slug);
  const { detached } = await docker.ensureNetwork({
    name,
    internal: true,
    labels: { 'wpl7.role': 'site-network', 'wpl7.site': slug },
  });
  // Only the site container: infrastructure is reattached below, with the DNS aliases a
  // plain reconnect would lose. Skipping this would take a running site off its own network
  // the first time the isolation policy changed under it.
  const infra = new Set(SITE_NETWORK_MEMBERS.map((m) => m.container));
  for (const container of detached) {
    if (!infra.has(container)) await docker.connectContainer(name, container);
  }
  await ensureEgressNetwork(docker);
  return attachInfra(docker, [name]);
}

async function attachInfra(docker: DockerPort, networks: string[]): Promise<AttachReport> {
  const missing = new Set<string>();
  for (const member of SITE_NETWORK_MEMBERS) {
    if ((await docker.containerState(member.container)) === 'missing') {
      // Not on this server (a worker without a relay) or the stack is mid-restart. The
      // reconciler picks it up once it exists rather than failing the operation.
      missing.add(member.container);
      continue;
    }
    const attached = new Set(await docker.containerNetworks(member.container));
    for (const network of networks) {
      if (attached.has(network)) continue;
      await docker.connectContainer(network, member.container, { aliases: member.aliases });
    }
  }
  return { missing: [...missing] };
}

/**
 * Re-attach infrastructure to every site network.
 *
 * `docker compose up` recreates Traefik, MariaDB and the relay from a file that knows
 * nothing about per-site networks, so a stack redeploy silently drops those endpoints and
 * with them every site's routing, database and mail. Rather than teach compose about
 * networks that do not exist yet when it runs, the panel repairs the attachments on a
 * timer and at boot. Three container inspections per server per tick, regardless of how
 * many sites there are.
 */
export async function reconcileSiteNetworks(docker: DockerPort): Promise<{ networks: number; repaired: number }> {
  const networks = await listSiteNetworks(docker);
  if (networks.length === 0) return { networks: 0, repaired: 0 };

  let repaired = 0;
  for (const member of SITE_NETWORK_MEMBERS) {
    if ((await docker.containerState(member.container)) === 'missing') continue; // absent here
    const attached = new Set(await docker.containerNetworks(member.container));
    for (const network of networks) {
      if (attached.has(network)) continue;
      await docker.connectContainer(network, member.container, { aliases: member.aliases });
      repaired++;
    }
  }
  return { networks: networks.length, repaired };
}

/** Drop a site's network. Called after its container is gone, so no endpoints remain. */
export async function removeSiteNetwork(docker: DockerPort, slug: string): Promise<void> {
  await removeNetwork(docker, siteNetworkName(slug));
}

/**
 * LEGACY(ceo) - delete in 0.3.0. Drop the pre-rename network of a site that has just been
 * recreated on its new one. Only the infrastructure containers are still attached at that
 * point, so this is the last step of the per-site migration rather than a risk to the site.
 */
export async function removeLegacySiteNetwork(docker: DockerPort, slug: string): Promise<boolean> {
  const name = legacySiteNetworkName(slug);
  if (!(await docker.inspectNetwork(name))) return false;
  await removeNetwork(docker, name);
  return true;
}

/**
 * LEGACY(ceo) - delete in 0.3.0. Drop the pre-rename egress network once the last site has
 * moved off it. Guarded on emptiness rather than trusting the caller's bookkeeping: a site
 * this panel does not know about (mid-move, or restored by hand) must not lose its route
 * out.
 */
export async function removeLegacyEgressNetwork(docker: DockerPort): Promise<boolean> {
  const info = await docker.inspectNetwork(LEGACY_EGRESS_NETWORK);
  if (!info || info.containers.length > 0) return false;
  await docker.removeNetwork(LEGACY_EGRESS_NETWORK);
  return true;
}

async function removeNetwork(docker: DockerPort, name: string): Promise<void> {
  const info = await docker.inspectNetwork(name);
  if (!info) return;
  // Infra is still attached (it is attached to every site network); detach before removing,
  // otherwise Docker refuses with "network has active endpoints".
  for (const container of info.containers) {
    await docker.disconnectContainer(name, container);
  }
  await docker.removeNetwork(name);
}
