/**
 * The REST API, described once.
 *
 * This is what the panel's **API keys -> Docs** tab renders and what its test console
 * prefills, so the reference an operator reads is generated from the same list the test
 * button fires. `test/unit/apiDocs.test.ts` checks it against Fastify's own route table
 * in both directions - a documented endpoint that does not exist, and an endpoint nobody
 * documented, are both test failures.
 *
 * Summaries are deliberately one line. The long-form prose (why a move needs no DNS work,
 * how offsite encryption is keyed) lives in docs/api.md and the docs/ pages it links.
 *
 * It is also what an API key's level and the MCP server go by: every endpoint names the
 * access it needs, and the auth gate (src/plugins/auth.ts) holds every request to it.
 */

import { ACCESS_LABELS, allows, type AccessLevel } from './access.js';

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiDocEndpoint {
  method: ApiMethod;
  /** Fastify's route pattern, `:param` and all - which is also how the test console fills it in. */
  path: string;
  /** One line, imperative, no trailing full stop. */
  summary: string;
  /** Request body or query string, compact. */
  input?: string;
  /** What comes back on success. */
  returns?: string;
  /** Answers `202 {job}` + `Location: /api/jobs/<id>`: poll the job for the outcome. */
  job?: boolean;
  /**
   * Removes or overwrites something. The test console asks before sending these, and over MCP
   * they go through the tool an AI client asks about before every call.
   */
  danger?: boolean;
  /** Reachable without a key (the login endpoints, the health probe). */
  open?: boolean;
  /** Not a plain JSON call: a websocket upgrade, a file upload, a binary stream. */
  note?: string;
  /**
   * The access a key or an MCP connection needs to call it. Required, so that nobody adds an
   * endpoint without deciding. The rule of thumb is `ruleOfThumb()` below; anything else says
   * why in `levelReason`, and test/unit/apiAccess.test.ts pins the list of exceptions.
   */
  level: AccessLevel;
  /** Why `level` is not what the rule of thumb gives: a secret, a safety net, a mere nudge. */
  levelReason?: string;
  /**
   * How an AI client reaches it over MCP (docs/mcp.md). Left out: through the generic tool for
   * what it does - read, change, or destroy. `false`: never - a session, a credential, a binary
   * stream, something that leaves the box. `'file'`: only through the file tools, which speak
   * text, not raw bytes.
   */
  mcp?: false | 'file';
}

export interface ApiDocGroup {
  id: string;
  title: string;
  /**
   * What a change in this group needs, unless an endpoint says otherwise. Manage where the
   * change stays inside the sites - their WordPress, files, logins, backups, jobs and
   * schedules, which a site's own admin could reach from wp-admin anyway. Full where it is the
   * panel's own: servers, mail, offsite destinations, the catalog, recipes, settings, accounts.
   */
  changes: 'manage' | 'full';
  /** One or two lines above the table. */
  intro: string;
  endpoints: ApiDocEndpoint[];
}

