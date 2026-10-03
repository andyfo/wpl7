import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mailMessages, sites } from '../../src/db/schema.js';
import { MAIL_CONTAINER, DKIM_CONTAINER, mailPaths } from '../../src/services/mail.js';
import { makeApp, makeWorld, type TestWorld } from '../helpers.js';
import type { DnsResolver } from '../../src/services/mailDns.js';

/** A resolver that answers NXDOMAIN for everything: deliverability checks stay offline. */
const emptyResolver: DnsResolver = {
  async resolveTxt() {
    const err = new Error('ENOTFOUND') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  },
  async resolve4() {
    const err = new Error('ENOTFOUND') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  },
  async resolveMx() {
    const err = new Error('ENOTFOUND') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  },
  async reverse() {
    const err = new Error('ENOTFOUND') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  },
};

async function authedApp(world?: TestWorld) {
  const w = world ?? (await makeWorld({ resolver: emptyResolver }));
  const { app } = await makeApp(w);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'correct-horse-battery' },
  });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  const headers = { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' };
  return { app, world: w, headers };
}

/** Pretend the relay (and signer) are up on server 1. */
function relayRunning(world: TestWorld): void {
  world.docker.containers.set(MAIL_CONTAINER, 'running');
  world.docker.containers.set(DKIM_CONTAINER, 'running');
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

const POSTFIX_LOG = `
2026-09-18T05:39:23.781211+00:00 INFO    postfix/smtpd[984]: connect from wp-acme.wpl7_proxy[172.22.0.5]
2026-09-18T05:39:23.792921+00:00 INFO    postfix/smtpd[984]: C17462B13: client=wp-acme.wpl7_proxy[172.22.0.5]
2026-09-18T05:39:24.121100+00:00 INFO    postfix/qmgr[978]: C17462B13: from=<wordpress@acme.test>, size=443, nrcpt=2 (queue active)
2026-09-18T05:39:24.161156+00:00 INFO    postfix/smtp[990]: C17462B13: to=<one@somewhere.test>, relay=mx[203.0.113.9]:25, delay=0.37, dsn=2.0.0, status=sent (250 Ok)
2026-09-18T05:39:25.161156+00:00 INFO    postfix/smtp[990]: C17462B13: to=<two@elsewhere.test>, relay=mx2[203.0.113.8]:25, delay=1.2, dsn=5.1.1, status=bounced (550 User unknown)
2026-09-18T05:39:26.000000+00:00 INFO    postfix/smtpd[984]: NOQUEUE: reject: RCPT from unknown[198.51.100.7]: 554 5.7.1 <x@y.test>: Relay access denied; from=<spam@bad.test> to=<x@y.test> proto=ESMTP
`.trim();

const DKIM_LOG = 'Sep 18 05:39:24 host opendkim[85]: C17462B13: DKIM-Signature field added (s=wpl7, d=acme.test)';

describe('mail traffic ingest', () => {
  it('reconstructs one row per recipient, with the sending site and signing verdict', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    seedSite(world, 'acme', 'acme.test');
    world.docker.logs.set(MAIL_CONTAINER, POSTFIX_LOG);
    world.docker.logs.set(DKIM_CONTAINER, DKIM_LOG);

    await world.core.mail.ingestServer(1);

    const rows = world.db.select().from(mailMessages).all();
    // Two recipients of the queued message, plus the refused one.
    expect(rows).toHaveLength(3);

    const sent = rows.find((r) => r.toAddr === 'one@somewhere.test')!;
    expect(sent).toMatchObject({
      queueId: 'C17462B13',
      siteSlug: 'acme',
      fromAddr: 'wordpress@acme.test',
      status: 'sent',
      dsn: '2.0.0',
      sizeBytes: 443,
      nrcpt: 2,
      dkimSigned: 1,
      dkimDomain: 'acme.test',
    });
    expect(sent.delayMs).toBe(370);

    const bounced = rows.find((r) => r.toAddr === 'two@elsewhere.test')!;
    // The second recipient inherits the envelope even though only the first claimed it.
    expect(bounced).toMatchObject({ status: 'bounced', siteSlug: 'acme', fromAddr: 'wordpress@acme.test', dkimSigned: 1 });

    const rejected = rows.find((r) => r.status === 'rejected')!;
    expect(rejected).toMatchObject({ toAddr: 'x@y.test', fromAddr: 'spam@bad.test', siteSlug: null });
  });

  it('is idempotent when the overlap window replays the same lines', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    world.docker.logs.set(MAIL_CONTAINER, POSTFIX_LOG);
    world.docker.logs.set(DKIM_CONTAINER, DKIM_LOG);

    await world.core.mail.ingestServer(1);
    const first = world.db.select().from(mailMessages).all();
    await world.core.mail.ingestServer(1);
    await world.core.mail.ingestServer(1);
    const third = world.db.select().from(mailMessages).all();

    expect(third).toHaveLength(first.length);
    expect(third.map((r) => `${r.queueId}/${r.toAddr}/${r.status}`).sort()).toEqual(
      first.map((r) => `${r.queueId}/${r.toAddr}/${r.status}`).sort(),
    );
  });

  it('completes a message whose delivery only shows up in a later read', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    const lines = POSTFIX_LOG.split('\n');

    // First pass: postfix has accepted the message but not tried to deliver it yet.
    world.docker.logs.set(MAIL_CONTAINER, lines.slice(0, 3).join('\n'));
    await world.core.mail.ingestServer(1);
    const queued = world.db.select().from(mailMessages).all();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'queued', toAddr: '' });

    // Second pass: the delivery lines arrive and must fill in the waiting row.
    world.docker.logs.set(MAIL_CONTAINER, lines.join('\n'));
    await world.core.mail.ingestServer(1);
    const rows = world.db.select().from(mailMessages).all();
    expect(rows.filter((r) => r.toAddr === '')).toHaveLength(0);
    expect(rows.find((r) => r.toAddr === 'one@somewhere.test')?.status).toBe('sent');
  });

  it('marks a delivered message unsigned when the signer logged nothing for it', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    world.docker.logs.set(MAIL_CONTAINER, POSTFIX_LOG);
    // Signer is up and logging, but this message never matched a signing table entry.
    world.docker.logs.set(DKIM_CONTAINER, 'Sep 18 05:39:24 host opendkim[85]: OpenDKIM Filter v2.11.0 starting');

    await world.core.mail.ingestServer(1);
    const sent = world.db.select().from(mailMessages).all().find((r) => r.toAddr === 'one@somewhere.test')!;
    expect(sent.dkimSigned).toBe(0);
  });

  it('does nothing when the relay is not running on that server', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    // Stated outright rather than relying on the world's stack being bare: server 1 is
    // provisioned there, and "no relay here" is the actual condition under test.
    world.docker.containers.delete(MAIL_CONTAINER);
    world.docker.logs.set(MAIL_CONTAINER, POSTFIX_LOG);
    const res = await world.core.mail.ingestServer(1);
    expect(res.events).toBe(0);
    expect(world.db.select().from(mailMessages).all()).toHaveLength(0);
  });
});

