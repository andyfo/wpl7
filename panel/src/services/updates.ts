// @docs get-started/how-it-works, panel/updating, security/privacy
import type { Config } from '../config.js';
import type { SystemVersionDto, UpdateReleaseDto } from '../../shared/types.js';
import { PANEL_GIT_SHA, PANEL_VERSION } from '../lib/version.js';
import type { Logger } from './index.js';
import type { SettingsService } from './settings.js';

/**
 * Is there a newer version, and what is it?
 *
 * The panel asks GitHub once an hour and caches the answer, so no page view ever reaches out
 * to a third party - a control panel that stalls because a registry is slow is worse than one
 * that is a few minutes out of date. Everything it knows is in settings, which means the
 * answer survives a restart and an update can be offered the moment the panel comes back.
 *
 * The check is deliberately allowed to fail loudly. An unauthenticated caller gets 60
 * requests an hour *per IP address* and a conditional request only escapes that budget when
 * it was authorized, so a box behind CGNAT, or one sharing an address with CI, will
 * eventually be told 403. A checker that treats "I could not ask" as "you are up to date"
 * would then quietly stop offering updates forever, which is why `error` is a field of its
 * own and the UI has three states rather than two.
 */

export type UpdateChannel = 'stable' | 'edge';

export interface UpdateManifest {
  version: string;
  channel: UpdateChannel;
  publishedAt: string;
  notesUrl: string;
  gitSha?: string;
  images: { panel: string; wordpress: Record<string, string> };
  minUpgradeFrom?: string;
  requiresDowntime?: boolean;
}

interface CachedCheck {
  manifest: UpdateManifest | null;
  /** Version the operator has already been told about, so they are told exactly once. */
  announced: string | null;
  /** Last check that reached GitHub and got an answer (200 or 304). */
  checkedAt: number | null;
  /** Last attempt, whatever came of it. */
  attemptedAt: number | null;
  /** ETag of the release the cached manifest came from. */
  etag: string | null;
  error: string | null;
  /** Do not ask again before this; set from the rate-limit headers. */
  retryAfter: number | null;
}

