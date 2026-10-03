/**
 * WP Godmode's chats, read through `wp godmode chat list | read | wait` with arguments the panel
 * builds. Manage, and reached through the MCP tool that reads - so an AI app can follow a chat
 * without being asked about every poll, while sending to one still goes through the tool that asks.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { sites } from '../../src/db/schema.js';
import { timedOut } from '../../src/lib/errors.js';
import type { ExecOpts } from '../../src/services/docker.js';
import { endpointFor, mcpToolGroup } from '../../shared/apiDocs.js';
import type { AccessLevel } from '../../shared/access.js';
import type { RunResult } from '../../src/services/docker.js';
import { makeApp, makeWorld, mcpClient, waitFor, type TestWorld } from '../helpers.js';

const CHAT = '0b6f4a3e-8c1d-4f2a-9e57-2d9c1a7b5e10';
const PROMPT = 'Add a hello-world shortcode, in a mu-plugin.';

async function panel() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  world.deps.settings.set('mcpEnabled', true);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  const key = (access: AccessLevel) => ({ authorization: `Bearer ${world.deps.apiKeys.create(`key-${access}`, access).token}` });
  const mcp = (access: AccessLevel) => mcpClient(app, key(access));
  const get = (url: string, as: Record<string, string> = headers) => app.inject({ method: 'GET', url, headers: as });
  return { app, world, headers, key, mcp, get };
}

function addSite(w: TestWorld, slug: string, state: 'running' | 'exited' = 'running'): void {
  const now = Date.now();
  w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status: state === 'running' ? 'running' : 'stopped',
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  w.docker.containers.set(`wp-${slug}`, state);
}

/** What `wp godmode …` prints: one line of compact JSON, and a non-zero exit with `ok: false`. */
const printed = (value: Record<string, unknown>): RunResult => ({
  stdout: `${JSON.stringify(value)}\n`,
  stderr: '',
  exitCode: value.ok === false ? 1 : 0,
});

type ExecCall = { method: string; args: [string, string[], Record<string, unknown>] };
const commands = (w: TestWorld) => (w.docker.calls.filter((c) => c.method === 'exec') as ExecCall[]).map((c) => c.args[1]);