describe('mail API', () => {
  it('filters traffic by site, status and search', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    seedSite(world, 'acme', 'acme.test');
    world.docker.logs.set(MAIL_CONTAINER, POSTFIX_LOG);
    const { app, headers } = await authedApp(world);
    await app.inject({ method: 'POST', url: '/api/mail/ingest', headers });

    const bySite = await app.inject({ method: 'GET', url: '/api/mail/messages?siteSlug=acme', headers });
    expect(bySite.json().items).toHaveLength(2);

    const byStatus = await app.inject({ method: 'GET', url: '/api/mail/messages?status=bounced', headers });
    expect(byStatus.json().items).toHaveLength(1);
    expect(byStatus.json().items[0].to).toBe('two@elsewhere.test');

    const bySearch = await app.inject({ method: 'GET', url: '/api/mail/messages?search=elsewhere', headers });
    expect(bySearch.json().items).toHaveLength(1);

    // The site column comes from the connection, so the DTO can be trusted for attribution.
    expect(bySite.json().items[0].siteSlug).toBe('acme');
  });

  it('rejects an unknown status rather than silently returning everything', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/api/mail/messages?status=exploded', headers });
    expect(res.statusCode).toBe(400);
  });

  it('counts volume per site and flags a spike against the budget', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    seedSite(world, 'acme', 'acme.test');
    world.core.settings.set('mailAlertPerSitePerHour', 10);

    // 60 messages from one site in the window: well past 10/hour * 1 hour.
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      world.db
        .insert(mailMessages)
        .values({
          serverId: 1,
          queueId: `Q${String(i).padStart(9, '0')}`,
          siteSlug: 'acme',
          fromAddr: 'wordpress@acme.test',
          toAddr: `victim${i}@spammed.test`,
          status: i % 3 === 0 ? 'bounced' : 'sent',
          firstSeenAt: now,
          lastEventAt: now,
        })
        .run();
    }

    const { app, headers } = await authedApp(world);
    const res = await app.inject({ method: 'GET', url: '/api/mail/stats?hours=1', headers });
    const stats = res.json();
    expect(stats.total).toBe(60);
    const acme = stats.topSites.find((s: { siteSlug: string }) => s.siteSlug === 'acme');
    expect(acme).toMatchObject({ overBudget: true, uniqueRecipients: 60 });
    expect(acme.failed).toBe(20);
    expect(stats.topRecipientDomains[0]).toMatchObject({ domain: 'spammed.test', count: 60 });
  });

  it('reports relay health, including the milter and the queue', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    // postconf output, then postqueue -j (empty).
    world.docker.execQueue.push({ stdout: 'mail.acme.test\n\ninet:dkim:8891\n', stderr: '', exitCode: 0 });
    world.docker.execQueue.push({ stdout: '', stderr: '', exitCode: 0 });

    const { app, headers } = await authedApp(world);
    const res = await app.inject({ method: 'GET', url: '/api/mail/status', headers });
    expect(res.statusCode).toBe(200);
    const server = res.json().servers[0];
    expect(server).toMatchObject({ relayRunning: true, dkimRunning: true, hostname: 'mail.acme.test', mode: 'direct' });
    expect(server.checks.find((c: { name: string }) => c.name === 'milter').ok).toBe(true);
  });

  it('surfaces a stopped relay as a failed check instead of an error page', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    world.docker.containers.set(MAIL_CONTAINER, 'exited');
    const { app, headers } = await authedApp(world);
    const res = await app.inject({ method: 'GET', url: '/api/mail/status', headers });
    expect(res.statusCode).toBe(200);
    const server = res.json().servers[0];
    expect(server.ok).toBe(false);
    expect(server.checks.find((c: { name: string }) => c.name === 'relay')).toMatchObject({ ok: false });
  });
});