export const API_DOC_GROUPS: ApiDocGroup[] = [
  {
    id: 'sites',
    title: 'Sites',
    changes: 'manage',
    intro:
      'Create, change and remove sites. Everything that touches a container is asynchronous: you get a job back and poll it.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/sites',
        summary: 'List every site with its status, health probe and WordPress snapshot',
        returns: '{items: SiteSummary[]}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/sites',
        summary: 'Create a site (dev hostname or a live domain) and install WordPress',
        input:
          '{title, slug?, serverId?, domainMode: "dev"|"custom", domains?, phpVersion?, locale?, adminUser, adminEmail?, adminPassword?, discourageSearchEngines?, plugins?: {catalogIds?, extraWporgSlugs?}} - adminEmail left out uses the defaultAdminEmail setting (400 when that is empty); catalogIds left out installs the catalog\'s default plugins, [] none of them',
        returns: 'job.result: {url, adminPassword}',
        job: true,
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug',
        summary: 'One site in full, including its container state and monitoring snapshot',
        returns: 'SiteDetail',
        level: 'read',
      },
      {
        method: 'DELETE',
        path: '/api/sites/:slug',
        summary: 'Delete a site, its database and its files',
        input: '?finalBackup=true|false (default true)&deleteBackups=true|false (default false; with a final backup, that one is kept)',
        job: true,
        danger: true,
        level: 'full',
        levelReason: 'Removes the site itself, with its database and files',
      },
      { method: 'POST', path: '/api/sites/:slug/start', summary: 'Start the container', job: true, level: 'manage' },
      { method: 'POST', path: '/api/sites/:slug/stop', summary: 'Stop the container', job: true, danger: true, level: 'manage' },
      { method: 'POST', path: '/api/sites/:slug/restart', summary: 'Restart the container', job: true, level: 'manage' },
      {
        method: 'PUT',
        path: '/api/sites/:slug/php',
        summary: 'Switch PHP version, rolling back if the site stops answering',
        input: '{phpVersion}',
        job: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/go-live',
        summary: 'Move a dev site onto its real domains with no downtime',
        input: '{domains: [primary, ...aliases], keepDevAlias?: true, manageDns?: false (true needs Full)}',
        job: true,
        danger: true,
        level: 'manage',
      },
      {
        method: 'PUT',
        path: '/api/sites/:slug/domains',
        summary: 'Edit the domains a live site answers on',
        input: '{domains}',
        job: true,
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/move',
        summary: 'Move the site to another server; the old one forwards until DNS catches up',
        input: '{targetServerId, quiesce?: "maintenance"|"stop"|"none"}',
        job: true,
        level: 'full',
        levelReason: 'Crosses servers and leaves a parked copy behind',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/move/finalize',
        summary: 'Tear down the parked source copy now instead of waiting for DNS verification',
        job: true,
        danger: true,
        level: 'full',
        levelReason: 'Ends a move, which is Full: tears down the parked copy',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/reconcile',
        summary: 'Re-apply the isolation policy (network, capabilities, limits, mail credential)',
        job: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/reconcile-all',
        summary: 'The same for every site, one job each',
        returns: '202 {jobs}',
        job: true,
        level: 'manage',
      },
      {
        method: 'PUT',
        path: '/api/sites/:slug/backups-enabled',
        summary: 'Include or exclude this site from the scheduled backup run',
        input: '{enabled}',
        returns: 'SiteDetail (sync)',
        danger: true,
        level: 'full',
        levelReason: 'Switching backups off removes a safety net',
      },
      {
        method: 'PUT',
        path: '/api/sites/:slug/offsite-enabled',
        summary: 'Stop or resume copying this site\'s backups offsite',
        input: '{enabled}',
        returns: 'SiteDetail (sync)',
        danger: true,
        level: 'full',
        levelReason: 'Switching offsite copies off removes a safety net',
      },
      {
        method: 'PUT',
        path: '/api/sites/:slug/mail-suspension',
        summary: 'Stop or resume the relay accepting this site\'s mail',
        input: '{suspended, reason?}',
        returns: 'SiteDetail (sync)',
        danger: true,
        level: 'full',
        levelReason: 'Lifting a suspension undoes the spam guard',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/traffic',
        summary: 'Visitor statistics: visitors, page views, top pages, referrers, countries, crawlers',
        input: '?days=1..365 (default 30)',
        returns: 'SiteTrafficDto',
        level: 'read',
      },
    ],
  },
  {
    id: 'wp',
    title: 'WordPress on one site',
    changes: 'manage',
    intro:
      'The snapshot (`/wp/status`) is a database read and answers instantly, even for a stopped site. Anything that changes the install is a job.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/sites/:slug/wp/status',
        summary: 'Plugins, themes, core and vulnerability counts from the last scan',
        returns: '{core, plugins[], themes[], counts, feed, scannedAt}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/scan',
        summary: 'Re-read this site now and return the fresh snapshot',
        returns: 'the snapshot (sync, 5-20s, 10/min)',
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/bulk',
        summary: 'Run several update/activate/deactivate/delete operations as one job',
        input: '{ops: [{kind, slug?, action}], backupFirst?: false, healthCheck?: true}',
        job: true,
        danger: true,
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/wp/plugins',
        summary: 'Installed plugins read live from the container',
        returns: '{items} (sync, 409 when stopped)',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/plugins',
        summary: 'Install a plugin from wordpress.org or the catalog',
        input: '{source: {kind:"wporg",slug}|{kind:"catalog",id}, activate?}',
        job: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/plugins/:name/activate',
        summary: 'Activate a plugin',
        job: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/plugins/:name/deactivate',
        summary: 'Deactivate a plugin',
        job: true,
        level: 'manage',
      },
      { method: 'POST', path: '/api/sites/:slug/wp/plugins/:name/update', summary: 'Update one plugin', job: true, level: 'manage' },
      {
        method: 'DELETE',
        path: '/api/sites/:slug/wp/plugins/:name',
        summary: 'Delete a plugin',
        job: true,
        danger: true,
        level: 'manage',
      },
      { method: 'POST', path: '/api/sites/:slug/wp/themes/:name/activate', summary: 'Activate a theme', job: true, level: 'manage' },
      { method: 'POST', path: '/api/sites/:slug/wp/themes/:name/update', summary: 'Update one theme', job: true, level: 'manage' },
      {
        method: 'DELETE',
        path: '/api/sites/:slug/wp/themes/:name',
        summary: 'Delete a theme (never the active one or its parent)',
        job: true,
        danger: true,
        level: 'manage',
      },
      { method: 'POST', path: '/api/sites/:slug/wp/core-update', summary: 'Update WordPress core', job: true, level: 'manage' },
      {
        method: 'GET',
        path: '/api/sites/:slug/wp/version',
        summary: 'Core version and whether an update is waiting',
        returns: '{version, update}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/users/reset-password',
        summary: 'Reset a WordPress user password; the new one is returned once and never stored',
        input: '{user}',
        returns: '{newPassword} (sync)',
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/admin-login',
        summary: 'Mint a single-use link that lands in wp-admin already signed in (120s)',
        returns: '{url, user, expiresInSeconds}',
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/wp/maintenance',
        summary: 'Is maintenance mode on?',
        returns: '{enabled}',
        level: 'read',
      },
      {
        method: 'PUT',
        path: '/api/sites/:slug/wp/maintenance',
        summary: 'Turn maintenance mode on or off',
        input: '{enabled}',
        returns: '{enabled} (sync)',
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/wp/recipes',
        summary: 'Where each plugin recipe stands on this site, from the last run',
        returns: '{items: SiteLicense[]}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/recipes/apply',
        summary: 'Run the plugin recipes on this site now, or only verify them',
        input: '{recipeId?, hook?: "afterInstall"|"verify"}',
        job: true,
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/cli',
        summary: 'Run a wp-cli command in the container, or queue it as a job with async: true',
        input:
          '{args: ["option","get","siteurl"], stdin?: text for a "-" value or --prompt, one line each (≤ 64 KB; in no summary or log), async?, timeoutMin?: 1-60} - a WP Godmode wait is never async',
        returns: '{stdout, stderr, exitCode} (sync, 55s cap; 504 past it) | 202 {job} (async; output in the job log)',
        danger: true,
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/wp/cli/help',
        summary: "WP-CLI's help for a command, a plugin's own included: read it before running a command you have not met",
        input: '?command=<words, e.g. "godmode" or "godmode chat send"; none lists every command>',
        returns:
          "{command, help (less WP-CLI's global parameters, the same for every command), panel?: how to reach these commands through the panel} | 404 when the site has no such command",
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/godmode/chats',
        summary: "List the site's WP Godmode chats and what each is doing, or a chat's sub-chats (wp godmode chat list)",
        input: '?parent=<chat or agent id>',
        returns:
          "WP Godmode's JSON as printed, {ok:false, error} too: {chats: [{id, name, type, state, …}], total} | 409 without the plugin's commands",
        level: 'manage',
        levelReason: 'Runs WP-CLI in the site, and a chat can quote anything the site holds',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/godmode/agents',
        summary: "List the site's WP Godmode agents (wp godmode agent list); an agent's id is a chat id",
        returns: "WP Godmode's JSON as printed, {ok:false, error} too | 409 without the plugin's commands",
        level: 'manage',
        levelReason: 'Runs WP-CLI in the site, and an agent can quote anything the site holds',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/godmode/chats/:chatId',
        summary: 'Read a WP Godmode chat, or wait up to 40 s while it works (wp godmode chat read / wait)',
        input:
          '?wait=0-40 (seconds; 0 reads at once), after=<the turn cursor an earlier answer gave; -1 = from the start>, last=1-50 (a read without after), pending=true (a read of the waiting cards alone, in full)',
        returns:
          "WP Godmode's JSON as printed, {ok:false, error} too: a wait {state: working|waiting_for_input|idle|unknown, waiting_on, digest?, …}, a read {chat, turns, waiting_on, after, …} | 409 without the plugin's commands",
        level: 'manage',
        levelReason: 'Runs WP-CLI in the site, and a chat can quote anything the site holds',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/shell',
        summary: "Queue a shell command in the site's container, run as www-data in the WordPress folder",
        input: '{command: "ls -la wp-content", timeoutMin?: 1-60}',
        returns: '202 {job}; output in the job log',
        job: true,
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/rest',
        summary: "Call one of the site's WordPress REST API routes, optionally signed in with an application password",
        input: '{method?: "GET", route: "wp/v2/posts?per_page=5", body?, auth?: {username, applicationPassword}, async?, timeoutMin?: 1-60}',
        returns: '{status, statusText, contentType, headers, body, truncated, sizeBytes, durationMs, error} (sync, 45s cap) | 202 {job} (async; the answer in the job log)',
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/wp/test-email',
        summary: 'Send a real wp_mail() test message',
        input: '{to}',
        returns: '{accepted, detail}',
        level: 'manage',
      },
    ],
  },
  {
    id: 'files',
    title: 'Files (Web FTP)',
    changes: 'manage',
    intro:
      "A site's files, relative to its WordPress folder (`path=''` is the folder itself). Everything runs inside the site's own container as www-data, so it can do what the site's own PHP can, no more.",
    endpoints: [
      {
        method: 'GET',
        path: '/api/sites/:slug/files',
        summary: 'List a folder: names, sizes, dates, permissions, owners, link targets',
        input: '?path=wp-content',
        returns: '{path, writable, entries[], truncated} (409 when stopped)',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/files/content',
        summary: 'Read a file of up to 8 MiB, with its ETag for a later save',
        input: '?path=wp-config.php',
        returns: 'the bytes, ETag: "<sha256>"',
        note: 'Raw bytes - fetch them with curl rather than the console',
        level: 'manage',
        levelReason: 'Reads any file - wp-config.php and its database password included',
        mcp: 'file',
      },
      {
        method: 'PUT',
        path: '/api/sites/:slug/files/content',
        summary: 'Save a whole file (up to 8 MiB); If-Match makes it conditional, If-None-Match: * create-only',
        input: '?path=…&lint=php, body: the bytes (application/octet-stream)',
        returns: '{path, entry, etag}; 412 when the file changed, 422 when lint finds a PHP parse error',
        danger: true,
        note: 'Raw body - send it with curl --data-binary rather than the console',
        level: 'manage',
        mcp: 'file',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/files/download',
        summary: 'Download a file, or a folder as .tar.gz',
        input: '?path=wp-content/themes/mytheme',
        returns: 'an attachment (3 at a time per server)',
        note: 'Binary stream - fetch it with curl rather than the console',
        level: 'manage',
        levelReason: 'Downloads any file or folder, secrets included',
        mcp: false,
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/files/search',
        summary: 'Find files by name, or search their contents (plain text or a regex)',
        input: '?path=&q=eval(base64_decode&mode=name|content&case=&regex=&include=*.php',
        returns: '{mode, path, matches[], truncated, timedOut} (30/min)',
        level: 'manage',
        levelReason: 'A content search returns the matching lines of any file',
      },
      {
        method: 'PUT',
        path: '/api/sites/:slug/files/uploads/:id',
        summary: 'Upload one chunk (up to 8 MiB) of a file; the chunk that completes it puts the file in place',
        input: '?path=…&offset=0&size=<total>&overwrite=false, body: the chunk',
        returns: '{received, written}; 409 {details.received} to resume from; the last chunk sent again gets the same answer',
        danger: true,
        note: 'Raw body - see docs/web-ftp.md for the upload protocol',
        level: 'manage',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/sites/:slug/files/uploads/:id',
        summary: 'Abandon an upload and remove what arrived of it',
        input: '?path=…',
        level: 'manage',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/files/mkdir',
        summary: 'Create a folder',
        input: '{path}',
        returns: '{entry}',
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/files/move',
        summary: 'Rename or move a file or folder',
        input: '{from, to, overwrite?: false}',
        returns: '{entry}',
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/files/copy',
        summary: 'Copy a file or folder (never over an existing entry)',
        input: '{from, to}',
        returns: '{entry}',
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/files/delete',
        summary: 'Delete files and folders; checks them all first, so one bad path deletes nothing',
        input: '{paths: [...]} (up to 200)',
        returns: '{deleted}',
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/files/chmod',
        summary: 'Change the permissions of a file or folder',
        input: '{path, mode: "644"}',
        returns: '{entry}',
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/files/fix-ownership',
        summary: 'Give everything under a path back to the site user (www-data), e.g. files root created',
        input: "{path?: ''}",
        returns: '{ok}',
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/files/extract',
        summary: 'Extract a .zip into a folder; refuses unsafe archives, and anything in the way unless overwrite',
        input: "{path, to?: '', overwrite?: false}",
        job: true,
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/files/compress',
        summary: 'Compress entries of one folder into a .zip beside them',
        input: '{paths: [...], to: "folder/archive.zip", overwrite?: false}',
        job: true,
        danger: true,
        level: 'manage',
      },
    ],
  },
  {
    id: 'ftp',
    title: 'FTP & SFTP logins',
    changes: 'manage',
    intro:
      "Logins for desktop FTP and SFTP clients, each kept to one site's files. There are none by default, and nothing FTP runs on a server until one of its sites has a login.",
    endpoints: [
      {
        method: 'GET',
        path: '/api/sites/:slug/ftp',
        summary: "How to connect (host, ports, fingerprints), the server's FTP status, and the site's logins",
        returns: '{enabled, serverId, serverName, endpoint, status, applied, paused, users[]}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/ftp/users',
        summary: 'Create a login; leave out the password to have one generated and returned this once',
        input: '{username, password?, folder?: "", expiresAt?: <unix ms>|null}',
        returns: '201 {user, password} (password null when you chose it); 409 when the username is taken',
        level: 'manage',
      },
      {
        method: 'PATCH',
        path: '/api/sites/:slug/ftp/users/:id',
        summary: "Move a login to another folder or change its expiry; ends the site's open FTP sessions",
        input: '{folder?, expiresAt?}',
        returns: '{user}',
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/ftp/users/:id/password',
        summary: "Set a new password, or leave it out to have one generated; ends the site's open FTP sessions",
        input: '{password?}',
        returns: '{user, password}',
        danger: true,
        level: 'manage',
      },
      {
        method: 'DELETE',
        path: '/api/sites/:slug/ftp/users/:id',
        summary: "Delete a login; it cannot sign in again, and the site's open FTP sessions end",
        danger: true,
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/servers/:id/ftp',
        summary: "A server's FTP gateway: status, ports, fingerprints and how many logins it serves",
        returns: '{serverId, enabled, endpoint, status, sites, logins, activeLogins}',
        level: 'read',
      },
    ],
  },
  {
    id: 'fleet',
    title: 'WordPress across the fleet',
    changes: 'manage',
    intro: 'One table of every plugin, theme and core version on every server, and one bulk run over the selection.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/wp/inventory',
        summary: 'One row per component with its per-site rows, updates and severities',
        input: '?kind=plugin|theme|core&filter=updates,vulnerable,inactive,closed&q=&serverId=&siteSlug=&includeStopped=',
        returns: '{rows[], fleet, feed, scanJob}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/wp/bulk',
        summary: 'Run one action over many sites as a batch - one job per site',
        input: '{action, targets: [{siteSlug, kind, slug?}], backupFirst?: false, healthCheck?: true}',
        returns: '202 {batch, jobs[], skipped[]}',
        job: true,
        danger: true,
        level: 'manage',
      },
      { method: 'GET', path: '/api/wp/batches', summary: 'Recent bulk runs with rolled-up job counts', input: '?limit=10', level: 'read' },
      {
        method: 'GET',
        path: '/api/wp/batches/:id',
        summary: 'One batch and all of its jobs - one poll drives a progress table',
        returns: '{batch, jobs}',
        level: 'read',
      },
      { method: 'POST', path: '/api/wp/scan', summary: 'Refresh the whole fleet snapshot', job: true, level: 'manage' },
    ],
  },
  {
    id: 'security',
    title: 'Site protection and malware scans',
    changes: 'manage',
    intro:
      "Each site's firewall rules and rate limits, the requests they blocked, and its malware scans: findings, Reinstall original and quarantine. See docs/security.md.",
    endpoints: [
      {
        method: 'GET',
        path: '/api/security/overview',
        summary: 'The default protection, every site on one row, and each server\'s rules folder',
        returns: 'SecurityOverviewDto',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/security/sync',
        summary: "Put every server's rules and blocked addresses in line now rather than within the minute",
        returns: 'SecurityOverviewDto',
        level: 'manage',
      },
      { method: 'GET', path: '/api/security/scans', summary: 'Every site with its scan settings, last scan and open findings', returns: '{items[], inFlight}', level: 'read' },
      {
        method: 'POST',
        path: '/api/security/scans',
        summary: 'Scan these sites now (or every site that is scanned) - one scan per site at a time',
        input: '{slugs?: string[]}',
        returns: '{queued: slug[], already: slug[]}',
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/security',
        summary: "A site's protection: its own settings, what is in force and why, and the requests it blocked",
        returns: 'SiteSecurityDto',
        level: 'read',
      },
      {
        method: 'PUT',
        path: '/api/sites/:slug/security',
        summary: "Change a site's own protection; each part left out stays as it is",
        input: '{level?: "off"|"standard"|"strict"|null, overrides?, customRules?: [{id?, action: "block"|"allow", match: "all"|"any", conditions[], note?, enabled?}]}',
        returns: 'SiteSecurityDto',
        danger: true,
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/security/blocked',
        summary: 'The latest requests the site\'s protection blocked, and 7 days of counts per rule',
        input: '?limit=100&rule=',
        returns: '{items: BlockedRequestDto[], counts7d}',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/security/scan',
        summary: 'Scan settings, the last scan and the ones before it',
        returns: '{scan: SiteScanDto, history: ScanDto[]}',
        level: 'read',
      },
      { method: 'POST', path: '/api/sites/:slug/security/scan', summary: 'Scan the site now', job: true, level: 'manage' },
      {
        method: 'PUT',
        path: '/api/sites/:slug/security/scan/settings',
        summary: "The site's own scan settings; null follows the fleet's",
        input: '{enabled?: boolean|null, onFinding?: "report"|"quarantine-confirmed"|"quarantine-all"|null}',
        returns: 'SiteScanDto',
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/security/findings',
        summary: 'What the scans found, the most serious first',
        input: '?status=open|ignored|resolved|quarantined|all (default open)',
        returns: '{items: FindingDto[], counts}',
        level: 'read',
      },
      { method: 'POST', path: '/api/sites/:slug/security/findings/:id/ignore', summary: 'Ignore a finding; it stays ignored until its file changes', level: 'manage' },
      { method: 'POST', path: '/api/sites/:slug/security/findings/:id/unignore', summary: 'Take an ignored finding back', level: 'manage' },
      { method: 'POST', path: '/api/sites/:slug/security/findings/:id/resolve', summary: 'Mark a finding dealt with; a scan reopens it if it comes back', level: 'manage' },
      {
        method: 'POST',
        path: '/api/sites/:slug/security/findings/:id/reinstall',
        summary: 'Reinstall original: download WordPress or the plugin again at its version, then scan again',
        job: true,
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/security/findings/:id/put-back',
        summary: 'Put back a changed WPL7 file (the site must be running), then scan again',
        job: true,
        danger: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/sites/:slug/security/findings/:id/quarantine',
        summary: "Move the finding's file out of the site, into its quarantine",
        returns: 'QuarantineItemDto',
        danger: true,
        level: 'manage',
      },
      { method: 'GET', path: '/api/sites/:slug/security/quarantine', summary: 'Files moved out of the site, kept, restored or deleted', returns: '{items: QuarantineItemDto[]}', level: 'read' },
      {
        method: 'POST',
        path: '/api/sites/:slug/security/quarantine/:id/restore',
        summary: 'Put a quarantined file back where it was; its findings become ignored',
        returns: 'QuarantineItemDto',
        danger: true,
        level: 'manage',
      },
      {
        method: 'DELETE',
        path: '/api/sites/:slug/security/quarantine/:id',
        summary: 'Delete a quarantined file for good',
        returns: 'QuarantineItemDto',
        danger: true,
        level: 'manage',
      },
    ],
  },
  {
    id: 'backups',
    title: 'Backups',
    changes: 'manage',
    intro: 'Backups live on the server that holds the site. Offsite copies are made by that same server.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/backups',
        summary: "Every backup on every server, newest first - deleted sites' and the panel's own included",
        input: '?siteSlug=&deleted=true|false&type=&serverId=&limit=&offset=',
        returns: '{items: Backup[] (+ siteTitle, siteDeleted), total, deletedSites}',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/sites/:slug/backups',
        summary: 'Backups of one site, each with its offsite copies',
        returns: '{items: Backup[]}',
        level: 'read',
      },
      { method: 'POST', path: '/api/sites/:slug/backups', summary: 'Back this site up now', input: '{note?}', job: true, level: 'manage' },
      {
        method: 'POST',
        path: '/api/backups/:id/restore',
        summary: 'Restore a backup over the live site',
        input: '{skipPreRestoreBackup?: false}',
        job: true,
        danger: true,
        level: 'manage',
      },
      {
        method: 'GET',
        path: '/api/backups/:id/download',
        summary: 'Download the archive',
        returns: 'tar stream',
        note: 'Binary stream - fetch it with curl rather than the console',
        level: 'manage',
        levelReason: "Holds the site's database and wp-config.php; a panel snapshot needs Full",
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/backups/:id/offsite',
        summary: 'Copy this backup offsite now, or retry a copy that gave up',
        input: '{destinationId?}',
        job: true,
        level: 'manage',
      },
      {
        method: 'POST',
        path: '/api/backups/:id/fetch',
        summary: 'Pull an offsite copy back onto the site\'s current server',
        input: '{destinationId}',
        job: true,
        level: 'manage',
      },
      {
        method: 'DELETE',
        path: '/api/backups/:id',
        summary: 'Delete a backup and, unless told otherwise, its offsite copies',
        input: '?keepOffsite=true|false (default false)',
        danger: true,
        level: 'full',
        levelReason: 'A backup is the safety net, so removing one is Full',
      },
      {
        method: 'GET',
        path: '/api/backups/ids',
        summary: 'The ids of every backup some filters match that a bulk delete could take, across all pages',
        input: '?siteSlug=&deleted=true|false&type=&serverId= (as GET /api/backups)',
        returns: '{items: [{id, siteSlug, siteDeleted, status, remoteCopies}], total} - newest first, at most 5000',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/backups/bulk-delete',
        summary: 'Delete several backups and their offsite copies, named by id',
        input: '{ids: [id, ...]} (at most 5000; GET /api/backups/ids turns filters into ids)',
        returns: '{job, count}',
        job: true,
        danger: true,
        level: 'full',
        levelReason: 'A backup is the safety net, so removing one is Full',
      },
      {
        method: 'GET',
        path: '/api/backups/overview',
        summary: 'Offsite health: destinations, last success, 24h counters, failures',
        level: 'read',
      },
    ],
  },
  {
    id: 'destinations',
    title: 'Offsite destinations',
    changes: 'full',
    intro:
      'Credentials are write-only: they go in with `secrets` and read back as `secretsSet` - the names on file, never the values.',
    endpoints: [
      { method: 'GET', path: '/api/backup-destinations', summary: 'List destinations', returns: '{items}', level: 'read' },
      {
        method: 'POST',
        path: '/api/backup-destinations',
        summary: 'Add a destination; with encryption on, the passphrase comes back exactly once',
        input: '{name, provider, config, secrets, enabled?, copyTypes?, retention*, encryption?, backfill?}',
        returns: '201 Destination',
        level: 'full',
      },
      {
        method: 'POST',
        path: '/api/backup-destinations/test',
        summary: 'Probe unsaved credentials: listing, write, delete',
        returns: '{ok, checks[]}',
        level: 'full',
      },
      { method: 'POST', path: '/api/backup-destinations/:id/test', summary: 'The same with the stored credentials', level: 'manage', levelReason: 'Only tests the stored credentials; changes nothing' },
      {
        method: 'PATCH',
        path: '/api/backup-destinations/:id',
        summary: 'Change a destination (provider is immutable; encryption is fixed once a copy exists)',
        danger: true,
        level: 'full',
      },
      {
        method: 'POST',
        path: '/api/backup-destinations/:id/passphrase',
        summary: 'Read the crypt passphrase back - the one endpoint that returns a stored secret',
        returns: '{password, salt}',
        danger: true,
        level: 'full',
      },
      {
        method: 'GET',
        path: '/api/backup-destinations/:id/copies',
        summary: 'Copies made to this destination',
        input: '?status=&limit=&offset=',
        level: 'read',
      },
      {
        method: 'DELETE',
        path: '/api/backup-destinations/:id',
        summary: 'Forget a destination; with deleteRemote, purge what this panel wrote there',
        input: '?deleteRemote=true|false (default false)',
        danger: true,
        level: 'full',
      },
    ],
  },
  {
    id: 'servers',
    title: 'Servers',
    changes: 'full',
    intro: 'Register machines you provisioned, or hand the panel a blank VPS and let it do it.',
    endpoints: [
      { method: 'GET', path: '/api/servers', summary: 'Every server with status, site count and host key', level: 'read' },
      {
        method: 'POST',
        path: '/api/servers',
        summary: 'Register a server, or provision a blank VPS over SSH',
        input: '{name, sshHost, sshPort?, sshUser?, devDomain, dnsProvider?, publicIp?, provision?, acmeEmail?}',
        returns: '201 {server, checks, job} | 202 when provisioning',
        danger: true,
        level: 'full',
      },
      {
        method: 'GET',
        path: '/api/servers/ssh-public-key',
        summary: 'The key to authorize on a new machine',
        returns: '{publicKey}',
        level: 'read',
      },
      { method: 'GET', path: '/api/servers/:id', summary: 'One server', level: 'read' },
      {
        method: 'GET',
        path: '/api/servers/:id/info',
        summary: 'What the machine is: OS, kernel, CPU, memory, uptime, Docker version',
        input: '?refresh=true skips the one-minute cache',
        returns: '{reachable, os, kernel, arch, cpus, memTotalBytes, uptimeSeconds, dockerVersion, …}',
        level: 'read',
      },
      {
        method: 'PATCH',
        path: '/api/servers/:id',
        summary: 'Edit a server, re-trust its host key, or set where it keeps backups',
        input: '{name?, sshHost?, sshPort?, sshUser?, publicIp?, devDomain?, dnsProvider?, retrustHostKey?, backupRoot?}',
        danger: true,
        level: 'full',
      },
      { method: 'POST', path: '/api/servers/:id/test', summary: 'Re-verify the connection now', returns: '{ok, checks}', level: 'manage', levelReason: 'Only re-checks the connection; changes nothing' },
      {
        method: 'POST',
        path: '/api/servers/:id/update',
        summary: 'Re-push the provision bundle and re-run setup.sh',
        input: '{rootUser?: "root"}',
        job: true,
        danger: true,
        level: 'full',
      },
      {
        method: 'GET',
        path: '/api/servers/:id/storage',
        summary: 'Where backups live on this server, and whether a candidate path would work',
        input: '?path= to validate instead',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/servers/:id/backups/relocate',
        summary: 'Copy every backup to a new location, verify, remove the originals',
        input: '{to}',
        job: true,
        danger: true,
        level: 'full',
      },
      {
        method: 'GET',
        path: '/api/servers/:id/terminal',
        summary: 'Interactive root shell',
        input: '?cols=&rows=',
        note: 'Websocket upgrade - not callable from the test console',
        danger: true,
        level: 'full',
        levelReason: 'A root shell on the server',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/servers/:id',
        summary: 'Remove a server (refused while sites live on it; server 1 never)',
        input: '?force=true',
        danger: true,
        level: 'full',
      },
      {
        method: 'GET',
        path: '/api/monitor/overview',
        summary: 'Per-server load/memory/disk and per-site up/CPU/memory/disk',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/monitor/servers/:id/history',
        summary: 'Server resource history for charts',
        input: '?hours=1..168',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/monitor/sites/:slug/history',
        summary: 'Site resource history for charts',
        input: '?hours=1..168',
        level: 'read',
      },
    ],
  },
  {
    id: 'dns',
    title: 'DNS',
    changes: 'full',
    intro:
      "The Cloudflare token the panel writes records with, and which every server's Traefik gets a wildcard certificate with. No answer ever contains it.",
    endpoints: [
      {
        method: 'GET',
        path: '/api/dns',
        summary: "Whether a token is set, and each server's wildcard certificate and Traefik",
        returns: '{provider, token: {configured, setAt, envDiffers}, wildcardServerId, servers[]}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/dns/check',
        summary: 'What a token reaches - the one given, or the stored one - without keeping it',
        input: '{token?}',
        returns: '{ok, error, zones[], zoneCount, devDomains[]}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'PUT',
        path: '/api/dns/token',
        summary: "Replace the token; refused unless Cloudflare takes it. Every server's Traefik gets it",
        input: '{token}',
        returns: '{...GET /api/dns, check}',
        danger: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/dns/token',
        summary: 'Remove the token; dev sites sharing a wildcard certificate get their own',
        returns: '{...GET /api/dns, rebuilding[], busy[]} - one site.reconcile per rebuilt site',
        danger: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'PUT',
        path: '/api/dns/servers/:id/wildcard',
        summary: "Switch a server's wildcard certificate; off rebuilds the dev sites that share it",
        input: '{on: boolean}',
        returns: "{...GET /api/dns, rebuilding[], busy[]}; 409 when the token does not reach the dev domain's records",
        danger: true,
        level: 'full',
      },
    ],
  },
  {
    id: 'blocklist',
    title: 'Blocked addresses',
    changes: 'full',
    intro:
      'Addresses refused on every server - by the network firewall for direct visitors, by Traefik behind a trusted proxy - and those that never are.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/security/blocks',
        summary: 'Blocks in force, or the history, newest first',
        input: '?state=active|history&q=&limit=100&offset=0',
        returns: 'SecurityBlockListDto',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/security/blocks',
        summary: 'Block an address or a range on every server; refused, with the reason, for one that is never blocked',
        input: '{address, minutes?: number|null (null: until lifted), note?, siteSlug?}',
        returns: '201 SecurityBlockDto',
        level: 'full',
      },
      { method: 'DELETE', path: '/api/security/blocks/:id', summary: 'Lift a block; it does not count as a repeat', returns: 'SecurityBlockDto', danger: true, level: 'full' },
      {
        method: 'GET',
        path: '/api/security/never-block',
        summary: 'The never-block list, and the addresses admins used the panel from in the last 30 days',
        returns: '{items: NeverBlockDto[], admins: AdminAddressDto[]}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/security/never-block',
        summary: 'Never block an address or a range; blocks on it are lifted',
        input: '{address, note?}',
        returns: '201 NeverBlockDto',
        danger: true,
        level: 'full',
      },
      { method: 'DELETE', path: '/api/security/never-block/:id', summary: 'Take an address off the never-block list', danger: true, level: 'full' },
      { method: 'GET', path: '/api/security/firewall', summary: 'Where every server stands: network layer loaded, HTTP only, off, not installed', returns: 'FirewallOverviewDto', level: 'read' },
      { method: 'POST', path: '/api/security/firewall/sync', summary: 'Load the list on every server now', returns: 'FirewallOverviewDto', level: 'full' },
      {
        method: 'GET',
        path: '/api/security/check',
        summary: 'Could this address be blocked - and if not, why not; is it blocked, and by which block',
        input: '?address=',
        returns: 'SecurityCheckDto',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/security/detection',
        summary: 'The detector: its mode, the addresses it watches, and its recent decisions - including why it did not block',
        returns: 'SecurityDetectionDto',
        level: 'read',
      },
    ],
  },
  {
    id: 'mail',
    title: 'Mail',
    changes: 'full',
    intro: 'One relay per server, every message logged, and the SPF/DKIM/DMARC records checked against live DNS.',
    endpoints: [
      { method: 'GET', path: '/api/mail/status', summary: 'Relay and signer health, queue depth, reverse-DNS verdicts', level: 'read' },
      {
        method: 'GET',
        path: '/api/mail/messages',
        summary: 'Sent mail, one row per recipient',
        input: '?siteSlug=&status=&serverId=&search=&hours=&limit=&offset=',
        level: 'read',
      },
      { method: 'GET', path: '/api/mail/stats', summary: 'Totals by status, per-hour buckets, per-site volume', input: '?hours=24', level: 'read' },
      { method: 'POST', path: '/api/mail/ingest', summary: 'Parse the relay logs now instead of waiting a minute', level: 'manage', levelReason: 'Only does now what the panel does every minute' },
      { method: 'GET', path: '/api/mail/queue', summary: 'The postfix queue with a deferral reason per recipient', input: '?serverId=', level: 'read' },
      { method: 'POST', path: '/api/mail/queue/:serverId/flush', summary: 'Retry the whole queue now', level: 'manage', levelReason: 'Only retries the mail already queued' },
      {
        method: 'DELETE',
        path: '/api/mail/queue/:serverId/:queueId',
        summary: 'Drop one queued message; queueId=ALL empties the queue',
        danger: true,
        level: 'full',
      },
      {
        method: 'POST',
        path: '/api/mail/test',
        summary: 'Inject a message into the relay, bypassing WordPress',
        input: '{from, to, serverId?, subject?}',
        level: 'full',
      },
      { method: 'GET', path: '/api/mail/setup', summary: 'The whole setup guide: mode, rDNS, ports, per-domain record plan', level: 'read' },
      {
        method: 'GET',
        path: '/api/mail/domains',
        summary: 'Per-domain SPF/DKIM/DMARC against live DNS, plus the records to publish',
        input: '?domain=',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/mail/domains/:domain/publish',
        summary: 'Publish what can be published safely (SPF merged, DKIM generated, DMARC left alone)',
        danger: true,
        level: 'full',
      },
      { method: 'POST', path: '/api/mail/domains/:domain/check', summary: 'Re-check one domain', level: 'manage', levelReason: 'Only re-checks DNS; changes nothing' },
      {
        method: 'PUT',
        path: '/api/mail/servers/:serverId/hostname',
        summary: 'Change the name the relay announces (applied live, queue untouched)',
        input: '{hostname}',
        level: 'full',
      },
      {
        method: 'DELETE',
        path: '/api/mail/servers/:serverId/hostname',
        summary: 'Put the relay back on its default name, MAIL_HOSTNAME (applied live)',
        level: 'full',
      },
      {
        method: 'POST',
        path: '/api/mail/servers/:serverId/publish-hostname',
        summary: 'Point the relay hostname\'s A record at that server',
        danger: true,
        level: 'full',
      },
      { method: 'GET', path: '/api/mail/dkim', summary: 'DKIM keys with their DNS record values', level: 'read' },
      {
        method: 'POST',
        path: '/api/mail/dkim',
        summary: 'Generate (or rotate) a key, push it to every server, restart the signers',
        input: '{domain, rotate?}',
        danger: true,
        level: 'full',
      },
      { method: 'POST', path: '/api/mail/dkim/sync', summary: 'Re-materialize every key on every server', level: 'manage', levelReason: 'Only re-copies the keys the panel already holds' },
      { method: 'DELETE', path: '/api/mail/dkim/:domain', summary: 'Delete a key and its files', danger: true, level: 'full' },
    ],
  },
  {
    id: 'plugins',
    title: 'Plugin catalog',
    changes: 'full',
    intro: 'The set offered in the new-site wizard: wordpress.org slugs and uploaded zips.',
    endpoints: [
      { method: 'GET', path: '/api/plugins', summary: 'The catalog', level: 'read' },
      {
        method: 'POST',
        path: '/api/plugins',
        summary: 'Add a wordpress.org plugin (the slug is verified unless force)',
        input: '{kind:"wporg", slug, name?, isDefault?, force?}',
        level: 'full',
      },
      {
        method: 'POST',
        path: '/api/plugins/upload',
        summary: 'Upload a zip into the catalog',
        input: 'multipart file, <=100MB',
        note: 'Multipart - not callable from the test console',
        level: 'full',
        mcp: false,
      },
      {
        method: 'GET',
        path: '/api/plugins/search',
        summary: 'Search the wordpress.org directory (backs the typeahead)',
        input: '?q= (>=2 chars) &page=',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/plugins/:id/check',
        summary: "An uploaded zip's malware check: its files, and what AMWScan found in them",
        returns: '{check: {status, checking, folder, version, files, flagged, confirmed, problem, checkedAt, reviewed, needsReview} | null, findings: [{path, kind, label, severity, rule, line, detail}]}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/plugins/:id/check',
        summary: 'Check an uploaded zip again (uploads are checked on their own, and again when AMWScan changes)',
        job: true,
        level: 'full',
      },
      {
        method: 'POST',
        path: '/api/plugins/:id/check/review',
        summary: "Say the files a zip's check flagged are the plugin's own, so sites' unchanged copies of them are vouched for",
        returns: '{check} - the review holds for exactly those findings; a check that finds anything else asks again',
        level: 'full',
      },
      { method: 'PUT', path: '/api/plugins/:id', summary: 'Rename a catalog entry or change its default flag', input: '{name?, isDefault?}', level: 'full' },
      { method: 'DELETE', path: '/api/plugins/:id', summary: 'Remove a catalog entry', danger: true, level: 'full' },
    ],
  },
  {
    id: 'recipes',
    title: 'Plugin recipes',
    changes: 'full',
    intro:
      'How the panel activates pro-plugin licenses (docs/licenses.md). Recipes come from the public catalog, the bundled files or your own JSON; what you enter for their inputs is stored per recipe, and secret inputs such as license keys are never returned.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/recipes',
        summary: 'Every recipe the panel knows, whether it is installed and enabled, and what is entered for its inputs',
        returns: '{items: [{id, name, plugin, version, source, installed, enabled, sites, inPluginCatalog, inputs: [{id, label, secret, set, display, ...}], ...}]}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/recipes/local',
        summary: 'Add or replace a recipe of your own; installed and enabled at once, shadows a catalog id',
        input: '{recipe}',
        danger: true,
        level: 'full',
      },
      {
        method: 'GET',
        path: '/api/recipes/:id/definition',
        summary: 'The recipe as the panel has it, to copy or fork',
        returns: 'the recipe JSON',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/recipes/:id/install',
        summary: 'Take a known recipe into use; a catalog recipe keeps following the catalog',
        level: 'full',
      },
      {
        method: 'DELETE',
        path: '/api/recipes/:id/install',
        summary: 'Stop using a recipe and forget its key; a local recipe is deleted outright',
        danger: true,
        level: 'full',
      },
      {
        method: 'PUT',
        path: '/api/recipes/:id/enabled',
        summary: 'Switch an installed recipe off or on without uninstalling it',
        input: '{enabled}',
        level: 'full',
      },
      {
        method: 'PUT',
        path: '/api/recipes/:id/inputs/:input',
        summary: 'Enter the value for one of a recipe\'s inputs, such as its license key (write-only when secret)',
        input: '{value}',
        danger: true,
        level: 'full',
      },
      { method: 'DELETE', path: '/api/recipes/:id/inputs/:input', summary: 'Forget the value entered for an input', danger: true, level: 'full' },
      {
        method: 'GET',
        path: '/api/catalog',
        summary: 'The public recipe catalog as this panel sees it: entries, last fetch, last error',
        returns: '{url, entries, unsupported, generatedAt, commit, fetchedAt, changedAt, error, keyId, recipes}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/catalog/refresh',
        summary: 'Fetch and verify the catalog now, ignoring the cached ETag',
        returns: '{outcome: "updated"|"unchanged"|"failed"|"disabled", catalog} (sync, <=15 s)',
        level: 'manage',
        levelReason: 'Only fetches the signed catalog now instead of within the hour',
      },
    ],
  },
  {
    id: 'jobs',
    title: 'Jobs',
    changes: 'manage',
    intro: 'Every 202 lands here. Poll with `logAfter` and use the returned `lastSeq` as the next cursor.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/jobs',
        summary: 'Jobs, newest first; status, type, category and origin take comma lists',
        input: '?q=&status=&type=&category=&origin=&siteSlug=&serverId=&scheduleId=&batchId=&since=&until=&limit=&offset=',
        returns: '{items, total, counts (per status), retentionDays}',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/jobs/types',
        summary: 'Every job type with its name, description, category and time limit',
        returns: '{items: [{type, label, description, category, internal, timeoutMs}]}',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/jobs/:id',
        summary: 'One job plus the log lines after a cursor',
        input: '?logAfter=<seq>',
        returns: '{job, logs[], lastSeq}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/jobs/:id/cancel',
        summary: 'Cancel a queued job, or ask a running one to stop',
        danger: true,
        level: 'manage',
      },
    ],
  },
  {
    id: 'schedules',
    title: 'Schedules',
    changes: 'manage',
    intro:
      'What runs on its own - the built-in tasks and your custom schedules - with pause, resume and run now. `:id` also takes a built-in key such as `wp-scan`.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/schedules',
        summary: 'Every schedule: built-in jobs, background tasks and custom ones, with next and last run',
        returns: '{items: ScheduleDto[]}',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/schedules/actions',
        summary: 'What a custom schedule can do, with JSON Schemas for its params, target and body',
        returns: '{actions: [{action, label, targets, jobType, paramsSchema}], targetSchema, createBodySchema, …}',
        level: 'read',
      },
      { method: 'GET', path: '/api/schedules/:id', summary: 'One schedule', returns: '{schedule}', level: 'read' },
      {
        method: 'POST',
        path: '/api/schedules',
        summary: 'Create a custom schedule: an action, a target, and a cron (repeat) or runAt (once)',
        input: '{name, action, target: {kind: "sites", slugs}, params, cron: "0 3 * * *" | runAt, enabled?}',
        returns: '201 {schedule}',
        danger: true,
        level: 'manage',
      },
      {
        method: 'PATCH',
        path: '/api/schedules/:id',
        summary: 'Pause or resume ({enabled}); a custom schedule also takes any field of the create body',
        input: '{enabled: false} (a built-in one needs Full: it pauses backups, scans, housekeeping)',
        returns: '{schedule}',
        danger: true,
        level: 'manage',
      },
      { method: 'DELETE', path: '/api/schedules/:id', summary: 'Delete a custom schedule', danger: true, level: 'manage' },
      {
        method: 'POST',
        path: '/api/schedules/:id/run',
        summary: 'Run a schedule now, paused or not',
        returns: '202 {jobs, skipped, running}; Location when it queued exactly one job',
        danger: true,
        level: 'manage',
      },
    ],
  },
  {
    id: 'panel',
    title: 'Panel, settings and keys',
    changes: 'full',
    intro: 'What the pickers offer, what the schedules are, and the credentials this page manages.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/health',
        summary: 'Liveness probe',
        returns: '{ok: true}',
        open: true,
        level: 'read',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/feedback',
        summary: "Send a question or an idea to this install's community; bugs go to GitHub from the browser",
        input: '{summary, details, environment?}',
        returns: '{ok: true}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'GET',
        path: '/api/meta',
        summary: 'PHP versions, locales, servers, dev domain, timezone - what the forms are built from',
        level: 'read',
      },
      { method: 'GET', path: '/api/settings', summary: 'Every panel setting', returns: '{settings}', level: 'read' },
      {
        method: 'PUT',
        path: '/api/settings',
        summary: 'Change settings: schedules, retentions, limits, site defaults',
        input: 'any subset of the settings object',
        // Not `job: true`: the answer is a 200, and usually with no jobs in it.
        returns: '{settings, jobs[]} - jobs: one per server when a site container limit changed',
        danger: true,
        level: 'full',
      },
      {
        method: 'GET',
        path: '/api/api-keys',
        summary: 'Your API keys (never the tokens)',
        level: 'read',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/api-keys',
        summary: 'Create a key - the token is in this response and nowhere else',
        input: '{name}',
        returns: '201 {token, ...}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/api-keys/:id',
        summary: 'Revoke a key immediately',
        danger: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'GET',
        path: '/api/api-keys/activity',
        summary: 'The API request log behind the Activity tab',
        input: '?keyId=&outcome=ok|error|denied&method=&search=&hours=&limit=&offset=',
        returns: '{items, total, last24h, retentionDays, maxRows}',
        level: 'read',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/api-keys/activity',
        summary: 'Empty the request log now',
        returns: '{removed}',
        danger: true,
        level: 'full',
        mcp: false,
      },
    ],
  },
  {
    id: 'mcp',
    title: 'MCP connections',
    changes: 'full',
    intro:
      'The MCP server for AI apps (docs/mcp.md): the connection window an app signs in through, and the apps connected. None of it is reachable over MCP itself.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/mcp',
        summary: 'Whether MCP is on, its URL, the connection window, the connected apps and their recent calls',
        returns: '{enabled, unavailable, url, window, connections[], activity[]}',
        level: 'read',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/mcp/connect-window',
        summary: 'Open ten minutes in which one app may register and you may approve it; browser session only',
        returns: '{window}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/mcp/connect-window',
        summary: 'Close the connection window; browser session only',
        level: 'full',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/mcp/connect-window/registration',
        summary: 'Forget the app that registered in your window and keep the window open; browser session only',
        level: 'full',
        mcp: false,
      },
      {
        method: 'PATCH',
        path: '/api/mcp/connections/:id',
        summary: "Change a connected app's access; its very next call has the new level",
        input: '{access: "read"|"manage"|"full"}',
        returns: '{connection}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/mcp/connections/:id',
        summary: 'Disconnect an app: its tokens stop working at once',
        danger: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/oauth/authorize/check',
        summary: 'What the approval page shows for an app asking to connect; browser session only',
        input: '{query}',
        returns: '{status: "ready"|"closed"|"error", ...}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/oauth/authorize/decision',
        summary: 'Approve or decline the app at the level chosen; browser session only',
        input: '{query, approve, access?: "read"}',
        returns: '{redirectTo}',
        level: 'full',
        mcp: false,
      },
    ],
  },
  {
    id: 'system',
    title: 'This install, and updating it',
    changes: 'full',
    intro:
      'What this install is, the release the hourly check found, and applying it (docs/updating.md). Writes are refused with 503 while an update is in flight.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/system/version',
        summary: 'This version and channel, the newest known release, and when it was last checked',
        returns: '{version, gitSha, channel, source, latest, updateAvailable, checkedAt, nextCheckAt, error}',
        level: 'read',
      },
      {
        method: 'GET',
        path: '/api/system/about',
        summary: 'Where this install came from and what it runs on - the About page in one call',
        returns: '{repoUrl, host, publicIp, reverseDns, communityUrl, panelDomain, node, panelUptimeSeconds}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/system/update/check',
        summary: 'Ask GitHub now instead of waiting for the hourly check',
        returns: 'the same object as GET /api/system/version',
        level: 'manage',
        levelReason: 'Only asks GitHub now instead of within the hour',
      },
      {
        method: 'POST',
        path: '/api/system/update',
        summary: 'Apply the release the check found; the panel goes away and comes back',
        input: '{version}',
        returns: '202 {unit, version}',
        danger: true,
        level: 'full',
      },
      {
        method: 'GET',
        path: '/api/system/update/status',
        summary: 'Progress, log tail and history - keep polling through the gap where nothing answers',
        returns: '{running, maintenance, state, log, history}',
        level: 'read',
      },
      {
        method: 'POST',
        path: '/api/system/update/post-update',
        summary: 'Re-run the follow-up tasks of the last applied update',
        job: true,
        level: 'full',
      },
    ],
  },
  {
    id: 'auth',
    title: 'Panel login',
    changes: 'full',
    intro:
      'The browser session, not the API. A key needs none of this: it is a separate credential that two-factor never gates.',
    endpoints: [
      {
        method: 'POST',
        path: '/api/auth/login',
        summary: 'Sign in; totpRequired means the cookie is only half a login',
        input: '{username, password}',
        open: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/auth/login/totp',
        summary: 'Finish a half-login with a code or recovery code',
        input: '{code}',
        open: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/auth/logout',
        summary: 'End this session',
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/auth/forgot-password',
        summary: 'Email a reset link to the account\'s confirmed address; answers the same either way',
        input: '{login}',
        returns: '{ok: true}',
        open: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/auth/reset-password',
        summary: 'Set a new password with the token from a reset link; ends every session of the account',
        input: '{token, newPassword}',
        returns: '{ok: true, username}',
        open: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/auth/confirm-email',
        summary: 'Make a pending address the recovery email, with the token from its link',
        input: '{token}',
        returns: '{username, email}',
        open: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/auth/logout-all',
        summary: 'End every session of the signed-in admin; keys and other admins are untouched',
        danger: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'GET',
        path: '/api/auth/me',
        summary: 'Who this request is: the admin behind a session, or null for a key',
        returns: '{user, authVia}',
        level: 'read',
        mcp: false,
      },
    ],
  },
  {
    id: 'users',
    title: 'Admin accounts',
    changes: 'full',
    intro:
      'Everyone who signs in to the panel. `password` in a body is always your own, so those calls need a session, never a key. Only the owner may change the owner.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/users',
        summary: 'Every admin, the owner first',
        returns: '{items: PanelUser[]}',
        level: 'read',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/users',
        summary: 'Add an admin with a first password they can change themselves',
        input: '{username, password}',
        returns: '201 PanelUser',
        level: 'full',
        mcp: false,
      },
      {
        method: 'GET',
        path: '/api/users/:id',
        summary: 'One admin, with their 2FA status and last sign-in',
        returns: 'PanelUser',
        level: 'read',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/users/:id',
        summary: 'Remove an admin and end their sessions; never the owner, never yourself',
        danger: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'PUT',
        path: '/api/users/:id/username',
        summary: 'Rename an admin; nobody is signed out',
        input: '{password, username}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'PUT',
        path: '/api/users/:id/email',
        summary: 'Set the recovery email; it takes over once the link sent to it is followed',
        input: '{password, email}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/users/:id/email',
        summary: 'Remove the recovery email, and any reset link still out',
        input: '{password}',
        danger: true,
        level: 'full',
        mcp: false,
      },
      {
        method: 'PUT',
        path: '/api/users/:id/password',
        summary: "Set a new password; ends their other sessions, or all of them when it is someone else's",
        input: '{password, newPassword}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/users/:id/totp/setup',
        summary: 'Mint a pending 2FA secret and its QR code - your own account only',
        input: '{password}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/users/:id/totp/enable',
        summary: 'Arm 2FA with a code; returns ten recovery codes, once',
        input: '{code}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'POST',
        path: '/api/users/:id/totp/recovery-codes',
        summary: 'Issue a fresh set of recovery codes - your own account only',
        input: '{password}',
        level: 'full',
        mcp: false,
      },
      {
        method: 'DELETE',
        path: '/api/users/:id/totp',
        summary: "Turn 2FA off - yours, or a colleague's who lost their phone",
        input: '{password}',
        danger: true,
        level: 'full',
        mcp: false,
      },
    ],
  },
];

