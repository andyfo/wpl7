// @docs integrations/cloudflare, integrations/dns, security/privacy
import type { Logger } from './index.js';

/** The one provider the panel manages records with, and whose token it hands to Traefik. */
export const CLOUDFLARE = 'cloudflare';

export interface DnsZone {
  id: string;
  name: string;
}

export interface DnsTxtRecord {
  id: string;
  content: string;
}

/** Minimal write client for per-site A records; same token every server's Traefik answers DNS challenges with. */
export interface DnsProviderClient {
  /** Longest-suffix zone of fqdn present in the account, or null. */
  findZone(fqdn: string): Promise<DnsZone | null>;
  upsertA(zone: DnsZone, fqdn: string, ip: string, ttlSec: number): Promise<void>;
  deleteA(zone: DnsZone, fqdn: string): Promise<void>;
  /** TXT records at exactly this name (SPF, DKIM and DMARC all live in TXT). */
  listTxt(zone: DnsZone, fqdn: string): Promise<DnsTxtRecord[]>;
  createTxt(zone: DnsZone, fqdn: string, content: string, ttlSec: number): Promise<void>;
  updateTxt(zone: DnsZone, recordId: string, fqdn: string, content: string, ttlSec: number): Promise<void>;
}

const RECORD_TTL_SEC = 300; // low TTL so moves cut over fast

/**
 * Panel-managed DNS. The dev wildcard (*.devDomain) points at the wildcard server;
 * sites on other servers get an explicit record (specific beats wildcard), created at
 * site-create, flipped on move, removed at delete. Custom domains whose zone lives in
 * the same account can be flipped too. Fully optional - a null provider disables it.
 *
 * The provider comes from the token in Settings -> DNS (services/dnsAccount.ts), so it can
 * change while the panel runs: every call reads the current one.
 */
export class DnsService {
  /** Keyed by the zone's OWN name, so a hit is only ever a real suffix of the fqdn. */
  private zoneCache = new Map<string, DnsZone>();
  /** Names already known not to sit in any zone of this account. */
  private noZone = new Set<string>();
  /**
   * How many times both were emptied. A lookup still out at the time is not written into them:
   * it may have been asked of the old token, or before a zone was added.
   */
  private forgotten = 0;

  constructor(
    private provider: DnsProviderClient | null,
    private readonly log: Logger,
  ) {}

  get enabled(): boolean {
    return this.provider !== null;
  }

  /**
   * Work in another account from now on - a new token, or none. What was learned about the
   * old one's zones goes with it: a zone id means nothing in another account.
   */
  use(provider: DnsProviderClient | null): void {
    this.provider = provider;
    this.forgetZones();
  }

  /** Look every zone up again: one added to the account since is found on the next call. */
  forgetZones(): void {
    this.zoneCache.clear();
    this.noZone.clear();
    this.forgotten++;
  }

  /**
   * The DNS provider a server's dev sites get their wildcard certificate from, or '' when
   * they cannot get one there. Cloudflare's token is the panel's - Traefik reads the copy the
   * panel gives every server (services/traefikDns.ts) - so a server set to Cloudflare has no
   * way to answer the challenge without one, and a site labelled for it would be served no
   * certificate at all. Any other provider's credentials are in that server's deploy/.env.
   */
  wildcardProvider(serverDnsProvider: string): string {
    return serverDnsProvider === CLOUDFLARE && !this.enabled ? '' : serverDnsProvider;
  }

  /**
   * The zone fqdn is in, with the provider that found it - which is the one that then writes
   * there: a zone id means nothing in another account. A token replaced while the lookup was
   * out makes its answer one about the old account, so the new token is asked; a token removed
   * leaves nothing to write with.
   */
  private async locate(fqdn: string): Promise<{ provider: DnsProviderClient; zone: DnsZone } | null> {
    const provider = this.provider;
    if (!provider) return null;
    const zone = await this.zoneFor(provider, fqdn);
    if (provider !== this.provider) return this.locate(fqdn);
    return zone ? { provider, zone } : null;
  }