describe('WP Godmode chats', () => {
  it('lists the chats with `wp godmode chat list`, as www-data, and answers with the JSON it printed', async () => {
    const { world, get } = await panel();
    addSite(world, 'alpha');
    const list = { ok: true, chats: [{ id: CHAT, name: 'Hello world shortcode', state: 'idle' }] };
    world.docker.execQueue.push(printed(list));

    const res = await get('/api/sites/alpha/godmode/chats');

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(list);
    const [call] = world.docker.calls.filter((c) => c.method === 'exec') as ExecCall[];
    expect(call!.args[0]).toBe('wp-alpha');
    expect(call!.args[1]).toEqual(['wp', 'godmode', 'chat', 'list']);
    expect(call!.args[2]).toMatchObject({ user: '33:33', env: ['HOME=/tmp'], workdir: '/var/www/html', timeoutMs: 30_000 });

    // One chat's or agent's sub-chats, and the agents, which the chat list leaves out.
    world.docker.execQueue.push(printed(list));
    expect((await get(`/api/sites/alpha/godmode/chats?parent=${CHAT.toUpperCase()}`)).statusCode).toBe(200);
    expect(commands(world).at(-1)).toEqual(['wp', 'godmode', 'chat', 'list', `--parent=${CHAT}`]);
    world.docker.execQueue.push(printed({ ok: true, agents: [] }));
    expect((await get('/api/sites/alpha/godmode/agents')).json()).toEqual({ ok: true, agents: [] });
    expect(commands(world).at(-1)).toEqual(['wp', 'godmode', 'agent', 'list']);
    expect((await get('/api/sites/alpha/godmode/chats?parent=nope')).statusCode).toBe(400);
  });

  it('reads a chat at once, or waits on it for up to 40 s, with the cursor and count passed on', async () => {
    const { world, get } = await panel();
    addSite(world, 'alpha');
    // Always WP Godmode's own 20,000-character cap, whatever a wp-cli.yml on the site says.
    const cap = '--max-chars=20000';
    const cases: [string, string[], number][] = [
      ['', ['read', CHAT, cap], 30_000],
      ['?wait=0', ['read', CHAT, cap], 30_000],
      ['?last=5', ['read', CHAT, '--last=5', cap], 30_000],
      ['?after=3', ['read', CHAT, '--after=3', cap], 30_000],
      ['?after=-1', ['read', CHAT, '--after=-1', cap], 30_000],
      // Empty or blank: not given, rather than a 0 that would skip the chat's first turn.
      ['?after=&last=', ['read', CHAT, cap], 30_000],
      ['?after=%20', ['read', CHAT, cap], 30_000],
      ['?pending=true', ['read', CHAT, '--pending', cap], 30_000],
      // A wait has its seconds on top of a read's, up to the ~55 s a request is given.
      ['?wait=40', ['wait', CHAT, '--timeout=40', cap], 55_000],
      ['?wait=12&after=7', ['wait', CHAT, '--timeout=12', '--after=7', cap], 42_000],
    ];
    for (const [query, args, timeoutMs] of cases) {
      world.docker.execQueue.push(printed({ ok: true, state: 'idle' }));
      const res = await get(`/api/sites/alpha/godmode/chats/${CHAT}${query}`);
      expect(res.statusCode, `${query}: ${res.body}`).toBe(200);
      expect(commands(world).at(-1), query).toEqual(['wp', 'godmode', 'chat', ...args]);
      const calls = world.docker.calls.filter((c) => c.method === 'exec') as ExecCall[];
      expect(calls.at(-1)!.args[2], query).toMatchObject({ timeoutMs });
    }

    // A chat id pasted in upper case is the same chat: the plugin writes them in lower case.
    world.docker.execQueue.push(printed({ ok: true, state: 'idle' }));
    expect((await get(`/api/sites/alpha/godmode/chats/${CHAT.toUpperCase()}`)).statusCode).toBe(200);
    expect(commands(world).at(-1)).toEqual(['wp', 'godmode', 'chat', 'read', CHAT, cap]);
  });

  it("passes WP Godmode's own refusals through as its answer, with a 200 like any other", async () => {
    const { world, get } = await panel();
    addSite(world, 'alpha');
    const missing = { ok: false, error: { code: 'not_found', message: 'No chat with that id' } };
    world.docker.execQueue.push(printed(missing));
    const res = await get(`/api/sites/alpha/godmode/chats/${CHAT}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(missing);

    // Whatever else the plugin says beside the error travels with it.
    const off = {
      ok: false,
      error: { code: 'feature_not_in_tier', message: 'Remote control is not part of this plan' },
      feature: 'remote_control',
    };
    world.docker.execQueue.push(printed(off));
    const list = await get('/api/sites/alpha/godmode/chats');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(off);
  });

  it('finds the answer among lines a plugin printed while WordPress loaded or shut down', async () => {
    const { world, get } = await panel();
    addSite(world, 'alpha');
    world.docker.execQueue.push({
      stdout: 'Notice: Function _load_textdomain_just_in_time was called incorrectly.\r\n{"ok":true,"state":"working","waiting_on":[]}\r\n',
      stderr: 'PHP Deprecated: something else\n',
      exitCode: 0,
    });
    const res = await get(`/api/sites/alpha/godmode/chats/${CHAT}?wait=40`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: 'working', waiting_on: [] });

    world.docker.execQueue.push({
      stdout: '{"debug":"a plugin\'s own JSON"}\n{"ok":true,"state":"idle"}\n<!-- served by a shutdown hook -->\n{not json\n',
      stderr: '',
      exitCode: 0,
    });
    expect((await get(`/api/sites/alpha/godmode/chats/${CHAT}`)).json()).toEqual({ ok: true, state: 'idle' });

    // Printed before the plugin started catching stray output, with no newline of its own:
    // WordPress's database error box, an mu-plugin's comment. The answer shares their line.
    for (const before of ['<div id="error"><p class="wpdberror">Table x doesn\'t exist</p></div>', '<!-- x -->']) {
      world.docker.execQueue.push({ stdout: `${before}{"ok":true,"state":"idle"}\n`, stderr: '', exitCode: 0 });
      expect((await get(`/api/sites/alpha/godmode/chats/${CHAT}`)).json(), before).toEqual({ ok: true, state: 'idle' });
    }
    world.docker.execQueue.push({ stdout: '<!-- x -->{"ok":false,"error":{"code":"not_found","message":"No chat"}}\n', stderr: '', exitCode: 1 });
    expect((await get(`/api/sites/alpha/godmode/chats/${CHAT}`)).json()).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('answers 409 for a site without the commands - asking again will not change that - and 502 for no answer', async () => {
    const { world, get, mcp } = await panel();
    addSite(world, 'alpha');

    // The plugin is not there (or not active, or too old): WP-CLI knows no such command.
    world.docker.execQueue.push({
      stdout: '',
      stderr: "Error: 'godmode' is not a registered wp command. See 'wp help' for available commands.\n",
      exitCode: 1,
    });
    const absent = await get('/api/sites/alpha/godmode/chats');
    expect(absent.statusCode).toBe(409);
    expect(absent.json().error).toEqual({
      code: 'conflict',
      message:
        'This site has no `wp godmode chat list`: WP Godmode is not installed, not active, or older than these WP-CLI ' +
        'commands. Install or update the plugin, then try again.',
      details: {
        exitCode: 1,
        stdout: '',
        stderr: "Error: 'godmode' is not a registered wp command. See 'wp help' for available commands.",
      },
    });
    // A plugin that has `wp godmode` but not the subcommand asked for is too old for it.
    world.docker.execQueue.push({
      stdout: '',
      stderr: "Error: 'wait' is not a registered subcommand of 'godmode chat'. See 'wp help godmode chat' for available subcommands.\n",
      exitCode: 1,
    });
    const old = await mcp('manage').call('wpl7_api_get', { path: `/api/sites/alpha/godmode/chats/${CHAT}`, query: { wait: 10 } });
    expect(old.isError).toBe(true);
    expect(old.value).toMatchObject({ status: 409, error: { code: 'conflict' } });
    // No "try again later" from the MCP side either: the message says what to do.
    expect(old.value.hint).toBeUndefined();

    // WordPress itself fell over before the command could answer.
    world.docker.execQueue.push({
      stdout: 'There has been a critical error on this website.',
      stderr: 'PHP Fatal error:  Uncaught Error: Call to undefined function x() in /var/www/html/wp-content/plugins/y/y.php:3',
      exitCode: 255,
    });
    const fatal = await get(`/api/sites/alpha/godmode/chats/${CHAT}?wait=10`);
    expect(fatal.statusCode).toBe(502);
    expect(fatal.json().error).toMatchObject({
      code: 'bad_gateway',
      message: "wp godmode chat wait did not answer with WP Godmode's JSON (exit 255)",
      details: { exitCode: 255, stdout: 'There has been a critical error on this website.' },
    });
    expect(fatal.json().error.details.stderr).toContain('PHP Fatal error');

    // JSON, but not the plugin's; and a torrent of output, kept short.
    world.docker.execQueue.push({ stdout: '[1,2,3]\n', stderr: '', exitCode: 0 });
    expect((await get(`/api/sites/alpha/godmode/chats/${CHAT}`)).statusCode).toBe(502);
    world.docker.execQueue.push({ stdout: 'x'.repeat(50_000), stderr: 'y'.repeat(50_000), exitCode: 1 });
    const flood = await get(`/api/sites/alpha/godmode/chats/${CHAT}`);
    expect(flood.statusCode).toBe(502);
    expect(flood.json().error.details.stdout).toHaveLength(2000);
    expect(flood.json().error.details.stderr).toHaveLength(2000);
  });

  it('refuses what is not a chat id, a wait, a cursor or a count, before running anything', async () => {
    const { world, get } = await panel();
    addSite(world, 'alpha');
    for (const path of [
      'not-a-chat',
      `${CHAT}0`,
      CHAT.replace(/-/g, ''),
      '..%2F..%2Fetc',
      `${CHAT}?wait=41`,
      `${CHAT}?wait=-1`,
      `${CHAT}?wait=1.5`,
      `${CHAT}?wait=soon`,
      `${CHAT}?after=-2`,
      `${CHAT}?after=last`,
      `${CHAT}?last=0`,
      `${CHAT}?last=51`,
      // A wait answers with its own digest, and a read from a cursor has no count: WP Godmode
      // would ignore `last` in both, silently.
      `${CHAT}?wait=10&last=5`,
      `${CHAT}?after=3&last=5`,
      // The waiting cards, read alone.
      `${CHAT}?pending=true&wait=10`,
      `${CHAT}?pending=true&after=1`,
      `${CHAT}?pending=true&last=2`,
      `${CHAT}?pending=maybe`,
      `${CHAT}?timeout=10`,
    ]) {
      const res = await get(`/api/sites/alpha/godmode/chats/${path}`);
      expect(res.statusCode, path).toBe(400);
      expect(res.json().error.code, path).toBe('validation_error');
    }
    expect(commands(world)).toHaveLength(0);
  });

  it('refuses a stopped site rather than starting it', async () => {
    const { world, get } = await panel();
    addSite(world, 'asleep', 'exited');
    expect((await get('/api/sites/asleep/godmode/chats')).statusCode).toBe(409);
    expect((await get(`/api/sites/asleep/godmode/chats/${CHAT}?wait=40`)).statusCode).toBe(409);
    expect(commands(world)).toHaveLength(0);
    expect(world.docker.calls.some((c) => c.method === 'startContainer')).toBe(false);
  });

  it('needs Manage, and is read through the tool that runs without asking', async () => {
    const { world, key, get, mcp } = await panel();
    addSite(world, 'alpha');
    for (const path of ['/api/sites/:slug/godmode/chats', '/api/sites/:slug/godmode/chats/:chatId']) {
      const endpoint = endpointFor('GET', path)!;
      expect(endpoint).toMatchObject({ level: 'manage' });
      expect(endpoint.danger).toBeUndefined();
      expect(mcpToolGroup(endpoint)).toBe('get');
    }

    const refused = await get(`/api/sites/alpha/godmode/chats/${CHAT}`, key('read'));
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe('This key is Read only; GET /api/sites/:slug/godmode/chats/:chatId needs Manage');
    world.docker.execQueue.push(printed({ ok: true, chats: [] }));
    expect((await get('/api/sites/alpha/godmode/chats', key('manage'))).statusCode).toBe(200);

    const idle = { ok: true, state: 'idle', waiting_on: [], digest: { turns: [] } };
    world.docker.execQueue.push(printed(idle));
    const read = await mcp('manage').call('wpl7_api_get', { path: `/api/sites/alpha/godmode/chats/${CHAT}`, query: { wait: 40 } });
    expect(read).toEqual({ isError: false, value: { status: 200, endpoint: 'GET /api/sites/:slug/godmode/chats/:chatId', body: idle } });
    const readOnly = await mcp('read').call('wpl7_api_get', { path: '/api/sites/alpha/godmode/chats' });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.value.error.message).toBe('This key is Read only; GET /api/sites/:slug/godmode/chats needs Manage');
  });

  it('carries the loop an AI app follows over MCP: send on stdin, wait and read without asking, answer the card', async () => {
    const { world, mcp } = await panel();
    addSite(world, 'alpha');
    const app = mcp('manage');
    const cli = async (args: string[], stdin?: string) => {
      const { isError, value } = await app.call('wpl7_api_dangerous', {
        method: 'POST',
        path: '/api/sites/alpha/wp/cli',
        body: { args, ...(stdin !== undefined ? { stdin } : {}) },
      });
      expect(isError, JSON.stringify(value)).toBe(false);
      return JSON.parse((value.body as { stdout: string }).stdout) as Record<string, unknown>;
    };
    const wait = async (after: number) => {
      const { isError, value } = await app.call('wpl7_api_get', {
        path: `/api/sites/alpha/godmode/chats/${CHAT}`,
        query: { wait: 40, after },
      });
      expect(isError, JSON.stringify(value)).toBe(false);
      return value.body as Record<string, unknown>;
    };

    // 1. The prompt goes on stdin, however long; the command line stays short.
    world.docker.execQueue.push(printed({ ok: true, chat_id: CHAT, message_id: 'm-1', client_id: 'c-1', after: -1 }));
    const sent = await cli(['godmode', 'chat', 'send', '--new', '--message=-', '--label=Claude Code'], PROMPT);
    expect(sent).toMatchObject({ chat_id: CHAT, after: -1 });
    expect(world.docker.inputs.at(-1)!.toString('utf8')).toBe(PROMPT);

    // 2. Wait while it works, then it asks something.
    world.docker.execQueue.push(printed({ ok: true, state: 'working', waiting_on: [], working: [CHAT] }));
    expect(await wait(-1)).toMatchObject({ state: 'working' });
    const card = { chat_id: CHAT, input_id: 'plan:1727000000000', type: 'plan' };
    world.docker.execQueue.push(printed({ ok: true, state: 'waiting_for_input', waiting_on: [card] }));
    expect(await wait(-1)).toMatchObject({ state: 'waiting_for_input', waiting_on: [card] });
    expect(commands(world).slice(-2)).toEqual([
      ['wp', 'godmode', 'chat', 'wait', CHAT, '--timeout=40', '--after=-1', '--max-chars=20000'],
      ['wp', 'godmode', 'chat', 'wait', CHAT, '--timeout=40', '--after=-1', '--max-chars=20000'],
    ]);

    // 3. The card in full - a wait cuts long plans - for the user to decide on, without asking.
    const full = { ...card, plan: 'Create wp-content/mu-plugins/year.php with a [year] shortcode.' };
    world.docker.execQueue.push(printed({ ok: true, waiting_on: [full] }));
    const pending = await app.call('wpl7_api_get', { path: `/api/sites/alpha/godmode/chats/${CHAT}`, query: { pending: true } });
    expect(pending.value.body).toMatchObject({ waiting_on: [full] });
    expect(commands(world).at(-1)).toEqual(['wp', 'godmode', 'chat', 'read', CHAT, '--pending', '--max-chars=20000']);

    // 4. The answer is a command again, through the tool that asks first.
    world.docker.execQueue.push(printed({ ok: true, message_id: 'm-2', after: 1 }));
    const answer = ['godmode', 'chat', 'answer', CHAT, `--input-id=${card.input_id}`, '--approve', '--label=Claude Code'];
    expect(await cli(answer)).toMatchObject({ message_id: 'm-2' });

    // 5. Until it is idle, with the reply in the digest.
    world.docker.execQueue.push(printed({ ok: true, state: 'idle', waiting_on: [], digest: { turns: [{ reply: 'Done.' }] } }));
    expect(await wait(1)).toMatchObject({ state: 'idle', digest: { turns: [{ reply: 'Done.' }] } });
  });

  /** An exec that answers only when told to - how a 40 s wait looks to everyone else meanwhile. */
  function holdExecs(w: TestWorld) {
    const held: { cmd: string[]; opts: ExecOpts | undefined; answer: (r: RunResult) => void }[] = [];
    w.docker.exec = (_name: string, cmd: string[], opts?: ExecOpts) =>
      new Promise<RunResult>((answer) => {
        held.push({ cmd, opts, answer });
      });
    return held;
  }

  it('joins a caller to the same command already running, instead of running it twice', async () => {
    const { world, app, headers } = await panel();
    addSite(world, 'alpha');
    const held = holdExecs(world);
    const url = `/api/sites/alpha/godmode/chats/${CHAT}?wait=40&after=2`;
    // An app whose client gave up on a wait asks for it again while the first still runs.
    const first = app.inject({ method: 'GET', url, headers });
    await waitFor(() => held.length === 1);
    const second = app.inject({ method: 'GET', url, headers });
    // A different question is a command of its own.
    const other = app.inject({ method: 'GET', url: `/api/sites/alpha/godmode/chats/${CHAT}?wait=40&after=3`, headers });
    await waitFor(() => held.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(held).toHaveLength(2);

    held[0]!.answer(printed({ ok: true, state: 'idle' }));
    held[1]!.answer(printed({ ok: true, state: 'working' }));
    const [a, b, c] = await Promise.all([first, second, other]);
    expect(a.json()).toEqual({ ok: true, state: 'idle' });
    expect(b.json()).toEqual({ ok: true, state: 'idle' });
    expect(c.json()).toEqual({ ok: true, state: 'working' });
  });

  it('hangs up on a wait whose caller went away, which frees its connection to the container', async () => {
    const { world, app, key } = await panel();
    addSite(world, 'alpha');
    const held = holdExecs(world);
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { port } = app.server.address() as AddressInfo;
      const req = http.get({ host: '127.0.0.1', port, path: `/api/sites/alpha/godmode/chats/${CHAT}?wait=40`, headers: key('manage') });
      req.on('error', () => undefined);
      await waitFor(() => held.length === 1);
      const signal = held[0]!.opts!.signal!;
      expect(signal.aborted).toBe(false);
      req.destroy();
      await waitFor(() => signal.aborted);
    } finally {
      await app.close();
    }
  });

  it('answers 504 when the command ran out of time, with what to do about it over MCP', async () => {
    const { world, mcp } = await panel();
    addSite(world, 'alpha');
    world.docker.exec = async () => {
      throw timedOut('wp timed out after 55000ms and was killed inside the container');
    };
    const res = await mcp('manage').call('wpl7_api_get', { path: `/api/sites/alpha/godmode/chats/${CHAT}`, query: { wait: 40 } });
    expect(res.isError).toBe(true);
    expect(res.value).toMatchObject({ status: 504, error: { code: 'timeout' } });
    expect(res.value.hint).toMatch(/read the result first/);
  });
});
