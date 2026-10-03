/**
 * Fixed container names of the system stack (deploy/docker-compose.yml). The panel creates
 * site containers outside compose and reaches these by name, so the names are API, not
 * cosmetics - renaming a service in compose without changing it here breaks routing,
 * database access and mail for every site.
 */
export const TRAEFIK_CONTAINER = 'wpl7-traefik';
export const MARIADB_CONTAINER = 'wpl7-mariadb';
export const MAIL_CONTAINER = 'wpl7-mail';
export const DKIM_CONTAINER = 'wpl7-dkim';
export const PANEL_CONTAINER = 'wpl7-panel';
