/**
 * DNS answers from a domain's own nameservers, for checks that have to see a record the moment
 * it is published.
 *
 * The mail setup guide is asked "is it there yet?" right after someone has added a record, and a
 * recursive resolver is the wrong thing to ask. It remembers "no such record" for as long as the
 * zone's SOA allows - an hour at some registrars - so a record added a minute after the guide
 * first looked stays missing for that hour, whatever the guide's Check button does. A zone's own
 * nameservers keep no such memory. So each query goes to them: the walk up the name finds the
 * nearest name with NS records, which is where the zone begins.
 *
 * The machine's resolver still answers whenever the direct answer cannot be had or trusted: no
 * zone found, its nameservers unreachable or refusing, or a CNAME at the name, which a zone's
 * servers report without following it out of their zone.
 */
// @docs mail/setup, security/privacy
import dnsPromises from 'node:dns/promises';
import { getDomain } from 'tldts';
import type { DnsResolver } from './mailDns.js';

/** The lookups the checks make, and the two the walk needs. */
export interface DnsQueries extends DnsResolver {
  resolveNs(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
}

export interface FreshDnsBackend {
  /** The machine's own resolver: recursive, and caching. */
  recursive: DnsQueries;
  /** Lookups sent to these addresses only: a zone's nameservers. */
  at(servers: string[]): DnsQueries;
}

/** Short, because the machine's resolver is still there to ask when a nameserver is not. */
const DIRECT_TIMEOUT_MS = 1500;

export const systemDnsBackend: FreshDnsBackend = {
  recursive: {
    resolveTxt: (name) => dnsPromises.resolveTxt(name),
    resolve4: (name) => dnsPromises.resolve4(name),
    resolveMx: (name) => dnsPromises.resolveMx(name),
    reverse: (ip) => dnsPromises.reverse(ip),
    resolveNs: (name) => dnsPromises.resolveNs(name),
    resolveCname: (name) => dnsPromises.resolveCname(name),
  },
  at(servers) {
    const resolver = new dnsPromises.Resolver({ timeout: DIRECT_TIMEOUT_MS, tries: 1 });
    resolver.setServers(servers);
    return {
      resolveTxt: (name) => resolver.resolveTxt(name),
      resolve4: (name) => resolver.resolve4(name),
      resolveMx: (name) => resolver.resolveMx(name),
      reverse: (ip) => resolver.reverse(ip),
      resolveNs: (name) => resolver.resolveNs(name),
      resolveCname: (name) => resolver.resolveCname(name),
    };
  },
};

/** "The name or the record does not exist": an answer, not a failure. */
const NEGATIVE = new Set(['ENOTFOUND', 'ENODATA']);
/** Nobody answered at all; asking the same servers again soon would only wait again. */
const UNREACHABLE = new Set(['ETIMEOUT', 'ECONNREFUSED']);
const codeOf = (err: unknown): string => (err as NodeJS.ErrnoException | null)?.code ?? '';

/** Where a zone begins, and the addresses of its nameservers. */
interface Zone {
  name: string;
  servers: string[];
}

/** Long enough to cover one visit to the guide; zones rarely move. */
const ZONE_TTL_MS = 10 * 60_000;
/** A name whose zone was not found is looked for again after this. */
const MISS_TTL_MS = 60_000;
/** How long a zone whose nameservers did not answer is asked through the machine's resolver. */
const UNREACHABLE_TTL_MS = 10 * 60_000;
/** Nameservers asked per zone. A zone has two to four; c-ares goes through them in turn. */
const SERVERS_PER_ZONE = 3;

/** `203.0.113.7` -> `7.113.0.203.in-addr.arpa`; null for anything but IPv4. */
function reverseName(ip: string): string | null {
  const octets = ip.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return null;
  return `${octets.reverse().join('.')}.in-addr.arpa`;
}

export class FreshResolver implements DnsResolver {
  private readonly zones = new Map<string, { at: number; zone: Promise<Zone | null> }>();
  private readonly unreachable = new Map<string, number>();

