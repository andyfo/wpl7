/**
 * FTP and SFTP logins for a site's files.
 *
 * The rule every other way into a site's files follows (services/siteFiles.ts): they are
 * only ever touched from a mount namespace that holds that ONE site's files, as its own
 * user. A compromised site's PHP can plant symlinks, and uid 33 is every site on the host,
 * so one FTP server with /srv/sites mounted would be one race away from every site on the
 * box - SFTPGo resolves symlinks in userspace and says in its SECURITY.md that races in that
 * are not vulnerabilities.
 *
 * So there are two kinds of SFTPGo container per server (services/ftpConfig.ts):
 * - the **gateway** `wpl7-ftp`, the only one with published ports: it speaks SFTP and FTPS,
 *   checks passwords and bans brute force, and has no site files mounted at all;
 * - a **file server** `wpl7-ftp-<slug>` per site with logins: SFTP on an internal network,
 *   as uid 33, with that site's folder and nothing else. Every login's filesystem on the
 *   gateway is SFTP to its own site's file server, with a key only that site's file server
 *   accepts and a host key the gateway pins.
 *
 * An FTP login can therefore do nothing the site's own PHP could not, and nothing that can be
 * reached from the network holds the Docker socket or root.
 *
 * Nothing runs until a site has a login. The panel database is the truth; `syncServer` makes
 * a server match it - files under ${SRV_ROOT}/ftp, then the containers - and is safe to run
 * any number of times. Changes kick it at once; a tick catches everything else.
 */
// @docs help/troubleshooting, sites/ftp-sftp
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { and, count, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  ftpServers,
  siteFtp,
  siteFtpUsers,
  sites,
  type FtpServerRow,
  type ServerRow,
  type SiteFtpRow,
  type SiteFtpUserRow,
  type SiteRow,
} from '../db/schema.js';
import type { Config } from '../config.js';
import { conflict, notFound } from '../lib/errors.js';
import { certPemSha256, selfSignedCert } from '../lib/x509.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import { ServerUnreachableError } from '../servers/sshConnection.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';
import { sitePaths } from './siteSpec.js';
import { generateFtpPassword, hashFtpPassword, newSshKeyPair, sshKeyFacts } from './ftpKeys.js';
import {
  FILES,
  FTP_EDGE_NETWORK,
  FTP_GATEWAY_CONTAINER,
  FTP_GATEWAY_UID,
  FTP_NETWORK,
  FTP_ROLE_FILES,
  FTP_ROLE_GATEWAY,
  SITE_UID,
  fileServerSpec,
  ftpFileServerContainer,
  ftpPaths,
  gatewaySpec,
  renderFileServerConfig,
  renderFileServerUsers,
  renderGatewayConfig,
  renderGatewayUsers,
  toJson,
  type FtpPaths,
  type FtpPorts,
  type GatewayLogin,
} from './ftpConfig.js';
import type {
  FtpEndpointDto,
  FtpServerStatusDto,
  FtpServiceState,
  FtpStatusDto,
  SiteFtpDto,
  SiteFtpUserDto,
} from '../../shared/types.js';
import { hostedSites } from '../lib/siteKind.js';

const GATEWAY_OWNER = { uid: FTP_GATEWAY_UID, gid: FTP_GATEWAY_UID };
const SITE_OWNER = { uid: SITE_UID, gid: SITE_UID };
/** Statuses whose files are not there to serve (being made, being removed). */
const NO_FILES = ['provisioning', 'deleting'];
/** A server that is already right is re-checked this often (a stopped container, a lost file). */
const RECHECK_MS = 5 * 60_000;
/** How long after a failed build of the SFTPGo image before a sync tries it again. */
const BUILD_RETRY_MS = 15 * 60_000;
/** On the build stage of deploy/sftpgo-image: what a build leaves behind, and what is pruned. */
const BUILD_STAGE_LABEL = 'wpl7.build=sftpgo';

/** The gateway's own state on a server. */
interface ServerStatus {
  state: FtpServiceState;
  message: string | null;
  /** When the sync that found this state started; null = none has finished since the panel started. */
  checkedAt: number | null;
  /** When the last sync that got the gateway right started. */
  syncedAt: number | null;
}

/**
 * One site's part of its server's sync. Kept apart from the server's, so that one site whose
 * file server cannot start (its files missing, say) is that site's error - not every site's
 * on the server, and not a reason to call everyone else's changes unapplied.
 */
interface SiteStatus {
  problem: string | null;
  /** When the last sync that left this site right started; what "applied" is measured against. */
  syncedAt: number | null;
}

export interface FtpServiceOpts {
  /** Coalescing window for kicks; 0 in tests. */
  debounceMs?: number;
  /**
   * How long a container that was just started gets before it is judged: SFTPGo takes a moment
   * to listen, and one handed a config it refuses exits within it. 0 in tests.
   */
  settleMs?: number;
}

export interface FtpUserInput {
  username: string;
  /** Absent = generate one (and hand it back, once). */
  password?: string;
  folder: string;
  expiresAt: number | null;
}

