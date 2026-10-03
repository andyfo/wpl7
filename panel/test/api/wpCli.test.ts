/**
 * `POST /api/sites/:slug/wp/cli` with `stdin`: what `wp … --message=-` reads, handed to the
 * command and to nothing else - not the job's summary, its DTO or its log, and not the panel's
 * own log.
 */
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, schedules, sites, type SiteRow } from '../../src/db/schema.js';
import type { JobDto } from '../../shared/types.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const CHAT = '0b6f4a3e-8c1d-4f2a-9e57-2d9c1a7b5e10';
const SEND = ['godmode', 'chat', 'send', CHAT, '--message=-'];
/** Two lines, and a word no command line, summary or log line would hold unless it leaked. */
const PROMPT = 'Add a hello-world shortcode.\nPut it in a mu-plugin and say which file: zanzibar.';
const LEAK = 'zanzibar';

async function authedApp() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

function addRunningSite(w: TestWorld, slug: string): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status: 'running',
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  w.docker.containers.set(site.containerName, 'running');
  return site;
}

type ExecCall = { method: string; args: [string, string[], Record<string, unknown>] };
const callsOf = (w: TestWorld, method: 'exec' | 'execWithInput') =>
  w.docker.calls.filter((c) => c.method === method) as ExecCall[];

/** Who and where a command ran: the part of its exec options that must never differ. */
const identity = (opts: Record<string, unknown>) => ({ user: opts.user, env: opts.env, workdir: opts.workdir });

async function runJob(w: TestWorld, id: number) {
  w.worker.start();
  await waitFor(() => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, id)).get()!.status), 10_000);
  await w.worker.stop();
  return w.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
}

