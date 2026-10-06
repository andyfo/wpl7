/**
 * Takes the docs' screenshots from the panel's demo world.
 *
 *   npm run shoot -- --out .screens-local                 every shot, for looking at
 *   npm run shoot -- --out .screens-local --only mcp,jobs
 *   npm run shoot                                         into screens/ (what CI commits)
 *   npm run shoot -- --marketing                          the hero set in every accent and theme
 *
 * It builds the panel's web app into a temporary folder (or takes --web-dist), starts the demo
 * world on a free port (panel/scripts/demo-world.ts: fictional data, no Docker, no network),
 * signs in once - the sign-in is limited to five a minute - and captures every shot in
 * scripts/shots.ts at 1440×900 CSS pixels at 2×. Both clocks stand at the demo's instant, so
 * relative times and chart axes never move. Local captures are for looking at only: fonts render
 * differently on macOS than on the Linux runner, whose captures are the ones committed.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { ACCENTS, SHOTS, type Shot } from './shots.ts';

/** panel/scripts/demo/clock.ts DEMO_NOW. */
const DEMO_NOW = Date.UTC(2026, 9, 5, 10, 0, 0);
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SIGN_IN = { username: 'admin', password: 'correct-horse-battery' };

const site = path.resolve(import.meta.dirname, '..');
const panel = path.resolve(site, '../../panel');

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(site, 'screens') },
    only: { type: 'string' },
    'web-dist': { type: 'string' },
    'demo-url': { type: 'string' },
    marketing: { type: 'boolean', default: false },
    phone: { type: 'boolean', default: false },
    optimize: { type: 'boolean', default: true },
  },
});

const outDir = path.resolve(values.out);
const only = values.only ? new Set(values.only.split(',').map((s) => s.trim())) : null;
for (const name of only ?? []) if (!SHOTS.some((s) => s.name === name)) throw new Error(`No shot named "${name}" in scripts/shots.ts`);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function buildWeb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-shoot-web-'));
  console.log('Building the panel web app…');
  execFileSync('npx', ['vite', 'build', '--config', 'web/vite.config.ts', '--outDir', dir, '--emptyOutDir', '--logLevel', 'warn'], { cwd: panel, stdio: 'inherit' });
  return dir;
}

async function startDemo(webDist: string): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  // Node itself rather than `npx tsx`, so that kill() reaches the demo: on Linux npx exits on
  // SIGTERM without passing it on, and the demo it leaves behind keeps this script waiting on
  // its stdout.
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo-world.ts', '--port', String(port), '--web-dist', webDist], { cwd: panel, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The demo did not start within 90 seconds')), 90_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('demo ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`The demo exited (${code}) before it was ready`)));
  });
  // localhost, not 127.0.0.1: the session cookie is Secure, which Chromium accepts there.
  return { url: `http://localhost:${port}`, child };
}

/** One documentation-range client address per page: the panel limits each address to 300 requests a minute. */
let addressSeq = 0;
const nextAddress = () => {
  addressSeq++;
  return addressSeq < 250 ? `192.0.2.${addressSeq + 1}` : `198.51.100.${(addressSeq % 250) + 1}`;
};

interface Variant {
  theme: 'light' | 'dark';
  accent: (typeof ACCENTS)[number];
  phone: boolean;
  signedOut: boolean;
}

async function newContext(browser: Browser, baseURL: string, v: Variant, storageState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined) {
  const ctx = await browser.newContext({
    baseURL,
    viewport: v.phone ? PHONE : DESKTOP,
    deviceScaleFactor: 2,
    isMobile: v.phone,
    hasTouch: v.phone,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: v.theme,
    reducedMotion: 'reduce',
    // The demo runs behind no proxy; this makes the panel treat the requests as HTTPS, as on a
    // real install, so its Secure session cookie is set.
    extraHTTPHeaders: { 'x-forwarded-proto': 'https' },
    ...(v.signedOut || !storageState ? {} : { storageState }),
  });
  await ctx.addInitScript(
    ([theme, accent]) => {
      try {
        localStorage.setItem('wpl7-theme', theme);
        localStorage.setItem('wpl7-accent', accent);
      } catch {
        /* storage unavailable: the panel falls back to its defaults */
      }
    },
    [v.theme, v.accent] as const,
  );
  return ctx;
}

