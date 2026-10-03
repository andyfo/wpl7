import { describe, expect, it } from 'vitest';
import { createTestDb, FakeGitHub, makeApp, makeTestConfig, makeWorld } from '../helpers.js';
import { SettingsService } from '../../src/services/settings.js';
import { compareVersions, isBehind, UpdateService, type UpdateManifest } from '../../src/services/updates.js';
import type { MetaDto, SystemVersionDto } from '../../shared/types.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const manifest = (over: Partial<UpdateManifest> = {}): Record<string, unknown> => ({
  version: '0.3.0',
  channel: 'stable',
  publishedAt: '2026-10-01T12:00:00Z',
  notesUrl: 'https://example.test/releases/v0.3.0',
  gitSha: 'a'.repeat(40),
  images: { panel: 'ghcr.io/x/y/panel:0.3.0', wordpress: { '8.3': 'ghcr.io/x/y/wordpress:php8.3-0.3.0' } },
  minUpgradeFrom: '0.2.0',
  requiresDowntime: false,
  ...over,
});

function service(github: FakeGitHub, env: Record<string, string> = {}) {
  const settings = new SettingsService(createTestDb());
  const config = makeTestConfig(env);
  return { svc: new UpdateService(settings, config, silentLog, github.fetch), settings };
}

describe('version precedence', () => {
  it('orders releases, prereleases and nonsense the way semver says', () => {
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    // A prerelease is older than the release it names - which is what makes an edge build
    // of 0.3.0 sort below 0.3.0 and above 0.2.9.
    expect(compareVersions('0.3.0-edge.abc1234', '0.3.0')).toBe(-1);
    expect(compareVersions('0.3.0-edge.abc1234', '0.2.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1); // numeric, not lexical
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1); // fewer identifiers wins
    // `dev` is what build.sh stamps on a hand-built panel. It is not a release, and the
    // honest answer is that a release is newer.
    expect(compareVersions('dev', '0.0.1')).toBe(-1);
  });
});

describe('is this install behind', () => {
  it('compares by commit on edge, because the version strings cannot say', () => {
    const edge = { channel: 'edge', version: '0.3.0-edge.bbbbbbb', gitSha: 'b'.repeat(40) } as UpdateManifest;
    // Same build: two edge versions differ only in trailing identifiers that semver
    // compares as strings, so the sha is the only thing that means anything here.
    expect(isBehind('0.3.0-edge.bbbbbbb', 'b'.repeat(40), edge)).toBe(false);
    expect(isBehind('0.3.0-edge.aaaaaaa', 'a'.repeat(40), edge)).toBe(true);
    // A local build stamps a short sha; CI stamps the full one.
    expect(isBehind('0.3.0-source', 'bbbbbbb', edge)).toBe(false);
  });

  it('compares by version on stable', () => {
    const stable = { channel: 'stable', version: '0.3.0', gitSha: 'c'.repeat(40) } as UpdateManifest;
    expect(isBehind('0.2.0', 'whatever', stable)).toBe(true);
    expect(isBehind('0.3.0', 'whatever', stable)).toBe(false);
    expect(isBehind('0.4.0', 'whatever', stable)).toBe(false);
    // An unstamped local build is behind every release, which is the useful answer.
    expect(isBehind('dev', 'unknown', stable)).toBe(true);
  });
});

describe('the check', () => {
  it('reads the newest non-prerelease on stable and caches it', async () => {
    const github = new FakeGitHub().release(manifest(), { etag: 'W/"v1"' });
    const { svc } = service(github);

    const status = await svc.check();

    expect(status.latest?.version).toBe('0.3.0');
    expect(status.updateAvailable).toBe(true);
    expect(status.error).toBeNull();
    expect(status.checkedAt).not.toBeNull();
    // The asset URL, not browser_download_url: that one 404s on a private repository.
    expect(github.requests.at(-1)!.url).toContain('/releases/assets/');
    expect(github.requests.at(-1)!.headers.accept).toBe('application/octet-stream');
  });

  it('skips drafts and prereleases - `edge` is both, deliberately', async () => {
    const github = new FakeGitHub().on('/releases?per_page', {
      status: 200,
      body: [
        { draft: false, prerelease: true, assets: [{ name: 'manifest.json', url: 'https://x/edge' }] },
        { draft: true, prerelease: false, assets: [{ name: 'manifest.json', url: 'https://x/draft' }] },
        { draft: false, prerelease: false, assets: [{ name: 'manifest.json', url: 'https://api.github.com/x/releases/assets/9' }] },
      ],
    });
    github.on('/releases/assets/', { status: 200, body: manifest({ version: '0.4.0' }) });
    const { svc } = service(github);

    expect((await svc.check()).latest?.version).toBe('0.4.0');
  });

  it('asks for the `edge` tag when that is the channel', async () => {
    const github = new FakeGitHub().release(manifest({ channel: 'edge', version: '0.3.0-edge.abc1234' }));
    const { svc } = service(github, { WPL7_CHANNEL: 'edge' });

    const status = await svc.check();

    expect(status.channel).toBe('edge');
    expect(status.latest?.version).toBe('0.3.0-edge.abc1234');
    expect(github.requests[0]!.url).toContain('/releases/tags/edge');
  });

  it('sends If-None-Match once it has something, and keeps the cache on 304', async () => {
    const github = new FakeGitHub().release(manifest(), { etag: 'W/"v1"' });
    const { svc } = service(github);
    await svc.check();
    const before = svc.status().checkedAt!;

    github.routes = [{ match: '/releases?per_page', response: { status: 304 } }];
    await new Promise((r) => setTimeout(r, 2));
    const status = await svc.check();

    expect(github.requests.at(-1)!.headers['if-none-match']).toBe('W/"v1"');
    expect(status.latest?.version).toBe('0.3.0'); // still known
    expect(status.error).toBeNull();
    // A 304 is a successful check - it just says the answer has not changed.
    expect(status.checkedAt!).toBeGreaterThan(before);
  });

  it('says it could not check rather than that there is nothing new', async () => {
    const github = new FakeGitHub().on('/releases?per_page', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) },
      body: { message: 'API rate limit exceeded' },
    });
    const { svc, settings } = service(github);

    const status = await svc.check();

    expect(status.error).toContain('rate limit');
    expect(status.updateAvailable).toBe(false);
    expect(status.checkedAt).toBeNull();
    // And it backs off rather than spending the next 60 ticks discovering the same thing.
    const before = github.requests.length;
    await svc.tick();
    expect(github.requests).toHaveLength(before);
    expect((settings.getRaw('updates.latest') as { retryAfter: number }).retryAfter).toBeGreaterThan(Date.now());
  });

  it('announces a new release once, not on every tick', async () => {
    const github = new FakeGitHub().release(manifest());
    const { svc, settings } = service(github);
    const seen: string[] = [];
    svc.onNewRelease = (release) => seen.push(release.version);

    await svc.check();
    await svc.check();
    expect(seen).toEqual(['0.3.0']);

    // A newer one is worth another email; the same one never is.
    github.release(manifest({ version: '0.4.0' }));
    settings.setRaw('updates.latest', { ...(settings.getRaw('updates.latest') as object), etag: null });
    await svc.check();
    expect(seen).toEqual(['0.3.0', '0.4.0']);
  });

  it('refuses a release whose manifest is not a manifest', async () => {
    const github = new FakeGitHub().release({ version: '0.3.0' }); // no images
    const { svc } = service(github);

    const status = await svc.check();

    expect(status.error).toContain('expected shape');
    expect(status.latest).toBeNull();
  });
});

