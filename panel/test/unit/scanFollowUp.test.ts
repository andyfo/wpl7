/**
 * What follows a malware scan (services/malwareScan.ts): the site's on-finding setting, the
 * operator's alert and the schedule that queues the scans - and "Reinstall original".
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, servers, siteScanFindings, siteScanStatus, siteSecurity, sites, type SiteRow } from '../../src/db/schema.js';
import type { EphemeralOpts } from '../../src/services/docker.js';
import type { RunResult } from '../../src/lib/exec.js';
import { MAX_AUTO_QUARANTINE } from '../../src/services/scanPolicy.js';
import { MAX_SCANS_IN_FLIGHT } from '../../src/services/malwareScan.js';
import { makeWorld, waitFor, type TestWorld } from '../helpers.js';

const HASH = 'c'.repeat(64);
const log = { info: () => undefined, warn: () => undefined, checkCanceled: () => undefined };
const out = (...lines: object[]): RunResult => ({ stdout: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', stderr: '', exitCode: 0 });
const checkSummary = { t: 'summary', engine: 'check', complete: true, files: 10, unreadable: 0, findings: 0, truncated: false, packages: {}, links: [] };
const sigSummary = { t: 'summary', engine: 'signatures', exit: 1, report: true, scanned: 5, complete: true, errors: 0, unreadable: 0, findings: 1, truncated: false };

function addSite(w: TestWorld, slug = 'alpha', serverId = 1): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      serverId,
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
  fs.mkdirSync(path.join(w.config.paths.sites, slug, 'wordpress'), { recursive: true });
  return site;
}

/** A scan that finds what `found` says, and a quarantine container that always manages. */
function world(w: TestWorld, found: () => { check?: object[]; signatures?: object[] }) {
  const moved: string[] = [];
  w.docker.ephemeral = (opts: EphemeralOpts) => {
    if (opts.labels?.['wpl7.quarantine']) {
      const args = opts.cmd.slice(-4);
      moved.push(args[1]!);
      return { stdout: '{"mode":"644","size":10}\n', stderr: '', exitCode: 0 };
    }
    const which = opts.labels?.['wpl7.scan'];
    if (which === 'inventory') return out({ t: 'inventory', core: null, plugins: [], themes: [] });
    if (which === 'check') return out(...(found().check ?? []), checkSummary);
    return out(...(found().signatures ?? []), sigSummary);
  };
  return moved;
}

const malware = (p: string) => ({ t: 'finding', path: p, rule: 'sign:abcd1234', severity: 'danger', message: 'Malware Signature', line: 1, sha256: HASH });
const candidate = (p: string) => ({ t: 'finding', path: p, rule: 'function:exec', severity: 'warn', message: 'Potentially dangerous function', line: 3 });

async function scanAndFollow(w: TestWorld, site: SiteRow) {
  const result = await w.core.malwareScan.scan(log, site.id, 'schedule', null);
  return { result, after: await w.core.malwareScan.followUp(log, w.worker, site.id, result) };
}

const setOnFinding = (w: TestWorld, site: SiteRow, mode: string) =>
  w.db.insert(siteSecurity).values({ siteId: site.id, scanOnFinding: mode, updatedAt: Date.now() }).onConflictDoUpdate({ target: siteSecurity.siteId, set: { scanOnFinding: mode } }).run();

