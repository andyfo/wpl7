import type { WporgPluginDto } from '../../shared/types.js';
import { badGateway } from '../lib/errors.js';

const API_BASE = 'https://api.wordpress.org/plugins/info/1.2/';
const TIMEOUT_MS = 8000;

/**
 * The directory returns a lot by default (full readme HTML, every contributor, every
 * past version). Asking for exactly the fields the panel renders keeps a ten-result
 * search under ~20 kB instead of well over a megabyte.
 */
const FIELDS_ON = [
  'short_description',
  'icons',
  'active_installs',
  'requires',
  'requires_php',
  'tested',
  'last_updated',
  'homepage',
];
const FIELDS_OFF = [
  'sections',
  'description',
  'tags',
  'ratings',
  'contributors',
  'banners',
  'screenshots',
  'versions',
  'compatibility',
  'donate_link',
  'reviews',
  'added',
  'downloaded',
  'support_threads',
];

interface WporgApiPlugin {
  name?: string;
  slug?: string;
  version?: string;
  author?: string;
  short_description?: string;
  active_installs?: number;
  rating?: number;
  num_ratings?: number;
  requires?: string | false;
  requires_php?: string | false;
  tested?: string | false;
  last_updated?: string;
  homepage?: string;
  icons?: Record<string, string>;
}

export interface WporgSearchResult {
  items: WporgPluginDto[];
  page: number;
  pages: number;
  total: number;
}

/** What routes and the catalog need; the tests swap in a fake instead of hitting the network. */
export interface WporgDirectory {
  search(query: string, page?: number): Promise<WporgSearchResult>;
  /** Canonical plugin record, or null when the directory has no such slug. */
  info(slug: string): Promise<WporgPluginDto | null>;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/**
 * Directory text is HTML: names carry entities ("Yoast SEO &#8211; …") and `author` is a
 * full anchor tag. React escapes on render, so this is about legibility, not safety.
 */
export function cleanText(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function toDto(p: WporgApiPlugin): WporgPluginDto | null {
  if (!p.slug) return null;
  const icons = p.icons ?? {};
  return {
    slug: p.slug,
    name: cleanText(p.name) || p.slug,
    author: cleanText(p.author),
    shortDescription: cleanText(p.short_description),
    version: p.version ?? '',
    activeInstalls: p.active_installs ?? 0,
    rating: p.rating ?? 0,
    numRatings: p.num_ratings ?? 0,
    requiresWp: p.requires || null,
    requiresPhp: p.requires_php || null,
    testedUpTo: p.tested || null,
    lastUpdated: p.last_updated ?? null,
    homepage: p.homepage || null,
    icon: icons['2x'] ?? icons['1x'] ?? icons.svg ?? icons.default ?? null,
  };
}

/** Fixed-capacity TTL cache; oldest insertion is evicted once it is full. */
class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/**
 * Read-only client for the wordpress.org plugin directory, used to search the directory
 * from the panel and to check a slug really exists before it lands in the catalog.
 */
export class WporgDirectoryService implements WporgDirectory {
  private readonly fetchImpl: typeof fetch;
  private readonly searchCache: TtlCache<WporgSearchResult>;
  /** `null` is cached too: a typo'd slug should not re-query the directory on every keystroke. */
  private readonly infoCache: TtlCache<WporgPluginDto | null>;

  constructor(opts: { fetchImpl?: typeof fetch; searchTtlMs?: number; infoTtlMs?: number } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.searchCache = new TtlCache(200, opts.searchTtlMs ?? 5 * 60_000);
    this.infoCache = new TtlCache(500, opts.infoTtlMs ?? 60 * 60_000);
  }

  private url(action: string, request: Record<string, string | number>): string {
    const params = new URLSearchParams({ action });
    for (const [key, value] of Object.entries(request)) params.set(`request[${key}]`, String(value));
    for (const f of FIELDS_ON) params.set(`request[fields][${f}]`, '1');
    for (const f of FIELDS_OFF) params.set(`request[fields][${f}]`, '0');
    return `${API_BASE}?${params}`;
  }

  private async get(url: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'wpl7-panel' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw badGateway(
        'Could not reach the wordpress.org plugin directory. Check this server’s outbound ' +
          `internet access and try again (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    // 404 is the directory's "no such plugin" answer, so it is a result, not a failure.
    if (!res.ok && res.status !== 404) {
      throw badGateway(`The wordpress.org plugin directory returned HTTP ${res.status}.`);
    }
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async search(query: string, page = 1): Promise<WporgSearchResult> {
    const term = query.trim();
    const key = `${page}:${term.toLowerCase()}`;
    const cached = this.searchCache.get(key);
    if (cached) return cached;

    const { body } = await this.get(this.url('query_plugins', { search: term, page, per_page: 10 }));
    const payload = body as { plugins?: WporgApiPlugin[]; info?: { page?: number; pages?: number; results?: number } } | null;
    const result: WporgSearchResult = {
      items: (payload?.plugins ?? []).map(toDto).filter((p): p is WporgPluginDto => p !== null),
      page: payload?.info?.page ?? page,
      pages: payload?.info?.pages ?? 1,
      total: payload?.info?.results ?? 0,
    };
    this.searchCache.set(key, result);
    return result;
  }

  async info(slug: string): Promise<WporgPluginDto | null> {
    const key = slug.toLowerCase();
    const cached = this.infoCache.get(key);
    if (cached !== undefined) return cached;

    const { status, body } = await this.get(this.url('plugin_information', { slug }));
    const payload = body as (WporgApiPlugin & { error?: string }) | null;
    const result = status === 404 || !payload || payload.error ? null : toDto(payload);
    this.infoCache.set(key, result);
    return result;
  }
}
