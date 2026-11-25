/**
 * Every screenshot the docs and the marketing site use: the one list of what exists.
 *
 * `name` is a stable identifier: <Screenshot name="…"> and the marketing site's URLs
 * (/docs/screens/<name>-light.png) depend on it. `path` is a panel URL in the demo world
 * (panel/scripts/demo/), `prepare` opens dialogs, picks tabs or fills forms before the capture,
 * and `theme: 'both'` also takes a dark twin. Phone shots are 390×844, the rest 1440×900, all at
 * 2×. `hero` marks the marketing set (shoot.ts --marketing takes it in every accent). shoot.ts
 * reads this file; README.md says how to run it.
 */
import type { Page } from '@playwright/test';

export interface Shot {
  name: string;
  /** What the shot shows, for reviewers and for alt text. */
  what: string;
  path: string;
  theme: 'light' | 'both';
  phone?: boolean;
  hero?: boolean;
  /** Taken signed out (the sign-in page). */
  signedOut?: boolean;
  /** Runs before the page loads: to change what the demo world answers, for this shot alone. */
  before?: (page: Page) => Promise<void>;
  prepare?: (page: Page) => Promise<void>;
}

/** Click the tab whose visible name is exactly `name`. */
const tab = (name: string) => async (page: Page) => {
  await page.getByRole('tab', { name, exact: true }).or(page.getByRole('button', { name, exact: true })).first().click();
};

/** Click the button whose visible name is exactly `name`. */
const button = (name: string) => async (page: Page) => {
  await page.getByRole('button', { name, exact: true }).first().click();
};

/** Scroll the page so the card with this title is near the top. */
const scrollTo = (title: string) => async (page: Page) => {
  await page.getByText(title, { exact: true }).first().evaluate((el) => {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 96, behavior: 'instant' });
  });
};

/** What New site reads of a Duplicator package, for the site-new-package shot. */
const demoPackage = (uploadId: string) => ({
  uploadId,
  format: 'zip',
  bytes: 1_288_490_189,
  duplicator: '5.2.0',
  created: '2026-11-20 10:15:00',
  report: {
    home: 'https://harborflorist.example',
    siteurl: 'https://harborflorist.example',
    title: 'Harbor Florist',
    wpVersion: '7.1.5',
    phpVersion: '8.2.29',
    tablePrefix: 'hf_',
    https: true,
    abspath: '/home/harbor/public_html',
    files: { count: 18342, bytes: 1_610_612_736, partial: false },
    db: { server: '10.11.9-MariaDB', bytes: 100_663_296, tables: 48 },
    plugins: Array.from({ length: 23 }, (_, i) => ({ slug: `plugin-${i}`, name: `Plugin ${i}`, version: '1.0', active: i < 17 })),
    theme: { slug: 'harbor', name: 'Harbor', version: '2.3' },
    dropins: [],
    muPlugins: [],
  },
  dumpFiles: 49,
  warnings: [{ code: 'htaccess-custom', blocking: false, message: '.htaccess has rules of its own. Check them once the site is up (Files tab).' }],
  blockedReason: null,
  suggestions: { title: 'Harbor Florist', slug: 'harborflorist', phpVersion: '8.2', deactivatePlugins: [], removeDropins: [], removeMuPlugins: [] },
  constants: [],
});

