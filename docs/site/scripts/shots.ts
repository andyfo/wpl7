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

const steps =
  (...fns: ((page: Page) => Promise<void>)[]) =>
  async (page: Page) => {
    for (const fn of fns) {
      await fn(page);
      await page.waitForLoadState('networkidle');
    }
  };

export const SHOTS: Shot[] = [
  { name: 'overview', what: 'The Dashboard: the fleet at a glance', path: '/', theme: 'both', hero: true },
  { name: 'sites-list', what: 'Sites → All sites: eleven sites on three servers, and two hosted elsewhere', path: '/sites', theme: 'both', hero: true },
  {
    name: 'site-new',
    what: 'The New site wizard, its first step filled in',
    path: '/sites/new',
    theme: 'light',
    prepare: async (page) => {
      await page.getByLabel('Site title').fill('Willow Pediatrics');
    },
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
