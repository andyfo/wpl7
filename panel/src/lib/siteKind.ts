// @docs sites/external
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
