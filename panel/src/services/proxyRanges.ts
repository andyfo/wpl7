/**
 * The published address ranges of the services whose traffic the panel treats specially:
 * Cloudflare, whose edge servers stand in front of sites that use its proxy; Jetpack, whose
 * servers call a site's XML-RPC endpoint and must not be limited or blocked for it; and the
 * AI assistants - ChatGPT, Claude, Gemini and the rest - whose crawlers and fetchers are never
 * blocked.
 *
 * Cloudflare and Jetpack publish a plain list, the AI companies Google's JSON format. The panel
 * fetches them weekly (from the nightly housekeeping), keeps the last copy that passed its
 * sanity checks, and ships with a copy of its own for an install that has never reached them.
 * A list that fails the checks is never used: trusting a wrong range for Cloudflare means
 * believing a forged visitor address from whoever holds it, and a wrong range for an AI
 * company means never blocking whoever holds it.
 */
// @docs security/blocked-addresses, security/privacy
import { CidrSet, isPrivateIp, parseCidr, WIDEST_PREFIX, type IpFamily } from '../../shared/cidr.js';
import { CLOUDFLARE, DEFAULT_TRUSTED_PROXIES, type TrustedProxiesSetting } from '../../shared/security.js';
import type { TrustedProxy } from '../lib/clientIp.js';
import { AI_BUILTIN } from './aiRanges.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';

/** The AI companies whose published addresses are never blocked. */
export const AI_SOURCES = ['openai', 'anthropic', 'googleAgents', 'perplexity', 'mistral', 'duckduckgo'] as const;
export type AiSource = (typeof AI_SOURCES)[number];
export type RangeSource = 'cloudflare' | 'jetpack' | AiSource;

interface SourceSpec {
  label: string;
  urls: string[];
  /** Google's JSON (`{"prefixes": [{"ipv4Prefix": ...}]}`), kept merged; else one range a line. */
  format?: 'prefixes';
  /** Fewer than this many ranges is a broken download, not a vendor that shrank. */
  minRanges: number;
  /** More than this many is not the vendor's list either. Default 500. */
  maxRanges?: number;
  /** The widest range the list may hold. Default: the widest anyone may trust by hand. */
  widest?: Record<IpFamily, number>;
  /** As published when this version was written; what an install that never fetched uses. */
  builtin: string[];
}

/** An AI company's range never blocked may be no wider than this: Google's widest is a /16. */
const AI_WIDEST: Record<IpFamily, number> = { 4: 16, 6: 32 };

export const RANGE_SOURCES: Record<RangeSource, SourceSpec> = {
  cloudflare: {
    label: 'Cloudflare',
    urls: ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6'],
    minRanges: 10,
    // https://www.cloudflare.com/ips/, 2026-09-29.
    builtin: [
      '173.245.48.0/20',
      '103.21.244.0/22',
      '103.22.200.0/22',
      '103.31.4.0/22',
      '141.101.64.0/18',
      '108.162.192.0/18',
      '190.93.240.0/20',
      '188.114.96.0/20',
      '197.234.240.0/22',
      '198.41.128.0/17',
      '162.158.0.0/15',
      '104.16.0.0/13',
      '104.24.0.0/14',
      '172.64.0.0/13',
      '131.0.72.0/22',
      '2400:cb00::/32',
      '2606:4700::/32',
      '2803:f800::/32',
      '2405:b500::/32',
      '2405:8100::/32',
      '2a06:98c0::/29',
      '2c0f:f248::/32',
    ],
  },
  jetpack: {
    label: 'Jetpack',
    urls: ['https://jetpack.com/ips-v4.txt'],
    minRanges: 3,
    // https://jetpack.com/ips-v4.txt, 2026-09-29. Jetpack publishes no IPv6 list.
    builtin: [
      '122.248.245.244/32',
      '54.217.201.243/32',
      '54.232.116.4/32',
      '192.0.80.0/20',
      '192.0.96.0/20',
      '192.0.112.0/20',
      '195.234.108.0/22',
      '192.0.64.0/18',
    ],
  },
  // Each company's lists as its bot documentation names them. The copies shipped are in
  // services/aiRanges.ts, which scripts/ai-ranges.ts writes.
  openai: {
    label: "OpenAI's bots (ChatGPT, GPTBot)",
    urls: ['https://openai.com/gptbot.json', 'https://openai.com/searchbot.json', 'https://openai.com/chatgpt-user.json', 'https://openai.com/adsbot.json'],
    format: 'prefixes',
    minRanges: 20,
    maxRanges: 2000,
    widest: AI_WIDEST,
    builtin: AI_BUILTIN.openai,
  },
  anthropic: {
    label: "Anthropic's bots (Claude)",
    urls: ['https://claude.com/crawling/bots.json'],
    format: 'prefixes',
    minRanges: 5,
    widest: AI_WIDEST,
    builtin: AI_BUILTIN.anthropic,
  },
  googleAgents: {
    label: "Google's fetchers and agents (Gemini)",
    urls: [
      'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json',
      'https://developers.google.com/static/search/apis/ipranges/user-triggered-agents.json',
    ],
    format: 'prefixes',
    minRanges: 100,
    maxRanges: 5000,
    widest: AI_WIDEST,
    builtin: AI_BUILTIN.googleAgents,
  },
  perplexity: {
    label: "Perplexity's bots",
    urls: ['https://www.perplexity.com/perplexitybot.json', 'https://www.perplexity.com/perplexity-user.json'],
    format: 'prefixes',
    minRanges: 3,
    widest: AI_WIDEST,
    builtin: AI_BUILTIN.perplexity,
  },
  mistral: {
    label: "Mistral's bots (Le Chat)",
    urls: ['https://mistral.ai/mistralai-user-ips.json', 'https://mistral.ai/mistralai-index-ips.json'],
    format: 'prefixes',
    minRanges: 1,
    widest: AI_WIDEST,
    builtin: AI_BUILTIN.mistral,
  },
  duckduckgo: {
    label: "DuckDuckGo's DuckAssistBot",
    urls: ['https://duckduckgo.com/duckassistbot.json'],
    format: 'prefixes',
    minRanges: 50,
    maxRanges: 2000,
    widest: AI_WIDEST,
    builtin: AI_BUILTIN.duckduckgo,
  },
};

