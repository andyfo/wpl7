import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { siteWpComponents } from '../../src/db/schema.js';
import { backendFor } from '../../src/services/siteBackend.js';
import { externalWorld, runJob, siteRow } from '../connectWorld.js';

/** Updates of a site hosted elsewhere, through WPL7 Connect (services/siteBackend.ts ConnectorBackend). */

const scan = async (w: Awaited<ReturnType<typeof externalWorld>>['w']) => {
  const site = siteRow(w);
  await w.core.wpInventory.scanSite(site, backendFor(w.core, site), { refreshFeed: false });
  return w.core.wpInventory.statusFor(site);
};

describe('a site hosted elsewhere: inventory and updates', () => {
  it('reads plugins, themes and core through the plugin, in the shape WP-CLI gives', async () => {
    const { w } = await externalWorld();
    const status = await scan(w);
    expect(status.core).toMatchObject({ version: '7.1.2', updateVersion: null });
    expect(status.plugins.map((p) => [p.slug, p.status, p.version, p.updateVersion])).toEqual([
      ['akismet', 'active', '5.7.2', '5.8'],
      ['hello', 'inactive', '1.7.2', null],
      ['wpl7-connect', 'active', '0.4.0', null],
    ]);
    // The connector is the panel's way in: it takes updates, nothing else.
    expect(status.plugins.find((p) => p.slug === 'wpl7-connect')).toMatchObject({
      actionable: { activate: false, deactivate: false, delete: false },
      blockedReason: 'WPL7 Connect connects this site to the panel.',
    });
    expect(status.themes.find((t) => t.slug === 'twentytwentyfour')).toMatchObject({ updateVersion: '1.4', actionable: { update: true } });
  });

  it('updates, checks the site, and drops the rollback copies of a run that went well', async () => {
    const { w, fake } = await externalWorld();
    await scan(w);
    const site = siteRow(w);
    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'akismet', action: 'update' }, { kind: 'theme', slug: 'twentytwentyfour', action: 'update' }], backupFirst: false, healthCheck: true },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
    expect(job.lane).toBe(`external-${site.id % 2}`);
    const { job: done, result, log } = await runJob(w, job.id);
    expect(done.status, log.join('\n')).toBe('succeeded');
    expect(result!.ops).toEqual([
      { kind: 'plugin', slug: 'akismet', action: 'update', ok: true, from: '5.7.2', to: '5.8', error: null },
      { kind: 'theme', slug: 'twentytwentyfour', action: 'update', ok: true, from: '1.3', to: '1.4', error: null },
    ]);
    expect(result!.healthy).toBe(true);
    expect(fake.updates).toEqual(['plugin:akismet', 'theme:twentytwentyfour']);
    expect(fake.cleanups).toHaveLength(2);
    expect(fake.rollbacks).toEqual([]);
    // Rescanned at the end: the snapshot says what the site has now.
    const akismet = w.db.select().from(siteWpComponents).where(eq(siteWpComponents.slug, 'akismet')).get()!;
    expect(akismet.version).toBe('5.8');
  });

  it('puts back what it updated when the site stops answering, through the must-use loader', async () => {
    const { w, fake } = await externalWorld();
    fake.fatalAfterUpdate.add('akismet');
    await scan(w);
    const site = siteRow(w);
    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'akismet', action: 'update' }], backupFirst: false, healthCheck: true },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
    const { job: done, result, log } = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/stopped answering after the update, so WPL7 Connect put back akismet; it answers again/);
    expect(fake.rollbacks).toEqual([{ op: expect.stringMatching(/^[0-9a-f]{16}$/), items: [{ kind: 'plugin', slug: 'akismet' }], skipPlugins: ['akismet/akismet.php'], skipTheme: false }]);
    expect(fake.requests.filter((a) => a === 'rollback')).toHaveLength(1);
    expect(result).toMatchObject({ healthy: true, rolledBack: ['akismet'] });
    expect((result!.ops as { rolledBack?: boolean }[])[0]!.rolledBack).toBe(true);
    expect(fake.plugins.get('akismet')!.version).toBe('5.7.2');
    // Put back and answering again: the copy has done its job.
    expect(fake.cleanups).toHaveLength(1);
    expect(log.join('\n')).toContain('akismet: put back as it was before the update.');
  });

  it('leaves alone a site that did not answer before the run', async () => {
    const { w, fake } = await externalWorld();
    await scan(w);
    fake.homeDown = true;
    const site = siteRow(w);
    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'akismet', action: 'update' }], backupFirst: false, healthCheck: true },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
    const { job: done, log } = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/did not answer before the update either; nothing was rolled back/);
    expect(fake.updates).toEqual(['plugin:akismet']);
    expect(fake.rollbacks).toEqual([]);
    expect(log.join('\n')).toMatch(/did not answer before the update/);
  });

  it('says why an update cannot run where WordPress cannot write its own files', async () => {
    const { w } = await externalWorld({ fake: { fs_method: 'ftpext' } });
    const status = await scan(w);
    expect(status.plugins.find((p) => p.slug === 'akismet')!.updateVersion).toBe('5.8');
    const site = siteRow(w);
    const job = w.worker.enqueue(
      'wp.bulkTask',
      { siteId: site.id, ops: [{ kind: 'plugin', slug: 'akismet', action: 'update' }, { kind: 'theme', slug: 'twentytwentyfour', action: 'update' }], backupFirst: false, healthCheck: false },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
    const { job: done, result } = await runJob(w, job.id);
    expect(done.status).toBe('failed');
    for (const op of result!.ops as { ok: boolean; error: string }[]) {
      expect(op).toMatchObject({ ok: false, error: 'Updates need FTP details in wp-config.php: WordPress cannot write its own files on this site.' });
    }
  });

  it('updates WordPress itself, waiting for the core update and then the database', async () => {
    const { w, fake } = await externalWorld();
    fake.core.update = { version: '7.1.3', type: 'minor' };
    await scan(w);
    const site = siteRow(w);
    const job = w.worker.enqueue('wp.coreUpdate', { siteId: site.id }, { id: site.id, slug: site.slug, serverId: site.serverId });
    const { job: done, result, log } = await runJob(w, job.id);
    expect(done.status, log.join('\n')).toBe('succeeded');
    expect(result).toEqual({ from: '7.1.2', to: '7.1.3' });
    expect(fake.updates).toEqual(['core', 'db']);
    expect(fake.count('op')).toBeGreaterThan(0);
  });

  it('refuses to switch off or delete WPL7 Connect, and runs plugin and theme changes', async () => {
    const { w, fake } = await externalWorld();
    await scan(w);
    const site = siteRow(w);
    let refusal: unknown;
    try {
      w.deps.wpBulk.validateOps(site, [{ kind: 'plugin', slug: 'wpl7-connect', action: 'deactivate' }]);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toMatchObject({ statusCode: 400, details: [expect.stringContaining('WPL7 Connect connects this site to the panel.')] });
    const job = w.worker.enqueue('wp.pluginTask', { siteId: site.id, action: 'activate', name: 'hello', activate: true }, { id: site.id, slug: site.slug, serverId: site.serverId });
    const { job: done } = await runJob(w, job.id);
    expect(done.status).toBe('succeeded');
    expect(fake.plugins.get('hello')!.status).toBe('active');
    const install = w.worker.enqueue(
      'wp.pluginTask',
      { siteId: site.id, action: 'install', source: { kind: 'wporg', slug: 'classic-editor' }, activate: false },
      { id: site.id, slug: site.slug, serverId: site.serverId },
    );
    const installed = await runJob(w, install.id);
    expect(installed.job.status).toBe('succeeded');
    expect(installed.result).toEqual({ installed: 'classic-editor' });
    expect(fake.plugins.get('classic-editor')!.status).toBe('inactive');
  });
});
