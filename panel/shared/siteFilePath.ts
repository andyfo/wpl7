/**
 * Paths inside a site's WordPress folder, as the Files tab and the `/files` API name them.
 *
 * A path is relative to the site's docroot - `''` is the folder itself - '/'-separated,
 * and can never leave it: no `.` or `..` segments, no empty ones, no NUL. The panel turns
 * it into `/var/www/html/<path>` and hands that to a command running INSIDE the site's
 * own container, so even a path that resolved somewhere odd through a symlink the site
 * planted would still only reach what the site itself can reach (see services/siteFiles.ts).
 *
 * No node:path here: the browser uses the same rules to build breadcrumbs and to check a
 * name before sending it.
 */

// @docs sites/files
/** Where the site's WordPress folder is mounted inside its container. */
export const SITE_FILES_ROOT = '/var/www/html';

export const FILE_LIMITS = {
  /** The largest file the editor opens, and the largest body one `PUT /files/content` saves. */
  editBytes: 8 * 1024 * 1024,
  /** The largest upload chunk. Small enough to cross Traefik's 60 s read timeout at ~1 Mbit/s. */
  chunkBytes: 8 * 1024 * 1024,
  /** The largest file an upload may assemble. */
  uploadBytes: 2 * 1024 * 1024 * 1024,
  /** Entries a folder listing returns before it says it was cut short. */
  listEntries: 10_000,
  /** Matches a search returns before it says it was cut short. */
  searchResults: 1_000,
  /** Paths one delete or compress request may name (keeps the JSON body well under 1 MiB). */
  batchPaths: 200,
  /** A whole path, in UTF-8 bytes; it travels in a query string. */
  pathBytes: 2048,
  /** One name, in UTF-8 bytes (the Linux limit). */
  nameBytes: 255,
  /** An upload or an extraction that would leave less than this free on the disk is refused. */
  minFreeBytes: 1024 * 1024 * 1024,
} as const;

/** Upload ids are chosen by the client; this is all they may look like. */
export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Prefix of the panel's own temporary files (a save in progress, an upload being assembled,
 * an archive being written). Reserved: nobody can create a file called that from the panel.
 */
export const RESERVED_FILE_PREFIX = '.wpl7-';

/** How long `s` is in UTF-8 bytes - what a file system, or a command's stdin, counts. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export type ParsedSitePath = { ok: true; path: string } | { ok: false; problem: string };

/**
 * Validate and normalise a path. One leading and one trailing `/` are forgiven (`/wp-content/`
 * is `wp-content`); anything else that is not a plain relative path is refused with a
 * sentence saying why, which the API returns verbatim.
 */
export function parseSiteFilePath(input: string): ParsedSitePath {
  let p = input;
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (p === '') return { ok: true, path: '' };
  if (p.includes('\0')) return { ok: false, problem: 'The path contains a NUL character.' };
  if (utf8Bytes(p) > FILE_LIMITS.pathBytes) {
    return { ok: false, problem: `The path is longer than ${FILE_LIMITS.pathBytes} bytes.` };
  }
  for (const segment of p.split('/')) {
    if (segment === '') return { ok: false, problem: 'The path has an empty segment ("//").' };
    if (segment === '.' || segment === '..') {
      return { ok: false, problem: 'The path may not contain "." or ".." segments.' };
    }
    if (utf8Bytes(segment) > FILE_LIMITS.nameBytes) {
      return { ok: false, problem: `A name in the path is longer than ${FILE_LIMITS.nameBytes} bytes.` };
    }
  }
  return { ok: true, path: p };
}

export function joinSiteFilePath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** The folder an entry is in; `''` for a top-level entry, and for the root itself. */
export function siteFileParent(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** The entry's own name; `''` for the root. */
export function siteFileBase(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** True when `p` is `ancestor` or somewhere below it. */
export function isSameOrInside(p: string, ancestor: string): boolean {
  return ancestor === '' || p === ancestor || p.startsWith(`${ancestor}/`);
}

/** The absolute path inside the container. */
export function containerPath(p: string, root: string = SITE_FILES_ROOT): string {
  return p === '' ? root : `${root}/${p}`;
}

/**
 * Null when `name` can be given to a new file or folder, else a sentence saying why not.
 * Stricter than what can already exist: an odd name a plugin wrote can still be opened,
 * renamed and deleted, but the panel does not make new ones.
 */
export function newFileNameProblem(name: string): string | null {
  if (name === '') return 'Enter a name.';
  if (name === '.' || name === '..') return `"${name}" is not a usable name.`;
  if (name.includes('/')) return 'A name cannot contain "/".';
  if (/[\x00-\x1f\x7f]/.test(name)) return 'A name cannot contain control characters.';
  if (name.startsWith(RESERVED_FILE_PREFIX)) return `Names starting with "${RESERVED_FILE_PREFIX}" are reserved for the panel.`;
  if (utf8Bytes(name) > FILE_LIMITS.nameBytes) return `A name can be at most ${FILE_LIMITS.nameBytes} bytes long.`;
  return null;
}