async function capture(ctx: BrowserContext, shot: Shot, file: string): Promise<void> {
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-for': nextAddress() });
  await page.clock.setFixedTime(DEMO_NOW);
  await page.goto(shot.path, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*, *::before, *::after { cursor: none !important; caret-color: transparent !important; }' });
  await page.evaluate(() => window.scrollTo(0, 0));
  if (shot.prepare) await shot.prepare(page);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  // Charts and lists settle a frame after their data arrives.
  await page.waitForTimeout(400);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', scale: 'device' });
  await page.close();
}

function optimize(files: string[]): void {
  if (!values.optimize || files.length === 0) return;
  try {
    execFileSync('oxipng', ['--version'], { stdio: 'ignore' });
  } catch {
    console.warn('oxipng is not installed: the PNGs are left as Chromium wrote them (CI optimizes them).');
    return;
  }
  execFileSync('oxipng', ['-o', '4', '--strip', 'all', '--quiet', ...files], { stdio: 'inherit' });
}

async function main(): Promise<void> {
  const demo = values['demo-url'] ? { url: values['demo-url'], child: null } : await startDemo(values['web-dist'] ? path.resolve(values['web-dist']) : buildWeb());
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    // Sign in once; every other context reuses the session.
    const login = await newContext(browser, demo.url, { theme: 'light', accent: 'blue', phone: false, signedOut: true }, undefined);
    const page = await login.newPage();
    await page.setExtraHTTPHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.10' });
    await page.goto('/login');
    await page.locator('input:not([type="password"])').first().fill(SIGN_IN.username);
    await page.locator('input[type="password"]').fill(SIGN_IN.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
    const storageState = await login.storageState();
    await login.close();

    const contexts = new Map<string, BrowserContext>();
    const contextFor = async (v: Variant) => {
      const key = JSON.stringify(v);
      if (!contexts.has(key)) contexts.set(key, await newContext(browser, demo.url, v, storageState));
      return contexts.get(key)!;
    };

    const jobs: { shot: Shot; v: Variant; file: string }[] = [];
    for (const shot of SHOTS) {
      if (only && !only.has(shot.name)) continue;
      if (values.phone && !shot.phone) continue;
      const themes = shot.theme === 'both' ? (['light', 'dark'] as const) : (['light'] as const);
      if (!values.marketing) {
        for (const theme of themes) {
          jobs.push({ shot, v: { theme, accent: 'blue', phone: !!shot.phone, signedOut: !!shot.signedOut }, file: path.join(outDir, `${shot.name}-${theme}.png`) });
        }
      }
      // Every accent but blue once, on the Dashboard; with --marketing the whole hero set in every accent and theme.
      if (shot.hero && (values.marketing || shot.name === 'overview')) {
        for (const accent of ACCENTS) {
          if (!values.marketing && accent === 'blue') continue;
          for (const theme of values.marketing ? (['light', 'dark'] as const) : (['light'] as const)) {
            jobs.push({ shot, v: { theme, accent, phone: false, signedOut: false }, file: path.join(outDir, 'marketing', `${shot.name}-${accent}-${theme}.png`) });
          }
        }
      }
    }
    for (const job of jobs) {
      process.stdout.write(`${path.relative(site, job.file)}\n`);
      await capture(await contextFor(job.v), job.shot, job.file);
      written.push(job.file);
    }
  } finally {
    await browser.close();
    demo.child?.kill();
  }
  optimize(written);
  console.log(`${written.length} screenshot(s) written to ${path.relative(process.cwd(), outDir) || '.'}`);
}

await main();
