import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from './index.js';
import { plugins, servers, sessions, settings } from './schema.js';
import type { Config } from '../config.js';
import { SettingsService } from '../services/settings.js';
import { UsersService, type TotpEnrollment, type TotpState } from '../services/users.js';
import { generatePassword } from '../lib/crypto.js';
import { DEFAULT_DETECTION_RULES, DEFAULT_TRUSTED_PROXIES } from '../../shared/security.js';

export interface SeedResult {
  /**
   * A password this boot made up for the owner, to be printed once (src/index.ts). Null
   * when there was nothing to seed, or when PANEL_ADMIN_PASSWORD supplied it.
   */
  generatedOwnerPassword: { username: string; password: string; reason: 'first-boot' | 'reset' } | null;
  /** The login from before accounts existed was turned into the owner on this boot. */
  adoptedLegacyAdmin: boolean;
}

/**
 * Where the one login lived before there were accounts. Read once, to adopt it, and deleted
 * in the same transaction.
 */
const LEGACY_ADMIN_KEYS = ['admin.username', 'admin.passwordHash', 'admin.totp', 'admin.totpEnrollment'];

/**
 * First-boot seeding: the owner account + default settings + default plugin catalog.
 * Idempotent - existing values are never overwritten, so a stale PANEL_ADMIN_PASSWORD
 * in the environment cannot silently reset the password on later boots. The one exception
 * is asked for by hand: an owner whose password hash was blanked gets a fresh one.
 */
