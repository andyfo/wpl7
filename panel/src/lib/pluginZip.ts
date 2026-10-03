import fs from 'node:fs';

const END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const ENTRY = 0x02014b50;

/**
 * The names in a zip, from its central directory - the index at the end of the file - so
 * nothing is inflated and a 100 MB plugin costs a read of its last few hundred KB. Null when
 * the file cannot be read or is not a zip.
 */
export function zipEntryNames(file: string): string[] | null {
  return zipEntries(file)?.map((e) => e.name) ?? null;
}

/**
 * The entries of a zip, with what each unpacks to, from its central directory. A size a
 * Zip64 record holds instead is taken as unknown (-1). Null when it is not a zip.
 */
export function zipEntries(file: string): { name: string; size: number }[] | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  const read = (position: number, length: number): Buffer => {
    const buf = Buffer.alloc(length);
    if (fs.readSync(fd, buf, 0, length, position) !== length) throw new Error('short read');
    return buf;
  };
  try {
    const size = fs.fstatSync(fd).size;
    // The end record is 22 bytes, followed by a comment of up to 64 KB.
    const tailStart = Math.max(0, size - 22 - 0xffff);
    const tail = read(tailStart, size - tailStart);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    let count = tail.readUInt16LE(end + 10);
    let dirSize = tail.readUInt32LE(end + 12);
    let dirStart = tail.readUInt32LE(end + 16);
    if (count === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) {
      // Zip64: the end record only says so, and the real numbers are in the record the
      // locator just before it points at.
      const at = tailStart + end - 20;
      if (at < 0) return null;
      const locator = read(at, 20);
      if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) return null;
      const record = read(Number(locator.readBigUInt64LE(8)), 56);
      if (record.readUInt32LE(0) !== ZIP64_END) return null;
      count = Number(record.readBigUInt64LE(32));
      dirSize = Number(record.readBigUInt64LE(40));
      dirStart = Number(record.readBigUInt64LE(48));
    }
    if (dirStart + dirSize > size) return null;
    const dir = read(dirStart, dirSize);
    const entries: { name: string; size: number }[] = [];
    for (let p = 0, n = 0; n < count; n++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== ENTRY) return null;
      const nameLength = dir.readUInt16LE(p + 28);
      if (p + 46 + nameLength > dir.length) return null;
      const size = dir.readUInt32LE(p + 24);
      entries.push({ name: dir.toString('utf8', p + 46, p + 46 + nameLength), size: size === 0xffffffff ? -1 : size });
      p += 46 + nameLength + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    return entries;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The folder WordPress installs a plugin zip into, which is what `wp plugin list` - and so a
 * recipe - calls the plugin: the zip's one top-level folder (WP_Upgrader::install_package).
 * Null when there is no single one - WordPress then names the folder after the zip file,
 * which the panel's stored copy suffixes at random - or the zip cannot be read.
 */
export function zipPluginFolder(file: string): string | null {
  const names = zipEntryNames(file);
  if (!names) return null;
  const top = new Set<string>();
  let folder = false;
  for (const name of names) {
    // WordPress does not extract what macOS's Archive Utility adds (unzip_file) - judged by
    // the name as stored, so a `./__MACOSX/` folder is extracted like any other.
    if (name.startsWith('__MACOSX/')) continue;
    // It writes each entry under its unzip folder by that name, so `./breakdance/x.php` and
    // `/breakdance/x.php` land in breakdance/ as well. A name that climbs out with `..` is
    // refused by validate_file and never lands anywhere.
    const parts = name.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.length === 0 || parts.includes('..')) continue;
    top.add(parts[0]!);
    if (parts.length > 1 || name.endsWith('/')) folder = true;
  }
  const [only] = top;
  return top.size === 1 && folder && only ? only : null;
}

const folders = new Map<string, string>();

/**
 * zipPluginFolder, remembered: the panel never rewrites a stored zip (its name carries a
 * random suffix), so a path always holds the same plugin. Only a found folder is kept, so a
 * zip that could not be read is tried again next time.
 */
export function storedZipPluginFolder(file: string): string | null {
  const known = folders.get(file);
  if (known !== undefined) return known;
  const folder = zipPluginFolder(file);
  if (folder !== null) folders.set(file, folder);
  return folder;
}
