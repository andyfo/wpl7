// @docs plugins/recipes, reference/recipe-format, security/privacy
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { catalogEntries, installedRecipes } from '../db/schema.js';
import type { Config } from '../config.js';
import { catalogIndex, catalogSignature, knownCatalogTypes } from '../../shared/recipes.js';
import type { CatalogStateDto } from '../../shared/types.js';
import type { RecipeCatalog } from './catalog.js';
import type { Logger } from './index.js';
import type { SettingsService } from './settings.js';

const TIMEOUT_MS = 15_000;
const USER_AGENT = 'wpl7-panel';

/** Persisted alongside the entries, in the settings table (state, not settings: never listed). */
const KEYS = {
  etag: 'catalog.etag',
  fetchedAt: 'catalog.fetchedAt',
  changedAt: 'catalog.changedAt',
  generatedAt: 'catalog.generatedAt',
  commit: 'catalog.commit',
  unsupported: 'catalog.unsupported',
  error: 'catalog.error',
  keyId: 'catalog.keyId',
} as const;

export type RefreshOutcome = 'updated' | 'unchanged' | 'failed' | 'disabled';

/**
 * The public catalog, fetched hourly: verify the signature, keep the copy, rebuild the
 * recipes in use. Every failure - unreachable host, a signature that does not verify, an
 * index that does not parse - leaves the previous copy in place and is shown on the
 * Recipes page; nothing a fetch does can take a recipe away from a running panel except
 * a newer verified index that no longer carries it.
 *
 * What leaves the box: one conditional GET of the index and one of its signature, per
 * hour, from the panel. No site data is part of either.
 */
export class CatalogSyncService {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private inFlight: Promise<RefreshOutcome> | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: SettingsService,
    private readonly catalog: RecipeCatalog,
    private readonly log: Logger,
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  get enabled(): boolean {
    return this.config.catalog.url !== null;
  }

  /** Local recipes, the last verified catalog copy, the bundled files - what the panel boots with. */
  rebuild(): void {
    const remote = this.enabled
      ? this.db
          .select()
          .from(catalogEntries)
          .all()
          .map((row) => JSON.parse(row.payload) as unknown)
      : [];
    const local = this.db
      .select()
      .from(installedRecipes)
      .where(eq(installedRecipes.source, 'local'))
      .all()
      .flatMap((row) => (row.payload ? [JSON.parse(row.payload) as unknown] : []));
    this.catalog.load({ bundledDir: this.config.catalogDir, remote, local });
  }

  state(): CatalogStateDto {
    const str = (k: string): string | null => {
      const v = this.settings.getRaw(k);
      return typeof v === 'string' ? v : null;
    };
    const num = (k: string): number | null => {
      const v = this.settings.getRaw(k);
      return typeof v === 'number' ? v : null;
    };
    const entries = this.enabled ? this.db.select({ id: catalogEntries.id }).from(catalogEntries).all().length : 0;
    return {
      url: this.config.catalog.url,
      entries,
      unsupported: this.enabled ? (num(KEYS.unsupported) ?? 0) : 0,
      generatedAt: str(KEYS.generatedAt),
      commit: str(KEYS.commit),
      fetchedAt: num(KEYS.fetchedAt),
      changedAt: num(KEYS.changedAt),
      error: this.enabled ? str(KEYS.error) : null,
      keyId: str(KEYS.keyId),
      recipes: this.catalog.counts(),
    };
  }