const SOURCES = Object.keys(RANGE_SOURCES) as RangeSource[];

/** Refreshed when older than this. Cloudflare's and Jetpack's change a few times a year. */
export const RANGES_MAX_AGE_MS = 7 * 24 * 3600_000;
const FETCH_TIMEOUT_MS = 30_000;
/** More than this many ranges is not a vendor's list either, unless its spec says otherwise. */
const MAX_RANGES = 500;

interface StoredRanges {
  ranges: string[];
  fetchedAt: number;
}

type StoredState = Partial<Record<RangeSource, StoredRanges>> & {
  /** Last failed refresh per source, cleared by a successful one. */
  errors?: Partial<Record<RangeSource, string>>;
  /** Last attempt, successful or not - what "stale" backs off on. */
  attemptedAt?: number;
};

export interface RangeSourceStatus {
  source: RangeSource;
  label: string;
  ranges: number;
  /** null = the copy shipped with this version is in use. */
  fetchedAt: number | null;
  error: string | null;
}

const STATE_KEY = 'security.proxyRanges';

/**
 * Parse and check one download: every line a range (comments and blank lines skipped), none
 * private, none wider than `widest` - by default, what the panel lets anyone trust by hand.
 */
export function parseRangeList(text: string, widest: Record<IpFamily, number> = WIDEST_PREFIX): { ranges: string[] } | { problem: string } {
  const ranges: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cidr = parseCidr(line);
    if (!cidr) return { problem: `"${line.slice(0, 60)}" is not an address range` };
    if (cidr.prefix < widest[cidr.family]) return { problem: `${cidr.text} is wider than a /${widest[cidr.family]}` };
    if (isPrivateIp(cidr.text.split('/')[0]!)) return { problem: `${cidr.text} is a private range` };
    ranges.push(cidr.text);
  }
  return { ranges };
}

/**
 * The same, for a list in Google's JSON format - `{"prefixes": [{"ipv4Prefix": "..."},
 * {"ipv6Prefix": "..."}]}` - which the AI companies publish theirs in too.
 */
export function parsePrefixList(text: string, widest: Record<IpFamily, number> = WIDEST_PREFIX): { ranges: string[] } | { problem: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { problem: 'not JSON' };
  }
  const prefixes = doc !== null && typeof doc === 'object' ? (doc as { prefixes?: unknown }).prefixes : undefined;
  if (!Array.isArray(prefixes)) return { problem: 'no "prefixes" list' };
  const lines: string[] = [];
  for (const entry of prefixes) {
    const e = (entry ?? {}) as { ipv4Prefix?: unknown; ipv6Prefix?: unknown };
    const value = e.ipv4Prefix ?? e.ipv6Prefix;
    if (typeof value !== 'string') return { problem: 'a prefix without an address' };
    lines.push(value);
  }
  return parseRangeList(lines.join('\n'), widest);
}

export class ProxyRangesService {
  private cache: { key: string; proxies: TrustedProxy[] } | null = null;
  private jetpackSet: { key: string; set: CidrSet } | null = null;
  private aiSets: { key: string; list: { label: string; set: CidrSet }[] } | null = null;
  /** Told when the ranges or the setting change what is trusted, so the rules get rewritten. */
  onChange: (() => void) | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private state(): StoredState {
    return (this.settings.getRaw(STATE_KEY) as StoredState | undefined) ?? {};
  }

  /** The ranges in use for a source: the last good download, or the built-in copy. */
  ranges(source: RangeSource): string[] {
    return this.state()[source]?.ranges ?? RANGE_SOURCES[source].builtin;
  }

