import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { siteWpComponents, siteWpStatus, sites, type SiteRow } from '../../src/db/schema.js';
import { actionsFor, parseComponents } from '../../src/services/wpInventory.js';
import { makeWorld, type TestWorld } from '../helpers.js';

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

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string) => ({ stdout: '', stderr, exitCode: 1 });

/** What `wp plugin list --format=json` looks like on a real site, warts included. */
const PLUGIN_LIST = JSON.stringify([
  {
    name: 'contact-form-7',
    title: 'Contact Form 7',
    status: 'active',
    version: '5.3.1',
    update: 'available',
    update_version: '6.0.1',
    auto_update: 'off',
    file: 'contact-form-7/wp-contact-form-7.php',
  },
  {
    name: 'akismet',
    title: 'Akismet Anti-spam',
    status: 'inactive',
    version: '5.3',
    update: 'none',
    update_version: null,
    auto_update: 'on',
    file: 'akismet/akismet.php',
  },
  {
    name: 'ceo-login',
    title: 'CEO one-click login',
    status: 'must-use',
    version: '1.0',
    update: 'none',
    update_version: null,
    auto_update: 'off',
    file: 'ceo-login.php',
  },
  {
    name: 'advanced-cache',
    title: 'Advanced caching drop-in',
    status: 'dropin',
    version: '',
    update: 'none',
    update_version: null,
    auto_update: 'off',
    file: 'advanced-cache.php',
  },
  {
    name: 'beta-thing',
    title: 'Beta Thing',
    status: 'active',
    version: '3.0-beta2',
    // An install newer than what the directory offers - not an update.
    update: 'version higher than expected',
    update_version: '2.9',
    auto_update: 'off',
    file: 'beta-thing/beta-thing.php',
  },
]);

const THEME_LIST = JSON.stringify([
  { name: 'child-theme', title: 'Child Theme', status: 'active', version: '1.2', update: 'none', update_version: null, auto_update: 'off' },
  { name: 'parent-theme', title: 'Parent Theme', status: 'parent', version: '2.0', update: 'available', update_version: '2.1', auto_update: 'off' },
  { name: 'twentytwentyfour', title: 'Twenty Twenty-Four', status: 'inactive', version: '1.0', update: 'none', update_version: null, auto_update: 'on' },
]);

/** The four calls one scan makes, in order. */
function scriptScan(
  w: TestWorld,
  opts: { plugins?: string; themes?: string; coreVersion?: string; checkUpdate?: string } = {},
): void {
  w.docker.execQueue.push(
    ok(opts.plugins ?? PLUGIN_LIST),
    ok(opts.themes ?? THEME_LIST),
    ok(opts.coreVersion ?? '6.8.2\n'),
    ok(opts.checkUpdate ?? ''),
  );
}

describe('parseComponents', () => {
  it('reads statuses, update states and auto-update from wp-cli output', () => {
    const rows = parseComponents('plugin', JSON.parse(PLUGIN_LIST));
    const bySlug = new Map(rows.map((r) => [r.slug, r]));

    expect(bySlug.get('contact-form-7')).toMatchObject({
      title: 'Contact Form 7',
      status: 'active',
      version: '5.3.1',
      updateVersion: '6.0.1',
      updateState: 'available',
      autoUpdate: false,
      file: 'contact-form-7/wp-contact-form-7.php',
    });
    expect(bySlug.get('akismet')!.autoUpdate).toBe(true);
    expect(bySlug.get('ceo-login')!.status).toBe('must-use');
    expect(bySlug.get('advanced-cache')!.status).toBe('dropin');
    // "version higher than expected" is not an available update.
    expect(bySlug.get('beta-thing')!.updateState).toBe('higher');
  });

  it('accepts wp-cli builds that report booleans instead of words', () => {
    const rows = parseComponents('plugin', [
      { name: 'x', title: 'X', status: 'active', version: '1.0', update: true, update_version: '1.1', auto_update: true },
    ]);
    expect(rows[0]).toMatchObject({ updateState: 'available', autoUpdate: true });
  });

  it('skips rows with no name rather than inventing a slug', () => {
    expect(parseComponents('theme', [{ status: 'active' }, { name: '  ' }])).toHaveLength(0);
  });
});