describe('scheduling', () => {
  it('picks a minute of the hour once and remembers it', () => {
    const { svc, settings } = service(new FakeGitHub());
    const first = svc.minuteOffset();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(60);
    expect(svc.minuteOffset()).toBe(first);
    expect(settings.getRaw('updates.minuteOffset')).toBe(first);
  });

  it('checks immediately the first time, then only on its own minute', async () => {
    const github = new FakeGitHub().release(manifest());
    const { svc, settings } = service(github);

    await svc.tick(new Date(2026, 0, 1, 12, 37));
    expect(github.requests.length).toBeGreaterThan(0);

    // Freshly checked: not due again for an hour, whatever minute it is.
    const before = github.requests.length;
    await svc.tick(new Date(2026, 0, 1, 13, svc.minuteOffset()));
    expect(github.requests).toHaveLength(before);

    // Due again, but on somebody else's minute.
    const cache = settings.getRaw('updates.latest') as Record<string, unknown>;
    settings.setRaw('updates.latest', { ...cache, checkedAt: Date.now() - 2 * 60 * 60_000 });
    const wrongMinute = (svc.minuteOffset() + 1) % 60;
    await svc.tick(new Date(2026, 0, 1, 14, wrongMinute));
    expect(github.requests).toHaveLength(before);

    await svc.tick(new Date(2026, 0, 1, 14, svc.minuteOffset()));
    expect(github.requests.length).toBeGreaterThan(before);
  });
});

describe('the API', () => {
  it('serves the cached answer and never blocks a page view on GitHub', async () => {
    const world = await makeWorld();
    world.github.release(manifest());
    const { app } = await makeApp(world);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };

    const before = (await app.inject({ method: 'GET', url: '/api/system/version', headers })).json() as SystemVersionDto;
    expect(before.latest).toBeNull();
    expect(world.github.requests).toHaveLength(0); // reading the page asked nobody

    const checked = await app.inject({ method: 'POST', url: '/api/system/update/check', headers });
    expect((checked.json() as SystemVersionDto).latest?.version).toBe('0.3.0');

    const meta = (await app.inject({ method: 'GET', url: '/api/meta', headers })).json() as MetaDto;
    expect(meta.updateAvailable).toBe(true);
    expect(meta.channel).toBe('stable');
  });
});
