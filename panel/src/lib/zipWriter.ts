import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * A zip file, whole in memory: for the few small archives the panel hands out itself, such as an
 * import's migration plugin. Not for anything a site holds - those are zipped on their server
 * (services/siteFilesZip.ts).
 *
 * Entries are deflated unless that saves nothing; names are UTF-8 (general purpose bit 11); a name
 * ending in `/` is a folder. Unix permissions go in the external attributes, which is where
 * `unzip` and PHP's ZipArchive look for them. No zip64: each file and the whole archive have to stay
 * under 4 GiB, which nothing this is for comes near.
 */
export interface ZipEntry {
  name: string;
  data?: Buffer | string;
  /** Unix permission bits; 0644 for a file and 0755 for a folder when left out. */
  mode?: number;
}

/** 1980-01-01 00:00 in MS-DOS date and time fields: fixed, so the same input gives the same bytes. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const LIMIT = 0xffffffff;

export function zipOf(entries: ZipEntry[]): Buffer {
  const files: Buffer[] = [];
  const index: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.split('/').includes('..')) {
      throw new Error(`Not a name for a zip entry: ${JSON.stringify(entry.name)}`);
    }
    if (seen.has(entry.name)) throw new Error(`Twice in one zip: ${entry.name}`);
    seen.add(entry.name);
    const folder = entry.name.endsWith('/');
    const raw = folder ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const deflated = raw.length > 0 ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const crc = zlib.crc32(raw);
    const name = Buffer.from(entry.name, 'utf8');
    if (raw.length > LIMIT || offset + body.length > LIMIT) throw new Error('A zip this big needs zip64');
    const mode = (entry.mode ?? (folder ? 0o755 : 0o644)) | (folder ? 0o040000 : 0o100000);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(((mode << 16) | (folder ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    files.push(local, name, body);
    index.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(index);
  if (entries.length > 0xffff || offset + directory.length > LIMIT) throw new Error('A zip this big needs zip64');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...files, directory, end]);
}

/**
 * A WordPress plugin's folder as the zip a site installs: `<folder>/` and everything under `root`,
 * with `version` written over the placeholder `0.0.0-dev` in its `.php` and `.txt` files, and the
 * `extra` files added. A `connection.php` lying in the folder from testing is never taken: only
 * the one in `extra` goes out.
 */
export function pluginFolderZip(root: string, folder: string, version: string, extra: ZipEntry[] = []): Buffer {
  const entries: ZipEntry[] = [{ name: `${folder}/` }];
  const walk = (dir: string, rel: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = `${rel}${item.name}`;
      if (relPath === 'connection.php') continue;
      if (item.isDirectory()) {
        entries.push({ name: `${folder}/${relPath}/` });
        walk(path.join(dir, item.name), `${relPath}/`);
      } else if (item.isFile()) {
        let data = fs.readFileSync(path.join(dir, item.name));
        if (/\.(php|txt)$/.test(item.name)) data = Buffer.from(data.toString('utf8').replaceAll('0.0.0-dev', version), 'utf8');
        entries.push({ name: `${folder}/${relPath}`, data });
      }
    }
  };
  walk(root, '');
  return zipOf([...entries, ...extra.map((e) => ({ ...e, name: `${folder}/${e.name}` }))]);
}
