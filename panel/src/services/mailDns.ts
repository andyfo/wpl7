/**
 * Deliverability checks: SPF, DKIM and DMARC lookups plus reverse DNS for the relay.
 *
 * These are the three records that decide whether a customer's `wp_mail()` lands in the
 * inbox or the spam folder, and getting them wrong is silent — mail is accepted and then
 * quietly filtered. The panel therefore checks them the way a receiver would rather than
 * just asserting the record exists.
 *
 * The resolver is injected so the whole module is testable without a network.
 */
import dnsPromises from 'node:dns/promises';
import type { MailRecordCheck } from '../../shared/types.js';
import { dkimRecordName, dkimRecordValue } from './mailDkim.js';

export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolve4(hostname: string): Promise<string[]>;
  resolveMx(hostname: string): Promise<{ exchange: string; priority: number }[]>;
  reverse(ip: string): Promise<string[]>;
}

export const systemResolver: DnsResolver = {
  resolveTxt: (h) => dnsPromises.resolveTxt(h),
  resolve4: (h) => dnsPromises.resolve4(h),
  resolveMx: (h) => dnsPromises.resolveMx(h),
  reverse: (ip) => dnsPromises.reverse(ip),
};

/**
 * One lookup's verdict. Aliased to the wire type so a change to the DTO cannot drift from
 * what these functions actually return:
 * 'ok' = receivers will be happy; 'warn' = present but weak; 'missing'/'error' need action.
 */
export type RecordCheck = MailRecordCheck;
export type CheckVerdict = MailRecordCheck['verdict'];

/** TXT records arrive as arrays of chunks that must be concatenated before parsing. */
async function txtRecords(resolver: DnsResolver, name: string): Promise<string[] | null> {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch (err) {
    // NXDOMAIN/ENODATA are "no record", which is a legitimate answer, not a failure.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ENXDOMAIN') return [];
    return null;
  }
}

// ---------------------------------------------------------------------------
// SPF

export interface SpfResult {
  found: string | null;
  /** Whether `ip` is authorized by the record, evaluated the way a receiver would. */
  authorizes: boolean | null;
  /** Qualifier attached to the matching (or catch-all) mechanism. */
  qualifier: '+' | '-' | '~' | '?' | null;
  /** DNS-querying mechanisms consumed; more than 10 makes the record permerror. */
  lookups: number;
  warnings: string[];
}

/** RFC 7208 caps an evaluation at 10 DNS-querying mechanisms; beyond that it is a permerror. */
const SPF_LOOKUP_LIMIT = 10;

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out;
};

/** Is `ip` inside `cidr` (`1.2.3.4` or `1.2.3.0/24`)? IPv4 only — servers are registered by IPv4. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [network = '', bitsRaw] = cidr.split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(network);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ~(0xffffffff >>> bits) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/**
 * Evaluate a domain's SPF record against one sending IP, following `include:` and
 * `redirect=` the way a receiving mail server does. Returns `authorizes: null` when the
 * record could not be evaluated (DNS failure or lookup limit blown) rather than guessing —
 * a false "not authorized" would send the operator chasing a record that is actually fine.
 */
