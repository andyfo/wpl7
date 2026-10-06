// @docs integrations/api
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { apiKeys, type ApiKeyRow } from '../db/schema.js';
import type { ApiKeyDto } from '../../shared/types.js';
import { isAccessLevel, type AccessLevel } from '../../shared/access.js';
import { generateApiKey, isApiKeyToken, sha256Hex } from '../lib/crypto.js';

/** Who a key is, as the auth gate and the activity log need it. */
export interface VerifiedKey {
  id: number;
  name: string;
  prefix: string;
  access: AccessLevel;
}

/** A value the column should never hold counts as the least it could mean. */
const accessOf = (row: ApiKeyRow): AccessLevel => (isAccessLevel(row.access) ? row.access : 'read');

const toDto = (row: ApiKeyRow, requests24h = 0): ApiKeyDto => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  access: accessOf(row),
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  requests24h,
});

export class ApiKeysService {
  private lastUsedWrites = new Map<number, number>();

  constructor(private readonly db: Db) {}

  /** `counts` comes from the activity log, so the list can say which keys are actually in use. */
  list(counts: Map<number, number> = new Map()): ApiKeyDto[] {
    return this.db
      .select()
      .from(apiKeys)
      .all()
      .filter((r) => r.revokedAt === null)
      .map((row) => toDto(row, counts.get(row.id) ?? 0));
  }

  create(name: string, access: AccessLevel = 'full'): ApiKeyDto & { token: string } {
    const { token, hash, prefix } = generateApiKey();
    const row = this.db
      .insert(apiKeys)
      .values({ name, tokenHash: hash, prefix, access, createdAt: Date.now() })
      .returning()
      .get();
    return { ...toDto(row), token };
  }

  revoke(id: number): boolean {
    const updated = this.db
      .update(apiKeys)
      .set({ revokedAt: Date.now() })
      .where(eq(apiKeys.id, id))
      .returning({ id: apiKeys.id })
      .all();
    return updated.length > 0;
  }

  /**
   * O(1) lookup by hash; last_used writes throttled to once a minute per key.
   *
   * Returns who the caller is rather than a yes/no: the activity log names the key behind
   * every request, and a rejected token has to be distinguishable from an accepted one.
   */
  verify(token: string): VerifiedKey | null {
    if (!isApiKeyToken(token)) return null;
    const row = this.db.select().from(apiKeys).where(eq(apiKeys.tokenHash, sha256Hex(token))).get();
    if (!row || row.revokedAt !== null) return null;
    const last = this.lastUsedWrites.get(row.id) ?? 0;
    if (Date.now() - last > 60_000) {
      this.lastUsedWrites.set(row.id, Date.now());
      this.db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, row.id)).run();
    }
    return { id: row.id, name: row.name, prefix: row.prefix, access: accessOf(row) };
  }
}
