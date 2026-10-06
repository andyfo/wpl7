/**
 * Security: Standard protection for the fleet and Strict for Alpine Dental Clinic, a week of
 * blocked requests per site, six addresses on the fleet block list (documentation ranges), and
 * last night's malware scans: everything clean but Pixel Press Magazine, where a PHP file in
 * uploads was found and moved to quarantine, and the stopped site, whose scan could not run.
 */
import { securityBlocks, securityNeverBlock, siteBlocked, siteBlockedRecent, siteQuarantine, siteScanFindings, siteScanStatus, siteScans, siteSecurity } from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, MINUTE, ago, DEMO_NOW } from './clock.js';
import { SITES, rng, seedOf } from './data.js';
import { siteIds } from './sites.js';

const RULES: [rule: string, share: number][] = [
  ['files', 0.32],
  ['limit-login', 0.24],
  ['scanners', 0.14],
  ['xmlrpc', 0.12],
  ['enum', 0.08],
  ['uploads', 0.05],
  ['blocked-address', 0.05],
];

const PROBES: [rule: string, method: string, path: string, status: number][] = [
  ['files', 'GET', '/.env', 403],
  ['files', 'GET', '/wp-config.php.bak', 403],
  ['limit-login', 'POST', '/wp-login.php', 429],
  ['scanners', 'GET', '/', 403],
  ['xmlrpc', 'POST', '/xmlrpc.php', 403],
  ['enum', 'GET', '/', 403],
  ['uploads', 'GET', '/wp-content/uploads/2026/09/cache.php', 403],
  ['files', 'GET', '/.git/config', 403],
];

