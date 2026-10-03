/**
 * The Security API: a site's protection, its scans, findings and quarantine; the fleet's
 * overview; blocked addresses and the never-block list - and who may do which.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, pluginZipChecks, plugins, sitePanelFiles, siteScanFindings, sites } from '../../src/db/schema.js';
import { MU_PLUGIN_PATH, MU_PLUGIN_SOURCE } from '../../src/services/adminLogin.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import type { AccessLevel } from '../../shared/access.js';
import type {
  FindingDto,
  QuarantineItemDto,
  SecurityBlockDto,
  SecurityBlockListDto,
  SecurityCheckDto,
  SecurityOverviewDto,
  SiteScanDto,
  SiteSecurityDto,
} from '../../shared/types.js';
import { makeApp, makeWorld } from '../helpers.js';

async function signedIn() {
  const world = await makeWorld();
  const { app } = await makeApp(world);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  const keyOf = async (access: AccessLevel) => {
    const res = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: `key-${access}`, access } });
    return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
  };
  const addSite = (slug: string) => {
    const now = Date.now();
    fs.mkdirSync(sitePaths(world.config, slug).wordpress, { recursive: true });
    world.docker.containers.set(`wp-${slug}`, 'running');
    return world.db
      .insert(sites)
      .values({
        slug,
        title: slug,
        domains: JSON.stringify([`${slug}.test`]),
        phpVersion: '8.3',
        status: 'running',
        dbName: slug,
        dbUser: slug,
        dbPassword: 'x',
        containerName: `wp-${slug}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  };
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, as: Record<string, string> = headers) =>
    app.inject({ method, url, headers: as, ...(payload ? { payload } : {}) });
  return { app, world, headers, keyOf, addSite, call };
}

function addFinding(world: Awaited<ReturnType<typeof signedIn>>['world'], siteId: number, values: Partial<typeof siteScanFindings.$inferInsert>) {
  const now = Date.now();
  return world.db
    .insert(siteScanFindings)
    .values({
      siteId,
      fingerprint: `fp-${Math.random()}`,
      engine: 'check',
      kind: 'upload-php',
      confidence: 'suspicious',
      severity: 'high',
      path: 'wp-content/uploads/x.php',
      sha256: 'e'.repeat(64),
      firstSeenAt: now,
      lastSeenAt: now,
      status: 'open',
      ...values,
    })
    .returning()
    .get();
}

describe("a site's protection", () => {
  it('follows the default until changed, and writes what is changed to its server', async () => {
    const { world, addSite, call } = await signedIn();
    addSite('alpha');
    const before = (await call('GET', '/api/sites/alpha/security')).json() as SiteSecurityDto;
    expect(before).toMatchObject({ slug: 'alpha', level: null, policy: { level: 'standard', levelFrom: 'fleet' }, customRules: [] });

    const res = await call('PUT', '/api/sites/alpha/security', {
      level: 'strict',
      overrides: { rules: { enum: false } },
      customRules: [{ action: 'block', match: 'all', conditions: [{ field: 'path', op: 'startsWith', value: '/secret' }] }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json() as SiteSecurityDto;
    expect(after).toMatchObject({ level: 'strict', policy: { level: 'strict', levelFrom: 'site', rules: { enum: false } } });
    expect(after.customRules[0]!.id).toMatch(/^[a-z0-9]{1,12}$/);
    await world.core.security.idle();
    const file = fs.readFileSync(path.join(world.config.srvRoot, 'traefik', 'dynamic', 'sec-alpha.yml'), 'utf8');
    expect(file).toContain(`wpl7sec_block-${after.customRules[0]!.id}_alpha`);

    // Back to the default; the rules it was given stay its own.
    const back = (await call('PUT', '/api/sites/alpha/security', { level: null })).json() as SiteSecurityDto;
    expect(back).toMatchObject({ level: null, policy: { level: 'standard' } });
    expect(back.customRules).toHaveLength(1);
  });

  it('refuses what is not a policy', async () => {
    const { addSite, call } = await signedIn();
    addSite('alpha');
    expect((await call('PUT', '/api/sites/alpha/security', { level: 'paranoid' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/sites/alpha/security', { overrides: { rules: { nonsense: true } } })).statusCode).toBe(400);
    expect((await call('PUT', '/api/sites/alpha/security', { extra: 1 })).statusCode).toBe(400);
    expect((await call('GET', '/api/sites/nope/security')).statusCode).toBe(404);
  });

  it('lists every site on the overview, and what was blocked', async () => {
    const { addSite, call } = await signedIn();
    addSite('alpha');
    addSite('beta');
    addSite('gamma');
    await call('PUT', '/api/sites/beta/security', {
      level: 'off',
      overrides: { rules: { enum: false }, xmlrpc: 'allow', limits: { login: null } },
      customRules: [{ action: 'block', match: 'all', conditions: [{ field: 'path', op: 'startsWith', value: '/secret' }] }],
    });
    // Its own scan settings alone are not "customised" protection, but they are its own.
    await call('PUT', '/api/sites/gamma/security/scan/settings', { enabled: false, onFinding: 'quarantine-confirmed' });
    const overview = (await call('GET', '/api/security/overview')).json() as SecurityOverviewDto;
    expect(overview.fleetPolicy.level).toBe('standard');
    expect(overview.sites.map((s) => [s.slug, s.level, s.customised])).toEqual([
      ['alpha', 'standard', false],
      ['beta', 'off', true],
      ['gamma', 'standard', false],
    ]);
    expect(overview.sites.map((s) => s.own)).toEqual([
      { level: null, changes: 0, customRules: 0, scanEnabled: null, scanOnFinding: null },
      { level: 'off', changes: 3, customRules: 1, scanEnabled: null, scanOnFinding: null },
      { level: null, changes: 0, customRules: 0, scanEnabled: false, scanOnFinding: 'quarantine-confirmed' },
    ]);
    expect(overview.servers[0]).toMatchObject({ serverId: 1 });
    const blocked = (await call('GET', '/api/sites/alpha/security/blocked')).json();
    expect(blocked).toEqual({ items: [], counts7d: {} });
    expect((await call('POST', '/api/security/sync')).statusCode).toBe(200);
  });

  it('keeps "security" free for the page: no site may be called that', async () => {
    const { call } = await signedIn();
    const res = await call('POST', '/api/sites', { title: 'Security', slug: 'security', domainMode: 'dev', adminUser: 'boss', adminEmail: 'boss@example.com' });
    expect(res.statusCode).toBe(400);
  });
});

describe("a site's scans", () => {
  it('queues one scan per site at a time, in its server scan lane', async () => {
    const { world, addSite, call } = await signedIn();
    addSite('alpha');
    const first = await call('POST', '/api/sites/alpha/security/scan');
    expect(first.statusCode).toBe(202);
    const again = await call('POST', '/api/sites/alpha/security/scan');
    expect(again.json().job.id).toBe(first.json().job.id);
    const job = world.db.select().from(jobs).where(eq(jobs.id, first.json().job.id)).get()!;
    expect(job).toMatchObject({ type: 'site.malwareScan', lane: 'scan:1', siteId: null, siteSlug: 'alpha' });
    const view = (await call('GET', '/api/sites/alpha/security/scan')).json() as { scan: SiteScanDto; history: unknown[] };
    expect(view.scan.active).toEqual({ jobId: job.id, status: 'queued' });
    expect(view.history).toEqual([]);
  });

  it('takes a site out of scanning, and "scan all" leaves it out', async () => {
    const { world, addSite, call } = await signedIn();
    addSite('alpha');
    addSite('beta');
    const res = await call('PUT', '/api/sites/beta/security/scan/settings', { enabled: false, onFinding: 'quarantine-all' });
    expect(res.json()).toMatchObject({
      enabled: false,
      onFinding: 'quarantine-all',
      effective: { enabled: false, onFinding: 'quarantine-all' },
      // What "follow the default" would give it, whatever it says itself.
      defaults: { enabled: true, onFinding: 'report' },
      nextDueAt: null,
    });
    expect((await call('POST', '/api/security/scans', {})).json()).toEqual({ queued: ['alpha'], already: [] });
    expect((await call('POST', '/api/security/scans', { slugs: ['alpha', 'beta'] })).json()).toEqual({ queued: ['beta'], already: ['alpha'] });
    expect(world.db.select().from(jobs).where(eq(jobs.type, 'site.malwareScan')).all()).toHaveLength(2);
    const fleet = (await call('GET', '/api/security/scans')).json() as { items: { slug: string }[]; inFlight: number };
    expect(fleet.items.map((i) => i.slug)).toEqual(['alpha', 'beta']);
    expect(fleet.inFlight).toBe(2);
  });

  it('ignores, takes back and resolves findings, and says what can be done with each', async () => {
    const { world, addSite, call } = await signedIn();
    const site = addSite('alpha');
    const upload = addFinding(world, site.id, {});
    const changed = addFinding(world, site.id, { kind: 'core-modified', path: 'wp-includes/functions.php', package: 'core', packageVersion: '6.9' });
    const config = addFinding(world, site.id, { engine: 'signatures', kind: 'signature', confidence: 'confirmed', path: 'wp-config.php', rule: 'sign:1' });

    const list = (await call('GET', '/api/sites/alpha/security/findings')).json() as { items: FindingDto[]; counts: Record<string, number> };
    expect(list.counts).toEqual({ open: 3, ignored: 0, resolved: 0, quarantined: 0 });
    const byId = new Map(list.items.map((f) => [f.id, f]));
    expect(byId.get(upload.id)).toMatchObject({ canReinstall: false, quarantineProblem: null });
    expect(byId.get(changed.id)).toMatchObject({ canReinstall: true, quarantineProblem: expect.stringContaining('Reinstall original') });
    expect(byId.get(config.id)).toMatchObject({ canReinstall: false, quarantineProblem: expect.stringContaining('needs this file') });

    expect((await call('POST', `/api/sites/alpha/security/findings/${upload.id}/ignore`)).json()).toMatchObject({ status: 'ignored', statusBy: 'admin' });
    expect((await call('POST', `/api/sites/alpha/security/findings/${upload.id}/ignore`)).statusCode).toBe(400);
    expect((await call('POST', `/api/sites/alpha/security/findings/${upload.id}/unignore`)).json()).toMatchObject({ status: 'open' });
    expect((await call('POST', `/api/sites/alpha/security/findings/${upload.id}/resolve`)).json()).toMatchObject({ status: 'resolved' });
    expect((await call('POST', '/api/sites/alpha/security/findings/99999/ignore')).statusCode).toBe(404);

    expect((await call('POST', `/api/sites/alpha/security/findings/${config.id}/reinstall`)).statusCode).toBe(400);
    const reinstall = await call('POST', `/api/sites/alpha/security/findings/${changed.id}/reinstall`);
    expect(reinstall.statusCode).toBe(202);
    expect(world.db.select().from(jobs).where(eq(jobs.id, reinstall.json().job.id)).get()).toMatchObject({
      type: 'wp.reinstall',
      siteId: site.id,
      payload: JSON.stringify({ siteId: site.id, package: 'core' }),
    });
    expect((await call('POST', `/api/sites/alpha/security/findings/${config.id}/quarantine`)).statusCode).toBe(400);
  });

  it("puts a changed WPL7 file back from inside the running site, and scans again", async () => {
    const { world, addSite, call } = await signedIn();
    const site = addSite('alpha');
    const login = path.join(sitePaths(world.config, 'alpha').wordpress, MU_PLUGIN_PATH);
    fs.mkdirSync(path.dirname(login), { recursive: true });
    fs.writeFileSync(login, '<?php // somebody else\'s now\n');
    const changed = addFinding(world, site.id, { kind: 'panel-modified', path: MU_PLUGIN_PATH });
    const upload = addFinding(world, site.id, {});

    const list = (await call('GET', '/api/sites/alpha/security/findings')).json() as { items: FindingDto[] };
    const byId = new Map(list.items.map((f) => [f.id, f]));
    expect(byId.get(changed.id)).toMatchObject({ canPutBack: true, canReinstall: false, quarantineProblem: expect.stringContaining('Put back') });
    expect(byId.get(upload.id)).toMatchObject({ canPutBack: false });
    expect((await call('POST', `/api/sites/alpha/security/findings/${upload.id}/put-back`)).statusCode).toBe(400);

    world.docker.containers.set('wp-alpha', 'exited');
    expect((await call('POST', `/api/sites/alpha/security/findings/${changed.id}/put-back`)).statusCode).toBe(409);
    world.docker.containers.set('wp-alpha', 'running');
    const res = await call('POST', `/api/sites/alpha/security/findings/${changed.id}/put-back`);
    expect(res.statusCode).toBe(202);
    expect(fs.readFileSync(login, 'utf8')).toBe(MU_PLUGIN_SOURCE);
    expect(world.db.select().from(sitePanelFiles).all()).toEqual([
      { siteId: site.id, path: MU_PLUGIN_PATH, sha256: sha256Hex(MU_PLUGIN_SOURCE), writtenAt: expect.any(Number) },
    ]);
    expect(world.db.select().from(jobs).where(eq(jobs.id, res.json().job.id)).get()).toMatchObject({ type: 'site.malwareScan', lane: 'scan:1' });
  });

  it("points a finding at the review of the catalog zip that flagged the same file", async () => {
    const { world, addSite, call } = await signedIn();
    const site = addSite('alpha');
    const zip = world.db.insert(plugins).values({ kind: 'zip', slug: 'premium-1-0', name: 'Premium 1.0', zipPath: '/srv/plugins/p.zip', isDefault: 0, createdAt: Date.now() }).returning().get();
    const flagged = [{ path: 'lib/x.php', kind: 'suspicious', severity: 'medium', rule: 'exploit:execution', line: 4, detail: 'RCE' }];
    world.db
      .insert(pluginZipChecks)
      .values({ pluginId: zip.id, status: 'done', folder: 'premium', version: '1.0', files: 1, manifest: JSON.stringify({ 'lib/x.php': 'a'.repeat(64) }), findings: JSON.stringify(flagged), checkedAt: Date.now() })
      .run();
    const same = addFinding(world, site.id, { engine: 'signatures', kind: 'suspicious', severity: 'medium', path: 'wp-content/plugins/premium/lib/x.php', rule: 'exploit:execution' });
    const other = addFinding(world, site.id, { engine: 'signatures', kind: 'suspicious', severity: 'medium', path: 'wp-content/plugins/premium/lib/y.php', rule: 'exploit:execution' });

    const items = new Map(((await call('GET', '/api/sites/alpha/security/findings')).json() as { items: FindingDto[] }).items.map((f) => [f.id, f]));
    expect(items.get(same.id)!.zipReview).toEqual({ pluginId: zip.id, name: 'Premium 1.0', version: '1.0' });
    expect(items.get(other.id)!.zipReview).toBeNull();

    world.core.pluginZipChecks.review(zip.id, 'alice');
    const after = new Map(((await call('GET', '/api/sites/alpha/security/findings')).json() as { items: FindingDto[] }).items.map((f) => [f.id, f]));
    expect(after.get(same.id)!.zipReview).toBeNull();
  });

  it('moves a file to quarantine by hand, lists it, restores it, and deletes what is left', async () => {
    const { world, addSite, call } = await signedIn();
    const site = addSite('alpha');
    world.docker.ephemeral = (opts) =>
      opts.cmd.includes('move') ? { stdout: '{"mode":"644","size":5}\n', stderr: '', exitCode: 0 } : { stdout: '{"restored":true}\n', stderr: '', exitCode: 0 };
    const upload = addFinding(world, site.id, {});
    const moved = await call('POST', `/api/sites/alpha/security/findings/${upload.id}/quarantine`);
    expect(moved.statusCode, moved.body).toBe(200);
    const item = moved.json() as QuarantineItemDto;
    expect(item).toMatchObject({ path: 'wp-content/uploads/x.php', state: 'kept', movedBy: 'admin', reason: 'Moved by hand' });
    expect((await call('GET', '/api/sites/alpha/security/findings?status=quarantined')).json().items).toHaveLength(1);
    expect((await call('GET', '/api/sites/alpha/security/quarantine')).json().items).toHaveLength(1);

    expect((await call('POST', `/api/sites/alpha/security/quarantine/${item.id}/restore`)).json()).toMatchObject({ state: 'restored', restoredBy: 'admin' });
    expect((await call('DELETE', `/api/sites/alpha/security/quarantine/${item.id}`)).statusCode).toBe(409);
  });
});

describe('blocked addresses', () => {
  it('blocks and unblocks by hand, and refuses what is never blocked', async () => {
    const { call } = await signedIn();
    const res = await call('POST', '/api/security/blocks', { address: '198.51.100.7', minutes: 60, note: 'scraping' });
    expect(res.statusCode, res.body).toBe(201);
    const block = res.json() as SecurityBlockDto;
    expect(block).toMatchObject({ address: '198.51.100.7', source: 'manual', createdBy: 'admin', note: 'scraping', active: true });
    expect(block.expiresAt! - block.createdAt).toBe(3600_000);
    expect((await call('POST', '/api/security/blocks', { address: '198.51.100.7' })).statusCode).toBe(409);
    const refused = await call('POST', '/api/security/blocks', { address: '10.0.0.5' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/is never blocked/);

    expect(((await call('GET', '/api/security/blocks')).json() as SecurityBlockListDto).items.map((b) => b.address)).toEqual(['198.51.100.7']);
    expect((await call('DELETE', `/api/security/blocks/${block.id}`)).json()).toMatchObject({ active: false, endReason: 'lifted', endedBy: 'admin' });
    expect(((await call('GET', '/api/security/blocks?state=history')).json() as SecurityBlockListDto).items).toHaveLength(1);
  });

  it('keeps a never-block list, and says of any address whether it could be blocked', async () => {
    const { call } = await signedIn();
    const added = await call('POST', '/api/security/never-block', { address: '192.0.2.0/24', note: 'office' });
    expect(added.statusCode).toBe(201);
    expect((await call('GET', '/api/security/never-block')).json()).toMatchObject({ items: [{ address: '192.0.2.0/24', note: 'office' }] });
    const check = (await call('GET', '/api/security/check?address=192.0.2.9')).json() as SecurityCheckDto;
    expect(check).toMatchObject({ address: '192.0.2.9', valid: true, protectedBecause: expect.stringMatching(/never-block/i) });
    expect((await call('GET', '/api/security/check?address=nonsense')).json()).toMatchObject({ valid: false });
    expect((await call('DELETE', `/api/security/never-block/${added.json().id}`)).statusCode).toBe(204);
    expect((await call('GET', '/api/security/firewall')).json()).toMatchObject({ enforced: true });
    expect((await call('POST', '/api/security/firewall/sync')).statusCode).toBe(200);
    expect((await call('GET', '/api/security/detection')).json()).toMatchObject({ mode: 'on', decisions: [] });
  });
});

describe('who may do what', () => {
  it("gives Manage a site's protection and scans, and keeps the fleet's block list to Full", async () => {
    const { addSite, call, keyOf } = await signedIn();
    addSite('alpha');
    const manage = await keyOf('manage');
    const read = await keyOf('read');
    expect((await call('PUT', '/api/sites/alpha/security', { level: 'strict' }, manage)).statusCode).toBe(200);
    expect((await call('POST', '/api/sites/alpha/security/scan', undefined, manage)).statusCode).toBe(202);
    expect((await call('POST', '/api/security/blocks', { address: '198.51.100.8' }, manage)).statusCode).toBe(403);
    expect((await call('POST', '/api/security/never-block', { address: '198.51.100.8' }, manage)).statusCode).toBe(403);
    expect((await call('GET', '/api/security/overview', undefined, read)).statusCode).toBe(200);
    expect((await call('GET', '/api/security/blocks', undefined, read)).statusCode).toBe(200);
    expect((await call('PUT', '/api/sites/alpha/security', { level: 'off' }, read)).statusCode).toBe(403);
  });
});