describe('after a scan', () => {
  it('reports and alerts by default, moving nothing', async () => {
    const w = await makeWorld();
    w.core.settings.set('alertEmail', 'ops@example.com');
    const site = addSite(w);
    const moved = world(w, () => ({ signatures: [malware('wp-content/uploads/x.php')] }));
    const notify = vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);
    const { after } = await scanAndFollow(w, site);
    expect(moved).toEqual([]);
    expect(after.alerted).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    const [subject, body] = notify.mock.calls[0]!;
    expect(subject).toBe('Malware scan: 1 new finding on "alpha"');
    expect(body).toContain('Known malware: wp-content/uploads/x.php (line 1)');
  });

  it('moves confirmed malware where that is safe, says so, and marks its findings', async () => {
    const w = await makeWorld();
    const site = addSite(w);
    setOnFinding(w, site, 'quarantine-confirmed');
    const moved = world(w, () => ({
      signatures: [malware('wp-content/uploads/x.php'), malware('wp-config.php'), candidate('wp-content/uploads/y.php')],
    }));
    const notify = vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);
    const { after } = await scanAndFollow(w, site);
    expect(moved).toEqual(['wp-content/uploads/x.php']);
    expect(after.moved.map((m) => [m.path, m.movedBy, m.reason])).toEqual([['wp-content/uploads/x.php', 'automatic', 'Known malware']]);
    const status = (p: string) => w.db.select().from(siteScanFindings).all().filter((f) => f.path === p).map((f) => f.status);
    expect(status('wp-content/uploads/x.php')).toEqual(['quarantined']);
    expect(status('wp-config.php')).toEqual(['open']);
    expect(status('wp-content/uploads/y.php')).toEqual(['open']);
    expect(w.db.select().from(siteScanStatus).where(eq(siteScanStatus.siteId, site.id)).get()).toMatchObject({ quarantined: 1, openConfirmed: 1 });
    expect(notify.mock.calls[0]![1]).toContain("Moved to quarantine - restorable from the site's Security tab:\n  - wp-content/uploads/x.php (Known malware)");
  });

  it(`moves nothing, and asks for a person, when more than ${MAX_AUTO_QUARANTINE} files would go`, async () => {
    const w = await makeWorld();
    const site = addSite(w);
    setOnFinding(w, site, 'quarantine-confirmed');
    const moved = world(w, () => ({ signatures: Array.from({ length: MAX_AUTO_QUARANTINE + 1 }, (_, i) => malware(`wp-content/uploads/${i}.php`)) }));
    const notify = vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);
    const { after } = await scanAndFollow(w, site);
    expect(moved).toEqual([]);
    expect(after.overLimit).toBe(MAX_AUTO_QUARANTINE + 1);
    expect(notify.mock.calls[0]![1]).toContain('needs a person to look at it, not an automatic clean-up');
  });

  it('keeps the files of a site that is busy with a job, until the next scan', async () => {
    const w = await makeWorld();
    const site = addSite(w);
    setOnFinding(w, site, 'quarantine-confirmed');
    const moved = world(w, () => ({ signatures: [malware('wp-content/uploads/x.php')] }));
    vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);
    w.worker.enqueue('site.restart', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: 1 });
    const { after } = await scanAndFollow(w, site);
    expect(moved).toEqual([]);
    expect(after.skipped).toMatch(/^Nothing was moved to quarantine: Site "alpha" is busy with job #\d+ \(site\.restart\)/);
  });

  it('never alerts on suspicious-code candidates, and at most once in six hours', async () => {
    const w = await makeWorld();
    const site = addSite(w);
    let found: object[] = [candidate('wp-content/plugins/premium/p.php')];
    world(w, () => ({ signatures: found }));
    const notify = vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);
    expect((await scanAndFollow(w, site)).after.alerted).toBe(false);

    found = [malware('wp-content/uploads/a.php')];
    expect((await scanAndFollow(w, site)).after.alerted).toBe(true);
    found = [malware('wp-content/uploads/a.php'), malware('wp-content/uploads/b.php')];
    expect((await scanAndFollow(w, site)).after.alerted).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    w.db.update(siteScanStatus).set({ lastAlertAt: Date.now() - 7 * 3600_000 }).where(eq(siteScanStatus.siteId, site.id)).run();
    found = [malware('wp-content/uploads/a.php'), malware('wp-content/uploads/b.php'), malware('wp-content/uploads/c.php')];
    expect((await scanAndFollow(w, site)).after.alerted).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('alerts on the third failed scan in a row', async () => {
    const w = await makeWorld();
    const site = addSite(w);
    w.docker.ephemeral = () => ({ stdout: '', stderr: 'no such image', exitCode: 125 });
    const notify = vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);
    for (let i = 1; i <= 3; i++) await scanAndFollow(w, site);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe('Malware scan of "alpha" has failed three times');
  });
});

