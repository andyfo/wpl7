import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sites } from '../../src/db/schema.js';
import { MAIL_CONTAINER, DKIM_CONTAINER, MailService } from '../../src/services/mail.js';
import type { ExecPort } from '../../src/lib/exec.js';
import { ExecFiles } from '../../src/lib/files.js';
import { FakeDnsProvider, FakeDocker, makeApp, makeWorld, type TestWorld } from '../helpers.js';
import type { DnsResolver } from '../../src/services/mailDns.js';

const nx = () => {
  const err = new Error('ENOTFOUND') as NodeJS.ErrnoException;
  err.code = 'ENOTFOUND';
  return err;
};

/** Public-DNS view, scripted per test. Anything unset answers NXDOMAIN like a real one. */
function resolverFor(txt: Record<string, string[]> = {}, a: Record<string, string[]> = {}): DnsResolver {
  return {
    async resolveTxt(name) {
      const records = txt[name];
      if (!records) throw nx();
      return records.map((r) => [r]);
    },
    async resolve4(name) {
      const records = a[name];
      if (!records) throw nx();
      return records;
    },
    async resolveMx() {
      throw nx();
    },
    async reverse() {
      throw nx();
    },
  };
}

async function authedApp(world: TestWorld) {
  const { app } = await makeApp(world);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

function seedSite(world: TestWorld, slug: string, domain: string): void {
  const now = Date.now();
  world.db
    .insert(sites)
    .values({
      slug,
      title: slug,
      domains: JSON.stringify([domain]),
      phpVersion: '8.3',
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'x',
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** A world with a customer site, a reachable relay, and (optionally) a writable zone. */
async function setupWorld(opts: { zones?: string[]; resolver?: DnsResolver; publicIp?: string } = {}) {
  const dnsProvider = new FakeDnsProvider();
  dnsProvider.zones = opts.zones ?? [];
  const world = await makeWorld({ dnsProvider, resolver: opts.resolver ?? resolverFor() });
  world.docker.containers.set(MAIL_CONTAINER, 'running');
  world.docker.containers.set(DKIM_CONTAINER, 'running');
  seedSite(world, 'acme', 'acme.test');
  // Give server 1 a public IP so SPF has something to authorize.
  const { servers } = await import('../../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  world.db.update(servers).set({ publicIp: opts.publicIp ?? '203.0.113.9' }).where(eq(servers.id, 1)).run();
  return { world, dnsProvider };
}

const PANEL_HEADER = '# Written by the WPL7 panel (Mail -> Setup guide).\n';
const relayEnvPath = (world: TestWorld) => path.join(world.config.srvRoot, 'mail', 'relay.env');

function writeRelayEnv(world: TestWorld, content: string): void {
  fs.mkdirSync(path.dirname(relayEnvPath(world)), { recursive: true });
  fs.writeFileSync(relayEnvPath(world), content);
}

/** The `postconf -e … && postfix reload` calls made into the relay, as their shell lines. */
const reloads = (world: TestWorld): string[] =>
  world.docker.calls
    .filter((c) => c.method === 'exec' && c.args[0] === MAIL_CONTAINER)
    .map((c) => (c.args[1] as string[]).join(' '))
    .filter((line) => line.includes('postfix reload') && line.includes('postconf'));

describe('GET /api/mail/setup', () => {
  it('returns the server steps, the domain plan and the rDNS instructions in one call', async () => {
    const { world } = await setupWorld();
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'GET', url: '/api/mail/setup', headers });
    expect(res.statusCode).toBe(200);
    const setup = res.json();

    expect(setup.mode).toBe('direct');
    expect(setup.servers[0]).toMatchObject({ serverId: 1, name: 'local', ip: '203.0.113.9' });
    // rDNS cannot be set through a DNS API, so the guide ships instructions instead.
    expect(setup.rdnsGuides.map((g: { id: string }) => g.id)).toContain('hetzner-cloud');

    const domain = setup.domains.find((d: { domain: string }) => d.domain === 'acme.test');
    expect(domain.steps.map((s: { id: string }) => s.id)).toEqual(['spf', 'dkim', 'dmarc']);
    expect(domain.ready).toBe(false);
  });

  it('says where the announced name comes from: the default, and the name set in the panel', async () => {
    const { world } = await setupWorld();
    world.docker.relayHostnames = { live: 'srv.example.com', fallback: 'mail.example.com' };
    writeRelayEnv(world, `${PANEL_HEADER}POSTFIX_myhostname=srv.example.com\n`);
    const { app, headers } = await authedApp(world);

    const setup = (await app.inject({ method: 'GET', url: '/api/mail/setup', headers })).json();
    expect(setup.servers[0]).toMatchObject({ defaultHostname: 'mail.example.com', hostnameOverride: 'srv.example.com' });

    // A relay that is down cannot say what it was created with; the override is still on disk.
    world.docker.containers.set(MAIL_CONTAINER, 'exited');
    const down = (await app.inject({ method: 'GET', url: '/api/mail/setup', headers })).json();
    expect(down.servers[0]).toMatchObject({ defaultHostname: null, hostnameOverride: 'srv.example.com' });
  });

  it('explains how to switch automation on when no DNS token is configured', async () => {
    const world = await makeWorld({ resolver: resolverFor() });
    const { app, headers } = await authedApp(world);
    const setup = (await app.inject({ method: 'GET', url: '/api/mail/setup', headers })).json();

    expect(setup.dns.configured).toBe(false);
    expect(setup.dns.provider).toBe('');
    // The panel's own Settings, not a file on the server: that is where the token lives now.
    expect(setup.dns.hint).toMatch(/Settings → DNS/);
    expect(setup.dns.hint).toMatch(/Zone → Zone → Read and Zone → DNS → Edit/);
    expect(setup.dns.hint).not.toMatch(/deploy\/\.env/);
  });

  it('marks every step ready once the zone is writable', async () => {
    const { world } = await setupWorld({ zones: ['acme.test'] });
    const { app, headers } = await authedApp(world);
    const setup = (await app.inject({ method: 'GET', url: '/api/mail/setup', headers })).json();

    expect(setup.dns.configured).toBe(true);
    const domain = setup.domains.find((d: { domain: string }) => d.domain === 'acme.test');
    expect(domain.steps.map((s: { automation: { state: string } }) => s.automation.state)).toEqual([
      'ready',
      'ready',
      'ready',
    ]);
  });

  it('requires a session', async () => {
    const { world } = await setupWorld();
    const { app } = await authedApp(world);
    expect((await app.inject({ method: 'GET', url: '/api/mail/setup' })).statusCode).toBe(401);
  });
});

describe('POST /api/mail/domains/:domain/publish', () => {
  it('publishes all three records and generates the DKIM key on the way', async () => {
    const { world, dnsProvider } = await setupWorld({ zones: ['acme.test'] });
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    expect(res.statusCode).toBe(200);
    const results = res.json().results as { step: string; outcome: string }[];
    expect(results.map((r) => [r.step, r.outcome])).toEqual([
      ['spf', 'created'],
      ['dkim', 'created'],
      ['dmarc', 'created'],
    ]);

    expect(dnsProvider.txt.get('acme.test')![0]!.content).toBe('v=spf1 ip4:203.0.113.9 ~all');
    expect(dnsProvider.txt.get('wpl7._domainkey.acme.test')![0]!.content).toMatch(/^v=DKIM1; h=sha256; k=rsa; p=/);
    expect(dnsProvider.txt.get('_dmarc.acme.test')![0]!.content).toContain('p=none');

    // The key is real and on every server, not just a DNS record.
    expect(world.core.mail.dkimKeyFor('acme.test')).toBeTruthy();
  });

  it('merges into an existing SPF record instead of replacing it', async () => {
    const existing = 'v=spf1 include:spf.protection.outlook.com -all';
    const { world, dnsProvider } = await setupWorld({
      zones: ['acme.test'],
      resolver: resolverFor({ 'acme.test': [existing] }),
    });
    const spfId = dnsProvider.seedTxt('acme.test', existing);
    // An unrelated TXT at the same name must survive untouched.
    dnsProvider.seedTxt('acme.test', 'google-site-verification=abc123');

    const { app, headers } = await authedApp(world);
    const res = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    const results = res.json().results as { step: string; outcome: string }[];
    expect(results.find((r) => r.step === 'spf')).toMatchObject({ outcome: 'updated' });

    const records = dnsProvider.txt.get('acme.test')!;
    expect(records.find((r) => r.id === spfId)!.content).toBe(
      'v=spf1 include:spf.protection.outlook.com ip4:203.0.113.9 -all',
    );
    expect(records.find((r) => r.content.startsWith('google-site-verification'))).toBeTruthy();
    expect(records).toHaveLength(2);
  });

  it('leaves an existing DMARC policy alone rather than weakening it', async () => {
    const strict = 'v=DMARC1; p=reject; rua=mailto:dmarc@acme.test';
    const { world, dnsProvider } = await setupWorld({
      zones: ['acme.test'],
      resolver: resolverFor({ '_dmarc.acme.test': [strict] }),
    });
    dnsProvider.seedTxt('_dmarc.acme.test', strict);

    const { app, headers } = await authedApp(world);
    const res = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    const dmarc = (res.json().results as { step: string; outcome: string; detail: string }[]).find(
      (r) => r.step === 'dmarc',
    )!;
    expect(dmarc.outcome).toBe('unchanged');
    expect(dnsProvider.txt.get('_dmarc.acme.test')![0]!.content).toBe(strict);
  });

  it('does not wipe a provider record that public DNS has not caught up with yet', async () => {
    // The write target comes from the provider API, but the plan comes from public DNS. When
    // the two disagree - a record added minutes ago, or a resolver hiccup - a plan built on
    // "nothing is published" must not be written over a record that plainly is.
    const outlook = 'v=spf1 include:spf.protection.outlook.com -all';
    const strictDmarc = 'v=DMARC1; p=reject; rua=mailto:dmarc@acme.test';
    const { world, dnsProvider } = await setupWorld({
      zones: ['acme.test'],
      resolver: resolverFor(), // public DNS still says NXDOMAIN for everything
    });
    dnsProvider.seedTxt('acme.test', outlook);
    dnsProvider.seedTxt('_dmarc.acme.test', strictDmarc);

    const { app, headers } = await authedApp(world);
    await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });

    // The customer's Microsoft 365 authorization must survive.
    expect(dnsProvider.txt.get('acme.test')![0]!.content).toContain('include:spf.protection.outlook.com');
    // And their deliberate p=reject must not be downgraded to our starter p=none.
    expect(dnsProvider.txt.get('_dmarc.acme.test')![0]!.content).toBe(strictDmarc);
  });

  it('refuses rather than guessing when two SPF records are published', async () => {
    const { world, dnsProvider } = await setupWorld({
      zones: ['acme.test'],
      resolver: resolverFor({ 'acme.test': ['v=spf1 include:a.test ~all', 'v=spf1 include:b.test ~all'] }),
    });
    dnsProvider.seedTxt('acme.test', 'v=spf1 include:a.test ~all');
    dnsProvider.seedTxt('acme.test', 'v=spf1 include:b.test ~all');

    const { app, headers } = await authedApp(world);
    const res = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    const spf = (res.json().results as { step: string; outcome: string; detail: string }[]).find((r) => r.step === 'spf')!;
    expect(spf.outcome).toBe('failed');
    expect(spf.detail).toMatch(/consolidate/i);
  });

  it('is a no-op the second time around', async () => {
    const { world, dnsProvider } = await setupWorld({ zones: ['acme.test'] });
    const { app, headers } = await authedApp(world);
    await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });

    // Second run: public DNS now shows what was written, so nothing is left to do.
    const published = dnsProvider.txt;
    const resolver = resolverFor({
      'acme.test': published.get('acme.test')!.map((r) => r.content),
      'wpl7._domainkey.acme.test': published.get('wpl7._domainkey.acme.test')!.map((r) => r.content),
      '_dmarc.acme.test': published.get('_dmarc.acme.test')!.map((r) => r.content),
    });
    const world2 = await makeWorld({ dnsProvider, resolver });
    seedSite(world2, 'acme', 'acme.test');
    const { servers } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    world2.db.update(servers).set({ publicIp: '203.0.113.9' }).where(eq(servers.id, 1)).run();
    // Carry the key over: it is the panel's, and the published record must keep matching it.
    const key = world.core.mail.dkimKeyFor('acme.test')!;
    world2.core.mail.createDkimKey('acme.test');
    const { mailDkimKeys } = await import('../../src/db/schema.js');
    world2.db
      .update(mailDkimKeys)
      .set({ privateKeyPem: key.privateKeyPem, publicKeyB64: key.publicKeyB64 })
      .where(eq(mailDkimKeys.domain, 'acme.test'))
      .run();

    const app2 = await authedApp(world2);
    const res = await app2.app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers: app2.headers });
    const outcomes = (res.json().results as { outcome: string }[]).map((r) => r.outcome);
    expect(outcomes).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('does not publish a DKIM record the servers cannot back up', async () => {
    const { world, dnsProvider } = await setupWorld({ zones: ['acme.test'] });
    // A second server whose signer will not restart: the key never reaches it.
    const s2 = world.addSshServer('s2', { publicIp: '198.51.100.4' });
    s2.docker.failOn.set('restartContainer', 'container is unhealthy');
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    const dkim = (res.json().results as { step: string; outcome: string; detail: string }[]).find(
      (r) => r.step === 'dkim',
    )!;
    expect(dkim.outcome).toBe('failed');
    expect(dkim.detail).toMatch(/s2/);
    // Promising a signature a relay cannot produce is worse than publishing no DKIM at all.
    expect(dnsProvider.txt.get('wpl7._domainkey.acme.test')).toBeUndefined();

    // The key is kept, and a retry re-attempts distribution rather than assuming it is done.
    expect(world.core.mail.dkimKeyFor('acme.test')).toBeTruthy();
    s2.docker.failOn.delete('restartContainer');
    const retry = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    const dkim2 = (retry.json().results as { step: string; outcome: string }[]).find((r) => r.step === 'dkim')!;
    expect(dkim2.outcome).toBe('created');
    expect(dnsProvider.txt.get('wpl7._domainkey.acme.test')![0]!.content).toMatch(/^v=DKIM1/);
  });

  it('will not flip an SPF record that explicitly denies this server', async () => {
    const denial = 'v=spf1 -ip4:203.0.113.9 -all';
    const { world, dnsProvider } = await setupWorld({
      zones: ['acme.test'],
      resolver: resolverFor({ 'acme.test': [denial] }),
    });
    dnsProvider.seedTxt('acme.test', denial);
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    const spf = (res.json().results as { step: string; outcome: string; detail: string }[]).find((r) => r.step === 'spf')!;
    expect(spf.outcome).toMatch(/failed|skipped/);
    expect(dnsProvider.txt.get('acme.test')![0]!.content).toBe(denial);
  });

  it('says what to do instead when no DNS provider is configured', async () => {
    const world = await makeWorld({ resolver: resolverFor() });
    seedSite(world, 'acme', 'acme.test');
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/by hand/i);
  });

  it('says so when the zone is not in the panel DNS account', async () => {
    const { world } = await setupWorld({ zones: ['someone-else.test'] });
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not in the panel's DNS account/);
  });

  it('never proposes an SPF record for a smarthost', async () => {
    const dnsProvider = new FakeDnsProvider();
    dnsProvider.zones = ['acme.test'];
    const world = await makeWorld({ dnsProvider, resolver: resolverFor() });
    // A relayhost makes this a smarthost install; only the provider knows the SPF value.
    Object.assign(world.config, { mailMode: 'smarthost' });
    seedSite(world, 'acme', 'acme.test');
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'POST', url: '/api/mail/domains/acme.test/publish', headers });
    const spf = (res.json().results as { step: string; outcome: string }[]).find((r) => r.step === 'spf')!;
    expect(spf.outcome).toBe('skipped');
    expect(dnsProvider.txt.get('acme.test')).toBeUndefined();
  });
});

