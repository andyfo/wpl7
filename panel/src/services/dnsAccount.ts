// @docs integrations/cloudflare
import type { Config } from '../config.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';
import {
  CloudflareApiError,
  CloudflareDnsClient,
  type DnsAccountProbe,
  type DnsProviderClient,
  type DnsService,
  type DnsZone,
} from './dns.js';
import type { DnsTokenCheckDto } from '../../shared/types.js';

/**
 * A settings row of its own rather than a key of PanelSettings: `GET /api/settings` answers
 * every key there to Read only API keys, and the token must never be in that answer.
 */
export const CLOUDFLARE_TOKEN_KEY = 'dns.cloudflareToken';
const SET_AT_KEY = 'dns.cloudflareTokenSetAt';

export type DnsClient = DnsProviderClient & DnsAccountProbe;

/** Where a domain is in the account, and whether the token may touch that zone's records. */
export type DnsReach = Pick<DnsTokenCheckDto['devDomains'][number], 'zone' | 'records' | 'detail'>;

/**
 * deploy/.env's token, on the first boot that finds one - the seed every other value that is
 * in both places gets (docs/configuration.md). A token removed in Settings is an empty string,
 * not a missing row, so it is never seeded back.
 */
export function seedCloudflareToken(settings: SettingsService, token: string): void {
  if (!token || settings.getRaw(CLOUDFLARE_TOKEN_KEY) !== undefined) return;
  settings.setRaw(CLOUDFLARE_TOKEN_KEY, token);
  settings.setRaw(SET_AT_KEY, Date.now());
}

/**
 * The Cloudflare account the panel works in (Settings -> DNS): the token, which no API answer
 * ever contains, and the check that says what a token reaches before anything depends on it.
 *
 * One token does all of it: the panel's own records (DnsService) - a site's record on a server
 * the wildcard does not point at, a domain going live, a mail domain's SPF, DKIM and DMARC -
 * and, through the copy every server is given (services/traefikDns.ts), the DNS challenges
 * behind the wildcard certificate dev sites share.
 */
export class DnsAccount {
  /** Told after the token changed: every server's Traefik needs the new one. */
  onChange: () => void = () => undefined;

  constructor(
    private readonly settings: SettingsService,
    private readonly dns: DnsService,
    private readonly servers: ServerRegistry,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly makeClient: (token: string) => DnsClient = (token) => new CloudflareDnsClient(token),
  ) {}

  /** At boot, before the first request: records are written with the stored token from then on. */
  load(): void {
    const token = this.token();
    this.dns.use(token ? this.makeClient(token) : null);
  }

  token(): string {
    const value = this.settings.getRaw(CLOUDFLARE_TOKEN_KEY);
    return typeof value === 'string' ? value : '';
  }

  status(): { configured: boolean; setAt: number | null; envDiffers: boolean } {
    const token = this.token();
    const setAt = this.settings.getRaw(SET_AT_KEY);
    return {
      configured: token !== '',
      setAt: token && typeof setAt === 'number' ? setAt : null,
      envDiffers: this.config.cloudflareTokenSeed !== '' && this.config.cloudflareTokenSeed !== token,
    };
  }

  /** Keep this token from now on - checked by the caller - or none (''). False when nothing changed. */
  set(token: string): boolean {
    const next = token.trim();
    if (next === this.token()) return false;
    this.settings.setRaw(CLOUDFLARE_TOKEN_KEY, next);
    this.settings.setRaw(SET_AT_KEY, next ? Date.now() : null);
    this.dns.use(next ? this.makeClient(next) : null);
    this.log.info(next ? 'DNS: a new Cloudflare token is in use' : 'DNS: the Cloudflare token was removed');
    this.onChange();
    return true;
  }

  /**
   * What a token reaches - the stored one when none is given. Whether Cloudflare takes it at
   * all, which zones it reads, and for every dev domain of the fleet, the zone it is in and
   * whether the token reads that zone's records: the wildcard certificate's challenges and the
   * per-site records are both written there. Reads only; nothing in any zone is changed.
   */
  async check(candidate?: string): Promise<DnsTokenCheckDto> {
    const token = (candidate ?? this.token()).trim();
    const result: DnsTokenCheckDto = { ok: false, error: null, zones: [], zoneCount: 0, devDomains: [] };
    if (!token) return { ...result, error: 'There is no token to check.' };
    // A zone added to the account since the panel last looked is found from now on.
    if (candidate === undefined) this.dns.forgetZones();

    const client = this.makeClient(token);
    try {
      const { zones, total } = await client.listZones();
      result.zones = zones.map((z) => z.name).sort();
      result.zoneCount = total;
    } catch (err) {
      return { ...result, error: cloudflareError(err) };
    }
    if (result.zoneCount === 0) {
      return {
        ...result,
        error: "The token works, but it can't see any domain. Give it Zone → Zone → Read and Zone → DNS → Edit for your domains.",
      };
    }
    result.ok = true;

    const byDomain = new Map<string, string[]>();
    for (const row of this.servers.listRows()) {
      if (!row.devDomain) continue;
      byDomain.set(row.devDomain, [...(byDomain.get(row.devDomain) ?? []), row.name]);
    }
    for (const [domain, servers] of byDomain) {
      result.devDomains.push({ domain, servers, ...(await reachOf(client, domain)) });
    }
    return result;
  }

  /**
   * What the stored token reaches of one domain, asked of Cloudflare now - the line Check shows
   * for a dev domain, and what switching a server's wildcard certificate on depends on.
   */
  async reach(domain: string): Promise<DnsReach> {
    const token = this.token();
    if (!token) return { zone: null, records: null, detail: null };
    return reachOf(this.makeClient(token), domain);
  }
}

/**
 * The zone a domain is in, and whether the token reads its records. Zone Read alone finds the
 * zone; the records - a site's, or a DNS challenge's - need DNS access there as well.
 */
async function reachOf(client: DnsClient, domain: string): Promise<DnsReach> {
  let zone: DnsZone | null;
  try {
    zone = await client.findZone(domain);
  } catch (err) {
    return { zone: null, records: null, detail: cloudflareError(err) };
  }
  if (!zone) return { zone: null, records: null, detail: null };
  try {
    await client.probeRecords(zone);
    return { zone: zone.name, records: 'readable', detail: null };
  } catch (err) {
    return { zone: zone.name, records: 'refused', detail: cloudflareError(err) };
  }
}

/** One line for an operator: Cloudflare's own words when it answered, or why it could not be reached. */
function cloudflareError(err: unknown): string {
  if (err instanceof CloudflareApiError) return `Cloudflare said: ${err.detail}`;
  return `Couldn't reach Cloudflare: ${err instanceof Error ? err.message : String(err)}`;
}
