/**
 * Outbound mail: health, traffic, queue, test sends and DKIM key management.
 *
 * Every site on a server hands its `mail()` output to one postfix relay (`wpl7-mail`), so
 * that relay's log is the single place where all outbound traffic is visible. This service
 * turns it into queryable rows, which is what makes "is mail working?" and "is a site
 * spamming?" answerable questions rather than an SSH session.
 *
 * Signing happens in a second container (`wpl7-dkim`, OpenDKIM as a milter) whose entire
 * configuration is written from here. Keys live in the panel database and are materialized
 * onto every server, so moving a site never breaks its signatures.
 */
import path from 'node:path';
import { and, asc, count, desc, eq, gte, isNotNull, like, lt, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { mailDkimKeys, mailMessages, sites, type MailDkimKeyRow, type MailMessageRow } from '../db/schema.js';
import type { Config } from '../config.js';
import type { ServerHandle, ServerRegistry } from '../servers/registry.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';
import { badGateway, badRequest, conflict, notFound } from '../lib/errors.js';
import { shellQuote } from '../servers/sshExec.js';
import { safeJoin } from '../lib/slug.js';
import { MAIL_CONTAINER, DKIM_CONTAINER } from './stack.js';
import {
  mailAuthPaths,
  mailLogin,
  parseSaslUsers,
  renderSaslBlock,
  renderSenderLogin,
  renderSmtpdConf,
  RESERVED_LOGIN,
  SASLDB_IN_CONTAINER,
  legacyLoginFor,
  legacyMailLogin,
  sqSingle,
  type SenderOwner,
} from './mailAuth.js';
import {
  parseMailLog,
  parsePostqueueJson,
  siteSlugFromClient,
  type MailLogEvent,
  type MailStatus,
  type QueueEntry,
} from '../lib/mailLog.js';
import {
  DEFAULT_DKIM_SELECTOR,
  DKIM_TRUSTED_HOSTS,
  dkimRecordBind,
  dkimRecordName,
  dkimRecordValue,
  generateDkimKey,
  renderKeyTable,
  renderOpendkimConf,
  renderSenderLogins,
  renderSigningPolicy,
  type DkimKeyFile,
  type SignerOwner,
} from './mailDkim.js';
import {
  checkDkim,
  checkDmarc,
  checkHostnameA,
  checkReverseDns,
  checkSpf,
  dkimNotConfigured,
  suggestedDmarc,
  suggestedSpf,
  systemResolver,
  type DnsResolver,
  type RecordCheck,
} from './mailDns.js';
import { mergeSpf, planDomainSteps, RDNS_GUIDES, spfLookupCount, spfMechanismsFor } from './mailSetup.js';
import {
  hostnameOverride,
  parseHostnameProbe,
  RELAY_HOSTNAME_PROBE,
  relayEnvWith,
  sameHostname,
  type RelayHostnames,
} from './mailHostname.js';
import { CLOUDFLARE, type DnsService } from './dns.js';
import type {
  MailDkimKeyDto,
  MailDomainDto,
  MailMessageDto,
  MailPublishResult,
  MailQueueDto,
  MailServerSetupDto,
  MailServerStatusDto,
  MailSetupDto,
  MailSetupStep,
  MailStatsDto,
  ServerCheck,
} from '../../shared/types.js';

export { MAIL_CONTAINER, DKIM_CONTAINER } from './stack.js';
/** Where the DKIM volume is mounted inside wpl7-dkim (see deploy/docker-compose.yml). */
const KEYS_DIR_IN_CONTAINER = '/etc/opendkim/keys';
/** OpenDKIM validates these before loading a key; see syncDkimTo(). */
const DKIM_KEY_MODE = 0o600;
const DKIM_DIR_MODE = 0o700;

/** Re-read the last few seconds of log on every tick; `since` only has second resolution. */
const INGEST_OVERLAP_MS = 5_000;
/** First-ever ingest for a server reaches back this far, so a fresh panel is not empty. */
const INGEST_COLD_START_MS = 6 * 3600_000;
/** Hard cap per tick so a log flood cannot blow up panel memory. */
const INGEST_MAX_LINES = 20_000;
/**
 * The port-25 probe opens a real connection to a remote MX and takes seconds. The UI polls
 * status every minute, so the answer is cached - whether a provider blocks the port changes
 * on the timescale of a support ticket, not a page refresh.
 */
const PORT25_CACHE_MS = 5 * 60_000;

/** Paths of the mail state directory on a server. Identical on every server (shared SRV_ROOT). */
export function mailPaths(config: Config) {
  const root = path.join(config.srvRoot, 'mail');
  return {
    root,
    /** Bind-mounted at /etc/opendkim/keys. */
    dkimDir: path.join(root, 'dkim'),
    keyTable: path.join(root, 'dkim', 'KeyTable'),
    /** Who owns which sender domain, for the signing policy (renderSenderLogins). */
    senderLogins: path.join(root, 'dkim', 'SenderLogins'),
    /** The signing policy the signer runs for every message (renderSigningPolicy). */
    signingPolicy: path.join(root, 'dkim', 'policy.lua'),
    trustedHosts: path.join(root, 'dkim', 'TrustedHosts'),
    /** Bind-mounted over /etc/opendkim/opendkim.conf. */
    opendkimConf: path.join(root, 'opendkim.conf'),
    /**
     * Panel-written overrides for the relay container, read by compose as an optional
     * `env_file`. This is how a setting changed in the panel survives the container being
     * recreated: `deploy/.env` lives in the checkout, which the panel cannot reach on its
     * own server, but `${SRV_ROOT}` is mounted into it. A restart is another matter - see
     * mailHostname.ts.
     */
    relayEnv: path.join(root, 'relay.env'),
  };
}

export interface MessageFilter {
  siteSlug?: string;
  status?: MailStatus;
  serverId?: number;
  /** Substring match against sender and recipient. */
  search?: string;
  sinceHours?: number;
  limit: number;
  offset: number;
}

export class MailService {
  private port25Cache = new Map<number, { open: boolean; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly settings: SettingsService,
    private readonly log: Logger,
    private readonly resolver: DnsResolver = systemResolver,
    /** Optional: when the panel holds a DNS token, the guide can publish records itself. */
    private readonly dns: DnsService | null = null,
    /** How long postfix gets to log a test message before it is read back (tests: 0). */
    private readonly testSendSettleMs = 1500,
  ) {}

  // -------------------------------------------------------------------- DKIM keys

  listDkimKeys(): MailDkimKeyRow[] {
    return this.db.select().from(mailDkimKeys).orderBy(asc(mailDkimKeys.domain)).all();
  }

  dkimKeyFor(domain: string): MailDkimKeyRow | undefined {
    return this.db.select().from(mailDkimKeys).where(eq(mailDkimKeys.domain, domain)).get();
  }

  dkimKeyToDto(row: MailDkimKeyRow): MailDkimKeyDto {
    const name = dkimRecordName(row.domain, row.selector);
    const value = dkimRecordValue(row.publicKeyB64);
    return {
      domain: row.domain,
      selector: row.selector,
      recordName: name,
      recordValue: value,
      recordBind: dkimRecordBind(name, value),
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt,
    };
  }

  /**
   * Create (or rotate) the signing key for a domain. Rotation deliberately keeps the same
   * selector: the operator republishes one record and old in-flight mail, already signed,
   * is unaffected because receivers fetch the key at verification time.
   */
  createDkimKey(domain: string, opts: { rotate?: boolean } = {}): MailDkimKeyRow {
    const existing = this.dkimKeyFor(domain);
    if (existing && !opts.rotate) throw conflict(`A DKIM key for "${domain}" already exists`);
    const material = generateDkimKey(existing?.selector ?? DEFAULT_DKIM_SELECTOR);
    const now = Date.now();
    if (existing) {
      return this.db
        .update(mailDkimKeys)
        .set({ privateKeyPem: material.privateKeyPem, publicKeyB64: material.publicKeyB64, rotatedAt: now })
        .where(eq(mailDkimKeys.id, existing.id))
        .returning()
        .get();
    }
    return this.db
      .insert(mailDkimKeys)
      .values({
        domain,
        selector: material.selector,
        privateKeyPem: material.privateKeyPem,
        publicKeyB64: material.publicKeyB64,
        createdAt: now,
      })
      .returning()
      .get();
  }

  deleteDkimKey(domain: string): void {
    const existing = this.dkimKeyFor(domain);
    if (!existing) throw notFound(`No DKIM key for "${domain}"`);
    this.db.delete(mailDkimKeys).where(eq(mailDkimKeys.id, existing.id)).run();
  }

  /**
   * Write every key and the OpenDKIM config onto one server, then restart its signer.
   *
   * All keys go to all servers rather than only the domains hosted there: the files are
   * small, and it means a site that moves is signed correctly from the moment it starts on
   * the target, with no key shuffling in the move path.
   */
  async syncDkimTo(serverId: number): Promise<{ domains: number; restarted: boolean }> {
    const handle = this.servers.handleFor(serverId);
    const keys = this.listDkimKeys();
    const p = mailPaths(this.config);

    await handle.files.mkdirp(p.dkimDir, { mode: DKIM_DIR_MODE });

    const keyFiles: DkimKeyFile[] = [];
    for (const key of keys) {
      // Domains are validated by domainSchema before they get here; safeJoin is the
      // belt-and-braces guard that a key can never be written outside the DKIM directory.
      const dir = safeJoin(p.dkimDir, key.domain);
      await handle.files.mkdirp(dir, { mode: DKIM_DIR_MODE });
      // OpenDKIM refuses to load ("key data is not secure") any private key that group or
      // other can read, and answers the milter with a tempfail - which postfix turns into
      // "451 Service unavailable" for every message from that domain. The mode is not
      // hygiene here, it is what makes signing work at all.
      await handle.files.writeFile(path.join(dir, `${key.selector}.private`), key.privateKeyPem, {
        mode: DKIM_KEY_MODE,
      });
      keyFiles.push({
        domain: key.domain,
        selector: key.selector,
        containerPath: `${KEYS_DIR_IN_CONTAINER}/${key.domain}/${key.selector}.private`,
      });
    }

    await handle.files.writeFile(p.keyTable, renderKeyTable(keyFiles));
    await handle.files.writeFile(p.senderLogins, renderSenderLogins(this.signerOwners()));
    await handle.files.writeFile(p.signingPolicy, renderSigningPolicy(KEYS_DIR_IN_CONTAINER));
    await handle.files.writeFile(p.trustedHosts, DKIM_TRUSTED_HOSTS);
    await handle.files.writeFile(p.opendkimConf, renderOpendkimConf(KEYS_DIR_IN_CONTAINER));

    // A key left behind after its domain was removed would keep signing mail nobody
    // publishes a record for, so the directory is reconciled rather than appended to - which
    // also takes away the SigningTable of the panels before the signing policy.
    const wanted = new Set<string>([
      ...keys.map((k) => k.domain),
      'KeyTable',
      'SenderLogins',
      'policy.lua',
      'TrustedHosts',
    ]);
    for (const entry of await handle.files.readdir(p.dkimDir).catch(() => [] as string[])) {
      if (wanted.has(entry)) continue;
      await handle.files.rm(path.join(p.dkimDir, entry)).catch(() => undefined);
    }

    // OpenDKIM reads its tables once at startup, so the config only takes effect on restart.
    let restarted = false;
    if ((await handle.docker.containerState(DKIM_CONTAINER)) === 'running') {
      await handle.docker.restartContainer(DKIM_CONTAINER);
      restarted = true;
    }
    return { domains: keys.length, restarted };
  }

  /**
   * Bring every reachable server's signer up to the config this panel writes, where it is not
   * already: the signer only reads its config at startup, and only a DKIM sync writes it. Run
   * at boot, so a new signing policy reaches every server however the update arrived (the
   * Update button, update.sh, a CD deploy) - and a server whose signer is current is not
   * restarted for nothing. Failures are reported, not thrown: mail keeps flowing either way.
   */
  async convergeSigners(): Promise<{ name: string; synced: boolean; error?: string }[]> {
    const p = mailPaths(this.config);
    const wantedConf = renderOpendkimConf(KEYS_DIR_IN_CONTAINER);
    const wantedPolicy = renderSigningPolicy(KEYS_DIR_IN_CONTAINER);
    const out: { name: string; synced: boolean; error?: string }[] = [];
    for (const row of this.servers.listRows()) {
      try {
        const handle = this.servers.handleFor(row.id);
        const read = (file: string) => handle.files.readFile(file).catch(() => null);
        if ((await read(p.opendkimConf)) === wantedConf && (await read(p.signingPolicy)) === wantedPolicy) {
          out.push({ name: row.name, synced: false });
          continue;
        }
        await this.syncDkimTo(row.id);
        out.push({ name: row.name, synced: true });
      } catch (err) {
        out.push({ name: row.name, synced: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  /** Push keys to every reachable server; unreachable ones are reported, not thrown. */
  async syncDkimEverywhere(): Promise<{ serverId: number; name: string; ok: boolean; detail: string }[]> {
    const out: { serverId: number; name: string; ok: boolean; detail: string }[] = [];
    for (const row of this.servers.listRows()) {
      try {
        const res = await this.syncDkimTo(row.id);
        out.push({
          serverId: row.id,
          name: row.name,
          ok: true,
          detail: res.restarted
            ? `${res.domains} key(s) written, signer restarted`
            : `${res.domains} key(s) written (signer not running here)`,
        });
      } catch (err) {
        out.push({ serverId: row.id, name: row.name, ok: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      }
    }
    return out;
  }

  // ------------------------------------------------------- relay authentication (SASL)

  /**
   * Sender domain -> the login allowed to use it. Every hostname a site answers to is
   * owned by that site; a domain that only has a DKIM key (kept after a site was deleted,
   * or created ahead of a migration) is parked on a login nobody holds, so it cannot be
   * spoofed either.
   */
  /**
   * The same owners, as the signing policy reads them: one per login, the pre-rename twin of a
   * site login included - it is the login a site not yet reconciled still authenticates with.
   * LEGACY(ceo) - drop the twins in 0.3.0, with legacyLoginFor.
   */
  private signerOwners(extra: SenderOwner[] = []): SignerOwner[] {
    return [...this.senderOwners(), ...extra].flatMap((o) => {
      const legacy = legacyLoginFor(o.login);
      return legacy ? [o, { domain: o.domain, login: legacy }] : [o];
    });
  }

  senderOwners(): SenderOwner[] {
    const owners: SenderOwner[] = [];
    for (const site of this.db.select().from(sites).all()) {
      const login = mailLogin(site.slug);
      for (const domain of JSON.parse(site.domains) as string[]) owners.push({ domain, login });
      if (site.devHostname) owners.push({ domain: site.devHostname, login });
    }
    const owned = new Set(owners.map((o) => o.domain.toLowerCase()));
    for (const key of this.listDkimKeys()) {
      if (!owned.has(key.domain.toLowerCase())) owners.push({ domain: key.domain, login: RESERVED_LOGIN });
    }
    return owners;
  }

  /** Logins the relay must currently refuse (abuse guard). */
  blockedLogins(): { login: string; reason: string }[] {
    return this.db
      .select()
      .from(sites)
      .where(isNotNull(sites.mailSuspendedAt))
      .all()
      .map((site) => ({
        login: mailLogin(site.slug),
        reason: site.mailSuspendReason ?? 'Outbound mail suspended by the panel',
      }));
  }

  /**
   * Write the relay's authentication state onto one server and reload postfix.
   *
   * Like the DKIM keys, every site's login goes to every server rather than only the ones
   * hosted there: a site that moves must be able to authenticate the instant its container
   * starts on the target, and the alternative is a credential shuffle inside the move path.
   *
   * Passwords are only (re)written for logins the server does not have yet - listing the
   * db is one exec, writing a credential is one exec each - unless `forceLogins` asks for
   * a rewrite, which is what a site reconcile does after minting a new one.
   */
  async syncMailAuthTo(
    serverId: number,
    opts: { forceLogins?: string[]; extraOwners?: SenderOwner[] } = {},
  ): Promise<{ logins: number; written: number; removed: number; reloaded: boolean }> {
    const handle = this.servers.handleFor(serverId);
    const p = mailAuthPaths(this.config);

    await handle.files.mkdirp(p.policyDir);
    await handle.files.mkdirp(p.saslDir);
    await handle.files.mkdirp(p.smtpdConfDir);
    await handle.files.writeFile(p.smtpdConf, renderSmtpdConf());
    // extraOwners covers the window in a go-live where a domain is already routed to the
    // site and WordPress is about to send from it, but the registry row still lists the old
    // one - without it, mail from the new domain would be rejected for those few seconds.
    await handle.files.writeFile(p.senderLogin, renderSenderLogin([...this.senderOwners(), ...(opts.extraOwners ?? [])]));
    await handle.files.writeFile(p.saslBlock, renderSaslBlock(this.blockedLogins()));
    // The signer holds the From: header to the same owners (renderSigningPolicy). It reads
    // this file for every message, so the owners change without a restart.
    const dkim = mailPaths(this.config);
    await handle.files.mkdirp(dkim.dkimDir, { mode: DKIM_DIR_MODE });
    await handle.files.writeFile(dkim.senderLogins, renderSenderLogins(this.signerOwners(opts.extraOwners)));

    const wanted = new Map<string, string>();
    for (const site of this.db.select().from(sites).all()) {
      if (!site.mailPassword) continue;
      wanted.set(mailLogin(site.slug), site.mailPassword);
      // LEGACY(ceo) - delete in 0.3.0. Same password under the pre-rename realm, so a site
      // whose msmtprc has not been rewritten yet keeps authenticating. Listing it as wanted
      // is also what stops the pruning loop below from deleting it.
      wanted.set(legacyMailLogin(site.slug), site.mailPassword);
    }

    if ((await handle.docker.containerState(MAIL_CONTAINER)) !== 'running') {
      // Files are on disk and will be picked up when the relay starts; the db needs it.
      return { logins: wanted.size, written: 0, removed: 0, reloaded: false };
    }

    // Local development swaps postfix for mailpit, which catches everything and enforces
    // nothing. Asking it for a credential database produces a pile of confusing warnings,
    // so the capability is checked once and reported plainly instead.
    const probe = await handle.docker.exec(
      MAIL_CONTAINER,
      ['sh', '-c', 'command -v saslpasswd2 >/dev/null && echo yes || echo no'],
      { timeoutMs: 20_000 },
    );
    if (!probe.stdout.includes('yes')) {
      this.log.info(
        `Mail auth: the relay on "${handle.name}" is not postfix (local dev uses mailpit) - ` +
          `sender authorization is not enforced there. Maps written; no credentials to install.`,
      );
      return { logins: wanted.size, written: 0, removed: 0, reloaded: false };
    }

    const listing = await handle.docker.exec(
      MAIL_CONTAINER,
      ['sh', '-c', `sasldblistusers2 -f ${SASLDB_IN_CONTAINER} 2>/dev/null || true`],
      { timeoutMs: 30_000 },
    );
    const existing = new Set(parseSaslUsers(listing.stdout));
    const force = new Set(opts.forceLogins ?? []);

    let written = 0;
    for (const [login, password] of wanted) {
      if (existing.has(login) && !force.has(login)) continue;
      // The realm comes from the login rather than from SASL_REALM: during the rename each
      // site has a credential in both realms (LEGACY(ceo), see mailAuth.ts).
      const user = login.slice(0, login.lastIndexOf('@'));
      const realm = login.slice(login.lastIndexOf('@') + 1);
      // No stdin on the docker exec API, so the password is piped in-container. It reaches
      // the daemon as an exec argument either way; the alternative (a temp file) would
      // leave it on disk.
      const res = await handle.docker.exec(
        MAIL_CONTAINER,
        [
          'sh',
          '-c',
          `printf '%s' ${sqSingle(password)} | saslpasswd2 -p -c -f ${SASLDB_IN_CONTAINER} -u ${sqSingle(realm)} ${sqSingle(user)}`,
        ],
        { timeoutMs: 30_000 },
      );
      if (res.exitCode !== 0) throw badGateway(`Could not write the relay credential for "${login}": ${res.stderr.slice(0, 200)}`);
      written++;
    }

    let removed = 0;
    for (const login of existing) {
      if (wanted.has(login)) continue;
      const user = login.slice(0, login.lastIndexOf('@'));
      const realm = login.slice(login.lastIndexOf('@') + 1);
      await handle.docker.exec(
        MAIL_CONTAINER,
        ['sh', '-c', `saslpasswd2 -d -f ${SASLDB_IN_CONTAINER} -u ${sqSingle(realm)} ${sqSingle(user)} || true`],
        { timeoutMs: 30_000 },
      );
      removed++;
    }

    // saslpasswd2 creates the db 0600 root:root, but smtpd reads it as the unprivileged
    // postfix user - without this every login fails with "unable to open Berkeley db".
    if (written > 0 || removed > 0) {
      const perms = await handle.docker.exec(
        MAIL_CONTAINER,
        ['sh', '-c', `chmod 640 ${SASLDB_IN_CONTAINER} && chown root:postfix ${SASLDB_IN_CONTAINER}`],
        { timeoutMs: 20_000 },
      );
      if (perms.exitCode !== 0) {
        this.log.warn(
          `Mail auth: could not set sasldb ownership (${perms.stderr.trim().slice(0, 200)}) - logins may fail`,
        );
      }
    }

    // texthash maps are read when a process starts, so the new maps only reach smtpd on reload.
    const reload = await handle.docker.exec(MAIL_CONTAINER, ['postfix', 'reload'], { timeoutMs: 30_000 });
    if (reload.exitCode !== 0) {
      this.log.warn(`Mail auth: postfix reload failed (${reload.stderr.trim().slice(0, 200)})`);
    }
    return { logins: wanted.size, written, removed, reloaded: reload.exitCode === 0 };
  }

  /** Push logins and maps to every reachable server; unreachable ones are reported, not thrown. */
  async syncMailAuthEverywhere(
    opts: { forceLogins?: string[]; extraOwners?: SenderOwner[] } = {},
  ): Promise<{ serverId: number; name: string; ok: boolean; detail: string }[]> {
    const out: { serverId: number; name: string; ok: boolean; detail: string }[] = [];
    for (const row of this.servers.listRows()) {
      try {
        const res = await this.syncMailAuthTo(row.id, opts);
        out.push({
          serverId: row.id,
          name: row.name,
          ok: true,
          detail: res.reloaded
            ? `${res.logins} login(s): ${res.written} written, ${res.removed} removed`
            : `${res.logins} login(s) staged (relay not running here)`,
        });
      } catch (err) {
        out.push({
          serverId: row.id,
          name: row.name,
          ok: false,
          detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
      }
    }
    return out;
  }

  /**
   * Stop (or resume) a site's outbound mail. Suspension is a relay-side reject rather than
   * a container stop: the site keeps serving its pages, which is the proportionate response
   * to "this site is sending like a spam run" while the operator looks at it.
   */
  async setSiteMailSuspended(siteId: number, suspended: boolean, reason?: string): Promise<void> {
    const site = this.db.select().from(sites).where(eq(sites.id, siteId)).get();
    if (!site) throw notFound(`No site with id ${siteId}`);
    this.db
      .update(sites)
      .set({
        mailSuspendedAt: suspended ? Date.now() : null,
        mailSuspendReason: suspended ? (reason ?? 'Outbound mail suspended by the panel') : null,
        updatedAt: Date.now(),
      })
      .where(eq(sites.id, siteId))
      .run();
    const results = await this.syncMailAuthEverywhere();
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      this.log.warn(
        `Mail suspension for "${site.slug}" is not in force on: ${failed.map((f) => `${f.name} (${f.detail})`).join(', ')}`,
      );
    }
  }

  // ------------------------------------------------------------------ abuse guard

  /**
   * Stop a site that is sending like a spam run.
   *
   * The volume figures already existed, but only as a colour on a page somebody had to be
   * looking at - meanwhile the queue fills and the server's IP earns a listing that every
   * other customer on it then pays for. This is the same number turned into an action: over
   * the threshold, the relay stops accepting that login's mail until an operator resumes it.
   *
   * Only ever automatic in one direction. Resuming is a human decision, because the
   * interesting question after a suspension - was this a compromise or a newsletter? - is
   * not one the counter can answer.
   */
  async enforceVolumeLimits(): Promise<{ suspended: string[] }> {
    const threshold = this.settings.get('mailSuspendPerSitePerHour') || 0;
    if (threshold <= 0) return { suspended: [] };

    const since = Date.now() - 3600_000;
    const rows = this.db
      .select({ slug: mailMessages.siteSlug, n: count() })
      .from(mailMessages)
      .where(and(gte(mailMessages.lastEventAt, since), isNotNull(mailMessages.siteSlug)))
      .groupBy(mailMessages.siteSlug)
      .all();

    const suspended: string[] = [];
    for (const row of rows) {
      if (!row.slug || row.n <= threshold) continue;
      const site = this.db.select().from(sites).where(eq(sites.slug, row.slug)).get();
      if (!site || site.mailSuspendedAt) continue;
      const reason = `Sent ${row.n} messages in an hour (limit ${threshold})`;
      this.log.warn(`Mail abuse guard: suspending outbound mail for "${site.slug}" - ${reason}`);
      await this.setSiteMailSuspended(site.id, true, reason);
      suspended.push(site.slug);
      await this.notifyOperator(
        `Outbound mail suspended for "${site.slug}"`,
        [
          `The relay has stopped accepting mail from the site "${site.slug}".`,
          '',
          `Reason: ${reason}.`,
          '',
          'That rate is what a compromised WordPress install looks like when it is being used',
          'to send spam. The site itself is still serving pages - only its outbound mail is',
          'blocked - so customers see no downtime while you look at it.',
          '',
          'Check the Mail page (Volume by site) for what it was sending, then either clean up',
          'the site or resume its mail from the site page.',
        ].join('\n'),
      ).catch((err: unknown) => this.log.warn(`Could not send the abuse alert: ${String(err)}`));
    }
    return { suspended };
  }

  /** Email the operator, at the alert address from Settings. */
  async notifyOperator(subject: string, body: string): Promise<boolean> {
    const to = (this.settings.get('alertEmail') ?? '').trim();
    if (!to) {
      this.log.warn(`Alert not emailed (no alert address configured in Settings): ${subject}`);
      return false;
    }
    return this.sendPanelMail(to, subject, body);
  }

  /**
   * One plain-text message from the panel itself: alerts, and the links that confirm a
   * recovery address or reset a password. Injected with sendmail inside the relay container
   * on the panel's own server rather than over SMTP, so it is not subject to the sender
   * authorization it is often reporting on, and works even when every site login is blocked.
   *
   * `true` means the relay took it, not that it arrived - delivery is postfix's business.
   */
  async sendPanelMail(to: string, subject: string, body: string): Promise<boolean> {
    const from = `wpl7-panel@${this.config.panelDomain || 'localhost'}`;
    const message = [
      `From: WPL7 panel <${from}>`,
      `To: <${to}>`,
      `Subject: [WPL7] ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
      '',
    ].join('\n');
    let failure: string;
    try {
      const server = this.servers.listRows()[0];
      if (!server) return false;
      const handle = this.servers.handleFor(server.id);
      if ((await handle.docker.containerState(MAIL_CONTAINER)) === 'running') {
        const line = `printf '%s' ${shellQuote([message])} | sendmail -f ${shellQuote([from])} -- ${shellQuote([to])}`;
        const res = await handle.docker.exec(MAIL_CONTAINER, ['sh', '-c', line], { timeoutMs: 30_000 });
        if (res.exitCode === 0) return true;
        failure = (res.stderr || res.stdout).slice(0, 200);
      } else {
        failure = `the ${MAIL_CONTAINER} container is not running`;
      }
    } catch (err) {
      failure = String(err);
    }
    // `npm run dev` without the Docker stack has no relay to hand anything to. Printing the
    // message is what lets a sign-in link be followed there at all; production never gets
    // here (the image sets NODE_ENV=production).
    if (this.config.nodeEnv === 'development') {
      this.log.info(`Email not sent (${failure}); in development it goes to the log instead:\n${message}`);
      return true;
    }
    this.log.warn(`Email to ${to} not sent: ${failure}`);
    return false;
  }

  // -------------------------------------------------------------------- status

  /**
   * Domains this fleet sends from.
   *
   * Dev hostnames are collapsed into their dev domain: the signing table gives every key a
   * `*@*.<domain>` entry, so one key published at `dev.example.com` signs all fifty dev
   * sites under it. Listing them individually would be fifty rows asking for fifty DNS
   * records that a single record already covers.
   */
  sendingDomains(serverId?: number): { domain: string; sites: string[] }[] {
    const devDomains = this.servers.listRows().map((s) => s.devDomain).filter(Boolean);
    const collapse = (host: string): string =>
      devDomains.find((dev) => host === dev || host.endsWith(`.${dev}`)) ?? host;

    const byDomain = new Map<string, Set<string>>();
    for (const site of this.db.select().from(sites).all()) {
      if (serverId !== undefined && site.serverId !== serverId) continue;
      for (const host of JSON.parse(site.domains) as string[]) {
        const domain = collapse(host);
        const list = byDomain.get(domain) ?? new Set<string>();
        list.add(site.slug);
        byDomain.set(domain, list);
      }
    }
    return [...byDomain.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, slugs]) => ({ domain, sites: [...slugs].sort() }));
  }

  /**
   * How many domains the sites on one server send from, and which of them no key signs for:
   * neither the domain nor any domain above it has one - the signer's own rule
   * (renderSigningPolicy). Mail from those goes out without a signature.
   */
  private dkimCoverage(serverId: number): { sending: number; unsigned: string[] } {
    const keyDomains = this.listDkimKeys().map((k) => k.domain.toLowerCase());
    const signed = (domain: string) => keyDomains.some((k) => domain === k || domain.endsWith(`.${k}`));
    const domains = this.sendingDomains(serverId).map((d) => d.domain.toLowerCase());
    return { sending: domains.length, unsigned: domains.filter((d) => !signed(d)) };
  }

  async statusFor(serverId: number): Promise<MailServerStatusDto> {
    const handle = this.servers.handleFor(serverId);
    const checks: ServerCheck[] = [];
    const add = (name: string, ok: boolean, detail: string, warn = false) =>
      checks.push(warn ? { name, ok, detail, warn } : { name, ok, detail });

    let relayState: string;
    try {
      relayState = await handle.docker.containerState(MAIL_CONTAINER);
    } catch (err) {
      return {
        serverId,
        serverName: handle.name,
        ok: false,
        relayRunning: false,
        dkimRunning: false,
        mode: this.config.mailMode,
        hostname: '',
        relayhost: '',
        queued: 0,
        deferred: 0,
        signedDomains: 0,
        checks: [{ name: 'relay', ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) }],
      };
    }
    const relayRunning = relayState === 'running';
    add('relay', relayRunning, relayRunning ? `${MAIL_CONTAINER} is running` : `${MAIL_CONTAINER} is ${relayState} — PHP mail() from every site on this server will fail`);

    const dkimState = await handle.docker.containerState(DKIM_CONTAINER).catch(() => 'missing' as const);
    const dkimRunning = dkimState === 'running';
    const keyCount = this.listDkimKeys().length;
    const { sending, unsigned } = this.dkimCoverage(serverId);
    if (!dkimRunning && keyCount > 0) {
      add('dkim', false, `${DKIM_CONTAINER} is ${dkimState} but ${keyCount} key(s) exist — mail is going out unsigned`);
    } else if (unsigned.length > 0) {
      // Not broken - the mail is delivered - but unsigned mail is what receivers trust least,
      // and with no signature DMARC can only pass on SPF, which forwarding breaks.
      const names = unsigned.length > 3 ? `${unsigned.slice(0, 3).join(', ')} and ${unsigned.length - 3} more` : unsigned.join(', ');
      add(
        'dkim',
        true,
        `No DKIM key for ${unsigned.length} of ${sending} sending domain(s), so their mail goes out unsigned: ${names}. ` +
          'Create keys in DKIM & DMARC.',
        true,
      );
    } else if (dkimRunning) {
      add(
        'dkim',
        true,
        sending > 0
          ? `${DKIM_CONTAINER} is running, signing for all ${sending} sending domain(s)`
          : `${DKIM_CONTAINER} is running; no site on this server sends mail yet`,
      );
    } else {
      add('dkim', true, `${DKIM_CONTAINER} is ${dkimState}; no DKIM keys configured yet`);
    }

    let hostname = '';
    let relayhost = '';
    if (relayRunning) {
      const res = await handle.docker
        .exec(MAIL_CONTAINER, ['postconf', '-h', 'myhostname', 'relayhost', 'smtpd_milters'], { timeoutMs: 20_000 })
        .catch(() => null);
      const [h = '', r = '', milters = ''] = (res?.stdout ?? '').split('\n').map((s) => s.trim());
      hostname = h;
      relayhost = r;
      add('hostname', !!hostname, hostname ? `announces itself as ${hostname}` : 'postfix could not report myhostname');
      const mode = relayhost ? 'smarthost' : 'direct';
      add(
        'mode',
        true,
        relayhost ? `smarthost: relaying through ${relayhost}` : 'direct delivery: this server talks to recipient MX servers itself',
      );
      add(
        'milter',
        keyCount === 0 || !!milters,
        milters
          ? `signing milter wired up (${milters})`
          : 'postfix has no DKIM milter configured — re-run provisioning so the mail container picks up POSTFIX_smtpd_milters',
      );
      if (mode === 'direct') {
        // Most VPS providers block outbound 25 until asked; that failure is otherwise
        // invisible until customers report missing mail days later.
        const open = await this.port25Open(handle);
        add(
          'port-25',
          open,
          open
            ? 'outbound port 25 is open'
            : 'outbound port 25 appears blocked — ask your VPS provider to unblock it, or set SMTP_RELAYHOST to use a smarthost',
        );
      }
    }

    let queued = 0;
    let deferred = 0;
    if (relayRunning) {
      const entries = await this.queueFor(serverId).catch(() => [] as QueueEntry[]);
      queued = entries.length;
      deferred = entries.filter((e) => e.queueName === 'deferred').length;
      add(
        'queue',
        deferred < 50,
        queued === 0 ? 'queue is empty' : `${queued} message(s) queued, ${deferred} deferred`,
      );
    }

    return {
      serverId,
      serverName: handle.name,
      ok: checks.every((c) => c.ok),
      relayRunning,
      dkimRunning,
      mode: relayhost ? 'smarthost' : 'direct',
      hostname,
      relayhost,
      queued,
      deferred,
      signedDomains: keyCount,
      checks,
    };
  }

  /** Cached outbound-25 reachability for one server. */
  private async port25Open(handle: ServerHandle): Promise<boolean> {
    const cached = this.port25Cache.get(handle.id);
    if (cached && Date.now() - cached.at < PORT25_CACHE_MS) return cached.open;
    const probe = await handle.docker
      .exec(MAIL_CONTAINER, ['sh', '-c', 'timeout 8 nc -z gmail-smtp-in.l.google.com 25 && echo open || echo blocked'], {
        timeoutMs: 25_000,
      })
      .catch(() => null);
    const open = (probe?.stdout ?? '').includes('open');
    this.port25Cache.set(handle.id, { open, at: Date.now() });
    return open;
  }

  async status(): Promise<MailServerStatusDto[]> {
    const out: MailServerStatusDto[] = [];
    for (const row of this.servers.listRows()) {
      try {
        out.push(await this.statusFor(row.id));
      } catch (err) {
        out.push({
          serverId: row.id,
          serverName: row.name,
          ok: false,
          relayRunning: false,
          dkimRunning: false,
          mode: this.config.mailMode,
          hostname: '',
          relayhost: '',
          queued: 0,
          deferred: 0,
          signedDomains: 0,
          checks: [{ name: 'server', ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) }],
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------- queue

  async queueFor(serverId: number): Promise<QueueEntry[]> {
    const handle = this.servers.handleFor(serverId);
    const res = await handle.docker.exec(MAIL_CONTAINER, ['postqueue', '-j'], { timeoutMs: 30_000 });
    if (res.exitCode !== 0) throw badGateway('Could not read the mail queue', (res.stderr || res.stdout).slice(0, 300));
    return parsePostqueueJson(res.stdout);
  }

  async queue(serverId?: number): Promise<MailQueueDto[]> {
    const rows = serverId !== undefined ? [this.servers.rowById(serverId)] : this.servers.listRows();
    const out: MailQueueDto[] = [];
    for (const row of rows) {
      if (!row) continue;
      const entries = await this.queueFor(row.id).catch(() => [] as QueueEntry[]);
      for (const entry of entries) {
        out.push({
          serverId: row.id,
          serverName: row.name,
          queueId: entry.queueId,
          queueName: entry.queueName,
          arrivalTime: entry.arrivalTime,
          sizeBytes: entry.sizeBytes,
          sender: entry.sender,
          recipients: entry.recipients,
          siteSlug: this.siteForQueueId(row.id, entry.queueId),
        });
      }
    }
    return out.sort((a, b) => b.arrivalTime - a.arrivalTime);
  }

  private siteForQueueId(serverId: number, queueId: string): string | null {
    const row = this.db
      .select({ siteSlug: mailMessages.siteSlug })
      .from(mailMessages)
      .where(and(eq(mailMessages.serverId, serverId), eq(mailMessages.queueId, queueId)))
      .get();
    return row?.siteSlug ?? null;
  }

  /** Ask postfix to retry everything now (after fixing a relay password, DNS, …). */
  async flushQueue(serverId: number): Promise<void> {
    const handle = this.servers.handleFor(serverId);
    const res = await handle.docker.exec(MAIL_CONTAINER, ['postqueue', '-f'], { timeoutMs: 60_000 });
    if (res.exitCode !== 0) throw badGateway('Queue flush failed', (res.stderr || res.stdout).slice(0, 300));
  }

  /** Drop one message, or the whole queue when `queueId` is 'ALL' (postsuper's own syntax). */
  async deleteQueued(serverId: number, queueId: string): Promise<void> {
    if (!/^(ALL|[A-Za-z0-9]{6,20})$/.test(queueId)) throw badRequest('Not a valid queue id');
    const handle = this.servers.handleFor(serverId);
    const res = await handle.docker.exec(MAIL_CONTAINER, ['postsuper', '-d', queueId], { timeoutMs: 60_000 });
    if (res.exitCode !== 0) throw badGateway('Deleting from the queue failed', (res.stderr || res.stdout).slice(0, 300));
  }

  // -------------------------------------------------------------------- test send

  /**
   * Inject a message straight into the relay, bypassing WordPress. This isolates the half
   * of the path the panel owns: if this arrives and a site's test does not, the problem is
   * in that site rather than in mail delivery.
   */
  async sendTestFromRelay(serverId: number, opts: { from: string; to: string; subject?: string }): Promise<{ detail: string }> {
    const handle = this.servers.handleFor(serverId);
    if ((await handle.docker.containerState(MAIL_CONTAINER)) !== 'running') {
      throw conflict(`${MAIL_CONTAINER} is not running on "${handle.name}"`);
    }
    const subject = opts.subject ?? 'WPL7 mail test';
    const message = [
      `From: WPL7 panel <${opts.from}>`,
      `To: <${opts.to}>`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This is a test message from the WPL7 control panel.',
      '',
      `Sent through the relay on "${handle.name}" as ${opts.from}.`,
      'If it arrived and is signed (check the message headers for DKIM-Signature),',
      'outbound mail for this domain is working.',
      '',
    ].join('\n');

    // sendmail needs the body on stdin and DockerPort.exec has no stdin, so the message is
    // handed over as a quoted argument to printf inside the container's own shell.
    const line = `printf '%s' ${shellQuote([message])} | sendmail -f ${shellQuote([opts.from])} -- ${shellQuote([opts.to])}`;
    const res = await handle.docker.exec(MAIL_CONTAINER, ['sh', '-c', line], { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw badGateway('The relay refused the test message', (res.stderr || res.stdout).slice(0, 500));
    }
    // Give postfix a moment to log the hand-off, then pull it into the traffic view so the
    // result is visible immediately instead of at the next scheduled ingest.
    await new Promise((r) => setTimeout(r, this.testSendSettleMs));
    await this.ingestServer(serverId).catch(() => undefined);
    return {
      detail: `Queued for ${opts.to}. Follow it in Traffic below; delivery to the recipient's server may take a few seconds.`,
    };
  }

  // -------------------------------------------------------------------- log ingest

  private cursors(): Record<string, number> {
    return (this.settings.getRaw('mail.logCursor') as Record<string, number> | undefined) ?? {};
  }

  private setCursor(serverId: number, ts: number): void {
    this.settings.setRaw('mail.logCursor', { ...this.cursors(), [serverId]: ts });
  }

  /**
   * Pull new log lines from every server into `mail_messages`, then apply the abuse guard.
   * Also puts back a relay's hostname where a restart moved it (convergeHostname).
   */
  async ingestTick(): Promise<void> {
    for (const row of this.servers.listRows()) {
      if (row.status === 'unreachable') continue;
      try {
        await this.ingestServer(row.id);
      } catch (err) {
        this.log.warn(`Mail log ingest for server "${row.name}" failed: ${err instanceof Error ? err.message : err}`);
      }
      try {
        await this.convergeHostname(row.id);
      } catch (err) {
        this.log.warn(`Mail hostname check for server "${row.name}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Runs on the freshly ingested rows: the guard is only ever as current as the traffic
    // view, and a minute of spam is the resolution this buys.
    try {
      await this.enforceVolumeLimits();
    } catch (err) {
      this.log.warn(`Mail abuse guard failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async ingestServer(serverId: number): Promise<{ events: number }> {
    const handle = this.servers.handleFor(serverId);
    if ((await handle.docker.containerState(MAIL_CONTAINER)) !== 'running') return { events: 0 };

    const cursor = this.cursors()[serverId] ?? Date.now() - INGEST_COLD_START_MS;
    const sinceSec = Math.max(0, Math.floor((cursor - INGEST_OVERLAP_MS) / 1000));
    const readAt = Date.now();

    const postfixLog = await handle.docker.containerLogs(MAIL_CONTAINER, { sinceSec, tail: INGEST_MAX_LINES });
    // The signer logs under its own container but speaks about the same queue ids, which is
    // what lets a signature be attributed to an individual message.
    const dkimLog = await handle.docker.containerLogs(DKIM_CONTAINER, { sinceSec, tail: INGEST_MAX_LINES }).catch(() => '');

    const events = [...parseMailLog(postfixLog, readAt), ...parseMailLog(dkimLog, readAt)].sort((a, b) => a.ts - b.ts);
    if (events.length > 0) {
      const dkimAvailable = dkimLog.length > 0;
      let failed = 0;
      this.db.transaction(() => {
        for (const event of events) {
          // Per-event rather than per-tick: letting one unexpected line abort the
          // transaction would roll back the whole read AND leave the cursor unmoved, so the
          // same line would poison every following tick and the traffic view would stop
          // updating for good.
          try {
            this.applyEvent(serverId, event, dkimAvailable);
          } catch (err) {
            failed++;
            if (failed === 1) {
              this.log.warn(`Mail log event could not be stored (${event.kind}): ${err instanceof Error ? err.message : err}`);
            }
          }
        }
      });
      if (failed > 1) this.log.warn(`${failed} mail log events were skipped on server #${serverId}`);
    }
    this.setCursor(serverId, readAt);
    return { events: events.length };
  }

  /** Apply one parsed log event. Every path is idempotent: the overlap window replays lines. */
  private applyEvent(serverId: number, event: MailLogEvent, dkimAvailable: boolean): void {
    if (event.kind === 'reject') {
      // A refused message never got a queue id, so one is derived from the event itself -
      // stable across replays of the same line, unique between different ones.
      const fingerprint = `nq-${Buffer.from(`${event.ts}|${event.clientHost ?? ''}|${event.from ?? ''}|${event.to ?? ''}`)
        .toString('base64url')
        .slice(0, 16)}`;
      this.upsertRow(serverId, fingerprint, event.to ?? '', {
        clientHost: event.clientHost ?? null,
        siteSlug: siteSlugFromClient(event.clientHost),
        fromAddr: event.from ?? '',
        status: 'rejected',
        detail: event.detail ?? null,
        firstSeenAt: event.ts,
        lastEventAt: event.ts,
      });
      return;
    }

    if (event.kind === 'envelope') {
      const patch: Partial<typeof mailMessages.$inferInsert> = { lastEventAt: event.ts };
      if (event.clientHost !== undefined) {
        patch.clientHost = event.clientHost;
        patch.siteSlug = siteSlugFromClient(event.clientHost);
      }
      if (event.from !== undefined) patch.fromAddr = event.from;
      if (event.sizeBytes !== undefined) patch.sizeBytes = event.sizeBytes;
      if (event.nrcpt !== undefined) patch.nrcpt = event.nrcpt;

      const existing = this.rowsForQueue(serverId, event.queueId);
      if (existing.length === 0) {
        this.upsertRow(serverId, event.queueId, '', { ...patch, status: 'queued', firstSeenAt: event.ts });
        return;
      }
      // Envelope details arrive before delivery but may be replayed after it; apply them to
      // every recipient row so a late `from=` still lands on all of them.
      for (const row of existing) {
        this.db.update(mailMessages).set(patch).where(eq(mailMessages.id, row.id)).run();
      }
      return;
    }

    if (event.kind === 'dkim') {
      const patch = { dkimSigned: event.signed ? 1 : 0, dkimDomain: event.domain ?? null };
      const existing = this.rowsForQueue(serverId, event.queueId);
      if (existing.length === 0) {
        this.upsertRow(serverId, event.queueId, '', { ...patch, status: 'queued', firstSeenAt: event.ts, lastEventAt: event.ts });
        return;
      }
      for (const row of existing) {
        this.db.update(mailMessages).set(patch).where(eq(mailMessages.id, row.id)).run();
      }
      return;
    }

    // Delivery: complete the placeholder if it is still waiting for a recipient, otherwise
    // this is another recipient of the same message and gets its own row.
    const rows = this.rowsForQueue(serverId, event.queueId);
    // Claiming the placeholder writes this recipient into it, so only do that when the
    // recipient has no row of its own - otherwise the write would hit the unique index.
    const placeholder = rows.some((r) => r.toAddr === event.to) ? undefined : rows.find((r) => r.toAddr === '');
    const envelope = rows[0];
    const delivery = {
      status: event.status,
      // A rejected message never gets a `qmgr: from=` line, so its sender arrives here.
      ...(event.from !== undefined ? { fromAddr: event.from } : {}),
      relay: event.relay ?? null,
      dsn: event.dsn ?? null,
      delayMs: event.delayMs ?? null,
      detail: event.detail?.slice(0, 500) ?? null,
      lastEventAt: event.ts,
      // By the time postfix reports delivery the milter has already run, so a message with
      // no signing line by now was genuinely not signed.
      ...(dkimAvailable && envelope?.dkimSigned === null ? { dkimSigned: 0 } : {}),
    };

    if (placeholder) {
      // Two recipients racing for the same placeholder would collide on the unique index;
      // claim it by id and let any later recipient fall through to its own row.
      this.db.update(mailMessages).set({ toAddr: event.to, ...delivery }).where(eq(mailMessages.id, placeholder.id)).run();
      return;
    }
    this.upsertRow(serverId, event.queueId, event.to, {
      clientHost: envelope?.clientHost ?? null,
      siteSlug: envelope?.siteSlug ?? null,
      fromAddr: envelope?.fromAddr ?? '',
      sizeBytes: envelope?.sizeBytes ?? null,
      nrcpt: envelope?.nrcpt ?? null,
      dkimSigned: envelope?.dkimSigned ?? null,
      dkimDomain: envelope?.dkimDomain ?? null,
      firstSeenAt: envelope?.firstSeenAt ?? event.ts,
      ...delivery,
    });
  }

  private rowsForQueue(serverId: number, queueId: string): MailMessageRow[] {
    return this.db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.serverId, serverId), eq(mailMessages.queueId, queueId)))
      .all();
  }

  private upsertRow(
    serverId: number,
    queueId: string,
    toAddr: string,
    values: Partial<typeof mailMessages.$inferInsert> & { status?: string; firstSeenAt?: number; lastEventAt?: number },
  ): void {
    const now = Date.now();
    const { firstSeenAt, lastEventAt, status, ...rest } = values;
    this.db
      .insert(mailMessages)
      .values({
        serverId,
        queueId,
        toAddr,
        status: status ?? 'queued',
        firstSeenAt: firstSeenAt ?? now,
        lastEventAt: lastEventAt ?? now,
        ...rest,
      })
      .onConflictDoUpdate({
        target: [mailMessages.serverId, mailMessages.queueId, mailMessages.toAddr],
        set: { ...rest, ...(status ? { status } : {}), lastEventAt: lastEventAt ?? now },
      })
      .run();
  }

  // -------------------------------------------------------------------- queries

  messages(filter: MessageFilter): { items: MailMessageDto[]; total: number } {
    const conditions = [];
    if (filter.siteSlug) conditions.push(eq(mailMessages.siteSlug, filter.siteSlug));
    if (filter.status) conditions.push(eq(mailMessages.status, filter.status));
    if (filter.serverId !== undefined) conditions.push(eq(mailMessages.serverId, filter.serverId));
    if (filter.sinceHours) conditions.push(gte(mailMessages.lastEventAt, Date.now() - filter.sinceHours * 3600_000));
    if (filter.search) {
      const needle = `%${filter.search.toLowerCase()}%`;
      conditions.push(or(like(mailMessages.fromAddr, needle), like(mailMessages.toAddr, needle)));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const total = this.db.select({ n: count() }).from(mailMessages).where(where).get()?.n ?? 0;
    const rows = this.db
      .select()
      .from(mailMessages)
      .where(where)
      .orderBy(desc(mailMessages.lastEventAt))
      .limit(filter.limit)
      .offset(filter.offset)
      .all();
    const serverNames = new Map(this.servers.listRows().map((s) => [s.id, s.name]));
    return {
      items: rows.map((row) => ({
        id: row.id,
        serverId: row.serverId,
        serverName: serverNames.get(row.serverId) ?? `#${row.serverId}`,
        queueId: row.queueId,
        siteSlug: row.siteSlug,
        from: row.fromAddr,
        to: row.toAddr,
        status: row.status as MailStatus,
        sizeBytes: row.sizeBytes,
        relay: row.relay,
        dsn: row.dsn,
        delayMs: row.delayMs,
        detail: row.detail,
        dkimSigned: row.dkimSigned === null ? null : row.dkimSigned === 1,
        dkimDomain: row.dkimDomain,
        firstSeenAt: row.firstSeenAt,
        lastEventAt: row.lastEventAt,
      })),
      total,
    };
  }

  /**
   * Volume and failure rates over a window, plus the per-site counters the abuse view
   * reads. A site whose mail suddenly spikes, or whose bounce rate jumps, is the signature
   * of a compromised install being used to send spam - which is why the sender is taken
   * from the *connection* (the site's container) and not from the From: header.
   */
  stats(hours: number): MailStatsDto {
    const since = Date.now() - hours * 3600_000;
    const rows = this.db.select().from(mailMessages).where(gte(mailMessages.lastEventAt, since)).all();

    const byStatus: Record<string, number> = { queued: 0, sent: 0, deferred: 0, bounced: 0, expired: 0, rejected: 0 };
    const perSite = new Map<string, { sent: number; failed: number; recipients: Set<string>; lastAt: number }>();
    const perHour = new Map<number, { ts: number; sent: number; failed: number }>();
    const perRecipientDomain = new Map<string, number>();

    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      const failed = row.status === 'bounced' || row.status === 'rejected' || row.status === 'expired';
      const key = row.siteSlug ?? '(relay)';
      const site = perSite.get(key) ?? { sent: 0, failed: 0, recipients: new Set<string>(), lastAt: 0 };
      if (row.status === 'sent') site.sent++;
      if (failed) site.failed++;
      if (row.toAddr) site.recipients.add(row.toAddr.toLowerCase());
      site.lastAt = Math.max(site.lastAt, row.lastEventAt);
      perSite.set(key, site);

      const bucket = Math.floor(row.lastEventAt / 3600_000) * 3600_000;
      const h = perHour.get(bucket) ?? { ts: bucket, sent: 0, failed: 0 };
      if (row.status === 'sent') h.sent++;
      if (failed) h.failed++;
      perHour.set(bucket, h);

      const domain = row.toAddr.split('@')[1]?.toLowerCase();
      if (domain) perRecipientDomain.set(domain, (perRecipientDomain.get(domain) ?? 0) + 1);
    }

    const perHourThreshold = this.settings.get('mailAlertPerSitePerHour') || 200;
    const budget = perHourThreshold * Math.max(1, hours);

    const suspendedSlugs = new Set(
      this.db
        .select({ slug: sites.slug })
        .from(sites)
        .where(isNotNull(sites.mailSuspendedAt))
        .all()
        .map((r) => r.slug),
    );

    return {
      hours,
      total: rows.length,
      byStatus: byStatus as MailStatsDto['byStatus'],
      perHour: [...perHour.values()].sort((a, b) => a.ts - b.ts),
      topSites: [...perSite.entries()]
        .map(([siteSlug, s]) => ({
          siteSlug,
          sent: s.sent,
          failed: s.failed,
          total: s.sent + s.failed,
          uniqueRecipients: s.recipients.size,
          lastAt: s.lastAt,
          // Two independent smells: raw volume against the configured budget, and a
          // failure rate high enough to mean the recipient list is not a real audience.
          overBudget: s.sent + s.failed > budget,
          highFailureRate: s.sent + s.failed >= 20 && s.failed / Math.max(1, s.sent + s.failed) > 0.4,
          mailSuspended: suspendedSlugs.has(siteSlug),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 25),
      topRecipientDomains: [...perRecipientDomain.entries()]
        .map(([domain, n]) => ({ domain, count: n }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      perSiteHourlyBudget: perHourThreshold,
    };
  }

  /** Drop traffic rows past the retention window (called from the nightly maintenance job). */
  prune(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 24 * 3600_000;
    const doomed = this.db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(lt(mailMessages.lastEventAt, cutoff))
      .all();
    if (doomed.length === 0) return 0;
    this.db.delete(mailMessages).where(lt(mailMessages.lastEventAt, cutoff)).run();
    return doomed.length;
  }

  // -------------------------------------------------------------------- deliverability

  /**
   * Per-domain DKIM/SPF/DMARC state, with the exact records to publish. Checks run against
   * public DNS, so this answers "did the customer actually add the record?" rather than
   * "did we ask them to".
   */
  async domains(only?: string): Promise<MailDomainDto[]> {
    const serverRows = this.servers.listRows();
    const serverIps = serverRows.map((s) => s.publicIp).filter(Boolean);
    const direct = this.config.mailMode === 'direct';
    const keys = new Map(this.listDkimKeys().map((k) => [k.domain, k]));

    const wanted = this.sendingDomains().filter((d) => !only || d.domain === only);
    // A domain with a key but no site left still needs to be listed: its DNS record is
    // published and its key is still being handed to every server.
    for (const [domain, key] of keys) {
      if (only && domain !== only) continue;
      if (!wanted.some((d) => d.domain === domain)) wanted.push({ domain, sites: [] });
    }

    return Promise.all(
      wanted.map(async ({ domain, sites: siteSlugs }) => {
        const key = keys.get(domain);
        const [dkim, spf, dmarc, dnsManaged] = await Promise.all([
          key ? checkDkim(this.resolver, domain, key.selector, key.publicKeyB64) : Promise.resolve(dkimNotConfigured()),
          // A smarthost sends from the provider's IPs, not ours, so checking our addresses
          // against the record would report a failure that is not one.
          direct ? checkSpf(this.resolver, domain, serverIps) : checkSpf(this.resolver, domain, []),
          checkDmarc(this.resolver, domain),
          // Memoized per zone inside DnsService, so a fleet of customer domains under one
          // account costs one lookup, not one per domain.
          this.dns?.canManage(domain) ?? Promise.resolve(false),
        ]);
        const steps = planDomainSteps({
          domain,
          mode: this.config.mailMode,
          serverIps,
          spf,
          dkim,
          dmarc,
          dkimKey: key ? { selector: key.selector, publicKeyB64: key.publicKeyB64 } : null,
          dnsManaged,
        });
        return {
          domain,
          sites: siteSlugs,
          dkim,
          spf,
          dmarc,
          dkimKey: key ? this.dkimKeyToDto(key) : null,
          suggestedSpf: direct ? suggestedSpf(serverIps) : 'v=spf1 include:<your SMTP provider> ~all',
          suggestedDmarc: suggestedDmarc(`dmarc@${domain}`),
          steps,
          ready: steps.every((step) => step.automation.state === 'satisfied'),
        };
      }),
    );
  }

  /**
   * Everything the setup guide shows: how mail leaves this fleet, what each server still
   * needs, and the per-domain record plan. Assembled in one call so the guide is a single
   * request rather than a cascade the operator watches load.
   */
  async setup(): Promise<MailSetupDto> {
    const statuses = await this.status();
    const byServer = new Map(statuses.map((st) => [st.serverId, st]));

    const servers: MailServerSetupDto[] = await Promise.all(
      this.servers.listRows().map(async (row): Promise<MailServerSetupDto> => {
        const status = byServer.get(row.id);
        const hostname = status?.hostname ?? '';
        const port25 = status?.checks.find((c) => c.name === 'port-25');
        const [hostnameA, reverseDns, hostnameAutomatable, settings] = await Promise.all([
          row.publicIp
            ? checkHostnameA(this.resolver, hostname, row.publicIp)
            : Promise.resolve({ verdict: 'missing' as const, found: null, detail: 'This server has no public IP recorded' }),
          row.publicIp
            ? checkReverseDns(this.resolver, row.publicIp, hostname || undefined)
            : Promise.resolve({ verdict: 'missing' as const, found: null, detail: 'This server has no public IP recorded' }),
          hostname ? (this.dns?.canManage(hostname) ?? Promise.resolve(false)) : Promise.resolve(false),
          this.hostnameSettings(row.id),
        ]);
        return {
          serverId: row.id,
          name: row.name,
          ip: row.publicIp,
          hostname,
          defaultHostname: settings.fallback,
          hostnameOverride: settings.override,
          mode: status?.mode ?? this.config.mailMode,
          hostnameA,
          reverseDns,
          port25: port25 ? { ok: port25.ok, detail: port25.detail } : null,
          hostnameAutomatable,
        };
      }),
    );

    return {
      mode: this.config.mailMode,
      dns: {
        configured: this.dns?.enabled ?? false,
        provider: this.dns?.enabled ? CLOUDFLARE : '',
        hint:
          'Add a Cloudflare API token under Settings → DNS (Zone → Zone → Read and Zone → DNS → Edit on the zones you host). ' +
          'The panel then publishes SPF, DKIM and DMARC for any domain whose zone that token reaches — ' +
          'the same token the wildcard certificate and the per-site records use.',
      },
      servers,
      // Reverse DNS is set where the IP was rented, not in the domain's zone, so no DNS
      // token can reach it - these are instructions, deliberately not a button.
      rdnsGuides: RDNS_GUIDES,
      domains: await this.domains(),
    };
  }

  /**
   * Change the name the relay announces in HELO, or - `hostname` null - go back to the default.
   *
   * Two writes, because neither alone is enough. `postconf` + `postfix reload` makes it true
   * now, without dropping the queue or a connection - but it lives in the container's
   * filesystem and a recreate would revert it. The override file makes it survive that,
   * because compose reads it back as an `env_file` on the next `up`. A restart in between is
   * convergeHostname's to repair.
   *
   * Asking for the default name is going back to it: no override is written, so the relay
   * keeps following MAIL_HOSTNAME if that changes later.
   */
  async setMailHostname(
    serverId: number,
    hostname: string | null,
  ): Promise<{ effective: string; applied: boolean; detail: string }> {
    const handle = this.servers.handleFor(serverId);
    const p = mailPaths(this.config);
    const running = (await handle.docker.containerState(MAIL_CONTAINER)) === 'running';
    const names = running ? await this.relayHostnames(handle) : null;
    const override = hostname !== null && !(names && sameHostname(hostname, names.fallback)) ? hostname : null;

    await handle.files.mkdirp(p.root);
    const next = relayEnvWith(await this.readRelayEnv(handle), override);
    if (next === null) await handle.files.rm(p.relayEnv);
    else await handle.files.writeFile(p.relayEnv, next);

    if (!running) {
      return {
        effective: override ?? '',
        applied: false,
        detail: `Saved. ${MAIL_CONTAINER} is not running on "${handle.name}", so it takes effect when the relay next starts.`,
      };
    }
    const wanted = override ?? names?.fallback;
    if (wanted === undefined) {
      throw badGateway(
        'Removed the override, but the relay did not report its default name, so it changes once the relay is recreated',
      );
    }
    const effective = await this.announce(handle, wanted || null);
    return {
      effective,
      applied: true,
      detail:
        `The relay now announces itself as ${effective}${override === null ? ', the default' : ''}. ` +
        `Point an A record at this server for it and update the server's reverse DNS to match; ` +
        `the setup guide's checks follow on their own.`,
    };
  }

  /** Go back to the default name: MAIL_HOSTNAME, as the relay was created with it. */
  resetMailHostname(serverId: number): Promise<{ effective: string; applied: boolean; detail: string }> {
    return this.setMailHostname(serverId, null);
  }

  /**
   * Put the name the relay announces back to the one it should have, where a restart moved it.
   *
   * A restarted relay re-applies the environment its container was created with
   * (mailHostname.ts), so an override set or removed since then is undone until compose next
   * recreates it. Checked on every mail-log tick: one file read and one exec, and the repair
   * is a reload, so nothing in flight is lost.
   */
  async convergeHostname(serverId: number): Promise<{ from: string; to: string } | null> {
    const handle = this.servers.handleFor(serverId);
    if ((await handle.docker.containerState(MAIL_CONTAINER)) !== 'running') return null;
    const names = await this.relayHostnames(handle);
    if (!names) return null;
    const wanted = hostnameOverride(await this.readRelayEnv(handle)) ?? names.fallback;
    if (!wanted || sameHostname(wanted, names.live)) return null;
    const now = await this.announce(handle, wanted);
    this.log.info(`Mail relay on "${handle.name}" was announcing ${names.live || 'nothing'}; set it back to ${now}`);
    return { from: names.live, to: now };
  }

  /** The name postfix announces and the default it falls back to; null where it cannot say. */
  private async relayHostnames(handle: ServerHandle): Promise<RelayHostnames | null> {
    const res = await handle.docker.exec(MAIL_CONTAINER, RELAY_HOSTNAME_PROBE, { timeoutMs: 20_000 }).catch(() => null);
    return res && res.exitCode === 0 ? parseHostnameProbe(res.stdout) : null;
  }

  /**
   * The relay.env on one server, null only when it is confirmed not there. A check that failed
   * throws instead (readOptional): taken for "no override", a server that merely answered
   * slowly would have its relay put back on the default.
   */
  private readRelayEnv(handle: ServerHandle): Promise<string | null> {
    return handle.files.readOptional(mailPaths(this.config).relayEnv);
  }

  /**
   * Make postfix announce `hostname` - null: its own default - and return what it reads back,
   * which is what receivers will see. A reload re-reads main.cf without restarting: no dropped
   * connection, no queue pause.
   */
  private async announce(handle: ServerHandle, hostname: string | null): Promise<string> {
    const edit = hostname ? `postconf -e ${shellQuote([`myhostname=${hostname}`])}` : 'postconf -# myhostname';
    const res = await handle.docker.exec(MAIL_CONTAINER, ['sh', '-c', `${edit} && postfix reload`], { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw badGateway('The relay refused the new hostname', (res.stderr || res.stdout).slice(0, 300));
    }
    const check = await handle.docker.exec(MAIL_CONTAINER, ['postconf', '-h', 'myhostname'], { timeoutMs: 20_000 });
    this.port25Cache.delete(handle.id);
    return check.stdout.trim() || hostname || '';
  }

  /** Where the announced name comes from, for the setup guide. Null wherever that is unknown. */
  private async hostnameSettings(serverId: number): Promise<{ fallback: string | null; override: string | null }> {
    try {
      const handle = this.servers.handleFor(serverId);
      const running = (await handle.docker.containerState(MAIL_CONTAINER)) === 'running';
      const [names, env] = await Promise.all([running ? this.relayHostnames(handle) : null, this.readRelayEnv(handle)]);
      return { fallback: names?.fallback || null, override: hostnameOverride(env) };
    } catch {
      return { fallback: null, override: null };
    }
  }

  /** Write the mail hostname's A record, for the servers whose zone the panel can reach. */
  async publishHostnameA(serverId: number): Promise<{ outcome: 'written' | 'unmanaged' | 'skipped'; detail: string }> {
    const row = this.servers.rowById(serverId);
    if (!row) throw notFound(`Server #${serverId} not found`);
    if (!row.publicIp) return { outcome: 'skipped', detail: 'This server has no public IP recorded' };
    const status = await this.statusFor(serverId);
    if (!status.hostname) return { outcome: 'skipped', detail: 'The relay does not report a hostname yet' };
    if (!this.dns) return { outcome: 'unmanaged', detail: 'No DNS provider token is configured' };
    const result = await this.dns.upsertA(status.hostname, row.publicIp);
    return result === 'updated'
      ? { outcome: 'written', detail: `${status.hostname} now points at ${row.publicIp}` }
      : { outcome: 'unmanaged', detail: `The zone for ${status.hostname} is not in the panel's DNS account — add the A record by hand` };
  }

  /**
   * Publish the records the panel is allowed to publish for one domain.
   *
   * Re-plans against live DNS first rather than trusting what the browser last saw: the
   * decision of what to write (above all, what an SPF merge should become) has to be made
   * from the record that is published right now.
   */
  async publishDomain(domain: string): Promise<MailPublishResult[]> {
    if (!this.dns?.enabled) {
      throw badRequest('No DNS provider is configured, so the panel cannot publish records — add them by hand.');
    }
    if (!(await this.dns.canManage(domain))) {
      throw badRequest(`The zone for "${domain}" is not in the panel's DNS account — add the records by hand.`);
    }

    const [plan] = await this.domains(domain);
    if (!plan) throw notFound(`"${domain}" is not a domain this fleet sends mail for`);

    const results: MailPublishResult[] = [];
    for (const step of plan.steps) {
      results.push(await this.publishStep(domain, step));
    }
    return results;
  }

  /**
   * Publish one step.
   *
   * The plan says *whether* to write; what gets written is decided here, from the zone's
   * own current contents. Those two views disagree more often than they look like they
   * should - a record added minutes ago has not propagated, a resolver returns SERVFAIL, an
   * answer is cached - and the plan is built from public DNS while the write targets a
   * record id from the provider API. Writing a plan that says "nothing is published" onto a
   * record that plainly is would delete a customer's Microsoft 365 authorization, or
   * downgrade a deliberate `p=reject` to our starter `p=none`. So the merge is redone here
   * against what the provider actually holds.
   */
  private async publishStep(domain: string, step: MailSetupStep): Promise<MailPublishResult> {
    if (step.automation.state === 'satisfied') {
      return { step: step.id, outcome: 'unchanged', detail: step.automation.detail };
    }
    if (step.automation.state !== 'ready') {
      return { step: step.id, outcome: 'skipped', detail: step.automation.detail };
    }

    try {
      if (step.id === 'dkim') return await this.publishDkim(domain);

      const name = step.record.name;
      const existing = (await this.dns!.listTxt(name)) ?? [];
      // Only ever replace the record of the kind being published; a customer's unrelated
      // TXT records (domain verification, site ownership) share the same name.
      const marker = step.id === 'spf' ? /^"?v=spf1(\s|"|$)/i : /^"?v=DMARC1(\s|;|"|$)/i;
      const mine = existing.filter((r) => marker.test(r.content.trim()));
      if (mine.length > 1) {
        return {
          step: step.id,
          outcome: 'failed',
          detail: `${mine.length} ${step.id.toUpperCase()} records are published at ${name}; consolidate them into one first.`,
        };
      }
      const current = mine[0];

      if (step.id === 'dmarc') {
        // Same rule the planner applies, enforced where it actually matters. A record the
        // planner could not see is still a policy someone chose.
        if (current) {
          return {
            step: 'dmarc',
            outcome: 'unchanged',
            detail: `A DMARC record is already published (${current.content.slice(0, 120)}); the panel leaves it alone so an existing policy is never weakened.`,
          };
        }
        await this.dns!.putTxt(name, step.automation.plannedValue!, undefined);
        return {
          step: 'dmarc',
          outcome: 'created',
          detail: `${step.automation.detail}. DNS caches can hold the old answer for a few minutes.`,
        };
      }

      // SPF: re-merge against the record the zone holds right now.
      const merge = mergeSpf(current?.content ?? null, this.spfMechanisms());
      if (merge.action === 'unchanged') {
        return { step: 'spf', outcome: 'unchanged', detail: merge.detail };
      }
      if (merge.action === 'conflict') {
        return { step: 'spf', outcome: 'failed', detail: `${merge.detail}.` };
      }
      if (spfLookupCount(merge.record) > 10) {
        return {
          step: 'spf',
          outcome: 'failed',
          detail: 'The merged record would need more than 10 DNS lookups, which receivers reject — consolidate the existing includes first.',
        };
      }
      await this.dns!.putTxt(name, merge.record, current?.id);
      return {
        step: 'spf',
        outcome: current ? 'updated' : 'created',
        detail: `${merge.detail}. DNS caches can hold the old answer for a few minutes.`,
      };
    } catch (err) {
      return { step: step.id, outcome: 'failed', detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  }

  /** The SPF mechanisms this fleet needs authorized, for the current delivery mode. */
  private spfMechanisms(): string[] {
    return spfMechanismsFor(
      this.config.mailMode,
      this.servers.listRows().map((s) => s.publicIp).filter(Boolean),
    );
  }

  /**
   * DKIM, key first.
   *
   * Distribution is re-run on every publish, not only when the key is created: an earlier
   * attempt that saved the key but failed to reach a server would otherwise never try
   * again, because the key now exists. And a failed distribution stops the DNS write
   * outright - publishing the public half while a relay is still signing with nothing (or
   * with an older key) tells receivers to expect a signature that server cannot produce,
   * which is worse for delivery than having no DKIM record at all.
   */
  private async publishDkim(domain: string): Promise<MailPublishResult> {
    try {
      const existingKey = this.dkimKeyFor(domain);
      const key = existingKey ?? this.createDkimKey(domain);

      const sync = await this.syncDkimEverywhere();
      const failed = sync.filter((s) => !s.ok);
      if (failed.length > 0) {
        return {
          step: 'dkim',
          outcome: 'failed',
          detail:
            `The signing key could not be installed on ${failed.map((f) => f.name).join(', ')} ` +
            `(${failed[0]!.detail}). The DNS record was NOT published: it would promise a signature ` +
            `those servers cannot produce. The key is saved — fix the server and publish again.`,
        };
      }

      const name = dkimRecordName(domain, key.selector);
      const value = dkimRecordValue(key.publicKeyB64);
      const existing = (await this.dns!.listTxt(name)) ?? [];
      const mine = existing.filter((r) => /v=DKIM1/i.test(r.content));
      if (mine.length > 0 && mine[0]!.content.includes(key.publicKeyB64)) {
        return { step: 'dkim', outcome: 'unchanged', detail: `The published key already matches; it is installed on all ${sync.length} server(s).` };
      }
      await this.dns!.putTxt(name, value, mine[0]?.id);
      return {
        step: 'dkim',
        outcome: mine.length > 0 ? 'updated' : 'created',
        detail: existingKey
          ? `Published the public half of the existing signing key, installed on all ${sync.length} server(s).`
          : `Generated a signing key, installed it on all ${sync.length} server(s) and published the public half.`,
      };
    } catch (err) {
      return { step: 'dkim', outcome: 'failed', detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  }

  /**
   * Reverse-DNS verdict per server; only meaningful when this fleet delivers mail itself.
   * Takes the already-collected statuses rather than re-probing: `statusFor` runs several
   * container commands, and the overview endpoint needs both halves of the answer.
   */
  async reverseDnsChecks(
    statuses: MailServerStatusDto[] = [],
  ): Promise<{ serverId: number; name: string; ip: string; check: RecordCheck }[]> {
    const hostnameFor = new Map(statuses.map((s) => [s.serverId, s.hostname]));
    const rows = this.servers.listRows().filter((row) => row.publicIp);
    return Promise.all(
      rows.map(async (row) => ({
        serverId: row.id,
        name: row.name,
        ip: row.publicIp,
        check: await checkReverseDns(this.resolver, row.publicIp, hostnameFor.get(row.id) || undefined),
      })),
    );
  }
}

/** Re-exported so routes can validate against the same list the parser produces. */
export { MAIL_STATUSES } from '../lib/mailLog.js';
export type { MailStatus } from '../lib/mailLog.js';
