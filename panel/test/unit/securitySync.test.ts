import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { securityNeverBlock, sites, type SiteRow } from '../../src/db/schema.js';
import { SecurityService } from '../../src/services/security.js';
import { ServerUnreachableError } from '../../src/servers/sshConnection.js';
import { makeWorld, type TestWorld } from '../helpers.js';

function addSite(w: TestWorld, slug: string, opts: { status?: string; serverId?: number; domains?: string[] } = {}): SiteRow {
  const now = Date.now();
  return w.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      serverId: opts.serverId ?? 1,
      domains: JSON.stringify(opts.domains ?? [`${slug}.dev.example.test`]),
      phpVersion: '8.3',
      status: opts.status ?? 'running',
      dbName: slug,
      dbUser: slug,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

const rulesDir = (root: string) => path.join(root, 'traefik', 'dynamic');
const rulesOf = (root: string, slug: string) => path.join(rulesDir(root), `sec-${slug}.yml`);
const inode = (file: string) => fs.statSync(file).ino;

async function sync(w: TestWorld, serverId = 1): Promise<void> {
  await w.core.security.kick(serverId);
}

describe('site protection on a server', () => {
  it('writes the rules of every running site, and none for a stopped one or one at Off', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const beta = addSite(w, 'beta');
    addSite(w, 'gamma', { status: 'stopped' });
    w.core.security.updateSite(beta, { level: 'off' }, 'alice');
    await sync(w);
    const root = w.config.srvRoot;
    expect(fs.readdirSync(rulesDir(root)).sort()).toEqual(['sec-alpha.yml']);
    const text = fs.readFileSync(rulesOf(root, 'alpha'), 'utf8');
    expect(text).toContain('wpl7sec_deny-files_alpha');
    expect(text).toContain('Host(`alpha.dev.example.test`)');
    // Plain HTTP in the test world (TLS_MODE=none).
    expect(text).toContain('"web"');
  });

  it("takes away the rules of sites gone from the server, and nothing it did not write", async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const dir = rulesDir(w.config.srvRoot);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['sec-gone.yml', 'move-alpha.yml', 'my-own.yml', 'sec-NOPE.yml']) fs.writeFileSync(path.join(dir, name), 'http: {}\n');
    await sync(w);
    expect(fs.readdirSync(dir).sort()).toEqual(['move-alpha.yml', 'my-own.yml', 'sec-NOPE.yml', 'sec-alpha.yml']);
  });

  it('rewrites a file only when what it says changes - across a panel restart too', async () => {
    const w = await makeWorld();
    const alpha = addSite(w, 'alpha');
    await sync(w);
    const file = rulesOf(w.config.srvRoot, 'alpha');
    const first = inode(file);

    await sync(w);
    expect(inode(file)).toBe(first);

    // A freshly started panel has no memory of what it wrote; it reads the file instead.
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const restarted = new SecurityService(w.db, w.config, w.servers, w.core.settings, w.core.proxyRanges, log, { debounceMs: 0 });
    await restarted.syncServer(1);
    expect(inode(file)).toBe(first);

    w.core.security.updateSite(alpha, { overrides: { rules: { files: false } } }, 'alice');
    await w.core.security.idle();
    expect(inode(file)).not.toBe(first);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('deny-files');
  });

  it('puts a file back that was deleted or edited by hand', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    await sync(w);
    const file = rulesOf(w.config.srvRoot, 'alpha');
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, 'http: {}\n');
    // Within the verify interval the cache is believed; past it the file is read back.
    const later = Date.now() + 11 * 60_000;
    vi.useFakeTimers({ now: later, toFake: ['Date'] });
    try {
      expect(w.core.security.tick(later).kicked).toBe(1);
      await w.core.security.idle();
    } finally {
      vi.useRealTimers();
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(good);
  });

  it('syncs once for a burst of changes', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const spy = vi.spyOn(w.core.security, 'syncServer');
    await Promise.all([sync(w), sync(w), sync(w)]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('follows the fleet default for every site that has none of its own', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    const pinned = addSite(w, 'beta');
    w.core.security.updateSite(pinned, { level: 'standard' }, 'alice');
    w.core.settings.set('securityLevel', 'off');
    await w.core.security.kickAll();
    expect(fs.readdirSync(rulesDir(w.config.srvRoot))).toEqual(['sec-beta.yml']);
  });

  it("gives the never-block list and the fleet's servers a pass", async () => {
    const w = await makeWorld();
    addSite(w, 'alpha');
    w.addSshServer('s2', { publicIp: '203.0.113.9' });
    w.db.insert(securityNeverBlock).values({ address: '192.0.2.0/24', createdAt: Date.now() }).run();
    await sync(w);
    const infra = fs
      .readFileSync(rulesOf(w.config.srvRoot, 'alpha'), 'utf8')
      .split('\n')
      .find((l) => l.includes('ClientIP(`192.0.2.0/24`)'));
    expect(infra).toContain('ClientIP(`203.0.113.9`)');
  });

  it('catches a server up once it answers again', async () => {
    const w = await makeWorld();
    const s2 = w.addSshServer('s2', { real: true });
    // As a start leaves it: the files its container mounts are there.
    await w.core.security.prepareHardening(w.servers.handleFor(s2.id), addSite(w, 'far', { serverId: s2.id }));
    const mkdirp = s2.files.mkdirp.bind(s2.files);
    s2.files.mkdirp = async () => {
      throw new ServerUnreachableError(s2.id, 's2', new Error('connect ETIMEDOUT'));
    };
    await sync(w, s2.id);
    expect(w.core.security.serverStatus(s2.id).state).toBe('unreachable');
    const far = w.db.select().from(sites).where(eq(sites.slug, 'far')).get()!;
    expect(w.core.security.siteStatus(far).unprotected).toMatch(/cannot reach/);

    s2.files.mkdirp = mkdirp;
    expect(w.core.security.tick().kicked).toBeGreaterThan(0);
    await w.core.security.idle();
    expect(fs.existsSync(rulesOf(s2.root!, 'far'))).toBe(true);
    expect(w.core.security.serverStatus(s2.id).state).toBe('ok');
    expect(w.core.security.siteStatus(far)).toMatchObject({ applied: true, unprotected: null });
  });

  it('keeps a file it cannot rewrite, and says so', async () => {
    const w = await makeWorld();
    const alpha = addSite(w, 'alpha');
    await sync(w);
    const file = rulesOf(w.config.srvRoot, 'alpha');
    const before = fs.readFileSync(file, 'utf8');
    // Nothing valid reaches the table; a row written by hand can.
    w.db.update(sites).set({ domains: JSON.stringify(['alpha.test`) || Host(`evil.test']) }).where(eq(sites.id, alpha.id)).run();
    await sync(w);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const fresh = w.db.select().from(sites).where(eq(sites.id, alpha.id)).get()!;
    expect(w.core.security.siteStatus(fresh).unprotected).toMatch(/could not be written/);
  });
});