describe('PUT /api/mail/servers/:serverId/hostname', () => {
  it('applies the new name to the running relay and persists it for the next recreate', async () => {
    const { world } = await setupWorld({ zones: ['example.com'] });
    // postconf -e + postfix reload, then the read-back.
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 });
    world.docker.execQueue.push({ stdout: 'smtp.example.com\n', stderr: '', exitCode: 0 });
    const { app, headers } = await authedApp(world);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/mail/servers/1/hostname',
      headers,
      payload: { hostname: 'smtp.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ effective: 'smtp.example.com', applied: true });

    // Live: reloaded rather than restarted, so nothing queued is dropped.
    const reload = world.docker.calls.find(
      (c) => c.method === 'exec' && String((c.args[1] as string[])?.[2] ?? '').includes('postfix reload'),
    )!;
    expect((reload.args[1] as string[])[2]).toContain('postconf -e myhostname=smtp.example.com');

    // Durable: compose reads this back as an env_file, so a recreate keeps the new name.
    const fs = await import('node:fs');
    const written = fs.readFileSync(`${world.config.srvRoot}/mail/relay.env`, 'utf8');
    expect(written).toContain('POSTFIX_myhostname=smtp.example.com');
  });

  it('saves the value even when the relay is down, to apply on next start', async () => {
    const { world } = await setupWorld({ zones: ['example.com'] });
    world.docker.containers.set(MAIL_CONTAINER, 'exited');
    const { app, headers } = await authedApp(world);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/mail/servers/1/hostname',
      headers,
      payload: { hostname: 'smtp.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: false });
    expect(res.json().detail).toMatch(/next starts/);
    const fs = await import('node:fs');
    expect(fs.readFileSync(`${world.config.srvRoot}/mail/relay.env`, 'utf8')).toContain('smtp.example.com');
  });

  it('reports what the relay actually announces, not what was asked for', async () => {
    const { world } = await setupWorld({ zones: ['example.com'] });
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 });
    // Whatever postfix says is the truth receivers will see.
    world.docker.execQueue.push({ stdout: 'something.else\n', stderr: '', exitCode: 0 });
    const { app, headers } = await authedApp(world);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/mail/servers/1/hostname',
      headers,
      payload: { hostname: 'smtp.example.com' },
    });
    expect(res.json().effective).toBe('something.else');
  });

  it('surfaces a relay that refuses the change instead of claiming success', async () => {
    const { world } = await setupWorld({ zones: ['example.com'] });
    world.docker.execQueue.push({ stdout: '', stderr: 'postconf: fatal: bad value', exitCode: 1 });
    const { app, headers } = await authedApp(world);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/mail/servers/1/hostname',
      headers,
      payload: { hostname: 'smtp.example.com' },
    });
    expect(res.statusCode).toBe(502);
  });

  it('rejects anything that is not a hostname', async () => {
    const { world } = await setupWorld();
    const { app, headers } = await authedApp(world);
    for (const hostname of ['not a host', 'localhost', '', 'http://smtp.example.com']) {
      const res = await app.inject({ method: 'PUT', url: '/api/mail/servers/1/hostname', headers, payload: { hostname } });
      expect(res.statusCode, hostname).toBe(400);
    }
  });

  it('reports an unknown server rather than writing nothing quietly', async () => {
    const { world } = await setupWorld();
    const { app, headers } = await authedApp(world);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/mail/servers/99/hostname',
      headers,
      payload: { hostname: 'smtp.example.com' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/mail/servers/:serverId/hostname with the default name', () => {
  it('goes back to the default rather than pinning it as an override', async () => {
    // Pinned, the relay would keep this name after MAIL_HOSTNAME changed; as the default, it
    // follows .env - which is what asking for the default name means.
    const { world } = await setupWorld();
    world.docker.relayHostnames = { live: 'srv.example.com', fallback: 'mail.example.com' };
    writeRelayEnv(world, `${PANEL_HEADER}POSTFIX_myhostname=srv.example.com\n`);
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 });
    world.docker.execQueue.push({ stdout: 'mail.example.com\n', stderr: '', exitCode: 0 });
    const { app, headers } = await authedApp(world);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/mail/servers/1/hostname',
      headers,
      payload: { hostname: 'Mail.Example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ effective: 'mail.example.com', applied: true });
    expect(res.json().detail).toMatch(/the default/);
    expect(fs.existsSync(relayEnvPath(world))).toBe(false);
    expect(reloads(world)).toEqual(['sh -c postconf -e myhostname=mail.example.com && postfix reload']);
  });
});

