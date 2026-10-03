import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { integrityManifests, type IntegrityManifestRow } from '../db/schema.js';
import type { Logger } from './index.js';

/**
 * wordpress.org's published checksums, for WordPress itself and for the plugins in its
 * directory. The panel fetches them and hands them to a scan, which runs with no network at
 * all (services/scanEngines.ts).
 *
 * A release never changes, so a list is kept for as long as anybody runs that version.
 * "Nothing published" - a premium plugin, a version not indexed yet - is asked again after a
 * day, a failed request after an hour. Themes have no published checksums.
 */

/** Path relative to the package's own folder -> every hash that file may have. */
export interface Manifest {
  hashType: 'md5' | 'sha256';
  files: Record<string, string[]>;
}

export type ManifestLookup = { state: 'ok'; manifest: Manifest } | { state: 'none' } | { state: 'error'; error: string };

const CORE_URL = 'https://api.wordpress.org/core/checksums/1.0/';
const PLUGIN_URL = 'https://downloads.wordpress.org/plugin-checksums';
const TIMEOUT_MS = 15_000;
const NONE_TTL_MS = 24 * 3600_000;
const ERROR_TTL_MS = 3600_000;

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const LOCALE_RE = /^[a-z]{2,3}(?:_[A-Z]{2})?(?:_[a-z0-9]+)?$/;

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

export class IntegrityManifests {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  /** WordPress's own files for a version and locale; the en_US list when the locale has none. */
  async core(version: string, locale: string | null): Promise<ManifestLookup> {
    if (!VERSION_RE.test(version)) return { state: 'none' };
    const wanted = locale && LOCALE_RE.test(locale) ? locale : 'en_US';
    const lookup = await this.cached(`core:${version}:${wanted}`, { kind: 'core', slug: 'wordpress', version, locale: wanted }, () =>
      this.fetchCore(version, wanted),
    );
    if (lookup.state === 'none' && wanted !== 'en_US') return this.core(version, 'en_US');
    return lookup;
  }

  /** A plugin from the wordpress.org directory, at one version. */
  async plugin(slug: string, version: string): Promise<ManifestLookup> {
    if (!SLUG_RE.test(slug) || !VERSION_RE.test(version)) return { state: 'none' };
    return this.cached(`plugin:${slug}:${version}`, { kind: 'plugin', slug, version, locale: null }, () =>
      this.fetchPlugin(slug, version),
    );
  }

  private async cached(
    key: string,
    what: Pick<IntegrityManifestRow, 'kind' | 'slug' | 'version' | 'locale'>,
    fetchIt: () => Promise<ManifestLookup>,
  ): Promise<ManifestLookup> {
    const row = this.db.select().from(integrityManifests).where(eq(integrityManifests.key, key)).get();
    const now = this.now();
    if (row) {
      const fresh =
        row.status === 'ok' ||
        (row.status === 'none' && now - row.fetchedAt < NONE_TTL_MS) ||
        (row.status === 'error' && now - row.fetchedAt < ERROR_TTL_MS);
      if (fresh) return fromRow(row);
    }
    const lookup = await fetchIt();
    const values = {
      ...what,
      status: lookup.state,
      files: lookup.state === 'ok' ? JSON.stringify(lookup.manifest.files) : null,
      hashType: lookup.state === 'ok' ? lookup.manifest.hashType : null,
      fetchedAt: now,
      error: lookup.state === 'error' ? lookup.error.slice(0, 300) : null,
    };
    this.db
      .insert(integrityManifests)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: integrityManifests.key, set: values })
      .run();
    if (lookup.state === 'error') this.log.warn(`Checksums for ${key} could not be fetched: ${lookup.error}`);
    return lookup;
  }

  private async get(url: string): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'WPL7 panel (integrity check)' },
    });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: res.status, body: await res.json() };
  }

  private async fetchCore(version: string, locale: string): Promise<ManifestLookup> {
    try {
      const url = `${CORE_URL}?version=${encodeURIComponent(version)}&locale=${encodeURIComponent(locale)}`;
      const { body } = await this.get(url);
      const checksums = (body as { checksums?: unknown } | null)?.checksums;
      if (!checksums || typeof checksums !== 'object') return { state: 'none' };
      const files: Record<string, string[]> = {};
      for (const [file, hash] of Object.entries(checksums as Record<string, unknown>)) {
        const hashes = hashList(hash, 32);
        if (hashes.length > 0 && isRelativePath(file)) files[file] = hashes;
      }
      return Object.keys(files).length > 0 ? { state: 'ok', manifest: { hashType: 'md5', files } } : { state: 'none' };
    } catch (err) {
      return { state: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchPlugin(slug: string, version: string): Promise<ManifestLookup> {
    try {
      const { status, body } = await this.get(`${PLUGIN_URL}/${encodeURIComponent(slug)}/${encodeURIComponent(version)}.json`);
      if (status === 404) return { state: 'none' };
      const listed = (body as { files?: unknown } | null)?.files;
      if (!listed || typeof listed !== 'object') return { state: 'none' };
      const files: Record<string, string[]> = {};
      for (const [file, entry] of Object.entries(listed as Record<string, unknown>)) {
        const hashes = hashList((entry as { sha256?: unknown } | null)?.sha256, 64);
        if (hashes.length > 0 && isRelativePath(file)) files[file] = hashes;
      }
      return Object.keys(files).length > 0 ? { state: 'ok', manifest: { hashType: 'sha256', files } } : { state: 'none' };
    } catch (err) {
      return { state: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function fromRow(row: IntegrityManifestRow): ManifestLookup {
  if (row.status === 'ok' && row.files) {
    return { state: 'ok', manifest: { hashType: row.hashType === 'sha256' ? 'sha256' : 'md5', files: JSON.parse(row.files) as Record<string, string[]> } };
  }
  if (row.status === 'error') return { state: 'error', error: row.error ?? 'unknown error' };
  return { state: 'none' };
}

/** One hash or a list of them (a file rebuilt between two zips of one release), lower case. */
function hashList(value: unknown, length: number): string[] {
  const all = Array.isArray(value) ? value : [value];
  const re = new RegExp(`^[0-9a-f]{${length}}$`);
  return all.filter((h): h is string => typeof h === 'string' && re.test(h.toLowerCase())).map((h) => h.toLowerCase());
}

/** What goes into a scan's input must never point outside the package it describes. */
function isRelativePath(file: string): boolean {
  return file.length > 0 && file.length <= 1024 && !file.startsWith('/') && !file.split('/').includes('..') && !file.includes('\0');
}
