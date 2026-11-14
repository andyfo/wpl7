/**
 * A container app's container: what it is made from, how it runs, and what it is given.
 *
 * Never the site image's spec (siteSpec.ts siteContainerSpec refuses an app): an app's container
 * is made from its own image, pinned (`repo@sha256:…`) or an upload's id, with
 *
 * - labels that keep Traefik off it (`traefik.enable=false`, and none of Traefik's own: its routes
 *   are a file of their own, services/appRoutes.ts) and say whose it is (`wpl7.role=app`), which
 *   no image may set itself (services/appImages.ts labelRefusal);
 * - its environment from `app_env`, with the panel's placeholders filled at every create;
 * - its folders: each writable path under `data/<dir>`, each mount under `mounts/<name>`, owned by
 *   the user the container runs as, and nothing else of the host;
 * - its site's network and the egress network, the limits a site has, no published port, and
 *   no-new-privileges always; every capability dropped or the ones a site drops; a read-only root
 *   with a tmpfs /tmp when asked.
 */
// @docs sites/container
import path from 'node:path';
import type { Config } from '../config.js';
import type { AppEnvRow, AppMountRow, AppSettingsRow, SiteRow } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { appMounts, appSettings } from '../db/schema.js';
import type { FilesPort } from '../lib/files.js';
import { hasDatabase } from '../lib/siteKind.js';
import { pinned } from './appImages.js';
import type { SiteContainerSpec } from './docker.js';
import { mailLogin } from './mailAuth.js';
import { siteNetworksFor } from './siteNetwork.js';
import type { SiteRuntime } from './siteSpec.js';

export const APP_ROLE = 'app';

/** Where an app's files are on its server. `data/` and `mounts/` hold one folder per path, never the app's root. */
export function appPaths(config: Pick<Config, 'paths'>, slug: string) {
  const root = path.join(config.paths.sites, slug);
  return {
    root,
    data: path.join(root, 'data'),
    mounts: path.join(root, 'mounts'),
    dataDir: (dir: string) => path.join(root, 'data', dir),
    mountDir: (name: string) => path.join(root, 'mounts', name),
    /** Where a mount's archive lands, chunk by chunk (routes/apps.ts), outside every backup. */
    mountUpload: (uploadId: string) => path.join(root, 'mount-uploads', uploadId),
    siteJson: path.join(root, 'site.json'),
  };
}

// ---------------------------------------------------------------------------
// Paths in the container

/** A writable path the app keeps, in its folder under `data/`. `fromImage`: one of the image's VOLUMEs. */
export interface DataPath {
  path: string;
  dir: string;
  fromImage: boolean;
}

/** A name the container resolves itself (its /etc/hosts). */
export interface ExtraHost {
  host: string;
  address: string;
}

export const parseDataPaths = (json: string): DataPath[] => {
  try {
    const list = JSON.parse(json) as DataPath[];
    return Array.isArray(list) ? list.filter((d) => typeof d?.path === 'string' && typeof d?.dir === 'string') : [];
  } catch {
    return [];
  }
};

export const parseExtraHosts = (json: string): ExtraHost[] => {
  try {
    const list = JSON.parse(json) as ExtraHost[];
    return Array.isArray(list) ? list.filter((h) => typeof h?.host === 'string' && typeof h?.address === 'string') : [];
  } catch {
    return [];
  }
};

/** Where nothing of the app's may be mounted: the container's own system folders. */
const SYSTEM_PATHS = ['/proc', '/sys', '/dev', '/etc', '/bin', '/sbin', '/usr', '/lib', '/lib64'];

/** Why a path in the container cannot be a data path or a mount. Null when it can. */
export function containerPathProblem(p: string): string | null {
  if (!p.startsWith('/')) return `${p} is not an absolute path.`;
  if (p.length > 200) return `${p.slice(0, 40)}… is longer than 200 characters.`;
  if (!/^\/[A-Za-z0-9._@+\-/]*$/.test(p)) return `${p} may hold only letters, digits and . _ @ + - /.`;
  if (p === '/' || p.endsWith('/')) return `${p}: name a folder, without a / at the end.`;
  if (p.split('/').some((part, i) => i > 0 && (part === '' || part === '.' || part === '..'))) return `${p} has an empty, . or .. part.`;
  const system = SYSTEM_PATHS.find((s) => p === s || p.startsWith(`${s}/`));
  if (system) return `${p} is in ${system}, which belongs to the container's own system.`;
  return null;
}

/**
 * A folder name under `data/` for a path, kept with it from then on: readable on the server
 * (`/var/lib/app` → `var-lib-app`), and unique among the app's.
 */