describe('DELETE /api/mail/servers/:serverId/hostname', () => {
  it('drops the override and puts the relay back on its default, live', async () => {
    const { world } = await setupWorld();
    world.docker.relayHostnames = { live: 'srv.example.com', fallback: 'mail.example.com' };
    writeRelayEnv(world, `${PANEL_HEADER}POSTFIX_myhostname=srv.example.com\nPOSTFIX_smtp_tls_loglevel=1\n`);
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 });
    world.docker.execQueue.push({ stdout: 'mail.example.com\n', stderr: '', exitCode: 0 });
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'DELETE', url: '/api/mail/servers/1/hostname', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ effective: 'mail.example.com', applied: true });
    expect(reloads(world)).toEqual(['sh -c postconf -e myhostname=mail.example.com && postfix reload']);
    // The panel's other settings stay; only the hostname goes.
    const left = fs.readFileSync(relayEnvPath(world), 'utf8');
    expect(left).toContain('POSTFIX_smtp_tls_loglevel=1');
    expect(left).not.toContain('POSTFIX_myhostname');
  });

  it('removes the file once nothing is left in it, and waits for a relay that is down', async () => {
    const { world } = await setupWorld();
    world.docker.containers.set(MAIL_CONTAINER, 'exited');
    writeRelayEnv(world, `${PANEL_HEADER}POSTFIX_myhostname=srv.example.com\n`);
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'DELETE', url: '/api/mail/servers/1/hostname', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: false });
    expect(res.json().detail).toMatch(/next starts/);
    expect(fs.existsSync(relayEnvPath(world))).toBe(false);
    expect(reloads(world)).toEqual([]);
  });

  it('reports an unknown server rather than writing nothing quietly', async () => {
    const { world } = await setupWorld();
    const { app, headers } = await authedApp(world);
    const res = await app.inject({ method: 'DELETE', url: '/api/mail/servers/99/hostname', headers });
    expect(res.statusCode).toBe(404);
  });
});

