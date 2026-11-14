/**
 * The image checks the container-apps plan proposes, written for the tests that settle them:
 * test/engine/containerImages.test.ts runs them against this machine's Docker, and
 * test/e2e/sshTransport.ts against a worker over SSH, on both of Docker's image stores. Nothing in
 * the panel does any of this yet.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Docker's name for the host's architecture (`docker info`), in the one images use. */
export const ARCH: Record<string, string> = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' };

/**
 * An image may run on a server only if its OS and architecture are the server's. The variant
 * (arm64's v8) is left out: Docker says it of some images and not of others.
 */
export function platformRefusal(image: { Os?: string; Architecture?: string }, server: { os: string; arch: string }): string | null {
  const os = image.Os ?? '';
  const arch = ARCH[image.Architecture ?? ''] ?? image.Architecture ?? '';
  if (os === server.os && arch === server.arch) return null;
  return `The image is for ${os}/${arch}, and this server is ${server.os}/${server.arch}.`;
}

/** Which of Docker's image stores `docker info` describes. */
export function imageStore(info: { DriverStatus?: unknown }): 'containerd' | 'classic' {
  const status = (info.DriverStatus ?? []) as [string, string][];
  return status.some(([k, v]) => k === 'driver-type' && v === 'io.containerd.snapshotter.v1') ? 'containerd' : 'classic';
}

function tar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // COPYFILE_DISABLE: macOS's tar would add AppleDouble files of its own.
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`tar ${args.join(' ')}: ${Buffer.concat(err).toString('utf8')}`))));
  });
}

/** What `docker save` wrote, unpacked into a folder: its files, and the names each place in it gives. */
export interface Unpacked {
  dir: string;
  /** Every entry but the blobs. */
  files: string[];
  /** manifest.json: one entry per image, with its RepoTags. */
  manifest: { Config: string; RepoTags: string[] | null; Layers: string[] }[] | null;
  /** index.json (OCI): one manifest per image, its names in annotations. */
  index: { manifests: { digest: string; annotations?: Record<string, string> }[] } | null;
  /** The legacy `repositories` file: repository -> tag -> id. */
  repositories: Record<string, Record<string, string>> | null;
}

export async function unpackArchive(archive: string): Promise<Unpacked> {
  const dir = `${archive}.d`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  await tar(['-xf', archive, '-C', dir]);
  const read = <T>(name: string): T | null => (fs.existsSync(path.join(dir, name)) ? (JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as T) : null);
  const files = (await tar(['-tf', archive])).split('\n').filter((f) => f && !f.startsWith('blobs/'));
  return { dir, files, manifest: read('manifest.json'), index: read('index.json'), repositories: read('repositories') };
}

/**
 * Packing an archive again: a plain tar. The classic image store refuses a load whose entries carry
 * extended attributes it cannot set (macOS's tar writes its com.apple.provenance), and the panel's
 * own writer would write none.
 */
const pack = (dir: string, to: string) =>
  tar(['--no-xattrs', ...(process.platform === 'darwin' ? ['--no-mac-metadata'] : []), '-cf', to, '-C', dir, ...fs.readdirSync(dir)]);

/** A name as the daemon lists it: `docker.io/library/x:1` and `x:1` are one name. */
export const normalName = (name: string) => name.replace(/^docker\.io\/library\//, '').replace(/^docker\.io\//, '');

/** How many images an archive holds, and every name it carries, from each place a load reads one. */
export function archiveNames(u: Unpacked): { images: number; names: string[] } {
  const names = new Set<string>();
  for (const m of u.manifest ?? []) for (const t of m.RepoTags ?? []) names.add(normalName(t));
  for (const m of u.index?.manifests ?? []) {
    const name = m.annotations?.['io.containerd.image.name'];
    if (name) names.add(normalName(name));
  }
  for (const [repo, tags] of Object.entries(u.repositories ?? {})) for (const tag of Object.keys(tags)) names.add(normalName(`${repo}:${tag}`));
  return { images: Math.max(u.manifest?.length ?? 0, u.index?.manifests.length ?? 0), names: [...names] };
}

/** Every name a daemon has, from its image list. */
export const namesOf = (images: { RepoTags?: string[] | null }[]): Set<string> =>
  new Set(images.flatMap((i) => i.RepoTags ?? []).filter((t) => !t.startsWith('<none>')).map(normalName));

/** The names `u` carries, rewritten into a new archive `to`: each place set to `name`, or emptied when it is null. */
export async function renameArchive(u: Unpacked, name: string | null, to: string): Promise<void> {
  const write = (file: string, value: unknown) => fs.writeFileSync(path.join(u.dir, file), JSON.stringify(value));
  if (u.manifest) write('manifest.json', u.manifest.map((m) => ({ ...m, RepoTags: name ? [name] : null })));
  if (u.index) {
    write('index.json', {
      ...u.index,
      manifests: u.index.manifests.map((m) => {
        const annotations = { ...m.annotations };
        delete annotations['io.containerd.image.name'];
        delete annotations['org.opencontainers.image.ref.name'];
        if (name) {
          annotations['io.containerd.image.name'] = name.includes('/') ? name : `docker.io/library/${name}`;
          annotations['org.opencontainers.image.ref.name'] = name.split(':').pop()!;
        }
        return { ...m, annotations };
      }),
    });
  }
  if (u.repositories) fs.rmSync(path.join(u.dir, 'repositories'));
  await pack(u.dir, to);
}

/** An archive whose manifest.json names one image and whose index.json another: which a load goes by. */
export async function disagreeingArchive(u: Unpacked, manifestName: string, indexName: string, to: string): Promise<void> {
  const write = (file: string, value: unknown) => fs.writeFileSync(path.join(u.dir, file), JSON.stringify(value));
  if (u.manifest) write('manifest.json', u.manifest.map((m) => ({ ...m, RepoTags: [manifestName] })));
  if (u.index) {
    write('index.json', {
      ...u.index,
      manifests: u.index.manifests.map((m) => ({
        ...m,
        annotations: { 'io.containerd.image.name': `docker.io/library/${indexName}`, 'org.opencontainers.image.ref.name': indexName.split(':').pop()! },
      })),
    });
  }
  if (u.repositories) fs.rmSync(path.join(u.dir, 'repositories'));
  await pack(u.dir, to);
}

/** The uid and gid of a user named in an image's /etc/passwd, or of a numeric `USER`. */
export function userIds(passwd: string, user: string): { uid: number; gid: number } | null {
  const [name = '', group] = user.split(':');
  const row = /^\d+$/.test(name) ? null : passwd.split('\n').map((l) => l.split(':')).find((f) => f[0] === name);
  const uid = /^\d+$/.test(name) ? Number(name) : row ? Number(row[2]) : NaN;
  const gid = group !== undefined && /^\d+$/.test(group) ? Number(group) : row ? Number(row[3]) : uid;
  return Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null;
}
