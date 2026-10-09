/**
 * Plugins and themes: what the wordpress.org directory answers, what each site has installed,
 * and what wpvulnerability.net knows. The one vulnerable plugin is fictional on purpose
 * ("Simple Gallery Grid"), so no screenshot claims a flaw in a real plugin.
 *
 * Every other version is real: the newest release on the demo's date (clock.ts), as
 * wordpress.org and the vendors list it. An older version a site runs is one wpvulnerability.net
 * knows no advisory for. `npx tsx scripts/demo/check-versions.ts` compares them with today's
 * releases; docs/internal/watchlist.md says when.
 */
import type { WporgPluginDto } from '../../shared/types.js';

/** The newest WordPress. A site runs it unless INVENTORY gives it an older one. */
export const WORDPRESS = '7.1.2';

type Directory = Partial<WporgPluginDto> & { slug: string; name: string; version: string };

export const WPORG_PLUGINS: Directory[] = [
  { slug: 'wordpress-seo', name: 'Yoast SEO', author: 'Team Yoast', version: '28.6', testedUpTo: '7.1.2', activeInstalls: 10_000_000, rating: 96, shortDescription: 'Improve your WordPress SEO.' },
  { slug: 'contact-form-7', name: 'Contact Form 7', author: 'Takayuki Miyoshi', version: '6.1.7', testedUpTo: '7.1.2', activeInstalls: 10_000_000, rating: 82, shortDescription: 'Just another contact form plugin. Simple but flexible.' },
  { slug: 'woocommerce', name: 'WooCommerce', author: 'Automattic', version: '11.1.2', testedUpTo: '7.1.2', activeInstalls: 7_000_000, rating: 90, shortDescription: 'Everything you need to launch an online store.' },
  { slug: 'redirection', name: 'Redirection', author: 'John Godley', version: '5.10.1', testedUpTo: '7.1.2', activeInstalls: 2_000_000, rating: 90, shortDescription: 'Manage 301 redirects and track 404 errors.' },
  { slug: 'safe-svg', name: 'Safe SVG', author: '10up', version: '2.5.1', testedUpTo: '7.1.2', activeInstalls: 1_000_000, rating: 92, shortDescription: 'Enable SVG uploads and sanitize them.' },
  { slug: 'query-monitor', name: 'Query Monitor', author: 'John Blackbourn', version: '4.0.7', testedUpTo: '7.0.6', activeInstalls: 200_000, rating: 98, shortDescription: 'The developer tools panel for WordPress.' },
  { slug: 'duplicate-post', name: 'Yoast Duplicate Post', author: 'Enrico Battocchi & Team Yoast', version: '4.7', testedUpTo: '7.1.2', activeInstalls: 4_000_000, rating: 92, shortDescription: 'Clone posts and pages.' },
  { slug: 'regenerate-thumbnails', name: 'Regenerate Thumbnails', author: 'Alex Mills', version: '3.1.6', testedUpTo: '6.8.10', activeInstalls: 1_000_000, rating: 94, shortDescription: 'Regenerate the thumbnails for your image attachments.' },
  { slug: 'tablepress', name: 'TablePress', author: 'Tobias Bäthge', version: '3.4', testedUpTo: '7.1.2', activeInstalls: 700_000, rating: 98, shortDescription: 'Embed beautiful and interactive tables into your site.' },
  { slug: 'the-events-calendar', name: 'The Events Calendar', author: 'The Events Calendar', version: '6.18.0', testedUpTo: '7.1.2', activeInstalls: 700_000, rating: 86, shortDescription: 'Create and manage an events calendar.' },
  { slug: 'polylang', name: 'Polylang', author: 'WP SYNTEX', version: '3.8.10', testedUpTo: '7.1.2', activeInstalls: 800_000, rating: 92, shortDescription: 'Make your WordPress site multilingual.' },
  { slug: 'wp-super-cache', name: 'WP Super Cache', author: 'Automattic', version: '3.1.4', testedUpTo: '7.1.2', activeInstalls: 1_000_000, rating: 82, shortDescription: 'A very fast caching engine for WordPress.' },
  { slug: 'mailchimp-for-wp', name: 'MC4WP: Mailchimp for WordPress', author: 'ibericode', version: '4.14.1', testedUpTo: '7.1.2', activeInstalls: 2_000_000, rating: 96, shortDescription: 'Mailchimp for WordPress, by ibericode.' },
  { slug: 'simple-gallery-grid', name: 'Simple Gallery Grid', author: 'Demo Plugins', version: '2.1.4', testedUpTo: '7.1.2', activeInstalls: 20_000, rating: 84, shortDescription: 'Responsive image galleries from a shortcode.' },
];

