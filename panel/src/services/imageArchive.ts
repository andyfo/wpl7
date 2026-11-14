/**
 * A `docker save` archive, read and renamed before it is loaded (services/appImages.ts).
 *
 * A load hands every name an archive carries to the image in it, and takes the name from whatever
 * had it, without a refusal: the classic image store says "renaming the old one ... to empty
 * string" and goes on, containerd's says nothing (test/engine/containerImages.test.ts, item 9). An
 * archive named like the site image or like Traefik's would become what the next container made by
 * that name runs, and one named like an image a server does not have yet would wait for it. So no
 * name of the archive's own ever reaches a daemon: before the load every one is rewritten to the
 * panel's own name for the upload.
 *
 * The names are in up to three places, and the two stores read different ones: `manifest.json`
 * (RepoTags; what the classic store goes by when they disagree), `index.json` (the
 * `io.containerd.image.name` and `org.opencontainers.image.ref.name` annotations; containerd's), and
 * `repositories` (the old format, written by the classic store). All three are rewritten or dropped.
 *
 * Read the way Docker's own reader (Go's archive/tar) reads it: a PAX header or a GNU long name sets
 * the next entry's name, so an archive cannot hide a `manifest.json` from this check behind one.
 * Pass 1 reads only the headers and the three small files; pass 2 streams a new archive in which
 * every other entry is the original's bytes, unchanged.
 */
import fs from 'node:fs';
import { Readable } from 'node:stream';

const BLOCK = 512;
/** The files that carry names. Anything bigger than this is no `docker save` index. */
const NAME_FILES = ['manifest.json', 'index.json', 'repositories'] as const;
const MAX_NAME_FILE = 1024 * 1024;

export interface ArchiveEntry {
  /** The name a reader takes, with a PAX path or a GNU long name applied. */
  name: string;
  /** The tar type flag: '0' (or '\0') a file, '5' a folder, '1'/'2' links. */
  type: string;
  size: number;
  /** Where its first header block starts: its PAX or long-name blocks, if it has them. */
  start: number;
  /** Where its data starts, and where the next entry does (after the padding). */
  dataStart: number;
  end: number;
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
  manifest: { Config?: string; RepoTags?: string[] | null; Layers?: string[] }[] | null;
  index: { manifests?: { annotations?: Record<string, string> }[] } | null;
  /** Byte offset where the archive's end blocks start. */
  dataEnd: number;
}