describe('actionsFor (the safety rails)', () => {
  it('refuses to manage must-use plugins and drop-ins', () => {
    for (const status of ['must-use', 'dropin']) {
      const { actionable, blockedReason } = actionsFor({
        kind: 'plugin',
        status,
        updateState: 'available',
        updateVersion: '2.0',
      });
      expect(actionable).toEqual({ activate: false, deactivate: false, update: false, delete: false });
      expect(blockedReason).toBeTruthy();
    }
  });

  it('refuses to delete the active theme or the active theme\'s parent', () => {
    expect(actionsFor({ kind: 'theme', status: 'active', updateState: 'none', updateVersion: null }).actionable).toEqual({
      activate: false,
      deactivate: false,
      update: false,
      delete: false,
    });
    const parent = actionsFor({ kind: 'theme', status: 'parent', updateState: 'available', updateVersion: '2.1' });
    expect(parent.actionable).toMatchObject({ delete: false, update: true, activate: true });
    expect(parent.blockedReason).toMatch(/child/);
  });

  it('only offers an update when there is a version to update to', () => {
    expect(
      actionsFor({ kind: 'plugin', status: 'active', updateState: 'available', updateVersion: null }).actionable.update,
    ).toBe(false);
    expect(
      actionsFor({ kind: 'plugin', status: 'active', updateState: 'higher', updateVersion: '2.9' }).actionable.update,
    ).toBe(false);
  });
});

