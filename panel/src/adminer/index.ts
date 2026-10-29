// @docs databases/adminer
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { and, eq, gt } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { sessions as panelSessions, sites } from '../db/schema.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { DatabasesService } from '../services/databases.js';
import type { DbTarget } from '../services/dbBrowser.js';
import type { DnsService } from '../services/dns.js';
import type { JobWorker, SiteHold } from '../jobs/worker.js';
import type { Logger } from '../services/index.js';
import type { SettingsService } from '../services/settings.js';
import type { UsersService } from '../services/users.js';
import { hostedSites } from '../lib/siteKind.js';
import { AdminerContainers } from './containers.js';
import { ADMINER_CONTAINER, adminerRequest, readAll } from './relay.js';
import { ADMINER_IDLE_MS, AdminerSessions, type AdminerSession, type AdminerTab } from './sessions.js';
import { AdminerTickets, type AdminerTicket } from './tickets.js';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).trim().slice(0, 300);

/** The file on the panel's own server that sends `db.<dev domain>` to the front door. */
export const ADMINER_ROUTE_FILE = 'wpl7-adminer.yml';

/** Jobs a change through Adminer may run beside: a backup reads the database as it is. */
const BESIDE_JOBS = new Set(['backup.create']);

/** The session's site is gone, or on another server: the session ends with it. */
export class AdminerSessionEndedError extends Error {}

/**
 * The lock a change's Adminer connection takes, named after the tag the front door gives the
 * request (deploy/adminer-image/wpl7.php): MariaDB then says whether the change still runs.
 */
export const adminerLockName = (tag: string) => `wpl7_adminer_${tag}`;

/**
 * What Adminer's gate (deploy/adminer-image/router.php) says of a tagged change: given up before
 * PHP started it, so it never will run (`canceled`); started, and running or waiting for its
 * session or its connection (`started`); or over (`done`). `gone`: Adminer is not running, so
 * nothing of it runs in PHP. `unknown`: it could not be asked.
 */
type GateState = 'canceled' | 'started' | 'done' | 'gone' | 'unknown';

/** What a read takes of a site: nothing. */
const NO_HOLD: SiteHold = Object.assign(() => undefined, { renew: () => undefined });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "Open in Adminer": a database of a site opened in Adminer, signed in as the site's own
 * database user, on its own address. The panel mints a ticket (`open`), the front door
 * (frontDoor.ts) spends it and starts a session, and every request of that session goes to the
 * site's server's `wpl7-adminer` through `docker exec` (relay.ts). Nothing of it faces the
 * internet but the front door, and the front door serves nothing of the panel.
 */