/** What wordpress.org does not list, and where its vendor announces a release. */
export const VENDOR_RELEASES: Record<string, { version: string; source: string }> = {
  'advanced-custom-fields-pro': { version: '6.8.10', source: 'https://www.advancedcustomfields.com/changelog/' },
  breakdance: { version: '2.8.3', source: 'https://breakdance.com/blog/' },
  'breakdance-zero': { version: '1.0.0', source: 'https://github.com/soflyy/breakdance-zero-theme/blob/master/style.css' },
};

/** The newest release of everything a site has installed. */
export const LATEST: Record<string, string> = {
  ...Object.fromEntries(WPORG_PLUGINS.map((plugin) => [plugin.slug, plugin.version])),
  ...Object.fromEntries(Object.entries(VENDOR_RELEASES).map(([slug, release]) => [slug, release.version])),
  twentytwentyfive: '1.5',
  twentytwentyfour: '1.6',
};

export interface DemoComponent {
  kind: 'plugin' | 'theme';
  slug: string;
  title: string;
  status: string;
  version: string;
  updateVersion?: string;
}

interface Installed {
  /** Older than the newest release, which then waits as the site's update. */
  version?: string;
  status?: string;
}

function component(kind: DemoComponent['kind'], slug: string, title: string, installed: Installed = {}): DemoComponent {
  const latest = LATEST[slug];
  if (!latest) throw new Error(`plugins.ts: no newest release of ${slug} in LATEST`);
  const version = installed.version ?? latest;
  return { kind, slug, title, status: installed.status ?? 'active', version, ...(version !== latest ? { updateVersion: latest } : {}) };
}
const p = (slug: string, title: string, installed?: Installed): DemoComponent => component('plugin', slug, title, installed);
const t = (slug: string, title: string, installed?: Installed): DemoComponent => component('theme', slug, title, installed);

const common = [p('wordpress-seo', 'Yoast SEO'), p('contact-form-7', 'Contact Form 7'), p('redirection', 'Redirection')];

export interface DemoSite {
  core: string;
  /** The WordPress update waiting on a site that runs an older release. */
  coreUpdate?: { version: string; type: 'major' | 'minor' };
  components: DemoComponent[];
}

/** WordPress calls an update major when it moves to another x.y branch. */
const branch = (version: string): string => version.split('.').slice(0, 2).join('.');

function site(components: DemoComponent[], core = WORDPRESS): DemoSite {
  if (core === WORDPRESS) return { core, components };
  return { core, coreUpdate: { version: WORDPRESS, type: branch(core) === branch(WORDPRESS) ? 'minor' : 'major' }, components };
}

/**
 * Installed plugins and themes per site. The two sites behind on WordPress run the newest
 * release of an older branch: wordpress.org calls 7.0.6 and 6.9.9 outdated but not insecure,
 * while every 7.1 release before 7.1.2 is insecure.
 */