describe("Traefik's own word", () => {
  it('keeps what Traefik said about a rule it could not use, until the file is rewritten', async () => {
    const w = await makeWorld();
    const alpha = addSite(w, 'alpha');
    await sync(w);
    const chunk = [
      '{"ClientAddr":"198.18.0.1:1","DownstreamStatus":200,"RouterName":"wpl7sec_main_alpha@file"}',
      '2026-09-29T14:12:03Z ERR error="error while adding rule PathRegexp: error parsing regexp: missing closing ]" entryPointName=websecure routerName=wpl7sec_block-x7_alpha@file',
      // A container being recreated is not a rule's fault.
      '2026-09-29T14:12:04Z ERR error="the service \\"wp-alpha@docker\\" does not exist" routerName=wpl7sec_main_alpha@file',
      '2026-09-29T14:12:05Z INF Configuration loaded from file: /etc/traefik/dynamic/sec-alpha.yml',
    ].join('\n');
    w.core.security.noteTraefikLog(chunk);
    expect(w.core.security.rejections('alpha')).toMatchObject([{ router: 'wpl7sec_block-x7_alpha' }]);

    w.core.security.updateSite(alpha, { overrides: { rules: { install: false } } }, 'alice');
    await w.core.security.idle();
    expect(w.core.security.rejections('alpha')).toEqual([]);
  });
});

describe('site jobs', () => {
  it('stop takes the rules away and start puts them back', async () => {
    const w = await makeWorld();
    const alpha = addSite(w, 'alpha');
    w.docker.containers.set('wp-alpha', 'running');
    await sync(w);
    const file = rulesOf(w.config.srvRoot, 'alpha');
    expect(fs.existsSync(file)).toBe(true);

    const run = async (action: 'stop' | 'start') => {
      const job = w.deps.sites.action(alpha.slug, action);
      w.worker.start();
      await vi.waitFor(() => {
        const s = w.db.select().from(sites).where(eq(sites.id, alpha.id)).get()!;
        expect(s.status).toBe(action === 'stop' ? 'stopped' : 'running');
      });
      await w.worker.stop();
      await w.core.security.idle();
      return job;
    };
    await run('stop');
    expect(fs.existsSync(file)).toBe(false);
    await run('start');
    expect(fs.existsSync(file)).toBe(true);
  });
});