describe('DKIM key management', () => {
  it('writes the key and tables onto the server and restarts the signer', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    const { app, headers } = await authedApp(world);

    const res = await app.inject({
      method: 'POST',
      url: '/api/mail/dkim',
      headers,
      payload: { domain: 'acme.test' },
    });
    expect(res.statusCode).toBe(201);
    const key = res.json().key;
    expect(key).toMatchObject({ domain: 'acme.test', selector: 'wpl7', recordName: 'wpl7._domainkey.acme.test' });
    expect(key.recordValue).toMatch(/^v=DKIM1; h=sha256; k=rsa; p=/);

    const p = mailPaths(world.config);
    expect(fs.readFileSync(path.join(p.dkimDir, 'acme.test', 'wpl7.private'), 'utf8')).toMatch(
      /^-----BEGIN RSA PRIVATE KEY-----/,
    );
    expect(fs.readFileSync(p.keyTable, 'utf8')).toContain(
      'acme.test acme.test:wpl7:/etc/opendkim/keys/acme.test/wpl7.private',
    );
    expect(fs.readFileSync(p.signingPolicy, 'utf8')).toContain('odkim.get_fromdomain(ctx)');
    expect(fs.existsSync(p.senderLogins)).toBe(true);
    expect(fs.readFileSync(p.opendkimConf, 'utf8')).toContain('Mode                    s');

    // The tables are only read at startup, so a sync that skipped the restart would be a no-op.
    expect(world.docker.calls.some((c) => c.method === 'restartContainer' && c.args[0] === DKIM_CONTAINER)).toBe(true);
  });

  it('refuses a duplicate key but allows an explicit rotation', async () => {
    const { app, headers } = await authedApp();
    await app.inject({ method: 'POST', url: '/api/mail/dkim', headers, payload: { domain: 'acme.test' } });

    const dup = await app.inject({ method: 'POST', url: '/api/mail/dkim', headers, payload: { domain: 'acme.test' } });
    expect(dup.statusCode).toBe(409);

    const first = await app.inject({ method: 'GET', url: '/api/mail/dkim', headers });
    const rotate = await app.inject({
      method: 'POST',
      url: '/api/mail/dkim',
      headers,
      payload: { domain: 'acme.test', rotate: true },
    });
    expect(rotate.statusCode).toBe(201);
    // Same selector (one DNS record to update), new key material.
    expect(rotate.json().key.selector).toBe(first.json().items[0].selector);
    expect(rotate.json().key.recordValue).not.toBe(first.json().items[0].recordValue);
  });

  it('removes the key directory again when the domain is dropped', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    const { app, headers } = await authedApp(world);
    await app.inject({ method: 'POST', url: '/api/mail/dkim', headers, payload: { domain: 'acme.test' } });
    await app.inject({ method: 'POST', url: '/api/mail/dkim', headers, payload: { domain: 'other.test' } });

    const p = mailPaths(world.config);
    expect(fs.existsSync(path.join(p.dkimDir, 'acme.test'))).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: '/api/mail/dkim/acme.test', headers });
    expect(del.statusCode).toBe(200);
    // A key left on disk would keep signing for a domain nobody publishes a record for.
    expect(fs.existsSync(path.join(p.dkimDir, 'acme.test'))).toBe(false);
    expect(fs.existsSync(path.join(p.dkimDir, 'other.test'))).toBe(true);
    expect(fs.readFileSync(p.keyTable, 'utf8')).not.toContain('acme.test');
  });

  it('pushes every key to every server, so a moved site keeps signing', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    const s2 = world.addSshServer('s2', { real: true });
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'POST', url: '/api/mail/dkim', headers, payload: { domain: 'acme.test' } });
    expect(res.json().sync.map((s: { name: string; ok: boolean }) => [s.name, s.ok])).toEqual([
      ['local', true],
      ['s2', true],
    ]);
    // s2's files land under its own root; the path-mapped fake proves the write went there.
    const remoteKey = path.join(s2.root!, 'mail', 'dkim', 'acme.test', 'wpl7.private');
    expect(fs.existsSync(remoteKey)).toBe(true);
  });

  it('lists every dev site under one dev domain instead of one row each', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    // Three dev sites and one customer domain. The dev domain is dev.example.test.
    seedSite(world, 'alpha', 'alpha.dev.example.test');
    seedSite(world, 'beta', 'beta.dev.example.test');
    seedSite(world, 'gamma', 'gamma.dev.example.test');
    seedSite(world, 'shop', 'shop.customer.test');
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'GET', url: '/api/mail/domains', headers });
    const domains = res.json().items as { domain: string; sites: string[] }[];
    // One key at the dev domain signs all of them via the *@*.<domain> signing entry, so
    // asking the operator for three separate DNS records would be busywork.
    expect(domains.map((d) => d.domain).sort()).toEqual(['dev.example.test', 'shop.customer.test']);
    expect(domains.find((d) => d.domain === 'dev.example.test')!.sites).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('lists a domain with no key as something to enable', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    seedSite(world, 'acme', 'acme.test');
    const { app, headers } = await authedApp(world);

    const res = await app.inject({ method: 'GET', url: '/api/mail/domains', headers });
    expect(res.statusCode).toBe(200);
    const domain = res.json().items.find((d: { domain: string }) => d.domain === 'acme.test');
    expect(domain).toMatchObject({ sites: ['acme'], dkimKey: null });
    expect(domain.dkim.verdict).toBe('missing');
    expect(domain.spf.verdict).toBe('missing');
    expect(domain.dmarc.verdict).toBe('missing');
    expect(domain.suggestedDmarc).toContain('p=none');
  });
});

