/**
 * The access levels live in the API catalog (shared/apiDocs.ts), one per endpoint. These
 * tests hold the catalog to its rules, and pin every exception to them - so that raising or
 * lowering what a key may do is a change somebody made on purpose, in a diff somebody reads.
 */
import { describe, expect, it } from 'vitest';
import {
  API_DOC_ENDPOINTS,
  API_DOC_GROUPS,
  endpointFor,
  levelFor,
  mcpGroupReachable,
  mcpToolGroup,
  ruleOfThumb,
} from '../../shared/apiDocs.js';
import { allows } from '../../shared/access.js';

const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

/** Everything the rule of thumb gets wrong, and what it is instead. */
const EXCEPTIONS: Record<string, string> = {
  // Inside the sites, and still Full: the site itself, the safety nets, the spam guard.
  'DELETE /api/sites/:slug': 'full',
  'POST /api/sites/:slug/move': 'full',
  'POST /api/sites/:slug/move/finalize': 'full',
  'PUT /api/sites/:slug/backups-enabled': 'full',
  'PUT /api/sites/:slug/offsite-enabled': 'full',
  'PUT /api/sites/:slug/mail-suspension': 'full',
  'DELETE /api/backups/:id': 'full',
  // Reads that are more than Read only: what a file or a backup holds, a WP Godmode chat (a
  // command's output, quoting whatever the site holds), and a root shell.
  'GET /api/sites/:slug/files/content': 'manage',
  'GET /api/sites/:slug/files/download': 'manage',
  'GET /api/sites/:slug/files/search': 'manage',
  'GET /api/sites/:slug/godmode/chats': 'manage',
  'GET /api/sites/:slug/godmode/agents': 'manage',
  'GET /api/sites/:slug/godmode/chats/:chatId': 'manage',
  'GET /api/backups/:id/download': 'manage',
  'GET /api/servers/:id/terminal': 'full',
  // The panel's own, but only a nudge: now, what the panel does by itself anyway.
  'POST /api/backup-destinations/:id/test': 'manage',
  'POST /api/servers/:id/test': 'manage',
  'POST /api/mail/ingest': 'manage',
  'POST /api/mail/queue/:serverId/flush': 'manage',
  'POST /api/mail/domains/:domain/check': 'manage',
  'POST /api/mail/dkim/sync': 'manage',
  'POST /api/catalog/refresh': 'manage',
  'POST /api/system/update/check': 'manage',
};

/** Everything marked `danger`, sorted. */
const DESTRUCTIVE = [
  'DELETE /api/api-keys/:id',
  'DELETE /api/api-keys/activity',
  'DELETE /api/backup-destinations/:id',
  'DELETE /api/backups/:id',
  'DELETE /api/mail/dkim/:domain',
  'DELETE /api/mail/queue/:serverId/:queueId',
  'DELETE /api/mcp/connections/:id',
  'DELETE /api/plugins/:id',
  'DELETE /api/recipes/:id/inputs/:input',
  'DELETE /api/recipes/:id/install',
  'DELETE /api/schedules/:id',
  'DELETE /api/security/blocks/:id',
  'DELETE /api/security/never-block/:id',
  'DELETE /api/servers/:id',
  'DELETE /api/sites/:slug',
  'DELETE /api/sites/:slug/ftp/users/:id',
  'DELETE /api/sites/:slug/security/quarantine/:id',
  'DELETE /api/sites/:slug/wp/plugins/:name',
  'DELETE /api/sites/:slug/wp/themes/:name',
  'DELETE /api/users/:id',
  'DELETE /api/users/:id/email',
  'DELETE /api/users/:id/totp',
  'GET /api/servers/:id/terminal',
  'PATCH /api/backup-destinations/:id',
  'PATCH /api/schedules/:id',
  'PATCH /api/servers/:id',
  'POST /api/auth/logout-all',
  'POST /api/backup-destinations/:id/passphrase',
  'POST /api/backups/:id/restore',
  'POST /api/jobs/:id/cancel',
  'POST /api/mail/dkim',
  'POST /api/mail/domains/:domain/publish',
  'POST /api/mail/servers/:serverId/publish-hostname',
  'POST /api/recipes/local',
  'POST /api/schedules',
  'POST /api/schedules/:id/run',
  'POST /api/security/never-block',
  'POST /api/servers',
  'POST /api/servers/:id/backups/relocate',
  'POST /api/servers/:id/update',
  'POST /api/sites/:slug/files/compress',
  'POST /api/sites/:slug/files/delete',
  'POST /api/sites/:slug/files/extract',
  'POST /api/sites/:slug/files/move',
  'POST /api/sites/:slug/ftp/users/:id/password',
  'POST /api/sites/:slug/go-live',
  'POST /api/sites/:slug/move/finalize',
  'POST /api/sites/:slug/security/findings/:id/put-back',
  'POST /api/sites/:slug/security/findings/:id/quarantine',
  'POST /api/sites/:slug/security/findings/:id/reinstall',
  'POST /api/sites/:slug/security/quarantine/:id/restore',
  'POST /api/sites/:slug/shell',
  'POST /api/sites/:slug/stop',
  'POST /api/sites/:slug/wp/bulk',
  'POST /api/sites/:slug/wp/cli',
  'POST /api/sites/:slug/wp/recipes/apply',
  'POST /api/sites/:slug/wp/rest',
  'POST /api/sites/:slug/wp/users/reset-password',
  'POST /api/system/update',
  'POST /api/wp/bulk',
  'PUT /api/recipes/:id/inputs/:input',
  'PUT /api/settings',
  'PUT /api/sites/:slug/backups-enabled',
  'PUT /api/sites/:slug/domains',
  'PUT /api/sites/:slug/files/content',
  'PUT /api/sites/:slug/files/uploads/:id',
  'PUT /api/sites/:slug/mail-suspension',
  'PUT /api/sites/:slug/offsite-enabled',
  'PUT /api/sites/:slug/security',
];

