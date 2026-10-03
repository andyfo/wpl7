import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mailMessages, sites } from '../../src/db/schema.js';
import { makeWorld, type TestWorld } from '../helpers.js';
import {
  mailAuthPaths,
  mailLogin,
  parseSaslUsers,
  renderMsmtprc,
  renderSaslBlock,
  renderSenderLogin,
  RESERVED_LOGIN,
} from '../../src/services/mailAuth.js';
import { DKIM_CONTAINER, mailPaths } from '../../src/services/mail.js';

const execLines = (w: TestWorld): string[] =>
  w.docker.calls.filter((c) => c.method === 'exec').map((c) => (c.args[1] as string[]).join(' '));

function addSite(w: TestWorld, slug: string, domains: string[], devHostname: string | null = null): void {
  const now = Date.now();
  w.db
    .insert(sites)
    .values({
      slug,
      serverId: 1,
      title: slug,
      domains: JSON.stringify(domains),
      devHostname,
      phpVersion: '8.3',
      status: 'running',
      dbName: `wp_${slug}`,
      dbUser: `wp_${slug}`,
      dbPassword: 'x',
      mailPassword: `pw-${slug}`,
      containerName: `wp-${slug}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe('relay authorization maps', () => {
  it('maps every sender domain to the login that owns it', () => {
    const out = renderSenderLogin([
      { domain: 'Beta.example', login: 'beta@wpl7' },
      { domain: 'alpha.example', login: 'alpha@wpl7' },
      { domain: 'alpha.example', login: 'someone-else@wpl7' },
    ]);
    // `@domain` covers every local part, which is what WordPress sends as (wordpress@<host>).
    // First writer wins on a duplicate: one domain is owned by one site, never two.
    // Each owner is listed under both realms until the rename is finished everywhere
    // (LEGACY(ceo)); postfix reads the value as a list, so either login is accepted.
    expect(out).toBe('@alpha.example\talpha@wpl7,alpha@ceo\n@beta.example\tbeta@wpl7,beta@ceo\n');
  });

  it('parks an orphan DKIM domain on a login nobody holds, with no legacy twin', () => {
    // RESERVED_LOGIN is not a site login, so it gets no pre-rename counterpart to mint.
    expect(renderSenderLogin([{ domain: 'gone.example', login: RESERVED_LOGIN }])).toBe(
      `@gone.example\t${RESERVED_LOGIN}\n`,
    );
  });

  it('cannot be tricked into a second entry by a newline in a suspension reason', () => {
    const out = renderSaslBlock([
      { login: 'alpha@wpl7', reason: 'Sent 5000\n@victim.example\tattacker@wpl7' },
    ]);
    // Two lines, and only two: this site's login under each realm (LEGACY(ceo)). The
    // injected "@victim.example" ends up inside a reason, never at the start of a line.
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => /^alpha@(wpl7|ceo)\tREJECT /.test(l))).toBe(true);
    expect(out).toContain('alpha@wpl7\tREJECT Sent 5000 @victim.example attacker@wpl7');
    expect(out).toContain('alpha@ceo\tREJECT Sent 5000 @victim.example attacker@wpl7');
  });

  it('renders an msmtp config the site authenticates with', () => {
    const out = renderMsmtprc('alpha@wpl7', 's3cret');
    expect(out).toContain('host mail');
    // Named explicitly: `auth on` makes msmtp refuse PLAIN on an unencrypted hop, which is
    // every hop here, so mail would never leave the container.
    expect(out).toContain('auth plain');
    expect(out).toContain('user alpha@wpl7');
    expect(out).toContain('password s3cret');
  });

  it('reads back the logins a relay already holds', () => {
    expect(parseSaslUsers('alpha@wpl7: userPassword\nbeta@wpl7: userPassword\n\n')).toEqual(['alpha@wpl7', 'beta@wpl7']);
    expect(parseSaslUsers('')).toEqual([]);
  });
});

describe('sender ownership', () => {
  it('gives a site every hostname it answers to, and parks orphan DKIM domains', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example', 'www.alpha.example'], 'alpha.dev.example.test');
    w.core.mail.createDkimKey('alpha.example');
    w.core.mail.createDkimKey('gone.example'); // key kept after its site was deleted

    const owners = w.core.mail.senderOwners();
    const byDomain = new Map(owners.map((o) => [o.domain, o.login]));
    expect(byDomain.get('alpha.example')).toBe('alpha@wpl7');
    expect(byDomain.get('www.alpha.example')).toBe('alpha@wpl7');
    expect(byDomain.get('alpha.dev.example.test')).toBe('alpha@wpl7');
    // A domain that can still be DKIM-signed but belongs to no site is owned by nobody, so
    // no site can authenticate as its owner - the spoofing hole this all exists to close.
    expect(byDomain.get('gone.example')).toBe(RESERVED_LOGIN);
  });
});

describe('the owners the DKIM signer holds a From: header to', () => {
  it('are published with every relay publish, twins and go-live extras included', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example'], 'alpha.dev.test');
    await w.core.mail.syncMailAuthTo(1, { extraOwners: [{ domain: 'new.alpha.example', login: mailLogin('alpha') }] });
    // The signer reads this file for each message: the same owners the relay holds the
    // envelope to, so a site gets signatures only for what it may send as.
    expect(fs.readFileSync(mailPaths(w.config).senderLogins, 'utf8').trim().split('\n')).toEqual([
      'alpha@ceo/alpha.dev.test',
      'alpha@ceo/alpha.example',
      'alpha@ceo/new.alpha.example',
      'alpha@wpl7/alpha.dev.test',
      'alpha@wpl7/alpha.example',
      'alpha@wpl7/new.alpha.example',
    ]);
  });

  it('brings a signer up to date at boot only where its config differs, and restarts only that one', async () => {
    const w = await makeWorld();
    w.docker.containers.set(DKIM_CONTAINER, 'running');
    const restarts = () => w.docker.calls.filter((c) => c.method === 'restartContainer' && c.args[0] === DKIM_CONTAINER).length;

    // A server still carrying the config of a panel from before the signing policy.
    const p = mailPaths(w.config);
    fs.mkdirSync(p.dkimDir, { recursive: true });
    fs.writeFileSync(p.opendkimConf, 'SigningTable refile:/etc/opendkim/keys/SigningTable\n');
    fs.writeFileSync(path.join(p.dkimDir, 'SigningTable'), '*@alpha.example wpl7._domainkey.alpha.example\n');
    expect(await w.core.mail.convergeSigners()).toEqual([{ name: expect.any(String), synced: true }]);
    expect(restarts()).toBe(1);
    expect(fs.readFileSync(p.opendkimConf, 'utf8')).toContain('SetupPolicyScript');
    // The old table goes with it: a leftover would be the next thing someone reads.
    expect(fs.existsSync(path.join(p.dkimDir, 'SigningTable'))).toBe(false);

    // Current now: nothing written, nothing restarted.
    expect(await w.core.mail.convergeSigners()).toEqual([{ name: expect.any(String), synced: false }]);
    expect(restarts()).toBe(1);
  });
});

describe('syncMailAuthTo', () => {
  it('publishes the maps and creates the missing login', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);

    const res = await w.core.mail.syncMailAuthTo(1);

    const p = mailAuthPaths(w.config);
    expect(fs.readFileSync(p.senderLogin, 'utf8')).toBe('@alpha.example\talpha@wpl7,alpha@ceo\n');
    expect(fs.readFileSync(p.saslBlock, 'utf8')).toBe('');
    expect(fs.readFileSync(p.smtpdConf, 'utf8')).toContain('sasldb_path: /etc/postfix/sasl/sasldb2');

    const lines = execLines(w);
    expect(lines.some((l) => l.includes('saslpasswd2 -p -c') && l.includes('-u ') && l.includes('alpha'))).toBe(true);
    // Without the chmod, smtpd (which runs unprivileged) cannot open the db and every
    // login fails - so it is part of the contract, not an afterthought.
    expect(lines.some((l) => l.includes('chmod 640') && l.includes('sasldb2'))).toBe(true);
    expect(lines).toContain('postfix reload');
    // One credential per realm while the rename is in flight (LEGACY(ceo)).
    expect(res.written).toBe(2);
    expect(res.reloaded).toBe(true);
  });

  it('writes each realm with its own -u, not the current one twice', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);

    await w.core.mail.syncMailAuthTo(1);

    const mints = execLines(w).filter((l) => l.includes('saslpasswd2 -p -c'));
    // A hardcoded realm here would write "alpha" twice under wpl7 and leave the login the
    // site is still presenting without a password.
    expect(mints.some((l) => l.includes("-u 'wpl7' 'alpha'"))).toBe(true);
    expect(mints.some((l) => l.includes("-u 'ceo' 'alpha'"))).toBe(true);
  });

  it('does not rewrite a credential the relay already has', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);
    w.docker.relayAuthResult = {
      stdout: 'alpha@wpl7: userPassword\nalpha@ceo: userPassword\n',
      stderr: '',
      exitCode: 0,
    };

    const res = await w.core.mail.syncMailAuthTo(1);
    expect(res.written).toBe(0);
    expect(res.removed).toBe(0);
    expect(execLines(w).some((l) => l.includes('saslpasswd2 -p -c'))).toBe(false);

    // ...unless the caller says the password changed (a reconcile that just minted one).
    w.docker.calls.length = 0;
    const forced = await w.core.mail.syncMailAuthTo(1, { forceLogins: ['alpha@wpl7'] });
    expect(forced.written).toBe(1);
  });

  it('revokes a login whose site is gone', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);
    w.docker.relayAuthResult = { stdout: 'alpha@wpl7: userPassword\nghost@wpl7: userPassword\n', stderr: '', exitCode: 0 };

    const res = await w.core.mail.syncMailAuthTo(1);

    expect(res.removed).toBe(1);
    expect(execLines(w).some((l) => l.includes('saslpasswd2 -d') && l.includes('ghost'))).toBe(true);
  });

  it('installs no credentials against a relay that has none (mailpit in local dev)', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);
    w.docker.relayHasSasl = false;

    const res = await w.core.mail.syncMailAuthTo(1);

    expect(res.written).toBe(0);
    expect(execLines(w).some((l) => l.includes('saslpasswd2 -p -c'))).toBe(false);
    // The maps are still published, so switching that server to postfix needs no extra step.
    expect(fs.readFileSync(mailAuthPaths(w.config).senderLogin, 'utf8')).toContain('alpha@wpl7');
  });

  it('stages the maps even when the relay is not running here', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);
    w.docker.containers.delete('wpl7-mail');

    const res = await w.core.mail.syncMailAuthTo(1);

    expect(res.reloaded).toBe(false);
    // Files still land, so the relay picks them up the moment it starts.
    expect(fs.readFileSync(mailAuthPaths(w.config).senderLogin, 'utf8')).toContain('alpha@wpl7');
  });

  it('authorizes a domain that is mid-go-live', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.dev.example.test']);

    await w.core.mail.syncMailAuthTo(1, {
      extraOwners: [{ domain: 'customer.example', login: mailLogin('alpha') }],
    });

    const map = fs.readFileSync(mailAuthPaths(w.config).senderLogin, 'utf8');
    expect(map).toContain('@customer.example\talpha@wpl7');
    expect(map).toContain('@alpha.dev.example.test\talpha@wpl7');
  });
});

describe('mail abuse guard', () => {
  function logMessages(w: TestWorld, slug: string, n: number): void {
    const now = Date.now();
    const rows = Array.from({ length: n }, (_, i) => ({
      serverId: 1,
      queueId: `Q${slug}${i}`,
      siteSlug: slug,
      fromAddr: `wordpress@${slug}.example`,
      toAddr: `victim${i}@elsewhere.test`,
      status: 'sent' as const,
      firstSeenAt: now,
      lastEventAt: now,
    }));
    // A thousand rows to a statement, well inside SQLite's limit on bound parameters.
    for (let i = 0; i < rows.length; i += 1000) w.db.insert(mailMessages).values(rows.slice(i, i + 1000)).run();
  }

  it('suspends a site that sends like a spam run, and tells the relay', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);
    w.deps.settings.update({ mailSuspendPerSitePerHour: 10 });
    logMessages(w, 'alpha', 11);

    const { suspended } = await w.core.mail.enforceVolumeLimits();

    expect(suspended).toEqual(['alpha']);
    const row = w.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!;
    expect(row.mailSuspendedAt).toBeTruthy();
    expect(row.mailSuspendReason).toContain('11 messages');
    // The block map is the part that actually stops the mail.
    expect(fs.readFileSync(mailAuthPaths(w.config).saslBlock, 'utf8')).toContain('alpha@wpl7\tREJECT');
  });

  it('leaves a busy-but-not-abusive site alone', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);
    w.deps.settings.update({ mailSuspendPerSitePerHour: 10 });
    logMessages(w, 'alpha', 10);

    expect((await w.core.mail.enforceVolumeLimits()).suspended).toEqual([]);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!.mailSuspendedAt).toBeNull();
  });

  it('counts only the last hour', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);
    w.deps.settings.update({ mailSuspendPerSitePerHour: 5 });
    const old = Date.now() - 2 * 3600_000;
    for (let i = 0; i < 20; i++) {
      w.db
        .insert(mailMessages)
        .values({
          serverId: 1,
          queueId: `OLD${i}`,
          siteSlug: 'alpha',
          fromAddr: 'wordpress@alpha.example',
          toAddr: `x${i}@elsewhere.test`,
          status: 'sent',
          firstSeenAt: old,
          lastEventAt: old,
        })
        .run();
    }
    expect((await w.core.mail.enforceVolumeLimits()).suspended).toEqual([]);
  });

  it('can be turned off', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);
    w.deps.settings.update({ mailSuspendPerSitePerHour: 0 });
    logMessages(w, 'alpha', 5000);

    expect((await w.core.mail.enforceVolumeLimits()).suspended).toEqual([]);
  });

  it('does not re-suspend, and resuming clears the block', async () => {
    const w = await makeWorld();
    addSite(w, 'alpha', ['alpha.example']);
    w.deps.settings.update({ mailSuspendPerSitePerHour: 10 });
    logMessages(w, 'alpha', 11);
    await w.core.mail.enforceVolumeLimits();
    const firstSuspendedAt = w.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!.mailSuspendedAt;

    expect((await w.core.mail.enforceVolumeLimits()).suspended).toEqual([]);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!.mailSuspendedAt).toBe(firstSuspendedAt);

    const site = w.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!;
    await w.core.mail.setSiteMailSuspended(site.id, false);

    expect(w.db.select().from(sites).where(eq(sites.slug, 'alpha')).get()!.mailSuspendedAt).toBeNull();
    expect(fs.readFileSync(mailAuthPaths(w.config).saslBlock, 'utf8')).toBe('');
  });
});