export class FtpService {
  private readonly status = new Map<number, ServerStatus>();
  private readonly siteStatus = new Map<number, SiteStatus>();
  /**
   * Servers where FTP's ports could not be published (port 21 held by another FTP server, a
   * passive port in use): their gateway runs SFTP alone rather than not at all. Cleared when
   * the settings or the server's address change, which is when trying again can help.
   */
  private readonly ftpBlocked = new Map<number, string>();
  /** Per server: the sync (or pause) in progress, which the next one waits for. */
  private readonly chains = new Map<number, Promise<void>>();
  /** Per server: a kicked sync that has not started yet - later kicks ride along with it. */
  private readonly waiting = new Map<number, Promise<void>>();
  /** Sites a restore, move or delete has paused (count, as those can overlap). */
  private readonly paused = new Map<number, number>();
  /** `<serverId>:<path>` -> digest of what was last written there, so an unchanged file is not rewritten. */
  private readonly written = new Map<string, string>();
  /** Per server: the users file the gateway last loaded. */
  private readonly loadedUsers = new Map<number, string>();
  /**
   * Per server: the last failed build of the SFTPGo image - when, what it said, and how many
   * changes had asked for a sync by then. Until BUILD_RETRY_MS have passed, only a sync that a
   * change made after the failure asks for builds again.
   */
  private readonly buildFailed = new Map<number, { at: number; message: string; changes: number }>();
  /** Per server: how many changes (not ticks) have asked for a sync so far. */
  private readonly changes = new Map<number, number>();
  private readonly debounceMs: number;
  private readonly settleMs: number;
  readonly paths: FtpPaths;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly settings: SettingsService,
    private readonly log: Logger,
    opts: FtpServiceOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 250;
    this.settleMs = opts.settleMs ?? 1500;
    this.paths = ftpPaths(config);
  }

  // ------------------------------------------------------------------ logins

  usersOf(siteId: number): SiteFtpUserRow[] {
    return this.db.select().from(siteFtpUsers).where(eq(siteFtpUsers.siteId, siteId)).orderBy(siteFtpUsers.username).all();
  }

  hasLogins(siteId: number): boolean {
    return (this.db.select({ n: count() }).from(siteFtpUsers).where(eq(siteFtpUsers.siteId, siteId)).get()?.n ?? 0) > 0;
  }

  private userOf(site: SiteRow, id: number): SiteFtpUserRow {
    const row = this.db.select().from(siteFtpUsers).where(eq(siteFtpUsers.id, id)).get();
    // Another site's login is "not found" from here, not "forbidden": nothing about it leaks.
    if (!row || row.siteId !== site.id) throw notFound(`FTP login #${id} not found on "${site.slug}"`);
    return row;
  }

  private assertUsernameFree(username: string): void {
    const taken = this.db.select({ id: siteFtpUsers.id }).from(siteFtpUsers).where(eq(siteFtpUsers.username, username)).get();
    // Unique across the panel, and the answer does not say which site has it.
    if (taken) throw conflict(`The FTP username "${username}" is taken`);
  }

  async createUser(site: SiteRow, input: FtpUserInput, createdBy: string | null): Promise<{ user: SiteFtpUserDto; password: string | null }> {
    this.assertUsernameFree(input.username);
    const password = input.password ?? generateFtpPassword();
    // The slow parts (hashing, key generation) happen before the transaction, never in it.
    const hash = await hashFtpPassword(password);
    // Made whether or not the site has a link already: the one it has may be gone by the time
    // the transaction runs (its last login deleted meanwhile), and a login without a link is
    // one no server would serve. Two ed25519 keys cost next to nothing.
    const link = await this.newLink();
    const now = Date.now();
    const row = this.db.transaction((tx) => {
      this.assertUsernameFree(input.username);
      if (!tx.select().from(siteFtp).where(eq(siteFtp.siteId, site.id)).get()) {
        tx.insert(siteFtp).values({ siteId: site.id, ...link, changedAt: now, rotatedAt: now, createdAt: now }).run();
      } else {
        tx.update(siteFtp).set({ changedAt: now }).where(eq(siteFtp.siteId, site.id)).run();
      }
      return tx
        .insert(siteFtpUsers)
        .values({
          siteId: site.id,
          username: input.username,
          passwordHash: hash,
          folder: input.folder,
          expiresAt: input.expiresAt,
          createdBy,
          passwordSetAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    });
    void this.kick(site.serverId);
    return { user: this.userToDto(row), password: input.password === undefined ? password : null };
  }

  /**
   * A new folder or expiry. Always taken as narrowing access (the key is rotated): whether a
   * change widens or narrows it is a judgement this does not need to make.
   */
  async updateUser(site: SiteRow, id: number, patch: { folder?: string; expiresAt?: number | null }): Promise<SiteFtpUserDto> {
    this.userOf(site, id);
    const key = await this.newClientKey();
    const now = Date.now();
    const row = this.db.transaction((tx) => {
      const updated = tx
        .update(siteFtpUsers)
        .set({
          ...(patch.folder !== undefined ? { folder: patch.folder } : {}),
          ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
          updatedAt: now,
        })
        .where(and(eq(siteFtpUsers.id, id), eq(siteFtpUsers.siteId, site.id)))
        .returning()
        .get();
      if (!updated) throw notFound(`FTP login #${id} not found on "${site.slug}"`);
      tx.update(siteFtp).set({ clientKey: key, rotatedAt: now, changedAt: now }).where(eq(siteFtp.siteId, site.id)).run();
      return updated;
    });
    void this.kick(site.serverId);
    return this.userToDto(row);
  }

  async resetPassword(site: SiteRow, id: number, password?: string): Promise<{ user: SiteFtpUserDto; password: string | null }> {
    this.userOf(site, id);
    const next = password ?? generateFtpPassword();
    const hash = await hashFtpPassword(next);
    const key = await this.newClientKey();
    const now = Date.now();
    const row = this.db.transaction((tx) => {
      const updated = tx
        .update(siteFtpUsers)
        .set({ passwordHash: hash, passwordSetAt: now, updatedAt: now })
        .where(and(eq(siteFtpUsers.id, id), eq(siteFtpUsers.siteId, site.id)))
        .returning()
        .get();
      if (!updated) throw notFound(`FTP login #${id} not found on "${site.slug}"`);
      // Rotated so a session opened with the old password ends too, not just new logins.
      tx.update(siteFtp).set({ clientKey: key, rotatedAt: now, changedAt: now }).where(eq(siteFtp.siteId, site.id)).run();
      return updated;
    });
    void this.kick(site.serverId);
    return { user: this.userToDto(row), password: password === undefined ? next : null };
  }

  async deleteUser(site: SiteRow, id: number): Promise<SiteFtpUserRow> {
    const row = this.userOf(site, id);
    const key = await this.newClientKey();
    const now = Date.now();
    this.db.transaction((tx) => {
      const gone = tx.delete(siteFtpUsers).where(and(eq(siteFtpUsers.id, id), eq(siteFtpUsers.siteId, site.id))).run();
      if (gone.changes === 0) throw notFound(`FTP login #${id} not found on "${site.slug}"`);
      // The link stays even when this was the last login: it is what says the removal has not
      // reached the server yet. The sync that takes the file server down drops it.
      tx.update(siteFtp).set({ clientKey: key, rotatedAt: now, changedAt: now }).where(eq(siteFtp.siteId, site.id)).run();
    });
    void this.kick(site.serverId);
    return row;
  }

  private linkOf(siteId: number): SiteFtpRow | undefined {
    return this.db.select().from(siteFtp).where(eq(siteFtp.siteId, siteId)).get();
  }

  private async newLink(): Promise<{ fileServerHostKey: string; clientKey: string }> {
    const hostKey = await newSshKeyPair('ed25519', 'wpl7-ftp-files');
    return { fileServerHostKey: hostKey.privateKey, clientKey: await this.newClientKey() };
  }

  private async newClientKey(): Promise<string> {
    return (await newSshKeyPair('ed25519', 'wpl7-ftp-gateway')).privateKey;
  }

  /**
   * Take a login's live sessions away when it expires. SFTPGo refuses an expired login but
   * lets a session that is already open run on, so the site's key is rotated once the time
   * has passed - here, on the tick - which ends it within the minute.
   */
  async expireDue(now = Date.now()): Promise<number> {
    const due = this.db
      .select({ siteId: siteFtpUsers.siteId, expiresAt: siteFtpUsers.expiresAt, rotatedAt: siteFtp.rotatedAt })
      .from(siteFtpUsers)
      .innerJoin(siteFtp, eq(siteFtp.siteId, siteFtpUsers.siteId))
      .where(and(isNotNull(siteFtpUsers.expiresAt), lte(siteFtpUsers.expiresAt, now)))
      .all()
      .filter((r) => r.rotatedAt < (r.expiresAt ?? 0));
    const siteIds = [...new Set(due.map((r) => r.siteId))];
    for (const siteId of siteIds) {
      const key = await this.newClientKey();
      this.db.update(siteFtp).set({ clientKey: key, rotatedAt: now, changedAt: now }).where(eq(siteFtp.siteId, siteId)).run();
      const site = this.db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (site) void this.kick(site.serverId);
    }
    return siteIds.length;
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Stop a site's FTP for the length of a job that replaces or removes its files: a restore
   * swaps the folder (a running file server would go on serving the old one, and taking
   * uploads into it), a move copies it elsewhere (an upload meanwhile would be lost at the
   * cutover), a delete removes it. The file server is removed now, under the server's lock,
   * and nothing puts it back until `resume` - which the job calls when it ends, however it
   * ends.
   *
   * The pause counts for a site without logins too (nothing to stop, so no Docker call): a
   * first login added while the job runs must wait for it as well, or its file server would
   * mount the very folder the job is about to set aside.
   */
  async suspendSite(site: SiteRow): Promise<() => void> {
    this.paused.set(site.id, (this.paused.get(site.id) ?? 0) + 1);
    const had = this.hasLogins(site.id);
    if (had) {
      try {
        await this.withLock(site.serverId, async () => {
          await this.servers.handleFor(site.serverId).docker.removeContainer(ftpFileServerContainer(site.slug));
        });
      } catch (err) {
        this.unpause(site.id);
        throw err;
      }
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.unpause(site.id);
      if (!had && !this.hasLogins(site.id)) return;
      // Both servers after a move: the old one drops the site, the new one takes it on.
      void this.kick(site.serverId);
      const now = this.db.select().from(sites).where(eq(sites.id, site.id)).get();
      if (now && now.serverId !== site.serverId) void this.kick(now.serverId);
    };
  }

  private unpause(siteId: number): void {
    const n = (this.paused.get(siteId) ?? 1) - 1;
    if (n <= 0) this.paused.delete(siteId);
    else this.paused.set(siteId, n);
  }

  isPaused(siteId: number): boolean {
    return this.paused.has(siteId);
  }

  /** A deleted site's file server and its files, before the site's own folder goes. */
  async removeSite(serverId: number, slug: string): Promise<void> {
    await this.withLock(serverId, async () => {
      const handle = this.servers.handleFor(serverId);
      await handle.docker.removeContainer(ftpFileServerContainer(slug));
      await handle.files.rm(this.paths.site(slug));
      this.forgetWrites(serverId, this.paths.site(slug));
    });
  }

  /**
   * A server leaving the panel: take everything FTP off it while it can still be reached - the
   * gateway there holds every login's password hash. Returns what is left behind, if anything,
   * for the removal's answer.
   */
  async forgetServer(serverId: number): Promise<string | null> {
    let left: string | null = null;
    if (this.status.get(serverId)?.state !== 'off') {
      try {
        await this.withLock(serverId, () => this.teardown(this.servers.handleFor(serverId)));
      } catch (err) {
        left =
          `FTP could not be removed from it (${err instanceof Error ? err.message : String(err)}): on the server, ` +
          `remove the containers named wpl7-ftp* and ${this.paths.root}.`;
      }
    }
    this.status.delete(serverId);
    this.loadedUsers.delete(serverId);
    this.ftpBlocked.delete(serverId);
    this.forgetWrites(serverId);
    return left;
  }

  /** Try FTP's ports again on a server where they were taken (its address changed, say). */
  recheck(serverId: number): Promise<void> {
    this.ftpBlocked.delete(serverId);
    return this.kick(serverId);
  }

  // ------------------------------------------------------------------ syncing

  /**
   * Bring a server in line soon. Kicks that arrive while one is waiting ride along with it,
   * and one that arrives mid-sync queues exactly one more, so a burst of edits is one sync.
   * Resolves when a sync that started after the kick is done; never rejects.
   *
   * `tick` is the minute tick asking: everything else is a change - an edit, the settings, an
   * expiry, a job ending - which may retry a failed build of the SFTPGo image at once.
   */
  kick(serverId: number, cause: 'change' | 'tick' = 'change'): Promise<void> {
    if (cause === 'change') this.changes.set(serverId, (this.changes.get(serverId) ?? 0) + 1);
    const pending = this.waiting.get(serverId);
    if (pending) return pending;
    const before = this.chains.get(serverId) ?? Promise.resolve();
    const run = before
      .then(() => (this.debounceMs > 0 ? new Promise<void>((r) => setTimeout(r, this.debounceMs)) : undefined))
      .then(() => {
        this.waiting.delete(serverId);
        return this.syncServer(serverId);
      })
      // syncServer reports its own failures; this only stops a surprise from breaking the
      // chain, which every later sync of this server waits on.
      .catch((err: unknown) => {
        this.waiting.delete(serverId);
        this.log.warn(`FTP sync of server #${serverId} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    this.waiting.set(serverId, run);
    this.chains.set(serverId, run);
    return run;
  }

  /** Every server, after the FTP settings changed - including another go at blocked FTP ports. */
  kickAll(): Promise<void> {
    this.ftpBlocked.clear();
    return Promise.all(this.servers.listRows().map((row) => this.kick(row.id))).then(() => undefined);
  }

  /** Wait for everything queued so far (tests; a clean shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  private withLock<T>(serverId: number, work: () => Promise<T>): Promise<T> {
    const before = this.chains.get(serverId) ?? Promise.resolve();
    const run = before.then(work);
    this.chains.set(
      serverId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * The minute tick: take expired logins' sessions away, then re-check every server that is
   * not known to be right. A server with no logins that was already cleaned up is left alone
   * - which is every server, on an install that has never had an FTP login.
   *
   * The syncs are started, not waited for: one slow server (an image pull, SSH timing out)
   * must not hold up the next minute's expiry everywhere else. `idle()` waits for them.
   */
  async tick(): Promise<void> {
    await this.expireDue();
    const now = Date.now();
    const wanted = new Set(this.serversWanting(now));
    for (const row of this.servers.listRows()) {
      // An unreachable server is retried once something else has seen it answer again
      // (the monitor marks it reachable); a change made meanwhile shows as not applied.
      if (row.status === 'provisioning' || row.status === 'unreachable') continue;
      const s = this.status.get(row.id);
      if (s?.state === 'off' && !wanted.has(row.id)) continue;
      if (s?.state === 'ready' && s.syncedAt !== null && now - s.syncedAt < RECHECK_MS) continue;
      const failedBuild = this.buildFailed.get(row.id);
      if (failedBuild && now - failedBuild.at < BUILD_RETRY_MS) continue;
      void this.kick(row.id, 'tick');
    }
  }

  /**
   * Servers that should be running FTP: a login there that has not expired, with FTP switched
   * on. Everything else that is already off stays unvisited - otherwise a server whose last
   * login expired, or every server while FTP is switched off, would be "cleaned up" again
   * every minute.
   */
  private serversWanting(now: number): number[] {
    if (this.settings.get('ftpEnabled') === false) return [];
    return this.db
      .selectDistinct({ serverId: sites.serverId })
      .from(siteFtpUsers)
      .innerJoin(sites, eq(sites.id, siteFtpUsers.siteId))
      .where(or(isNull(siteFtpUsers.expiresAt), gt(siteFtpUsers.expiresAt, now)))
      .all()
      .map((r) => r.serverId);
  }

  /** What a server should be running, straight from the database. */
  private plan(row: ServerRow, now: number) {
    const onServer = this.db
      .select()
      .from(sites)
      .where(and(eq(sites.serverId, row.id), notInArray(sites.status, NO_FILES), hostedSites()))
      .all();
    const siteIds = onServer.map((s) => s.id);
    const users = siteIds.length
      ? this.db.select().from(siteFtpUsers).where(inArray(siteFtpUsers.siteId, siteIds)).all()
      : [];
    const live = users.filter((u) => u.expiresAt === null || u.expiresAt > now);
    const links = new Map(
      (siteIds.length ? this.db.select().from(siteFtp).where(inArray(siteFtp.siteId, siteIds)).all() : []).map((l) => [l.siteId, l]),
    );
    const withLogins = onServer.filter((s) => live.some((u) => u.siteId === s.id) && links.has(s.id));
    return {
      enabled: this.settings.get('ftpEnabled') !== false,
      live,
      links,
      sites: withLogins,
      all: onServer,
      bySite: new Map(onServer.map((s) => [s.id, s])),
    };
  }

  /** The published ports, and whether FTP can run here at all. */
  ports(row: ServerRow): { ports: FtpPorts; ftpReason: string | null } {
    const sftp = Number(this.settings.get('ftpSftpPort')) || 2222;
    let ftpReason: string | null = null;
    if (this.settings.get('ftpOfferFtps') === false) ftpReason = 'FTP is switched off in Settings; SFTP only.';
    else if (!isIPv4(row.publicIp)) {
      // Not just "empty": an address SFTPGo cannot parse makes it refuse to start at all,
      // which would take SFTP down with FTP.
      ftpReason = row.publicIp
        ? `FTP needs the server's public IPv4 address for passive mode, and "${row.publicIp}" is not one; fix it on "${row.name}" (Servers).`
        : `FTP needs the server's public IPv4 address for passive mode; set it on "${row.name}" (Servers).`;
    } else if (this.ftpBlocked.has(row.id)) {
      ftpReason = this.ftpBlocked.get(row.id)!;
    }
    return {
      ports: {
        sftp,
        ftp: ftpReason
          ? null
          : {
              port: Number(this.settings.get('ftpPort')) || 21,
              passiveStart: Number(this.settings.get('ftpPassivePortStart')) || 30000,
              passiveEnd: Number(this.settings.get('ftpPassivePortEnd')) || 30015,
              passiveIp: row.publicIp,
            },
      },
      ftpReason,
    };
  }

  private setStatus(serverId: number, patch: Partial<ServerStatus>): void {
    const prev = this.status.get(serverId) ?? { state: 'off', message: null, checkedAt: null, syncedAt: null };
    this.status.set(serverId, { ...prev, ...patch });
  }

  /** Never throws: what went wrong is the server's status, which the FTP tab shows. */
  async syncServer(serverId: number): Promise<void> {
    const row = this.servers.rowById(serverId);
    if (!row) {
      this.status.delete(serverId);
      this.loadedUsers.delete(serverId);
      return;
    }
    if (row.status === 'provisioning') return;
    const startedAt = Date.now();
    // Dated only once the sync has an outcome: "off" with a date is a server where FTP was
    // found and left gone, which is what the FTP tab may call switched off.
    const found = (patch: Omit<Partial<ServerStatus>, 'checkedAt'>) => this.setStatus(serverId, { ...patch, checkedAt: startedAt });
    try {
      const handle = this.servers.handleFor(serverId);
      const plan = this.plan(row, startedAt);
      if (!plan.enabled || plan.sites.length === 0) {
        await this.teardown(handle);
        found({ state: 'off', message: null, syncedAt: startedAt });
        this.settled(plan.all, startedAt, new Map());
        return;
      }
      const { gatewayProblem, siteProblems } = await this.apply(handle, row, plan);
      // What went wrong may not be on disk as the write cache believes: write it all next time.
      for (const siteId of siteProblems.keys()) {
        const slug = plan.bySite.get(siteId)?.slug;
        if (slug) this.forgetWrites(serverId, this.paths.site(slug));
      }
      if (gatewayProblem) {
        this.forgetWrites(serverId, this.paths.gateway);
        found({ state: 'error', message: gatewayProblem });
      } else {
        found({ state: 'ready', message: null, syncedAt: startedAt });
        this.settled(plan.all, startedAt, siteProblems);
      }
    } catch (err) {
      this.forgetWrites(serverId);
      if (err instanceof ServerUnreachableError) {
        found({ state: 'unreachable', message: err.message });
      } else {
        const message = describeDockerError(err, row.name);
        found({ state: 'error', message });
        this.log.warn(`FTP on "${row.name}": ${message}`);
      }
    }
  }

  /**
   * After a sync whose gateway part worked: every site on the server is up to date as of its
   * start, except the ones with a problem of their own. A site whose last login was removed
   * no longer needs its link - that removal has now reached the server.
   */
  private settled(onServer: SiteRow[], startedAt: number, problems: Map<number, string>): void {
    for (const site of onServer) {
      const problem = problems.get(site.id) ?? null;
      const before = this.siteStatus.get(site.id);
      this.siteStatus.set(site.id, { problem, syncedAt: problem ? (before?.syncedAt ?? null) : startedAt });
    }
    const ids = onServer.map((s) => s.id);
    if (ids.length === 0) return;
    this.db
      .delete(siteFtp)
      .where(
        and(
          inArray(siteFtp.siteId, ids),
          lte(siteFtp.changedAt, startedAt),
          notInArray(siteFtp.siteId, this.db.select({ id: siteFtpUsers.siteId }).from(siteFtpUsers)),
        ),
      )
      .run();
  }

  /** Everything FTP on a server, gone: containers, networks, files. The logins stay in the database. */
  private async teardown(handle: ServerHandle): Promise<void> {
    const docker = handle.docker;
    const containers = [
      ...(await docker.listManaged([`wpl7.role=${FTP_ROLE_GATEWAY}`])),
      ...(await docker.listManaged([`wpl7.role=${FTP_ROLE_FILES}`])),
    ];
    for (const c of containers) await docker.removeContainer(c.name);
    await docker.removeNetwork(FTP_EDGE_NETWORK);
    await docker.removeNetwork(FTP_NETWORK);
    await handle.files.rm(this.paths.root);
    this.forgetWrites(handle.id);
    this.loadedUsers.delete(handle.id);
    if (containers.length > 0) this.log.info(`FTP on "${handle.name}": no logins left, gateway and file servers removed`);
  }

  private async apply(
    handle: ServerHandle,
    row: ServerRow,
    plan: ReturnType<FtpService['plan']>,
  ): Promise<{ gatewayProblem: string | null; siteProblems: Map<number, string> }> {
    const { docker, files } = handle;
    const image = this.config.sftpgoImage;
    const siteProblems = new Map<number, string>();
    const addProblem = (siteId: number, problem: string) => {
      const before = siteProblems.get(siteId);
      siteProblems.set(siteId, before ? `${before} · ${problem}` : problem);
    };

    await this.ensureImage(handle, row);
    this.setStatus(row.id, { state: this.status.get(row.id)?.state === 'ready' ? 'ready' : 'starting', message: null });
    await docker.ensureNetwork({ name: FTP_NETWORK, internal: true, labels: { 'wpl7.role': 'ftp-network' } });
    await docker.ensureNetwork({
      name: FTP_EDGE_NETWORK,
      options: { 'com.docker.network.bridge.enable_icc': 'false' },
      labels: { 'wpl7.role': 'ftp-edge' },
    });
    const identity = await this.ensureIdentity(row);

    // Traversable, not listable: a container that could see this folder would learn every
    // slug, and nothing in there is anyone's business but its own container's.
    await files.mkdirp(this.paths.root, { mode: 0o711 });
    await files.mkdirp(this.paths.sites, { mode: 0o711 });

    // ---- one file server per site with logins (paused sites have none until resumed)
    const serving = new Set<string>();
    let started = false;
    for (const site of plan.sites) {
      if (this.paused.has(site.id)) continue;
      const link = plan.links.get(site.id)!;
      try {
        const dir = this.paths.site(site.slug);
        await files.mkdirp(dir, { mode: 0o700, owner: SITE_OWNER });
        const config = toJson(renderFileServerConfig());
        const users = renderFileServerUsers(sshKeyFacts(link.clientKey).publicKey);
        await this.put(handle, path.join(dir, FILES.config), config, SITE_OWNER);
        await this.put(handle, path.join(dir, FILES.users), users, SITE_OWNER);
        await this.put(handle, path.join(dir, FILES.hostEd25519), link.fileServerHostKey, SITE_OWNER);
        const folder = sitePaths(this.config, site.slug).wordpress;
        const st = await files.stat(folder);
        if (!st) throw new Error(`its files are missing (${folder})`);
        const outcome = await docker.ensureServiceContainer(
          fileServerSpec({
            image,
            paths: this.paths,
            slug: site.slug,
            siteFolder: folder,
            inputs: digest(config, users, link.fileServerHostKey, st.id),
          }),
        );
        if (outcome !== 'unchanged') started = true;
        serving.add(site.slug);
      } catch (err) {
        if (err instanceof ServerUnreachableError) throw err;
        addProblem(site.id, describeDockerError(err, row.name));
      }
    }
    for (const c of await docker.listManaged([`wpl7.role=${FTP_ROLE_FILES}`])) {
      const slug = c.labels['wpl7.site'];
      if (!slug || !serving.has(slug)) await docker.removeContainer(c.name);
    }
    for (const entry of await files.readdir(this.paths.sites)) {
      if (plan.sites.some((s) => s.slug === entry)) continue;
      await files.rm(this.paths.site(entry));
      this.forgetWrites(row.id, this.paths.site(entry));
    }

    // ---- the gateway
    const logins: GatewayLogin[] = [];
    for (const user of plan.live) {
      const site = plan.bySite.get(user.siteId);
      const link = plan.links.get(user.siteId);
      if (!site || !link) continue;
      logins.push({
        username: user.username,
        passwordHash: user.passwordHash,
        folder: user.folder,
        expiresAt: user.expiresAt,
        siteSlug: site.slug,
        clientKey: link.clientKey,
        fileServerFingerprint: sshKeyFacts(link.fileServerHostKey).fingerprint,
      });
    }
    const users = renderGatewayUsers(logins);
    for (const skipped of users.skipped) {
      const siteId = plan.live.find((u) => u.username === skipped.username)?.siteId;
      if (siteId !== undefined) addProblem(siteId, `login "${skipped.username}" left out: ${skipped.problem}`);
    }
    const dir = this.paths.gateway;
    await files.mkdirp(dir, { mode: 0o700, owner: GATEWAY_OWNER });
    await this.put(handle, path.join(dir, FILES.users), users.json, GATEWAY_OWNER);
    await this.put(handle, path.join(dir, FILES.hostEd25519), identity.hostKeyEd25519, GATEWAY_OWNER);
    await this.put(handle, path.join(dir, FILES.hostRsa), identity.hostKeyRsa, GATEWAY_OWNER);
    await this.put(handle, path.join(dir, FILES.tlsCert), identity.tlsCertPem, GATEWAY_OWNER);
    await this.put(handle, path.join(dir, FILES.tlsKey), identity.tlsKeyPem, GATEWAY_OWNER);
    const startGateway = async (ports: FtpPorts) => {
      const config = toJson(renderGatewayConfig(ports.ftp));
      await this.put(handle, path.join(dir, FILES.config), config, GATEWAY_OWNER);
      return docker.ensureServiceContainer(
        gatewaySpec({
          image,
          paths: this.paths,
          ports,
          // SIGHUP reloads the users and the certificate, but not the host keys or the config
          // itself - those only take effect on a new container.
          inputs: digest(config, identity.hostKeyEd25519, identity.hostKeyRsa, identity.tlsCertPem, identity.tlsKeyPem),
        }),
      );
    };
    const { ports } = this.ports(row);
    let outcome: Awaited<ReturnType<typeof startGateway>>;
    try {
      outcome = await startGateway(ports);
    } catch (err) {
      // One container carries both protocols, so a port only FTP needs - 21 held by a
      // preinstalled FTP server, a passive port in use - would take SFTP down with it.
      const taken = ports.ftp ? takenPort(err) : null;
      const ftpOnly =
        ports.ftp && taken !== null && (taken === ports.ftp.port || (taken >= ports.ftp.passiveStart && taken <= ports.ftp.passiveEnd));
      if (!ftpOnly) throw err;
      const reason =
        `Port ${taken} is already in use on "${row.name}", so it offers SFTP only. Free the port, or pick ` +
        `another in Settings -> Sites -> FTP & SFTP.`;
      this.ftpBlocked.set(row.id, reason);
      this.log.warn(`FTP on "${row.name}": ${reason}`);
      outcome = await startGateway({ sftp: ports.sftp, ftp: null });
    }
    const usersDigest = digest(users.json);
    if (outcome !== 'unchanged') {
      started = true;
      this.loadedUsers.set(row.id, usersDigest);
    } else if (this.loadedUsers.get(row.id) !== usersDigest) {
      await docker.signalContainer(FTP_GATEWAY_CONTAINER, 'SIGHUP');
      this.loadedUsers.set(row.id, usersDigest);
    }

    // Judged once they have had a moment: "running" a second after the start is what a
    // config SFTPGo refuses looks like too, until it exits.
    if (started && this.settleMs > 0) await new Promise((r) => setTimeout(r, this.settleMs));
    for (const site of plan.sites) {
      if (!serving.has(site.slug)) continue;
      const state = await docker.serviceState(ftpFileServerContainer(site.slug));
      if (state.restarting || state.state !== 'running') {
        addProblem(site.id, `its file server keeps stopping: ${await lastLogLines(handle, ftpFileServerContainer(site.slug))}`);
      }
    }
    const gateway = await docker.serviceState(FTP_GATEWAY_CONTAINER);
    const gatewayProblem =
      gateway.restarting || gateway.state !== 'running'
        ? `the FTP gateway keeps stopping: ${await lastLogLines(handle, FTP_GATEWAY_CONTAINER)}`
        : null;
    return { gatewayProblem, siteProblems };
  }

  /**
   * The SFTPGo image on this server, under its local name - as with the site images, an
   * install from released images pulls the published build, and one built from source builds
   * it here from deploy/sftpgo-image, which the panel carries. Either happens once per version
   * and server, and only on a server one of whose sites has a login. WPL7_SFTPGO_IMAGE is taken
   * as it is: pulled if missing, never built.
   */
  private async ensureImage(handle: ServerHandle, row: ServerRow): Promise<void> {
    const { docker } = handle;
    const c = this.config;
    if (await docker.imageExists(c.sftpgoImage)) return;
    if (c.sftpgoImagePinned || c.source === 'image') {
      const from = c.sftpgoImagePinned ? c.sftpgoImage : c.sftpgoPublishedImage;
      this.setStatus(row.id, { state: 'starting', message: 'Downloading SFTPGo…' });
      try {
        await docker.pullImage(from);
        if (from !== c.sftpgoImage) await docker.tagImage(from, c.sftpgoImage);
        return;
      } catch (err) {
        if (c.sftpgoImagePinned || err instanceof ServerUnreachableError) throw err;
        // A fork that publishes nothing, or a registry that is down: what source installs do.
        this.log.warn(`FTP on "${row.name}": could not download ${from} (${errorText(err)}); building it instead`);
      }
    }
    await this.buildImage(handle, row);
  }

  /**
   * Build the SFTPGo image on a server: a few minutes of a Go compile, on the server's own
   * daemon, from the build context the panel sends it.
   */
  private async buildImage(handle: ServerHandle, row: ServerRow): Promise<void> {
    const { docker } = handle;
    const { sftpgoImage: image, sftpgoImageContext: context } = this.config;
    // Checked here, when the sync runs, and not only by the tick: a tick during a build that
    // then fails has already queued a sync, which must not start the next build straight away.
    const failed = this.buildFailed.get(row.id);
    const changes = this.changes.get(row.id) ?? 0;
    if (failed && Date.now() - failed.at < BUILD_RETRY_MS && changes === failed.changes) throw new Error(failed.message);
    const base = builderBase(context);
    if (!base || image.endsWith(':')) throw new Error(`this panel cannot build SFTPGo: its build context is missing (${context})`);
    const hadBase = await docker.imageExists(base);
    this.setStatus(row.id, { state: 'starting', message: `Building SFTPGo on "${row.name}" - a few minutes, once per version` });
    this.log.info(`FTP on "${row.name}": building ${image}`);
    try {
      await docker.buildImage(image, context, {});
      this.buildFailed.delete(row.id);
      this.log.info(`FTP on "${row.name}": ${image} built`);
    } catch (err) {
      if (err instanceof ServerUnreachableError) throw err;
      // A compile that dies minutes in must not run back to back: the next try waits
      // BUILD_RETRY_MS, unless a login or the settings change after this.
      const message = `building SFTPGo failed: ${errorText(err)}. It is tried again in ${BUILD_RETRY_MS / 60_000} minutes, or at once when a login or the FTP settings change.`;
      this.buildFailed.set(row.id, { at: Date.now(), message, changes: this.changes.get(row.id) ?? 0 });
      throw new Error(message);
    } finally {
      // All the build leaves behind is the image: not its first stage (the Go toolchain, the
      // module cache, the compiler's output) nor the Go image, unless the server had it before.
      await docker.pruneImages([BUILD_STAGE_LABEL]).catch(() => undefined);
      if (!hadBase) await docker.removeImage(base).catch(() => undefined);
    }
  }

  /** Write a file the containers read, unless it already holds exactly this. */
  private async put(handle: ServerHandle, file: string, content: string, owner: { uid: number; gid: number }): Promise<void> {
    const key = `${handle.id}:${file}`;
    const sum = digest(content, `${owner.uid}`);
    if (this.written.get(key) === sum) return;
    await handle.files.writeFile(file, content, { mode: 0o600, owner, atomic: true });
    this.written.set(key, sum);
  }

  private forgetWrites(serverId: number, under?: string): void {
    const prefix = `${serverId}:${under ?? ''}`;
    for (const key of [...this.written.keys()]) if (key.startsWith(prefix)) this.written.delete(key);
  }

  /** The server's gateway keys and certificate, made the first time they are needed. */
  private async ensureIdentity(row: ServerRow): Promise<FtpServerRow> {
    const existing = this.identityOf(row.id);
    if (existing) return existing;
    const [ed25519, rsa, cert] = await Promise.all([
      newSshKeyPair('ed25519', `wpl7-ftp@${row.name}`),
      newSshKeyPair('rsa', `wpl7-ftp@${row.name}`),
      selfSignedCert({ commonName: `WPL7 FTP (${row.name})`, ips: isIPv4(row.publicIp) ? [row.publicIp] : [] }),
    ]);
    this.db
      .insert(ftpServers)
      .values({
        serverId: row.id,
        hostKeyEd25519: ed25519.privateKey,
        hostKeyRsa: rsa.privateKey,
        tlsCertPem: cert.certPem,
        tlsKeyPem: cert.keyPem,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    this.log.info(`FTP on "${row.name}": gateway keys and certificate created (SFTP ${ed25519.fingerprint})`);
    return this.identityOf(row.id)!;
  }

  private identityOf(serverId: number): FtpServerRow | undefined {
    return this.db.select().from(ftpServers).where(eq(ftpServers.serverId, serverId)).get();
  }

  // ------------------------------------------------------------------ views

  private statusDto(row: ServerRow): FtpStatusDto {
    const s = this.status.get(row.id);
    // Not looked at since the panel started, and the tick leaves an unreachable server alone:
    // where FTP ever ran (it has keys), whether it still does is not known - which "off" would
    // claim.
    if (s?.checkedAt == null && row.status === 'unreachable' && this.identityOf(row.id)) {
      return { state: 'unreachable', message: `The panel cannot reach "${row.name}".`, checkedAt: null };
    }
    return { state: s?.state ?? 'off', message: s?.message ?? null, checkedAt: s?.checkedAt ?? null };
  }

  endpoint(row: ServerRow): FtpEndpointDto {
    const identity = this.identityOf(row.id);
    const { ports, ftpReason } = this.ports(row);
    return {
      host: isIPv4(row.publicIp) ? row.publicIp : null,
      sftp: {
        port: ports.sftp,
        hostKeys: identity
          ? [identity.hostKeyEd25519, identity.hostKeyRsa].map((k) => {
              const facts = sshKeyFacts(k);
              return { type: facts.type, fingerprint: facts.fingerprint };
            })
          : [],
      },
      ftp: {
        available: ports.ftp !== null,
        reason: ftpReason,
        port: Number(this.settings.get('ftpPort')) || 21,
        passivePorts: {
          start: Number(this.settings.get('ftpPassivePortStart')) || 30000,
          end: Number(this.settings.get('ftpPassivePortEnd')) || 30015,
        },
        certFingerprint: identity ? certPemSha256(identity.tlsCertPem) : null,
      },
    };
  }

  siteView(site: SiteRow, now = Date.now()): SiteFtpDto {
    const row = this.servers.rowById(site.serverId);
    if (!row) throw notFound(`Server #${site.serverId} not found`);
    const link = this.linkOf(site.id);
    const own = this.siteStatus.get(site.id);
    const server = this.statusDto(row);
    // The server's trouble first (it is everyone's), then this site's own.
    const status: FtpStatusDto =
      own?.problem && server.state !== 'unreachable' && server.state !== 'error'
        ? { state: 'error', message: own.problem, checkedAt: server.checkedAt }
        : server;
    const users = this.usersOf(site.id);
    // A login that has expired is a change too, one nobody made: it has reached the server once
    // the key was rotated after it (expireDue, on the tick) and a sync has put that key there.
    const expiring = !!link && users.some((u) => u.expiresAt !== null && u.expiresAt <= now && link.rotatedAt < u.expiresAt);
    return {
      enabled: this.settings.get('ftpEnabled') !== false,
      serverId: row.id,
      serverName: row.name,
      endpoint: this.endpoint(row),
      status,
      applied: !link || (!expiring && own?.syncedAt != null && own.syncedAt >= link.changedAt),
      paused: this.isPaused(site.id),
      users: users.map((u) => this.userToDto(u, now)),
    };
  }

  serverView(serverId: number, now = Date.now()): FtpServerStatusDto {
    const row = this.servers.rowById(serverId);
    if (!row) throw notFound(`Server #${serverId} not found`);
    const onServer = this.db
      .select({ siteId: siteFtpUsers.siteId, expiresAt: siteFtpUsers.expiresAt })
      .from(siteFtpUsers)
      .innerJoin(sites, eq(sites.id, siteFtpUsers.siteId))
      .where(eq(sites.serverId, serverId))
      .all();
    return {
      serverId,
      enabled: this.settings.get('ftpEnabled') !== false,
      endpoint: this.endpoint(row),
      status: this.statusDto(row),
      sites: new Set(onServer.map((r) => r.siteId)).size,
      logins: onServer.length,
      activeLogins: onServer.filter((r) => r.expiresAt === null || r.expiresAt > now).length,
    };
  }

  userToDto(row: SiteFtpUserRow, now = Date.now()): SiteFtpUserDto {
    return {
      id: row.id,
      username: row.username,
      folder: row.folder,
      expiresAt: row.expiresAt,
      expired: row.expiresAt !== null && row.expiresAt <= now,
      createdBy: row.createdBy,
      passwordSetAt: row.passwordSetAt,
      createdAt: row.createdAt,
    };
  }
}

const digest = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex');

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).trim().slice(0, 300);

/** The image deploy/sftpgo-image's build stage starts from (`FROM <it> AS builder`); null without its Dockerfile. */
function builderBase(context: string): string | null {
  try {
    return /^FROM\s+(\S+)\s+AS\s+builder\s*$/im.exec(fs.readFileSync(path.join(context, 'Dockerfile'), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The last few lines a container logged, for a status message; SFTPGo logs JSON, so its `message`s. */
async function lastLogLines(handle: ServerHandle, name: string): Promise<string> {
  const raw = await handle.docker.containerLogs(name, { tail: 20 }).catch(() => '');
  const lines = raw
    .split('\n')
    .map((l) => {
      try {
        const j = JSON.parse(l) as { message?: string; level?: string };
        return j.level === 'error' || j.level === 'warn' ? (j.message ?? '') : '';
      } catch {
        return l.trim();
      }
    })
    .filter(Boolean);
  return lines.slice(-2).join(' / ').slice(0, 400) || 'see `docker logs` on the server';
}

/** The host port a failed start complained about ("Bind for 0.0.0.0:21 failed…"), if any. */
function takenPort(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!/already allocated|address already in use/i.test(message)) return null;
  const port = /(?:0\.0\.0\.0|\[::\]|\*):(\d+)/.exec(message)?.[1];
  return port ? Number(port) : null;
}

/** Docker's own words, where there is a plainer way to say them. */
function describeDockerError(err: unknown, serverName: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const port = /(?:0\.0\.0\.0|\[::\]|\*):(\d+)/.exec(message)?.[1];
  if (port && /already allocated|address already in use/i.test(message)) {
    return `port ${port} is already in use on "${serverName}" - free it, or pick another port in Settings -> Sites -> FTP & SFTP`;
  }
  return message.slice(0, 400);
}

