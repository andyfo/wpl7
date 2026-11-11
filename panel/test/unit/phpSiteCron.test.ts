/**
 * A PHP site's cron lines: started by a tick once a minute, never through the job queue, never
 * waited for, never two of the same at once, and at most two to a server.
 */
import type { Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { jobs, siteCron, sites, type SiteRow } from '../../src/db/schema.js';
import { nextCronRun } from '../../src/services/schedules.js';
import { addPhpSite, makeApp, makeWorld, type TestWorld } from '../helpers.js';

const MIN = 60_000;

async function authed(w: TestWorld) {
  const { app } = await makeApp(w);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

/** A line, saved as the API saves it, and made due now. */
function dueLine(w: TestWorld, site: SiteRow, command: string, opts: { expr?: string; timeoutMin?: number } = {}) {
  const [line] = w.core.siteCron.save(site, [
    ...w.core.siteCron.rows(site.id).map((r) => ({ id: r.id, expr: r.expr, command: r.command, enabled: r.enabled === 1, timeoutMin: r.timeoutMin })),
    { expr: opts.expr ?? '* * * * *', command, enabled: true, timeoutMin: opts.timeoutMin ?? 5 },
  ]).slice(-1);
  w.db.update(siteCron).set({ nextRunAt: Date.now() - 1000 }).where(eq(siteCron.id, line!.id)).run();
  return line!.id;
}

const lineRow = (w: TestWorld, id: number) => w.db.select().from(siteCron).where(eq(siteCron.id, id)).get()!;

/** execToStream that holds each run until it is let go. */
function holdRuns(w: TestWorld) {
  const held: { cmd: string[]; finish: (out: string, exitCode?: number) => void }[] = [];
  vi.spyOn(w.docker, 'execToStream').mockImplementation(
    (_name: string, cmd: string[], out: Writable) =>
      new Promise((resolve) => {
        held.push({
          cmd,
          finish: (text, exitCode = 0) => {
            out.write(text);
            resolve({ exitCode, stderr: '' });
          },
        });
      }),
  );
  return held;
}

describe("a PHP site's cron lines", () => {
  it('are saved with their next run, keep their last run when saved again, and go when left out', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const { app, headers } = await authed(w);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/sites/plain/cron',
      headers,
      payload: { lines: [{ expr: '*/5 * * * *', command: 'php artisan schedule:run' }, { expr: '0 3 * * *', command: 'php backup.php', enabled: false }] },
    });
    expect(saved.statusCode).toBe(200);
    const [first, second] = saved.json().lines;
    expect(first).toMatchObject({ expr: '*/5 * * * *', schedule: 'Every 5 minutes.', enabled: true, timeoutMin: 5, running: false, last: null });
    expect(Math.abs(first.nextRunAt - nextCronRun('*/5 * * * *')!)).toBeLessThan(MIN);
    expect(second).toMatchObject({ enabled: false, nextRunAt: null });

    w.db.update(siteCron).set({ lastStartedAt: 1, lastMs: 20, lastExit: 0, lastOutput: 'ok' }).where(eq(siteCron.id, first.id)).run();
    const again = await app.inject({ method: 'PUT', url: '/api/sites/plain/cron', headers, payload: { lines: [{ id: first.id, expr: '*/5 * * * *', command: 'php artisan schedule:run --quiet' }] } });
    expect(again.json().lines).toHaveLength(1);
    expect(again.json().lines[0]).toMatchObject({ id: first.id, command: 'php artisan schedule:run --quiet', last: { exitCode: 0, output: 'ok' } });
    expect(w.core.siteCron.rows(site.id)).toHaveLength(1);
  });

  it('are refused for a WordPress site, past ten lines, and with a schedule the editor cannot read', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const { app, headers } = await authed(w);
    const eleven = Array.from({ length: 11 }, () => ({ expr: '* * * * *', command: 'true' }));
    expect((await app.inject({ method: 'PUT', url: '/api/sites/plain/cron', headers, payload: { lines: eleven } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/sites/plain/cron', headers, payload: { lines: [{ expr: 'every minute', command: 'true' }] } })).statusCode).toBe(400);
    w.db.update(sites).set({ app: 'wordpress' }).where(eq(sites.id, site.id)).run();
    const wp = await app.inject({ method: 'GET', url: '/api/sites/plain/cron', headers });
    expect(wp.statusCode).toBe(409);
  });

  it('run as www-data in the site folder, outside the job queue, with the command as an argument of its own', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const id = dueLine(w, site, 'php cron.php "$HOME"');
    w.docker.streamQueue.push({ stdout: Buffer.from('done\n'), exitCode: 0 });
    expect(w.core.siteCron.tick()).toEqual({ started: 1, waiting: 0 });
    await w.core.siteCron.idle();
    const call = w.docker.calls.find((c) => c.method === 'execToStream')!;
    expect(call.args[0]).toBe('wp-plain');
    expect(call.args[1]).toEqual(['sh', '-c', 'sh -c "$1" 2>&1', 'sh', 'php cron.php "$HOME"']);
    expect(call.args[2]).toMatchObject({ user: '33:33', workdir: '/var/www/html', timeoutMs: 5 * MIN });
    expect(lineRow(w, id)).toMatchObject({ lastExit: 0, lastOutput: 'done\n', lastError: null });
    expect(lineRow(w, id).lastMs).not.toBeNull();
    expect(lineRow(w, id).nextRunAt!).toBeGreaterThan(Date.now());
    expect(w.db.select().from(jobs).all()).toEqual([]);
  });

  it('keep the end of the output, and say when a run was stopped at its time', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const id = dueLine(w, site, 'yes | head -c 100000', { timeoutMin: 1 });
    // As DockerService ends a command that its timeout stopped: the output came, then the error.
    const { timedOut } = await import('../../src/lib/errors.js');
    vi.spyOn(w.docker, 'execToStream').mockImplementation(async (_n: string, _c: string[], out: Writable) => {
      out.write(`${'x'.repeat(10_000)}THE END`);
      throw timedOut('sh timed out after 60000ms and was killed inside the container');
    });
    w.core.siteCron.tick();
    await w.core.siteCron.idle();
    const row = lineRow(w, id);
    expect(row.lastOutput!.length).toBe(4096);
    expect(row.lastOutput!.endsWith('THE END')).toBe(true);
    expect([row.lastExit, row.lastError]).toEqual([124, 'Stopped after 1 minute.']);
  });

  it('never start one still running, at most two to a server, and the rest stay due', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const held = holdRuns(w);
    const a = dueLine(w, site, 'sleep 100');
    const b = dueLine(w, site, 'sleep 200');
    const c = dueLine(w, site, 'sleep 300');
    expect(w.core.siteCron.tick()).toEqual({ started: 2, waiting: 1 });
    expect(held.map((h) => h.cmd.at(-1))).toEqual(['sleep 100', 'sleep 200']);
    // The third waits, due; the first two are running, and their time now is skipped.
    expect(lineRow(w, c).nextRunAt!).toBeLessThan(Date.now());
    w.db.update(siteCron).set({ nextRunAt: Date.now() - 1000 }).where(eq(siteCron.id, a)).run();
    expect(w.core.siteCron.tick()).toEqual({ started: 0, waiting: 1 });
    expect(lineRow(w, a).nextRunAt!).toBeGreaterThan(Date.now());
    held[0]!.finish('');
    await new Promise((r) => setImmediate(r));
    expect(w.core.siteCron.tick()).toEqual({ started: 1, waiting: 0 });
    expect(held.map((h) => h.cmd.at(-1))).toEqual(['sleep 100', 'sleep 200', 'sleep 300']);
    for (const h of held.slice(1)) h.finish('');
    await w.core.siteCron.idle();
    expect(lineRow(w, b).lastExit).toBe(0);
  });

  it('wait while the site is stopped or busy, and run once when it is back', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const id = dueLine(w, site, 'true');
    w.db.update(sites).set({ status: 'stopped' }).where(eq(sites.id, site.id)).run();
    expect(w.core.siteCron.tick()).toEqual({ started: 0, waiting: 1 });
    w.db.update(sites).set({ status: 'running' }).where(eq(sites.id, site.id)).run();
    w.core.monitor.busySlugs.add('plain');
    expect(w.core.siteCron.tick()).toEqual({ started: 0, waiting: 1 });
    w.core.monitor.busySlugs.delete('plain');
    // Due for a while now: it runs once.
    expect(w.core.siteCron.tick()).toEqual({ started: 1, waiting: 0 });
    await w.core.siteCron.idle();
    expect(w.core.siteCron.tick()).toEqual({ started: 0, waiting: 0 });
    expect(lineRow(w, id).nextRunAt!).toBeGreaterThan(Date.now());
  });

  it('count a run the panel lost sight of in a restart as running until its stop-after time', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const id = dueLine(w, site, 'sleep 60', { timeoutMin: 5 });
    w.db.update(siteCron).set({ lastStartedAt: Date.now() - MIN }).where(eq(siteCron.id, id)).run();
    expect(w.core.siteCron.tick().started).toBe(0);
    expect(w.core.siteCron.list(w.deps.sites.bySlug('plain'))[0]!.running).toBe(true);
    w.db.update(siteCron).set({ lastStartedAt: Date.now() - 6 * MIN, nextRunAt: Date.now() - 1000 }).where(eq(siteCron.id, id)).run();
    expect(w.core.siteCron.tick().started).toBe(1);
    await w.core.siteCron.idle();
  });

  it('run now: started at once, refused while it runs', async () => {
    const w = await makeWorld();
    const site = addPhpSite(w, 'plain');
    const held = holdRuns(w);
    const [line] = w.core.siteCron.save(site, [{ expr: '0 3 * * *', command: 'php report.php', enabled: true, timeoutMin: 5 }]);
    const { app, headers } = await authed(w);
    const run = await app.inject({ method: 'POST', url: `/api/sites/plain/cron/${line!.id}/run`, headers });
    expect(run.statusCode).toBe(200);
    expect(run.json().line).toMatchObject({ running: true });
    // A run by hand keeps the line's own next time.
    expect(lineRow(w, line!.id).nextRunAt).toBe(line!.nextRunAt);
    const again = await app.inject({ method: 'POST', url: `/api/sites/plain/cron/${line!.id}/run`, headers });
    expect([again.statusCode, again.json().error.message]).toEqual([409, 'This line is running already.']);
    held[0]!.finish('report sent');
    await w.core.siteCron.idle();
    expect(lineRow(w, line!.id).lastOutput).toBe('report sent');
  });
});