describe('WpInventoryService.scanSite', () => {
  it('writes the snapshot and reports it back through statusFor', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    scriptScan(w, { checkUpdate: JSON.stringify([{ version: '6.8.3', update_type: 'minor' }]) });

    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));

    const status = w.core.wpInventory.statusFor(site);
    expect(status.scannedAt).not.toBeNull();
    expect(status.partial).toBe(false);
    expect(status.core).toMatchObject({ version: '6.8.2', updateVersion: '6.8.3', updateType: 'minor' });
    expect(status.plugins).toHaveLength(5);
    expect(status.themes).toHaveLength(3);
    // core + contact-form-7 + parent-theme
    expect(status.counts.updates).toBe(3);
    expect(status.counts.inactive).toBe(2);
    expect(w.db.select().from(siteWpStatus).where(eq(siteWpStatus.siteId, site.id)).get()?.updatesCount).toBe(3);
  });

  it('reads an empty check-update as "up to date", not as a failure', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    // `--format=json` prints nothing at all when there is no update available.
    scriptScan(w, { checkUpdate: '' });

    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));
    expect(w.core.wpInventory.statusFor(site).core.updateVersion).toBeNull();
  });

  it('offers the newest core version when several updates are on the table', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    scriptScan(w, {
      checkUpdate: JSON.stringify([
        { version: '6.8.3', update_type: 'minor' },
        { version: '6.9', update_type: 'major' },
      ]),
    });

    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));
    expect(w.core.wpInventory.statusFor(site).core).toMatchObject({ updateVersion: '6.9', updateType: 'major' });
  });

  it('survives a PHP notice printed ahead of wp-cli\'s JSON', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    scriptScan(w, {
      plugins: `PHP Notice:  Undefined index: foo in /var/www/html/wp-content/plugins/sloppy/sloppy.php on line 7\n${PLUGIN_LIST}\n`,
    });

    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));
    expect(w.core.wpInventory.statusFor(site).plugins).toHaveLength(5);
  });

  it('retries without extensions loaded when the listing fatals, and flags the snapshot partial', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    w.docker.execQueue.push(
      fail('PHP Fatal error: Uncaught Error in broken-plugin.php'),
      ok(PLUGIN_LIST),
      ok(THEME_LIST),
      ok('6.8.2\n'),
      ok(''),
    );

    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));

    const status = w.core.wpInventory.statusFor(site);
    expect(status.partial).toBe(true);
    expect(status.plugins).toHaveLength(5);
    // The retry is the one with the extensions switched off.
    const listCalls = w.docker.calls
      .filter((c) => c.method === 'exec')
      .map((c) => (c.args[1] as string[]).join(' '))
      .filter((line) => line.includes('plugin list'));
    expect(listCalls[0]).not.toContain('--skip-plugins');
    expect(listCalls[1]).toContain('--skip-plugins --skip-themes');
  });

  it('keeps the recovered inventory when the core check fatals on the same broken plugin', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    w.docker.execQueue.push(
      fail('PHP Fatal error in broken-plugin.php'), // plugin list
      ok(PLUGIN_LIST), // …recovered with --skip-plugins
      ok(THEME_LIST), // theme list, already skipping extensions
      ok('6.8.2\n'), // core version
      ok(JSON.stringify([{ version: '6.8.3', update_type: 'minor' }])), // core check-update
    );

    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));

    // Before, the core check ran without the skip flags, hit the same fatal, and its
    // exception threw away the inventory that had just been recovered.
    const status = w.core.wpInventory.statusFor(site);
    expect(status.scannedAt).not.toBeNull();
    expect(status.partial).toBe(true);
    expect(status.plugins).toHaveLength(5);
    expect(status.core).toMatchObject({ version: '6.8.2', updateVersion: '6.8.3' });
    const coreCalls = w.docker.calls
      .filter((c) => c.method === 'exec')
      .map((c) => (c.args[1] as string[]).join(' '))
      .filter((line) => line.includes('core check-update'));
    expect(coreCalls).toHaveLength(1);
    expect(coreCalls[0]).toContain('--skip-plugins --skip-themes');
  });

  it('retries the core check without extensions when only that call fails', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    w.docker.execQueue.push(
      ok(PLUGIN_LIST),
      ok(THEME_LIST),
      ok('6.8.2\n'),
      fail('PHP Fatal error during core check'),
      ok('6.8.2\n'),
      ok(JSON.stringify([{ version: '6.8.3', update_type: 'minor' }])),
    );

    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));
    expect(w.core.wpInventory.statusFor(site).core).toMatchObject({ version: '6.8.2', updateVersion: '6.8.3' });
  });

  it('keeps the last known core version when the check fails both ways', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    scriptScan(w, { checkUpdate: JSON.stringify([{ version: '6.8.3', update_type: 'minor' }]) });
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));

    w.docker.execQueue.push(
      ok(PLUGIN_LIST),
      ok(THEME_LIST),
      ok(''), // core version: empty
      fail('fatal'), // check-update
      ok(''),
      fail('fatal'), // …and the retry
    );
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));

    const status = w.core.wpInventory.statusFor(site);
    expect(status.plugins).toHaveLength(5); // the inventory still landed
    expect(status.partial).toBe(true);
    expect(status.core).toMatchObject({ version: '6.8.2', updateVersion: '6.8.3' }); // remembered
  });

  it('removes components the site no longer has', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    scriptScan(w);
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));
    expect(w.db.select().from(siteWpComponents).all()).toHaveLength(8);

    // akismet was deleted since the last scan.
    const fewer = JSON.parse(PLUGIN_LIST).filter((p: { name: string }) => p.name !== 'akismet');
    scriptScan(w, { plugins: JSON.stringify(fewer) });
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));

    const slugs = w.db.select().from(siteWpComponents).all().map((r) => r.slug);
    expect(slugs).not.toContain('akismet');
    expect(slugs).toContain('contact-form-7');
  });

  it('records a failed scan on the row instead of losing the reason', async () => {
    const w = await makeWorld();
    const site = addRunningSite(w, 'blog');
    // Both the first attempt and the --skip-plugins retry fail.
    w.docker.execQueue.push(fail('container is not running'), fail('container is not running'));

    await expect(w.core.wpInventory.scanSite(site, w.servers.handleFor(1))).rejects.toThrow();

    const row = w.db.select().from(siteWpStatus).where(eq(siteWpStatus.siteId, site.id)).get();
    expect(row?.scanError).toContain('wp plugin failed');
    expect(row?.scannedAt).toBeNull();
    expect(w.core.wpInventory.statusFor(site).scannedAt).toBeNull();
  });
});