/** `docker.io/library/x:1` and `x:1` are one name. */
export const normalImageName = (name: string): string => name.replace(/^docker\.io\/library\//, '').replace(/^docker\.io\//, '');

function cstring(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

/** A numeric header field: octal, or base-256 when its high bit is set (sizes past 8 GiB). */
function numberField(buf: Buffer, start: number, length: number): number {
  const field = buf.subarray(start, start + length);
  if (field[0]! & 0x80) {
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    return value;
  }
  const text = cstring(buf, start, length).trim();
  return text === '' ? 0 : parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  return sum === numberField(block, 148, 8);
}

/** PAX records, `<len> key=value\n` each. */
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const length = parseInt(data.subarray(i, space).toString('ascii'), 10);
    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, i + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;

async function readAt(fd: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** Pass 1: the archive's entries and names, and what would stop it from loading. */
export async function inspectArchive(file: string): Promise<ArchiveInfo> {
  const fd = await fs.promises.open(file, 'r');
  try {
    const { size: fileSize } = await fd.stat();
    const entries: ArchiveEntry[] = [];
    const contents = new Map<string, Buffer>();
    let problem: string | null = null;
    let offset = 0;
    let dataEnd = fileSize;
    let pax: Record<string, string> = {};
    let longName: string | null = null;
    let start = 0;
    for (;;) {
      if (offset + BLOCK > fileSize) {
        problem ??= 'The archive ends in the middle of an entry.';
        break;
      }
      const block = await readAt(fd, offset, BLOCK);
      if (block.every((b) => b === 0)) {
        dataEnd = offset;
        break;
      }
      if (!checksumOk(block)) {
        problem ??= 'This is not a tar archive (a header does not check out).';
        break;
      }
      const type = String.fromCharCode(block[156]!);
      const size = numberField(block, 124, 12);
      const dataStart = offset + BLOCK;
      const next = dataStart + padded(size);
      if (type === 'g') {
        // Go's reader hands a global header over as an entry of its own and names nothing after
        // it by it: kept as it is, on its own.
        entries.push({ name: '', type, size, start, dataStart, end: next });
        offset = next;
        start = offset;
        continue;
      }
      if (type === 'x' || type === 'L' || type === 'K') {
        if (size > MAX_NAME_FILE) {
          problem ??= 'An extended header in the archive is too large.';
          break;
        }
        const data = await readAt(fd, dataStart, size);
        if (type === 'x') pax = { ...pax, ...paxRecords(data) };
        else if (type === 'L') longName = cstring(data, 0, data.length);
        offset = next;
        continue;
      }
      // The prefix field is POSIX ustar's; GNU's format keeps other fields there.
      const posix = block.subarray(257, 263).toString('latin1') === 'ustar\0';
      const prefix = posix ? cstring(block, 345, 155) : '';
      const plain = cstring(block, 0, 100);
      const name = (pax.path ?? longName ?? (prefix ? `${prefix}/${plain}` : plain)).replace(/^\.\//, '');
      const realSize = pax.size !== undefined ? Number(pax.size) : size;
      const entry: ArchiveEntry = { name, type, size: realSize, start, dataStart, end: dataStart + padded(realSize) };
      entries.push(entry);
      if ((NAME_FILES as readonly string[]).includes(name) || name === 'oci-layout') {
        if (type !== '0' && type !== '\0') problem ??= `The archive's ${name} is not a plain file.`;
        else if (contents.has(name)) problem ??= `The archive has ${name} twice.`;
        else if (realSize > MAX_NAME_FILE) problem ??= `The archive's ${name} is too large.`;
        else if (name !== 'oci-layout') contents.set(name, await readAt(fd, dataStart, realSize));
      }
      pax = {};
      longName = null;
      offset = entry.end;
      start = offset;
    }

    const parse = <T>(name: string): T | null => {
      const raw = contents.get(name);
      if (!raw) return null;
      try {
        return JSON.parse(raw.toString('utf8')) as T;
      } catch {
        problem ??= `The archive's ${name} is not JSON.`;
        return null;
      }
    };
    const manifest = parse<ArchiveInfo['manifest']>('manifest.json');
    const index = parse<ArchiveInfo['index']>('index.json');
    const repositories = parse<Record<string, Record<string, string>>>('repositories');
    if (!problem && (!Array.isArray(manifest) || manifest.length === 0)) {
      problem = 'This is not an image archive from docker save: it has no manifest.json.';
    }
    const images = Math.max(Array.isArray(manifest) ? manifest.length : 0, index?.manifests?.length ?? 0);
    if (!problem && images > 1) problem = `The archive holds ${images} images; upload one at a time.`;

    const names = new Set<string>();
    for (const m of Array.isArray(manifest) ? manifest : []) for (const tag of m.RepoTags ?? []) names.add(normalImageName(tag));
    for (const m of index?.manifests ?? []) {
      const named = m.annotations?.['io.containerd.image.name'];
      if (named) names.add(normalImageName(named));
    }
    for (const [repo, tags] of Object.entries(repositories ?? {})) for (const tag of Object.keys(tags)) names.add(normalImageName(`${repo}:${tag}`));
    return { entries, images, names: [...names], problem, manifest, index, dataEnd };
  } finally {
    await fd.close();
  }
}

/** One plain ustar header: what the rewritten files get. */
function encodeHeader(name: string, size: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write(`${Math.floor(mtime).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i]!;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

function fileEntry(name: string, data: Buffer): Buffer[] {
  return [encodeHeader(name, data.length, Date.now() / 1000), data, Buffer.alloc(padded(data.length) - data.length)];
}

/** The image's name in the form `index.json`'s annotation takes. */
const qualified = (name: string) => (name.includes('/') ? name : `docker.io/library/${name}`);

/**
 * Pass 2: the archive with every name it carries replaced by `name`, as a stream, for
 * `POST /images/load`. Only for an archive `inspectArchive` found nothing wrong with.
 */
export function renamedArchive(file: string, info: ArchiveInfo, name: string): Readable {
  if (info.problem) throw new Error(info.problem);
  const tag = name.slice(name.lastIndexOf(':') + 1);
  const manifest = JSON.stringify((info.manifest ?? []).map((m) => ({ ...m, RepoTags: [name] })));
  const index = info.index
    ? JSON.stringify({
        ...info.index,
        manifests: (info.index.manifests ?? []).map((m) => {
          const annotations = { ...m.annotations };
          delete annotations['io.containerd.image.name'];
          delete annotations['org.opencontainers.image.ref.name'];
          return { ...m, annotations: { ...annotations, 'io.containerd.image.name': qualified(name), 'org.opencontainers.image.ref.name': tag } };
        }),
      })
    : null;

  async function* parts(): AsyncGenerator<Buffer> {
    for (const entry of info.entries) {
      if (entry.name === 'repositories') continue;
      if (entry.name === 'manifest.json') {
        yield* fileEntry('manifest.json', Buffer.from(manifest, 'utf8'));
        continue;
      }
      if (entry.name === 'index.json' && index !== null) {
        yield* fileEntry('index.json', Buffer.from(index, 'utf8'));
        continue;
      }
      // Everything else, its own header blocks included, exactly as it was.
      for await (const chunk of fs.createReadStream(file, { start: entry.start, end: entry.end - 1 })) yield chunk as Buffer;
    }
    yield Buffer.alloc(BLOCK * 2);
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
    const size = numberField(block, 124, 12);
    const dataStart = offset + BLOCK;
    if (type === 'x' || type === 'L') {
      const data = tar.subarray(dataStart, dataStart + size);
      if (type === 'x') pax = paxRecords(data);
      else longName = cstring(data, 0, data.length);
      offset = dataStart + padded(size);
      continue;
    }
    const name = (pax.path ?? longName ?? cstring(block, 0, 100)).replace(/^\.\//, '');
    if (name.split('/').pop() === wanted.split('/').pop()) {
      if (type === '1' || type === '2') return { link: pax.linkpath ?? cstring(block, 157, 100) };
      return { data: tar.subarray(dataStart, dataStart + size) };
    }
    pax = {};
    longName = null;
    offset = dataStart + padded(size);
  }
  return null;
}