export async function evaluateSpf(
  resolver: DnsResolver,
  domain: string,
  ip: string,
  state = { lookups: 0, warnings: [] as string[], depth: 0 },
): Promise<SpfResult> {
  const records = await txtRecords(resolver, domain);
  if (records === null) {
    return { found: null, authorizes: null, qualifier: null, lookups: state.lookups, warnings: [...state.warnings, `DNS lookup for ${domain} failed`] };
  }
  const spfRecords = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (spfRecords.length === 0) {
    return { found: null, authorizes: false, qualifier: null, lookups: state.lookups, warnings: state.warnings };
  }
  if (spfRecords.length > 1) {
    state.warnings.push(`${domain} publishes ${spfRecords.length} SPF records; receivers treat that as permerror — keep exactly one`);
  }
  const record = spfRecords[0]!.trim();

  let redirect: string | null = null;
  let catchAll: SpfResult['qualifier'] = null;

  for (const rawTerm of record.split(/\s+/).slice(1)) {
    if (!rawTerm) continue;
    const lower = rawTerm.toLowerCase();

    if (lower.startsWith('redirect=')) {
      redirect = rawTerm.slice('redirect='.length);
      continue;
    }
    if (lower.startsWith('exp=')) continue;

    const qualified = '+-~?'.includes(rawTerm[0]!);
    const qualifier = (qualified ? rawTerm[0] : '+') as NonNullable<SpfResult['qualifier']>;
    const term = qualified ? rawTerm.slice(1) : rawTerm;
    // `include:example.com`, `a`, `a:host`, `a/24`, `mx:host/24` — the name ends at : or /.
    const mechanism = (/^[a-z0-9]+/i.exec(term)?.[0] ?? '').toLowerCase();
    const argument = term.slice(mechanism.length).replace(/^:/, '');

    if (mechanism === 'all') {
      catchAll = qualifier;
      continue;
    }

    if (mechanism === 'ip4') {
      if (ipInCidr(ip, argument)) return { found: record, authorizes: qualifier === '+', qualifier, lookups: state.lookups, warnings: state.warnings };
      continue;
    }
    if (mechanism === 'ip6') continue; // servers are registered by IPv4

    // Everything below costs a DNS lookup.
    if (mechanism === 'a' || mechanism === 'mx' || mechanism === 'include' || mechanism === 'exists' || mechanism === 'ptr') {
      state.lookups++;
      if (state.lookups > SPF_LOOKUP_LIMIT) {
        state.warnings.push(`SPF for ${domain} needs more than ${SPF_LOOKUP_LIMIT} DNS lookups; receivers will treat it as permerror and ignore it`);
        return { found: record, authorizes: null, qualifier: null, lookups: state.lookups, warnings: state.warnings };
      }
    }

    if (mechanism === 'a') {
      const target = argument || domain;
      const addrs = await resolver.resolve4(target.split('/')[0] ?? target).catch(() => [] as string[]);
      if (addrs.includes(ip)) return { found: record, authorizes: qualifier === '+', qualifier, lookups: state.lookups, warnings: state.warnings };
      continue;
    }
    if (mechanism === 'mx') {
      const target = argument || domain;
      const mxs = await resolver.resolveMx(target).catch(() => [] as { exchange: string; priority: number }[]);
      for (const mx of mxs) {
        const addrs = await resolver.resolve4(mx.exchange).catch(() => [] as string[]);
        if (addrs.includes(ip)) return { found: record, authorizes: qualifier === '+', qualifier, lookups: state.lookups, warnings: state.warnings };
      }
      continue;
    }
    if (mechanism === 'include') {
      // Depth guard on top of the lookup budget: a self-referential include would
      // otherwise recurse until the stack gives out.
      if (state.depth >= SPF_LOOKUP_LIMIT) continue;
      const nested = await evaluateSpf(resolver, argument, ip, { ...state, depth: state.depth + 1 });
      state.lookups = nested.lookups;
      if (nested.authorizes === true) {
        return { found: record, authorizes: qualifier === '+', qualifier, lookups: state.lookups, warnings: state.warnings };
      }
      continue;
    }
  }

  if (redirect) {
    state.lookups++;
    if (state.lookups <= SPF_LOOKUP_LIMIT && state.depth < SPF_LOOKUP_LIMIT) {
      const nested = await evaluateSpf(resolver, redirect, ip, { ...state, depth: state.depth + 1 });
      return { ...nested, found: record };
    }
  }

  return { found: record, authorizes: catchAll === '+', qualifier: catchAll, lookups: state.lookups, warnings: state.warnings };
}