  /**
   * Memoized zone lookup. The cache key is the discovered zone name, NOT the fqdn's
   * parent suffix: keying on the parent made every apex domain collide on its TLD, so
   * after looking up `example.com` (suffix "com") a later `another.com` hit the cache and
   * got example.com's zone id - records would be written into the wrong customer's zone.
   */
  private async zoneFor(provider: DnsProviderClient, fqdn: string): Promise<DnsZone | null> {
    const labels = fqdn.split('.');
    for (let i = 0; i <= labels.length - 2; i++) {
      const cached = this.zoneCache.get(labels.slice(i).join('.'));
      if (cached) return cached;
    }
    if (this.noZone.has(fqdn)) return null;
    const asked = this.forgotten;
    const zone = await provider.findZone(fqdn);
    if (asked === this.forgotten) {
      if (zone) this.zoneCache.set(zone.name, zone);
      else this.noZone.add(fqdn);
    }
    return zone;
  }

  async canManage(fqdn: string): Promise<boolean> {
    try {
      return (await this.locate(fqdn)) !== null;
    } catch (err) {
      this.log.warn(`DNS zone lookup for ${fqdn} failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Create or update the A record. 'unmanaged' = zone not in this account (set it manually). */
  async upsertA(fqdn: string, ip: string): Promise<'updated' | 'unmanaged'> {
    const found = await this.locate(fqdn);
    if (!found) return 'unmanaged';
    await found.provider.upsertA(found.zone, fqdn, ip, RECORD_TTL_SEC);
    return 'updated';
  }

  /** Remove the explicit A record; absent records are a no-op. */
  async deleteA(fqdn: string): Promise<'deleted' | 'unmanaged'> {
    const found = await this.locate(fqdn);
    if (!found) return 'unmanaged';
    await found.provider.deleteA(found.zone, fqdn);
    return 'deleted';
  }

  /** TXT records published at this exact name, or null when the zone is not ours. */
  async listTxt(fqdn: string): Promise<DnsTxtRecord[] | null> {
    const found = await this.locate(fqdn);
    if (!found) return null;
    return found.provider.listTxt(found.zone, fqdn);
  }

  /**
   * Write a TXT record.
   *
   * `replaceId` names the single record this is meant to supersede - the caller has already
   * decided which one that is. Mail records are unforgiving about duplicates (two SPF
   * records is a permerror, two DKIM keys at one selector is a coin flip), and the caller
   * knows which of several TXT records at a name is the mail one; a blind
   * "delete everything here and write ours" would take out a customer's unrelated
   * verification tokens.
   */
  async putTxt(fqdn: string, content: string, replaceId?: string): Promise<'written' | 'unmanaged'> {
    const found = await this.locate(fqdn);
    if (!found) return 'unmanaged';
    if (replaceId) await found.provider.updateTxt(found.zone, replaceId, fqdn, content, RECORD_TTL_SEC);
    else await found.provider.createTxt(found.zone, fqdn, content, RECORD_TTL_SEC);
    return 'written';
  }
}

// ---------------------------------------------------------------------------
// Cloudflare

interface CfEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
  result_info?: { total_count?: number };
}

/** Cloudflare said no, in its own words: what Settings -> DNS shows when a token is refused. */
export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    /** Cloudflare's own message, e.g. `Invalid API Token (1000)`; the HTTP status when there is none. */
    readonly detail: string,
    method: string,
    path: string,
  ) {
    super(`Cloudflare API ${method} ${path} failed - ${detail}`);
  }

  /** The token itself was refused - wrong, expired, revoked - rather than one request. */
  get refusedToken(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** What Settings -> DNS -> Check reads with a token, besides the records the panel writes. */
export interface DnsAccountProbe {
  /** Active zones the token can read: the first page, and how many there are in all. */
  listZones(): Promise<{ zones: DnsZone[]; total: number }>;
  /** Read one record of the zone: proof of DNS access there, which Zone Read alone is not. */
  probeRecords(zone: DnsZone): Promise<void>;
}

export class CloudflareDnsClient implements DnsProviderClient, DnsAccountProbe {
  constructor(private readonly token: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<CfEnvelope<T>> {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    // An error page from in front of the API is HTML, not an envelope.
    const json = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!res.ok || !json?.success) {
      const detail = json?.errors?.map((e) => `${e.message} (${e.code})`).join('; ') || `HTTP ${res.status}`;
      throw new CloudflareApiError(res.status, detail, method, path.replace(/\?.*$/, ''));
    }
    return json;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request<T>(method, path, body)).result;
  }

  async findZone(fqdn: string): Promise<DnsZone | null> {
    const labels = fqdn.split('.');
    // Zones are at least 2 labels; walk suffixes from most to least specific. An exact name
    // matches one zone at most; 5 is the smallest page Cloudflare's reference allows.
    for (let i = 0; i <= labels.length - 2; i++) {
      const candidate = labels.slice(i).join('.');
      const zones = await this.api<{ id: string; name: string }[]>(
        'GET',
        `/zones?name=${encodeURIComponent(candidate)}&status=active&per_page=5`,
      );
      if (zones.length > 0) return { id: zones[0]!.id, name: zones[0]!.name };
    }
    return null;
  }

  async listZones(): Promise<{ zones: DnsZone[]; total: number }> {
    const page = await this.request<{ id: string; name: string }[]>('GET', '/zones?status=active&per_page=50');
    const zones = page.result.map((z) => ({ id: z.id, name: z.name }));
    return { zones, total: Math.max(page.result_info?.total_count ?? zones.length, zones.length) };
  }

  async probeRecords(zone: DnsZone): Promise<void> {
    await this.api('GET', `/zones/${zone.id}/dns_records?per_page=1`);
  }

  private async findRecords(zone: DnsZone, fqdn: string): Promise<{ id: string }[]> {
    return this.api<{ id: string }[]>(
      'GET',
      `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(fqdn)}&per_page=10`,
    );
  }

  async upsertA(zone: DnsZone, fqdn: string, ip: string, ttlSec: number): Promise<void> {
    const existing = await this.findRecords(zone, fqdn);
    const record = { type: 'A', name: fqdn, content: ip, ttl: ttlSec, proxied: false };
    if (existing.length > 0) {
      await this.api('PUT', `/zones/${zone.id}/dns_records/${existing[0]!.id}`, record);
      for (const extra of existing.slice(1)) {
        await this.api('DELETE', `/zones/${zone.id}/dns_records/${extra.id}`);
      }
    } else {
      await this.api('POST', `/zones/${zone.id}/dns_records`, record);
    }
  }

  async deleteA(zone: DnsZone, fqdn: string): Promise<void> {
    for (const record of await this.findRecords(zone, fqdn)) {
      await this.api('DELETE', `/zones/${zone.id}/dns_records/${record.id}`);
    }
  }

  async listTxt(zone: DnsZone, fqdn: string): Promise<DnsTxtRecord[]> {
    const records = await this.api<{ id: string; content: string }[]>(
      'GET',
      `/zones/${zone.id}/dns_records?type=TXT&name=${encodeURIComponent(fqdn)}&per_page=100`,
    );
    return records.map((r) => ({ id: r.id, content: r.content }));
  }

  async createTxt(zone: DnsZone, fqdn: string, content: string, ttlSec: number): Promise<void> {
    await this.api('POST', `/zones/${zone.id}/dns_records`, { type: 'TXT', name: fqdn, content, ttl: ttlSec });
  }

  async updateTxt(zone: DnsZone, recordId: string, fqdn: string, content: string, ttlSec: number): Promise<void> {
    await this.api('PUT', `/zones/${zone.id}/dns_records/${recordId}`, { type: 'TXT', name: fqdn, content, ttl: ttlSec });
  }
}
