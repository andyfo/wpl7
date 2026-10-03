import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { siteWpStatus, sites, vulnFeed, type SiteRow } from '../../src/db/schema.js';
import { makeWorld, type TestWorld } from '../helpers.js';

/**
 * The join the whole security half of the feature rests on: an installed version from the
 * snapshot, an advisory from the cached feed, and a verdict computed on read - so a new
 * advisory changes what the panel says without anybody re-reading a container.
 */

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

const PLUGIN_LIST = JSON.stringify([
  { name: 'cf7', title: 'Contact Form 7', status: 'active', version: '5.3.1', update: 'available', update_version: '6.0.1', auto_update: 'off', file: 'cf7/cf7.php' },
  { name: 'safe', title: 'Safe Plugin', status: 'active', version: '2.0', update: 'none', update_version: null, auto_update: 'off', file: 'safe/safe.php' },
  { name: 'abandoned', title: 'Abandoned', status: 'inactive', version: '1.0', update: 'none', update_version: null, auto_update: 'off', file: 'abandoned/abandoned.php' },
]);
const THEME_LIST = JSON.stringify([
  { name: 'child', title: 'Child', status: 'active', version: '1.0', update: 'none', update_version: null, auto_update: 'off' },
]);

/** wpvulnerability.net answers for this fixture, in the real envelope shape. */
const FEED: Record<string, unknown> = {
  '/plugin/cf7': {
    error: 0,
    data: {
      name: 'Contact Form 7',
      plugin: 'cf7',
      link: 'https://wordpress.org/plugins/cf7/',
      latest: '1786939800',
      closed: 0,
      closed_reason: null,
      vulnerability: [
        {
          uuid: 'cf7-1',
          name: 'Contact Form 7 [cf7] < 6.0',
          source: [{ id: 'CVE-2024-1234', name: 'Contact Form 7 &lt; 6.0 - Arbitrary File Upload', link: 'https://example.test/a', date: '2024-05-01' }],
          operator: { min_version: null, min_operator: null, max_version: '6.0', max_operator: 'lt', unfixed: '0', closed: '0' },
          impact: { cvss: { score: '9.8', severity: 'c' }, cvss3: { score: '9.8', severity: 'critical' } },
        },
      ],
    },
    updated: 1789908504,
  },
  '/plugin/safe': {
    error: 0,
    data: { name: 'Safe Plugin', plugin: 'safe', link: null, latest: null, closed: 0, closed_reason: null, vulnerability: null },
    updated: 1789908504,
  },
  '/plugin/abandoned': {
    error: 0,
    data: {
      name: 'Abandoned',
      plugin: 'abandoned',
      link: null,
      latest: '1595755500',
      closed: 1,
      closed_reason: 'security-issue',
      vulnerability: null,
    },
    updated: 1789908504,
  },
  '/theme/child': {
    error: 0,
    data: { name: 'Child', theme: 'child', link: null, latest: null, closed: 0, closed_reason: null, vulnerability: null },
    updated: 1789908504,
  },
  '/core/6.8.2': {
    error: 0,
    data: {
      core: '6.8.2',
      link: null,
      vulnerability: [
        {
          uuid: 'core-1',
          name: '6.8.2',
          source: [{ id: 'x', name: 'WordPress <= 6.9.1 - XXE via getID3', link: 'https://example.test/core', date: '2026-01-02' }],
          impact: { cvss: { score: '5.9', severity: 'm' }, cvss3: { score: '5.9', severity: 'medium' } },
        },
      ],
    },
    updated: 1789908504,
  },
};

const feedFetch = (async (input: string | URL) => {
  const key = String(input).replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
  const body = FEED[key];
  if (!body) return new Response('{"error":0,"data":{"name":null,"vulnerability":null}}', { status: 200 });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

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

async function scannedWorld(): Promise<{ w: TestWorld; site: SiteRow }> {
  const w = await makeWorld({ feedFetch });
  const site = addRunningSite(w, 'blog');
  w.docker.execQueue.push(ok(PLUGIN_LIST), ok(THEME_LIST), ok('6.8.2\n'), ok(''));
  // scanSite refreshes the feed for the slugs it just found.
  await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));
  return { w, site };
}