export async function checkSpf(resolver: DnsResolver, domain: string, sendingIps: string[]): Promise<RecordCheck> {
  if (sendingIps.length === 0) {
    const records = await txtRecords(resolver, domain);
    const found = records?.find((r) => /^v=spf1(\s|$)/i.test(r.trim())) ?? null;
    return found
      ? { verdict: 'warn', found, detail: 'SPF record present; no server IP known to verify it against' }
      : { verdict: 'missing', found: null, detail: 'No SPF record published' };
  }

  const results = await Promise.all(sendingIps.map((ip) => evaluateSpf(resolver, domain, ip)));
  const record = results.find((r) => r.found)?.found ?? null;
  const warnings = [...new Set(results.flatMap((r) => r.warnings))];

  if (!record) {
    return { verdict: 'missing', found: null, detail: 'No SPF record published — receivers cannot tell that this server may send for the domain' };
  }
  const unresolved = results.some((r) => r.authorizes === null);
  const notAuthorized = sendingIps.filter((ip, i) => results[i]!.authorizes === false);
  if (unresolved) {
    return { verdict: 'warn', found: record, detail: warnings[0] ?? 'SPF record could not be fully evaluated (DNS lookup failed)' };
  }
  if (notAuthorized.length > 0) {
    return {
      verdict: 'error',
      found: record,
      detail: `SPF does not authorize ${notAuthorized.join(', ')} — mail sent directly from ${notAuthorized.length > 1 ? 'these servers' : 'this server'} will fail SPF`,
    };
  }
  // A record ending in `+all` authorizes the whole internet, which is the same as no SPF.
  const openEnded = /[\s]\+?all\s*$/i.test(record);
  if (openEnded) {
    return { verdict: 'warn', found: record, detail: 'Record ends in +all, which authorizes every sender on the internet — use ~all or -all' };
  }
  return {
    verdict: warnings.length > 0 ? 'warn' : 'ok',
    found: record,
    detail: warnings[0] ?? `Authorizes ${sendingIps.length > 1 ? 'all sending servers' : sendingIps[0]}`,
  };
}

// ---------------------------------------------------------------------------
// DKIM

export async function checkDkim(
  resolver: DnsResolver,
  domain: string,
  selector: string,
  expectedPublicKeyB64: string,
): Promise<RecordCheck> {
  const name = dkimRecordName(domain, selector);
  const records = await txtRecords(resolver, name);
  if (records === null) return { verdict: 'error', found: null, detail: `DNS lookup for ${name} failed` };
  const record = records.find((r) => /v=DKIM1/i.test(r)) ?? null;
  if (!record) {
    return { verdict: 'missing', found: null, detail: `No DKIM record at ${name} — publish it to switch signing on for this domain` };
  }
  // Whitespace inside the published `p=` is normal: providers wrap long values.
  const published = /[;\s]p=([A-Za-z0-9+/=\s]*)/.exec(record)?.[1]?.replace(/\s+/g, '') ?? '';
  if (!published) {
    return { verdict: 'error', found: record, detail: `The DKIM record at ${name} has an empty p= (that revokes the key)` };
  }
  if (published !== expectedPublicKeyB64) {
    return {
      verdict: 'error',
      found: record,
      detail: `The DKIM record at ${name} publishes a different key than this panel signs with — republish it, or signatures will fail`,
    };
  }
  return { verdict: 'ok', found: record, detail: `Published key matches the signing key (selector "${selector}")` };
}

/** Domains with no key yet: report what is missing rather than looking it up. */
export function dkimNotConfigured(): RecordCheck {
  return { verdict: 'missing', found: null, detail: 'No DKIM key generated for this domain yet' };
}

// ---------------------------------------------------------------------------
// DMARC

export interface DmarcTags {
  p?: string;
  sp?: string;
  pct?: string;
  rua?: string;
  ruf?: string;
  adkim?: string;
  aspf?: string;
}

export function parseDmarc(record: string): DmarcTags {
  const tags: Record<string, string> = {};
  for (const part of record.split(';')) {
    const [k, ...rest] = part.split('=');
    if (!k || rest.length === 0) continue;
    tags[k.trim().toLowerCase()] = rest.join('=').trim();
  }
  return tags;
}

