import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { plugins, type PluginRow } from '../db/schema.js';
import type { PluginDto, PluginZipCheckDto } from '../../shared/types.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { AppError } from '../lib/errors.js';
import { safeJoin } from '../lib/slug.js';
import { storedZipPluginFolder } from '../lib/pluginZip.js';
import type { WporgDirectory } from './wporg.js';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04

/**
 * The folder a catalog plugin installs into, which is what recipes go by: a wordpress.org
 * plugin's is its slug, an upload's is the folder inside the zip - not the file's name,
 * which is often the vendor's download name with a version number in it.
 */
export function pluginDirOf(row: PluginRow): string | null {
  if (row.kind !== 'zip') return row.slug;
  return row.zipPath ? storedZipPluginFolder(row.zipPath) : null;
}

const toDto = (row: PluginRow, check: PluginZipCheckDto | null = null): PluginDto => ({
  id: row.id,
  kind: row.kind as PluginDto['kind'],
  slug: row.slug,
  name: row.name,
  pluginDir: pluginDirOf(row),
  isDefault: row.isDefault === 1,
  zipPath: row.zipPath,
  createdAt: row.createdAt,
  check: row.kind === 'zip' ? check : null,
});

export class PluginCatalogService {
  constructor(
    private readonly db: Db,
    private readonly pluginsDir: string,
    private readonly wporg: WporgDirectory,
  ) {}

  /** The catalog, each zip with its malware check when `checks` has one (services/pluginZipChecks.ts). */
  list(checks: Map<number, PluginZipCheckDto> = new Map()): PluginDto[] {
    return this.db
      .select()
      .from(plugins)
      .all()
      .map((row) => toDto(row, checks.get(row.id) ?? null));
  }

  byId(id: number): PluginRow {
    const row = this.db.select().from(plugins).where(eq(plugins.id, id)).get();
    if (!row) throw notFound(`Catalog plugin #${id} not found`);
    return row;
  }

  /**
   * Add a wordpress.org plugin. The slug is checked against the directory first - an entry
   * `wp plugin install` could never resolve is worthless, and catching it here beats
   * finding out from a warning buried in a site-create job log. `force` skips the check for
   * panels with no outbound internet access.
   */
  async createWporg(input: {
    slug: string;
    name?: string;
    isDefault: boolean;
    force?: boolean;
  }): Promise<PluginDto> {
    const slug = input.slug.trim().toLowerCase();
    let canonicalName: string | undefined;
    if (!input.force) {
      const found = await this.wporg.info(slug);
      if (!found) {
        throw notFound(
          `"${slug}" is not a plugin on wordpress.org. Search for it by name instead, or ` +
            `pass "force": true to add the slug anyway.`,
        );
      }
      canonicalName = found.name;
    }
    try {
      const row = this.db
        .insert(plugins)
        .values({
          kind: 'wporg',
          slug,
          name: input.name ?? canonicalName ?? slug,
          isDefault: input.isDefault ? 1 : 0,
          createdAt: Date.now(),
        })
        .returning()
        .get();
      return toDto(row);
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint/.test(err.message)) {
        throw conflict(`Plugin "${slug}" is already in the catalog`);
      }
      throw err;
    }
  }

  /**
   * Stream a multipart zip upload to disk: temp file first, magic-byte check on the first
   * chunk, atomic rename into place. Truncated (over-limit) uploads are deleted and rejected.
   */
  async saveZip(
    filename: string,
    fileStream: NodeJS.ReadableStream & { truncated?: boolean },
    opts: { name?: string; isDefault?: boolean },
  ): Promise<PluginDto> {
    const baseName = (opts.name ?? path.basename(filename, '.zip'))
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!baseName) throw badRequest('Could not derive a plugin name from the upload');

    await fsp.mkdir(this.pluginsDir, { recursive: true });
    const tmpPath = path.join(this.pluginsDir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);

    let finalPath: string | null = null;
    let header = Buffer.alloc(0);
    const headerSniffer = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (header.length < 4) header = Buffer.concat([header, chunk]).subarray(0, 4);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(fileStream, headerSniffer, fs.createWriteStream(tmpPath));
      if (fileStream.truncated) {
        throw new AppError('validation_error', 413, 'Zip file exceeds the 100 MB upload limit');
      }
      if (!header.subarray(0, 4).equals(ZIP_MAGIC)) {
        throw badRequest('Upload is not a zip file');
      }
      const finalName = `${baseName}-${crypto.randomBytes(4).toString('hex')}.zip`;
      finalPath = safeJoin(this.pluginsDir, finalName);
      await fsp.rename(tmpPath, finalPath);
      const row = this.db
        .insert(plugins)
        .values({
          kind: 'zip',
          slug: baseName,
          name: opts.name ?? baseName,
          zipPath: finalPath,
          isDefault: opts.isDefault ? 1 : 0,
          createdAt: Date.now(),
        })
        .returning()
        .get();
      return toDto(row);
    } catch (err) {
      // Clean up whichever name the upload currently has, so a rejected upload
      // (duplicate name, bad zip) never leaves an orphaned file behind.
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      if (finalPath) await fsp.rm(finalPath, { force: true }).catch(() => undefined);
      if (err instanceof Error && /UNIQUE constraint/.test(err.message)) {
        throw conflict(`A zip plugin named "${baseName}" already exists; delete it first or pass a different name`);
      }
      throw err;
    }
  }

  update(id: number, patch: { name?: string; isDefault?: boolean }): PluginDto {
    this.byId(id);
    const set: Partial<typeof plugins.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.isDefault !== undefined) set.isDefault = patch.isDefault ? 1 : 0;
    const row = this.db.update(plugins).set(set).where(eq(plugins.id, id)).returning().get();
    return toDto(row);
  }

  async delete(id: number): Promise<void> {
    const row = this.byId(id);
    if (row.kind === 'zip' && row.zipPath) {
      const safe = safeJoin(this.pluginsDir, path.relative(this.pluginsDir, row.zipPath));
      await fsp.rm(safe, { force: true }).catch(() => undefined);
    }
    this.db.delete(plugins).where(eq(plugins.id, id)).run();
  }
}
