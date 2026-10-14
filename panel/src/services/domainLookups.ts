// @docs automations/reminders
import https from 'node:https';
import { domainToASCII } from 'node:url';
import { getDomain } from 'tldts';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { domainLookups } from '../db/schema.js';
import type { SettingsService } from './settings.js';
import { assertAllowedSource } from '../lib/outboundGuard.js';
import { badRequest } from '../lib/errors.js';
import { DAY, type DomainDto } from '../../shared/reminders.js';

// Registry endpoints absent from IANA's bootstrap. See docs/internal/watchlist.md.
export const RDAP_SUPPLEMENT: Record<string, string> = {
  co: 'https://rdap.registry.co/co/',
  io: 'https://rdap.identitydigital.services/rdap/',
  me: 'https://rdap.identitydigital.services/rdap/',
  us: 'https://rdap.nic.us/',
};
export const DANGER_STATUSES = new Set(['redemption period', 'pending delete', 'client hold', 'server hold', 'inactive']);
export const normalizedStatus = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[-_]/g, ' ');
export function registrableDomain(raw: string): string | null {
  if (/[\/\\?#@:\s]/.test(raw.trim())) return null;
  const name = domainToASCII(raw.trim().toLowerCase().replace(/\.$/, ''));
  if (!name || name.length > 253 || !name.split('.').every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  return getDomain(name, { allowPrivateDomains: false, validateHostname: true });
}

export interface JsonReply {
  status: number;
  body: unknown;
  retryAfter?: string;
}
export type JsonReader = (url: string, headers?: Record<string, string>) => Promise<JsonReply>;
/** Bounded HTTPS with public addresses pinned to the connection, including every redirect. */
export const readPublicJson: JsonReader = async (raw, headers = {}) => {
  let url = raw;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const allowed = await assertAllowedSource(url, { allowHttp: false });
    const result = await new Promise<{ status: number; body: string; location?: string; retryAfter?: string }>((resolve, reject) => {
      const req = https.get(
        allowed.url,
        {
          headers: { accept: 'application/rdap+json, application/json', 'user-agent': 'WPL7 reminders', ...headers },
          // Pin the family too: Node's default family=0 asks lookup for an array of addresses.
          family: allowed.family,
          lookup: (_hostname, _opts, cb) => cb(null, allowed.address, allowed.family),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2_000_000) req.destroy(new Error('Lookup response too large'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              location: res.headers.location,
              retryAfter: res.headers['retry-after'],
            }),
          );
        },
      );
      const timeout = setTimeout(() => req.destroy(new Error('Lookup timed out')), 15_000);
      req.on('close', () => clearTimeout(timeout));
      req.on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.location) {
      const next = new URL(result.location, url);
      // Authentication is only used for Cloudflare's fixed endpoint; never forward it.
      if (headers.authorization) throw new Error('Authenticated lookup redirected');
      url = next.href;
      continue;
    }
    return { status: result.status, body: result.status === 200 ? JSON.parse(result.body) : null, retryAfter: result.retryAfter };
  }
  throw new Error('Too many lookup redirects');
};
const rdapSchema = z.object({
  objectClassName: z.literal('domain'),
  events: z.array(z.object({ eventAction: z.string(), eventDate: z.string() })).optional(),
  status: z.array(z.string()).optional(),
  entities: z.array(z.object({ roles: z.array(z.string()).optional(), vcardArray: z.array(z.unknown()).optional() })).optional(),
});
export function parseRdap(body: unknown): Pick<DomainDto, 'expires' | 'registrar' | 'statuses'> {
  const doc = rdapSchema.parse(body);
  const expires = doc.events?.find((e) => e.eventAction === 'expiration')?.eventDate;
  const card = doc.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1];
  const fn = Array.isArray(card) ? card.find((v: unknown) => Array.isArray(v) && v[0] === 'fn') : null;
  return {
    expires: expires && Number.isFinite(Date.parse(expires)) ? new Date(expires).toISOString().slice(0, 10) : null,
    registrar: Array.isArray(fn) && typeof fn[3] === 'string' ? fn[3].slice(0, 200) : null,
    statuses: (doc.status ?? []).map(normalizedStatus),
  };
}

