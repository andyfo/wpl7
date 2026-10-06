// @docs plugins/catalog
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { plugins } from '../db/schema.js';
import type { Config } from '../config.js';
import { LocalFiles } from '../lib/files.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';

const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

/**
 * Catalog plugin zips live on the panel host (/srv/plugins) and are bind-mounted
 * read-only into every site container at the identical path - so every server needs
 * a copy of every zip. Push on server-add and on upload; ensure lazily before installs.
 */
export class PluginSyncService {
  private readonly localFiles = new LocalFiles();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
  ) {}

  private zipRows(): { zipPath: string }[] {
    return this.db
      .select({ zipPath: plugins.zipPath })
      .from(plugins)
      .where(eq(plugins.kind, 'zip'))
      .all()
      .filter((r): r is { zipPath: string } => !!r.zipPath);
  }

  /** Push all catalog zips missing (or stale) on a server. */
  async syncAllToServer(serverId: number, log: (msg: string) => void): Promise<{ pushed: number; skipped: number }> {
    const handle = this.servers.handleFor(serverId);
    if (handle.kind === 'local') return { pushed: 0, skipped: 0 };
    let pushed = 0;
    let skipped = 0;
    await handle.files.mkdirp(this.config.paths.plugins);
    for (const { zipPath } of this.zipRows()) {
      if (!fs.existsSync(zipPath)) {
        log(`skipping ${path.basename(zipPath)} - missing on the panel host`);
        continue;
      }
      if (await this.upToDate(handle, zipPath)) {
        skipped++;
        continue;
      }
      log(`pushing ${path.basename(zipPath)}…`);
      await this.push(handle, zipPath);
      pushed++;
    }
    return { pushed, skipped };
  }

  /** Guarantee one zip exists on the site's server before `wp plugin install <zip>`. */
  async ensureZipOnServer(handle: ServerHandle, zipPath: string): Promise<void> {
    if (handle.kind === 'local') return;
    if (!fs.existsSync(zipPath)) throw new Error(`Plugin zip ${zipPath} is missing on the panel host`);
    if (await this.upToDate(handle, zipPath)) return;
    await handle.files.mkdirp(this.config.paths.plugins);
    await this.push(handle, zipPath);
  }

  /** Best-effort push of one zip to every reachable ssh server (after upload). */
  async pushToAll(zipPath: string, log: (msg: string) => void): Promise<void> {
    for (const row of this.servers.listRows()) {
      if (row.kind === 'local') continue;
      try {
        await this.ensureZipOnServer(this.servers.handleFor(row.id), zipPath);
      } catch (err) {
        log(`plugin sync to "${row.name}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async upToDate(handle: ServerHandle, zipPath: string): Promise<boolean> {
    if (!(await handle.files.exists(zipPath).catch(() => false))) return false;
    const [localSha, remoteSha] = await Promise.all([
      this.localFiles.sha256(zipPath),
      handle.files.sha256(zipPath).catch(() => null),
    ]);
    return remoteSha === localSha;
  }

  private async push(handle: ServerHandle, zipPath: string): Promise<void> {
    const tmp = `${zipPath}.tmp-sync`;
    const res = await handle.exec.runWithInput(
      'sh',
      ['-c', `cat > ${q(tmp)} && mv ${q(tmp)} ${q(zipPath)}`],
      fs.createReadStream(zipPath),
      { timeoutMs: 10 * 60_000 },
    );
    if (res.exitCode !== 0) {
      throw new Error(`push of ${path.basename(zipPath)} failed (exit ${res.exitCode}): ${res.stderr.slice(0, 300)}`);
    }
  }
}