export const INVENTORY: Record<string, DemoSite> = {
  'northwind-bakery': site([...common, p('woocommerce', 'WooCommerce'), p('advanced-custom-fields-pro', 'Advanced Custom Fields PRO'), p('safe-svg', 'Safe SVG'), t('twentytwentyfive', 'Twenty Twenty-Five')]),
  'alpine-dental': site([...common, p('the-events-calendar', 'The Events Calendar'), p('duplicate-post', 'Yoast Duplicate Post'), t('twentytwentyfive', 'Twenty Twenty-Five')]),
  'harbor-yoga': site([...common, p('mailchimp-for-wp', 'MC4WP: Mailchimp for WordPress'), p('the-events-calendar', 'The Events Calendar', { version: '6.17.5.1' }), p('breakdance', 'Breakdance'), t('breakdance-zero', 'Breakdance Zero Theme')]),
  'cedar-stone': site([...common, p('tablepress', 'TablePress', { version: '3.3.4' }), p('regenerate-thumbnails', 'Regenerate Thumbnails'), t('twentytwentyfour', 'Twenty Twenty-Four')], '7.0.6'),
  'blue-fern': site([...common, p('simple-gallery-grid', 'Simple Gallery Grid', { version: '2.1.3' }), p('woocommerce', 'WooCommerce', { version: '11.1.1' }), t('twentytwentyfive', 'Twenty Twenty-Five')]),
  'pixel-press': site([...common, p('polylang', 'Polylang'), p('wp-super-cache', 'WP Super Cache'), p('advanced-custom-fields-pro', 'Advanced Custom Fields PRO'), t('twentytwentyfive', 'Twenty Twenty-Five')]),
  'ridge-outfitters': site([...common, p('woocommerce', 'WooCommerce'), p('query-monitor', 'Query Monitor', { status: 'inactive' }), t('twentytwentyfive', 'Twenty Twenty-Five')]),
  'lumen-law': site([...common, p('duplicate-post', 'Yoast Duplicate Post'), t('twentytwentyfive', 'Twenty Twenty-Five')]),
  'summit-coffee': site([...common, p('advanced-custom-fields-pro', 'Advanced Custom Fields PRO'), p('breakdance', 'Breakdance'), t('breakdance-zero', 'Breakdance Zero Theme')]),
  'oak-and-ivy': site([...common, t('twentytwentyfive', 'Twenty Twenty-Five')]),
  'tidewater-realty': site([...common, p('safe-svg', 'Safe SVG'), t('twentytwentyfour', 'Twenty Twenty-Four', { version: '1.5' })], '6.9.9'),
};

/**
 * The sites hosted elsewhere (external.ts): Meadow Vet Clinic runs the gallery plugin with the
 * advisory too. WPL7 Connect itself is not here: it is the panel's own (inventory.ts adds it).
 */
export const EXTERNAL_INVENTORY: Record<string, DemoSite> = {
  'meadow-vet': site([...common, p('simple-gallery-grid', 'Simple Gallery Grid', { version: '2.1.3' }), p('tablepress', 'TablePress', { version: '3.3.4' }), t('twentytwentyfive', 'Twenty Twenty-Five')]),
  'granite-gym': site([p('wordpress-seo', 'Yoast SEO'), p('mailchimp-for-wp', 'MC4WP: Mailchimp for WordPress'), t('twentytwentyfive', 'Twenty Twenty-Five')]),
};

/** The one advisory in the demo, against the fictional gallery plugin on Blue Fern Florist and Meadow Vet Clinic. */
export const DEMO_ADVISORY = {
  slug: 'simple-gallery-grid',
  advisory: {
    id: 'demo-0001',
    title: 'Simple Gallery Grid <= 2.1.3 - Stored Cross-Site Scripting via shortcode attributes',
    severity: 'medium' as const,
    cvss: 6.4,
    range: { maxVersion: '2.1.3', maxOperator: 'le' },
    unfixed: false,
    fixedIn: '2.1.4',
    cves: [],
    link: null,
    publishedAt: Date.UTC(2026, 8, 30),
  },
};

/** The plugin catalog: the default plugins for new sites, and two premium zips. */
export const CATALOG = [
  { kind: 'wporg', slug: 'wordpress-seo', name: 'Yoast SEO', isDefault: 1 },
  { kind: 'wporg', slug: 'contact-form-7', name: 'Contact Form 7', isDefault: 1 },
  { kind: 'wporg', slug: 'redirection', name: 'Redirection', isDefault: 1 },
  { kind: 'wporg', slug: 'safe-svg', name: 'Safe SVG', isDefault: 0 },
  { kind: 'zip', slug: 'advanced-custom-fields-pro', name: 'Advanced Custom Fields PRO', isDefault: 0 },
  { kind: 'zip', slug: 'breakdance', name: 'Breakdance', isDefault: 0 },
] as const;
