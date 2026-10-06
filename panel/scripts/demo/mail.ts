/**
 * Mail: a DKIM key for every domain the sites send from (stand-in keys: the shape of a real one,
 * never used to sign anything), and a day of outbound traffic as the relays' logs would record it,
 * almost all delivered, a few deferred, one bounce. Recipients are example.net addresses.
 */
import { mailDkimKeys, mailMessages } from '../../src/db/schema.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, MINUTE, ago } from './clock.js';
import { SITES, rng, seedOf } from './data.js';
import { SIGNED_DOMAINS, demoDkimPublicKey } from './dnsRecords.js';

const SENDERS: Record<string, string[]> = {
  'northwind-bakery': ['orders@northwindbakery.example', 'wordpress@northwindbakery.example'],
  'ridge-outfitters': ['orders@ridgeoutfitters.example', 'support@ridgeoutfitters.example'],
  'pixel-press': ['newsletter@pixelpress.example', 'wordpress@pixelpress.example'],
};

const RECIPIENTS = ['jane.doe', 'a.moreau', 'k.tanaka', 'sales', 'info', 'm.schmidt', 'r.okafor', 'office', 'l.svensson', 'p.rossi'];
const RECIPIENT_DOMAINS = ['example.net', 'example.org', 'mail.example.net'];

export function seedMail(world: TestWorld): void {
  const live = SITES.filter((s) => s.domain && s.state === 'live');
  world.db.transaction((tx) => {
    // A key for every domain a site sends from, the dev domain included.
    for (const domain of SIGNED_DOMAINS) {
      const site = SITES.find((s) => s.domain === domain);
      tx.insert(mailDkimKeys)
        .values({
          domain,
          selector: 'wpl7',
          // A stand-in: the demo never signs, so it carries no real key.
          privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nDEMO-NOT-A-KEY\n-----END RSA PRIVATE KEY-----\n',
          publicKeyB64: demoDkimPublicKey(domain),
          createdAt: ago(((site?.ageDays ?? 300) - 1) * DAY),
        })
        .run();
    }

    let queue = 0x4b2a10;
    for (const site of live) {
      const next = rng(seedOf(`mail:${site.slug}`));
      const perDay = Math.max(4, Math.round(site.dailyVisitors / 18));
      const senders = SENDERS[site.slug] ?? [`wordpress@${site.domain}`];
      for (let i = 0; i < perDay; i++) {
        const at = ago(Math.round(next() * DAY));
        const roll = next();
        const status = roll < 0.94 ? 'sent' : roll < 0.985 ? 'deferred' : 'bounced';
        const to = `${RECIPIENTS[Math.floor(next() * RECIPIENTS.length)]}@${RECIPIENT_DOMAINS[Math.floor(next() * RECIPIENT_DOMAINS.length)]}`;
        queue += 17 + Math.floor(next() * 400);
        tx.insert(mailMessages)
          .values({
            serverId: site.server,
            queueId: queue.toString(16).toUpperCase().padStart(10, '0'),
            siteSlug: site.slug,
            clientHost: `wp-${site.slug}`,
            fromAddr: senders[Math.floor(next() * senders.length)]!,
            toAddr: to,
            sizeBytes: 3_000 + Math.round(next() * 40_000),
            nrcpt: 1,
            status,
            dsn: status === 'sent' ? '2.0.0' : status === 'deferred' ? '4.7.0' : '5.1.1',
            relay: `mx.${to.split('@')[1]}[198.51.100.${25 + Math.floor(next() * 40)}]:25`,
            delayMs: status === 'sent' ? 300 + Math.round(next() * 1500) : 30 * MINUTE,
            detail:
              status === 'sent'
                ? '250 2.0.0 OK'
                : status === 'deferred'
                  ? '421 4.7.0 Try again later, closing connection'
                  : '550 5.1.1 The email account that you tried to reach does not exist',
            dkimSigned: 1,
            dkimDomain: site.domain!,
            firstSeenAt: at,
            lastEventAt: status === 'deferred' ? Math.min(at + 30 * MINUTE, ago(MINUTE)) : at + 2_000,
          })
          .run();
      }
    }
    // The password reset a dev site sent this morning, from its dev hostname.
    tx.insert(mailMessages)
      .values({
        serverId: 2,
        queueId: '5C0FFEE042',
        siteSlug: 'summit-coffee',
        clientHost: 'wp-summit-coffee',
        fromAddr: 'wordpress@summit-coffee.dev.example.com',
        toAddr: 'office@example.org',
        sizeBytes: 4_120,
        nrcpt: 1,
        status: 'sent',
        dsn: '2.0.0',
        relay: 'mx.example.org[198.51.100.31]:25',
        delayMs: 640,
        detail: '250 2.0.0 OK',
        dkimSigned: 1,
        dkimDomain: 'dev.example.com',
        firstSeenAt: ago(2 * HOUR + 11 * MINUTE),
        lastEventAt: ago(2 * HOUR + 11 * MINUTE),
      })
      .run();
  });
}
