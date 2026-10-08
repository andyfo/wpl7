// @docs sites/import
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FileEntry } from './importPull.js';

/** A file the old site listed: its size and modification time (unix seconds) at the time. */
export interface ListedFile {
  s: number;
  m: number;
}

/** The flags of a file the pull lists but cannot read, and so never copies. */
export const NOT_READ = ['unreadable', 'too_large'];

/**
 * The old site's files as the last pull listed them, kept by the panel on its own disk while the
 * import can still be refreshed, with the time the listing began. A refresh copies what changed
 * from that time on, tells a file deleted on the old site since by its absence from the new
 * listing, and removes the copy only while that still has the listed size and time: a file
 * changed on the new copy stays.
 *
 * It says what the copy has: only regular files with a UTF-8 path that the pull could read are
 * written down, and a refresh never removes anything else. What a refresh could not read or list,
 * it keeps the earlier record of (`carry`). One file per import, of gzip members appended page by
 * page: a pull that resumes appends a page again, and the later line wins.
 */
export interface Listing {
  files: Map<string, ListedFile>;
  /** When the listing began, by the old site's clock (unix seconds); null when it was not written down. */
  listedAt: number | null;
}

export class ImportListings {
  constructor(private readonly dir: string) {}

  private file(id: number, which: 'current' | 'next'): string {
    return path.join(this.dir, `${id}${which === 'next' ? '.next' : ''}.files.gz`);
  }

  /** A listing starts over: what was written for it so far is dropped, and when it began is written down. */
  reset(id: number, which: 'current' | 'next' = 'current', listedAt?: number): void {
    fs.rmSync(this.file(id, which), { force: true });
    if (listedAt === undefined) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file(id, which), zlib.gzipSync(`${JSON.stringify({ listedAt })}\n`), { mode: 0o600 });
  }

  append(id: number, entries: FileEntry[], which: 'current' | 'next' = 'current'): void {
    let text = '';
    for (const e of entries) {
      if (e.t === 'f' && !e.pb && !(e.f ?? []).some((f) => NOT_READ.includes(f))) text += `${JSON.stringify([e.p, e.s, e.m])}\n`;
    }
    this.write(id, which, text);
  }

  /** Into a refresh's listing: records of the one before, for files this one could not read or list. */
  carry(id: number, files: Iterable<[string, ListedFile]>): void {
    let text = '';
    for (const [p, f] of files) text += `${JSON.stringify([p, f.s, f.m])}\n`;
    this.write(id, 'next', text);
  }

  private write(id: number, which: 'current' | 'next', text: string): void {
    if (!text) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file(id, which), zlib.gzipSync(text), { mode: 0o600 });
  }

  /** The listing, or null when the panel has none for this import. */
  read(id: number): Listing | null {
    let data: Buffer;
    try {
      data = fs.readFileSync(this.file(id, 'current'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const files = new Map<string, ListedFile>();
    let listedAt: number | null = null;
    for (const line of zlib.gunzipSync(data).toString('utf8').split('\n')) {
      if (!line) continue;
      const parsed = JSON.parse(line) as [string, number, number] | { listedAt: number };
      if (Array.isArray(parsed)) files.set(parsed[0], { s: parsed[1], m: parsed[2] });
      else listedAt = parsed.listedAt;
    }
    return { files, listedAt };
  }

  /** The listing a refresh wrote replaces the one before it. */
  promote(id: number): void {
    const next = this.file(id, 'next');
    if (fs.existsSync(next)) fs.renameSync(next, this.file(id, 'current'));
    else this.reset(id);
  }

  drop(id: number): void {
    this.reset(id, 'current');
    this.reset(id, 'next');
  }

  /** The imports the panel holds a listing for. */
  ids(): number[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const ids = new Set<number>();
    for (const name of names) {
      const m = /^(\d+)(?:\.next)?\.files\.gz$/.exec(name);
      if (m) ids.add(Number(m[1]));
    }
    return [...ids];
  }
}
