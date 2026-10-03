import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from '../helpers.js';
import type { MetaDto } from '../../shared/types.js';

const PACKAGE_VERSION = (
  JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

describe('/api/meta', () => {
  it('reports the build, not a number hardcoded beside it', async () => {
    const { app } = await makeApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct-horse-battery' },
    });
    const c = login.cookies.find((x) => x.name === 'panel.sid')!;
    const res = await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie: `${c.name}=${c.value}` } });
    expect(res.statusCode).toBe(200);
    const meta = res.json() as MetaDto;
    // Nothing stamps the test run, so this is the package version - which is the point:
    // the sidebar cannot disagree with package.json without someone changing package.json.
    expect(meta.version).toBe(`${PACKAGE_VERSION}-dev`);
    expect(meta.gitSha).toBe('unknown');
  });
});

describe('build identity', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it('is whatever the image was stamped with', async () => {
    process.env.WPL7_VERSION = '0.3.0';
    process.env.WPL7_GIT_SHA = 'abc1234';
    vi.resetModules();

    const v = await import('../../src/lib/version.js');

    expect(v.PANEL_VERSION).toBe('0.3.0');
    expect(v.PANEL_GIT_SHA).toBe('abc1234');
  });

  it('falls back to the package version when there is no stamp', async () => {
    delete process.env.WPL7_VERSION;
    delete process.env.WPL7_GIT_SHA;
    vi.resetModules();

    const v = await import('../../src/lib/version.js');

    // The `-dev` suffix is load-bearing: update.sh refuses to overwrite an unstamped build
    // without --force, and semver puts a prerelease below the release it names.
    expect(v.PANEL_VERSION).toBe(`${PACKAGE_VERSION}-dev`);
    expect(v.PANEL_GIT_SHA).toBe('unknown');
  });
});
