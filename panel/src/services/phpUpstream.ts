// @docs security/privacy, sites/php-updates
import { z } from 'zod';
import { compareVersions } from '../lib/wpVersions.js';
import type { Logger } from './index.js';
import type { SettingsService } from './settings.js';

/**
 * What php.net says about PHP's releases, read every 15 minutes (services/phpUpdates.ts) and kept
 * in settings, so a restart keeps it and no page view waits on php.net.
 *
 * Four official sources, all public:
 * - `releases/active.php`: the newest release of each supported branch, tagged `security` when
 *   it fixes one;
 * - `pre-release-builds.php`: each branch's current release candidate. The release follows two
 *   weeks after a first candidate, and a week after a later one, on a Thursday;
 * - `feed.atom`, php.net's news: an advance notice before a critical fix, with its date and time
 *   in a sentence ("scheduled for Wednesday, 21 October 2026 at 14:00 UTC");
 * - GitHub's advisories for php-src: what a security release fixed. Asked once per new security
 *   release, not every 15 minutes: an install without a token has 60 GitHub requests an hour,
 *   and the update check needs some of them.
 *
 * Their shapes are what docs/internal/watchlist.md keeps an eye on. A source that fails or changes
 * shape keeps what was read last; only `active.php` failing counts as the read failing.
 */

export const PHP_ACTIVE_URL = 'https://www.php.net/releases/active.php';
export const PHP_CANDIDATES_URL = 'https://www.php.net/pre-release-builds.php?format=json';
export const PHP_NEWS_URL = 'https://www.php.net/feed.atom';
export const PHP_ADVISORIES_URL =
  'https://api.github.com/repos/php/php-src/security-advisories?per_page=50&sort=published&direction=desc';

const SETTINGS_KEY = 'php.upstream';
const REQUEST_TIMEOUT_MS = 20_000;
/** The news feed is 1.5 MB and growing: enough for it, not for anything that is not. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** A failed advisory lookup is tried again this long after. */
const ADVISORY_RETRY_MS = 60 * 60_000;
/** Advisories kept, by release: the newest few, which is all a page or an email shows. */
const ADVISORY_RELEASES_KEPT = 12;
const DAY_MS = 24 * 3600_000;

export interface PhpRelease {
  version: string;
  /** YYYY-MM-DD, as php.net dates it. */
  date: string;
  security: boolean;
  /** When this install first read it. */
  seenAt: number;
}

export interface PhpCandidate {
  /** 8.4.28RC1 */
  version: string;
  /** 8.4.28: the release it is a candidate for. */
  release: string;
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM-DD: when the release is expected, from the candidate's own date. */
  expected: string;
}

export interface PhpNotice {
  /** The feed entry's id. */
  id: string;
  title: string;
  url: string;
  publishedAt: number;
  /** When the release is scheduled, when the notice says so in a way that reads. */
  scheduledAt: number | null;
  /** Whether `scheduledAt` has a time of day, or only a date. */
  scheduledTime: boolean;
}

export interface PhpAdvisory {
  id: string;
  cve: string | null;
  /** low, medium, high, critical */
  severity: string;
  summary: string;
  url: string;
}

export interface PhpFacts {
  /** The last read of `active.php` that worked. */
  checkedAt: number | null;
  attemptedAt: number | null;
  error: string | null;
  /** By branch, 8.4. */
  releases: Record<string, PhpRelease>;
  /** By branch: only a candidate for a release newer than the branch's newest. */
  candidates: Record<string, PhpCandidate>;
  /** The newest advance notice of a security release, however old. */
  notice: PhpNotice | null;
  /** By release version, for security releases. */
  advisories: Record<string, { fetchedAt: number; error: string | null; items: PhpAdvisory[] }>;
  /** The news feed's validators, so an unchanged feed costs a 304. */
  feed: { etag: string | null; lastModified: string | null };
}

export const EMPTY_PHP_FACTS: PhpFacts = {
  checkedAt: null,
  attemptedAt: null,
  error: null,
  releases: {},
  candidates: {},
  notice: null,
  advisories: {},
  feed: { etag: null, lastModified: null },
};

