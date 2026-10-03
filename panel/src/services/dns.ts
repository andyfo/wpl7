import type { Config } from '../config.js';
import type { Logger } from './index.js';

export interface DnsZone {
  id: string;
  name: string;
}

export interface DnsTxtRecord {
  id: string;
  content: string;
}

/** Minimal write client for per-site A records; same token the Traefik DNS-01 overlay uses. */
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
 */
export class DnsService {
  readonly enabled: boolean;
  /** Keyed by the zone's OWN name, so a hit is only ever a real suffix of the fqdn. */
  private zoneCache = new Map<string, DnsZone>();
  /** Names already known not to sit in any zone of this account. */
  private noZone = new Set<string>();

  constructor(
    private readonly provider: DnsProviderClient | null,
    private readonly log: Logger,
  ) {
    this.enabled = provider !== null;
  }

  /**
   * Memoized zone lookup. The cache key is the discovered zone name, NOT the fqdn's
   * parent suffix: keying on the parent made every apex domain collide on its TLD, so
   * after looking up `example.com` (suffix "com") a later `another.com` hit the cache and
   * got example.com's zone id - records would be written into the wrong customer's zone.
   */
  private async zoneFor(fqdn: string): Promise<DnsZone | null> {
    if (!this.provider) return null;
    const labels = fqdn.split('.');
    for (let i = 0; i <= labels.length - 2; i++) {
      const cached = this.zoneCache.get(labels.slice(i).join('.'));
      if (cached) return cached;
    }
    if (this.noZone.has(fqdn)) return null;
    const zone = await this.provider.findZone(fqdn);
    if (zone) this.zoneCache.set(zone.name, zone);
    else this.noZone.add(fqdn);
    return zone;
  }

  async canManage(fqdn: string): Promise<boolean> {
    try {
      return (await this.zoneFor(fqdn)) !== null;
    } catch (err) {
      this.log.warn(`DNS zone lookup for ${fqdn} failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Create or update the A record. 'unmanaged' = zone not in this account (set it manually). */
  async upsertA(fqdn: string, ip: string): Promise<'updated' | 'unmanaged'> {
    if (!this.provider) return 'unmanaged';
    const zone = await this.zoneFor(fqdn);
    if (!zone) return 'unmanaged';
    await this.provider.upsertA(zone, fqdn, ip, RECORD_TTL_SEC);
    return 'updated';
  }

  /** Remove the explicit A record; absent records are a no-op. */
  async deleteA(fqdn: string): Promise<'deleted' | 'unmanaged'> {
    if (!this.provider) return 'unmanaged';
    const zone = await this.zoneFor(fqdn);
    if (!zone) return 'unmanaged';
    await this.provider.deleteA(zone, fqdn);
    return 'deleted';
  }

  /** TXT records published at this exact name, or null when the zone is not ours. */
  async listTxt(fqdn: string): Promise<DnsTxtRecord[] | null> {
    if (!this.provider) return null;
    const zone = await this.zoneFor(fqdn);
    if (!zone) return null;
    return this.provider.listTxt(zone, fqdn);
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
    if (!this.provider) return 'unmanaged';
    const zone = await this.zoneFor(fqdn);
    if (!zone) return 'unmanaged';
    if (replaceId) await this.provider.updateTxt(zone, replaceId, fqdn, content, RECORD_TTL_SEC);
    else await this.provider.createTxt(zone, fqdn, content, RECORD_TTL_SEC);
    return 'written';
  }
}

// ---------------------------------------------------------------------------
// Cloudflare

interface CfEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

export class CloudflareDnsClient implements DnsProviderClient {
  constructor(private readonly token: string) {}

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as CfEnvelope<T>;
    if (!res.ok || !json.success) {
      const detail = json.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Cloudflare API ${method} ${path} failed - ${detail}`);
    }
    return json.result;
  }

  async findZone(fqdn: string): Promise<DnsZone | null> {
    const labels = fqdn.split('.');
    // Zones are at least 2 labels; walk suffixes from most to least specific.
    for (let i = 0; i <= labels.length - 2; i++) {
      const candidate = labels.slice(i).join('.');
      const zones = await this.api<{ id: string; name: string }[]>(
        'GET',
        `/zones?name=${encodeURIComponent(candidate)}&status=active&per_page=1`,
      );
      if (zones.length > 0) return { id: zones[0]!.id, name: zones[0]!.name };
    }
    return null;
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

export function createDnsProvider(config: Config): DnsProviderClient | null {
  if (config.dnsProvider === 'cloudflare' && config.dnsApiToken) {
    return new CloudflareDnsClient(config.dnsApiToken);
  }
  // Other providers (hetzner, digitalocean) can slot in behind the same interface.
  return null;
}