export function dataDirFor(containerPath: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    containerPath
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'root';
  let dir = base;
  for (let n = 2; used.has(dir); n++) dir = `${base}-${n}`;
  return dir;
}

/**
 * The data paths after an image's VOLUMEs are read: every one of them kept, each new VOLUME
 * added. A VOLUME the image no longer has stays a data path: what it holds is never dropped by a
 * deploy, only by someone removing the path.
 */
export function withImageVolumes(current: DataPath[], volumes: string[], mountPaths: string[]): DataPath[] {
  const out = [...current];
  const have = new Set([...out.map((d) => d.path), ...mountPaths]);
  for (const volume of volumes) {
    const p = volume.replace(/\/+$/, '') || '/';
    if (have.has(p) || containerPathProblem(p)) continue;
    out.push({ path: p, dir: dataDirFor(p, out.map((d) => d.dir)), fromImage: true });
    have.add(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The environment

/** What the panel fills in an environment value, at every create of the container. */
export const APP_PLACEHOLDERS = [
  'db.host',
  'db.port',
  'db.name',
  'db.user',
  'db.password',
  'mail.host',
  'mail.port',
  'mail.user',
  'mail.password',
  'site.domain',
] as const;
export type AppPlaceholder = (typeof APP_PLACEHOLDERS)[number];

const PLACEHOLDER_RE = /\{\{\s*([^{}\s]*)\s*\}\}/g;

/** The placeholders a value names, known or not. */
export function placeholdersIn(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!);
}

/** Why an environment cannot be saved: a placeholder the panel doesn't fill, or a database the app has not. Null when it can. */
export function envProblem(env: { name: string; value: string }[], app: { database: boolean }): string | null {
  for (const v of env) {
    for (const name of placeholdersIn(v.value)) {
      if (!(APP_PLACEHOLDERS as readonly string[]).includes(name)) {
        return `${v.name}: {{${name}}} is not one the panel fills. It fills ${APP_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}.`;
      }
      if (name.startsWith('db.') && !app.database) return `${v.name}: {{${name}}} needs the app's database, and it has none.`;
    }
  }
  return null;
}

/** Whether the environment hands the app its relay login. */
export const usesMail = (env: Pick<AppEnvRow, 'value'>[]): boolean => env.some((v) => placeholdersIn(v.value).some((p) => p.startsWith('mail.')));

/** The values the placeholders stand for, for this app now. */
export function placeholderValues(
  config: Pick<Config, 'mariadb'>,
  site: Pick<SiteRow, 'slug' | 'domains' | 'dbName' | 'dbUser' | 'dbPassword' | 'mailPassword'>,
): Record<AppPlaceholder, string> {
  const domains = JSON.parse(site.domains) as string[];
  return {
    'db.host': hasDatabase(site) ? config.mariadb.host : '',
    'db.port': hasDatabase(site) ? '3306' : '',
    'db.name': site.dbName,
    'db.user': site.dbUser,
    'db.password': site.dbPassword,
    // The relay on the site's network, as a site's msmtp reaches it (mailAuth.ts renderMsmtprc).
    'mail.host': 'mail',
    'mail.port': '587',
    'mail.user': mailLogin(site.slug),
    'mail.password': site.mailPassword ?? '',
    'site.domain': domains[0] ?? '',
  };
}

/** The container's environment, its placeholders filled. */
export function resolveEnv(
  config: Pick<Config, 'mariadb'>,
  site: Pick<SiteRow, 'slug' | 'domains' | 'dbName' | 'dbUser' | 'dbPassword' | 'mailPassword'>,
  env: Pick<AppEnvRow, 'name' | 'value'>[],
): Record<string, string> {
  const values = placeholderValues(config, site);
  const out: Record<string, string> = {};
  for (const v of env) {
    out[v.name] = v.value.replace(PLACEHOLDER_RE, (whole, name: string) => (name in values ? values[name as AppPlaceholder] : whole));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Who it runs as

const RUN_AS_RE = /^(\d{1,10}):(\d{1,10})$/;

/** `run_as` as numbers, or null for the image's own user. */
export function parseRunAs(runAs: string): { uid: number; gid: number } | null {
  const m = RUN_AS_RE.exec(runAs);
  return m ? { uid: Number(m[1]), gid: Number(m[2]) } : null;
}

/** Who owns the app's folders: the user the container runs as. */
export function appOwner(settings: Pick<AppSettingsRow, 'runAs' | 'imageUid' | 'imageGid'>): { uid: number; gid: number } {
  return parseRunAs(settings.runAs) ?? { uid: settings.imageUid, gid: settings.imageGid };
}

// ---------------------------------------------------------------------------
// The spec

export interface AppSpecInput {
  site: Pick<SiteRow, 'slug' | 'containerName' | 'domains' | 'dbName' | 'dbUser' | 'dbPassword' | 'mailPassword'>;
  settings: Pick<AppSettingsRow, 'runAs' | 'dropAllCaps' | 'readOnlyRoot' | 'extraHosts' | 'dataPaths' | 'stopGraceSec'>;
  env: Pick<AppEnvRow, 'name' | 'value'>[];
  mounts: Pick<AppMountRow, 'name' | 'containerPath' | 'writable'>[];
  runtime: SiteRuntime;
  /** What the container is made from: `repo@sha256:…`, or an uploaded image's id. */
  image: string;
}

/** The labels an app's container carries, and every one it may: its image may set none of these (appImages.ts). */
export function appLabels(slug: string): Record<string, string> {
  return {
    'traefik.enable': 'false',
    'wpl7.managed': 'true',
    'wpl7.site': slug,
    'wpl7.role': APP_ROLE,
  };
}

export function buildAppContainerSpec(config: Pick<Config, 'paths' | 'mariadb'>, input: AppSpecInput): SiteContainerSpec {
  const p = appPaths(config, input.site.slug);
  const { settings, runtime } = input;
  return {
    name: input.site.containerName,
    image: input.image,
    env: resolveEnv(config, input.site, input.env),
    labels: appLabels(input.site.slug),
    binds: [
      ...parseDataPaths(settings.dataPaths).map((d) => `${p.dataDir(d.dir)}:${d.path}`),
      ...input.mounts.map((m) => `${p.mountDir(m.name)}:${m.containerPath}${m.writable ? '' : ':ro'}`),
    ],
    networks: siteNetworksFor(input.site.slug),
    memoryBytes: runtime.memoryBytes,
    ...(runtime.nanoCpus ? { nanoCpus: runtime.nanoCpus } : {}),
    ...(runtime.pidsLimit ? { pidsLimit: runtime.pidsLimit } : {}),
    ...(parseRunAs(settings.runAs) ? { user: settings.runAs } : {}),
    ...(settings.dropAllCaps ? { capDrop: ['ALL'] } : {}),
    ...(settings.readOnlyRoot ? { readOnlyRootfs: true, tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m' } } : {}),
    extraHosts: parseExtraHosts(settings.extraHosts).map((h) => `${h.host}:${h.address}`),
    stopTimeout: settings.stopGraceSec,
  };
}

/** The image a running app's container is made from again: pinned for a registry app, its id for an upload. */
export function currentImageRef(settings: Pick<AppSettingsRow, 'source' | 'reference' | 'digest' | 'imageId'>): string | null {
  if (settings.source === 'registry' && settings.digest) return pinned(settings.reference, settings.digest);
  return settings.imageId || null;
}

// ---------------------------------------------------------------------------
// Its folders

/**
 * Make every folder the container binds, owned by the user it runs as, before Docker is asked to
 * run it: Docker makes a missing bind source as a folder of root's, which a container that runs as
 * anyone else then cannot write. 0700: only that user, and root, see into them.
 */
export async function ensureAppFolders(
  files: Pick<FilesPort, 'mkdirp'>,
  config: Pick<Config, 'paths'>,
  site: Pick<SiteRow, 'slug'>,
  settings: Pick<AppSettingsRow, 'runAs' | 'imageUid' | 'imageGid' | 'dataPaths'>,
  mounts: Pick<AppMountRow, 'name'>[],
): Promise<void> {
  const p = appPaths(config, site.slug);
  const owner = appOwner(settings);
  await files.mkdirp(p.data, { mode: 0o755 });
  await files.mkdirp(p.mounts, { mode: 0o755 });
  for (const d of parseDataPaths(settings.dataPaths)) await files.mkdirp(p.dataDir(d.dir), { mode: 0o700, owner });
  for (const m of mounts) await files.mkdirp(p.mountDir(m.name), { mode: 0o700, owner });
}

/** The app's settings and mounts, as its folders and its container need them now. */
export function appRows(db: Db, siteId: number): { settings: AppSettingsRow; mounts: AppMountRow[] } | null {
  const settings = db.select().from(appSettings).where(eq(appSettings.siteId, siteId)).get();
  if (!settings) return null;
  return { settings, mounts: db.select().from(appMounts).where(eq(appMounts.siteId, siteId)).all() };
}
