/**
 * The demo world's data sheet (docs/internal/docs-site-plan.md, Appendix C). Every name,
 * domain and address here is fictional: customer domains are under the reserved `.example`
 * TLD, the panel and dev domains are example.com names, and the servers' addresses come from
 * 203.0.113.0/24, a range reserved for documentation. Nothing may point at a real installation.
 */

export const PANEL_DOMAIN = 'panel.example.com';
export const DEV_DOMAIN = 'dev.example.com';
export const ADMIN_USER = 'admin';
export const ADMIN_PASSWORD = 'correct-horse-battery';
export const ADMIN_EMAIL = 'ops@northwind-agency.example';

export interface DemoServer {
  id: number;
  name: string;
  ip: string;
  /** os-release PRETTY_NAME, CPUs and memory, as the server's facts card shows them. */
  cpus: number;
  memGb: number;
  diskGb: number;
}

export const SERVERS: DemoServer[] = [
  { id: 1, name: 'fra1', ip: '203.0.113.10', cpus: 4, memGb: 8, diskGb: 160 },
  { id: 2, name: 'nyc1', ip: '203.0.113.20', cpus: 4, memGb: 8, diskGb: 160 },
  { id: 3, name: 'sin1', ip: '203.0.113.30', cpus: 2, memGb: 4, diskGb: 80 },
];

export type DemoSiteState = 'live' | 'dev' | 'stopped';

export interface DemoSite {
  slug: string;
  title: string;
  /** The customer domain of a live site; null for a dev-only site. */
  domain: string | null;
  php: string;
  server: number;
  state: DemoSiteState;
  /** Days since it was created. */
  ageDays: number;
  diskMb: number;
  /** Visitors over the last 24 hours, roughly; drives the traffic seed. */
  dailyVisitors: number;
}

export const SITES: DemoSite[] = [
  { slug: 'northwind-bakery', title: 'Northwind Bakery', domain: 'northwindbakery.example', php: '8.4', server: 1, state: 'live', ageDays: 214, diskMb: 1840, dailyVisitors: 612 },
  { slug: 'alpine-dental', title: 'Alpine Dental Clinic', domain: 'alpinedental.example', php: '8.3', server: 1, state: 'live', ageDays: 180, diskMb: 960, dailyVisitors: 238 },
  { slug: 'harbor-yoga', title: 'Harbor Yoga Studio', domain: 'harboryoga.example', php: '8.4', server: 2, state: 'live', ageDays: 151, diskMb: 1320, dailyVisitors: 341 },
  { slug: 'cedar-stone', title: 'Cedar & Stone Architects', domain: 'cedarstone.example', php: '8.3', server: 2, state: 'live', ageDays: 133, diskMb: 2410, dailyVisitors: 97 },
  { slug: 'blue-fern', title: 'Blue Fern Florist', domain: 'bluefern.example', php: '8.2', server: 1, state: 'live', ageDays: 120, diskMb: 780, dailyVisitors: 184 },
  { slug: 'pixel-press', title: 'Pixel Press Magazine', domain: 'pixelpress.example', php: '8.5', server: 3, state: 'live', ageDays: 98, diskMb: 6230, dailyVisitors: 2875 },
  { slug: 'ridge-outfitters', title: 'Ridge Outfitters', domain: 'ridgeoutfitters.example', php: '8.4', server: 3, state: 'live', ageDays: 87, diskMb: 18420, dailyVisitors: 1290 },
  { slug: 'lumen-law', title: 'Lumen Law Partners', domain: 'lumenlaw.example', php: '8.3', server: 1, state: 'live', ageDays: 64, diskMb: 1150, dailyVisitors: 156 },
  { slug: 'summit-coffee', title: 'Summit Coffee Roasters', domain: null, php: '8.4', server: 2, state: 'dev', ageDays: 9, diskMb: 410, dailyVisitors: 6 },
  { slug: 'oak-and-ivy', title: 'Oak & Ivy Interiors', domain: null, php: '8.4', server: 1, state: 'dev', ageDays: 0, diskMb: 236, dailyVisitors: 0 },
  { slug: 'tidewater-realty', title: 'Tidewater Realty', domain: 'tidewaterrealty.example', php: '8.2', server: 2, state: 'stopped', ageDays: 302, diskMb: 1630, dailyVisitors: 0 },
];

/** The old site an import is connected to, waiting on its Confirm step (imports.ts). */
export const IMPORT_SOURCE = 'https://willow-pediatrics.example';

export interface DemoExternalSite {
  slug: string;
  title: string;
  home: string;
  php: string;
  /** Days since it was added. */
  ageDays: number;
  /** The server that keeps its backups. */
  storage: number;
  /** Whether WPL7 Connect answered the panel's last check. */
  reachable: boolean;
}

/** Sites hosted elsewhere, managed through WPL7 Connect (external.ts). */
export const EXTERNAL_SITES: DemoExternalSite[] = [
  { slug: 'meadow-vet', title: 'Meadow Vet Clinic', home: 'https://meadowvet.example', php: '8.3', ageDays: 41, storage: 1, reachable: true },
  { slug: 'granite-gym', title: 'Granite Gym', home: 'https://granitegym.example', php: '8.2', ageDays: 23, storage: 1, reachable: false },
];

/** A site hosted elsewhere whose plugin has just connected, waiting on its Confirm step (external.ts). */
export const CONNECT_SOURCE = 'https://riverside-books.example';

/** The site that was deleted: only its backups remain, on sin1. */
export const DELETED_SITE = { slug: 'old-portfolio', server: 3 };

export const PEOPLE = [
  { username: ADMIN_USER, owner: true, twoFactor: false, email: ADMIN_EMAIL },
  { username: 'sam', owner: false, twoFactor: true, email: 'sam@northwind-agency.example' },
  { username: 'priya', owner: false, twoFactor: false, email: 'priya@northwind-agency.example' },
];

export const devHostname = (slug: string): string => `${slug}.${DEV_DOMAIN}`;

/** The domains a site answers on, primary first, as the panel stores them. */
export function siteDomains(site: DemoSite): string[] {
  if (!site.domain) return [devHostname(site.slug)];
  return [site.domain, `www.${site.domain}`, devHostname(site.slug)];
}

/**
 * A small deterministic random number generator (mulberry32), so traffic curves and sample
 * timings look organic and are the same on every run.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed for a string (FNV-1a). */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