export async function seed(db: Db, config: Config): Promise<SeedResult> {
  const s = new SettingsService(db);
  const result = await seedOwner(db, config, s);

  // Server 1 = the machine the panel runs on (created by migration 0001 with sentinel-empty
  // fields). Fill the sentinels from env once; after that the row is the source of truth and
  // UI edits stick even if the env changes.
  const local = db.select().from(servers).where(eq(servers.id, 1)).get();
  if (local) {
    const patch: Record<string, unknown> = {};
    if (!local.publicIp && config.serverPublicIp) patch.publicIp = config.serverPublicIp;
    if (!local.devDomain) patch.devDomain = config.devDomain;
    if (!local.dnsProvider && config.dnsProvider) patch.dnsProvider = config.dnsProvider;
    // BACKUP_ROOT is what the compose overlay mounts into the panel container, so it has
    // to agree with the row: adopting it once keeps "the operator edited .env" working,
    // while later edits in the panel stay authoritative.
    if (!local.backupRoot && config.backupRoot) patch.backupRoot = config.backupRoot;
    if (!local.createdAt) {
      patch.createdAt = Date.now();
      patch.updatedAt = Date.now();
    }
    if (Object.keys(patch).length > 0) {
      db.update(servers).set(patch).where(eq(servers.id, 1)).run();
    }
  }

  const d = config.seedDefaults;
  s.seedRaw('site.defaultServerId', 1);
  s.seedRaw('dns.wildcardServerId', 1);
  s.seedRaw('backup.cron', d.backupCron);
  s.seedRaw('backup.retention', d.backupRetention);
  s.seedRaw('monitor.uptimeIntervalSec', 60);
  s.seedRaw('monitor.statsIntervalSec', 60);
  s.seedRaw('monitor.duIntervalMin', 30);
  s.seedRaw('monitor.retentionDays', 7);
  s.seedRaw('jobs.retentionDays', 90);
  s.seedRaw('mail.retentionDays', 30);
  // The API log is per-request rather than per-day, so it grows with whatever polls the
  // panel. Thirty days covers "what did that integration do last month" without letting a
  // busy client's chatter dominate the database.
  s.seedRaw('apiActivity.retentionDays', 30);
  // Longer than the other retentions on purpose: a traffic chart is worth little without
  // last quarter's numbers to compare this one against, and the rollups are tiny.
  s.seedRaw('traffic.retentionDays', 90);
  // Addresses are the one piece of personal data here, so they expire on their own much
  // shorter clock - long enough to investigate last week's abuse, no longer.
  s.seedRaw('traffic.ipRetentionDays', 7);
  s.seedRaw('traffic.storeIps', true);
  s.seedRaw('mail.alertPerSitePerHour', 200);
  s.seedRaw('mail.suspendPerSitePerHour', 1000);
  s.seedRaw('alerts.email', '');
  s.seedRaw('site.cpuLimit', 2);
  s.seedRaw('site.memoryLimitMb', 512);
  s.seedRaw('site.pidsLimit', 512);
  s.seedRaw('site.defaultPhpVersion', d.defaultPhpVersion);
  s.seedRaw('site.defaultLocale', d.defaultLocale);
  s.seedRaw('site.defaultAdminEmail', '');
  s.seedRaw('site.phpVersions', d.phpVersions);
  // Six hours: a plugin release an operator should know about is hours-old news, and each
  // pass costs one wp-cli call per site plus one wordpress.org check per install.
  s.seedRaw('wp.scanIntervalHours', 6);
  // On by default, and the Settings card says exactly what is sent (slugs and versions,
  // never site names) so the default is an informed one rather than a surprise.
  s.seedRaw('wp.vulnerabilityFeed', true);
  // No FTP login exists on a fresh install, so none of these open anything until one does.
  // 16 passive ports under the 32768 ephemeral range: one docker-proxy each, and plenty for
  // the handful of FTP clients a server sees at once.
  s.seedRaw('ftp.enabled', true);
  s.seedRaw('ftp.sftpPort', 2222);
  s.seedRaw('ftp.offerFtps', true);
  s.seedRaw('ftp.ftpPort', 21);
  s.seedRaw('ftp.passivePortStart', 30000);
  s.seedRaw('ftp.passivePortEnd', 30015);
  // Cloudflare's header is believed from Cloudflare's own ranges only, so trusting it by
  // default costs nothing on a site that is not behind it - and makes every visitor of one that
  // is someone other than a Cloudflare server.
  s.seedRaw('security.trustedProxies', DEFAULT_TRUSTED_PROXIES);
  // Standard for every site, including those that exist on the day this is installed: its
  // rules refuse only what no visitor asks for, and its limits are far above what a person
  // produces. Off, per site or fleet-wide, takes all of it away again within a minute.
  s.seedRaw('security.level', 'standard');
  s.seedRaw('security.overrides', {});
  s.seedRaw('security.bypassPrivate', true);
  s.seedRaw('security.autoBlock', 'on');
  s.seedRaw('security.enforcement', true);
  s.seedRaw('security.rules', DEFAULT_DETECTION_RULES);
  // An hour, then four times as long per repeat within 30 days, never beyond 30 days.
  s.seedRaw('security.blockMinutes', 60);
  s.seedRaw('security.blockMultiplier', 4);
  s.seedRaw('security.blockMaxDays', 30);
  // Well inside what a network set and the HTTP fallback file hold without effort.
  s.seedRaw('security.maxActiveBlocks', 10_000);
  s.seedRaw('security.historyDays', 30);
  // Daily, with both engines, reporting rather than moving anything: the step up to
  // quarantine is one an operator takes having seen what their sites look like.
  s.seedRaw('scan.enabled', true);
  s.seedRaw('scan.signatures', true);
  s.seedRaw('scan.intervalHours', 24);
  s.seedRaw('scan.onFinding', 'report');
  s.seedRaw('scan.memoryMb', 512);
  s.seedRaw('scan.timeoutMin', 30);
  s.seedRaw('scan.quarantineKeepDays', 0);
  // Off until someone switches it on: an AI app that can reach the panel is a decision.
  s.seedRaw('mcp.enabled', false);

  // Guarded by a marker rather than by "is the table empty": emptying the catalog on
  // purpose is a normal thing to do, and the emptiness test silently re-seeded it from
  // WP_DEFAULT_PLUGINS on the next restart, every restart.
  if (!s.getRaw('plugins.seeded')) {
    const alreadyPopulated = db.select({ id: plugins.id }).from(plugins).limit(1).all().length > 0;
    if (!alreadyPopulated && d.defaultPlugins.length > 0) {
      const now = Date.now();
      for (const slug of d.defaultPlugins) {
        db.insert(plugins)
          .values({ kind: 'wporg', slug, name: slug, isDefault: 1, createdAt: now })
          .onConflictDoNothing()
          .run();
      }
    }
    // Set on the upgrade path too, so an existing (possibly curated) catalog is adopted
    // as-is rather than topped up on the next boot.
    s.setRaw('plugins.seeded', true);
  }

  return result;
}