  /** Fetch, verify and apply. Concurrent calls share one run. */
  refresh(opts: { force?: boolean } = {}): Promise<RefreshOutcome> {
    if (!this.inFlight) {
      this.inFlight = this.doRefresh(opts).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doRefresh(opts: { force?: boolean }): Promise<RefreshOutcome> {
    const url = this.config.catalog.url;
    if (!url) return 'disabled';
    try {
      const outcome = await this.fetchAndApply(url, opts.force ?? false);
      this.settings.setRaw(KEYS.error, null);
      this.settings.setRaw(KEYS.fetchedAt, Date.now());
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.settings.setRaw(KEYS.error, message);
      this.log.warn(`Catalog: ${message} - keeping the previous copy`);
      return 'failed';
    }
  }

  private async fetchAndApply(url: string, force: boolean): Promise<RefreshOutcome> {
    const etag = this.settings.getRaw(KEYS.etag);
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT };
    if (!force && typeof etag === 'string' && etag) headers['if-none-match'] = etag;
    const res = await this.get(url, headers);
    if (res.status === 304) return 'unchanged';
    if (!res.ok) throw new Error(`the catalog answered HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    // The signature is over the exact bytes of the index; verified before a single byte of
    // it is parsed, so a mirror, a CDN hiccup or a compromised host cannot feed a panel
    // anything the maintainers' key did not sign.
    const sigRes = await this.get(`${url}.sig`, { accept: 'application/json', 'user-agent': USER_AGENT });
    if (!sigRes.ok) throw new Error(`the catalog's signature answered HTTP ${sigRes.status}`);
    const sigParsed = catalogSignature.safeParse(await sigRes.json().catch(() => null));
    if (!sigParsed.success) throw new Error('the catalog signature file is not in the expected format');
    const sig = sigParsed.data;
    let publicKey: crypto.KeyObject;
    try {
      publicKey = crypto.createPublicKey(this.config.catalog.publicKeyPem);
    } catch {
      throw new Error('WPL7_CATALOG_PUBLIC_KEY is not a valid PEM public key');
    }
    let verified = false;
    try {
      verified = crypto.verify(null, bytes, publicKey, Buffer.from(sig.signature, 'base64'));
    } catch {
      verified = false;
    }
    if (!verified) throw new Error(`the catalog signature does not verify (signed with key ${sig.keyId}, expecting the panel's)`);

    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('the catalog index is not valid JSON');
    }
    const index = catalogIndex.safeParse(json);
    if (!index.success) throw new Error('the catalog index is not in the expected format (a newer index format than this panel reads?)');

    // Store every entry with an id; the recipe loader decides what it can use. Counting
    // the ones of a type this version does not know is what the Recipes page turns into
    // "N entries need a newer panel".
    const rows: { id: string; type: string; typeVersion: number; payload: string; hash: string }[] = [];
    let unsupported = 0;
    for (const raw of index.data.entries) {
      if (typeof raw !== 'object' || raw === null) continue;
      const e = raw as { id?: unknown; type?: unknown; typeVersion?: unknown };
      if (typeof e.id !== 'string' || typeof e.type !== 'string') continue;
      if (!(knownCatalogTypes as readonly string[]).includes(e.type) || e.typeVersion !== 1) unsupported++;
      const payload = JSON.stringify(raw);
      rows.push({
        id: e.id,
        type: e.type,
        typeVersion: typeof e.typeVersion === 'number' ? e.typeVersion : 0,
        payload,
        hash: crypto.createHash('sha256').update(payload).digest('hex'),
      });
    }

    const before = new Map(
      this.db
        .select({ id: catalogEntries.id, hash: catalogEntries.hash, changedAt: catalogEntries.changedAt })
        .from(catalogEntries)
        .all()
        .map((r) => [r.id, r]),
    );
    const changed = rows.filter((r) => before.get(r.id)?.hash !== r.hash).map((r) => r.id);
    const removed = [...before.keys()].filter((id) => !rows.some((r) => r.id === id));
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.delete(catalogEntries).run();
      for (const row of rows) {
        const prev = before.get(row.id);
        const changedAt = prev && prev.hash === row.hash ? (prev.changedAt ?? now) : now;
        tx.insert(catalogEntries).values({ ...row, fetchedAt: now, changedAt }).run();
      }
    });
    const newEtag = res.headers.get('etag');
    this.settings.setRaw(KEYS.etag, newEtag ?? null);
    this.settings.setRaw(KEYS.generatedAt, index.data.generatedAt);
    this.settings.setRaw(KEYS.commit, index.data.commit ?? null);
    this.settings.setRaw(KEYS.unsupported, unsupported);
    this.settings.setRaw(KEYS.keyId, sig.keyId);

    if (changed.length === 0 && removed.length === 0) return 'unchanged';
    this.settings.setRaw(KEYS.changedAt, now);
    this.log.info(
      `Catalog updated (${index.data.generatedAt}${index.data.commit ? `, ${index.data.commit.slice(0, 7)}` : ''}): ` +
        `${rows.length} entries` +
        (changed.length ? `, changed: ${changed.join(', ')}` : '') +
        (removed.length ? `, removed: ${removed.join(', ')}` : '') +
        (unsupported ? `, ${unsupported} need a newer panel` : ''),
    );
    this.rebuild();
    return 'updated';
  }

  private async get(url: string, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
    } catch (err) {
      throw new Error(`could not reach the catalog (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