/** Never through MCP, whatever the connection's level. */
const NOT_THROUGH_MCP = [
  // Reachable without a key: logins, resets, the health probe.
  'GET /api/health',
  'POST /api/auth/login',
  'POST /api/auth/login/totp',
  'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password',
  'POST /api/auth/confirm-email',
  // A session's own business.
  'POST /api/auth/logout',
  'POST /api/auth/logout-all',
  'GET /api/auth/me',
  // Credentials that would outlive the connection, and the log that would show it.
  'GET /api/api-keys',
  'POST /api/api-keys',
  'DELETE /api/api-keys/:id',
  'GET /api/api-keys/activity',
  'DELETE /api/api-keys/activity',
  'GET /api/users',
  'POST /api/users',
  'GET /api/users/:id',
  'DELETE /api/users/:id',
  'PUT /api/users/:id/username',
  'PUT /api/users/:id/email',
  'DELETE /api/users/:id/email',
  'PUT /api/users/:id/password',
  'POST /api/users/:id/totp/setup',
  'POST /api/users/:id/totp/enable',
  'POST /api/users/:id/totp/recovery-codes',
  'DELETE /api/users/:id/totp',
  // Not JSON: binary streams, multipart, a websocket.
  'GET /api/sites/:slug/files/download',
  'PUT /api/sites/:slug/files/uploads/:id',
  'DELETE /api/sites/:slug/files/uploads/:id',
  'GET /api/backups/:id/download',
  'GET /api/servers/:id/terminal',
  'POST /api/plugins/upload',
  // Leaves the box.
  'POST /api/feedback',
  // MCP's own connections and sign-in: a connection must never manage itself.
  'GET /api/mcp',
  'POST /api/mcp/connect-window',
  'DELETE /api/mcp/connect-window',
  'DELETE /api/mcp/connect-window/registration',
  'PATCH /api/mcp/connections/:id',
  'DELETE /api/mcp/connections/:id',
  'POST /api/oauth/authorize/check',
  'POST /api/oauth/authorize/decision',
];

