import { describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { jobLogs, jobs, sites, type SiteRow } from '../../src/db/schema.js';
import { execLane } from '../../src/jobs/lanes.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

function addSite(w: TestWorld, slug: string, status = 'running'): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([`${slug}.test`]),
      phpVersion: '8.3',
      status,
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  w.docker.containers.set(site.containerName, status === 'running' ? 'running' : 'exited');
  return site;
}

async function runAll(w: TestWorld, ids: number[]) {
  w.worker.start();
  await waitFor(() =>
    ids.every((id) => {
      const s = w.db.select().from(jobs).where(eq(jobs.id, id)).get()!.status;
      return s !== 'queued' && s !== 'running';
    }), 10_000);
  await w.worker.stop();
  return ids.map((id) => w.db.select().from(jobs).where(eq(jobs.id, id)).get()!);
}

const logOf = (w: TestWorld, jobId: number) =>
  w.db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).orderBy(asc(jobLogs.id)).all().map((l) => l.message);

const execCalls = (w: TestWorld) =>
  w.docker.calls.filter((c) => c.method === 'exec') as { method: string; args: [string, string[], Record<string, unknown>] }[];

function queue(w: TestWorld, site: SiteRow, type: 'wp.cli' | 'site.shell', payload: Record<string, unknown>) {
  return w.worker.enqueue(type, { siteId: site.id, timeoutMin: 10, ...payload }, { id: site.id, slug: site.slug }, {
    lane: execLane(site.serverId),
    siteSlug: site.slug,
  });
}

describe('site commands as jobs', () => {
  it('runs wp-cli as www-data and puts its output in the job log', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'alpha');
    w.docker.execQueue.push({ stdout: 'Success: The cache was flushed.\n', stderr: '', exitCode: 0 });
    const job = queue(w, site, 'wp.cli', { args: ['cache', 'flush'] });
    const [done] = await runAll(w, [job.id]);

    expect(done!.status).toBe('succeeded');
    expect(JSON.parse(done!.result!)).toEqual({ exitCode: 0, lines: 1, truncated: false });
    const [name, cmd, opts] = execCalls(w).at(-1)!.args;
    expect(name).toBe('wp-alpha');
    expect(cmd).toEqual(['wp', 'cache', 'flush']);
    expect(opts).toMatchObject({ user: '33:33', workdir: '/var/www/html', timeoutMs: 600_000 });
    expect(logOf(w, job.id)).toEqual(expect.arrayContaining(['$ wp cache flush', 'Success: The cache was flushed.']));
  });

  it('runs a shell command through sh -c as www-data, never as root', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'alpha');
    w.docker.execQueue.push({ stdout: 'index.php\nwp-config.php', stderr: '', exitCode: 0 });
    const job = queue(w, site, 'site.shell', { command: 'ls | head -2', timeoutMin: 2 });
    const [done] = await runAll(w, [job.id]);

    expect(done!.status).toBe('succeeded');
    const [, cmd, opts] = execCalls(w).at(-1)!.args;
    expect(cmd).toEqual(['sh', '-c', 'ls | head -2']);
    expect(opts).toMatchObject({ user: '33:33', workdir: '/var/www/html', env: ['HOME=/tmp'], timeoutMs: 120_000 });
    // The last line has no newline after it, and still makes it into the log.
    expect(logOf(w, job.id)).toEqual(expect.arrayContaining(['index.php', 'wp-config.php']));
  });

  it('fails the job on a non-zero exit, with the exit code in the result', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'alpha');
    w.docker.execQueue.push({ stdout: '', stderr: 'Error: nope', exitCode: 3 });
    const job = queue(w, site, 'wp.cli', { args: ['nope'] });
    const [done] = await runAll(w, [job.id]);
    expect(done!.status).toBe('failed');
    expect(done!.error).toMatch(/exited with code 3/);
    expect(JSON.parse(done!.result!)).toMatchObject({ exitCode: 3 });
    expect(logOf(w, job.id)).toContain('Error: nope');
  });

  it('keeps at most a thousand lines of output', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'alpha');
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n');
    w.docker.execQueue.push({ stdout: lines, stderr: '', exitCode: 0 });
    const job = queue(w, site, 'site.shell', { command: 'seq 1500' });
    const [done] = await runAll(w, [job.id]);
    expect(JSON.parse(done!.result!)).toEqual({ exitCode: 0, lines: 1500, truncated: true });
    const log = logOf(w, job.id);
    expect(log).toContain('line 999');
    expect(log).not.toContain('line 1000');
    expect(log.some((l) => /500 more line\(s\) of output were not kept/.test(l))).toBe(true);
  });

  it('refuses a stopped site instead of starting it', async () => {
    const w = await makeWorld();
    const site = addSite(w, 'asleep', 'stopped');
    const job = queue(w, site, 'wp.cli', { args: ['cache', 'flush'] });
    const [done] = await runAll(w, [job.id]);
    expect(done!.status).toBe('failed');
    expect(done!.error).toMatch(/not running; start the site first/);
    expect(w.docker.calls.some((c) => c.method === 'startContainer')).toBe(false);
  });

  it('runs beside the server lane rather than in front of it', async () => {
    const w = await makeWorld();
    const a = addSite(w, 'alpha');
    const b = addSite(w, 'beta');
    // The command hangs until released - a long import, say.
    let release!: () => void;
    const exec = w.docker.exec.bind(w.docker);
    w.docker.exec = async (name, cmd, opts) => {
      if (cmd[0] === 'sh') await new Promise<void>((r) => (release = r));
      return exec(name, cmd, opts);
    };
    const command = queue(w, a, 'site.shell', { command: 'wp db import big.sql' });
    const restart = w.worker.enqueue('site.restart', { siteId: b.id }, { id: b.id, slug: b.slug });
    expect(command.serverId).toBeNull();
    expect(command.lane).toBe('exec:1');

    w.worker.start();
    const status = (id: number) => w.db.select().from(jobs).where(eq(jobs.id, id)).get()!.status;
    // Another site on the same server restarts while the command is still going.
    await waitFor(() => status(restart.id) === 'succeeded', 5000);
    expect(status(command.id)).toBe('running');
    release();
    await waitFor(() => status(command.id) === 'succeeded', 5000);
    await w.worker.stop();
  });
});
