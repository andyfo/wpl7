/**
 * Paths inside an archive the panel did not make: an import's files from an old site
 * (jobs/handlers/import.ts), a container app's mount (jobs/handlers/apps.ts).
 */

/**
 * Whether a path from an archive or an old site may be written into a folder of the panel's:
 * relative, no `.` or `..`, no NUL, nothing under the panel's own reserved prefix. Whatever made
 * the archive is trusted for none of it.
 */
export function importPathProblem(bytes: Buffer): string | null {
  if (bytes.length === 0) return 'an empty path';
  if (bytes.length > 4096) return 'a path longer than 4096 bytes';
  if (bytes.includes(0)) return 'a NUL byte';
  if (bytes[0] === 0x2f) return 'an absolute path';
  const segments = bytes.toString('latin1').split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return 'an empty, "." or ".." segment';
    if (segment.length > 255) return 'a name longer than 255 bytes';
    if (segment.startsWith('.wpl7-')) return "the panel's reserved .wpl7- prefix";
  }
  return null;
}