describe('WpInventoryService.fleetInventory', () => {
  it('groups one slug across sites and filters by has-update', async () => {
    const w = await makeWorld();
    const a = addRunningSite(w, 'alpha');
    const b = addRunningSite(w, 'beta');
    scriptScan(w);
    await w.core.wpInventory.scanSite(a, w.servers.handleFor(1));
    // The second site has the same plugin, already up to date.
    const patched = JSON.parse(PLUGIN_LIST).map((p: Record<string, unknown>) =>
      p.name === 'contact-form-7' ? { ...p, version: '6.0.1', update: 'none', update_version: null } : p,
    );
    scriptScan(w, { plugins: JSON.stringify(patched) });
    await w.core.wpInventory.scanSite(b, w.servers.handleFor(1));

    const all = w.core.wpInventory.fleetInventory({ kind: 'plugin', filter: [], includeStopped: false });
    const cf7 = all.rows.find((r) => r.slug === 'contact-form-7')!;
    expect(cf7.sites).toBe(2);
    expect(cf7.updates).toBe(1);
    expect(cf7.versions).toEqual(['5.3.1', '6.0.1']);
    expect(cf7.updateVersion).toBe('6.0.1');
    expect(all.fleet).toMatchObject({ sites: 2, scanned: 2, neverScanned: 0 });

    // With the "Has update" chip, only the site that needs it is offered.
    const filtered = w.core.wpInventory.fleetInventory({ kind: 'plugin', filter: ['updates'], includeStopped: false });
    const filteredCf7 = filtered.rows.find((r) => r.slug === 'contact-form-7')!;
    expect(filteredCf7.sites).toBe(1);
    expect(filteredCf7.siteRows.map((r) => r.siteSlug)).toEqual(['alpha']);
    // A plugin with no update anywhere drops out of the table entirely.
    expect(filtered.rows.some((r) => r.slug === 'akismet')).toBe(false);
  });

  it('hides stopped sites unless asked, and filters by server and text', async () => {
    const w = await makeWorld();
    const running = addRunningSite(w, 'alpha');
    const stopped = addRunningSite(w, 'beta');
    scriptScan(w);
    await w.core.wpInventory.scanSite(running, w.servers.handleFor(1));
    scriptScan(w);
    await w.core.wpInventory.scanSite(stopped, w.servers.handleFor(1));
    w.db.update(sites).set({ status: 'stopped' }).where(eq(sites.id, stopped.id)).run();

    const defaults = w.core.wpInventory.fleetInventory({ kind: 'plugin', filter: [], includeStopped: false });
    expect(defaults.fleet.sites).toBe(1);
    const withStopped = w.core.wpInventory.fleetInventory({ kind: 'plugin', filter: [], includeStopped: true });
    expect(withStopped.fleet.sites).toBe(2);

    const searched = w.core.wpInventory.fleetInventory({
      kind: 'plugin',
      filter: [],
      q: 'akis',
      includeStopped: true,
    });
    expect(searched.rows.map((r) => r.slug)).toEqual(['akismet']);

    const otherServer = w.core.wpInventory.fleetInventory({
      kind: 'plugin',
      filter: [],
      serverId: 999,
      includeStopped: true,
    });
    expect(otherServer.rows).toHaveLength(0);
  });

  it('lists core by version, one row per distinct version', async () => {
    const w = await makeWorld();
    const a = addRunningSite(w, 'alpha');
    const b = addRunningSite(w, 'beta');
    scriptScan(w, { checkUpdate: JSON.stringify([{ version: '6.8.3', update_type: 'minor' }]) });
    await w.core.wpInventory.scanSite(a, w.servers.handleFor(1));
    scriptScan(w, { coreVersion: '6.8.3\n' });
    await w.core.wpInventory.scanSite(b, w.servers.handleFor(1));

    const core = w.core.wpInventory.fleetInventory({ kind: 'core', filter: [], includeStopped: false });
    expect(core.rows.map((r) => r.slug).sort()).toEqual(['6.8.2', '6.8.3']);
    const outdated = core.rows.find((r) => r.slug === '6.8.2')!;
    expect(outdated.updates).toBe(1);
    expect(outdated.siteRows[0]!.actionable.update).toBe(true);
    expect(core.fleet.coreOutdated).toBe(1);

    const needing = w.core.wpInventory.fleetInventory({ kind: 'core', filter: ['updates'], includeStopped: false });
    expect(needing.rows.map((r) => r.slug)).toEqual(['6.8.2']);
  });
});

describe('WpInventoryService.summaries', () => {
  it('feeds GET /sites with per-site counters, and only for scanned sites', async () => {
    const w = await makeWorld();
    const scanned = addRunningSite(w, 'alpha');
    addRunningSite(w, 'never-scanned');
    scriptScan(w, { checkUpdate: JSON.stringify([{ version: '6.8.3', update_type: 'minor' }]) });
    await w.core.wpInventory.scanSite(scanned, w.servers.handleFor(1));

    const summaries = w.core.wpInventory.summaries();
    expect(summaries.size).toBe(1);
    expect(summaries.get(scanned.id)).toMatchObject({ updates: 3, vulnerable: 0, coreUpdate: '6.8.3' });

    const list = w.deps.sites.list();
    expect(list.find((s) => s.slug === 'alpha')!.wp?.updates).toBe(3);
    expect(list.find((s) => s.slug === 'never-scanned')!.wp).toBeNull();
  });
});