export async function checkDmarc(resolver: DnsResolver, domain: string): Promise<RecordCheck> {
  const name = `_dmarc.${domain}`;
  const records = await txtRecords(resolver, name);
  if (records === null) return { verdict: 'error', found: null, detail: `DNS lookup for ${name} failed` };
  const record = records.find((r) => /^v=DMARC1/i.test(r.trim())) ?? null;
  if (!record) {
    return { verdict: 'missing', found: null, detail: `No DMARC record at ${name} — start with p=none to collect reports before enforcing` };
  }
  const tags = parseDmarc(record);
  const policy = (tags.p ?? '').toLowerCase();
  if (!policy) {
    return { verdict: 'error', found: record, detail: 'DMARC record has no p= policy tag and will be ignored' };
  }
  if (policy === 'none') {
    return {
      verdict: 'warn',
      found: record,
      detail: tags.rua
        ? 'Policy is p=none (monitoring only). Move to quarantine once the reports look clean.'
        : 'Policy is p=none and no rua= report address is set, so nothing is being learned from it',
    };
  }
  return { verdict: 'ok', found: record, detail: `Policy is p=${policy}${tags.pct && tags.pct !== '100' ? ` on ${tags.pct}% of mail` : ''}` };
}

// ---------------------------------------------------------------------------
// Reverse DNS (per server, direct-delivery mode only)

/**
 * Receivers that accept mail straight from this server check that its IP resolves back to
 * a name, and that the name resolves forward to the same IP. A missing or mismatched PTR
 * is the single most common reason self-hosted mail is rejected outright.
 */
export async function checkReverseDns(resolver: DnsResolver, ip: string, expectedHostname?: string): Promise<RecordCheck> {
  let names: string[];
  try {
    names = await resolver.reverse(ip);
  } catch {
    return {
      verdict: 'error',
      found: null,
      detail: `${ip} has no reverse DNS (PTR) record — set it at your VPS provider or most receivers will reject the mail`,
    };
  }
  if (names.length === 0) {
    return { verdict: 'error', found: null, detail: `${ip} has no reverse DNS (PTR) record` };
  }
  const name = names[0]!;
  const forward = await resolver.resolve4(name).catch(() => [] as string[]);
  if (!forward.includes(ip)) {
    return {
      verdict: 'warn',
      found: name,
      detail: `${ip} resolves to ${name}, but ${name} does not resolve back to ${ip} — receivers doing forward-confirmed lookups will distrust it`,
    };
  }
  if (expectedHostname && name.toLowerCase() !== expectedHostname.toLowerCase()) {
    return {
      verdict: 'warn',
      found: name,
      detail: `Reverse DNS says ${name} but the relay announces itself as ${expectedHostname}; make the two match`,
    };
  }
  return { verdict: 'ok', found: name, detail: `${ip} resolves to ${name} and back` };
}

/**
 * Does the name the relay announces actually resolve to this server? Receivers that do a
 * forward-confirmed lookup start from the PTR and check it leads back here, so a missing A
 * record breaks rDNS even when the PTR itself is set — and on some providers the PTR cannot
 * be set until the forward record exists.
 */
export async function checkHostnameA(resolver: DnsResolver, hostname: string, ip: string): Promise<RecordCheck> {
  if (!hostname) return { verdict: 'missing', found: null, detail: 'The relay does not report a hostname yet' };
  const addrs = await resolver.resolve4(hostname).catch(() => [] as string[]);
  if (addrs.length === 0) {
    return { verdict: 'missing', found: null, detail: `${hostname} does not resolve — add an A record pointing it at ${ip}` };
  }
  if (!addrs.includes(ip)) {
    return {
      verdict: 'error',
      found: addrs.join(', '),
      detail: `${hostname} resolves to ${addrs.join(', ')}, not ${ip} — point it at this server`,
    };
  }
  return { verdict: 'ok', found: addrs.join(', '), detail: `${hostname} resolves to ${ip}` };
}

// ---------------------------------------------------------------------------
// Suggested records

/** The SPF record to publish when this fleet delivers mail itself. */
export const suggestedSpf = (serverIps: string[]): string =>
  `v=spf1 ${serverIps.map((ip) => `ip4:${ip}`).join(' ')} ~all`.replace(/\s+/g, ' ');

/** A safe starting DMARC policy: monitor first, enforce once the reports are clean. */
export const suggestedDmarc = (reportTo: string): string =>
  `v=DMARC1; p=none; rua=mailto:${reportTo}; adkim=r; aspf=r`;

export { dkimRecordValue };
