// @docs sites/move, servers/recover
import path from 'node:path';
import type { SiteRow } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { isContainerApp } from '../../lib/siteKind.js';
import { siteDomains } from './shared.js';
import { wildcardCovers } from './sites.js';
import { proxyConfigPathFor, proxyConfigYaml } from './moveHelpers.js';
import { appHttpHostsOf } from './apps.js';

/**
 * What a site's arrival on another server did to DNS, and what is left to a person: the move's
 * and a recovery's result both carry it.
 */
export interface DnsRepoint {
  updated: string[];
  manual: { host: string; ip: string }[];
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Point the site's hostnames at the server it now lives on: the dev hostname and every customer
 * domain the Cloudflare token reaches. The rest is listed, in the job log and in the result.
 *
 * `fromName` is where the site was, for the log. `sameServer` is a recovery onto the server the
 * site was already on: its records should already point there, unless the server came back with
 * another address, so there is nothing to say about a server it left. `madeAgain` is a deleted
 * site made again from its backup: its own domains' records are listed, never changed.
 */
export async function repointSiteDns(
  ctx: JobContext<unknown>,
  s: CoreServices,
  site: SiteRow,
  target: ServerHandle,
  opts: { fromName: string; sameServer?: boolean; madeAgain?: boolean },
): Promise<DnsRepoint> {
  const dns: DnsRepoint = { updated: [], manual: [] };
  const domains = siteDomains(site);
  const customHosts = domains.filter((d) => !(site.devHostname && d === site.devHostname));
  const ip = target.row.publicIp;
  // The wildcard covers the site on one server at most: landing where it does means leaving a
  // server where it needed a record of its own.
  const covered = site.devHostname !== null && wildcardCovers(s, target.id, site.devHostname);
  if (site.devHostname && !s.dns.enabled) {
    // Silence here used to mean the dev hostname kept resolving to the old server right up
    // until the old copy was removed. Landing where the wildcard covers it is no exception: a
    // record made by hand for the old server still beats the wildcard.
    dns.manual.push({ host: site.devHostname, ip });
    if (opts.sameServer) {
      ctx.warn(`DNS management is off. Make sure ${site.devHostname} points at ${ip}.`);
    } else {
      ctx.warn(
        covered
          ? `DNS management is off. If ${site.devHostname} has an A record of its own, point it at ` +
              `${ip} or delete it; the old server forwards traffic until then.`
          : `DNS management is off, so ${site.devHostname} still points at "${opts.fromName}". ` +
              `Create an A record to ${ip}; the old server forwards traffic until then.`,
      );
    }
  }
  if (site.devHostname && s.dns.enabled) {
    try {
      if (covered) {
        if ((await s.dns.deleteA(site.devHostname)) === 'deleted') {
          dns.updated.push(site.devHostname);
          ctx.info(`DNS: removed explicit record for ${site.devHostname} (wildcard server covers it)`);
        } else if (!opts.sameServer) {
          // Not in the token's zones: a record made by hand would still beat the wildcard.
          dns.manual.push({ host: site.devHostname, ip });
        }
      } else if (ip) {
        const res = await s.dns.upsertA(site.devHostname, ip);
        if (res === 'updated') {
          dns.updated.push(site.devHostname);
          ctx.info(`DNS: ${site.devHostname} -> ${ip}`);
        } else {
          dns.manual.push({ host: site.devHostname, ip });
        }
      }
    } catch (err) {
      ctx.error(`DNS update for ${site.devHostname} failed (fix manually): ${errMsg(err)}`);
      dns.manual.push({ host: site.devHostname, ip });
    }
  }
  for (const host of customHosts) {
    // A deleted site's domains may serve it from another host by now: made again, it only lists them.
    if (!opts.madeAgain && s.dns.enabled && ip && (await s.dns.canManage(host))) {
      try {
        await s.dns.upsertA(host, ip);
        dns.updated.push(host);
        ctx.info(`DNS: ${host} -> ${ip}`);
        continue;
      } catch (err) {
        ctx.error(`DNS update for ${host} failed: ${errMsg(err)}`);
      }
    }
    dns.manual.push({ host, ip });
  }
  if (dns.manual.length > 0) {
    const hosts = dns.manual.map((d) => d.host).join(', ');
    ctx.warn(
      (opts.madeAgain
        ? `DNS records are left as they were. For the site to answer on these here, point them at ${ip}: ${hosts}`
        : `${opts.sameServer ? 'Make sure these A records point at' : 'Update these A records to'} ${ip}: ${hosts}`) +
        (s.config.mailMode === 'direct' ? ' - and add the new server IP to their SPF records (docs/dns.md).' : ''),
    );
  }
  return dns;
}

/**
 * Make the old server forward every hostname of the site to the server it lives on now: Traefik
 * there keeps terminating TLS with the certificates it has, for clients on cached DNS answers and
 * for hostnames whose records were not (or could not be) updated, until the parked copy goes.
 * Returns the file's path, which the cleanup removes. A write that fails is a warning: stragglers
 * then get errors until DNS has moved.
 */
export async function writeForwarding(
  ctx: JobContext<unknown>,
  s: CoreServices,
  site: SiteRow,
  oldServer: ServerHandle,
  targetIp: string,
): Promise<string> {
  const proxyPath = proxyConfigPathFor(s.config.srvRoot, site.slug);
  try {
    await oldServer.files.mkdirp(path.dirname(proxyPath));
    await oldServer.files.writeFile(
      proxyPath,
      proxyConfigYaml({
        slug: site.slug,
        hosts: siteDomains(site),
        targetIp,
        tlsMode: s.config.tlsMode,
        acmeResolver: s.config.acmeResolver,
        devDomain: oldServer.row.devDomain,
        dnsProvider: s.dns.wildcardProvider(oldServer.row.dnsProvider),
        // A container app's plain http routes are forwarded on port 80 too.
        httpHosts: isContainerApp(site) ? appHttpHostsOf(s, site) : [],
      }),
    );
  } catch (err) {
    ctx.warn(
      `Could not write the forwarding config on "${oldServer.name}" (${errMsg(err)}); ` +
        `stragglers on old DNS will get errors until it propagates.`,
    );
  }
  return proxyPath;
}
