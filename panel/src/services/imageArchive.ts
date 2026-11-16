/**
 * A `docker save` archive, read and written anew before it is loaded (services/appImages.ts).
 *
 * A load hands every name an archive carries to the image in it, and takes the name from whatever
 * had it, without a refusal: the classic image store says "renaming the old one ... to empty
 * string" and goes on, containerd's says nothing (test/engine/containerImages.test.ts, item 9). An
 * archive named like the site image or like Traefik's would become what the next container made by
 * that name runs, and one named like an image a server does not have yet would wait for it. So no
 * name of the archive's own ever reaches a daemon: every one is replaced by the panel's own name
 * for the upload.
 *
 * The names are in up to three places, and the two stores read different ones: `manifest.json`
 * (RepoTags; what the classic store goes by when they disagree), `index.json` (the
 * `io.containerd.image.name` and `org.opencontainers.image.ref.name` annotations; containerd's), and
 * `repositories` (the old format). The first two are written anew with only the fields a load
 * reads, as Go's JSON reader would take a `repotags` beside `RepoTags`; the third is dropped.
 *
 * The daemon never reads the upload itself. Pass 1 reads its headers as Go's archive/tar does (both
 * stores read archives with it); pass 2 writes each entry with a plain ustar header of the panel's
 * own, then a file's data bytes. No header block, PAX record or GNU long name of the upload's goes
 * on, so what pass 1 found is what the daemon reads. Pass 1 refuses what a reader could take
 * another way: an entry that is not a file, a folder or a symbolic link; a folder or link with a
 * size (Go gives it no data, so the size would hide what follows); a name that is not plain, or
 * comes twice; an extended header twice for one entry, or a PAX name beside a GNU one; a link that
 * is not a plain way to a file in the archive, or has entries under it (the classic store unpacks
 * the archive into a folder, and would write through it).
 */
// @docs sites/container
import fs from 'node:fs';
import { Readable } from 'node:stream';

const BLOCK = 512;
/** The files that carry names. Anything bigger than this is no `docker save` index. */
const NAME_FILES = ['manifest.json', 'index.json', 'repositories'] as const;
const MAX_NAME_FILE = 1024 * 1024;
/** The files at the root a load reads by name: each a plain file, once. `oci-layout` names nothing, and is copied. */
const ROOT_FILES: readonly string[] = [...NAME_FILES, 'oci-layout'];
/** `docker save` writes a few entries a layer, and an archive of more than one image is refused anyway. */
const MAX_ENTRIES = 10_000;
/** A PAX header or a GNU long name: a name and a size take far less. */
const MAX_META = 64 * 1024;
/** One part of a name: what `docker save`, podman and skopeo write, and nothing a reader could take another way. */
const NAME_PART = /^[A-Za-z0-9._@:+=,~-]+$/;
/** How much of a file pass 2 reads at a time. */
const CHUNK = 1024 * 1024;

/** What a refused entry is, for its message. */
const TYPE_NAMES: Record<string, string> = {
  '1': 'a hard link',
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a FIFO',
  '7': 'a contiguous file',
  S: 'a sparse file',
};

export interface ArchiveEntry {
  /** Its name, checked plain: no `./` before it, no `/` after a folder's, every part a plain one. */
  name: string;
  /** '0' a file, '5' a folder, '2' a symbolic link: all an archive may hold. */
  type: '0' | '5' | '2';
  /** A file's size; 0 for a folder or a link. */
  size: number;
  /** Where a file's data starts in the upload. */
  dataStart: number;
  /** A link's target, as the archive gives it: a plain way, of 100 bytes at most. '' for the others. */
  link: string;
}

/** One image in `manifest.json`, with the fields a load reads. */
export interface ManifestItem {
  Config: string;
  RepoTags?: string[] | null;
  Layers?: string[] | null;
}

/** One image in `index.json`. Only the fields kept are named. */
export interface IndexDescriptor {
  mediaType?: unknown;
  digest?: unknown;
  size?: unknown;
  platform?: unknown;
  annotations?: Record<string, string> | null;
}

export interface ArchiveInfo {
  entries: ArchiveEntry[];
  /** How many images the archive holds, by the most either index says. */
  images: number;
  /** Every name it carries, as a daemon would list it (`x:1`, not `docker.io/library/x:1`). */
  names: string[];
  /** Why it cannot be loaded as it is; null when it can. */
  problem: string | null;
  /** The parsed name files, null when absent. */
  manifest: ManifestItem[] | null;
  index: { schemaVersion?: unknown; mediaType?: unknown; manifests: IndexDescriptor[] } | null;
  /** Byte offset where the archive's end blocks start. */
  dataEnd: number;
}