export class DomainLookupService {
  private pending = new Map<string, Promise<DomainDto>>();
  private bootstrapPending: Promise<Record<string, string>> | null = null;
  constructor(
    private db: Db,
    private settings: SettingsService,
    private read: JsonReader = readPublicJson,
  ) {}
  enabled() {
    return this.settings.get('domainLookups') !== false;
  }
  cached(domain: string): DomainDto | null {
    const row = this.db.select().from(domainLookups).where(eq(domainLookups.domain, domain)).get();
    return row ? (JSON.parse(row.data) as DomainDto) : null;
  }
  list(): DomainDto[] {
    return this.db
      .select()
      .from(domainLookups)
      .all()
      .map((r) => JSON.parse(r.data) as DomainDto);
  }
  private save(dto: DomainDto) {
    this.db
      .insert(domainLookups)
      .values({ domain: dto.domain, data: JSON.stringify(dto) })
      .onConflictDoUpdate({ target: domainLookups.domain, set: { data: JSON.stringify(dto) } })
      .run();
    return dto;
  }
  private async bootstrap(): Promise<Record<string, string>> {
    const hit = this.settings.getRaw('reminders.rdapBootstrap') as { at: number; urls: Record<string, string> } | undefined;
    if (hit && Date.now() - hit.at < 7 * DAY) return hit.urls;
    if (this.bootstrapPending) return this.bootstrapPending;
    this.bootstrapPending = (async () => {
      try {
        const reply = await this.read('https://data.iana.org/rdap/dns.json');
        if (reply.status !== 200) throw new Error('RDAP directory unavailable');
        const doc = z.object({ services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])) }).parse(reply.body);
        const urls: Record<string, string> = {};
        for (const [tlds, bases] of doc.services) {
          const base = bases.find((b) => b.startsWith('https://'));
          if (base) for (const tld of tlds) urls[tld] = base;
        }
        this.settings.setRaw('reminders.rdapBootstrap', { at: Date.now(), urls });
        return urls;
      } catch (err) {
        if (hit) return hit.urls;
        throw err;
      }
    })().finally(() => {
      this.bootstrapPending = null;
    });
    return this.bootstrapPending;
  }
  lookup(raw: string): Promise<DomainDto> {
    const domain = registrableDomain(raw);
    if (!domain) throw badRequest('Enter a public domain name');
    const existing = this.pending.get(domain);
    if (existing) return existing;
    const promise = this.query(domain).finally(() => this.pending.delete(domain));
    this.pending.set(domain, promise);
    return promise;
  }
  private async query(domain: string): Promise<DomainDto> {
    const now = Date.now();
    const old = this.cached(domain);
    const initial: DomainDto = old ?? {
      domain,
      expires: null,
      registrar: null,
      statuses: [],
      checkedAt: null,
      nextCheckAt: 0,
      source: null,
      error: null,
      observed: false,
      missing: false,
    };
    if (!this.enabled()) return { ...initial, error: 'Domain lookups are off' };
    if (initial.nextCheckAt > now) return initial;
    let source = initial.source;
    try {
      const bootstrap = await this.bootstrap();
      const tld = domain.split('.').at(-1)!;
      source = bootstrap[tld] ?? RDAP_SUPPLEMENT[tld] ?? null;
      if (!source)
        return this.save({ ...initial, checkedAt: now, nextCheckAt: now + 7 * DAY, error: 'No RDAP server. Enter the date manually.' });
      const waitKey = `reminders.rdapWait:${new URL(source).origin}`;
      const waitUntil = this.settings.getRaw(waitKey) as number | undefined;
      if (waitUntil && waitUntil > now)
        return this.save({ ...initial, nextCheckAt: waitUntil, error: 'Registry rate limit. Retrying later.' });
      const response = await this.read(new URL(`domain/${encodeURIComponent(domain)}`, source.endsWith('/') ? source : `${source}/`).href);
      if (response.status === 429 || response.status >= 500) {
        const retry = response.retryAfter;
        const retryAt = retry && /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry ?? '');
        this.settings.setRaw(waitKey, Math.max(now + DAY, Number.isFinite(retryAt) ? Math.min(retryAt, now + 7 * DAY) : 0));
      }
      if (response.status === 404)
        return this.save({
          ...initial,
          source,
          checkedAt: now,
          nextCheckAt: now + DAY,
          missing: initial.observed,
          error: initial.observed ? 'Domain no longer found at the registry' : 'Domain not found. Check the name or enter a date.',
        });
      if (response.status !== 200) throw new Error(`Registry returned HTTP ${response.status}`);
      const parsed = parseRdap(response.body);
      return this.save({
        ...initial,
        ...parsed,
        expires: parsed.expires ?? initial.expires,
        source,
        observed: true,
        missing: false,
        checkedAt: now,
        nextCheckAt: now + DAY,
        error: parsed.expires ? null : 'Registry publishes no expiry date. Enter it manually.',
      });
    } catch {
      return this.save({
        ...initial,
        source,
        checkedAt: now,
        nextCheckAt: now + DAY,
        error: 'Lookup failed. Keeping the last known date.',
      });
    }
  }
}