export type PhpFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "21 Oct 2026" or "05 November 2026" as YYYY-MM-DD; null for anything else. */
export function phpNetDate(text: string): string | null {
  const m = /^\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\s*$/.exec(text);
  const month = m ? MONTHS[m[2]!.slice(0, 3).toLowerCase()] : undefined;
  if (!m || !month) return null;
  const day = Number(m[1]);
  const iso = `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // 31 Feb is not a date.
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The branch of a release: 8.4.27 → 8.4. */
export const phpBranch = (version: string) => /^(\d+\.\d+)\./.exec(version)?.[1] ?? null;

const activeSchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.object({ version: z.string(), date: z.string(), tags: z.array(z.string()).nullish() }),
  ),
);

/** `releases/active.php`: the newest release of each branch, by branch. */
export function parseActive(body: unknown): Record<string, { version: string; date: string; security: boolean }> {
  const out: Record<string, { version: string; date: string; security: boolean }> = {};
  for (const branches of Object.values(activeSchema.parse(body))) {
    for (const [branch, release] of Object.entries(branches)) {
      const date = phpNetDate(release.date);
      if (!/^\d+\.\d+$/.test(branch) || phpBranch(release.version) !== branch || !date) continue;
      out[branch] = { version: release.version, date, security: (release.tags ?? []).includes('security') };
    }
  }
  if (Object.keys(out).length === 0) throw new Error('php.net listed no releases');
  return out;
}

/** One entry of the list. The list also has keys of other shapes (`reported`, `releases`), which are left out. */
const candidateSchema = z.object({
  release: z
    .object({ type: z.string().nullish(), number: z.coerce.number().nullish(), date: z.string().nullish(), version: z.string().nullish() })
    .nullish(),
});

/**
 * `pre-release-builds.php`: each branch's current candidate, when it is for a release newer than
 * the newest one `releases` has. The list keeps old entries with no candidate in them (number 0),
 * which say nothing.
 */
export function parseCandidates(body: unknown, releases: Record<string, { version: string }>): Record<string, PhpCandidate> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('php.net listed no release candidates');
  const out: Record<string, PhpCandidate> = {};
  for (const [release, raw] of Object.entries(body)) {
    const entry = candidateSchema.safeParse(raw);
    if (!entry.success || !/^\d+\.\d+\.\d+$/.test(release)) continue;
    const rc = entry.data.release;
    const version = rc?.version ?? '';
    const date = rc?.date ? phpNetDate(rc.date) : null;
    const m = /^(\d+\.\d+\.\d+)RC(\d+)$/.exec(version);
    const branch = phpBranch(release);
    if (!m || m[1] !== release || !date || !branch || (rc?.number ?? 0) < 1) continue;
    const newest = releases[branch]?.version;
    if (newest && compareVersions(release, newest) <= 0) continue;
    out[branch] = { version, release, date, expected: addDays(date, Number(m[2]) === 1 ? 14 : 7) };
  }
  return out;
}

const decode = (text: string) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

const textOf = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * When a notice says the release is: "scheduled for Wednesday, 21 October 2026 at 14:00 UTC",
 * or "on October 21, 2026". Null when no sentence reads, which is never guessed at.
 */
export function noticeSchedule(text: string): { at: number; time: boolean } | null {
  const day = String.raw`(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+)?`;
  const time = String.raw`(?:\s+at\s+(\d{1,2}):(\d{2})\s*UTC)?`;
  const patterns: [RegExp, (m: RegExpExecArray) => [string, string, string]][] = [
    [new RegExp(String.raw`(?:scheduled\s+for|on)\s+${day}(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})${time}`, 'i'), (m) => [m[1]!, m[2]!, m[3]!]],
    [new RegExp(String.raw`(?:scheduled\s+for|on)\s+${day}([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})${time}`, 'i'), (m) => [m[2]!, m[1]!, m[3]!]],
  ];
  for (const [pattern, parts] of patterns) {
    const m = pattern.exec(text);
    if (!m) continue;
    const [d, month, year] = parts(m);
    const date = phpNetDate(`${d} ${month} ${year}`);
    if (!date) continue;
    const hasTime = m[4] !== undefined && Number(m[4]) < 24 && Number(m[5]) < 60;
    const at = Date.parse(`${date}T${hasTime ? `${m[4]!.padStart(2, '0')}:${m[5]}` : '00:00'}:00Z`);
    return { at, time: hasTime };
  }
  return null;
}

const isPhpNet = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'php.net' || hostname.endsWith('.php.net'));
  } catch {
    return false;
  }
};

/** The feed's advance notices of a security release, newest first. */
export function parseNotices(atom: string): PhpNotice[] {
  const notices: PhpNotice[] = [];
  for (const [, entry] of atom.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const title = textOf(/<title[^>]*>([\s\S]*?)<\/title>/.exec(entry!)?.[1] ?? '');
    if (!/\bupcoming\b/i.test(title) || !/\bsecurity\b/i.test(title)) continue;
    const id = textOf(/<id>([\s\S]*?)<\/id>/.exec(entry!)?.[1] ?? '');
    const publishedAt = Date.parse(textOf(/<published>([\s\S]*?)<\/published>/.exec(entry!)?.[1] ?? ''));
    const url = /<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(entry!)?.[1] ?? /<link\b[^>]*href="([^"]+)"/.exec(entry!)?.[1] ?? '';
    // The card links to it: php.net's own pages only.
    if (!id || !Number.isFinite(publishedAt) || !isPhpNet(decode(url))) continue;
    const schedule = noticeSchedule(textOf(/<content[^>]*>([\s\S]*?)<\/content>/.exec(entry!)?.[1] ?? ''));
    notices.push({
      id,
      title,
      url: decode(url),
      publishedAt,
      scheduledAt: schedule?.at ?? null,
      scheduledTime: schedule?.time ?? false,
    });
  }
  return notices.sort((a, b) => b.publishedAt - a.publishedAt);
}

const advisoriesSchema = z.array(
  z
    .object({
      ghsa_id: z.string(),
      cve_id: z.string().nullish(),
      severity: z.string().nullish(),
      summary: z.string().nullish(),
      html_url: z.string().nullish(),
      vulnerabilities: z.array(z.object({ patched_versions: z.string().nullish() })).nullish(),
    }),
);

/** The advisories a release fixed: those that name it among their patched versions. */
export function parseAdvisories(body: unknown, version: string): PhpAdvisory[] {
  return advisoriesSchema
    .parse(body)
    .filter((a) => (a.vulnerabilities ?? []).some((v) => (v.patched_versions ?? '').split(',').map((p) => p.trim()).includes(version)))
    .map((a) => ({
      id: a.ghsa_id,
      cve: a.cve_id ?? null,
      severity: (a.severity ?? 'unknown').toLowerCase(),
      summary: a.summary ?? '',
      url: a.html_url && a.html_url.startsWith('https://github.com/') ? a.html_url : `https://github.com/php/php-src/security/advisories/${a.ghsa_id}`,
    }));
}

