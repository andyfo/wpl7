import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DnsResolver } from '../../src/services/mailDns.js';
import type { MetaDto, SystemAboutDto } from '../../shared/types.js';
import { servers } from '../../src/db/schema.js';
import { makeApp, makeTestConfig, makeWorld } from '../helpers.js';

const nx = (): Error => Object.assign(new Error('queryPtr ENOTFOUND'), { code: 'ENOTFOUND' });

/** A resolver that only ever answers PTR, which is all this endpoint asks it. */
function resolverFor(ptr: Record<string, string[]> = {}): DnsResolver {
  return {
    async resolveTxt() {
      throw nx();
    },
    async resolve4() {
      throw nx();
    },
    async resolveMx() {
      throw nx();
    },
    async reverse(ip) {
      const names = ptr[ip];
      if (!names) throw nx();
      return names;
    },
  };
}

async function aboutWorld(opts: { publicIp?: string; repo?: string; resolver?: DnsResolver } = {}) {
  const world = await makeWorld({
    config: makeTestConfig(opts.repo ? { WPL7_REPO: opts.repo } : {}),
    resolver: opts.resolver ?? resolverFor(),
  });
  if (opts.publicIp) {
    world.db.update(servers).set({ publicIp: opts.publicIp }).where(eq(servers.id, 1)).run();
  }
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, world, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

describe('GET /api/system/about', () => {
  it('says where this install came from, what it answers on, and what DNS calls it', async () => {
    const { app, headers } = await aboutWorld({
      publicIp: '203.0.113.9',
      resolver: resolverFor({ '203.0.113.9': ['web-01.example.test'] }),
    });

    const res = await app.inject({ method: 'GET', url: '/api/system/about', headers });
    expect(res.statusCode).toBe(200);
    const about = res.json<SystemAboutDto>();
    expect(about.repoUrl).toBe('https://github.com/andyfo/wpl7');
    expect(about.publicIp).toBe('203.0.113.9');
    expect(about.reverseDns).toBe('web-01.example.test');
    expect(about.panelDomain).toBe('panel.example.test');
    expect(about.host.serverId).toBe(1);
    expect(about.node).toBe(process.version);
    expect(about.panelUptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  /**
   * A PTR is unset on most hosts, and only mail minds - so it is an ordinary null here
   * rather than an error, and the page shows nothing where a name would be.
   */
  it('answers with a null name when the address has no PTR, not an error', async () => {
    const { app, headers } = await aboutWorld({ publicIp: '198.51.100.7' });

    const res = await app.inject({ method: 'GET', url: '/api/system/about', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json<SystemAboutDto>()).toMatchObject({ publicIp: '198.51.100.7', reverseDns: null });
  });

  it('asks nothing of DNS when no address has ever been established', async () => {
    let asked = 0;
    const resolver = resolverFor();
    const counting: DnsResolver = {
      ...resolver,
      reverse: (ip) => {
        asked++;
        return resolver.reverse(ip);
      },
    };
    const { app, headers } = await aboutWorld({ resolver: counting });

    const res = await app.inject({ method: 'GET', url: '/api/system/about', headers });
    expect(res.json<SystemAboutDto>().publicIp).toBeNull();
    expect(res.json<SystemAboutDto>().reverseDns).toBeNull();
    expect(asked).toBe(0);
  });

  /** A fork follows its own repository, so every link on the About page has to follow it too. */
  it('points at the repository this install actually follows', async () => {
    const { app, headers } = await aboutWorld({ repo: 'someone/their-fork' });

    const res = await app.inject({ method: 'GET', url: '/api/system/about', headers });
    expect(res.json<SystemAboutDto>().repoUrl).toBe('https://github.com/someone/their-fork');
  });

  /**
   * The Support page takes the same two links from /api/meta, which never asks the host - so
   * they have to be the same two links, fork and all.
   */
  it('hands /api/meta the same links, for the Support page', async () => {
    const { app, headers } = await aboutWorld({ repo: 'someone/their-fork' });

    const about = (await app.inject({ method: 'GET', url: '/api/system/about', headers })).json<SystemAboutDto>();
    const meta = (await app.inject({ method: 'GET', url: '/api/meta', headers })).json<MetaDto>();
    expect(meta.repoUrl).toBe('https://github.com/someone/their-fork');
    expect(meta).toMatchObject({ repoUrl: about.repoUrl, communityUrl: about.communityUrl });
  });

  it('is not readable without a session', async () => {
    const { app } = await aboutWorld();
    const res = await app.inject({ method: 'GET', url: '/api/system/about' });
    expect(res.statusCode).toBe(401);
  });

  /** One PTR lookup per address, however many times the page is opened. */
  it('caches the reverse lookup rather than asking on every page view', async () => {
    let asked = 0;
    const counting: DnsResolver = {
      ...resolverFor(),
      reverse: async (ip) => {
        asked++;
        return [`host-${ip.replaceAll('.', '-')}.example.test`];
      },
    };
    const { app, headers } = await aboutWorld({ publicIp: '203.0.113.9', resolver: counting });

    await app.inject({ method: 'GET', url: '/api/system/about', headers });
    await app.inject({ method: 'GET', url: '/api/system/about', headers });
    expect(asked).toBe(1);
  });
});
