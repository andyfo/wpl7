/**
 * How much of the panel a credential may use: an API key, or an app connected over MCP
 * (docs/mcp.md). A browser session is always Full - the people who sign in are admins.
 *
 * Each endpoint in `shared/apiDocs.ts` names the level it needs, and the auth gate
 * (src/plugins/auth.ts) holds every request to it. The levels nest: Manage can do everything
 * Read only can, and Full everything Manage can.
 *
 * The line between Manage and Full is the one the platform already holds between a site and
 * everything else: each site's container, on a network of its own. Manage is everything inside
 * the sites - what their WordPress admins could do from wp-admin, which is run code there, so
 * WP-CLI, shell and files are no more - and it can read whatever a site holds, a licence key a
 * recipe activated there included. Full is the panel: whatever is shared between sites, or keeps
 * them safe - servers, mail, DNS, offsite copies, the catalog, recipes and the keys entered for
 * them, settings, and the backup policy.
 */

// @docs integrations/api
export const accessLevels = ['read', 'manage', 'full'] as const;
export type AccessLevel = (typeof accessLevels)[number];

export const ACCESS_LABELS: Record<AccessLevel, string> = {
  read: 'Read only',
  manage: 'Manage',
  full: 'Full',
};

/** What each level adds to the one before it - the pickers show these. */
export const ACCESS_SUMMARIES: Record<AccessLevel, string> = {
  read:
    'See sites, servers, jobs, backups, the WordPress inventory, mail, traffic and settings, and list files. ' +
    'Never a file’s contents, a command’s output or a password.',
  manage:
    'Also work inside every site as its WordPress admin could: create sites; plugins, themes and core; WP-CLI, ' +
    'shell and REST calls; files; WordPress and FTP logins; backups and restores; each site\'s protection, malware scans ' +
    'and quarantine; custom schedules. It can read ' +
    'whatever a site holds, licence keys included, and what it sets up in a site stays when you revoke it.',
  full:
    'Everything: also the panel itself (servers, settings, mail and DNS, offsite destinations, the plugin ' +
    'catalog, recipes and the keys entered for them, the blocked addresses), the backup policy (backup schedules, deleting backups, ' +
    'switching them off), deleting or moving sites, and updating the panel.',
};

const RANK: Record<AccessLevel, number> = { read: 0, manage: 1, full: 2 };

/** Does a credential of level `granted` reach an endpoint that needs `required`? */
export function allows(granted: AccessLevel, required: AccessLevel): boolean {
  return RANK[granted] >= RANK[required];
}

export const isAccessLevel = (value: unknown): value is AccessLevel =>
  typeof value === 'string' && (accessLevels as readonly string[]).includes(value);