describe('vulnerability verdicts on the site page', () => {
  it('rates the affected plugin, leaves the current one alone, and flags a closed plugin', async () => {
    const { w, site } = await scannedWorld();
    const status = w.core.wpInventory.statusFor(site);

    const cf7 = status.plugins.find((p) => p.slug === 'cf7')!;
    expect(cf7.worstSeverity).toBe('critical');
    expect(cf7.vulnerabilities).toHaveLength(1);
    expect(cf7.vulnerabilities[0]).toMatchObject({
      severity: 'critical',
      cvss: 9.8,
      fixedIn: '6.0',
      versionMatch: 'match',
      cves: ['CVE-2024-1234'],
    });
    expect(cf7.feedCoverage).toBe('known');

    const safe = status.plugins.find((p) => p.slug === 'safe')!;
    expect(safe.worstSeverity).toBeNull();
    expect(safe.feedCoverage).toBe('known');

    const abandoned = status.plugins.find((p) => p.slug === 'abandoned')!;
    expect(abandoned.closedOnWporg).toBe(true);
    expect(abandoned.closedReason).toBe('security-issue');
    // Closed but with no advisory: it counts as something to act on even so.
    expect(abandoned.vulnerabilities).toHaveLength(0);

    // Core is rated by version, and its advisories carry no range.
    expect(status.core.worstSeverity).toBe('medium');
    expect(status.core.vulnerabilities).toHaveLength(1);

    // cf7 + abandoned + core
    expect(status.counts.vulnerable).toBe(3);
    expect(status.counts.closed).toBe(1);
    expect(status.feed.refreshedAt).not.toBeNull();
  });

  it('writes the worst severity and the count onto the site row for the list', async () => {
    const { w, site } = await scannedWorld();
    const row = w.db.select().from(siteWpStatus).where(eq(siteWpStatus.siteId, site.id)).get()!;
    expect(row.vulnerableCount).toBe(3);
    expect(row.worstSeverity).toBe('critical');
    expect(w.deps.sites.list()[0]!.wp).toMatchObject({ vulnerable: 3, worstSeverity: 'critical' });
  });

  it('clears the verdict once the plugin is on a fixed version, without a new feed fetch', async () => {
    const { w, site } = await scannedWorld();
    // The site updated cf7 to 6.0.1; only the snapshot changes.
    const patched = JSON.parse(PLUGIN_LIST).map((p: Record<string, unknown>) =>
      p.name === 'cf7' ? { ...p, version: '6.0.1', update: 'none', update_version: null } : p,
    );
    w.docker.execQueue.push(ok(JSON.stringify(patched)), ok(THEME_LIST), ok('6.8.2\n'), ok(''));
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));

    const status = w.core.wpInventory.statusFor(site);
    expect(status.plugins.find((p) => p.slug === 'cf7')!.vulnerabilities).toHaveLength(0);
    // abandoned (closed) + core still count.
    expect(status.counts.vulnerable).toBe(2);
    expect(w.db.select().from(siteWpStatus).where(eq(siteWpStatus.siteId, site.id)).get()!.worstSeverity).toBe('medium');
  });

  it('shows nothing rated when a slug is not in the feed at all', async () => {
    const w = await makeWorld({ feedFetch });
    const site = addRunningSite(w, 'blog');
    const unknownPlugin = JSON.stringify([
      { name: 'acme-premium', title: 'Acme Premium', status: 'active', version: '1.0', update: 'none', update_version: null, auto_update: 'off', file: 'acme/acme.php' },
    ]);
    w.docker.execQueue.push(ok(unknownPlugin), ok('[]'), ok('6.8.2\n'), ok(''));
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));

    const plugin = w.core.wpInventory.statusFor(site).plugins[0]!;
    // "We have no data" - emphatically not "this is clean".
    expect(plugin.feedCoverage).toBe('unknown');
    expect(plugin.worstSeverity).toBeNull();
  });
});