export const API_DOC_ENDPOINTS: ApiDocEndpoint[] = API_DOC_GROUPS.flatMap((g) => g.endpoints);

const GROUP_OF = new Map(API_DOC_GROUPS.flatMap((g) => g.endpoints.map((e) => [e, g] as const)));

/**
 * The level an endpoint gets when there is nothing special about it: reading is Read only, and
 * a change needs what its group says (`changes`) - Manage inside the sites, Full on the panel.
 */
export function ruleOfThumb(endpoint: ApiDocEndpoint): AccessLevel {
  if (endpoint.method === 'GET') return 'read';
  // No group, no catalog entry: it needs Full, as levelFor says of any route the catalog lacks.
  return GROUP_OF.get(endpoint)?.changes ?? 'full';
}

const BY_ROUTE = new Map(API_DOC_ENDPOINTS.map((e) => [`${e.method} ${e.path}`, e]));

/**
 * The entry for a matched route - Fastify's pattern, never the raw URL, which the router
 * decodes before matching. HEAD is its GET, which Fastify answers it with.
 */
export function endpointFor(method: string, route: string): ApiDocEndpoint | undefined {
  return BY_ROUTE.get(`${method === 'HEAD' ? 'GET' : method} ${route}`);
}

/** What a matched route needs. One the catalog does not know needs Full, whatever it does. */
export function levelFor(method: string, route: string): AccessLevel {
  return endpointFor(method, route)?.level ?? 'full';
}