describe('mail queue', () => {
  it('lists queued mail and attributes it to the sending site', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    seedSite(world, 'acme', 'acme.test');
    world.docker.logs.set(MAIL_CONTAINER, POSTFIX_LOG);
    await world.core.mail.ingestServer(1);

    world.docker.execQueue.push({
      stdout:
        '{"queue_name": "deferred", "queue_id": "C17462B13", "arrival_time": 1789710018, "message_size": 443, "sender": "wordpress@acme.test", "recipients": [{"address": "one@somewhere.test", "delay_reason": "Connection refused"}]}',
      stderr: '',
      exitCode: 0,
    });

    const { app, headers } = await authedApp(world);
    const res = await app.inject({ method: 'GET', url: '/api/mail/queue', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      queueId: 'C17462B13',
      queueName: 'deferred',
      siteSlug: 'acme',
      sender: 'wordpress@acme.test',
    });
  });

  it('flushes and deletes through postfix rather than touching the spool', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    const { app, headers } = await authedApp(world);

    expect((await app.inject({ method: 'POST', url: '/api/mail/queue/1/flush', headers })).statusCode).toBe(200);
    expect(world.docker.calls.some((c) => c.method === 'exec' && (c.args[1] as string[])?.[0] === 'postqueue')).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: '/api/mail/queue/1/C17462B13', headers });
    expect(del.statusCode).toBe(204);
    const postsuper = world.docker.calls.find((c) => c.method === 'exec' && (c.args[1] as string[])?.[0] === 'postsuper');
    expect(postsuper!.args[1]).toEqual(['postsuper', '-d', 'C17462B13']);
  });

  it('will not pass an arbitrary string to postsuper', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/mail/queue/1/..%2F..%2Fetc', headers });
    expect(res.statusCode).toBe(400);
  });
});