export function seedSecurity(world: TestWorld): void {
  const db = world.db;
  const today = Math.floor(DEMO_NOW / DAY) * DAY;
  db.transaction((tx) => {
    tx.insert(siteSecurity)
      .values({ siteId: siteIds.get('alpine-dental')!, level: 'strict', overrides: '{}', customRules: '[]', updatedAt: ago(41 * DAY), updatedBy: 'sam' })
      .run();

    for (const site of SITES) {
      if (site.dailyVisitors === 0 && site.state !== 'stopped') continue;
      const siteId = siteIds.get(site.slug)!;
      const next = rng(seedOf(`blocked:${site.slug}`));
      const scale = site.state === 'stopped' ? 0 : 40 + site.dailyVisitors * 0.18;
      for (let d = 6; d >= 0; d--) {
        for (const [rule, share] of RULES) {
          const requests = Math.round(scale * share * (0.6 + next() * 0.8));
          if (requests > 0) tx.insert(siteBlocked).values({ siteId, day: today - d * DAY, rule, requests }).run();
        }
      }
      if (scale === 0) continue;
      for (let i = 0, n = 4 + Math.round(site.dailyVisitors / 60); i < n; i++) {
        const [rule, method, path, status] = PROBES[Math.floor(next() * PROBES.length)]!;
        const ip = next() < 0.5 ? `198.51.100.${100 + Math.floor(next() * 120)}` : `192.0.2.${100 + Math.floor(next() * 120)}`;
        tx.insert(siteBlockedRecent)
          .values({ siteId, ts: ago(Math.round(next() * 20 * HOUR) + MINUTE), rule, ip, country: ip.startsWith('198') ? 'DE' : 'US', method, path, status })
          .run();
      }
    }

    // The fleet block list: six addresses the detector or an admin blocked, all from documentation ranges.
    const blocks = [
      { address: '198.51.100.23', rule: 'login', reason: 'Login guessing: 412 failed logins in 10 minutes', country: 'NL', at: ago(26 * MINUTE), hours: 1, site: 'northwind-bakery', strike: 1, count: 412, threshold: 30, windowMin: 10, paths: ['/wp-login.php'], ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      { address: '198.51.100.77', rule: 'probing', reason: 'Probing: 63 requests for sensitive files in 5 minutes', country: 'DE', at: ago(2 * HOUR + 4 * MINUTE), hours: 4, site: 'pixel-press', strike: 2, count: 63, threshold: 20, windowMin: 5, paths: ['/.env', '/.git/config', '/wp-config.php.bak'], ua: 'python-requests/2.33' },
      { address: '192.0.2.144', rule: 'xmlrpc', reason: 'XML-RPC: 280 POST requests to xmlrpc.php in 10 minutes', country: 'US', at: ago(3 * HOUR + 40 * MINUTE), hours: 16, site: 'blue-fern', strike: 3, count: 280, threshold: 20, windowMin: 10, paths: ['/xmlrpc.php'], ua: null },
      { address: '192.0.2.201', rule: 'deadUrls', reason: 'Dead URLs: 190 distinct pages answered 404 in 10 minutes', country: 'US', at: ago(41 * MINUTE), hours: 1, site: 'ridge-outfitters', strike: 1, count: 190, threshold: 60, windowMin: 10, paths: ['/old-shop/', '/backup.zip', '/admin/'], ua: 'Go-http-client/2.0' },
      { address: '198.51.100.140', rule: 'flooding', reason: 'Flooding: 1,840 requests blocked by a rate limit in 5 minutes', country: 'FR', at: ago(3 * HOUR + 12 * MINUTE), hours: 4, site: 'pixel-press', strike: 2, count: 1840, threshold: 300, windowMin: 5, paths: ['/', '/feed/'], ua: 'curl/8.5.0' },
      { address: '192.0.2.250', rule: null, reason: 'Blocked by hand: repeated card testing on the checkout', country: 'SG', at: ago(2 * DAY + 3 * HOUR), hours: null, site: 'ridge-outfitters', strike: 1, count: 0, threshold: 0, windowMin: 0, paths: ['/checkout/'], ua: null },
    ];
    for (const b of blocks) {
      tx.insert(securityBlocks)
        .values({
          address: b.address,
          family: 4,
          source: b.rule ? 'detector' : 'manual',
          rule: b.rule,
          reason: b.reason,
          evidence: b.rule ? JSON.stringify({ count: b.count, threshold: b.threshold, windowMin: b.windowMin, sites: [b.site], samplePaths: b.paths, userAgent: b.ua, via: null }) : null,
          siteId: siteIds.get(b.site)!,
          serverId: SITES.find((s) => s.slug === b.site)!.server,
          country: b.country,
          createdBy: b.rule ? 'detector' : 'priya',
          createdAt: b.at,
          expiresAt: b.hours === null ? null : b.at + b.hours * HOUR,
          strike: b.strike,
          hits: 12 + Math.round(rng(seedOf(b.address))() * 300),
          lastHitAt: b.at + 9 * MINUTE,
        })
        .run();
    }
    tx.insert(securityNeverBlock).values({ address: '192.0.2.10', note: 'Agency office', createdBy: 'admin', createdAt: ago(90 * DAY) }).run();

    // Last night's scans.
    for (const site of SITES) {
      if (site.ageDays < 1) continue;
      const siteId = siteIds.get(site.slug)!;
      const startedAt = today + 3 * HOUR + 70 * MINUTE + SITES.indexOf(site) * 4 * MINUTE;
      const stopped = site.state === 'stopped';
      const infected = site.slug === 'pixel-press';
      const scan = tx
        .insert(siteScans)
        .values({
          siteId,
          serverId: site.server,
          trigger: 'schedule',
          status: stopped ? 'failed' : infected ? 'findings' : 'clean',
          startedAt,
          finishedAt: startedAt + (stopped ? 2_000 : 95_000),
          engines: JSON.stringify(stopped ? {} : { check: { state: 'done' }, signatures: { state: 'done' } }),
          filesScanned: stopped ? null : 4_200 + Math.round(site.diskMb * 0.6),
          findingsTotal: stopped ? null : infected ? 1 : 0,
          findingsNew: stopped ? null : infected ? 1 : 0,
          noChecksums: JSON.stringify(site.slug === 'harbor-yoga' || site.slug === 'summit-coffee' ? ['plugin:breakdance'] : []),
          error: stopped ? 'The site is stopped: its files were not scanned.' : null,
        })
        .returning()
        .get();
      let findingId: number | null = null;
      if (infected) {
        findingId = tx
          .insert(siteScanFindings)
          .values({
            siteId,
            fingerprint: 'signature:wp-content/uploads/2026/09/cache.php:php-webshell',
            engine: 'signatures',
            kind: 'upload-php',
            confidence: 'confirmed',
            severity: 'high',
            path: 'wp-content/uploads/2026/09/cache.php',
            line: 1,
            rule: 'PHP webshell (eval of request data)',
            detail: 'A PHP file in uploads that evaluates code sent in a request.',
            sha256: 'd2c1f0a7b6e5d4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a2918070f6e5d4c',
            firstSeenAt: startedAt + 60_000,
            lastSeenAt: startedAt + 60_000,
            lastScanId: scan.id,
            status: 'quarantined',
            statusAt: startedAt + 95_000,
            statusBy: 'automatic',
          })
          .returning()
          .get().id;
        tx.insert(siteQuarantine)
          .values({
            siteId,
            findingId,
            path: 'wp-content/uploads/2026/09/cache.php',
            storedName: '20261005-041512-cache.php',
            sha256: 'd2c1f0a7b6e5d4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a2918070f6e5d4c',
            sizeBytes: 1_284,
            mode: '644',
            reason: 'Known malware: PHP webshell',
            movedAt: startedAt + 95_000,
            movedBy: 'automatic',
          })
          .run();
      }
      tx.insert(siteScanStatus)
        .values({
          siteId,
          lastScanId: scan.id,
          lastStartedAt: startedAt,
          lastFinishedAt: startedAt + (stopped ? 2_000 : 95_000),
          lastOutcome: stopped ? 'failed' : infected ? 'findings' : 'clean',
          openFindings: 0,
          openConfirmed: 0,
          quarantined: infected ? 1 : 0,
          failures: stopped ? 1 : 0,
        })
        .run();
    }
  });
  // Pixel Press quarantines what a scan confirms; everything else reports.
  db.insert(siteSecurity).values({ siteId: siteIds.get('pixel-press')!, scanOnFinding: 'quarantine-confirmed', overrides: '{}', customRules: '[]', updatedAt: ago(60 * DAY), updatedBy: 'admin' }).run();
}
