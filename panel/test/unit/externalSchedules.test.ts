import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, sites } from '../../src/db/schema.js';
import { fireAction, ineligible } from '../../src/jobs/actions.js';
import { externalLane, laneServerId } from '../../src/jobs/lanes.js';
import { externalWorld, siteRow } from '../connectWorld.js';

/** Schedules and lanes with a site hosted elsewhere among the sites. */

function addHosted(w: Awaited<ReturnType<typeof externalWorld>>['w'], slug: string, status = 'running') {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({ slug, title: slug, domains: JSON.stringify([`${slug}.example.org`]), phpVersion: '8.3', status, dbName: `wp_${slug}`, dbUser: `wp_${slug}`, dbPassword: 'x', containerName: `wp-${slug}`, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

describe('schedules and sites hosted elsewhere', () => {
  it('lanes: two shared lanes, belonging to no server', () => {
    expect([externalLane(1), externalLane(2), externalLane(3)]).toEqual(['external-1', 'external-0', 'external-1']);
    expect(laneServerId(externalLane(4))).toBeNull();
  });

  it('says which actions a site hosted elsewhere takes', async () => {
    const { w } = await externalWorld();
    const site = siteRow(w);
    expect(ineligible('site.restart', site)).toBe('is an external site: it cannot be restarted');
    expect(ineligible('site.stop', site)).toBe('is an external site: it cannot be stopped');
    expect(ineligible('site.shell', site)).toBe('is an external site: it runs no shell commands');
    for (const action of ['backup', 'wp.scan', 'wp.update', 'wp.cli', 'wp.rest'] as const) expect(ineligible(action, site), action).toBeNull();
    expect(ineligible('backup', { ...site, status: 'disconnected' })).toBe('is disconnected');
  });

  it('takes sites hosted elsewhere into "all" for what runs on them, never into a server', async () => {
    const { w } = await externalWorld();
    addHosted(w, 'blog');
    addHosted(w, 'paused', 'stopped');
    const backup = fireAction(w.core, w.worker, 'backup', { kind: 'all' }, {}, { name: 'Nightly' });
    expect(backup.jobs.map((j) => j.siteSlug).sort()).toEqual(['blog', 'shop']);
    expect(backup.jobs.find((j) => j.siteSlug === 'shop')!.lane).toBe(externalLane(siteRow(w).id));
    w.db.update(jobs).set({ status: 'canceled' }).run();

    const restart = fireAction(w.core, w.worker, 'site.restart', { kind: 'all' }, {}, { name: 'Restart' });
    expect(restart.jobs.map((j) => j.siteSlug)).toEqual(['blog']);
    w.db.update(jobs).set({ status: 'canceled' }).run();

    const onServer = fireAction(w.core, w.worker, 'backup', { kind: 'server', serverId: 1 }, {}, { name: 'Server 1' });
    expect(onServer.jobs.map((j) => j.siteSlug)).toEqual(['blog']);
    w.db.update(jobs).set({ status: 'canceled' }).run();

    const named = fireAction(w.core, w.worker, 'site.restart', { kind: 'sites', slugs: ['shop', 'blog'] }, {}, { name: 'Named' });
    expect(named.skipped).toEqual([{ siteSlug: 'shop', reason: 'is an external site: it cannot be restarted' }]);
    w.db.update(jobs).set({ status: 'canceled' }).run();

    const cli = fireAction(w.core, w.worker, 'wp.cli', { kind: 'sites', slugs: ['shop'] }, { args: ['hello'], timeoutMin: 5 }, { name: 'Hello' });
    expect(cli.jobs).toHaveLength(1);
    expect(cli.jobs[0]!.lane).toBe(externalLane(siteRow(w).id));
  });

  it('backs up a connected site hosted elsewhere with the scheduled backups, and scans it when due', async () => {
    const { w } = await externalWorld();
    await w.deps.schedulers.run('backups', 'manual');
    const queued = w.db.select().from(jobs).where(eq(jobs.status, 'queued')).all();
    expect(queued.map((j) => [j.type, j.siteSlug])).toEqual(expect.arrayContaining([['backup.create', 'shop']]));
    expect(w.deps.schedulers.wpScanIsDue()).toBe(true);
    w.db.update(sites).set({ backupsEnabled: 0 }).run();
    w.db.update(jobs).set({ status: 'canceled' }).run();
    await w.deps.schedulers.run('backups', 'manual');
    expect(w.db.select().from(jobs).where(eq(jobs.status, 'queued')).all().map((j) => j.type)).toEqual(['panel.snapshot']);
  });
});
