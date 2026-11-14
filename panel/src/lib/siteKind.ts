// @docs sites/external, sites/php
import { eq, ne } from 'drizzle-orm';
import type { SiteApp } from '../../shared/schemas.js';
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
 * What runs in a hosted site (sites.app). WordPress and PHP sites run on the site image: the same
 * container, files and surroundings, so a generic path takes either as it is, and every WordPress
 * path refuses a PHP site. A container app runs an image of its own, with none of the site image's
 * files, tools or PHP: every path that needs the site image refuses it, with `{ app: 'siteImage' }`
 * on its lookup (SitesService.bySlug, loadSite) or `siteImageSites()` in its query, and every
 * WordPress path refuses it with the rest. One that forgets meets a container with no `wp`, no `php`
 * and no `wordpress/`, and fails on that, not on the site's data.
 */

/** Which apps a lookup accepts: every one (the default), WordPress only, the two on the site image, or container apps only. */
export type SiteApps = 'any' | 'wordpress' | 'siteImage' | 'container';

export const isPhpSite = (site: Pick<SiteRow, 'app'>): boolean => site.app === 'php';

export const isContainerApp = (site: Pick<SiteRow, 'app'>): boolean => site.app === 'container';

/** A query condition: WordPress sites only, hosted or external. */
export const wordpressSites = () => eq(sites.app, 'wordpress');

/** A query condition: the sites on the site image, WordPress and PHP, never a container app. */
export const siteImageSites = () => ne(sites.app, 'container');

/** A query condition: container apps only. */
export const containerApps = () => eq(sites.app, 'container');

/** What a request about a PHP site or a container app gets where only WordPress makes sense. */
export function wordpressOnly(slug: string, app: SiteApp = 'php') {
  return conflict(
    app === 'container'
      ? `"${slug}" is a container app: this works only for WordPress sites.`
      : `"${slug}" is a PHP site: this works only for WordPress sites.`,
  );
}

/** What a request about a container app gets where the site image's files, tools or PHP are needed. */
export function siteImageOnly(slug: string) {
  return conflict(`"${slug}" is a container app: this works only for sites on the site image.`);
}

/** What a request about any other site gets where only a container app makes sense. */
export function containerAppOnly(slug: string) {
  return conflict(`"${slug}" is not a container app.`);
}

/** The row back when it is a WordPress site, else the refusal. */
export function assertWordPress<T extends Pick<SiteRow, 'slug' | 'app'>>(site: T): T {
  if (site.app !== 'wordpress') throw wordpressOnly(site.slug, site.app);
  return site;
}

/** The row back when it runs on the site image, else the refusal. */
export function assertSiteImage<T extends Pick<SiteRow, 'slug' | 'app'>>(site: T): T {
  if (isContainerApp(site)) throw siteImageOnly(site.slug);
  return site;
}

/** The row back when its app is one the caller takes, else the refusal. */
export function assertApp(site: SiteRow, apps: SiteApps = 'any'): SiteRow {
  switch (apps) {
    case 'wordpress':
      return assertWordPress(site);
    case 'siteImage':
      return assertSiteImage(site);
    case 'container':
      if (!isContainerApp(site)) throw containerAppOnly(site.slug);
      return site;
    default:
      return site;
  }
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

/** Why a container app has no domain change or go-live of its own: its hosts are its routes'. */
export const APP_HOSTS_FROM_ROUTES = (slug: string) => `"${slug}" is a container app: its hosts are the ones its routes name. Change its routes.`;

/** Why a container app moves only stopped: kept serving, its copy would start beside it, and a worker in it would run twice. */
export const APP_MOVES_STOPPED = (slug: string) => `"${slug}" is a container app: it is stopped while it moves.`;

/** What a PHP site's page cache settings get: nginx stores only pages WordPress marks. */
export const phpNoPageCache = (slug: string) => `"${slug}" is a PHP site, which has no page cache.`;
