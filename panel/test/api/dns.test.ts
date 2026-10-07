/**
 * Settings -> DNS over the API: the Cloudflare token (write-only, checked before it is kept,
 * never in any answer) and each server's wildcard certificate.
 */
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, servers, sites } from '../../src/db/schema.js';
import { buildSiteContainerSpec, siteRuntimeFrom, siteTlsFor } from '../../src/services/siteSpec.js';
import { tokenFilePath } from '../../src/services/traefikDns.js';
import type { AccessLevel } from '../../shared/access.js';
import type { DnsStatusDto } from '../../shared/types.js';
import { FakeDnsProvider, makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';

const TOKEN = 'cfut_' + 'x'.repeat(40) + 'abcd1234';
const RESOLVER = 'traefik.http.routers.wp-alpha.tls.certresolver';

/**
 * Certificates are labelled only where TLS is on, which the test config has off - and with it
 * on, the session cookie is Secure and never comes back over an injected request. So: keys.
 */
async function authedApp(opts: { zones?: string[] } = {}) {
  const cloudflare = new FakeDnsProvider();
  cloudflare.zones = opts.zones ?? ['example.test'];
  const world = await makeWorld({ env: { TLS_MODE: 'letsencrypt' }, dnsClient: () => cloudflare });
  const { app } = await makeApp(world);
  const keyOf = (access: AccessLevel) => ({ authorization: `Bearer ${world.deps.apiKeys.create(`key-${access}`, access).token}` });
  return { app, world, headers: keyOf('full'), keyOf, cloudflare };
}

/** A running dev site whose container was built with the wildcard certificate on - or off. */
async function addDevSite(w: TestWorld, slug: string, wildcardProvider: string, serverId = 1): Promise<void> {
  const host = `${slug}.${w.config.devDomain}`;
  const now = Date.now();
  const row = w.db
    .insert(sites)
    .values({
      slug,
      serverId,
      title: slug,
      domains: JSON.stringify([host]),
      devHostname: host,
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
  const docker = serverId === 1 ? w.docker : w.remote(serverId).docker;
  await docker.createSiteContainer(
    buildSiteContainerSpec(w.config, row, [host], { devDomain: w.config.devDomain, wildcardProvider }, siteRuntimeFrom(w.core.settings)),
  );
  docker.containers.set(`wp-${slug}`, 'running');
}

const reconciles = (w: TestWorld) => w.db.select().from(jobs).where(eq(jobs.type, 'site.reconcile')).all();

async function runJob(w: TestWorld, jobId: number): Promise<{ status: string; error: string | null }> {
  w.worker.start();
  await waitFor(() => {
    const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row!.status !== 'queued' && row!.status !== 'running';
  }, 15_000);
  await w.worker.stop();
  const row = w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
  return { status: row.status, error: row.error };
}

describe('Settings -> DNS: the token', () => {
  it('is never in an answer: neither the DNS status nor the settings', async () => {
    const { app, headers } = await authedApp();
    const put = await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.body).not.toContain(TOKEN);
    const dns = await app.inject({ method: 'GET', url: '/api/dns', headers });
    expect(dns.body).not.toContain(TOKEN);
    expect((dns.json() as DnsStatusDto).token).toMatchObject({ configured: true, envDiffers: false });
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(settings.body).not.toContain(TOKEN);
  });

  it('is checked before it is kept, and answered with what it reaches', async () => {
    const { app, world, headers } = await authedApp();
    const res = await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: ` ${TOKEN} ` } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as DnsStatusDto & { check: { ok: boolean; zones: string[]; devDomains: { domain: string; zone: string | null }[] } };
    expect(body.check.ok).toBe(true);
    expect(body.check.zones).toEqual(['example.test']);
    expect(body.check.devDomains).toEqual([expect.objectContaining({ domain: 'dev.example.test', zone: 'example.test' })]);
    // At work at once: the records, and Traefik's copy.
    expect(world.core.dns.enabled).toBe(true);
    await world.core.traefikDns.idle();
    expect(fs.readFileSync(tokenFilePath(world.config), 'utf8')).toBe(`${TOKEN}\n`);
  });

  it('is not kept when Cloudflare refuses it, and says why in Cloudflare’s words', async () => {
    const { app, world, headers, cloudflare } = await authedApp();
    cloudflare.refuse = FakeDnsProvider.invalidToken();
    const res = await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Cloudflare said: Invalid API Token (1000)');
    expect(world.core.dnsAccount.token()).toBe('');
    expect(world.core.dns.enabled).toBe(false);
  });

  it('is refused for what cannot be a token, a Global API Key by name', async () => {
    const { app, headers } = await authedApp();
    for (const [token, message] of [
      ['two words-' + 'x'.repeat(30), /one word/],
      ['short', /too short/],
      ['cfk_' + 'x'.repeat(40), /Global API Key/],
    ] as const) {
      const res = await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token } });
      expect(res.statusCode, token).toBe(400);
      expect(res.body, token).toMatch(message);
    }
  });

  it('is set and checked with Full only, and read by anyone', async () => {
    const { app, keyOf } = await authedApp();
    const read = keyOf('read');
    const manage = keyOf('manage');
    const full = keyOf('full');
    expect((await app.inject({ method: 'GET', url: '/api/dns', headers: read })).statusCode).toBe(200);
    for (const headers of [read, manage]) {
      expect((await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/dns/check', headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: '/api/dns/token', headers })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'PUT', url: '/api/dns/token', headers: full, payload: { token: TOKEN } })).statusCode).toBe(200);
  });

  it('checks a token without keeping it', async () => {
    const { app, world, headers } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/api/dns/check', headers, payload: { token: TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, zones: ['example.test'] });
    expect(world.core.dnsAccount.token()).toBe('');
  });

  it('removed, takes the dev sites that shared a Cloudflare wildcard certificate onto their own', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    world.db.update(servers).set({ dnsProvider: 'cloudflare' }).where(eq(servers.id, 1)).run();
    await addDevSite(world, 'alpha', 'cloudflare');
    await addDevSite(world, 'beta', '');
    await world.core.traefikDns.idle();

    const res = await app.inject({ method: 'DELETE', url: '/api/dns/token', headers });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as DnsStatusDto & { rebuilding: string[] };
    // Nothing could renew alpha's certificate now; beta has its own already.
    expect(body.rebuilding).toEqual(['alpha']);
    expect(reconciles(world).map((j) => j.siteId)).toHaveLength(1);
    expect(body.token.configured).toBe(false);
    // The server keeps its setting - a new token puts it back to work - but no new dev site
    // there is labelled for a certificate it cannot get.
    expect(body.servers[0]).toMatchObject({ dnsProvider: 'cloudflare', wildcardProvider: '' });
    await world.core.traefikDns.idle();
    expect(fs.existsSync(tokenFilePath(world.config))).toBe(false);
  });
});

