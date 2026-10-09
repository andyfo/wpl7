/**
 * Compare the demo's versions (plugins.ts) with today's releases: the watchlist's check for the
 * demo world (docs/internal/watchlist.md). It needs the network, which the demo never uses, and
 * exits 1 when something needs changing.
 *
 *   npx tsx scripts/demo/check-versions.ts
 *
 * It reports a newer release of WordPress or of a wordpress.org plugin or theme, an older
 * version a site runs that is now insecure or has an advisory, and a newest release that needs
 * a newer PHP or WordPress than a site runs. Premium releases have no API: it says where to look.
 */
import { compareVersions, matchRange } from '../../src/lib/wpVersions.js';
import { normalizeAdvisory } from '../../src/services/vulnerabilities.js';
import { EXTERNAL_SITES, SITES } from './data.js';
import { DEMO_ADVISORY, EXTERNAL_INVENTORY, INVENTORY, LATEST, VENDOR_RELEASES, WORDPRESS, WPORG_PLUGINS } from './plugins.js';

/** Every site's inventory, the ones hosted elsewhere too. WPL7 Connect is the panel's own, on no directory. */
const ALL = { ...INVENTORY, ...EXTERNAL_INVENTORY };

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': 'wpl7-demo-check-versions' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const problems: string[] = [];

// WordPress: the newest release, and the older ones two sites run.
const { offers } = await get<{ offers: { current: string }[] }>('https://api.wordpress.org/core/version-check/1.7/');
if (offers[0]?.current !== WORDPRESS) problems.push(`WordPress: ${offers[0]?.current} is out, the demo has ${WORDPRESS}`);
const stable = await get<Record<string, string>>('https://api.wordpress.org/core/stable-check/1.0/');
const cores = new Set(Object.values(ALL).map((site) => site.core));
for (const core of cores) {
  if (stable[core] === 'insecure') problems.push(`WordPress ${core}: wordpress.org calls it insecure`);
  const feed = await get<{ data: { vulnerability: unknown[] | null } }>(`https://www.wpvulnerability.net/core/${core}/`);
  if (feed.data.vulnerability?.length) problems.push(`WordPress ${core}: wpvulnerability.net lists ${feed.data.vulnerability.length} advisories`);
}

// Every plugin and theme the sites have, by slug.
const installed = new Map<string, { kind: 'plugin' | 'theme'; versions: Set<string>; sites: string[] }>();
for (const [slug, site] of Object.entries(ALL)) {
  for (const c of site.components) {
    const entry = installed.get(c.slug) ?? { kind: c.kind, versions: new Set<string>(), sites: [] };
    entry.versions.add(c.version);
    entry.sites.push(slug);
    installed.set(c.slug, entry);
  }
}

interface Info {
  version?: string;
  tested?: string;
  requires?: string | false;
  requires_php?: string | false;
  error?: string;
}

for (const [slug, { kind, versions, sites }] of installed) {
  if (slug === DEMO_ADVISORY.slug) continue;
  const vendor = VENDOR_RELEASES[slug];
  if (vendor) {
    console.log(`${slug}: the demo has ${vendor.version}. Check by hand: ${vendor.source}`);
  } else {
    const api = kind === 'plugin' ? 'plugins/info/1.2/?action=plugin_information' : 'themes/info/1.2/?action=theme_information';
    const info = await get<Info>(`https://api.wordpress.org/${api}&request%5Bslug%5D=${slug}&request%5Bfields%5D%5Bsections%5D=0`);
    if (info.error || !info.version) throw new Error(`${slug}: wordpress.org answered ${info.error ?? 'no version'}`);
    if (info.version !== LATEST[slug]) {
      problems.push(`${slug}: ${info.version} is out, the demo has ${LATEST[slug]}`);
    } else {
      const tested = WPORG_PLUGINS.find((plugin) => plugin.slug === slug)?.testedUpTo;
      if (kind === 'plugin' && info.tested !== tested) problems.push(`${slug}: tested up to ${info.tested}, the demo says ${tested}`);
      for (const siteSlug of sites) {
        const php = (SITES.find((s) => s.slug === siteSlug) ?? EXTERNAL_SITES.find((s) => s.slug === siteSlug))!.php;
        const core = ALL[siteSlug]!.core;
        if (info.requires_php && compareVersions(php, info.requires_php) < 0) problems.push(`${slug} ${info.version} needs PHP ${info.requires_php}; ${siteSlug} runs ${php}`);
        if (info.requires && compareVersions(core, info.requires) < 0) problems.push(`${slug} ${info.version} needs WordPress ${info.requires}; ${siteSlug} runs ${core}`);
      }
    }
  }
  // An older version a site runs must have no advisory: the demo shows it as safe.
  for (const version of versions) {
    if (version === LATEST[slug]) continue;
    const feed = await get<{ data: { vulnerability: Record<string, unknown>[] | null } }>(`https://www.wpvulnerability.net/${kind}/${slug}/`);
    const hits = (feed.data.vulnerability ?? []).map(normalizeAdvisory).filter((advisory) => matchRange(version, advisory.range) !== 'no-match');
    for (const advisory of hits) problems.push(`${slug} ${version}: ${advisory.title}`);
  }
}

if (problems.length === 0) {
  console.log('Everything else is the newest release, and no older version a site runs has an advisory.');
} else {
  for (const problem of problems) console.log(`- ${problem}`);
  process.exit(1);
}