describe('WP-CLI with stdin', () => {
  it('hands stdin to the command, as the same user and in the same place as any wp-cli call, within the request', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const printed = `${JSON.stringify({ ok: true, chat_id: CHAT, message_id: 'm-1', after: 3 })}\n`;
    world.docker.execQueue.push({ stdout: printed, stderr: '', exitCode: 0 });

    const res = await app.inject({ method: 'POST', url: '/api/sites/alpha/wp/cli', headers, payload: { args: SEND, stdin: PROMPT } });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ stdout: printed, stderr: '', exitCode: 0 });
    const [withInput] = callsOf(world, 'execWithInput');
    const [name, cmd, opts] = withInput!.args;
    expect(name).toBe('wp-alpha');
    expect(cmd).toEqual(['wp', ...SEND]);
    expect(opts).toMatchObject({ timeoutMs: 55_000 });
    expect(world.docker.inputs[0]!.toString('utf8')).toBe(PROMPT);
    expect(callsOf(world, 'exec')).toHaveLength(0);

    // Without stdin it is the plain exec it always was - as the same www-data, HOME and folder.
    const plain = await app.inject({ method: 'POST', url: '/api/sites/alpha/wp/cli', headers, payload: { args: ['option', 'get', 'home'] } });
    expect(plain.statusCode).toBe(200);
    const [, plainCmd, plainOpts] = callsOf(world, 'exec').at(-1)!.args;
    expect(plainCmd).toEqual(['wp', 'option', 'get', 'home']);
    expect(identity(opts)).toEqual(identity(plainOpts));
    expect(identity(opts)).toEqual({ user: '33:33', env: ['HOME=/tmp'], workdir: '/var/www/html' });
    expect(callsOf(world, 'execWithInput')).toHaveLength(1);
  });

  it('takes 64 KB of stdin, counted in bytes rather than characters', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const send = (stdin: string) =>
      app.inject({ method: 'POST', url: '/api/sites/alpha/wp/cli', headers, payload: { args: SEND, stdin } });

    // "é" is one character and two bytes: 32 Ki of them are exactly 64 KB.
    expect((await send('é'.repeat(32 * 1024))).statusCode).toBe(200);
    const over = await send('é'.repeat(32 * 1024 + 1));
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatchObject({ code: 'validation_error' });
    expect(JSON.stringify(over.json())).toMatch(/64 KB, counted in UTF-8 bytes/);
    // Far fewer characters than the limit, and still too much for it.
    expect((await send('😀'.repeat(20_000))).statusCode).toBe(400);
    expect(callsOf(world, 'execWithInput')).toHaveLength(1);
  });

  it('queues stdin with the job and shows only how much there was: in the summary, the DTO, the log and the panel log', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const panelLog = vi.spyOn(app.log, 'info');

    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/cli',
      headers,
      payload: { args: SEND, stdin: PROMPT, async: true, timeoutMin: 2 },
    });
    expect(res.statusCode, res.body).toBe(202);
    const job = (res.json() as { job: JobDto }).job;
    const note = `+ stdin, ${Buffer.byteLength(PROMPT)} bytes`;
    expect(job).toMatchObject({ type: 'wp.cli', summary: `wp godmode chat send ${CHAT} --message=- ${note}` });
    expect(res.body).not.toContain(LEAK);

    world.docker.execQueue.push({
      stdout: `${JSON.stringify({ ok: true, chat_id: CHAT, message_id: 'm-1', after: 3 })}\nsecond line\n`,
      stderr: 'PHP Notice: something noisy\n',
      exitCode: 0,
    });
    const done = await runJob(world, job.id);
    expect(done.status).toBe('succeeded');
    expect(JSON.parse(done.result!)).toEqual({ exitCode: 0, lines: 3, truncated: false });

    // The command got it, in the job's own lane and time limit...
    expect(world.docker.inputs.at(-1)!.toString('utf8')).toBe(PROMPT);
    const [, cmd, opts] = callsOf(world, 'execWithInput').at(-1)!.args;
    expect(cmd).toEqual(['wp', ...SEND]);
    expect(opts).toMatchObject({ user: '33:33', env: ['HOME=/tmp'], workdir: '/var/www/html', timeoutMs: 120_000 });

    // ...the job forgot it once it ended...
    expect(JSON.parse(done.payload)).toEqual({ siteId: expect.any(Number), args: SEND, timeoutMin: 2 });
    expect(done.payload).not.toContain(LEAK);

    // ...its output reached the log line by line, as it came...
    const detail = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}?logAfter=0`, headers });
    const messages = (detail.json() as { logs: { message: string }[] }).logs.map((l) => l.message);
    expect(messages).toEqual([
      `$ wp godmode chat send ${CHAT} --message=- ${note}`,
      `{"ok":true,"chat_id":"${CHAT}","message_id":"m-1","after":3}`,
      'second line',
      'PHP Notice: something noisy',
      'Finished (exit code 0).',
    ]);

    // ...and nothing that shows the job, finds it or logged the request has the text.
    expect(detail.body).not.toContain(LEAK);
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers });
    expect(list.body).not.toContain(LEAK);
    const search = await app.inject({ method: 'GET', url: `/api/jobs?q=${LEAK}`, headers });
    expect((search.json() as { items: JobDto[] }).items).toHaveLength(0);
    // The panel's own lines, the audit entry among them. Fastify's request lines are handed the
    // raw request, which its serializer cuts down to method, URL and address before writing.
    const own = panelLog.mock.calls.filter(([first]) => !(first && typeof first === 'object' && ('req' in first || 'res' in first)));
    expect(own.some(([line]) => JSON.stringify(line).includes('"wpCli"'))).toBe(true);
    expect(JSON.stringify(own)).not.toContain(LEAK);
  });

  it('fails a queued stdin command on a non-zero exit, with what it printed in the log', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/cli',
      headers,
      payload: { args: SEND, stdin: PROMPT, async: true },
    });
    const job = (res.json() as { job: JobDto }).job;
    world.docker.execQueue.push({ stdout: '{"ok":false,"error":{"code":"not_found","message":"No such chat"}}\n', stderr: '', exitCode: 1 });

    const done = await runJob(world, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/exited with code 1/);
    const detail = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}?logAfter=0`, headers });
    expect(detail.body).toContain('No such chat');
    expect(detail.body).not.toContain(LEAK);
  });

  it('never queues a WP Godmode wait, which would hold the command lane of every site on the server', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const cli = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/sites/alpha/wp/cli', headers, payload });

    for (const args of [
      ['godmode', 'chat', 'wait', CHAT, '--timeout=45'],
      ['--user=admin', 'godmode', 'chat', 'wait', CHAT],
      [...SEND, '--wait=30'],
      // WP Godmode reads the number with PHP's `$`, which lets a trailing newline through.
      [...SEND, '--wait=30\n'],
      ['godmode', 'agent', 'create', '--name=Audit', '--goal=Audit the site', '--start', '--wait=40'],
      // A wait handed over on stdin: --prompt asks for it by name, or for every argument.
      ['godmode', 'chat', 'answer', CHAT, '--input-id=plan:1727', '--approve', '--prompt=wait'],
      ['godmode', 'chat', 'answer', CHAT, '--prompt'],
    ]) {
      const res = await cli({ args, async: true, stdin: args.some((a) => a.startsWith('--prompt')) ? '30' : PROMPT });
      expect(res.statusCode, args.join(' ')).toBe(400);
      expect(res.json().error.message).toContain('GET /api/sites/<slug>/godmode/chats/<chatId>?wait=40');
    }
    expect(world.db.select().from(jobs).all()).toHaveLength(0);

    // A wait answers within the request instead, and what does not wait is queued as ever - a bare
    // `--wait` and an empty one included: WP-CLI hands them over as true and '', no wait at all.
    expect((await cli({ args: ['godmode', 'chat', 'wait', CHAT, '--timeout=5'] })).statusCode).toBe(200);
    for (const wait of ['--wait=0', '--wait', '--wait=']) {
      const queued = await cli({ args: [...SEND, wait], stdin: PROMPT, async: true });
      expect(queued.statusCode, wait).toBe(202);
      world.worker.cancel(queued.json().job.id);
    }
  });

  it('masks what --prompt was handed in the job log: WP-CLI echoes every answer, and the command it ran', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const password = "hunter2's-pass";
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/cli',
      headers,
      payload: { args: ['user', 'update', 'admin', '--prompt=user_pass'], stdin: `${password}\n`, async: true },
    });
    const job = (res.json() as { job: JobDto }).job;
    // What WP-CLI 2.12 prints for it: readline's echo of the answer, then the command, shell-quoted.
    world.docker.execQueue.push({
      stdout: `1/14 [--user_pass=<password>]: ${password}\nwp user update 'admin' --user_pass='hunter2'\\''s-pass'\nSuccess: Updated user 1.\n`,
      stderr: '',
      exitCode: 0,
    });
    expect((await runJob(world, job.id)).status).toBe('succeeded');

    const detail = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}?logAfter=0`, headers });
    const messages = (detail.json() as { logs: { message: string }[] }).logs.map((l) => l.message);
    expect(messages).toEqual([
      `$ wp user update admin --prompt=user_pass + stdin, ${Buffer.byteLength(password) + 1} bytes`,
      '1/14 [--user_pass=<password>]: ••••••',
      "wp user update 'admin' --user_pass='••••••'",
      'Success: Updated user 1.',
      'Finished (exit code 0).',
    ]);
    expect(detail.body).not.toContain('hunter2');
  });

  it('forgets stdin when a queued command is canceled before it ran', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/alpha/wp/cli',
      headers,
      payload: { args: SEND, stdin: PROMPT, async: true },
    });
    const job = (res.json() as { job: JobDto }).job;
    expect(world.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.payload).toContain(LEAK);
    expect(world.worker.cancel(job.id)).toBe('canceled');
    expect(world.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.payload).not.toContain(LEAK);
  });

  it('refuses a custom schedule that would queue a WP Godmode wait, and stops one saved before that rule', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const schedule = (args: string[]) =>
      app.inject({
        method: 'POST',
        url: '/api/schedules',
        headers,
        payload: { name: 'Follow the chat', action: 'wp.cli', target: { kind: 'sites', slugs: ['alpha'] }, params: { args }, cron: '*/5 * * * *' },
      });
    const refused = await schedule(['godmode', 'chat', 'wait', CHAT, '--timeout=600']);
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('A WP Godmode wait cannot run as a job');

    // One saved before the rule existed: its stored params are what a run reads.
    const saved = await schedule(['godmode', 'chat', 'list']);
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().schedule.id as number;
    world.db
      .update(schedules)
      .set({ params: JSON.stringify({ args: ['godmode', 'chat', 'wait', CHAT], timeoutMin: 60 }) })
      .where(eq(schedules.id, id))
      .run();
    const run = await app.inject({ method: 'POST', url: `/api/schedules/${id}/run`, headers });
    expect(run.json()).toMatchObject({ jobs: [], skipped: [] });
    expect(world.db.select().from(jobs).all()).toHaveLength(0);
    const after = (await app.inject({ method: 'GET', url: `/api/schedules/${id}`, headers })).json().schedule;
    expect(after.lastOutcome).toBe('skipped');
    expect(after.lastResult.message).toContain('A WP Godmode wait cannot run as a job');
  });

  it('leaves custom schedules as they were: a scheduled command takes no stdin', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const res = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers,
      payload: {
        name: 'Nightly nudge',
        action: 'wp.cli',
        target: { kind: 'sites', slugs: ['alpha'] },
        params: { args: SEND, stdin: PROMPT },
        cron: '0 4 * * *',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('WP-CLI help', () => {
  const help = (app: Awaited<ReturnType<typeof authedApp>>['app'], headers: Record<string, string>, query = '') =>
    app.inject({ method: 'GET', url: `/api/sites/alpha/wp/cli/help${query}`, headers });

  it("reads a command's help as wp help prints it, with how the panel reaches WP Godmode's", async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    const text = 'NAME\n\n  wp godmode\n\nDESCRIPTION\n\n  Drive Godmode chats and agents: send, wait, answer, read.\n';
    world.docker.execQueue.push({ stdout: text, stderr: '', exitCode: 0 });

    const res = await help(app, headers, '?command=godmode');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      command: 'godmode',
      help: text.trimEnd(),
      panel: expect.stringContaining('GET /api/sites/alpha/godmode/chats/<chat_id>?wait=40'),
    });
    const [, cmd, opts] = callsOf(world, 'exec').at(-1)!.args;
    expect(cmd).toEqual(['wp', 'help', 'godmode']);
    expect(opts).toMatchObject({ user: '33:33', timeoutMs: 30_000, outputCap: 256 * 1024 });

    // Any other command's help comes as it is; spaces between its words do not matter.
    world.docker.execQueue.push({ stdout: 'NAME\n\n  wp plugin list\n', stderr: '', exitCode: 0 });
    expect((await help(app, headers, '?command=%20plugin%20%20list')).json()).toEqual({ command: 'plugin list', help: 'NAME\n\n  wp plugin list' });
    expect(callsOf(world, 'exec').at(-1)!.args[1]).toEqual(['wp', 'help', 'plugin', 'list']);
    // No command: every one the site has, WP-CLI's own and its plugins'.
    world.docker.execQueue.push({ stdout: 'SUBCOMMANDS\n\n  godmode  Drive Godmode chats\n', stderr: '', exitCode: 0 });
    expect((await help(app, headers)).json()).toMatchObject({ command: null });
    expect(callsOf(world, 'exec').at(-1)!.args[1]).toEqual(['wp', 'help']);
  });

  it("leaves out WP-CLI's global parameters, the same for every command", async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    // As WP-CLI 2.12 prints them, shortened: `wp help plugin list`, then `wp help`.
    const globals =
      'GLOBAL PARAMETERS\n\n  --path=<path>\n      Path to the WordPress files.\n\n' +
      '  --user=<id|login|email>\n      Set the WordPress user.\n\n';
    const command = 'NAME\n\n  wp plugin list\n\nDESCRIPTION\n\n  Gets a list of plugins.\n\nEXAMPLES\n\n    $ wp plugin list --status=active\n';
    world.docker.execQueue.push({ stdout: `${command}\n${globals}`, stderr: '', exitCode: 0 });
    expect((await help(app, headers, '?command=plugin%20list')).json().help).toBe(command.trimEnd());

    const all = 'NAME\n\n  wp\n\nSUBCOMMANDS\n\n  cache                 Adds, removes, fetches, and flushes the WP Object Cache\n';
    world.docker.execQueue.push({
      stdout: `${all}\n\n\n${globals}  Run 'wp help <command>' to get more information on a specific command.\n\n`,
      stderr: '',
      exitCode: 0,
    });
    expect((await help(app, headers)).json().help).toBe(all.trimEnd());

    // A plugin's own heading of that name stays: the section goes from the last one, WP-CLI's.
    const guide = 'NAME\n\n  wp shop\n\nGLOBAL PARAMETERS\n\n  Every shop command takes --store=<id>.\n';
    world.docker.execQueue.push({ stdout: `${guide}\n${globals}`, stderr: '', exitCode: 0 });
    expect((await help(app, headers, '?command=shop')).json().help).toBe(guide.trimEnd());
  });

  it('answers 404 for a command the site does not have', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    world.docker.execQueue.push({ stdout: '', stderr: "Error: 'nope' is not a registered wp command. See 'wp help' for available commands.\n", exitCode: 1 });
    const res = await help(app, headers, '?command=nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain('GET /api/sites/alpha/wp/cli/help lists what does exist');
  });

  it('runs nothing but help: words only, never a flag', async () => {
    const { app, world, headers } = await authedApp();
    addRunningSite(world, 'alpha');
    for (const command of ['--exec=phpinfo();', 'godmode --require=/tmp/x.php', 'eval phpinfo();', 'Godmode', '../x', 'a b c d e f g', 'x'.repeat(201)]) {
      const res = await help(app, headers, `?command=${encodeURIComponent(command)}`);
      expect(res.statusCode, command).toBe(400);
    }
    expect((await help(app, headers, '?command=godmode&exec=1')).statusCode).toBe(400);
    expect(callsOf(world, 'exec')).toHaveLength(0);
  });

  it('is a read, which a Read only key may make and an AI app makes without being asked', async () => {
    const { app, world } = await authedApp();
    addRunningSite(world, 'alpha');
    const { endpointFor, mcpToolGroup } = await import('../../shared/apiDocs.js');
    const endpoint = endpointFor('GET', '/api/sites/:slug/wp/cli/help')!;
    expect(endpoint).toMatchObject({ level: 'read' });
    expect(mcpToolGroup(endpoint)).toBe('get');
    const token = world.deps.apiKeys.create('reader', 'read').token;
    world.docker.execQueue.push({ stdout: 'NAME\n', stderr: '', exitCode: 0 });
    expect((await help(app, { authorization: `Bearer ${token}` }, '?command=godmode')).statusCode).toBe(200);
  });
});
