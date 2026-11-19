/**
 * What php.net said on the demo's date, and one site that did not move onto the newest release:
 * the Overview's PHP card (services/phpUpdates.ts). On 2026-10-05 the newest releases were
 * September's security releases, and no release candidate was out yet.
 */
import { eq } from 'drizzle-orm';
import { sites } from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { DEMO_NOW, HOUR, MINUTE } from './clock.js';
import { PHP_RELEASES, SERVERS } from './data.js';

/** When php.net published September's releases, as this install first read them. */
const SEEN = Date.parse('2026-09-24T16:05:00Z');

/** Some of what PHP 8.4.26 fixed, as GitHub's advisories for php-src list it. */
const ADVISORIES_8_4_26 = [
  ['GHSA-rgrp-mwpx-f6rm', 'CVE-2026-91765', 'high', 'SOAP: Unbounded Recursion in Server-Side cleanup_xml_node'],
  ['GHSA-vvx9-73fr-5jjx', 'CVE-2026-91769', 'medium', 'TLS Hostname Verification Falls Back to CN After SAN Mismatch'],
  ['GHSA-fpwc-w8rq-cr92', 'CVE-2026-91766', 'medium', 'Cross-origin credential leak in HTTP stream wrapper redirects'],
  ['GHSA-62xp-839h-2637', 'CVE-2026-91768', 'medium', 'IPv6 ACL bypass in FastCGI listen.allowed_clients due to partial address comparison'],
  ['GHSA-r6x9-5r99-36j7', 'CVE-2025-1218', 'low', 'Various packet overreads in mysqlnd_writeprotocol.c'],
].map(([id, cve, severity, summary]) => ({ id: id!, cve: cve!, severity: severity!, summary: summary!, url: `https://github.com/php/php-src/security/advisories/${id}` }));

/** The site whose move onto 8.4.26 failed, and went back to its old container. */
export const PHP_BEHIND = { slug: 'ridge-outfitters', release: '8.4.25' };

/** When the sweep tried to move it, once its server had the new image (demo/jobs.ts). */
export const PHP_MOVE_AT = SEEN + 5 * HOUR;

export function seedPhp(w: TestWorld): void {
  const releases = Object.fromEntries(
    Object.entries(PHP_RELEASES).map(([branch, version]) => [branch, { version, date: '2026-09-24', security: true, seenAt: SEEN }]),
  );
  w.core.settings.setRaw('php.upstream', {
    checkedAt: DEMO_NOW - 6 * MINUTE,
    attemptedAt: DEMO_NOW - 6 * MINUTE,
    error: null,
    releases,
    candidates: {},
    notice: null,
    advisories: { '8.4.26': { fetchedAt: SEEN, error: null, items: ADVISORIES_8_4_26 } },
    feed: { etag: 'W/"demo"', lastModified: null },
  });
  w.core.settings.setRaw('php.images', {
    servers: Object.fromEntries(
      SERVERS.map((server) => [
        server.id,
        {
          releases: { ...PHP_RELEASES },
          readAt: DEMO_NOW - 6 * MINUTE,
          weeklyDone: Object.fromEntries(Object.keys(PHP_RELEASES).map((v) => [v, DEMO_NOW - 30 * HOUR])),
          error: null,
        },
      ]),
    ),
    doneAt: {},
  });
  w.db.update(sites).set({ phpRelease: PHP_BEHIND.release }).where(eq(sites.slug, PHP_BEHIND.slug)).run();
}