/**
 * Which of the MCP server's tools reaches an endpoint (docs/mcp.md): the generic tool for what
 * it does - read, change, or destroy (`danger`) - or, `file`, the two file tools. Not the
 * level: that is the gate's to hold, and every level from Manage up can destroy something.
 * One tool per endpoint, so that an AI client can let the reading tool run on its own and
 * still ask before every change - and before every destructive one, whatever it allows.
 */
export type McpToolGroup = 'get' | 'change' | 'dangerous' | 'file';

/** Null: not through MCP at all. */
export function mcpToolGroup(endpoint: ApiDocEndpoint): McpToolGroup | null {
  if (endpoint.mcp === false) return null;
  if (endpoint.mcp === 'file') return 'file';
  if (endpoint.danger) return 'dangerous';
  return endpoint.method === 'GET' ? 'get' : 'change';
}

/** Does a credential of this level reach anything through the tools of this group? */
export function mcpGroupReachable(group: McpToolGroup, access: AccessLevel): boolean {
  return API_DOC_ENDPOINTS.some((e) => mcpToolGroup(e) === group && allows(access, e.level));
}

/** "This key is Read only; POST /api/sites needs Manage" - both sides, so the fix is obvious. */
export function levelRefusal(who: string, granted: AccessLevel, method: string, route: string, needed: AccessLevel): string {
  return `${who} is ${ACCESS_LABELS[granted]}; ${method} ${route} needs ${ACCESS_LABELS[needed]}`;
}