const CACHE_KEY = 'updates.latest';
const OFFSET_KEY = 'updates.minuteOffset';
const CHECK_INTERVAL_MS = 60 * 60_000;
/** Long enough for the boot rush (migrations, network reconcile, mail sync) to be over. */
export const FIRST_CHECK_DELAY_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const EMPTY: CachedCheck = {
  manifest: null,
  announced: null,
  checkedAt: null,
  attemptedAt: null,
  etag: null,
  error: null,
  retryAfter: null,
};

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class UpdateService {
  /**
   * Told once per version, and only when this install is actually behind it. Wired to the
   * operator alert address in index.ts - an update nobody notices for three weeks is the
   * failure mode a checker exists to prevent, and the panel is not somewhere most operators
   * spend their day.
   */
  onNewRelease: ((release: UpdateManifest) => void) | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {}

  /**
   * A per-install minute of the hour, chosen once and remembered. Without it every WPL7
   * on earth would ask GitHub at :00 - which is both rude and the fastest way to have the
   * whole fleet rate-limited together.
   */
  minuteOffset(): number {
    const stored = this.settings.getRaw(OFFSET_KEY);
    if (typeof stored === 'number' && stored >= 0 && stored < 60) return stored;
    const offset = Math.floor(Math.random() * 60);
    this.settings.setRaw(OFFSET_KEY, offset);
    return offset;
  }

  cached(): CachedCheck {
    const raw = this.settings.getRaw(CACHE_KEY);
    return raw && typeof raw === 'object' ? { ...EMPTY, ...(raw as CachedCheck) } : { ...EMPTY };
  }

  status(): SystemVersionDto {
    const cache = this.cached();
    const latest = cache.manifest;
    return {
      version: PANEL_VERSION,
      gitSha: PANEL_GIT_SHA,
      channel: this.config.channel,
      source: this.config.source,
      latest: latest ? toReleaseDto(latest) : null,
      updateAvailable: latest ? isBehind(PANEL_VERSION, PANEL_GIT_SHA, latest) : false,
      checkedAt: cache.checkedAt,
      error: cache.error,
      nextCheckAt: cache.checkedAt === null ? null : cache.checkedAt + CHECK_INTERVAL_MS,
    };
  }

  /**
   * The scheduler's tick: ask only on this install's minute, and not while rate-limited.
   * True when it actually asked - the other 59 ticks an hour are not worth recording.
   */
  async tick(now = new Date()): Promise<boolean> {
    const cache = this.cached();
    if (cache.retryAfter !== null && Date.now() < cache.retryAfter) return false;
    const due = cache.checkedAt === null || Date.now() - cache.checkedAt >= CHECK_INTERVAL_MS;
    if (!due) return false;
    // First check ever: go as soon as the boot rush is over, whatever minute it is.
    if (cache.attemptedAt !== null && now.getMinutes() !== this.minuteOffset()) return false;
    await this.check();
    return true;
  }

  /** Ask GitHub now. Never throws: a failed check is a recorded state, not an exception. */
  async check(): Promise<SystemVersionDto> {
    const cache = this.cached();
    const next: CachedCheck = { ...cache, attemptedAt: Date.now() };
    const tag = this.config.channel === 'edge' ? 'edge' : null;

    try {
      const release = tag
        ? await this.get(`${this.api()}/releases/tags/${tag}`)
        : await this.newestStable();

      if (release.status === 304) {
        // Nothing changed. Still a successful check - and on an unauthorized request it
        // cost a unit of rate limit all the same, which is why the token is worth setting.
        next.checkedAt = Date.now();
        next.error = null;
      } else {
        const asset = findManifestAsset(release.body);
        if (!asset) throw new Error('the release has no manifest.json asset');
        const manifest = parseManifest(await this.getJson(asset));
        next.manifest = manifest;
        next.etag = release.etag;
        next.checkedAt = Date.now();
        next.error = null;
      }
      next.retryAfter = null;
    } catch (err) {
      next.error = err instanceof Error ? err.message : String(err);
      next.retryAfter = retryAfterFrom(err);
      this.log.warn(`Update check failed: ${next.error}`);
    }

    const latest = next.manifest;
    if (latest && next.announced !== latest.version && isBehind(PANEL_VERSION, PANEL_GIT_SHA, latest)) {
      next.announced = latest.version;
      try {
        this.onNewRelease?.(latest);
      } catch (err) {
        this.log.warn(`Update notification failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    this.settings.setRaw(CACHE_KEY, next);
    return this.status();
  }

  private api(): string {
    return `https://api.github.com/repos/${this.config.updateRepo}`;
  }

  /** Newest release that is neither a draft nor a prerelease - `edge` is both, by design. */
  private async newestStable(): Promise<{ status: number; body: unknown; etag: string | null }> {
    const res = await this.get(`${this.api()}/releases?per_page=20`);
    if (res.status === 304) return res;
    const list = Array.isArray(res.body) ? (res.body as Record<string, unknown>[]) : [];
    const newest = list.find((r) => r.draft !== true && r.prerelease !== true);
    if (!newest) throw new Error('no published release found');
    return { ...res, body: newest };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'wpl7-panel',
      ...extra,
    };
    if (this.config.updateToken) headers.authorization = `Bearer ${this.config.updateToken}`;
    return headers;
  }

  private async get(url: string): Promise<{ status: number; body: unknown; etag: string | null }> {
    const cache = this.cached();
    // Only worth sending when there is something cached to keep: a 304 with nothing behind
    // it would leave the panel reporting "no update known" and calling it success.
    const extra: Record<string, string> = cache.etag && cache.manifest ? { 'if-none-match': cache.etag } : {};
    const res = await this.request(url, this.headers(extra));
    if (res.status === 304) return { status: 304, body: null, etag: cache.etag };
    return { status: res.status, body: await res.json(), etag: res.headers.get('etag') };
  }

  private async getJson(assetUrl: string): Promise<unknown> {
    // The asset API URL with this Accept, not browser_download_url: this one also works
    // while the repository is private.
    const res = await this.request(assetUrl, this.headers({ accept: 'application/octet-stream' }));
    return JSON.parse(await res.text());
  }

  private async request(url: string, headers: Record<string, string>) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { headers, signal: controller.signal });
      if (res.status === 304 || (res.status >= 200 && res.status < 300)) return res;
      throw rateAwareError(res);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Carries the moment GitHub says the budget is back, so the next tick does not waste one. */
class GitHubError extends Error {
  constructor(
    message: string,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

function rateAwareError(res: { status: number; headers: { get(name: string): string | null } }): GitHubError {
  const remaining = res.headers.get('x-ratelimit-remaining');
  if ((res.status === 403 || res.status === 429) && remaining === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset') ?? '');
    const retryAfter = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + CHECK_INTERVAL_MS;
    return new GitHubError(
      `GitHub rate limit reached (60 requests an hour per address when unauthenticated); ` +
        `next attempt after ${new Date(retryAfter).toISOString()}. Set WPL7_GITHUB_TOKEN to lift it.`,
      retryAfter,
    );
  }
  const retry = Number(res.headers.get('retry-after') ?? '');
  return new GitHubError(
    `GitHub answered ${res.status}`,
    Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : null,
  );
}

const retryAfterFrom = (err: unknown): number | null => (err instanceof GitHubError ? err.retryAfter : null);

function findManifestAsset(release: unknown): string | null {
  const assets = (release as { assets?: { name?: string; url?: string }[] })?.assets ?? [];
  return assets.find((a) => a.name === 'manifest.json')?.url ?? null;
}

function parseManifest(value: unknown): UpdateManifest {
  const m = value as Partial<UpdateManifest>;
  if (!m || typeof m.version !== 'string' || typeof m.images !== 'object' || typeof m.images?.panel !== 'string') {
    throw new Error('the manifest is not in the expected shape');
  }
  return {
    version: m.version,
    channel: m.channel === 'edge' ? 'edge' : 'stable',
    publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : '',
    notesUrl: typeof m.notesUrl === 'string' ? m.notesUrl : '',
    ...(typeof m.gitSha === 'string' ? { gitSha: m.gitSha } : {}),
    images: { panel: m.images.panel, wordpress: m.images.wordpress ?? {} },
    ...(typeof m.minUpgradeFrom === 'string' ? { minUpgradeFrom: m.minUpgradeFrom } : {}),
    requiresDowntime: m.requiresDowntime === true,
  };
}

const toReleaseDto = (m: UpdateManifest): UpdateReleaseDto => ({
  version: m.version,
  channel: m.channel,
  publishedAt: m.publishedAt,
  notesUrl: m.notesUrl,
  requiresDowntime: m.requiresDowntime === true,
  minUpgradeFrom: m.minUpgradeFrom ?? null,
});

/**
 * Is this install behind the release it was offered?
 *
 * On `stable` that is a semver question. On `edge` it is not: every edge build is called
 * `0.3.0-edge.<commit>`, and semver compares those trailing identifiers as strings, which
 * says nothing about which commit came first. The commit itself is the answer - different
 * sha, different build - and the version is only the fallback for a build with no sha
 * (local development, where "behind" is not a useful thing to be told anyway).
 */
export function isBehind(version: string, gitSha: string, latest: UpdateManifest): boolean {
  if (latest.channel === 'edge') {
    if (!latest.gitSha || gitSha === 'unknown') return compareVersions(version, latest.version) < 0;
    return !shaMatches(gitSha, latest.gitSha);
  }
  return compareVersions(version, latest.version) < 0;
}

/** One may be a short sha (a local build) and the other full (CI stamps github.sha). */
const shaMatches = (a: string, b: string): boolean =>
  a.length <= b.length ? b.startsWith(a) : a.startsWith(b);

interface Parsed {
  core: number[];
  pre: string[];
}

function parse(version: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  };
}

/**
 * Semver precedence: -1 if a is older, 0 if equal, 1 if newer.
 *
 * Anything unparseable sorts below everything, which is what makes `dev` - the version
 * provision/build.sh stamps on a hand-built panel - always look behind. That is the honest
 * answer: a local build is not a release, and the panel should say an update exists.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! !== pb.core[i]!) return pa.core[i]! < pb.core[i]! ? -1 : 1;
  }
  // A version with a prerelease tag is older than the release it names: 1.0.0-rc.1 < 1.0.0.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // fewer identifiers wins
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