describe('the Vulnerable filter on the fleet page', () => {
  it('keeps only the installs an advisory applies to', async () => {
    const w = await makeWorld({ feedFetch });
    const affected = addRunningSite(w, 'affected');
    const patched = addRunningSite(w, 'patched');
    w.docker.execQueue.push(ok(PLUGIN_LIST), ok(THEME_LIST), ok('6.8.2\n'), ok(''));
    await w.core.wpInventory.scanSite(affected, w.servers.handleFor(1));
    const fixedList = JSON.parse(PLUGIN_LIST).map((p: Record<string, unknown>) =>
      p.name === 'cf7' ? { ...p, version: '6.0.1', update: 'none', update_version: null } : p,
    );
    w.docker.execQueue.push(ok(JSON.stringify(fixedList)), ok(THEME_LIST), ok('6.8.2\n'), ok(''));
    await w.core.wpInventory.scanSite(patched, w.servers.handleFor(1));

    const vulnerable = w.core.wpInventory.fleetInventory({ kind: 'plugin', filter: ['vulnerable'], includeStopped: false });
    const cf7 = vulnerable.rows.find((r) => r.slug === 'cf7')!;
    expect(cf7.siteRows.map((r) => r.siteSlug)).toEqual(['affected']);
    expect(cf7.worstSeverity).toBe('critical');
    // The closed plugin is vulnerable too, on both sites.
    expect(vulnerable.rows.find((r) => r.slug === 'abandoned')!.sites).toBe(2);
    expect(vulnerable.rows.some((r) => r.slug === 'safe')).toBe(false);
    expect(vulnerable.fleet.sitesVulnerable).toBe(2);

    // "Closed on wp.org" is narrower again.
    const closed = w.core.wpInventory.fleetInventory({ kind: 'plugin', filter: ['closed'], includeStopped: false });
    expect(closed.rows.map((r) => r.slug)).toEqual(['abandoned']);

    // Vulnerable AND has-update is exactly what one click of Update can fix.
    const fixable = w.core.wpInventory.fleetInventory({
      kind: 'plugin',
      filter: ['vulnerable', 'updates'],
      includeStopped: false,
    });
    expect(fixable.rows.map((r) => r.slug)).toEqual(['cf7']);
    expect(fixable.rows[0]!.siteRows.map((r) => r.siteSlug)).toEqual(['affected']);

    const core = w.core.wpInventory.fleetInventory({ kind: 'core', filter: ['vulnerable'], includeStopped: false });
    expect(core.rows.map((r) => r.slug)).toEqual(['6.8.2']);
  });

  it('stops rating anything while the feed is switched off', async () => {
    const { w } = await scannedWorld();
    w.core.settings.set('vulnerabilityFeed', false);
    w.core.wpInventory.recount();

    const off = w.core.wpInventory.fleetInventory({ kind: 'plugin', filter: ['vulnerable'], includeStopped: false });
    expect(off.rows).toHaveLength(0);
    expect(off.feed.enabled).toBe(false);
    expect(w.deps.sites.list()[0]!.wp!.vulnerable).toBe(0);
  });
});