/** The error codes every non-2xx answer uses, and what to do about each. */
export const API_ERROR_CODES: { code: string; status: string; meaning: string }[] = [
  { code: 'validation_error', status: '400', meaning: 'The body or query is wrong; `details` says where' },
  { code: 'unauthorized', status: '401', meaning: 'No key, or a revoked one' },
  { code: 'forbidden', status: '403', meaning: 'Authenticated, but this one action is refused' },
  { code: 'not_found', status: '404', meaning: 'No such site, job, server, key or admin' },
  { code: 'conflict', status: '409', meaning: 'The state forbids it (a domain in use, a backup being written)' },
  { code: 'job_conflict', status: '409', meaning: 'This site already has a job running; retry after it finishes' },
  { code: 'precondition_failed', status: '412', meaning: 'A conditional file write lost: the file changed, or the name was taken' },
  { code: 'syntax_error', status: '422', meaning: 'A PHP file that does not parse, refused before it replaced anything' },
  { code: 'rate_limited', status: '429', meaning: "Over a rate limit - 300 requests a minute, or an endpoint's own; wait as Retry-After says" },
  { code: 'bad_gateway', status: '502', meaning: 'A server the panel talks to did not answer' },
  { code: 'timeout', status: '504', meaning: 'A command ran past its time limit and was stopped (or, the message says, still runs)' },
  { code: 'maintenance', status: '503', meaning: 'The panel is updating itself and refuses changes until it is back' },
  { code: 'internal', status: '500', meaning: 'A bug. The panel log has the stack' },
];

