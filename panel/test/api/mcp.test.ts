/**
 * The MCP endpoint itself: when it exists, who it lets in, and what it offers whom - in both
 * protocol eras the SDK serves. What the tools then do is test/api/mcpTools.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { ApiActivityDto } from '../../shared/types.js';
import type { AccessLevel } from '../../shared/access.js';
import { makeApp, makeWorld, mcpClient } from '../helpers.js';

async function panel(opts: { enabled?: boolean } = {}) {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  if (opts.enabled !== false) world.deps.settings.set('mcpEnabled', true);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const session = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  const bearer = (access: AccessLevel = 'full') => ({
    authorization: `Bearer ${world.deps.apiKeys.create(`key-${access}`, access).token}`,
  });
  return { app, world, session, bearer };
}

const initialize = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '1' },
};

describe('the MCP endpoint', () => {
  it('does not exist while MCP is switched off', async () => {
    const { app, bearer } = await panel({ enabled: false });
    const post = await mcpClient(app, bearer()).send('initialize', initialize);
    expect(post.res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(404);
  });

  it('cannot be switched on without an address to hand out, and says why', async () => {
    const { app, world, session } = await panel({ enabled: false });
    // A production panel with no PANEL_DOMAIN (the config object is shared with the app).
    Object.assign(world.config, { nodeEnv: 'production', panelDomain: '' });
    const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: session, payload: { mcpEnabled: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/PANEL_DOMAIN/);
    // Switching it off, or saving anything else, is never held up by it.
    const off = await app.inject({ method: 'PUT', url: '/api/settings', headers: session, payload: { mcpEnabled: false } });
    expect(off.statusCode).toBe(200);
  });

  it('refuses plain http in production, even switched on', async () => {
    const { app, world, bearer } = await panel();
    Object.assign(world.config, { nodeEnv: 'production', tlsMode: 'none' });
    expect(world.deps.settings.get('mcpEnabled')).toBe(true);
    expect((await mcpClient(app, bearer()).send('initialize', initialize)).res.statusCode).toBe(404);
    Object.assign(world.config, { tlsMode: 'letsencrypt' });
    expect((await mcpClient(app, bearer()).send('initialize', initialize)).res.statusCode).toBe(200);
  });

  it('asks a client with no token to sign in, pointing at the resource metadata', async () => {
    const { app } = await panel();
    const { res } = await mcpClient(app, {}).send('initialize', initialize);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="http://panel.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('never takes the session cookie for a token', async () => {
    const { app, session } = await panel();
    const { res } = await mcpClient(app, { cookie: session.cookie }).send('initialize', initialize);
    expect(res.statusCode).toBe(401);
  });

  it('refuses a token it does not know, and writes the refusal to the activity log', async () => {
    const { app, session } = await panel();
    const { res } = await mcpClient(app, { authorization: 'Bearer wpl7_notARealKeyAtAll' }).send('initialize', initialize);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/error="invalid_token"/);
    const activity = (await app.inject({ method: 'GET', url: '/api/api-keys/activity', headers: session })).json() as ApiActivityDto;
    expect(activity.items[0]).toMatchObject({
      keyId: null,
      keyPrefix: 'wpl7_notARea',
      method: 'POST',
      path: '/mcp',
      status: 401,
      outcome: 'denied',
      via: 'mcp',
    });
  });

  it('refuses a web page on another site, and an opaque origin, but not an app of its own', async () => {
    const { app, bearer } = await panel();
    const key = bearer();
    for (const origin of ['https://evil.example', 'http://panel.example.test.evil.example', 'null']) {
      const { res } = await mcpClient(app, { ...key, origin }).send('initialize', initialize);
      expect(res.statusCode, origin).toBe(403);
    }
    for (const origin of ['http://panel.example.test', 'vscode-webview://abc123']) {
      const { res } = await mcpClient(app, { ...key, origin }).send('initialize', initialize);
      expect(res.statusCode, origin).toBe(200);
    }
  });

  it('keeps no session: GET and DELETE are 405, and no cookie is ever set', async () => {
    const { app, bearer } = await panel();
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/mcp', headers: bearer() });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
    const { res } = await mcpClient(app, bearer()).send('initialize', initialize);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toMatch(/no-store|no-cache/);
  });

  for (const era of ['legacy', 'modern'] as const) {
    it(`offers each level only the tools it can use (${era} protocol)`, async () => {
      const { app, bearer } = await panel();
      const tools = async (access: AccessLevel) => (await mcpClient(app, bearer(access), { era }).tools()).sort();
      expect(await tools('read')).toEqual(['wpl7_api_docs', 'wpl7_api_get', 'wpl7_wait_for_job']);
      // Manage and Full both destroy things and work on files; the gate tells them apart.
      const all = [
        'wpl7_api_change',
        'wpl7_api_dangerous',
        'wpl7_api_docs',
        'wpl7_api_get',
        'wpl7_read_site_file',
        'wpl7_wait_for_job',
        'wpl7_write_site_file',
      ];
      expect(await tools('manage')).toEqual(all);
      expect(await tools('full')).toEqual(all);
    });
  }

  it('introduces itself with the caller and its level', async () => {
    const { app, bearer } = await panel();
    const { message } = await mcpClient(app, bearer('manage')).send('initialize', initialize);
    expect(message!.result!.serverInfo).toMatchObject({ name: 'wpl7' });
    expect(message!.result!.instructions).toContain('as API key "key-manage" via MCP, with Manage access');
  });

  // An app can hold several panels, under names its user picks; nothing else tells them apart.
  it('says which panel it is, in both protocol eras', async () => {
    const { app, bearer } = await panel();
    const identity = { name: 'wpl7', title: 'WPL7 · panel.example.test', websiteUrl: 'http://panel.example.test' };
    const legacy = (await mcpClient(app, bearer()).send('initialize', initialize)).message!.result!;
    expect(legacy.serverInfo).toMatchObject(identity);
    expect(legacy.instructions).toMatch(/^This is the WPL7 panel at http:\/\/panel\.example\.test\. /);
    expect(legacy.instructions).toContain('Other WPL7 panels may be connected alongside this one');
    const modern = (await mcpClient(app, bearer(), { era: 'modern' }).send('server/discover')).message!.result!;
    expect(modern.instructions).toBe(legacy.instructions);
    expect((modern._meta as Record<string, unknown>)['io.modelcontextprotocol/serverInfo']).toMatchObject(identity);
  });

  // Read on connect, and kept short: Claude Code cuts them at 2 KB, ChatGPT reads the start first.
  it("points an app at a plugin's own WP-CLI help, and at WP Godmode's waits that ask nothing", async () => {
    const { app, bearer } = await panel();
    const { instructions } = (await mcpClient(app, bearer()).send('initialize', initialize)).message!.result! as { instructions: string };
    expect(instructions).toContain('wpl7_api_get /api/sites/{site}/wp/cli/help?command=<command>');
    expect(instructions).toContain('send and answer with wpl7_api_dangerous');
    expect(instructions).toContain('wpl7_api_get /api/sites/{site}/godmode/chats/{chatId}?wait=40, which needs no approval');
  });

  // The address and the caller's name are the parts that grow. Counted in bytes, never fewer than the
  // characters Claude Code counts, with a key named in 100 three-byte characters: an app's label (64
  // characters of its name, a 60-character username) comes to less either way.
  it('stays under 2 KB for the longest address and name there can be', async () => {
    const { app, world } = await panel();
    const domain = `${['a', 'b', 'c'].map((c) => c.repeat(63)).join('.')}.${'d'.repeat(56)}.test`;
    Object.assign(world.config, { panelDomain: domain, tlsMode: 'letsencrypt' });
    const name = '鍵'.repeat(100);
    const token = world.deps.apiKeys.create(name, 'read').token;
    const { instructions } = (await mcpClient(app, { authorization: `Bearer ${token}` }).send('initialize', initialize)).message!
      .result! as { instructions: string };
    expect(domain).toHaveLength(253);
    expect(instructions).toContain(`https://${domain}`);
    expect(instructions).toContain(`API key "${name}" via MCP, with Read only access`);
    expect(Buffer.byteLength(instructions)).toBeLessThan(2048);
  });

  it('marks the reading tools read-only and the destructive one destructive, so a client can ask first', async () => {
    const { app, bearer } = await panel();
    const { message } = await mcpClient(app, bearer('full')).send('tools/list');
    const tools = message!.result!.tools as { name: string; annotations: Record<string, boolean> }[];
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.wpl7_api_get).toMatchObject({ readOnlyHint: true });
    expect(hints.wpl7_wait_for_job).toMatchObject({ readOnlyHint: true });
    expect(hints.wpl7_api_change).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.wpl7_api_dangerous).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hints.wpl7_write_site_file).toMatchObject({ destructiveHint: true });
  });
});