describe('mail test send', () => {
  it('hands the message to sendmail with the requested envelope sender', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    const { app, headers } = await authedApp(world);

    const res = await app.inject({
      method: 'POST',
      url: '/api/mail/test',
      headers,
      payload: { from: 'wordpress@acme.test', to: 'me@example.test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().detail).toContain('me@example.test');

    const call = world.docker.calls.find(
      (c) => c.method === 'exec' && String((c.args[1] as string[])?.[2] ?? '').includes('sendmail'),
    )!;
    const line = (call.args[1] as string[])[2]!;
    expect(line).toContain('sendmail -f wordpress@acme.test -- me@example.test');
    expect(line).toContain('Subject: WPL7 mail test');
  });

  it('refuses to send when the relay is down, with a reason', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    world.docker.containers.set(MAIL_CONTAINER, 'exited');
    const { app, headers } = await authedApp(world);
    const res = await app.inject({
      method: 'POST',
      url: '/api/mail/test',
      headers,
      payload: { from: 'a@acme.test', to: 'b@example.test' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('not running');
  });

  it('validates the addresses', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/mail/test',
      headers,
      payload: { from: 'not-an-address', to: 'b@example.test' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('mail retention', () => {
  it('drops traffic older than the retention window', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    const old = Date.now() - 40 * 24 * 3600_000;
    const recent = Date.now();
    for (const [queueId, ts] of [
      ['OLD000000001', old],
      ['NEW000000001', recent],
    ] as const) {
      world.db
        .insert(mailMessages)
        .values({ serverId: 1, queueId, toAddr: 'a@b.test', status: 'sent', firstSeenAt: ts, lastEventAt: ts })
        .run();
    }
    expect(world.core.mail.prune(30)).toBe(1);
    expect(world.db.select().from(mailMessages).all().map((r) => r.queueId)).toEqual(['NEW000000001']);
  });
});

describe('mail API auth', () => {
  it('requires a session', async () => {
    const { app } = await authedApp();
    for (const url of ['/api/mail/status', '/api/mail/messages', '/api/mail/queue', '/api/mail/domains']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });
});

describe('mail from the panel itself', () => {
  it('goes through sendmail in the relay, from the panel domain', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    relayRunning(world);
    expect(await world.core.mail.sendPanelMail('someone@example.test', 'Hello', 'A body.')).toBe(true);

    const call = world.docker.calls.find(
      (c) => c.method === 'exec' && String((c.args[1] as string[])?.[2] ?? '').includes('sendmail'),
    )!;
    const line = (call.args[1] as string[])[2]!;
    expect(line).toContain('sendmail -f wpl7-panel@panel.example.test -- someone@example.test');
    expect(line).toContain('Subject: [WPL7] Hello');
  });

  it('says so when the relay is not running', async () => {
    const world = await makeWorld({ resolver: emptyResolver });
    world.docker.containers.set(MAIL_CONTAINER, 'exited');
    expect(await world.core.mail.sendPanelMail('someone@example.test', 'Hello', 'A body.')).toBe(false);
  });

  it('prints the message instead in development, where there is often no relay at all', async () => {
    const world = await makeWorld({ resolver: emptyResolver, env: { NODE_ENV: 'development' } });
    world.docker.containers.set(MAIL_CONTAINER, 'exited');
    const info = vi.spyOn(world.core.log, 'info');
    expect(await world.core.mail.sendPanelMail('someone@example.test', 'Hello', 'Open https://x.test/#tok')).toBe(true);
    expect(info.mock.calls.map(([m]) => m).join('\n')).toContain('Open https://x.test/#tok');
  });
});