describe('access levels in the API catalog', () => {
  it('reads with GET only: nothing that changes anything is Read only', () => {
    const writes = API_DOC_ENDPOINTS.filter((e) => e.level === 'read' && e.method !== 'GET');
    expect(writes.map(key)).toEqual([]);
  });

  it('draws the line at the sites: a change inside them is Manage, a change to the panel Full', () => {
    expect(Object.fromEntries(API_DOC_GROUPS.map((g) => [g.id, g.changes]))).toEqual({
      sites: 'manage',
      wp: 'manage',
      files: 'manage',
      ftp: 'manage',
      fleet: 'manage',
      // A site's protection, scans and quarantine are the site's; the fleet-wide list of
      // blocked addresses is the panel's.
      security: 'manage',
      backups: 'manage',
      jobs: 'manage',
      schedules: 'manage',
      destinations: 'full',
      servers: 'full',
      blocklist: 'full',
      mail: 'full',
      plugins: 'full',
      recipes: 'full',
      panel: 'full',
      mcp: 'full',
      system: 'full',
      auth: 'full',
      users: 'full',
    });
  });

  it('marks destructive everything that runs a command, deletes, overwrites or takes a safety net away', () => {
    // Over MCP these go through wpl7_api_dangerous, which an AI client asks about before every
    // call - at Manage as much as at Full. So the list is pinned: an endpoint that joins or
    // leaves it changes what an app may do without asking.
    expect(API_DOC_ENDPOINTS.filter((e) => e.danger).map(key).sort()).toEqual(DESTRUCTIVE);
  });

  it('sends the destructive ones through the tool that asks first, and reads through the one that reads', () => {
    const viaMcp = API_DOC_ENDPOINTS.filter((e) => mcpToolGroup(e) !== null && mcpToolGroup(e) !== 'file');
    expect(viaMcp.filter((e) => Boolean(e.danger) !== (mcpToolGroup(e) === 'dangerous')).map(key)).toEqual([]);
    expect(viaMcp.filter((e) => (e.method === 'GET') !== (mcpToolGroup(e) === 'get')).map(key)).toEqual([]);
  });

  it('lists a tool for a level only where the level reaches something through it', () => {
    const groups = ['get', 'change', 'dangerous', 'file'] as const;
    const reached = (access: 'read' | 'manage' | 'full') => groups.filter((g) => mcpGroupReachable(g, access));
    expect(reached('read')).toEqual(['get']);
    expect(reached('manage')).toEqual(['get', 'change', 'dangerous', 'file']);
    expect(reached('full')).toEqual(['get', 'change', 'dangerous', 'file']);
  });

  it('pins every exception to the rule of thumb', () => {
    const exceptions = Object.fromEntries(
      API_DOC_ENDPOINTS.filter((e) => e.level !== ruleOfThumb(e)).map((e) => [key(e), e.level]),
    );
    expect(exceptions).toEqual(EXCEPTIONS);
  });

  it('gives a reason for every exception, and only for exceptions', () => {
    const unexplained = API_DOC_ENDPOINTS.filter((e) => e.level !== ruleOfThumb(e) && !e.levelReason?.trim());
    const stale = API_DOC_ENDPOINTS.filter((e) => e.level === ruleOfThumb(e) && e.levelReason !== undefined);
    expect(unexplained.map(key)).toEqual([]);
    expect(stale.map(key)).toEqual([]);
    const rambling = API_DOC_ENDPOINTS.filter((e) => (e.levelReason ?? '').length > 90 || e.levelReason?.endsWith('.'));
    expect(rambling.map(key)).toEqual([]);
  });

  it('keeps sign-in, accounts, keys, binary streams and the feedback form away from MCP', () => {
    const excluded = API_DOC_ENDPOINTS.filter((e) => mcpToolGroup(e) === null).map(key);
    expect(excluded.sort()).toEqual([...NOT_THROUGH_MCP].sort());
    expect(API_DOC_ENDPOINTS.filter((e) => e.open && e.mcp !== false).map(key)).toEqual([]);
  });

  it('reaches file contents through the file tools alone', () => {
    const files = API_DOC_ENDPOINTS.filter((e) => mcpToolGroup(e) === 'file').map(key);
    expect(files.sort()).toEqual(['GET /api/sites/:slug/files/content', 'PUT /api/sites/:slug/files/content']);
    // Everything that is not plain JSON is either one of those or not reachable at all.
    const raw = API_DOC_ENDPOINTS.filter((e) => e.note && mcpToolGroup(e) !== null && mcpToolGroup(e) !== 'file');
    expect(raw.map(key)).toEqual([]);
  });

  it('looks a matched route up by its pattern, HEAD as its GET, and asks Full of anything it does not know', () => {
    expect(endpointFor('GET', '/api/sites/:slug')?.level).toBe('read');
    expect(endpointFor('HEAD', '/api/sites/:slug')?.level).toBe('read');
    expect(endpointFor('GET', '/api/sites/my-shop')).toBeUndefined();
    expect(levelFor('POST', '/api/sites')).toBe('manage');
    expect(levelFor('POST', '/api/not-documented')).toBe('full');
  });

  it('nests the levels', () => {
    expect(allows('full', 'read')).toBe(true);
    expect(allows('manage', 'manage')).toBe(true);
    expect(allows('manage', 'full')).toBe(false);
    expect(allows('read', 'manage')).toBe(false);
  });
});