async function seedOwner(db: Db, config: Config, s: SettingsService): Promise<SeedResult> {
  const users = new UsersService(db);
  const none: SeedResult = { generatedOwnerPassword: null, adoptedLegacyAdmin: false };

  if (users.count() > 0) {
    // `update users set password_hash = '' where is_owner = 1`, then a restart: the owner's
    // way back in when nobody else may reset their password (docs/troubleshooting.md). The
    // name and the second factor stay as they are; only the password is new.
    const owner = users.owner();
    if (!owner || owner.passwordHash !== '') return none;
    const { password, generated } = initialPassword(config);
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    users.setPasswordHash(owner.id, hash);
    users.revokeSessions(owner.id);
    return {
      ...none,
      generatedOwnerPassword: generated ? { username: owner.username, password, reason: 'reset' } : null,
    };
  }

  const legacyName = s.getRaw('admin.username');
  const legacyHash = s.getRaw('admin.passwordHash');
  const legacyTotp = (s.getRaw('admin.totp') as TotpState | undefined) ?? null;
  if (typeof legacyName === 'string' && typeof legacyHash === 'string') {
    // An install from before accounts: its one login becomes the owner exactly as it was -
    // name, password and second factor - and the sessions it has open are handed over with
    // it, so the update signs nobody out.
    const legacyEnrollment = (s.getRaw('admin.totpEnrollment') as TotpEnrollment | undefined) ?? null;
    db.transaction(() => {
      const owner = users.create({
        username: legacyName,
        passwordHash: legacyHash,
        isOwner: true,
        totp: legacyTotp,
        totpEnrollment: legacyEnrollment,
      });
      for (const row of db.select().from(sessions).all()) {
        const data = { ...(JSON.parse(row.data) as object), userId: owner.id, generation: owner.sessionGeneration };
        db.update(sessions)
          .set({ data: JSON.stringify(data), userId: owner.id })
          .where(eq(sessions.sid, row.sid))
          .run();
      }
      db.delete(settings).where(inArray(settings.key, LEGACY_ADMIN_KEYS)).run();
    });
    return { ...none, adoptedLegacyAdmin: true };
  }

  // First boot. Or a database whose old login had its hash deleted by hand - the recovery
  // recipe before accounts - which came back with the bootstrap name and whatever second
  // factor was still there, so that is what it gets here too. Any session left over belongs
  // to a login that no longer exists.
  const { password, generated } = initialPassword(config);
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  db.transaction(() => {
    users.create({ username: config.adminUser, passwordHash: hash, isOwner: true, totp: legacyTotp });
    db.delete(settings).where(inArray(settings.key, LEGACY_ADMIN_KEYS)).run();
    db.delete(sessions).run();
  });
  return {
    ...none,
    generatedOwnerPassword: generated ? { username: config.adminUser, password, reason: 'first-boot' } : null,
  };
}

/** PANEL_ADMIN_PASSWORD when the environment has one; otherwise one to print once. */
function initialPassword(config: Config): { password: string; generated: boolean } {
  return config.adminInitialPassword
    ? { password: config.adminInitialPassword, generated: false }
    : { password: generatePassword(20), generated: true };
}
