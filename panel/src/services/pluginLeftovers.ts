// @docs sites/duplicator, sites/import, sites/wordpress
/**
 * What a plugin takes away itself when it is deactivated in wp-admin, but leaves behind when the
 * panel deactivates it with WP-CLI. The panel takes it away in its place.
 *
 * WP Rocket: its rules in .htaccess. Its deactivation removes them only when WordPress runs under a
 * web server (`flush_rocket_htaccess` returns unless WordPress's `$is_apache`, which WP-CLI leaves
 * false), and only once no config file of another domain is left, which a moved site's always is.
 * Left in place, they send every page with `max-age=0`, so the panel's page cache stores none.
 */
import { AppError } from '../lib/errors.js';
import type { SiteFilesService } from './siteFiles.js';

const WP_ROCKET = 'wp-rocket';
const BEGIN = '# BEGIN WP Rocket';
const END = '# END WP Rocket';

/**
 * `text` without WP Rocket's rules: the line with its BEGIN marker, the line with its END marker
 * and what is between, as WP Rocket takes them out itself. Null without both markers in that order:
 * WP Rocket would take everything after a BEGIN with no END.
 */
export function withoutWpRocketRules(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes(BEGIN));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.includes(END));
  if (end < 0) return null;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
}

/**
 * After the panel deactivated or deleted the plugins `slugs` (their folders) on a site: WP Rocket's
 * rules out of its .htaccess, saved only over the version read. What it did or could not do, for
 * the log; null when there was nothing to do.
 */
export async function clearPluginLeftovers(
  files: Pick<SiteFilesService, 'read' | 'write'>,
  container: string,
  slugs: readonly string[],
): Promise<{ ok: boolean; message: string } | null> {
  if (!slugs.includes(WP_ROCKET)) return null;
  let read: { bytes: Buffer; etag: string };
  try {
    read = await files.read(container, '.htaccess');
  } catch (err) {
    // No .htaccess: nothing of WP Rocket's in one.
    if (err instanceof AppError && err.statusCode === 404) return null;
    return { ok: false, message: `Could not read .htaccess for WP Rocket's rules (${errMsg(err)}): take them out on the Files tab.` };
  }
  // latin1 keeps every byte as it was: the lines around the block stay exactly as they are.
  const without = withoutWpRocketRules(read.bytes.toString('latin1'));
  if (without === null) return null;
  try {
    await files.write(container, '.htaccess', Buffer.from(without, 'latin1'), { ifMatch: read.etag });
  } catch (err) {
    return { ok: false, message: `Could not take WP Rocket's rules out of .htaccess (${errMsg(err)}): take them out on the Files tab.` };
  }
  return { ok: true, message: "Took WP Rocket's rules out of .htaccess, as WP Rocket does when it is deactivated in wp-admin." };
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