describe('Settings -> DNS: a server’s wildcard certificate', () => {
  it('is refused without a token, and without one that reaches the dev domain', async () => {
    const { app, headers } = await authedApp({ zones: ['unrelated.test'] });
    let res = await app.inject({ method: 'PUT', url: '/api/dns/servers/1/wildcard', headers, payload: { on: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/Add a Cloudflare token first/);
    await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    res = await app.inject({ method: 'PUT', url: '/api/dns/servers/1/wildcard', headers, payload: { on: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/dev\.example\.test isn't under any domain the Cloudflare token can see/);
  });

  it('is refused where the token finds the dev domain’s zone but may not touch its records', async () => {
    const { app, world, headers, cloudflare } = await authedApp();
    cloudflare.recordsRefused.add('example.test');
    // Kept - the token reaches a zone - with Check saying what it cannot do there.
    const saved = await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    expect(saved.json().check.devDomains).toEqual([expect.objectContaining({ zone: 'example.test', records: 'refused' })]);
    const res = await app.inject({ method: 'PUT', url: '/api/dns/servers/1/wildcard', headers, payload: { on: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(
      /can't edit the DNS records of example\.test: give it Zone → DNS → Edit there\. Cloudflare said: Unauthorized/,
    );
    expect(world.servers.rowById(1)!.dnsProvider).toBe('');
  });

  it('on, gives the dev sites built from then on the shared certificate', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    const res = await app.inject({ method: 'PUT', url: '/api/dns/servers/1/wildcard', headers, payload: { on: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as DnsStatusDto).servers[0]).toMatchObject({ dnsProvider: 'cloudflare', wildcardProvider: 'cloudflare' });
    const row = world.servers.rowById(1)!;
    const spec = buildSiteContainerSpec(
      world.config,
      { slug: 'gamma', phpVersion: '8.3', dbName: 'g', dbUser: 'g', dbPassword: 'x', containerName: 'wp-gamma', tablePrefix: 'wp_' },
      ['gamma.dev.example.test'],
      siteTlsFor(world.core.dns, row),
      siteRuntimeFrom(world.core.settings),
    );
    expect(spec.labels['traefik.http.routers.wp-gamma.tls.certresolver']).toBe('letsencrypt-dns');
    expect(spec.labels['traefik.http.routers.wp-gamma.tls.domains[0].sans']).toBe('*.dev.example.test');
  });

  it('on, leaves the dev sites with a certificate of their own as they are', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    await addDevSite(world, 'alpha', '');
    const res = await app.inject({ method: 'PUT', url: '/api/dns/servers/1/wildcard', headers, payload: { on: true } });
    expect(res.json().rebuilding).toEqual([]);
    expect(reconciles(world)).toHaveLength(0);
  });

  it('off, rebuilds the dev sites that share it onto certificates of their own', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    await app.inject({ method: 'PUT', url: '/api/dns/servers/1/wildcard', headers, payload: { on: true } });
    await addDevSite(world, 'alpha', 'cloudflare');
    const res = await app.inject({ method: 'PUT', url: '/api/dns/servers/1/wildcard', headers, payload: { on: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rebuilding).toEqual(['alpha']);
    expect(world.servers.rowById(1)!.dnsProvider).toBe('');

    // The rebuild gives it its own certificate.
    const [job] = reconciles(world);
    expect(await runJob(world, job!.id)).toMatchObject({ status: 'succeeded' });
    const labels = (await world.docker.listManaged(['wpl7.role=wordpress'])).find((c) => c.name === 'wp-alpha')!.labels;
    expect(labels[RESOLVER]).toBe('letsencrypt');
  });

  it('is refused where Traefik cannot answer the challenge, whatever the token reaches', async () => {
    const { app, world, headers } = await authedApp();
    await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    // A stack from before the DNS resolver was in every compose file.
    world.docker.containerConfigs.set('wpl7-traefik', { cmd: ['--accesslog=true'], envSet: [] });
    await world.core.traefikDns.syncServer(1);
    const res = await app.inject({ method: 'PUT', url: '/api/dns/servers/1/wildcard', headers, payload: { on: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('"local" can\'t use a wildcard certificate. Update this server first: it was set up before this feature.');
    // The reason alone, for the server's row in Settings -> DNS.
    expect(res.json().error.details).toEqual({ reason: 'Update this server first: it was set up before this feature.' });
    expect(world.servers.rowById(1)!.dnsProvider).toBe('');
  });

  it('comes from the provider the server’s Traefik runs, whose credentials are its own', async () => {
    const { app, world, headers } = await authedApp();
    world.docker.containerConfigs.set('wpl7-traefik', {
      cmd: ['--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider=hetzner'],
      envSet: ['HETZNER_API_KEY'],
    });
    await world.core.traefikDns.syncServer(1);
    // No Cloudflare token needed: hetzner's is in that server's deploy/.env.
    const res = await app.inject({ method: 'PUT', url: '/api/dns/servers/1/wildcard', headers, payload: { on: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as DnsStatusDto).servers[0]).toMatchObject({ dnsProvider: 'hetzner', wildcardProvider: 'hetzner' });
  });

  it('is the same switch through PATCH /api/servers/:id', async () => {
    const { app, world, headers } = await authedApp({ zones: ['unrelated.test'] });
    await app.inject({ method: 'PUT', url: '/api/dns/token', headers, payload: { token: TOKEN } });
    const refused = await app.inject({ method: 'PATCH', url: '/api/servers/1', headers, payload: { dnsProvider: 'cloudflare' } });
    expect(refused.statusCode).toBe(409);
    // Another provider's credentials are that server's business: not checked, and kept.
    world.db.update(servers).set({ dnsProvider: 'hetzner' }).where(eq(servers.id, 1)).run();
    await addDevSite(world, 'alpha', 'hetzner');
    const off = await app.inject({ method: 'PATCH', url: '/api/servers/1', headers, payload: { dnsProvider: '' } });
    expect(off.statusCode).toBe(200);
    expect(reconciles(world)).toHaveLength(1);
  });
});
