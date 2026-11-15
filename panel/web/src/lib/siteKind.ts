import type { SiteApp } from '../../../shared/schemas';

/**
 * What each kind of site has, where the pages tell them apart: WordPress, a PHP site's own code,
 * or a container app's own image, which has neither. Not being PHP does not make a site WordPress.
 */

/** The word beside a site's own database: what it belongs to. */
export const databaseOwner = (app: SiteApp): string => (app === 'wordpress' ? 'WordPress' : app === 'container' ? 'App' : 'Site');

/**
 * Whether Send a test message can go from the site: wp_mail() on WordPress, PHP's mail() on a PHP
 * site. A container app's image is its own, with neither for the panel to run, and the API refuses it.
 */
export const sendsTestMail = (site: { app: SiteApp; status: string }): boolean => site.status === 'running' && site.app !== 'container';