describe('the relay hostname across a restart', () => {
  // A restarted relay re-applies the environment its container was created with, which says
  // nothing of an override set - or removed - since then (mailHostname.ts).
  it('puts back the name set in the panel when a restart has undone it', async () => {
    const { world } = await setupWorld();
    world.docker.relayHostnames = { live: 'mail.example.com', fallback: 'mail.example.com' };
    writeRelayEnv(world, `${PANEL_HEADER}POSTFIX_myhostname=smtp.example.com\n`);
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 });
    world.docker.execQueue.push({ stdout: 'smtp.example.com\n', stderr: '', exitCode: 0 });

    await world.core.mail.ingestTick();

    expect(reloads(world)).toEqual(['sh -c postconf -e myhostname=smtp.example.com && postfix reload']);
  });

  it('puts back the default when a restart brought back a name that was reset', async () => {
    const { world } = await setupWorld();
    world.docker.relayHostnames = { live: 'srv.example.com', fallback: 'mail.example.com' };
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 });
    world.docker.execQueue.push({ stdout: 'mail.example.com\n', stderr: '', exitCode: 0 });

    expect(await world.core.mail.convergeHostname(1)).toEqual({ from: 'srv.example.com', to: 'mail.example.com' });
    expect(reloads(world)).toEqual(['sh -c postconf -e myhostname=mail.example.com && postfix reload']);
  });

  it('leaves a relay alone that announces what it should, or cannot say', async () => {
    const { world } = await setupWorld();
    writeRelayEnv(world, `${PANEL_HEADER}POSTFIX_myhostname=SMTP.example.com\n`);
    world.docker.relayHostnames = { live: 'smtp.example.com', fallback: 'mail.example.com' };
    expect(await world.core.mail.convergeHostname(1)).toBeNull();

    world.docker.relayHostnames = null; // mailpit, in local development
    expect(await world.core.mail.convergeHostname(1)).toBeNull();

    world.docker.relayHostnames = { live: 'mail.example.com', fallback: 'mail.example.com' };
    world.docker.containers.set(MAIL_CONTAINER, 'exited');
    expect(await world.core.mail.convergeHostname(1)).toBeNull();
    expect(reloads(world)).toEqual([]);
  });

  it('does not take an override it could not read for no override', async () => {
    // Taken for "none", a slow or failing read would put the relay back on the default.
    const { world } = await setupWorld();
    world.docker.relayHostnames = { live: 'smtp.example.com', fallback: 'mail.example.com' };
    fs.mkdirSync(relayEnvPath(world), { recursive: true });

    await expect(world.core.mail.convergeHostname(1)).rejects.toThrow();
    expect(reloads(world)).toEqual([]);
  });

  it('does not take a check that timed out on a server for no override', async () => {
    // The server's real file adapter, over a shell where the check comes back as the remote
    // `timeout` wrapper's 124 - which exists() answers as "not there".
    const docker = new FakeDocker();
    docker.containers.set(MAIL_CONTAINER, 'running');
    docker.relayHostnames = { live: 'smtp.example.com', fallback: 'mail.example.com' };
    const relayOn = (exitCode: number) => {
      const shell: ExecPort = {
        run: async () => ({ stdout: '', stderr: '', exitCode }),
        runWithInput: async () => ({ stdout: '', stderr: '', exitCode }),
        runToStream: async () => ({ exitCode, stderr: '' }),
      };
      const handle = { id: 2, name: 'worker', docker, files: new ExecFiles(shell) };
      const log = { info: () => undefined, warn: () => undefined };
      return new MailService(
        null as never,
        { srvRoot: '/srv' } as never,
        { handleFor: () => handle } as never,
        null as never,
        log as never,
      );
    };

    await expect(relayOn(124).convergeHostname(2)).rejects.toThrow(/exit 124/);
    expect(docker.calls.filter((c) => c.method === 'exec' && String(c.args[1]).includes('postfix reload'))).toEqual([]);

    // Confirmed not there, it is no override: the default is put back.
    docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 });
    docker.execQueue.push({ stdout: 'mail.example.com\n', stderr: '', exitCode: 0 });
    expect(await relayOn(3).convergeHostname(2)).toEqual({ from: 'smtp.example.com', to: 'mail.example.com' });
  });
});

describe('POST /api/mail/servers/:serverId/publish-hostname', () => {
  it('points the mail hostname at the server when the zone is writable', async () => {
    const { world, dnsProvider } = await setupWorld({ zones: ['acme.test'] });
    world.docker.execQueue.push({ stdout: 'mail.acme.test\n\ninet:dkim:8891\n', stderr: '', exitCode: 0 });
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 }); // postqueue -j
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'POST', url: '/api/mail/servers/1/publish-hostname', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'written' });
    expect(dnsProvider.records.get('mail.acme.test')).toBe('203.0.113.9');
  });

  it('reports an unknown server rather than writing nothing quietly', async () => {
    const { world } = await setupWorld({ zones: ['acme.test'] });
    const { app, headers } = await authedApp(world);
    const res = await app.inject({ method: 'POST', url: '/api/mail/servers/99/publish-hostname', headers });
    expect(res.statusCode).toBe(404);
  });
});
