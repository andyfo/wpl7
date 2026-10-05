/**
 * Every server's Traefik reads the panel's Cloudflare token from a file, which the panel keeps
 * in step with Settings -> DNS - and restarts Traefik where a token it may still hold changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { servers } from '../../src/db/schema.js';
import { tokenFilePath, traefikDnsMode, TraefikDnsSync } from '../../src/services/traefikDns.js';
import { FakeDnsProvider, makeWorld, type FakeDocker, type TestWorld } from '../helpers.js';

const TOKEN = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const PROVIDER = '--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider=';

const restarts = (docker: FakeDocker) => docker.calls.filter((c) => c.method === 'restartContainer' && c.args[0] === 'wpl7-traefik').length;

async function world(): Promise<TestWorld> {
  return makeWorld({ dnsClient: () => new FakeDnsProvider() });
}

describe('how a server’s Traefik answers DNS challenges', () => {
  it('reads it off the container: its DNS resolver, and where the token comes from', () => {
    const cf = [`${PROVIDER}cloudflare`];
    expect(traefikDnsMode({ cmd: cf, envSet: ['CF_DNS_API_TOKEN_FILE'] }, true)).toEqual({ mode: 'file', provider: 'cloudflare', envToken: false });
    // A compose file from before Settings -> DNS passes .env's token, which lego reads first.
    expect(traefikDnsMode({ cmd: cf, envSet: ['CF_DNS_API_TOKEN', 'CF_DNS_API_TOKEN_FILE'] }, true)).toEqual({ mode: 'env', provider: 'cloudflare', envToken: true });
    expect(traefikDnsMode({ cmd: cf, envSet: [] }, true)).toEqual({ mode: 'env', provider: 'cloudflare', envToken: false });
    expect(traefikDnsMode({ cmd: [`${PROVIDER}hetzner`], envSet: ['HETZNER_API_KEY'] }, true)).toEqual({ mode: 'other', provider: 'hetzner', envToken: false });
    expect(traefikDnsMode({ cmd: ['--accesslog=true'], envSet: [] }, true)).toEqual({ mode: 'none', provider: null, envToken: false });
    expect(traefikDnsMode({ cmd: cf, envSet: ['CF_DNS_API_TOKEN_FILE'] }, false).mode).toBe('stopped');
    expect(traefikDnsMode(null, false).mode).toBe('stopped');
  });
});

describe('TraefikDnsSync', () => {
  it('writes the first token where Traefik reads it, 0600, without a restart', async () => {
    const w = await world();
    w.core.dnsAccount.set(TOKEN);
    await w.core.traefikDns.idle();
    const file = tokenFilePath(w.config);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${TOKEN}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    // A Traefik that had no token never kept one.
    expect(restarts(w.docker)).toBe(0);
    expect(w.core.traefikDns.statusOf(1)).toMatchObject({ state: 'ok', mode: 'file', provider: 'cloudflare', restartedAt: null });
  });

  it('restarts Traefik when a token it may hold is replaced, and only then', async () => {
    const w = await world();
    w.core.dnsAccount.set(TOKEN);
    await w.core.traefikDns.idle();
    await w.core.traefikDns.syncServer(1);
    expect(restarts(w.docker)).toBe(0);

    w.core.dnsAccount.set(OTHER);
    await w.core.traefikDns.idle();
    expect(fs.readFileSync(tokenFilePath(w.config), 'utf8')).toBe(`${OTHER}\n`);
    expect(restarts(w.docker)).toBe(1);
    expect(w.core.traefikDns.statusOf(1).restartedAt).toBeGreaterThan(0);
  });

  it('removes the file with the token, and restarts Traefik so it lets go of it too', async () => {
    const w = await world();
    w.core.dnsAccount.set(TOKEN);
    await w.core.traefikDns.idle();
    w.core.dnsAccount.set('');
    await w.core.traefikDns.idle();
    expect(fs.existsSync(tokenFilePath(w.config))).toBe(false);
    expect(restarts(w.docker)).toBe(1);
  });

  it('leaves a Traefik alone that does not read the file: an older stack, another provider, a stopped one', async () => {
    const w = await world();
    w.core.dnsAccount.set(TOKEN);
    await w.core.traefikDns.idle();
    w.docker.containerConfigs.set('wpl7-traefik', { cmd: [`${PROVIDER}cloudflare`], envSet: ['CF_DNS_API_TOKEN'] });
    w.core.dnsAccount.set(OTHER);
    await w.core.traefikDns.idle();
    expect(restarts(w.docker)).toBe(0);
    expect(w.core.traefikDns.statusOf(1)).toMatchObject({ state: 'ok', mode: 'env', envToken: true });
    // The file is current anyway: the server's next update starts Traefik reading it.
    expect(fs.readFileSync(tokenFilePath(w.config), 'utf8')).toBe(`${OTHER}\n`);

    w.docker.containerConfigs.set('wpl7-traefik', { cmd: [`${PROVIDER}cloudflare`], envSet: ['CF_DNS_API_TOKEN_FILE'] });
    w.docker.containers.set('wpl7-traefik', 'exited');
    w.core.dnsAccount.set(TOKEN);
    await w.core.traefikDns.idle();
    expect(restarts(w.docker)).toBe(0);
    expect(w.core.traefikDns.statusOf(1).mode).toBe('stopped');
  });

  it('tries a failed restart again, though the file is already current', async () => {
    const w = await world();
    w.core.dnsAccount.set(TOKEN);
    await w.core.traefikDns.idle();
    const restart = w.docker.restartContainer.bind(w.docker);
    w.docker.restartContainer = async () => {
      throw new Error('daemon busy');
    };
    w.core.dnsAccount.set(OTHER);
    await w.core.traefikDns.idle();
    expect(w.core.traefikDns.statusOf(1)).toMatchObject({ state: 'error', message: 'daemon busy' });

    w.docker.restartContainer = restart;
    await w.core.traefikDns.syncServer(1);
    expect(restarts(w.docker)).toBe(1);
    expect(w.core.traefikDns.statusOf(1).state).toBe('ok');
    // Owed once, paid once.
    await w.core.traefikDns.syncServer(1);
    expect(restarts(w.docker)).toBe(1);
  });

  it('gives every server its copy, worker servers included', async () => {
    const w = await world();
    const s2 = w.addSshServer('s2', { real: true });
    w.core.dnsAccount.set(TOKEN);
    await w.core.traefikDns.idle();
    expect(fs.readFileSync(path.join(s2.root!, 'traefik', 'dns', 'cloudflare-api-token'), 'utf8')).toBe(`${TOKEN}\n`);
    expect(w.core.traefikDns.statusOf(s2.id)).toMatchObject({ state: 'ok', mode: 'file' });
  });

  it('leaves a server being set up to its provision job, which gives it the token as its last step', async () => {
    const w = await world();
    const s2 = w.addSshServer('s2', { real: true });
    w.db.update(servers).set({ status: 'provisioning' }).where(eq(servers.id, s2.id)).run();
    w.core.dnsAccount.set(TOKEN);
    await w.core.traefikDns.idle();
    expect(fs.existsSync(path.join(s2.root!, 'traefik', 'dns', 'cloudflare-api-token'))).toBe(false);
    expect(w.core.traefikDns.statusOf(s2.id).state).toBe('unknown');
    w.db.update(servers).set({ status: 'ok' }).where(eq(servers.id, s2.id)).run();
    await w.core.traefikDns.kick(s2.id);
    expect(fs.readFileSync(path.join(s2.root!, 'traefik', 'dns', 'cloudflare-api-token'), 'utf8')).toBe(`${TOKEN}\n`);
  });

  it('ticks the servers not given the current token, and the ones not looked at for half an hour', async () => {
    const w = await world();
    const sync = new TraefikDnsSync(w.config, w.servers, () => TOKEN, w.core.log, { debounceMs: 0 });
    expect(sync.tick().kicked).toBe(1);
    await sync.idle();
    expect(sync.tick().kicked).toBe(0);
    expect(sync.tick(Date.now() + 31 * 60_000).kicked).toBe(1);
    await sync.idle();
    // A new server is looked at straight away; an unreachable one waits for the monitor to see it answer.
    const s2 = w.addSshServer('s2');
    const s3 = w.addSshServer('s3');
    w.db.update(servers).set({ status: 'unreachable' }).where(eq(servers.id, s3.id)).run();
    expect(sync.tick().kicked).toBe(1);
    await sync.idle();
    expect(sync.statusOf(s2.id).state).toBe('ok');
    expect(sync.statusOf(s3.id).state).toBe('unknown');
  });
});
