/**
 * Where a server's backups are allowed to live.
 *
 * Shared between the API (which validates before writing `servers.backup_root`) and the
 * Storage form (which greys out Apply before a round trip). The rule is not "is this path
 * pretty": a backup root is a directory the panel creates timestamp trees under and later
 * `rm -rf`s inside, so pointing it at `/` or at `<SRV_ROOT>/sites` would eventually delete
 * the very thing being backed up.
 */

// @docs backups/storage
/** Trees that hold live state; a backup root may neither be inside one nor contain one. */
export const RESERVED_SRV_SUBTREES = ['sites', 'mysql', 'panel', 'mail', 'traefik', 'plugins'] as const;

/**
 * System trees nothing should ever be written into. `/mnt`, `/media` and `/srv` itself are
 * deliberately absent: those are exactly where an extra disk usually turns up.
 */
const RESERVED_SYSTEM_PATHS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
];

/** Normalize without needing node:path, so the browser can call this too. */
export function normalizeAbsolutePath(input: string): string {
  const out: string[] = [];
  for (const part of input.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return '/' + out.join('/');
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent + '/');

/**
 * Null = usable. Otherwise a sentence naming what is wrong, shown verbatim in the form and
 * in the 400 body, so both say the same thing.
 */
export function backupRootProblem(input: string, srvRoot: string): string | null {
  const raw = input.trim();
  if (!raw) return 'Enter a directory, or leave it empty for the default location.';
  if (!raw.startsWith('/')) return 'The location must be an absolute path (starting with "/").';
  if (raw.includes('\0')) return 'The location contains an invalid character.';
  // Shell-hostile characters never make it past here: the path is spliced into `sh -c`
  // strings on the server (mkdir, df, mktemp) and into a Docker bind source.
  if (/[\n\r\t"'`$\\]/.test(raw)) return 'The location contains characters that are not allowed in a path.';
  const path = normalizeAbsolutePath(raw);
  if (path === '/') return 'The filesystem root cannot be a backup location.';

  const base = normalizeAbsolutePath(srvRoot);
  for (const name of RESERVED_SRV_SUBTREES) {
    const reserved = `${base === '/' ? '' : base}/${name}`;
    if (isInside(path, reserved)) return `${path} is inside ${reserved}, which holds live data.`;
    // An ancestor is just as bad: a site slug called "sites" would then collide with the
    // real one, and pruning that backup would rm -rf every site on the machine.
    if (isInside(reserved, path)) return `${path} contains ${reserved}, which holds live data.`;
  }
  for (const reserved of RESERVED_SYSTEM_PATHS) {
    if (isInside(path, reserved)) return `${path} is inside ${reserved}, which belongs to the operating system.`;
  }
  return null;
}

/** The normalized path an accepted input maps to. Throws on a path the rule rejects. */
export function normalizeBackupRoot(input: string, srvRoot: string): string {
  const problem = backupRootProblem(input, srvRoot);
  if (problem) throw new Error(problem);
  return normalizeAbsolutePath(input.trim());
}