/** php.net's facts as last read, and the reading of them. */
export class PhpUpstream {
  private pending: Promise<void> | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly log: Logger,
    private readonly fetchImpl: PhpFetch = globalThis.fetch as unknown as PhpFetch,
    /** A GitHub token, when the install has one for the update check: more requests an hour. */
    private readonly githubToken = '',
  ) {}

  facts(): PhpFacts {
    const raw = this.settings.getRaw(SETTINGS_KEY);
    if (!raw || typeof raw !== 'object') return structuredClone(EMPTY_PHP_FACTS);
    const facts = raw as Partial<PhpFacts>;
    return { ...structuredClone(EMPTY_PHP_FACTS), ...facts, feed: { ...EMPTY_PHP_FACTS.feed, ...facts.feed } };
  }

  /** Read php.net again. One read at a time: a second caller gets the first one's answer. */
  refresh(): Promise<void> {
    this.pending ??= this.read().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async read(): Promise<void> {
    const old = this.facts();
    const now = Date.now();
    const next: PhpFacts = { ...old, attemptedAt: now };
    try {
      const active = parseActive(await this.json(PHP_ACTIVE_URL));
      const releases: Record<string, PhpRelease> = {};
      for (const [branch, release] of Object.entries(active)) {
        const before = old.releases[branch];
        releases[branch] = before?.version === release.version ? { ...before, ...release } : { ...release, seenAt: now };
      }
      next.releases = releases;
      next.checkedAt = now;
      next.error = null;
    } catch (err) {
      next.error = `php.net could not be read: ${errorText(err)}`;
      this.settings.setRaw(SETTINGS_KEY, next);
      this.log.warn(next.error);
      return;
    }
    try {
      next.candidates = parseCandidates(await this.json(PHP_CANDIDATES_URL), next.releases);
    } catch (err) {
      // What was read last stands, less the candidates whose release is out now.
      next.candidates = Object.fromEntries(
        Object.entries(old.candidates).filter(([branch, c]) => !next.releases[branch] || compareVersions(c.release, next.releases[branch]!.version) > 0),
      );
      this.log.warn(`php.net's release candidates could not be read: ${errorText(err)}`);
    }
    try {
      const feed = await this.news(old.feed);
      if (feed) {
        next.feed = feed.validators;
        next.notice = parseNotices(feed.body)[0] ?? old.notice;
      }
    } catch (err) {
      this.log.warn(`php.net's news could not be read: ${errorText(err)}`);
    }
    next.advisories = await this.advisories(next, old);
    this.settings.setRaw(SETTINGS_KEY, next);
  }

  /** The advisories of each branch's newest release that is a security one, read once. */
  private async advisories(next: PhpFacts, old: PhpFacts): Promise<PhpFacts['advisories']> {
    const kept = { ...old.advisories };
    const wanted = Object.values(next.releases)
      .filter((r) => r.security)
      .map((r) => r.version)
      .filter((v) => {
        const known = kept[v];
        return !known || (known.error !== null && Date.now() - known.fetchedAt >= ADVISORY_RETRY_MS);
      });
    if (wanted.length > 0) {
      const at = Date.now();
      try {
        const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
        if (this.githubToken) headers.authorization = `Bearer ${this.githubToken}`;
        const body = await this.json(PHP_ADVISORIES_URL, headers);
        for (const version of wanted) kept[version] = { fetchedAt: at, error: null, items: parseAdvisories(body, version) };
      } catch (err) {
        for (const version of wanted) kept[version] = { fetchedAt: at, error: errorText(err), items: kept[version]?.items ?? [] };
        this.log.warn(`PHP's advisories could not be read from GitHub: ${errorText(err)}`);
      }
    }
    // The newest releases' only: nothing reads older ones.
    const newest = Object.keys(kept).sort((a, b) => compareVersions(b, a)).slice(0, ADVISORY_RELEASES_KEPT);
    return Object.fromEntries(newest.map((v) => [v, kept[v]!]));
  }

  private async json(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const res = await this.get(url, { accept: 'application/json', ...headers });
    if (res.status !== 200) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return JSON.parse(await bodyOf(res));
  }

  /** The news feed, or null when it has not changed since `validators`. */
  private async news(validators: PhpFacts['feed']): Promise<{ body: string; validators: PhpFacts['feed'] } | null> {
    const headers: Record<string, string> = { accept: 'application/atom+xml' };
    if (validators.etag) headers['if-none-match'] = validators.etag;
    if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;
    const res = await this.get(PHP_NEWS_URL, headers);
    if (res.status === 304) return null;
    if (res.status !== 200) throw new Error(`www.php.net answered ${res.status}`);
    return {
      body: await bodyOf(res),
      validators: { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') },
    };
  }

  private async get(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timed out')), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { headers: { 'user-agent': 'WPL7 PHP releases', ...headers }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A response's text, refused past MAX_BODY_BYTES. */
async function bodyOf(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error('the answer is too large');
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('the answer is too large');
  return text;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