/** `docker.io/library/x:1` and `x:1` are one name. */
export const normalImageName = (name: string): string => name.replace(/^docker\.io\/library\//, '').replace(/^docker\.io\//, '');

/** A string field, up to its first NUL as Go reads it. Latin-1 by default, so a byte is a character. */
function cstring(buf: Buffer, start: number, length: number, encoding: BufferEncoding = 'latin1'): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString(encoding);
}

/** An octal field as Go reads it: NULs and spaces trimmed off both ends, then up to a NUL. Null where Go's reader fails. */
function octal(field: Buffer): number | null {
  let text = field.toString('latin1').replace(/^[ \0]+|[ \0]+$/g, '');
  const nul = text.indexOf('\0');
  if (nul !== -1) text = text.slice(0, nul);
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) return null;
  const value = parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : null;
}

/** A numeric field: base-256 when its high bit is set (sizes of 8 GiB and more), else octal. Null where Go's reader fails, or for a negative one. */
function numeric(field: Buffer): number | null {
  if (!(field[0]! & 0x80)) return octal(field);
  if (field[0] !== 0x80) return null;
  let value = 0;
  for (let i = 1; i < field.length; i++) {
    value = value * 256 + field[i]!;
    if (value > Number.MAX_SAFE_INTEGER) return null;
  }
  return value;
}

/** Go takes a header whose checksum is the sum of its bytes, unsigned or signed, with the field itself as spaces. */
function checksumOk(block: Buffer): boolean {
  const stored = octal(block.subarray(148, 156));
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i]!;
    unsigned += b;
    signed += b < 0x80 ? b : b - 256;
  }
  return stored !== null && (stored === unsigned || stored === signed);
}

/** PAX records, `<length> key=value\n` each, as Go reads them. Null for a header Go's reader refuses. */
function paxRecords(data: Buffer, encoding: BufferEncoding = 'latin1'): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < data.length; ) {
    const space = data.indexOf(0x20, i);
    if (space === -1) return null;
    const digits = data.toString('latin1', i, space);
    const end = i + Number(digits);
    if (!/^[0-9]+$/.test(digits) || end - i < 5 || end > data.length || end - 1 <= space || data[end - 1] !== 0x0a) return null;
    const eq = data.indexOf(0x3d, space + 1);
    if (eq === -1 || eq === space + 1 || eq >= end - 1) return null;
    const key = data.toString('latin1', space + 1, eq);
    const value = data.toString(encoding, eq + 1, end - 1);
    if (['path', 'linkpath', 'uname', 'gname'].includes(key) ? value.includes('\0') : key.includes('\0')) return null;
    out[key] = value;
    i = end;
  }
  return out;
}

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;