/** Answer `GET <api>` with the demo world's own answer, as `edit` changes it. */
const answer = (api: string, edit: (body: Record<string, unknown>) => unknown) => async (page: Page) => {
  await page.route(`**${api}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: edit((await response.json()) as Record<string, unknown>) });
  });
};

const steps =
  (...fns: ((page: Page) => Promise<void>)[]) =>
  async (page: Page) => {
    for (const fn of fns) {
      await fn(page);
      await page.waitForLoadState('networkidle');
    }
  };

export const SHOTS: Shot[] = [
  { name: 'reminders', what: 'Reminders: a checklist with due and upcoming work', path: '/reminders', theme: 'both' },
  { name: 'reminders-new', what: 'A reminder with a repeat interval and an email recipient', path: '/reminders', theme: 'light', prepare: button('New reminder') },
  {
    name: 'reminders-eol', what: 'Adding a server OS end-of-life reminder', path: '/reminders', theme: 'light',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'New reminder', exact: true }).click();
      await page.getByLabel('Kind').selectOption('os');
      await page.getByLabel('Server operating system').selectOption({ index: 1 });
    },
  },
  { name: 'reminders-domains', what: 'Domains and their registry dates', path: '/reminders?tab=domains', theme: 'light' },
  {
    name: 'overview',
    what: 'The Dashboard: the fleet at a glance',
    path: '/',
    theme: 'both',
    hero: true,
    // Without the PHP card, which overview-php shows: it would push the server charts off the page.
    before: answer('/api/php', (php) => ({ ...php, branches: [] })),
  },
  {
    name: 'overview-php',
    what: "The Overview's PHP card: the PHP release each version's sites run, and a site still on an older PHP than a security release",
    path: '/',
    theme: 'light',
    prepare: scrollTo('PHP'),
  },
  {
    name: 'php-details',
    what: "The details of a PHP version: each server's image, a site whose move failed, and what the release fixed",
    path: '/?php=8.4',
    theme: 'light',
  },
  { name: 'sites-list', what: 'Sites → All sites: thirteen sites on three servers, and two hosted elsewhere', path: '/sites', theme: 'both', hero: true },
  {
    name: 'site-new',
    what: 'The New site wizard, its first step filled in',
    path: '/sites/new',
    theme: 'light',
    prepare: async (page) => {
      await page.getByLabel('Site title').fill('Willow Pediatrics');
    },
  },
  {
    name: 'site-new-php',
    what: 'The New site wizard for a PHP site, on its PHP step: a database and a web root',
    path: '/sites/new',
    theme: 'light',
    prepare: steps(
      async (page) => page.getByRole('group', { name: 'Type', exact: true }).getByRole('button', { name: 'PHP', exact: true }).click(),
      async (page) => page.getByLabel('Site title').fill('Lantern Ticketing'),
      async (page) => page.getByRole('button', { name: 'Continue', exact: true }).click(),
      async (page) => page.getByRole('switch', { name: 'Database' }).click(),
      async (page) => page.getByLabel('Web root').fill('public'),
    ),
  },
  {
    name: 'site-new-package',
    what: 'The New site wizard starting from a Duplicator package: what the package holds, and a warning',
    path: '/sites/new',
    theme: 'light',
    // The upload and what the panel reads of it, answered here: the demo world has no package to read.
    before: async (page) => {
      await page.route('**/api/package-uploads/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === 'PUT') return route.fulfill({ json: { received: Number(url.searchParams.get('size')), complete: true } });
        if (req.method() !== 'GET') return route.fulfill({ status: 204, body: '' });
        return route.fulfill({ json: demoPackage(url.pathname.split('/').pop()!) });
      });
    },
    prepare: steps(
      async (page) => page.getByLabel('Site title').fill('Harbor Florist'),
      async (page) => page.getByRole('button', { name: 'Continue', exact: true }).click(),
      async (page) => page.getByRole('group', { name: 'Start from', exact: true }).getByRole('button', { name: 'Duplicator package', exact: true }).click(),
      async (page) =>
        page.locator('input[type=file]').setInputFiles({ name: '20261120_harborflorist_8c1d2e3f_20261120101500_archive.zip', mimeType: 'application/zip', buffer: Buffer.alloc(2048) }),
      async (page) => page.getByText('Made by', { exact: true }).waitFor(),
    ),
  },
  { name: 'site-overview', what: 'A live site’s Overview tab', path: '/sites/northwind-bakery', theme: 'both', hero: true },
  {
    name: 'site-go-live',
    what: 'The Go live dialog with a domain entered',
    path: '/sites/summit-coffee',
    theme: 'light',
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Go live/ }).first().click();
      await page.getByRole('dialog').getByRole('textbox').first().fill('summitcoffee.example www.summitcoffee.example');
    },
  },
  { name: 'site-import', what: 'Importing a site: what the old site reported, on the Confirm step', path: '/sites/import?id=1', theme: 'light' },
  { name: 'site-connect', what: 'Connecting a site hosted elsewhere: what its plugin reported, on the Confirm step', path: '/sites/connect?id=3', theme: 'light' },
  { name: 'site-external', what: 'A site hosted elsewhere: its Overview tab', path: '/sites/meadow-vet', theme: 'light' },
  { name: 'site-php', what: 'A PHP site’s Overview tab: its web root and database among the facts', path: '/sites/bayside-bikes', theme: 'light' },
  {
    name: 'site-php-settings',
    what: 'A PHP site’s Settings tab: PHP version, web root and its cron lines',
    path: '/sites/bayside-bikes',
    theme: 'light',
    // The cron lines arrive after the tab's own data: wait for the demo's first one.
    prepare: steps(tab('Settings'), (page) => page.getByText('php artisan schedule:run').first().waitFor()),
  },
  {
    name: 'site-new-container',
    what: 'The New site wizard for a container app, on its Image step',
    path: '/sites/new',
    theme: 'light',
    prepare: steps(
      async (page) => page.getByRole('group', { name: 'Type', exact: true }).getByRole('button', { name: 'Container', exact: true }).click(),
      async (page) => page.getByLabel('Site title').fill('Lantern Bookings'),
      async (page) => page.getByRole('button', { name: 'Continue', exact: true }).click(),
      async (page) => page.getByLabel('Image reference').fill('ghcr.io/lantern-example/bookings:stable'),
    ),
  },
  { name: 'site-app', what: 'A container app’s Overview tab: the image it runs, how it is updated, and its routes', path: '/sites/orders-api', theme: 'light' },
  {
    name: 'site-app-routes',
    what: 'A container app’s routes on its Settings tab: a host of its own, and three paths of a WordPress site’s domain',
    path: '/sites/orders-api?tab=settings',
    theme: 'light',
    prepare: scrollTo('Routes'),
  },
  {
    name: 'site-app-deploys',
    what: 'A container app’s Deploys tab: five deploys, the failed one opened on its last log lines',
    path: '/sites/orders-api?tab=deploys',
    theme: 'light',
    prepare: button('Failed'),
  },
  { name: 'sites-external', what: 'Sites → All sites: the sites hosted elsewhere, one whose plugin does not answer', path: '/sites', theme: 'light', prepare: scrollTo('External') },
  { name: 'site-wordpress', what: 'A site’s WordPress tab: updates and plugins', path: '/sites/northwind-bakery', theme: 'both', prepare: tab('WordPress') },
  { name: 'site-updates', what: 'A site’s WordPress tab: an update waiting and a known vulnerability', path: '/sites/blue-fern', theme: 'light', prepare: tab('WordPress') },
  {
    name: 'site-files',
    what: 'A site’s Files tab with a theme file open in the editor',
    path: '/sites/northwind-bakery',
    theme: 'both',
    prepare: steps(
      tab('Files'),
      async (page) => page.getByText('wp-content', { exact: true }).click(),
      async (page) => page.getByText('themes', { exact: true }).click(),
      async (page) => page.getByText('northwind', { exact: true }).click(),
      async (page) => page.getByText('functions.php', { exact: true }).click(),
    ),
  },
  { name: 'site-ftp', what: 'A site’s FTP tab: one login and how to connect', path: '/sites/harbor-yoga', theme: 'light', prepare: tab('FTP') },
  {
    name: 'site-database',
    what: 'A site’s Database tab: how to connect, its two databases, and wp_options open in the browser',
    path: '/sites/northwind-bakery?tab=database&table=wp_options',
    theme: 'both',
  },
  {
    name: 'site-database-structure',
    what: 'The Structure view of wp_options: its columns, its primary key, and the buttons that change them',
    path: '/sites/northwind-bakery?tab=database&table=wp_options',
    theme: 'light',
    // Scrolling before the view has loaded stops short, as far as the page is tall by then.
    prepare: steps(button('Structure'), (page) => page.getByText(/foreign keys/i).waitFor(), scrollTo('Browse wp_northwind_bakery')),
  },
  {
    name: 'site-database-row',
    what: 'One row of wp_options open, its serialized plugin list edited as PHP data',
    path: '/sites/northwind-bakery?tab=database&table=wp_options',
    theme: 'light',
    prepare: steps(
      async (page) => {
        await page.getByRole('cell', { name: 'active_plugins', exact: true }).click();
      },
      button('Edit as PHP data'),
    ),
  },
  {
    name: 'site-database-sql',
    what: 'The SQL view with a query and its result',
    path: '/sites/northwind-bakery?tab=database&view=sql',
    theme: 'light',
    prepare: button('Run'),
  },
  { name: 'databases', what: 'Databases: every server’s databases, and one no site uses', path: '/databases', theme: 'light' },
  {
    name: 'site-visitors',
    what: 'A site’s Visitors tab over seven days',
    path: '/sites/pixel-press',
    theme: 'both',
    prepare: steps(tab('Visitors'), button('7 days')),
  },
  { name: 'site-backups', what: 'A site’s Backups tab', path: '/sites/northwind-bakery', theme: 'light', prepare: tab('Backups') },
  {
    name: 'site-security',
    what: 'A site’s Security tab with its own settings open',
    path: '/sites/alpine-dental',
    theme: 'light',
    // The second "Settings" button: the first is the site's Settings tab.
    prepare: steps(tab('Security'), async (page) => page.getByRole('button', { name: 'Settings', exact: true }).last().click()),
  },
  { name: 'site-settings', what: 'A site’s Settings tab: PHP version, domains, delete', path: '/sites/northwind-bakery', theme: 'light', prepare: tab('Settings') },
  {
    name: 'site-caching',
    what: 'A site’s Caching card: the page cache, how long pages stay, the object cache and Check a URL',
    path: '/sites/northwind-bakery',
    theme: 'light',
    prepare: steps(tab('Settings'), scrollTo('Caching')),
  },
  {
    name: 'site-caching-rules',
    what: 'A site’s Caching card with its rules open: the built-in groups and the form for a rule of its own',
    path: '/sites/northwind-bakery',
    theme: 'light',
    prepare: steps(tab('Settings'), scrollTo('Caching'), async (page) => {
      await page.locator('summary', { hasText: /^Rules$/ }).click();
    }),
  },
  {
    name: 'site-limits',
    what: 'A site’s container limits: memory of its own, CPU and processes on the defaults',
    path: '/sites/northwind-bakery',
    theme: 'light',
    prepare: steps(tab('Settings'), scrollTo('Container limits')),
  },
  {
    name: 'sites-bulk',
    what: 'Sites → Bulk management: plugins with updates, two selected',
    path: '/sites/bulk',
    theme: 'light',
    prepare: async (page) => {
      const rows = page.locator('tbody input[type="checkbox"]');
      await rows.nth(0).check();
      await rows.nth(1).check();
    },
  },
  { name: 'sites-security', what: 'Sites → Security → Findings', path: '/sites/security', theme: 'both', hero: true },
  { name: 'sites-security-settings', what: 'Sites → Security → Settings: the default protection', path: '/sites/security', theme: 'light', prepare: tab('Settings') },
  { name: 'servers-list', what: 'Servers → All servers', path: '/servers', theme: 'both' },
  { name: 'server-detail', what: 'A server’s page', path: '/servers/1', theme: 'light' },
  { name: 'server-add', what: 'The Add server dialog', path: '/servers', theme: 'light', prepare: button('Add server') },
  {
    name: 'terminal',
    what: 'Servers → Terminal with a shell session',
    path: '/servers/1/terminal',
    theme: 'both',
    prepare: async (page) => {
      await page.getByText('load average').first().waitFor();
    },
  },
  { name: 'servers-security', what: 'Servers → Security: the block list', path: '/servers/security', theme: 'light' },
  { name: 'plugins', what: 'Plugins → All plugins: the catalog', path: '/plugins', theme: 'both' },
  {
    name: 'plugins-catalog',
    what: 'Plugins → All plugins: adding a plugin from wordpress.org',
    path: '/plugins',
    theme: 'light',
    prepare: async (page) => {
      await page.getByPlaceholder(/Search wordpress\.org/).first().fill('seo');
      await page.waitForTimeout(600);
    },
  },
  { name: 'recipes', what: 'Plugins → Recipes: ACF PRO and Breakdance', path: '/plugins/recipes', theme: 'light' },
  { name: 'backups-all', what: 'Backups → All backups, a deleted site’s included', path: '/backups', theme: 'both', hero: true },
  { name: 'backups-storage', what: 'Backups → Storage: where backups are kept, and an offsite destination', path: '/backups/storage', theme: 'light' },
  {
    name: 'backups-delete-old',
    what: 'Backups → All backups: Delete old backups, with what it comes to',
    path: '/backups',
    theme: 'light',
    prepare: steps(
      button('Delete old backups'),
      async (page) => page.getByRole('dialog').getByRole('spinbutton', { name: 'Days' }).fill('7'),
      async (page) => page.getByRole('dialog').getByText(/^\d+ backups? of /).waitFor(),
    ),
  },
  { name: 'mail-overview', what: 'Mail: the relay of each server', path: '/mail', theme: 'both' },
  { name: 'mail-setup', what: 'Mail → Setup guide', path: '/mail', theme: 'light', prepare: tab('Setup guide') },
  { name: 'mail-traffic', what: 'Mail → Traffic', path: '/mail', theme: 'light', prepare: tab('Traffic') },
  { name: 'jobs', what: 'Automations → All jobs: running, queued, failed and done', path: '/jobs', theme: 'both' },
  {
    name: 'job-detail',
    what: 'A job’s page with its log',
    path: '/jobs',
    theme: 'light',
    // The site created ten minutes ago: its id depends on how many jobs the demo seeds before it.
    prepare: async (page) => {
      const id = await page.evaluate(async () => {
        const res = await fetch('/api/jobs?limit=100', { headers: { 'x-csrf': '1' } });
        const body = (await res.json()) as { items: { id: number; type: string }[] };
        return body.items.find((j) => j.type === 'site.create')?.id;
      });
      if (!id) throw new Error('The demo has no site.create job');
      await page.goto(`/jobs/${id}`, { waitUntil: 'networkidle' });
    },
  },
  {
    name: 'job-console',
    what: 'The job console over a site’s page, following a running backup with its log open',
    path: '/sites/ridge-outfitters',
    theme: 'light',
    // The backup the demo has running on this site, shown as a job started in this tab. The tab's
    // own storage: nothing carries over to the other shots, which open pages of their own.
    prepare: async (page) => {
      const id = await page.evaluate(async () => {
        const res = await fetch('/api/jobs?limit=100&status=running', { headers: { 'x-csrf': '1' } });
        const body = (await res.json()) as { items: { id: number; type: string; siteSlug: string | null }[] };
        return body.items.find((j) => j.type === 'backup.create' && j.siteSlug === 'ridge-outfitters')?.id;
      });
      if (!id) throw new Error('The demo has no running backup.create job on ridge-outfitters');
      await page.evaluate(
        (job) => sessionStorage.setItem('wpl7-job-console-jobs', JSON.stringify({ jobs: [job], selected: job, view: 'log' })),
        id,
      );
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('region', { name: 'Job console' }).locator('[data-seq]').first().waitFor();
    },
  },
  { name: 'schedules', what: 'Automations → Schedules', path: '/jobs/schedules', theme: 'light' },
  {
    name: 'schedule-new',
    what: 'The dialog for a scheduled job of your own: a WP-CLI command',
    path: '/jobs/schedules',
    theme: 'light',
    prepare: steps(button('New schedule'), async (page) => {
      await page.getByLabel('What it does').selectOption({ label: 'WP-CLI command' });
      await page.getByLabel('Site', { exact: true }).selectOption('pixel-press');
      await page.getByLabel('WP-CLI arguments').fill('cache flush');
    }),
  },
  { name: 'api-keys', what: 'Integrations → API keys', path: '/api-keys', theme: 'light' },
  { name: 'api-docs', what: 'Integrations → API keys → Docs', path: '/api-keys', theme: 'both', prepare: tab('Docs') },
  { name: 'api-activity', what: 'Integrations → API keys → Activity', path: '/api-keys', theme: 'light', prepare: tab('Activity') },
  { name: 'mcp', what: 'Integrations → MCP: two connected apps and their recent calls', path: '/integrations/mcp', theme: 'both', hero: true, prepare: scrollTo('Connected apps') },
  { name: 'users', what: 'Users: the owner and two admins', path: '/users', theme: 'light' },
  { name: 'user-detail', what: 'An admin’s page, two-factor authentication on', path: '/users/2', theme: 'light' },
  { name: 'settings-sites', what: 'Settings → Sites', path: '/settings', theme: 'light' },
  { name: 'settings-backups', what: 'Settings → Backups', path: '/settings?tab=backups', theme: 'light' },
  { name: 'settings-security', what: 'Settings → Security', path: '/settings?tab=security', theme: 'light' },
  { name: 'settings-mail', what: 'Settings → Mail', path: '/settings?tab=mail', theme: 'light' },
  { name: 'settings-dns', what: 'Settings → DNS', path: '/settings?tab=dns', theme: 'light' },
  { name: 'settings-monitoring', what: 'Settings → Monitoring', path: '/settings?tab=monitoring', theme: 'light' },
  { name: 'settings-updates', what: 'Settings → Updates', path: '/settings?tab=updates', theme: 'light' },
  { name: 'login', what: 'The sign-in page', path: '/login', theme: 'both', signedOut: true },
  { name: 'about', what: 'The About page', path: '/about', theme: 'light' },
  { name: 'support', what: 'The Support page', path: '/support', theme: 'light' },
  { name: 'phone-sites', what: 'All sites on a phone', path: '/sites', theme: 'light', phone: true },
  { name: 'phone-site', what: 'A site on a phone', path: '/sites/northwind-bakery', theme: 'light', phone: true },
  { name: 'phone-jobs', what: 'All jobs on a phone', path: '/jobs', theme: 'light', phone: true },
];

/** The panel's accents (panel/web/src/styles.css). Blue is every shot's; the rest are marketing's. */
export const ACCENTS = ['blue', 'violet', 'rose', 'amber', 'graphite', 'yellow', 'green'] as const;
