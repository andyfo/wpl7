/**
 * A container app's image: from a registry, pinned by digest, or uploaded as a `docker save`
 * archive; and the checks every one passes before any container is made from it.
 *
 * - Pinned by digest. The registry is asked what the reference names (`distribution`: one manifest
 *   request, no pull), then `repo@sha256:…` is pulled: a pull by tag would move a local name too.
 *   An upload has no registry digest: its container is made from its image id.
 * - The platform. Docker pulls another platform's single image without a complaint, and refuses
 *   only a list that lacks the server's (test/engine/containerImages.test.ts, item 6). A list's
 *   platforms are known before the pull; a single image's only after it, on containerd's store.
 * - No `traefik.*` and no `wpl7.*` label. An image's labels become its container's: Traefik would
 *   route another site's domain by them, and the panel's sweeps read `wpl7.*` off containers
 *   (item 3). The container's own `traefik.enable=false` voids the first kind anyway.
 * - Defaults from the image: its user (who owns `data/` and `mounts/`), its port, its VOLUME paths.
 */
// @docs sites/container
import { randomBytes } from 'node:crypto';
import type { ImageConfig, RegistryAuth, ServerPlatform } from './docker.js';
import type { ServerHandle } from '../servers/registry.js';
import { inspectArchive, renamedArchive } from './imageArchive.js';

/** Docker Hub's key in a login, as the Docker CLI writes it. */
const DOCKER_HUB = 'https://index.docker.io/v1/';

/** Where a reference's registry is: its first part when that has a dot, a port or is localhost; else Docker Hub. */
export function registryHost(reference: string): string {
  const first = reference.split('/')[0] ?? '';
  return reference.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : DOCKER_HUB;
}

/** `ghcr.io/example/app:stable` → `ghcr.io/example/app`. */
export function repositoryOfReference(reference: string): string {
  const at = reference.indexOf('@');
  if (at >= 0) return reference.slice(0, at);
  const colon = reference.lastIndexOf(':');
  return colon > reference.lastIndexOf('/') ? reference.slice(0, colon) : reference;
}

/** The pinned form of what a reference named: `ghcr.io/example/app@sha256:…`. */
export const pinned = (reference: string, digest: string): string => `${repositoryOfReference(reference)}@${digest}`;

/** The login for a reference, when the app has one. */
export function registryAuthFor(app: { reference: string; registryUser: string; registryToken: string }): RegistryAuth | undefined {
  if (!app.registryUser && !app.registryToken) return undefined;
  return { username: app.registryUser, password: app.registryToken, serveraddress: registryHost(app.reference) };
}

/** The name an upload gets on its server, never one of the archive's own (services/imageArchive.ts). */
export const uploadImageName = (slug: string, uploadId: string): string => `wpl7-app-${slug}:u${uploadId}`;

/** The repository every upload of an app is named in: how the clean-up finds them. */
export const uploadRepository = (slug: string): string => `wpl7-app-${slug}`;

/** Why an image may not run on this server: another platform. Null when it may. */
export function platformRefusal(image: Pick<ImageConfig, 'os' | 'architecture'>, server: ServerPlatform): string | null {
  if (image.os === server.os && image.architecture === server.arch) return null;
  return `The image is for ${image.os}/${image.architecture}, and this server is ${server.os}/${server.arch}. Build it for ${server.os}/${server.arch}.`;
}

/** Why an image may not run at all: labels that would reach Traefik or the panel. Null when none do. */
export function labelRefusal(labels: Record<string, string>): string | null {
  const taken = Object.keys(labels).filter((key) => key.startsWith('traefik.') || key.startsWith('wpl7.'));
  if (taken.length === 0) return null;
  return `The image has labels only the panel may set: ${taken.slice(0, 5).join(', ')}${taken.length > 5 ? ', …' : ''}. Remove them from its Dockerfile.`;
}

/** Both checks, after a pull or a load. */
export function imageRefusal(image: ImageConfig, server: ServerPlatform): string | null {
  return platformRefusal(image, server) ?? labelRefusal(image.labels);
}

/** The one TCP port an image exposes, or null when it exposes none or several. */
export function exposedPort(image: Pick<ImageConfig, 'exposedPorts'>): number | null {
  const tcp = image.exposedPorts.filter((p) => !p.endsWith('/udp')).map((p) => Number(p.split('/')[0]));
  return tcp.length === 1 && Number.isInteger(tcp[0]) ? tcp[0]! : null;
}