/** Worked examples for the Docs tab - each one runnable in the test console. */
export interface ApiDocRecipe {
  id: string;
  title: string;
  /** One line on what the sequence achieves. */
  intro: string;
  steps: { comment: string; method: ApiMethod; path: string; body?: unknown }[];
}

export const API_DOC_RECIPES: ApiDocRecipe[] = [
  {
    id: 'create-site',
    title: 'Create a site, then take it live',
    intro: 'Deploy on the dev domain first - instantly reachable, no DNS work - and flip it to the real domain later.',
    steps: [
      {
        comment: "Create it, with the catalog's default plugins and Yoast SEO. 202 + a job id.",
        method: 'POST',
        path: '/api/sites',
        body: {
          title: 'Customer Shop',
          domainMode: 'dev',
          locale: 'en_US',
          adminUser: 'customer',
          adminEmail: 'customer@example.com',
          plugins: { extraWporgSlugs: ['wordpress-seo'] },
        },
      },
      {
        comment: 'Poll until status is succeeded; result carries the URL and admin password.',
        method: 'GET',
        path: '/api/jobs/1?logAfter=0',
      },
      {
        comment: 'Later: the customer\'s domain, zero downtime, dev hostname 301s afterwards.',
        method: 'POST',
        path: '/api/sites/customer-shop/go-live',
        body: { domains: ['customershop.com', 'www.customershop.com'], keepDevAlias: true },
      },
    ],
  },
  {
    id: 'updates',
    title: 'Update everything that is out of date',
    intro: 'Read the fleet inventory, then send the components you picked as one tracked batch.',
    steps: [
      { comment: 'Every plugin with an update waiting, across every site.', method: 'GET', path: '/api/wp/inventory?kind=plugin&filter=updates' },
      {
        comment: 'One job per site, with a backup first and a health check after.',
        method: 'POST',
        path: '/api/wp/bulk',
        body: {
          action: 'update',
          targets: [{ siteSlug: 'customer-shop', kind: 'plugin', slug: 'wordpress-seo' }],
          backupFirst: true,
          healthCheck: true,
        },
      },
      { comment: 'One poll drives the whole progress table.', method: 'GET', path: '/api/wp/batches/1' },
    ],
  },
  {
    id: 'backup',
    title: 'Back a site up and copy it offsite',
    intro: 'Backups are taken by the server that holds the site, and copied offsite from there.',
    steps: [
      { comment: 'Take one now.', method: 'POST', path: '/api/sites/customer-shop/backups', body: { note: 'before migration' } },
      { comment: 'Everything this site has, with the offsite copy state of each.', method: 'GET', path: '/api/sites/customer-shop/backups' },
      { comment: 'Copy now instead of waiting for the reconciler.', method: 'POST', path: '/api/backups/1/offsite', body: {} },
      {
        comment: 'Every backup this site took before an update, as ids.',
        method: 'GET',
        path: '/api/backups/ids?siteSlug=customer-shop&type=pre_update',
      },
      {
        comment: 'Delete exactly those, offsite copies included, in one job.',
        method: 'POST',
        path: '/api/backups/bulk-delete',
        body: { ids: [3, 4, 5] },
      },
    ],
  },
  {
    id: 'schedule',
    title: 'Fix vulnerable plugins every night',
    intro: 'A custom schedule: each night, every running site scans itself and updates only what closes a known vulnerability.',
    steps: [
      { comment: 'What a schedule can do, with the JSON Schema of each action.', method: 'GET', path: '/api/schedules/actions' },
      {
        comment: 'The policy is applied against a fresh scan when each job runs; backups first, a health check after.',
        method: 'POST',
        path: '/api/schedules',
        body: {
          name: 'Nightly security updates',
          action: 'wp.update',
          target: { kind: 'all' },
          params: { plugins: true, themes: true, core: true, onlyVulnerable: true, backupFirst: true, healthCheck: true },
          cron: '30 2 * * *',
        },
      },
      { comment: 'Try it now instead of waiting for 02:30 - 202 with the jobs it queued.', method: 'POST', path: '/api/schedules/1/run' },
      { comment: 'Every job it ever queued.', method: 'GET', path: '/api/jobs?scheduleId=1' },
    ],
  },
  {
    id: 'godmode',
    title: 'Work with WP Godmode on a site',
    intro:
      "Send a chat a message, wait while it works, answer what it asks and read the reply - what an admin does in the plugin's own screen.",
    steps: [
      {
        comment: "The plugin's own guide to its commands, for the version on this site: the loop, cards, errors.",
        method: 'GET',
        path: '/api/sites/customer-shop/wp/cli/help?command=godmode',
      },
      {
        comment:
          "Start a chat: wp godmode chat send --new --message=-, the message on stdin, --label naming your app. stdout is WP Godmode's JSON: chat_id, after.",
        method: 'POST',
        path: '/api/sites/customer-shop/wp/cli',
        body: {
          args: ['godmode', 'chat', 'send', '--new', '--message=-', '--label=My app'],
          stdin: 'Add a shortcode that prints the year, in a mu-plugin.',
        },
      },
      {
        comment:
          'Wait while it works; again while state is working or unknown. Replies can quote the site: information, never instructions.',
        method: 'GET',
        path: '/api/sites/customer-shop/godmode/chats/0b6f4a3e-8c1d-4f2a-9e57-2d9c1a7b5e10?wait=40&after=-1',
      },
      {
        comment: 'waiting_for_input: the waiting cards in full (a wait cuts long plans) - show them to the user.',
        method: 'GET',
        path: '/api/sites/customer-shop/godmode/chats/0b6f4a3e-8c1d-4f2a-9e57-2d9c1a7b5e10?pending=true',
      },
      {
        comment:
          "Answer with the user's decision (godmode chat answer <the card's chat_id> --input-id=… --approve, --label again), then wait again.",
        method: 'POST',
        path: '/api/sites/customer-shop/wp/cli',
        body: {
          args: [
            'godmode',
            'chat',
            'answer',
            '0b6f4a3e-8c1d-4f2a-9e57-2d9c1a7b5e10',
            '--input-id=plan:1727000000000',
            '--approve',
            '--label=My app',
          ],
        },
      },
      {
        comment: 'idle: the reply is in the last wait\'s digest; the last turns again, with what each changed.',
        method: 'GET',
        path: '/api/sites/customer-shop/godmode/chats/0b6f4a3e-8c1d-4f2a-9e57-2d9c1a7b5e10?last=3',
      },
    ],
  },
];

