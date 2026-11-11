// @docs sites/external, sites/php
import { eq } from 'drizzle-orm';
import { sites, type SiteRow } from '../db/schema.js';
import { conflict } from './errors.js';

/**
 * Hosted sites run in a container on one of the panel's servers; external ones are hosted
 * elsewhere and reached through the WPL7 Connect plugin. An external row fills the container
 * columns with nothing (schema.ts, `sites.kind`), so every path that reaches Docker, the site's
 * database or its files must never be handed one. These are the checks it goes through.
 */

/** Which kinds a lookup accepts: hosted sites only (the default everywhere), or both. */
export type SiteKinds = 'hosted' | 'any';

export const isExternal = (site: Pick<SiteRow, 'kind'>): boolean => site.kind === 'external';

/** WPL7 Connect's plugin folder: an external site must keep it, and takes its updates from the panel. */
export const CONNECT_PLUGIN = 'wpl7-connect';

/** A query condition: hosted sites only. */
export const hostedSites = () => eq(sites.kind, 'hosted');

/** A query condition: external sites only. */
export const externalSites = () => eq(sites.kind, 'external');

/** What a request about an external site gets where only a hosted one makes sense. */
export function externalRefusal(slug: string) {
  return conflict(`"${slug}" is an external site: this works only for sites the panel hosts.`);
}

/** The row back when its kind is one the caller takes, else the refusal. */
export function assertKind(site: SiteRow, kinds: SiteKinds = 'hosted'): SiteRow {
  if (kinds === 'hosted' && isExternal(site)) throw externalRefusal(site.slug);
  return site;
}

/**
 * What runs in a hosted site (sites.app): WordPress, or the site's own PHP and files with no
 * WordPress in it. A PHP site has the same container, files and surroundings, so a generic path
 * takes it as it is. Every WordPress path refuses it: a route or a job with `{ app: 'wordpress' }`
 * on its lookup (SitesService.bySlug, loadSite), a loop with `wordpressSites()` in its query. One
 * that forgets meets a `wp` that finds no WordPress, and fails on that, not on the site's data.
 */

/** Which apps a lookup accepts: both (the default), or WordPress only. */
export type SiteApps = 'wordpress' | 'any';

export const isPhpSite = (site: Pick<SiteRow, 'app'>): boolean => site.app === 'php';

/** A query condition: WordPress sites only, hosted or external. */
export const wordpressSites = () => eq(sites.app, 'wordpress');

/** What a request about a PHP site gets where only WordPress makes sense. */
export function wordpressOnly(slug: string) {
  return conflict(`"${slug}" is a PHP site: this works only for WordPress sites.`);
}

/** The row back when it is a WordPress site, else the refusal. */
export function assertWordPress<T extends Pick<SiteRow, 'slug' | 'app'>>(site: T): T {
  if (isPhpSite(site)) throw wordpressOnly(site.slug);
  return site;
}

/** The row back when its app is one the caller takes, else the refusal. */
export function assertApp(site: SiteRow, apps: SiteApps = 'any'): SiteRow {
  return apps === 'wordpress' ? assertWordPress(site) : site;
}

/**
 * Whether the site has a database of its own (sites.db_name). A PHP site's is optional, and a site
 * without one has '' in all three columns, as an external row has: every path that reaches the
 * site's database asks this first, because the database tools refuse an empty name.
 */
export const hasDatabase = (site: Pick<SiteRow, 'dbName'>): boolean => site.dbName !== '';

/** What a request about a site's own database gets when it has none. */
export function noDatabase(slug: string) {
  return conflict(`"${slug}" has no database.`);
}

/** Why a PHP site's move can't be frozen by maintenance mode, which is WordPress's. */
export const PHP_NO_MAINTENANCE = (slug: string) =>
  `"${slug}" is a PHP site, which has no maintenance mode: stop it while it moves, or keep serving.`;

/** What a PHP site's page cache settings get: nginx stores only pages WordPress marks. */
export const phpNoPageCache = (slug: string) => `"${slug}" is a PHP site, which has no page cache.`;