describe('the malware-scan schedule', () => {
  const pass = (w: TestWorld, memory: (id: number) => number | null = () => 0.5) => w.core.malwareScan.schedulePass(w.worker, memory);

  it('queues what is due, asked-for first, then never scanned, then the most overdue - one per server', async () => {
    const w = await makeWorld();
    const s2 = w.addSshServer('s2');
    const s3 = w.addSshServer('s3');
    const now = Date.now();
    const old = addSite(w, 'old', 1);
    const older = addSite(w, 'older', 1);
    const fresh = addSite(w, 'fresh', s2.id);
    const asked = addSite(w, 'asked', s3.id);
    const never = addSite(w, 'never', s2.id);
    const status = (site: SiteRow, v: object) => w.db.insert(siteScanStatus).values({ siteId: site.id, ...v }).run();
    status(old, { lastFinishedAt: now - 25 * 3600_000 });
    status(older, { lastFinishedAt: now - 48 * 3600_000 });
    status(fresh, { lastFinishedAt: now - 3600_000 });
    status(asked, { lastFinishedAt: now - 3600_000, requestedAt: now - 60_000 });
    void never;

    expect(pass(w)).toEqual({ queued: ['asked', 'never', 'older'], deferred: [] });
    const queued = w.db.select().from(jobs).where(eq(jobs.type, 'site.malwareScan')).all();
    expect(queued.map((j) => [j.lane, JSON.parse(j.payload).trigger])).toEqual([
      [`scan:${s3.id}`, 'manual'],
      [`scan:${s2.id}`, 'schedule'],
      ['scan:1', 'schedule'],
    ]);
    // The fleet is full: nothing more until one finishes.
    expect(queued).toHaveLength(MAX_SCANS_IN_FLIGHT);
    expect(pass(w)).toEqual({ queued: [], deferred: [] });
  });

  it('leaves a server short of memory, or away, for later, and a site switched off alone', async () => {
    const w = await makeWorld();
    const s2 = w.addSshServer('s2');
    addSite(w, 'busy', 1);
    addSite(w, 'away', s2.id);
    const off = addSite(w, 'off', 1);
    w.db.insert(siteSecurity).values({ siteId: off.id, scanEnabled: 0, updatedAt: Date.now() }).run();
    w.db.update(servers).set({ status: 'unreachable' }).where(eq(servers.id, s2.id)).run();
    const result = pass(w, (id) => (id === 1 ? 0.93 : 0.2));
    expect(result.queued).toEqual([]);
    expect(result.deferred.map((d) => [d.siteSlug, d.reason]).sort()).toEqual([
      ['away', 'Its server "s2" is not answering'],
      ['busy', '"local" is using 93% of its memory'],
    ]);
  });

  it('scans nothing when scans are off for the fleet, except a site switched on itself', async () => {
    const w = await makeWorld();
    w.core.settings.set('scanEnabled', false);
    addSite(w, 'a', 1);
    const on = addSite(w, 'b', 1);
    w.db.insert(siteSecurity).values({ siteId: on.id, scanEnabled: 1, updatedAt: Date.now() }).run();
    expect(pass(w).queued).toEqual(['b']);
  });
});

describe('Reinstall original', () => {
  it('downloads the version the files say, with every plugin and theme skipped, then scans again', async () => {
    const w = await makeWorld();
    const site = addSite(w);
    w.docker.containers.set('wp-alpha', 'running');
    w.docker.ephemeral = () =>
      out({ t: 'inventory', core: { version: '6.9.1', locale: 'de_DE' }, plugins: [{ slug: 'akismet', version: '5.3' }], themes: [] });
    const run = async (pkg: string) => {
      const job = w.worker.enqueue('wp.reinstall', { siteId: site.id, package: pkg }, { id: site.id, slug: site.slug, serverId: 1 });
      w.worker.start();
      await waitFor(() => !['queued', 'running'].includes(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status), 10_000);
      await w.worker.stop();
      return w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    };
    const wpCalls = () => w.docker.calls.filter((c) => c.method === 'exec' && (c.args[1] as string[])[0] === 'wp').map((c) => (c.args[1] as string[]).slice(1));

    expect((await run('plugin:akismet')).status).toBe('succeeded');
    expect(wpCalls().at(-1)).toEqual(['plugin', 'install', 'akismet', '--version=5.3', '--force', '--skip-plugins', '--skip-themes']);
    expect((await run('core')).status).toBe('succeeded');
    expect(wpCalls().at(-1)).toEqual(['core', 'download', '--version=6.9.1', '--locale=de_DE', '--force', '--skip-content']);
    // One confirming scan after each (the first had run by the time the second was queued).
    const rescans = w.db.select().from(jobs).where(eq(jobs.type, 'site.malwareScan')).all();
    expect(rescans.map((j) => JSON.parse(j.payload).trigger)).toEqual(['rescan', 'rescan']);

    const missing = await run('plugin:gone');
    expect(missing.status).toBe('failed');
    expect(missing.error).toContain('The plugin "gone" is not installed');
  });
});