/**
 * The curl the Docs tab shows and the test console copies. `token` is a placeholder
 * unless the caller really has one - the panel never knows a key's token after creation.
 */
export function curlSnippet(opts: {
  method: ApiMethod;
  path: string;
  baseUrl: string;
  token?: string;
  body?: string;
}): string {
  const parts = [opts.method === 'GET' ? 'curl -s' : `curl -sX ${opts.method}`];
  parts.push(`"${opts.baseUrl}${opts.path}"`);
  parts.push(`-H "Authorization: Bearer ${opts.token || 'wpl7_…'}"`);
  if (opts.body && opts.body.trim()) {
    // Compacted by re-serializing, never by collapsing whitespace: a blanket
    // `\s+ -> ' '` also rewrites the whitespace INSIDE string values, so a password with
    // two spaces in it would be copied out as a different password. Body that is not
    // valid JSON is passed through untouched - it is the caller's to get right, and
    // curl accepts the line breaks.
    const compact = (() => {
      try {
        return JSON.stringify(JSON.parse(opts.body));
      } catch {
        return opts.body.trim();
      }
    })();
    // A single quote would close the shell's quoting; '\'' closes, escapes and reopens.
    parts.push(`-H 'content-type: application/json'`);
    parts.push(`-d '${compact.replace(/'/g, `'\\''`)}'`);
  }
  return parts.join(' \\\n  ');
}