async function readAt(fd: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** A name from the upload, quoted and cut short, for a message. */
const shown = (name: string) => JSON.stringify(name.length > 100 ? `${name.slice(0, 100)}…` : name);

/** The name a header gives, with its prefix field as Go joins it on. Null for a GNU one Go would read a prefix from after all. */
function headerName(block: Buffer): string | null {
  const plain = cstring(block, 0, 100);
  const magic = block.toString('latin1', 257, 263);
  let prefix = '';
  if (magic === 'ustar\0') {
    // POSIX's prefix field; star's archives keep two times in its tail.
    prefix = cstring(block, 345, block.toString('latin1', 508, 512) === 'tar\0' ? 131 : 155);
  } else if (magic === 'ustar ' && block.toString('latin1', 263, 265) === ' \0') {
    // GNU's has none, but Go reads one where its times do not read, as old Go wrote them there.
    const unreadable = (field: Buffer) => field[0] !== 0 && numeric(field) === null;
    if (unreadable(block.subarray(345, 357)) || unreadable(block.subarray(357, 369))) return null;
  }
  return prefix ? `${prefix}/${plain}` : plain;
}

/** A name as a ustar header holds it: whole, or split at a `/` as Go's writer splits it (prefix up to 155 bytes, name up to 100). Null when it does not fit. */
function ustarName(full: string): { prefix: string; name: string } | null {
  if (full.length <= 100) return { prefix: '', name: full };
  let length = full.length;
  if (length > 156) length = 156;
  else if (full.endsWith('/')) length--;
  const at = full.lastIndexOf('/', length - 1);
  const rest = full.length - at - 1;
  if (at <= 0 || at > 155 || rest === 0 || rest > 100) return null;
  return { prefix: full.slice(0, at), name: full.slice(at + 1) };
}

/** The name an entry goes by, checked plain; '' for the archive's own root (`./`). */
function plainName(raw: string, folder: boolean): { name: string } | { problem: string } {
  const refused = (why: string) => ({ problem: `The archive's ${shown(raw)} ${why}.` });
  // Readers clean names up, each its own way: only a name with nothing to clean is one name to all of them.
  if (raw.startsWith('/')) return refused('starts with "/": names in an image archive are relative');
  let name = raw;
  while (name.startsWith('./')) name = name.slice(2);
  // Before a folder's last "/" goes: ".//" is "./" and an empty part, not the root.
  if (name === '' || name === '.') return { name: '' };
  if (folder && name.endsWith('/')) name = name.slice(0, -1);
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return refused('has an empty, "." or ".." part');
  if (!parts.every((part) => NAME_PART.test(part))) return refused('has a character other than letters, digits and ._@:+=,~-');
  if (!ustarName(folder ? `${name}/` : name)) return refused('is too long for a plain tar header');
  // Kept as a copy: a slice keeps the whole string it was cut from, and a PAX path or GNU long name
  // can be 64 KiB of "./" in front of a short name. The name is ASCII by now.
  return { name: Buffer.from(name, 'latin1').toString('latin1') };
}

/** Where a link points from the archive's root: up from its folder first, then down, nothing else. Null when it leaves the archive or is not that plain. */
function linkTarget(name: string, target: string): string | null {
  if (target === '' || target.startsWith('/')) return null;
  const at = name.split('/').slice(0, -1);
  let up = true;
  for (const part of target.split('/')) {
    if (up && part === '..') {
      if (at.length === 0) return null;
      at.pop();
      continue;
    }
    up = false;
    if (part === '' || part === '.' || part === '..' || !NAME_PART.test(part)) return null;
    at.push(part);
  }
  return at.length > 0 ? at.join('/') : null;
}

/**
 * Why the entries are no plain tree: one under a file or a link, or a link whose target is not a
 * file in the archive (the walk has refused one that is no plain way). `docker save` before
 * Docker 25, podman and skopeo write `<id>/layer.tar` links to the layer itself: those pass.
 */
function treeProblem(entries: ArchiveEntry[], byName: Map<string, ArchiveEntry>): string | null {
  for (const entry of entries) {
    for (let at = entry.name.indexOf('/'); at !== -1; at = entry.name.indexOf('/', at + 1)) {
      const above = byName.get(entry.name.slice(0, at));
      if (above?.type === '2') return `The archive's ${entry.name} is under the link ${above.name}: a load that unpacks the archive would write through it.`;
      if (above?.type === '0') return `The archive's ${entry.name} is under the file ${above.name}.`;
    }
  }
  for (const entry of entries) {
    if (entry.type === '2' && byName.get(linkTarget(entry.name, entry.link) ?? '')?.type !== '0') {
      return `The archive's link ${entry.name} points at ${shown(entry.link)}, which is not a file in the archive.`;
    }
  }
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

function isManifest(v: unknown): v is ManifestItem[] {
  return Array.isArray(v) && v.every((m) => isObject(m) && typeof m.Config === 'string' && (m.RepoTags == null || isStrings(m.RepoTags)) && (m.Layers == null || isStrings(m.Layers)));
}

function isIndex(v: unknown): v is NonNullable<ArchiveInfo['index']> {
  return (
    isObject(v) &&
    Array.isArray(v.manifests) &&
    v.manifests.every((m) => isObject(m) && (m.annotations == null || (isObject(m.annotations) && Object.values(m.annotations).every((s) => typeof s === 'string'))))
  );
}

/** Pass 1: the archive's entries and names, and what would stop it from loading. */
export async function inspectArchive(file: string): Promise<ArchiveInfo> {
  const fd = await fs.promises.open(file, 'r');
  try {
    const { size: fileSize } = await fd.stat();
    const entries: ArchiveEntry[] = [];
    const byName = new Map<string, ArchiveEntry>();
    const contents = new Map<string, Buffer>();
    let problem: string | null = null;
    let offset = 0;
    let dataEnd = fileSize;
    let count = 0;
    // What the extended headers ahead of an entry say: one of each kind at most.
    let pax: Record<string, string> | null = null;
    let longName: string | null = null;
    let longLink: string | null = null;
    for (;;) {
      if (offset + BLOCK > fileSize) {
        problem = 'The archive ends in the middle of an entry.';
        break;
      }
      const block = await readAt(fd, offset, BLOCK);
      if (block.every((b) => b === 0)) {
        if (pax || longName !== null || longLink !== null) problem = 'The archive ends with an extended header that belongs to no entry.';
        dataEnd = offset;
        break;
      }
      const size = checksumOk(block) ? numeric(block.subarray(124, 136)) : null;
      if (size === null) {
        problem = 'This is not a tar archive (a header does not check out).';
        break;
      }
      const flag = String.fromCharCode(block[156]!);
      const dataStart = offset + BLOCK;
      if (flag === 'x' || flag === 'L' || flag === 'K') {
        if (size > MAX_META) {
          problem = 'An extended header in the archive is too large.';
          break;
        }
        if (dataStart + size > fileSize) {
          problem = 'The archive ends in the middle of an entry.';
          break;
        }
        // Go keeps the last of a kind, and another reader might merge them.
        if ((flag === 'x' && pax) || (flag === 'L' && longName !== null) || (flag === 'K' && longLink !== null)) {
          problem = 'An entry in the archive has two extended headers of one kind: readers disagree on which one counts.';
          break;
        }
        const data = await readAt(fd, dataStart, size);
        if (flag === 'x') {
          pax = paxRecords(data);
          if (!pax) {
            problem = 'An extended header in the archive is malformed.';
            break;
          }
          // GNU.sparse.name renames an entry in Go.
          if (Object.keys(pax).some((key) => key.startsWith('GNU.sparse.'))) {
            problem = 'The archive has a sparse file, which no docker save writes.';
            break;
          }
        } else if (flag === 'L') longName = cstring(data, 0, data.length);
        else longLink = cstring(data, 0, data.length);
        offset = dataStart + padded(size);
        continue;
      }
      if (++count > MAX_ENTRIES) {
        problem = `The archive has more than ${MAX_ENTRIES.toLocaleString('en-US')} entries; one image's docker save has far fewer.`;
        break;
      }
      // A global header would name nothing after it in Go, and everything in another reader.
      if (flag === 'g') {
        problem = 'The archive has a global extended header, which no docker save writes.';
        break;
      }
      const own = headerName(block);
      if (own === null) {
        problem = 'This is not a tar archive (a header does not check out).';
        break;
      }
      const paxPath = pax?.path || null;
      const paxLink = pax?.linkpath || null;
      // Go takes the GNU one; a reader that went by PAX would take the other.
      if ((paxPath && longName) || (paxLink && longLink)) {
        problem = 'An entry in the archive has both a PAX name and a GNU long name: readers disagree on which one counts.';
        break;
      }
      // An empty one is no name to Go: the header's own stands.
      const rawName = paxPath ?? (longName || own);
      const rawLink = paxLink ?? (longLink || cstring(block, 157, 100));
      let entrySize = size;
      if (pax?.size) {
        // Go reads it as a decimal integer; JavaScript's Number would take 0x10 and 1e3 as well.
        if (!/^[0-9]+$/.test(pax.size) || !Number.isSafeInteger(Number(pax.size))) {
          problem = 'An extended header in the archive gives a size that is not a plain number.';
          break;
        }
        entrySize = Number(pax.size);
      }
      // A name ending in "/" makes an old-style file a folder, to Go.
      const type = flag === '5' || (flag === '\0' && rawName.endsWith('/')) ? '5' : flag === '0' || flag === '\0' ? '0' : flag === '2' ? '2' : null;
      if (type === null) {
        problem = `The archive's ${shown(rawName)} is ${TYPE_NAMES[flag] ?? `of tar type ${JSON.stringify(flag)}`}: an image archive holds only files, folders and symbolic links.`;
        break;
      }
      // Go gives a folder or a link no data whatever its size says: a size would hide entries from one reader or the other.
      if (type !== '0' && entrySize !== 0) {
        problem = `The archive's ${shown(rawName)} is a ${type === '5' ? 'folder' : 'link'} with a size: readers disagree on where the next entry starts.`;
        break;
      }
      if (dataStart + entrySize > fileSize) {
        problem = 'The archive ends in the middle of an entry.';
        break;
      }
      const checked = plainName(rawName, type === '5');
      if ('problem' in checked) {
        problem = checked.problem;
        break;
      }
      const { name } = checked;
      pax = null;
      longName = null;
      longLink = null;
      offset = dataStart + padded(entrySize);
      if (name === '') {
        if (type !== '5') {
          problem = `The archive's ${shown(rawName)} names the archive's own folder, and is not a folder.`;
          break;
        }
        // The archive's own folder: nothing to write.
        continue;
      }
      if (byName.has(name)) {
        problem = `The archive has ${name} twice.`;
        break;
      }
      if (ROOT_FILES.includes(name)) {
        if (type !== '0') {
          problem = `The archive's ${name} is not a plain file.`;
          break;
        }
        if (entrySize > MAX_NAME_FILE) {
          problem = `The archive's ${name} is too large.`;
          break;
        }
        if (name !== 'oci-layout') contents.set(name, await readAt(fd, dataStart, entrySize));
      }
      // A link's target is checked before it is kept, not once the walk is done: a GNU long link
      // or a PAX header can make one 64 KiB, and an archive can hold 10,000 links.
      if (type === '2' && rawLink.length > 100) {
        problem = `The archive's link ${name} points at ${shown(rawLink)}, which is too long for a plain tar header.`;
        break;
      }
      if (type === '2' && linkTarget(name, rawLink) === null) {
        problem = `The archive's link ${name} points at ${shown(rawLink)}, which is not a file in the archive.`;
        break;
      }
      const entry: ArchiveEntry = { name, type, size: entrySize, dataStart, link: type === '2' ? rawLink : '' };
      entries.push(entry);
      byName.set(name, entry);
    }
    problem ??= treeProblem(entries, byName);

    const parse = (name: string): unknown => {
      const raw = contents.get(name);
      if (!raw) return null;
      try {
        return JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        problem ??= `The archive's ${name} is not JSON.`;
        return null;
      }
    };
    const manifestJson = parse('manifest.json');
    const indexJson = parse('index.json');
    const repositories = parse('repositories');
    if (contents.has('manifest.json') && !isManifest(manifestJson)) problem ??= "The archive's manifest.json is not one docker save writes.";
    if (contents.has('index.json') && !isIndex(indexJson)) problem ??= "The archive's index.json is not one docker save writes.";
    const manifest = isManifest(manifestJson) ? manifestJson : null;
    const index = isIndex(indexJson) ? indexJson : null;
    if (!problem && (!manifest || manifest.length === 0)) {
      problem = 'This is not an image archive from docker save: it has no manifest.json.';
    }
    const images = Math.max(manifest?.length ?? 0, index?.manifests.length ?? 0);
    if (!problem && images > 1) problem = `The archive holds ${images} images; upload one at a time.`;

    const names = new Set<string>();
    for (const m of manifest ?? []) for (const tag of m.RepoTags ?? []) names.add(normalImageName(tag));
    for (const m of index?.manifests ?? []) {
      const named = m.annotations?.['io.containerd.image.name'];
      if (named) names.add(normalImageName(named));
    }
    if (isObject(repositories)) {
      for (const [repo, tags] of Object.entries(repositories)) if (isObject(tags)) for (const tag of Object.keys(tags)) names.add(normalImageName(`${repo}:${tag}`));
    }
    return { entries, images, names: [...names], problem, manifest, index, dataEnd };
  } finally {
    await fd.close();
  }
}

/** A size in octal while 11 digits hold it, else in base-256 (high bit set, big-endian), which Go reads. */
function sizeField(size: number): Buffer {
  if (size <= 0o77777777777) return Buffer.from(`${size.toString(8).padStart(11, '0')}\0`, 'ascii');
  const field = Buffer.alloc(12);
  let rest = BigInt(size);
  for (let i = 11; i > 0; i--, rest >>= 8n) field[i] = Number(rest & 0xffn);
  field[0] = 0x80;
  return field;
}

const MODES = { '0': '0000644\0', '5': '0000755\0', '2': '0000777\0' } as const;

/** A plain ustar header of the panel's own: the entry's name, type, size and link target, owned by root, and nothing else. */
function ustarHeader(name: string, type: ArchiveEntry['type'], size: number, link = ''): Buffer {
  const split = ustarName(type === '5' ? `${name}/` : name);
  if (!split) throw new Error(`${name} does not fit a tar header.`);
  const block = Buffer.alloc(BLOCK);
  block.write(split.name, 0, 100, 'latin1');
  block.write(MODES[type], 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  sizeField(size).copy(block, 124);
  block.write('00000000000\0', 136, 12, 'ascii');
  block.fill(0x20, 148, 156); // the checksum counts its own field as spaces
  block.write(type, 156, 1, 'ascii');
  block.write(link, 157, 100, 'latin1');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write('0000000\0', 329, 8, 'ascii');
  block.write('0000000\0', 337, 8, 'ascii');
  block.write(split.prefix, 345, 155, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

const padding = (size: number) => Buffer.alloc(padded(size) - size);

/** A file's data out of the upload, a chunk at a time. */
async function* fileData(fd: fs.promises.FileHandle, start: number, size: number): AsyncGenerator<Buffer> {
  for (let at = start; at < start + size; ) {
    const length = Math.min(CHUNK, start + size - at);
    const { bytesRead, buffer } = await fd.read(Buffer.allocUnsafe(length), 0, length, at);
    // The header said how much follows: an entry cut short would make its next bytes a header.
    if (bytesRead === 0) throw new Error('The archive changed while it was read: upload it again.');
    at += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

/** The image's name in the form `index.json`'s annotation takes. */
const qualified = (name: string) => (name.includes('/') ? name : `docker.io/library/${name}`);

/**
 * Pass 2: the archive written anew, with every name it carries replaced by `name`, as a stream, for
 * `POST /images/load`. Only for an archive `inspectArchive` found nothing wrong with.
 */
export function renamedArchive(file: string, info: ArchiveInfo, name: string): Readable {
  if (info.problem) throw new Error(info.problem);
  const tag = name.slice(name.lastIndexOf(':') + 1);
  // The fields a load reads and no others: Go's JSON reader takes a key in any case, so a `repotags`
  // kept beside `RepoTags` would be read in its place.
  const manifest = Buffer.from(JSON.stringify((info.manifest ?? []).map((m) => ({ Config: m.Config, RepoTags: [name], Layers: m.Layers ?? [] }))), 'utf8');
  const index = info.index
    ? Buffer.from(
        JSON.stringify({
          schemaVersion: info.index.schemaVersion,
          mediaType: info.index.mediaType,
          manifests: info.index.manifests.map((m) => {
            const annotations = { ...m.annotations };
            delete annotations['io.containerd.image.name'];
            delete annotations['org.opencontainers.image.ref.name'];
            return {
              mediaType: m.mediaType,
              digest: m.digest,
              size: m.size,
              platform: m.platform,
              annotations: { ...annotations, 'io.containerd.image.name': qualified(name), 'org.opencontainers.image.ref.name': tag },
            };
          }),
        }),
        'utf8',
      )
    : null;
  if (!index && info.entries.some((e) => e.name === 'index.json')) throw new Error('The archive has an index.json that was not read.');

  async function* parts(): AsyncGenerator<Buffer> {
    const fd = await fs.promises.open(file, 'r');
    try {
      for (const entry of info.entries) {
        if (entry.name === 'repositories') continue;
        const written = entry.name === 'manifest.json' ? manifest : entry.name === 'index.json' ? index : null;
        if (written) {
          yield ustarHeader(entry.name, '0', written.length);
          yield written;
        } else {
          yield ustarHeader(entry.name, entry.type, entry.size, entry.link);
          if (entry.type === '0') yield* fileData(fd, entry.dataStart, entry.size);
        }
        const size = written ? written.length : entry.size;
        if (size % BLOCK !== 0) yield padding(size);
      }
      yield Buffer.alloc(BLOCK * 2);
    } finally {
      await fd.close();
    }
  }
  return Readable.from(parts());
}

/**
 * One file out of a small tar held in memory, as Docker's `getArchive` sends it: a single entry, a
 * link followed once. Null when it is not there.
 */
export function fileFromTar(tar: Buffer, wanted: string): { data: Buffer } | { link: string } | null {
  let offset = 0;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) return null;
    const type = String.fromCharCode(block[156]!);
    const size = numeric(block.subarray(124, 136)) ?? 0;
    const dataStart = offset + BLOCK;
    if (type === 'x' || type === 'L') {
      const data = tar.subarray(dataStart, dataStart + size);
      if (type === 'x') pax = paxRecords(data, 'utf8') ?? {};
      else longName = cstring(data, 0, data.length, 'utf8');
      offset = dataStart + padded(size);
      continue;
    }
    const name = (pax.path ?? longName ?? cstring(block, 0, 100, 'utf8')).replace(/^\.\//, '');
    if (name.split('/').pop() === wanted.split('/').pop()) {
      if (type === '1' || type === '2') return { link: pax.linkpath ?? cstring(block, 157, 100, 'utf8') };
      return { data: tar.subarray(dataStart, dataStart + size) };
    }
    pax = {};
    longName = null;
    offset = dataStart + padded(size);
  }
  return null;
}
