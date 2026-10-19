// @docs databases/adminer
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { and, eq, gt } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { sessions as panelSessions, sites } from '../db/schema.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { DatabasesService } from '../services/databases.js';
import type { DnsService } from '../services/dns.js';
import type { JobWorker } from '../jobs/worker.js';
import type { Logger } from '../services/index.js';
import type { SettingsService } from '../services/settings.js';
import type { UsersService } from '../services/users.js';
import { hostedSites } from '../lib/siteKind.js';
import { AdminerContainers } from './containers.js';
import { adminerRequest, readAll } from './relay.js';
import { ADMINER_IDLE_MS, AdminerSessions, type AdminerSession } from './sessions.js';
import { AdminerTickets, type AdminerTicket } from './tickets.js';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).trim().slice(0, 300);

/** The file on the panel's own server that sends `db.<dev domain>` to the front door. */
export const ADMINER_ROUTE_FILE = 'wpl7-adminer.yml';

/** Jobs a change through Adminer may run beside: a backup reads the database as it is. */
const BESIDE_JOBS = new Set(['backup.create']);

/** The session's site is gone, or on another server: the session ends with it. */
export class AdminerSessionEndedError extends Error {}

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
    this.sessions = new AdminerSessions((s) => this.alive(s));
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

  /** A session from a spent ticket; its server's Adminer is started and signed in behind it. */
  begin(ticket: AdminerTicket): AdminerSession {
    const site = this.siteOf(ticket.siteId);
    if (!site) throw new Error('That site is not there any more');
    const target = this.databases.targetFor(site, ticket.database);
    const session = this.sessions.create({ ...ticket, serverId: site.serverId, user: target.user });
    void this.prepare(session, target.password);
    return session;
  }

  /**
   * A request of the session, against its site as it is now. Gone, or moved to another server,
   * and the session ends: its Adminer is the old server's. A request that may change the database
   * (`change`) holds the site as the panel's own changes do: refused while a job but a backup has
   * it, and no job starts until it is answered. Returns what lets go.
   */
  hold(s: AdminerSession, change: boolean): () => void {
    const site = this.siteOf(s.siteId);
    if (!site || site.serverId !== s.serverId || site.status === 'deleting') {
      this.sessions.end(s.id);
      throw new AdminerSessionEndedError('The site has moved or is gone. Open its database again from the panel.');
    }
    if (!change || !this.worker) return () => undefined;
    return this.worker.holdSite(site, BESIDE_JOBS);
  }

  /** Switched off: every session ends now, and every Adminer stops, rather than once idle. */
  turnedOff(): Promise<number> {
    this.sessions.endAll();
    return this.containers.stopIdle(0, () => false);
  }

  /** Where Adminer opens on the session's database. */
  adminerPath(s: AdminerSession): string {
    return `/?server=mariadb&username=${encodeURIComponent(s.user)}&db=${encodeURIComponent(s.database)}`;
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
  private alive(s: AdminerSession): boolean {
    const signedIn = this.db
      .select({ sid: panelSessions.sid })
      .from(panelSessions)
      .where(and(eq(panelSessions.sid, s.panelSid), gt(panelSessions.expiresAt, Date.now())))
      .get();
    return !!signedIn && this.users.byId(s.userId) !== null;
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
