/**
 * The files the panel writes into a site's WordPress folder - its one-click login and its
 * plugin-license constants, both must-use plugins - and what it wrote them with. A malware scan
 * holds each to those hashes (scanScripts.ts): the same file is the panel's own and never a
 * finding, whatever a signature thinks of it; a changed one is "WPL7 file changed", which the
 * Findings card puts back.
 */
// @docs security/malware-scans
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sitePanelFiles } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { MU_PLUGIN_PATH, MU_PLUGIN_SOURCE } from './adminLogin.js';

/** Hashes kept per file: enough for the copies older backups bring back. */
const KEEP = 20;

export class PanelFiles {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** The panel put `content` at `path` in the site, or found it there already. */
  wrote(siteId: number, path: string, content: string): void {
    const at = this.now();
    this.db
      .insert(sitePanelFiles)
      .values({ siteId, path, sha256: sha256Hex(content), writtenAt: at })
      .onConflictDoUpdate({ target: [sitePanelFiles.siteId, sitePanelFiles.path, sitePanelFiles.sha256], set: { writtenAt: at } })
      .run();
    const old = this.db
      .select({ sha256: sitePanelFiles.sha256 })
      .from(sitePanelFiles)
      .where(and(eq(sitePanelFiles.siteId, siteId), eq(sitePanelFiles.path, path)))
      .orderBy(desc(sitePanelFiles.writtenAt))
      .all()
      .slice(KEEP);
    for (const { sha256 } of old) {
      this.db
        .delete(sitePanelFiles)
        .where(and(eq(sitePanelFiles.siteId, siteId), eq(sitePanelFiles.path, path), eq(sitePanelFiles.sha256, sha256)))
        .run();
    }
  }

  /**
   * Every hash each of the site's panel files may have: what the panel wrote there, and the
   * login drop-in as this version writes it - the same on every site, so a site that has it
   * from before anything was recorded is held to it too.
   */
  expected(siteId: number): Record<string, string[]> {
    const out: Record<string, string[]> = { [MU_PLUGIN_PATH]: [sha256Hex(MU_PLUGIN_SOURCE)] };
    for (const row of this.db.select().from(sitePanelFiles).where(eq(sitePanelFiles.siteId, siteId)).all()) {
      const list = (out[row.path] ??= []);
      if (!list.includes(row.sha256)) list.push(row.sha256);
    }
    return out;
  }
}
