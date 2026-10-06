// @docs security/overview, security/site-protection
import { asc } from 'drizzle-orm';
import { sites, type SiteRow } from '../db/schema.js';
import type { JobWorker } from '../jobs/worker.js';
import type { ContainerPolicy } from '../../shared/security.js';
import type { CoreServices } from './index.js';

/**
 * The part of a site's protection that lives inside its container rather than in front of
 * it: what Apache refuses to run, and what wp-admin refuses to do. Both come from files the
 * container mounts read-only, so nothing in the site - a .htaccess, a plugin, a stolen admin
 * login - can switch them back off.
 *
 *   config/security-apache.conf -> /etc/apache2/conf-enabled/zz-wpl7-security.conf
 *       Read when Apache starts or reloads. A single-file mount keeps the inode it was given,
 *       so the file is rewritten in place, and a change is checked before Apache reloads.
 *   config/security/            -> /etc/wpl7
 *       wp-config-extra.php, read by PHP on every request. Its folder is the mount so the
 *       file can be replaced whole: a request never reads half of it.
 *
 * Changing the image was not an option: an update's hooks run before the servers have the
 * new images (jobs/handlers/systemUpdate.ts).
 */

/** Carried by every site container built with these mounts; see sweepHardening. */
export const HARDENING_LABEL = 'wpl7.hardening';
/** Bumped whenever the mounts change shape, which recreates every container once more. */
export const HARDENING_VERSION = '1';

export const APACHE_CONF_IN_CONTAINER = '/etc/apache2/conf-enabled/zz-wpl7-security.conf';
export const HARDENING_DIR_IN_CONTAINER = '/etc/wpl7';
export const WP_EXTRA_IN_CONTAINER = `${HARDENING_DIR_IN_CONTAINER}/wp-config-extra.php`;

const HEADER = [
  "Written by the WPL7 panel from this site's protection, and mounted read-only.",
  "Change it in the panel (the site's Security tab): an edit here is overwritten.",
];

/**
 * Apache's part. `php_admin_flag` is out of a .htaccess's reach, and a <LocationMatch> is
 * applied after every .htaccess, so neither half can be undone from inside the site. The
 * pattern is the one the site's Traefik rule uses (services/securityConfig.ts), so a request
 * that got past Traefik - enforcement off, a visitor on the server's own network - meets the
 * same answer here.
 */
export function renderApacheHardening(policy: Pick<ContainerPolicy, 'blockPhpInUploads'>): string {
  const lines = HEADER.map((l) => `# ${l}`);
  if (policy.blockPhpInUploads) {
    lines.push(
      '',
      '# No PHP in uploads.',
      '<Directory "/var/www/html/wp-content/uploads">',
      '    <IfModule php_module>',
      '        php_admin_flag engine off',
      '    </IfModule>',
      '</Directory>',
      '<LocationMatch "(?i)^/wp-content/uploads/.*\\.ph(p[0-9]?|tml|ar|t|ps)([./]|$)">',
      '    Require all denied',
      '</LocationMatch>',
    );
  } else {
    lines.push('', '# Nothing to add: PHP in uploads is allowed for this site.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * PHP's part, required from wp-config.php (WORDPRESS_CONFIG_EXTRA, services/siteSpec.ts).
 * Never from the command line: the panel's WP-CLI installs and updates are its own, and keep
 * working under "No installs from wp-admin". A constant the site's own wp-config.php defines
 * first wins - PHP has no way to take one back - so each is defined only when it is not.
 */
export function renderWpConfigHardening(policy: Pick<ContainerPolicy, 'disallowFileEdit' | 'disallowFileMods'>): string {
  const lines = ['<?php', ...HEADER.map((l) => `// ${l}`)];
  const constants = [
    ...(policy.disallowFileEdit ? ['DISALLOW_FILE_EDIT'] : []),
    ...(policy.disallowFileMods ? ['DISALLOW_FILE_MODS'] : []),
  ];
  if (constants.length === 0) {
    lines.push('', '// Nothing to add: wp-admin keeps its file editor and its installs for this site.');
  } else {
    lines.push('', "if (PHP_SAPI !== 'cli') {");
    for (const name of constants) lines.push(`    if (!defined('${name}')) define('${name}', true);`);
    lines.push('}');
  }
  return `${lines.join('\n')}\n`;
}

export function hardeningFiles(policy: ContainerPolicy): { apache: string; php: string } {
  return { apache: renderApacheHardening(policy), php: renderWpConfigHardening(policy) };
}

export interface HardeningSweep {
  /** Slugs a reconcile was queued for (or already had one waiting). */
  queued: string[];
  /** Slugs whose container predates the mounts but could not be queued right now. */
  busy: string[];
}

/**
 * One site of a sweep: a `site.reconcile` queued for it, unless it is busy. One already waiting
 * on a reconcile counts as queued, so two sweeps never report each other as a conflict.
 */
export function queueReconcile(
  worker: Pick<JobWorker, 'enqueue' | 'activeSiteJob'>,
  site: Pick<SiteRow, 'id' | 'slug' | 'serverId' | 'status'>,
  sweep: HardeningSweep,
): void {
  if (site.status === 'provisioning' || site.status === 'deleting') {
    sweep.busy.push(site.slug);
    return;
  }
  const active = worker.activeSiteJob(site.id);
  if (active) {
    if (active.type === 'site.reconcile') sweep.queued.push(site.slug);
    else sweep.busy.push(site.slug);
    return;
  }
  try {
    worker.enqueue('site.reconcile', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: site.serverId });
    sweep.queued.push(site.slug);
  } catch {
    sweep.busy.push(site.slug);
  }
}

/**
 * Queue a `site.reconcile` for every site whose container was built without these mounts, or
 * with an older shape of them. Detected by the container's own label, so it is right on any
 * install however it was updated: the update hook calls it (updates/hooks.ts), and so does
 * every boot - a box that builds from its own checkout gets no update hooks.
 *
 * One job per site, in its server's lane, each with its own rollback. A site that is busy
 * with something else is left for the next boot; one already waiting on a reconcile counts as
 * queued, so the hook and the boot sweep never report each other as a conflict.
 */
export async function sweepHardening(s: CoreServices, worker: Pick<JobWorker, 'enqueue' | 'activeSiteJob'>): Promise<HardeningSweep> {
  const sweep: HardeningSweep = { queued: [], busy: [] };
  const rows = s.db.select().from(sites).orderBy(asc(sites.id)).all();
  for (const server of s.servers.listRows()) {
    if (server.status === 'unreachable' || server.status === 'provisioning') continue;
    let containers: { name: string; labels: Record<string, string> }[];
    try {
      containers = await s.servers.handleFor(server.id).docker.listManaged(['wpl7.role=wordpress']);
    } catch (err) {
      s.log.warn(`Hardening sweep on "${server.name}" failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const container of containers) {
      if (container.labels[HARDENING_LABEL] === HARDENING_VERSION) continue;
      const site = rows.find((r) => r.containerName === container.name && r.serverId === server.id);
      // A container the panel cannot explain - a move's leftover, a site deleted while this
      // server was away - is not the sweep's to rebuild.
      if (!site) continue;
      queueReconcile(worker, site, sweep);
    }
  }
  if (sweep.queued.length > 0) {
    s.log.info(`Hardening: ${sweep.queued.length} site container(s) queued to be rebuilt with the read-only protection mounts`);
  }
  if (sweep.busy.length > 0) {
    s.log.warn(`Hardening: ${sweep.busy.length} site(s) were busy and keep their old container until the next boot: ${sweep.busy.join(', ')}`);
  }
  return sweep;
}
