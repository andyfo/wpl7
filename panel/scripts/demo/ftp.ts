/**
 * FTP: one SFTP/FTP login on Harbor Yoga Studio, its server's gateway running, and the
 * connection details the FTP tab shows. The gateway's host keys and certificate are stand-ins:
 * real ones would be new on every run, so the tab shows fixed fingerprints instead.
 */
import { ftpServers, siteFtp, siteFtpUsers, type ServerRow } from '../../src/db/schema.js';
import type { FtpEndpointDto } from '../../shared/types.js';
import type { TestWorld } from '../../test/helpers.js';
import { DAY, HOUR, ago, DEMO_NOW } from './clock.js';
import { seedOf } from './data.js';
import { siteIds } from './sites.js';

const NOT_A_KEY = 'demo-stand-in-not-a-key';

/** A fingerprint in the shape ssh prints, the same on every run. */
function fingerprint(seed: string, bytes = 32): string {
  let out = '';
  let h = seedOf(seed);
  while (out.length < Math.ceil((bytes * 4) / 3)) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[h % 64];
  }
  return out.slice(0, 43);
}

/** A SHA-256 in the colon-separated hex the FTP tab shows, the same on every run. */
function hexPairs(seed: string): string {
  const out: string[] = [];
  let h = seedOf(seed);
  for (let i = 0; i < 32; i++) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    out.push((h & 0xff).toString(16).toUpperCase().padStart(2, '0'));
  }
  return out.join(':');
}

export function seedFtp(world: TestWorld): void {
  const siteId = siteIds.get('harbor-yoga')!;
  world.db.insert(ftpServers).values({ serverId: 2, hostKeyEd25519: NOT_A_KEY, hostKeyRsa: NOT_A_KEY, tlsCertPem: NOT_A_KEY, tlsKeyPem: NOT_A_KEY, createdAt: ago(80 * DAY) }).run();
  world.db.insert(siteFtp).values({ siteId, fileServerHostKey: NOT_A_KEY, clientKey: NOT_A_KEY, changedAt: ago(12 * DAY), rotatedAt: ago(12 * DAY), createdAt: ago(80 * DAY) }).run();
  world.db
    .insert(siteFtpUsers)
    .values({ siteId, username: 'harbor-yoga-web', passwordHash: NOT_A_KEY, folder: 'wp-content/themes', expiresAt: DEMO_NOW + 25 * DAY, createdBy: 'admin', passwordSetAt: ago(12 * DAY), createdAt: ago(12 * DAY), updatedAt: ago(12 * DAY) })
    .run();

  // Two private maps the FTP tick would fill, and the method that reads the gateway's keys.
  const ftp = world.core.ftp;
  const internals = ftp as unknown as {
    status: Map<number, { state: string; message: string | null; checkedAt: number | null; syncedAt: number | null }>;
    siteStatus: Map<number, { problem: string | null; syncedAt: number | null }>;
  };
  internals.status.set(2, { state: 'ready', message: null, checkedAt: ago(HOUR / 2), syncedAt: ago(HOUR / 2) });
  internals.siteStatus.set(siteId, { problem: null, syncedAt: ago(HOUR / 2) });
  const original = ftp.endpoint.bind(ftp);
  ftp.endpoint = (row: ServerRow): FtpEndpointDto => {
    const { ports, ftpReason } = ftp.ports(row);
    if (row.id !== 2) return original(row);
    return {
      host: row.publicIp,
      sftp: {
        port: ports.sftp,
        hostKeys: [
          { type: 'ssh-ed25519', fingerprint: `SHA256:${fingerprint(`ed25519:${row.name}`)}` },
          { type: 'ssh-rsa', fingerprint: `SHA256:${fingerprint(`rsa:${row.name}`)}` },
        ],
      },
      ftp: {
        available: ports.ftp !== null,
        reason: ftpReason,
        port: ports.ftp?.port ?? 21,
        passivePorts: { start: ports.ftp?.passiveStart ?? 30000, end: ports.ftp?.passiveEnd ?? 30015 },
        certFingerprint: hexPairs(`cert:${row.name}`),
      },
    };
  };
}