  constructor(
    private readonly backend: FreshDnsBackend = systemDnsBackend,
    private readonly now: () => number = Date.now,
  ) {}

  resolveTxt(name: string): Promise<string[][]> {
    return this.ask(name, (q) => q.resolveTxt(name));
  }

  resolve4(name: string): Promise<string[]> {
    return this.ask(name, (q) => q.resolve4(name));
  }

  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]> {
    return this.ask(name, (q) => q.resolveMx(name));
  }

  reverse(ip: string): Promise<string[]> {
    const name = reverseName(ip);
    return name ? this.ask(name, (q) => q.reverse(ip)) : this.backend.recursive.reverse(ip);
  }

  /** The zone `name` is published in, as the DNS itself says; null when the walk finds none. */
  async zoneOf(name: string): Promise<string | null> {
    return (await this.zoneFor(name))?.name ?? null;
  }

  private async ask<T>(name: string, query: (q: DnsQueries) => Promise<T[]>): Promise<T[]> {
    const zone = await this.zoneFor(name);
    if (zone && (this.unreachable.get(zone.name) ?? 0) <= this.now()) {
      const direct = this.backend.at(zone.servers);
      let negative: unknown = null;
      try {
        const answer = await query(direct);
        if (answer.length > 0) return answer;
        // Asked for one type, a zone's server answers a CNAME pointing out of its zone with
        // nothing of that type: an empty answer rather than "no such record".
        negative = answer;
      } catch (err) {
        if (UNREACHABLE.has(codeOf(err))) this.unreachable.set(zone.name, this.now() + UNREACHABLE_TTL_MS);
        if (NEGATIVE.has(codeOf(err))) negative = err;
      }
      if (negative !== null) {
        const alias = await direct.resolveCname(name).catch(() => [] as string[]);
        if (alias.length === 0) {
          if (Array.isArray(negative)) return negative as T[];
          throw negative;
        }
      }
    }
    return query(this.backend.recursive);
  }

  private zoneFor(name: string): Promise<Zone | null> {
    const key = name.toLowerCase().replace(/\.$/, '');
    const now = this.now();
    const cached = this.zones.get(key);
    if (cached && now - cached.at < ZONE_TTL_MS) return cached.zone;
    if (this.zones.size > 1000) {
      for (const [k, v] of this.zones) if (now - v.at >= ZONE_TTL_MS) this.zones.delete(k);
    }
    const zone = this.findZone(key).catch(() => null);
    const entry = { at: now, zone };
    this.zones.set(key, entry);
    // A walk that found nothing may have met a passing failure: try it again sooner.
    void zone.then((found) => {
      if (!found) entry.at = now - ZONE_TTL_MS + MISS_TTL_MS;
    });
    return zone;
  }

  /**
   * Up from the name to the first name with NS records, and not past the registrable domain:
   * above that is the registry, which holds the delegation and none of the records.
   */
  private async findZone(name: string): Promise<Zone | null> {
    const floor = getDomain(name, { allowPrivateDomains: false });
    if (!floor) return null;
    const labels = name.split('.');
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join('.');
      const hosts = await this.backend.recursive
        .resolveNs(candidate)
        .catch((err: unknown) => (NEGATIVE.has(codeOf(err)) ? [] : null));
      // The machine's resolver failed: walking on would only ask it again.
      if (hosts === null) return null;
      // A CNAME cannot sit where a zone begins. NS records for a name that has one are the
      // ones of the name it points to.
      if (hosts.length > 0 && !(await this.isAlias(candidate))) {
        const addresses = await Promise.all(
          hosts.slice(0, SERVERS_PER_ZONE + 1).map((host) => this.backend.recursive.resolve4(host).catch(() => [] as string[])),
        );
        const servers = [...new Set(addresses.flat())].slice(0, SERVERS_PER_ZONE);
        return servers.length > 0 ? { name: candidate, servers } : null;
      }
      if (candidate === floor) return null;
    }
    return null;
  }

  private async isAlias(name: string): Promise<boolean> {
    return (await this.backend.recursive.resolveCname(name).catch(() => [] as string[])).length > 0;
  }
}