describe('an advisory published since the last scan', () => {
  it('recounts every site that has the slug, not just the one being scanned', async () => {
    // A mutable feed: the plugin starts clean and gains an advisory later.
    const answers: Record<string, unknown> = {
      '/plugin/shared': {
        error: 0,
        data: { name: 'Shared', plugin: 'shared', link: null, latest: null, closed: 0, closed_reason: null, vulnerability: null },
        updated: 1,
      },
    };
    const mutableFetch = (async (input: string | URL) => {
      const key = String(input).replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
      const body = answers[key] ?? { error: 0, data: { name: null, vulnerability: null }, updated: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const w = await makeWorld({ feedFetch: mutableFetch });
    const a = addRunningSite(w, 'site-a');
    const b = addRunningSite(w, 'site-b');
    const list = JSON.stringify([
      { name: 'shared', title: 'Shared', status: 'active', version: '1.0', update: 'none', update_version: null, auto_update: 'off', file: 'shared/shared.php' },
    ]);
    for (const site of [a, b]) {
      w.docker.execQueue.push(ok(list), ok('[]'), ok('6.8.3\n'), ok(''));
      await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));
    }
    expect(w.core.wpInventory.summaries().get(b.id)!.vulnerable).toBe(0);

    // A day later the advisory is published, and site A happens to be the one scanned.
    answers['/plugin/shared'] = {
      error: 0,
      data: {
        name: 'Shared',
        plugin: 'shared',
        link: null,
        latest: null,
        closed: 0,
        closed_reason: null,
        vulnerability: [
          {
            uuid: 'shared-1',
            name: 'Shared < 2.0',
            source: [{ id: 'CVE-2026-9', name: 'Shared < 2.0 - RCE', link: 'https://example.test', date: '2026-09-01' }],
            operator: { min_version: null, min_operator: null, max_version: '2.0', max_operator: 'lt', unfixed: '0', closed: '0' },
            impact: { cvss: { score: '9.1', severity: 'c' }, cvss3: { score: '9.1', severity: 'critical' } },
          },
        ],
      },
      updated: 2,
    };
    w.db.update(vulnFeed).set({ fetchedAt: Date.now() - 25 * 3600_000 }).run();
    w.docker.execQueue.push(ok(list), ok('[]'), ok('6.8.3\n'), ok(''));
    await w.core.wpInventory.scanSite(a, w.servers.handleFor(1));

    // B's own page says it is vulnerable...
    expect(w.core.wpInventory.statusFor(b).counts.vulnerable).toBe(1);
    // ...so the site list, the dashboard and the fleet tiles must not still say zero.
    expect(w.core.wpInventory.summaries().get(b.id)!.vulnerable).toBe(1);
    expect(w.core.wpInventory.summaries().get(b.id)!.worstSeverity).toBe('critical');
    expect(w.deps.sites.list().find((s) => s.slug === 'site-b')!.wp!.vulnerable).toBe(1);
  });
});

describe('does the offered update actually fix it', () => {
  const advisoryFixedIn = (fixedIn: string) => ({
    error: 0,
    data: {
      name: 'Laggard',
      plugin: 'laggard',
      link: null,
      latest: null,
      closed: 0,
      closed_reason: null,
      vulnerability: [
        {
          uuid: 'laggard-1',
          name: `Laggard < ${fixedIn}`,
          source: [{ id: 'CVE-2026-1', name: `Laggard < ${fixedIn} - RCE`, link: 'https://example.test', date: '2026-01-01' }],
          operator: { min_version: null, min_operator: null, max_version: fixedIn, max_operator: 'lt', unfixed: '0', closed: '0' },
          impact: { cvss: { score: '9.1', severity: 'c' }, cvss3: { score: '9.1', severity: 'critical' } },
        },
      ],
    },
    updated: 1,
  });

  const scanWith = async (fixedIn: string, offered: string) => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(advisoryFixedIn(fixedIn)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const w = await makeWorld({ feedFetch: fetchImpl });
    const site = addRunningSite(w, 'blog');
    const list = JSON.stringify([
      { name: 'laggard', title: 'Laggard', status: 'active', version: '1.0', update: 'available', update_version: offered, auto_update: 'off', file: 'laggard/laggard.php' },
    ]);
    w.docker.execQueue.push(ok(list), ok('[]'), ok('6.8.3\n'), ok(''));
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));
    return w.core.wpInventory.statusFor(site).plugins[0]!;
  };

  it('is false when the available update stops short of the fixed release', async () => {
    // Installed 1.0, offered 1.1, fixed in 2.0: updating is an improvement but not a fix,
    // and "Fix vulnerable" must not promise otherwise.
    const component = await scanWith('2.0', '1.1');
    expect(component.vulnerabilities).toHaveLength(1);
    expect(component.actionable.update).toBe(true);
    expect(component.updateFixes).toBe(false);
  });

  it('is true when the offered release clears the advisory', async () => {
    const component = await scanWith('2.0', '2.0');
    expect(component.updateFixes).toBe(true);
  });

  it('is false for a component with nothing known against it', async () => {
    const component = await scanWith('0.1', '1.1'); // advisory does not match 1.0
    expect(component.vulnerabilities).toHaveLength(0);
    expect(component.updateFixes).toBe(false);
  });
});

describe('feed housekeeping', () => {
  it('forgets slugs no site has installed any more', async () => {
    const { w, site } = await scannedWorld();
    // Only "safe" is left installed.
    const fewer = JSON.stringify([
      { name: 'safe', title: 'Safe Plugin', status: 'active', version: '2.0', update: 'none', update_version: null, auto_update: 'off', file: 'safe/safe.php' },
    ]);
    w.docker.execQueue.push(ok(fewer), ok(THEME_LIST), ok('6.8.2\n'), ok(''));
    await w.core.wpInventory.scanSite(site, w.servers.handleFor(1));

    const removed = w.core.vulnerabilities.pruneUnreferenced();
    expect(removed).toBeGreaterThan(0);
    expect(w.core.vulnerabilities.verdictFor('plugin', 'cf7', '5.3.1').coverage).toBe('pending');
    expect(w.core.vulnerabilities.verdictFor('plugin', 'safe', '2.0').coverage).toBe('known');
    // Core is still installed, so its entry stays.
    expect(w.core.vulnerabilities.verdictFor('core', '6.8.2', '6.8.2').coverage).toBe('known');
  });
});