export class AdminerService {
  readonly tickets = new AdminerTickets();
  readonly sessions: AdminerSessions;
  readonly containers: AdminerContainers;
  private worker: Pick<JobWorker, 'holdSite'> | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    readonly servers: ServerRegistry,
    private readonly settings: SettingsService,
    private readonly users: UsersService,
    private readonly databases: DatabasesService,
    private readonly dns: DnsService,
    private readonly log: Logger,
  ) {
    this.sessions = new AdminerSessions((signIn) => this.alive(signIn));
    this.containers = new AdminerContainers(config, servers, log);
  }

  /** The queue, for a change through Adminer to hold its site (JobWorker.holdSite); attached once it exists. */
  attachWorker(worker: Pick<JobWorker, 'holdSite'>): void {
    this.worker = worker;
  }

  /** Why "Open in Adminer" is not offered now; null when it is. */
  unavailable(): string | null {
    if (this.settings.get('adminerEnabled') === false) return 'Adminer is turned off in Settings → Security';
    return null;
  }

  /** The address that opens Adminer on a database, once, within a minute. */
  open(ticket: AdminerTicket): string {
    return `${this.config.adminer.url}/open?ticket=${encodeURIComponent(this.tickets.issue(ticket))}`;
  }

  /** A tab from a spent ticket: its starting page claims it a session (claim()). */
  begin(ticket: AdminerTicket): AdminerTab {
    const site = this.siteOf(ticket.siteId);
    if (!site) throw new Error('That site is not there any more');
    this.databases.targetFor(site, ticket.database);
    return this.sessions.openTab(ticket);
  }

  /**
   * The tab's session, asked for by its starting page with whatever key the browser's cookie
   * holds (`cookie`): the panel sign-in's session for the site's user if it has one - another
   * tab's, on another of the site's databases too - or a new one, whose server's Adminer starts
   * and signs in behind it. Returns the key to set when the cookie holds none of this sign-in's.
   */
  claim(tab: AdminerTab, cookie: string | undefined): { session: AdminerSession; key: string; isNew: boolean } {
    const site = this.siteOf(tab.ticket.siteId);
    if (!site) throw new AdminerSessionEndedError('That site is not there any more. Open its database again from the panel.');
    const target = this.databases.targetFor(site, tab.ticket.database);
    const { key, isNew } = this.sessions.keyFor(cookie, tab.ticket);
    let session = this.sessions.find(tab.ticket, target.user, site.serverId);
    if (!session) {
      session = this.sessions.create({ ...tab.ticket, serverId: site.serverId, user: target.user });
      void this.prepare(session, target.password);
    } else if (session.state === 'ready') {
      // Signed in for another tab, but Adminer may have signed it out since - its own Logout
      // button, a restart of its container. The tab waits while that is checked.
      tab.waiting = true;
      void this.recheck(session, target.password).finally(() => {
        tab.waiting = false;
      });
    }
    tab.sessionId = session.id;
    return { session, key, isNew };
  }

  /**
   * Whether Adminer still holds the session's sign-in, signed in again when it does not. Asked by
   * every reopen of a site, once at a time: tabs still signed in carry on as they were.
   */
  private recheck(s: AdminerSession, password: string): Promise<void> {
    s.checking ??= (async () => {
      if (await this.signedIn(s)) return;
      s.state = 'starting';
      s.message = 'Signing in again…';
      await this.prepare(s, password);
    })().finally(() => {
      s.checking = null;
    });
    return s.checking;
  }

  /** Whether a page of Adminer's, asked with the session's cookies, is one for a signed-in user. */
  private async signedIn(s: AdminerSession): Promise<boolean> {
    try {
      const { docker } = this.servers.handleFor(s.serverId);
      const res = await adminerRequest(docker, { method: 'GET', path: this.adminerPath(s), headers: { cookie: s.jar.header() } });
      s.jar.take(res.headers['set-cookie']);
      const body = await readAll(res);
      // wpl7.php's page for a signed-out session.
      return res.statusCode === 200 && !body.includes('wpl7-signed-out');
    } catch {
      return false;
    }
  }

  /**
   * A request of the session, against its site as it is now. Gone, or moved to another server,
   * and the session ends: its Adminer is the old server's. A request that may change the database
   * (`change`) holds the site as the panel's own changes do: refused while a job but a backup has
   * it, and no job starts until it is answered. Returns what lets go.
   */
  hold(s: AdminerSession, change: boolean): SiteHold {
    const site = this.siteOf(s.siteId);
    if (!site || site.serverId !== s.serverId || site.status === 'deleting') {
      this.sessions.end(s.id);
      throw new AdminerSessionEndedError('The site has moved or is gone. Open its database again from the panel.');
    }
    if (!change || !this.worker) return NO_HOLD;
    return this.worker.holdSite(site, BESIDE_JOBS);
  }

  /**
   * Wait, after a change made in Adminer has ended for the front door, until it has ended in
   * Adminer and MariaDB too: PHP, and the statement it runs, go on after a browser or a relay goes.
   * Its connection holds the lock named after the request's tag (adminerLockName), so MariaDB says
   * whether it still runs.
   *
   * Answered whole, the request is over in PHP and its connection closes with it; one still there
   * after a few seconds is killed. Cut off (`cut`: its relay failed, or the browser went before
   * Adminer had it whole), PHP may still have it - waiting for a worker, its session or its
   * connection - and run it later. So Adminer's gate is asked: one not yet started is given up
   * there and never runs; a started one is waited for until it is over, its connection killed
   * whenever MariaDB shows one. `renew` keeps the site's hold while this waits.
   */
  async settle(s: AdminerSession, tag: string, opts: { cut: boolean; renew: () => void }): Promise<void> {
    const site = this.siteOf(s.siteId);
    // Gone, or moved: its database is no longer where this Adminer was.
    if (!site || site.serverId !== s.serverId) return;
    let target: DbTarget;
    try {
      target = this.databases.targetFor(site, s.database);
    } catch {
      return;
    }
    const browser = this.servers.handleFor(s.serverId).dbBrowser;
    const name = adminerLockName(tag);
    const t = this.settleTiming;
    const started = Date.now();
    let failures = 0;
    for (;;) {
      const waited = Date.now() - started;
      // Cut off, the request is over only once Adminer's gate says so.
      const gate: GateState = opts.cut ? await this.askGate(s.serverId, tag) : 'done';
      let holder: number | null | undefined;
      try {
        holder = await browser.lockHolder(target, name, { kill: opts.cut || waited >= t.graceMs });
        failures = 0;
      } catch (err) {
        if (++failures >= 5 && gate !== 'started' && gate !== 'unknown') {
          this.log.warn(`Adminer for ${s.database}: could not tell whether a change still runs (${errorText(err)}); letting the site go`);
          return;
        }
        holder = undefined;
      }
      if (holder === null && (gate === 'canceled' || gate === 'done' || gate === 'gone')) return;
      if (waited >= t.maxMs) {
        this.log.warn(`Adminer for ${s.database}: a change was still not over after ${Math.round(t.maxMs / 60_000)} minutes; letting the site go`);
        return;
      }
      opts.renew();
      // Each ask is a `docker exec` on the site's server: often at first, then less so.
      await sleep(waited < 10 * t.pollMs ? t.pollMs : 5 * t.pollMs);
    }
  }

  /** Adminer's gate's word on a tagged change (GateState); asking gives up one not yet started. */
  private async askGate(serverId: number, tag: string): Promise<GateState> {
    try {
      const { docker } = this.servers.handleFor(serverId);
      if ((await docker.containerState(ADMINER_CONTAINER)) !== 'running') return 'gone';
      const res = await adminerRequest(docker, {
        method: 'POST',
        path: `/.wpl7/settle?tag=${encodeURIComponent(tag)}`,
        headers: { 'x-wpl7-login-key': this.containers.loginKey(serverId), 'content-length': '0' },
      });
      const body = await readAll(res);
      if (res.statusCode !== 200) return 'unknown';
      const state = (JSON.parse(body) as { state?: string }).state;
      // Created but not yet written: it has started.
      if (state === '' || state === 'started') return 'started';
      return state === 'canceled' || state === 'done' ? state : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** How settle() waits; shorter in the tests. Past maxMs it lets the site go all the same, loudly. */
  settleTiming = { graceMs: 5_000, pollMs: 1_000, maxMs: 35 * 60_000 };

  /**
   * Switched off: every session ends now, and every Adminer stops, rather than once idle - one
   * still starting once it has started.
   */
  turnedOff(): Promise<number> {
    this.sessions.endAll();
    return this.containers.stopAll();
  }

  /** Where Adminer opens on a database of the session's site: its first, unless named. */
  adminerPath(s: AdminerSession, database: string = s.database): string {
    return `/?server=mariadb&username=${encodeURIComponent(s.user)}&db=${encodeURIComponent(database)}`;
  }

  /** Stop the Adminers nobody uses (the scheduler, every minute). */
  stopIdle(): Promise<number> {
    return this.containers.stopIdle(ADMINER_IDLE_MS, (serverId) => this.sessions.inUseOn(serverId));
  }

  /**
   * The route that sends `db.<dev domain>` to the front door, in Traefik's file provider on the
   * panel's own server: one file the panel owns, so an existing install gains it with an update.
   * The certificate comes the way a dev site's does.
   */
  async writeRoute(): Promise<void> {
    if (new URL(this.config.adminer.url).hostname !== `db.${this.config.devDomain}`) return;
    const handle = this.servers.localHandle();
    const https = this.config.tlsMode !== 'none';
    const wildcard = this.dns.wildcardProvider(handle.row.dnsProvider);
    const tls = !https
      ? ''
      : wildcard
        ? [
            '      tls:',
            `        certResolver: ${this.config.acmeResolver === 'letsencrypt-staging' ? 'letsencrypt-dns-staging' : 'letsencrypt-dns'}`,
            '        domains:',
            `          - main: "${this.config.devDomain}"`,
            `            sans: ["*.${this.config.devDomain}"]`,
          ].join('\n')
        : ['      tls:', `        certResolver: ${this.config.acmeResolver}`].join('\n');
    const content = [
      '# Written by the panel (panel/src/adminer): Adminer\'s front door, on an address of its own.',
      'http:',
      '  routers:',
      '    wpl7-adminer:',
      `      rule: "Host(\`db.${this.config.devDomain}\`)"`,
      `      entryPoints: [${https ? 'websecure' : 'web'}]`,
      '      service: wpl7-adminer',
      ...(tls ? [tls] : []),
      '  services:',
      '    wpl7-adminer:',
      '      loadBalancer:',
      '        servers:',
      `          - url: "http://wpl7-panel:${this.config.adminer.port}"`,
      '',
    ].join('\n');
    const dir = path.join(this.config.srvRoot, 'traefik', 'dynamic');
    await handle.files.mkdirp(dir, { mode: 0o755 });
    await handle.files.writeFile(path.join(dir, ADMINER_ROUTE_FILE), content, { atomic: true, mode: 0o644 });
  }

  private siteOf(siteId: number) {
    return this.db
      .select()
      .from(sites)
      .where(and(eq(sites.id, siteId), hostedSites()))
      .get();
  }

  /** Is the panel session behind an Adminer session still signed in, and its admin still there? */
  private alive(signIn: { userId: number; panelSid: string }): boolean {
    const signedIn = this.db
      .select({ sid: panelSessions.sid })
      .from(panelSessions)
      .where(and(eq(panelSessions.sid, signIn.panelSid), gt(panelSessions.expiresAt, Date.now())))
      .get();
    return !!signedIn && this.users.byId(signIn.userId) !== null;
  }

  /**
   * Start the server's Adminer and sign in as the site's user. The password goes in Adminer's
   * session encrypted with a key that lives in the session's cookie jar - in the panel, never in
   * the container nor the browser.
   */
  private async prepare(session: AdminerSession, password: string): Promise<void> {
    try {
      await this.containers.ensure(session.serverId, (message) => {
        session.message = message;
      });
      // Switched off while it started: it stops again, signed in as nobody.
      const off = this.unavailable();
      if (off) {
        await this.containers.stop(session.serverId);
        throw new Error(off);
      }
      const { docker } = this.servers.handleFor(session.serverId);
      session.jar.set('adminer_key', randomBytes(16).toString('hex'));
      const form = new URLSearchParams({
        'auth[driver]': 'server',
        'auth[server]': 'mariadb',
        'auth[username]': session.user,
        'auth[password]': password,
        'auth[db]': session.database,
      }).toString();
      const res = await adminerRequest(docker, {
        method: 'POST',
        path: '/',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(form)),
          'x-wpl7-login-key': this.containers.loginKey(session.serverId),
          cookie: session.jar.header(),
        },
        body: form,
      });
      session.jar.take(res.headers['set-cookie']);
      const body = await readAll(res);
      if (res.statusCode !== 302) throw new Error(`Adminer refused the sign-in (HTTP ${res.statusCode}): ${body.replace(/<[^>]+>/g, ' ').trim().slice(0, 200)}`);
      session.state = 'ready';
      session.message = null;
    } catch (err) {
      session.state = 'failed';
      session.message = errorText(err);
      this.log.warn(`Adminer for ${session.database}: ${session.message}`);
    }
  }
}