  status(): RangeSourceStatus[] {
    const state = this.state();
    return SOURCES.map((source) => ({
      source,
      label: RANGE_SOURCES[source].label,
      ranges: this.ranges(source).length,
      fetchedAt: state[source]?.fetchedAt ?? null,
      error: state.errors?.[source] ?? null,
    }));
  }

  /** Due for a refresh: never fetched, or the oldest copy is past its age - but not more than daily. */
  isStale(now = Date.now()): boolean {
    const state = this.state();
    if (state.attemptedAt && now - state.attemptedAt < 24 * 3600_000) return false;
    return SOURCES.some((source) => {
      const at = state[source]?.fetchedAt;
      return !at || now - at > RANGES_MAX_AGE_MS;
    });
  }

  async refresh(now = Date.now()): Promise<{ refreshed: RangeSource[]; failed: RangeSource[] }> {
    const state = this.state();
    const next: StoredState = { ...state, errors: { ...state.errors }, attemptedAt: now };
    const refreshed: RangeSource[] = [];
    const failed: RangeSource[] = [];
    for (const source of SOURCES) {
      const spec = RANGE_SOURCES[source];
      try {
        const lists = await Promise.all(
          spec.urls.map(async (url) => {
            const text = await this.fetchText(url);
            const parsed = spec.format === 'prefixes' ? parsePrefixList(text, spec.widest) : parseRangeList(text, spec.widest);
            if ('problem' in parsed) throw new Error(`${url}: ${parsed.problem}`);
            return parsed.ranges;
          }),
        );
        const all = lists.flat();
        if (all.length < spec.minRanges || all.length > (spec.maxRanges ?? MAX_RANGES)) {
          throw new Error(`${all.length} ranges, which is not what ${spec.label} publishes`);
        }
        // Google's list alone is a thousand /64s and /27s: kept merged, as the copy shipped is.
        const ranges = spec.format === 'prefixes' ? new CidrSet(all).cidrs.map((c) => c.text) : all;
        const before = [...this.ranges(source)].sort().join(',');
        next[source] = { ranges, fetchedAt: now };
        delete next.errors![source];
        refreshed.push(source);
        if (before !== [...ranges].sort().join(',')) {
          this.log.info(`${spec.label} address ranges changed (${ranges.length} ranges)`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        next.errors![source] = message.slice(0, 300);
        failed.push(source);
        this.log.warn(`${spec.label} address ranges not refreshed, keeping the previous copy: ${message}`);
      }
    }
    const changed = JSON.stringify(this.rangesOf(state)) !== JSON.stringify(this.rangesOf(next));
    this.settings.setRaw(STATE_KEY, next);
    if (changed) this.changed();
    return { refreshed, failed };
  }

  private rangesOf(state: StoredState): Record<RangeSource, string[]> {
    return Object.fromEntries(SOURCES.map((source) => [source, state[source]?.ranges ?? RANGE_SOURCES[source].builtin])) as Record<RangeSource, string[]>;
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'wpl7-panel/1 (+published address ranges)' },
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.text();
  }

  /** The setting, with a default for an install that predates it. */
  setting(): TrustedProxiesSetting {
    return this.settings.get('securityTrustedProxies') ?? DEFAULT_TRUSTED_PROXIES;
  }

  /** Every proxy whose header is believed, Cloudflare first. Cached until something changes. */
  trusted(): TrustedProxy[] {
    const setting = this.setting();
    const key = JSON.stringify([setting, this.ranges('cloudflare')]);
    if (this.cache?.key === key) return this.cache.proxies;
    const proxies: TrustedProxy[] = [];
    if (setting.cloudflare) {
      proxies.push({ name: CLOUDFLARE.name, header: CLOUDFLARE.header, ranges: new CidrSet(this.ranges('cloudflare')) });
    }
    for (const custom of setting.custom) {
      proxies.push({ name: custom.name, header: custom.header, ranges: new CidrSet(custom.ranges) });
    }
    this.cache = { key, proxies };
    return proxies;
  }

  /** Jetpack's servers: exempt from the XML-RPC limit and never blocked. */
  jetpack(): CidrSet {
    const ranges = this.ranges('jetpack');
    const key = ranges.join(',');
    if (this.jetpackSet?.key !== key) this.jetpackSet = { key, set: new CidrSet(ranges) };
    return this.jetpackSet.set;
  }

  /** The AI companies' crawlers and fetchers, by company: never blocked. */
  aiAssistants(): { label: string; set: CidrSet }[] {
    const key = AI_SOURCES.map((source) => this.ranges(source).join(',')).join('|');
    if (this.aiSets?.key !== key) {
      this.aiSets = { key, list: AI_SOURCES.map((source) => ({ label: RANGE_SOURCES[source].label, set: new CidrSet(this.ranges(source)) })) };
    }
    return this.aiSets.list;
  }

  /** The setting changed; see onChange. */
  changed(): void {
    this.cache = null;
    this.onChange?.();
  }
}
