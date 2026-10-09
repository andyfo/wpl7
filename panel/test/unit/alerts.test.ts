import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { alertStates, siteConnections, siteStats, sites, vulnNotices } from '../../src/db/schema.js';
import { AlertService, DOWN_AFTER } from '../../src/services/alerts.js';
import type { VulnFinding } from '../../src/services/wpInventory.js';
import { makeWorld, type TestWorld } from '../helpers.js';
import { connectionRow, externalWorld, siteRow } from '../connectWorld.js';

/** Emails about sites (services/alerts.ts): what goes out, once, and what a restart keeps. */

function capture(w: TestWorld) {
  const sent: { subject: string; body: string }[] = [];
  w.core.mail.notifyOperator = async (subject, body) => {
    sent.push({ subject, body });
    return true;
  };
  return sent;
}

function hostedSite(w: TestWorld, slug = 'blog', status = 'running') {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({
      slug,
      title: 'My Blog',
      domains: JSON.stringify([`${slug}.example.org`]),
      phpVersion: '8.3',
      status,
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

describe('alerts', () => {
  it('says a site is down after three failed checks, once, and that it is back with how long it was down', async () => {
    const w = await makeWorld();
    const sent = capture(w);
    const site = hostedSite(w);
    for (let i = 1; i < DOWN_AFTER; i++) await w.core.alerts.probed(site, { ok: false, status: 502 });
    expect(sent).toEqual([]);
    await w.core.alerts.probed(site, { ok: false, status: 502 });
    await w.core.alerts.probed(site, { ok: false, status: null, error: 'connect ECONNREFUSED' });
    expect(sent.map((m) => m.subject)).toEqual(['My Blog is down']);
    expect(sent[0]!.body).toContain("blog.example.org did not answer the panel's last 3 checks (HTTP 502).");
    expect(sent[0]!.body).toContain('http://panel.example.test/sites/blog');

    // A restart in between: what was said is in the database.
    const again = new AlertService(w.core);
    await again.probed(site, { ok: true, status: 200 });
    expect(sent.map((m) => m.subject)).toEqual(['My Blog is down', 'My Blog is back up']);
    expect(sent[1]!.body).toMatch(/answers again\. It was down for \d+ min/);
    expect(w.db.select().from(alertStates).all()).toEqual([]);
    await again.probed(site, { ok: true, status: 200 });
    expect(sent).toHaveLength(2);
  });

  it('sends nothing for a blip, nor when the alert is switched off', async () => {
    const w = await makeWorld();
    const sent = capture(w);
    const site = hostedSite(w);
    await w.core.alerts.probed(site, { ok: false, status: 500 });
    await w.core.alerts.probed(site, { ok: true, status: 200 });
    w.core.settings.set('alertsSiteDown', false);
    for (let i = 0; i < 5; i++) await w.core.alerts.probed(site, { ok: false, status: 500 });
    await w.core.alerts.probed(site, { ok: true, status: 200 });
    expect(sent).toEqual([]);
  });

  it('never probes a stopped site, so never calls it down', async () => {
    const w = await makeWorld();
    const sent = capture(w);
    hostedSite(w, 'paused', 'stopped');
    for (let i = 0; i < 4; i++) await w.core.monitor.tickUptime();
    expect(sent).toEqual([]);
    expect(w.db.select().from(alertStates).all()).toEqual([]);
  });

  it('names each new vulnerability once, and again when it comes back after a fix', async () => {
    const w = await makeWorld();
    const sent = capture(w);
    const site = hostedSite(w);
    const finding: VulnFinding = { kind: 'plugin', slug: 'akismet', title: 'Akismet Anti-spam', version: '5.0', advisory: 'adv-1', advisoryTitle: 'Stored XSS', severity: 'high', fixedIn: '5.1' };
    let now: VulnFinding[] = [finding];
    w.core.wpInventory.findings = () => new Map([[site.id, now]]);
    expect(await w.core.alerts.vulnerabilities()).toBe(1);
    expect(sent.map((m) => m.subject)).toEqual(['A new vulnerability on your sites']);
    expect(sent[0]!.body).toContain('  - Akismet Anti-spam 5.0: Stored XSS (high); fixed in 5.1');
    expect(await w.core.alerts.vulnerabilities()).toBe(0);
    now = [];
    await w.core.alerts.vulnerabilities();
    expect(w.db.select().from(vulnNotices).all()).toEqual([]);
    now = [finding, { ...finding, kind: 'core', slug: 'wordpress', title: 'WordPress', advisory: 'adv-2', advisoryTitle: 'SQL injection', fixedIn: null }];
    expect(await w.core.alerts.vulnerabilities()).toBe(2);
    expect(sent.map((m) => m.subject)).toEqual(['A new vulnerability on your sites', '2 new vulnerabilities on your sites']);
    expect(sent[1]!.body).toContain('WordPress 5.0: SQL injection (high); no fix yet');
  });

  it('says a backup failed at most once a day per site', async () => {
    const w = await makeWorld();
    const sent = capture(w);
    const site = hostedSite(w);
    await w.core.alerts.backupFailed(site, 'tar failed (exit 2)');
    await w.core.alerts.backupFailed(site, 'tar failed (exit 2)');
    expect(sent.map((m) => m.subject)).toEqual(['The backup of My Blog failed']);
    w.db.update(alertStates).set({ notifiedAt: Date.now() - 25 * 3600_000 }).run();
    await w.core.alerts.backupFailed(site, 'disk full');
    expect(sent).toHaveLength(2);
  });

  it('says when WPL7 Connect stops answering for three hours, and when it is back', async () => {
    const { w, fake, site } = await externalWorld();
    const sent = capture(w);
    fake.connection = null;
    for (let i = 0; i < 2; i++) expect(await w.core.connections.checkSite(siteRow(w))).toBe(false);
    expect(sent).toEqual([]);
    await w.core.connections.checkSite(siteRow(w));
    expect(connectionRow(w, site.id).failCount).toBe(3);
    expect(sent.map((m) => m.subject)).toEqual(['WPL7 Connect on Example Shop does not answer']);
    expect(sent[0]!.body).toContain('refused the panel');
    await w.core.connections.checkSite(siteRow(w));
    expect(sent).toHaveLength(1);
    fake.connection = { id: connectionRow(w, site.id).id, publicKey: connectionRow(w, site.id).publicKey };
    expect(await w.core.connections.checkSite(siteRow(w))).toBe(true);
    expect(sent.map((m) => m.subject)).toEqual(['WPL7 Connect on Example Shop does not answer', 'WPL7 Connect on Example Shop answers again']);
  });

  it('warns a week before an external site’s certificate expires, once until it is renewed', async () => {
    const { w, fake, site } = await externalWorld();
    const sent = capture(w);
    fake.certExpiresAt = Date.now() + 5 * 24 * 3600_000;
    await w.core.monitor.tickUptime();
    await w.core.monitor.tickUptime();
    expect(sent.map((m) => m.subject)).toEqual([expect.stringMatching(/^The certificate of Example Shop expires in (4|5) days$/)]);
    expect(w.db.select().from(siteConnections).where(eq(siteConnections.siteId, site.id)).get()!.certExpiresAt).toBe(fake.certExpiresAt);
    fake.certExpiresAt = Date.now() + 80 * 24 * 3600_000;
    await w.core.monitor.tickUptime();
    expect(w.db.select().from(alertStates).all()).toEqual([]);
  });

  it('checks a site hosted elsewhere at its own address, and records it as a hosted one', async () => {
    const { w, fake, site } = await externalWorld();
    capture(w);
    await w.core.monitor.tickUptime();
    expect(w.core.monitor.latestFor(site.id)).toMatchObject({ up: true, httpStatus: 200, httpMs: 12 });
    fake.homeDown = true;
    await w.core.monitor.tickUptime();
    expect(w.core.monitor.latestFor(site.id)).toMatchObject({ up: false, httpStatus: 503, httpMs: null });
    const rows = w.db.select().from(siteStats).where(eq(siteStats.siteId, site.id)).all();
    expect(rows.map((r) => r.up)).toEqual([1, 0]);
    // A disconnected site is not checked.
    w.db.update(sites).set({ status: 'disconnected' }).where(eq(sites.id, site.id)).run();
    await w.core.monitor.tickUptime();
    expect(w.db.select().from(siteStats).where(eq(siteStats.siteId, site.id)).all()).toHaveLength(2);
  });
});