/** A uid or gid out of `/etc/passwd` or `/etc/group`, for a name. */
function idIn(file: string | null, name: string, field: 2 | 3): number | null {
  if (!file) return null;
  const row = file
    .split('\n')
    .map((line) => line.split(':'))
    .find((f) => f[0] === name);
  const id = row ? Number(row[field]) : NaN;
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * Who an image runs as, by number: `USER` may be a name, which only the image's own `/etc/passwd`
 * turns into a uid. Read from a container created for it and never started. A name the image does
 * not know refuses, as Docker would refuse to start it.
 */
export async function imageUserIds(server: Pick<ServerHandle, 'docker'>, ref: string, user: string): Promise<{ uid: number; gid: number }> {
  const [name = '', group] = user.split(':');
  if (name === '' || name === 'root') return { uid: 0, gid: 0 };
  const numeric = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  let passwd: string | null = null;
  const passwdFile = async () => (passwd ??= (await server.docker.readImageFile(ref, '/etc/passwd'))?.toString('utf8') ?? '');
  const uid = numeric(name) ?? idIn(await passwdFile(), name, 2);
  if (uid === null) throw new Error(`The image runs as "${name}", and its /etc/passwd has no such user.`);
  let gid = numeric(group);
  if (gid === null && group) gid = idIn((await server.docker.readImageFile(ref, '/etc/group'))?.toString('utf8') ?? null, group, 2);
  if (gid === null && group) throw new Error(`The image runs as group "${group}", and its /etc/group has no such group.`);
  // No group given: the user's own, as Docker takes it: by name, or by uid for a number, and group 0
  // for a number the image has no entry for.
  if (gid === null) {
    const rows = (await passwdFile()).split('\n').map((line) => line.split(':'));
    const row = numeric(name) !== null ? rows.find((f) => f[2] === name) : rows.find((f) => f[0] === name);
    const own = row ? Number(row[3]) : 0;
    gid = Number.isInteger(own) && own >= 0 ? own : 0;
  }
  return { uid, gid };
}

export interface ResolvedImage {
  /** What a container is made from: `repo@sha256:…`, or an upload's id. */
  ref: string;
  /** The registry digest; '' for an upload. */
  digest: string;
  imageId: string;
  config: ImageConfig;
}

/** What a registry reference names now, asked without a pull. Refuses a list without the server's platform. */
export async function resolveDigest(server: Pick<ServerHandle, 'docker'>, reference: string, auth: RegistryAuth | undefined): Promise<string> {
  const info = await server.docker.distribution(reference, auth);
  if (!/^sha256:[0-9a-f]{64}$/.test(info.digest)) throw new Error(`The registry gave no digest for ${reference}.`);
  if (info.platforms.length > 0) {
    const here = await server.docker.serverPlatform();
    if (!info.platforms.some((p) => p.os === here.os && p.architecture === here.arch)) {
      const offered = [...new Set(info.platforms.map((p) => `${p.os}/${p.architecture}`))].join(', ');
      throw new Error(`${reference} has no image for ${here.os}/${here.arch}, only for ${offered}. Build it for ${here.os}/${here.arch}.`);
    }
  }
  return info.digest;
}

/**
 * Pull `repo@digest` and check it. A refused image is removed again: nothing is left that a later
 * create could take.
 */
export async function pullPinned(
  server: Pick<ServerHandle, 'docker'>,
  reference: string,
  digest: string,
  auth: RegistryAuth | undefined,
  onProgress?: (line: string) => void,
): Promise<ResolvedImage> {
  const ref = pinned(reference, digest);
  if (!(await server.docker.imageExists(ref))) await server.docker.pullImage(ref, onProgress, { auth });
  return checked(server, ref, digest);
}

/**
 * Load an uploaded archive under the panel's own name and check it. The archive's own names are
 * read first and replaced, and one with more than one image is refused, before a byte reaches the
 * daemon.
 */
export async function loadUploaded(
  server: Pick<ServerHandle, 'docker'>,
  file: string,
  name: string,
  onProgress?: (line: string) => void,
): Promise<ResolvedImage & { archiveNames: string[] }> {
  const info = await inspectArchive(file);
  if (info.problem) throw new Error(info.problem);
  await server.docker.loadImage(renamedArchive(file, info, name), onProgress);
  const id = await server.docker.imageId(name);
  if (!id) throw new Error('The daemon loaded the archive but has no image by its new name.');
  return { ...(await checked(server, name, '', id)), archiveNames: info.names };
}

async function checked(server: Pick<ServerHandle, 'docker'>, ref: string, digest: string, idFor = ref): Promise<ResolvedImage> {
  const config = await server.docker.imageConfig(ref);
  if (!config) throw new Error(`The image ${ref} is not on the server after all.`);
  const refusal = imageRefusal(config, await server.docker.serverPlatform());
  if (refusal) {
    await server.docker.removeImage(ref).catch(() => undefined);
    throw new Error(refusal);
  }
  return { ref: digest ? ref : config.id || idFor, digest, imageId: config.id, config };
}

/** A new upload's id, as a client would make one for the chunked upload. */
export const newUploadId = (): string => randomBytes(12).toString('base64url');
