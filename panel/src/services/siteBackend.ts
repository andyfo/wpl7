// @docs plugins/updates, sites/external, sites/wordpress
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { plugins, type BackupRow, type SiteConnectionRow, type SiteRow } from '../db/schema.js';
import type { BackupType, SiteKind } from '../../shared/schemas.js';
import { splitRestRoute } from '../../shared/schemas.js';
import type { WpBulkOpResult } from '../../shared/types.js';
import type { ServerHandle } from '../servers/registry.js';
import type { JobContext } from '../jobs/context.js';
import { probeSite, requireRunning, siteDomains } from '../jobs/handlers/shared.js';
import { conflict } from '../lib/errors.js';
import { CONNECT_PLUGIN, isExternal } from '../lib/siteKind.js';
import type { RunResult } from './docker.js';
import type { CoreServices } from './index.js';
import type { ScanLog } from './wpInventory.js';
import { createAdminLoginLink, type AdminLoginLink } from './adminLogin.js';
import { restTargetOf, sendWpRest, type WpRestResponse } from './wpRest.js';
import { PluginSourceError } from './pluginClient.js';
import { UnknownCommandError, type ConnectClient, type Rescue } from './connectClient.js';
import type { WpRestMethod } from '../../shared/schemas.js';

/** A request to a site's REST API: what `/wp/rest` and a `wp.rest` job carry. */
export interface RestCall {
  method: WpRestMethod;
  route: string;
  body?: unknown;
  auth?: { username: string; applicationPassword: string };
}

/**
 * Where WordPress work on a site goes: WP-CLI in the site's container for a site the panel hosts
 * (ContainerBackend: the code that always did it, called as it was), WPL7 Connect for a site
 * hosted elsewhere (ConnectorBackend, docs/internal/connect-protocol.md). The inventory, updates,
 * plugin and theme changes, commands, REST requests and login links go through here; the jobs and
 * routes around them are the same for both kinds.
 */

/** What a site's WordPress says it has, in WP-CLI's words (wpInventory.parseComponents reads both). */
export interface InventoryReading {
  plugins: Record<string, unknown>[];
  themes: Record<string, unknown>[];
  /** Null: the core could not be read; the caller keeps what it had, and the reading is partial. */
  core: { version: string | null; updateVersion: string | null; updateType: 'major' | 'minor' | null } | null;
  partial: boolean;
}

/** A plugin to install: from wordpress.org, or from the panel's catalog. */
export type InstallSource = { kind: 'wporg'; slug: string } | { kind: 'catalog'; id: number };

export interface CommandOptions {
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
  outputCap?: number;
}

export interface SiteBackend {
  readonly kind: SiteKind;
  readonly site: SiteRow;
  /** Ready the site for WordPress work (start a stopped container); the returned function undoes it. */
  prepare(ctx: JobContext<unknown>): Promise<() => Promise<void>>;
  readInventory(log: ScanLog): Promise<InventoryReading>;
  /** Who plugin and theme changes run as: a user id, or undefined for no one. */
  actor(ctx: JobContext<unknown>): Promise<string | undefined>;
  /** Update these plugins or themes; one outcome per slug, failures included. */
  updateMany(ctx: JobContext<unknown>, kind: 'plugin' | 'theme', slugs: string[], actor: string | undefined): Promise<WpBulkOpResult[]>;
  /** `update` only on a hosted site: an external one updates through updateMany, which keeps a rollback copy. */
  componentAction(kind: 'plugin' | 'theme', slug: string, action: 'activate' | 'deactivate' | 'delete' | 'update', actor: string | undefined): Promise<void>;
  /** Install a plugin; returns its slug. */
  install(ctx: JobContext<unknown>, source: InstallSource, activate: boolean, actor: string | undefined): Promise<string>;
  coreUpdate(ctx: JobContext<unknown>): Promise<{ from: string | null; to: string | null }>;
  /** Whether the site's home page answers, given the panel's usual time to settle. */
  healthy(): Promise<boolean>;
  backupFirst(ctx: JobContext<unknown>, type: BackupType): Promise<BackupRow>;
  /** Put back the plugins and themes this backend updated; what it put back. Hosted: nothing (a backup restore is the way). */
  rollback(ctx: JobContext<unknown>): Promise<{ kind: 'plugin' | 'theme'; slug: string; ok: boolean; error?: string }[]>;
  /** The run went well: the copies kept for a rollback can go. */
  cleanup(ctx: JobContext<unknown>): Promise<void>;
  run(args: string[], opts: CommandOptions): Promise<RunResult>;
  /** `wp help <words>`: what a command's help says, exit code and all. */
  help(words: string[]): Promise<RunResult>;
  rest(call: RestCall, opts: { timeoutMs: number; bodyCap: number }): Promise<WpRestResponse>;
  loginLink(): Promise<AdminLoginLink>;
  close(): void;
}

export function backendFor(s: CoreServices, site: SiteRow): SiteBackend {
  return isExternal(site) ? new ConnectorBackend(s, site) : new ContainerBackend(s, site);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ------------------------------------------------------------------------- hosted

/** A site in a container on one of the panel's servers: WP-CLI, as it always was. */
export class ContainerBackend implements SiteBackend {
  readonly kind = 'hosted' as const;
  private readonly server: ServerHandle;

  constructor(
    private readonly s: CoreServices,
    readonly site: SiteRow,
    server?: ServerHandle,
  ) {
    this.server = server ?? s.servers.handleFor(site.serverId);
  }

  prepare(ctx: JobContext<unknown>): Promise<() => Promise<void>> {
    return requireRunning(ctx, this.server, this.s, this.site);
  }

  /**
   * The listings, retried with WordPress's own plugins and themes not loaded when one of them
   * fatals under WP-CLI - the inventory is then partial: nothing that ships its own updater can
   * report an update - and the core read on its own, which a plugin that broke the listings
   * breaks too.
   */
  async readInventory(log: ScanLog): Promise<InventoryReading> {
    const { server, site } = this;
    let partial = false;
    const lists: Record<'plugin' | 'theme', Record<string, unknown>[]> = { plugin: [], theme: [] };
    for (const kind of ['plugin', 'theme'] as const) {
      try {
        lists[kind] = await server.wp.listComponents(site.containerName, kind, { skipExtensions: partial });
      } catch (err) {
        log('warn', `wp ${kind} list failed (${errorText(err)}); retrying with plugins and themes not loaded`);
        lists[kind] = await server.wp.listComponents(site.containerName, kind, { skipExtensions: true });
        partial = true;
      }
    }
    let core: InventoryReading['core'] = null;
    for (const skipExtensions of partial ? [true] : [false, true]) {
      try {
        const version = await server.wp.coreVersion(site.containerName, { skipExtensions });
        const update = await server.wp.coreCheckUpdate(site.containerName, { skipExtensions });
        core = { version, updateVersion: update?.version ?? null, updateType: update?.updateType ?? null };
        break;
      } catch (err) {
        if (!skipExtensions) {
          log('warn', `wp core check-update failed (${errorText(err)}); retrying with plugins and themes not loaded`);
          continue;
        }
        log('warn', `Could not read the WordPress version of "${site.slug}": ${errorText(err)}`);
      }
    }
    return { plugins: lists.plugin, themes: lists.theme, core, partial: partial || core === null };
  }

  /**
   * The site's administrator, as when an admin makes the change in wp-admin (services/wp.ts
   * actingAs says why). A site without one - or whose users cannot be listed - gets the change as
   * nobody, as before, with a word in the log.
   */
  async actor(ctx: JobContext<unknown>): Promise<string | undefined> {
    try {
      const admin = await this.server.wp.siteAdministrator(this.site.containerName, this.site.wpAdminUser);
      if (admin) return String(admin.id);
      ctx.warn('This site has no administrator account, so the change runs as no WordPress user.');
    } catch (err) {
      ctx.warn(`Could not find the site's administrator (${errorText(err)}); the change runs as no WordPress user.`);
    }
    return undefined;
  }

  /** One coalesced `wp <kind> update a b c --format=json`, split back into one outcome per slug. */
  async updateMany(ctx: JobContext<unknown>, kind: 'plugin' | 'theme', slugs: string[], actor: string | undefined): Promise<WpBulkOpResult[]> {
    ctx.info(`Updating ${slugs.length} ${kind}${slugs.length === 1 ? '' : 's'}: ${slugs.join(', ')}`);
    let rows: Awaited<ReturnType<ServerHandle['wp']['updateMany']>>;
    try {
      rows = await this.server.wp.updateMany(this.site.containerName, kind, slugs, actor);
    } catch (err) {
      const error = errorText(err);
      ctx.error(`wp ${kind} update failed outright: ${error}`);
      return slugs.map((slug) => ({ kind, slug, action: 'update', ok: false, from: null, to: null, error }));
    }
    const byName = new Map(rows.rows.map((row) => [row.name, row]));
    return slugs.map((slug) => {
      const row = byName.get(slug);
      if (!row) {
        // wp-cli said nothing about this one: it was not in the list it acted on (a
        // concurrent update, or a slug that vanished since the scan).
        ctx.warn(`${slug}: wp ${kind} update reported no result`);
        return {
          kind,
          slug,
          action: 'update' as const,
          ok: false,
          from: null,
          to: null,
          error: `wp ${kind} update reported no result (exit ${rows.exitCode}): ${rows.output.slice(0, 200)}`,
        };
      }
      const ok = row.status.toLowerCase() === 'updated';
      if (ok) ctx.info(`${slug}: ${row.oldVersion ?? '?'} → ${row.newVersion ?? '?'}`);
      else ctx.error(`${slug}: update reported "${row.status}"`);
      return { kind, slug, action: 'update' as const, ok, from: row.oldVersion, to: row.newVersion, error: ok ? null : `wp-cli reported "${row.status}"` };
    });
  }

  async componentAction(kind: 'plugin' | 'theme', slug: string, action: 'activate' | 'deactivate' | 'delete' | 'update', actor: string | undefined): Promise<void> {
    if (kind === 'plugin') await this.server.wp.pluginAction(this.site.containerName, slug, action, actor);
    else {
      if (action === 'deactivate') throw new Error('themes cannot be deactivated; activate another one instead');
      await this.server.wp.themeAction(this.site.containerName, slug, action, actor);
    }
  }

  async install(ctx: JobContext<unknown>, source: InstallSource, activate: boolean, actor: string | undefined): Promise<string> {
    const { server, site } = this;
    if (source.kind === 'wporg') {
      ctx.info(`Installing plugin ${source.slug} from wordpress.org…`);
      await server.wp.installPluginSlug(site.containerName, source.slug, activate, actor);
      return source.slug;
    }
    const row = this.s.db.select().from(plugins).where(eq(plugins.id, source.id)).get();
    if (!row) throw new Error(`Catalog plugin #${source.id} not found`);
    if (row.kind === 'zip') {
      if (!row.zipPath) throw new Error('Catalog entry has no zip file');
      ctx.info(`Installing plugin "${row.name}" from uploaded zip…`);
      const { PluginSyncService } = await import('./pluginSync.js');
      await new PluginSyncService(this.s.db, this.s.config, this.s.servers).ensureZipOnServer(server, row.zipPath);
      await server.wp.installPluginZip(site.containerName, row.zipPath, activate, actor);
    } else {
      ctx.info(`Installing plugin ${row.slug} from wordpress.org…`);
      await server.wp.installPluginSlug(site.containerName, row.slug, activate, actor);
    }
    return row.slug;
  }

  async coreUpdate(ctx: JobContext<unknown>): Promise<{ from: string | null; to: string | null }> {
    const from = await this.server.wp.coreVersion(this.site.containerName);
    ctx.info(`Updating WordPress core (current: ${from ?? 'unknown'})…`);
    const { update } = await this.server.wp.coreUpdate(this.site.containerName);
    ctx.info(update.stdout.trim().split('\n').slice(-1)[0] ?? 'Core update finished');
    const to = await this.server.wp.coreVersion(this.site.containerName);
    ctx.info(`Core version now: ${to ?? 'unknown'}`);
    return { from, to };
  }

  async healthy(): Promise<boolean> {
    const host = siteDomains(this.site)[0];
    if (!host) return true;
    // Same retry window every other health check in the panel uses, so "the site answers"
    // means one thing across backups, moves, PHP switches and updates.
    return probeSite(this.server, this.site.containerName, host, this.s.config.probeTimeoutMs);
  }

  async backupFirst(ctx: JobContext<unknown>, type: BackupType): Promise<BackupRow> {
    // The monitor's own probes and wp-cron are paused for the site while a backup runs, the same
    // way a manual backup does it.
    this.s.monitor.busySlugs.add(this.site.slug);
    try {
      return await this.s.backup.create(this.site, type, { jobId: ctx.jobId, log: (l, m) => ctx.log(l, m) });
    } finally {
      this.s.monitor.busySlugs.delete(this.site.slug);
    }
  }

  async rollback(): Promise<[]> {
    return [];
  }

  async cleanup(): Promise<void> {}

  run(args: string[], opts: CommandOptions): Promise<RunResult> {
    return this.server.wp.run(this.site.containerName, args, opts.timeoutMs, {
      input: opts.stdin,
      signal: opts.signal,
      onOutput: opts.onOutput,
      outputCap: opts.outputCap,
    });
  }

  help(words: string[]): Promise<RunResult> {
    return this.server.wp.run(this.site.containerName, ['help', ...words], 30_000, { outputCap: 256 * 1024 });
  }

  rest(call: RestCall, opts: { timeoutMs: number; bodyCap: number }): Promise<WpRestResponse> {
    return sendWpRest(this.server.docker, this.site.containerName, { ...call, ...restTargetOf(this.site, this.s.config), ...opts });
  }

  loginLink(): Promise<AdminLoginLink> {
    return createAdminLoginLink(this.server, this.site, this.s.config, this.s.panelFiles);
  }

  close(): void {}
}

// ------------------------------------------------------------------------- external

/** What `/wp/cli` answers for a command no plugin registered on WPL7 Connect. */
export function notRegistered(command: string, slug: string): string {
  return (
    `Error: '${command}' is not a registered wp command on this external site. Only commands a plugin ` +
    `registered with WPL7 Connect run here; GET /api/sites/${slug}/wp/cli/help lists them.\n`
  );
}

/** A site hosted elsewhere: WPL7 Connect, over its signed requests. */
export class ConnectorBackend implements SiteBackend {
  readonly kind = 'external' as const;
  private readonly conn: SiteConnectionRow;
  private clientOrNull: ConnectClient | null = null;
  /** What this backend updated, with the op that keeps its rollback copy. */
  private readonly updated: { kind: 'plugin' | 'theme'; slug: string; op: string }[] = [];

  constructor(
    private readonly s: CoreServices,
    readonly site: SiteRow,
  ) {
    this.conn = s.connections.forSite(site);
  }

  private client(ctx?: JobContext<unknown>): ConnectClient {
    if (!this.clientOrNull) {
      this.clientOrNull = this.s.connections.clientForSite(this.site, ctx ? { canceled: () => ctx.cancelRequested, log: (line) => ctx.info(line) } : {});
    }
    return this.clientOrNull;
  }

  /** The client's lessons (transport, clock, budget) go back with the connection, and so does whether the site answered. */
  private remember(outcome: { ok: boolean; error?: string } = { ok: true }): void {
    if (this.clientOrNull) this.s.connections.remember(this.site, this.clientOrNull, outcome);
  }

  async prepare(ctx: JobContext<unknown>): Promise<() => Promise<void>> {
    if (this.site.status !== 'connected') throw conflict(`"${this.site.slug}" is disconnected. Reconnect it from its Settings tab.`);
    try {
      await this.client(ctx).ping();
      this.remember();
    } catch (err) {
      this.remember({ ok: false, error: errorText(err) });
      throw err;
    }
    return async () => this.close();
  }

  /** The plugins this backend updated, as WordPress names their files: what a rescue skips. */
  private rescue(): Rescue | undefined {
    if (this.updated.length === 0) return undefined;
    const files = this.s.wpInventory.componentsFor(this.site.id);
    const skipPlugins = this.updated
      .filter((u) => u.kind === 'plugin')
      .map((u) => files.get(`plugin:${u.slug}`)?.file ?? `${u.slug}/${u.slug}.php`);
    return { skipPlugins, skipTheme: this.updated.some((u) => u.kind === 'theme') };
  }

  async readInventory(log: ScanLog): Promise<InventoryReading> {
    let answer;
    try {
      answer = await this.client().inventory({ check: true });
    } catch (err) {
      const rescue = this.rescue();
      if (!rescue) throw err;
      // A plugin or theme this run updated breaks the site: read it without them, through the loader.
      log('warn', `The site did not answer (${errorText(err)}); reading it without what was just updated.`);
      answer = await this.client().inventory({ check: true, rescue });
    }
    this.remember();
    const core = answer.core
      ? { version: answer.core.version, updateVersion: answer.core.update?.version ?? null, updateType: answer.core.update?.type ?? null }
      : null;
    return { plugins: answer.plugins, themes: answer.themes, core, partial: answer.partial || core === null };
  }

  async actor(): Promise<string | undefined> {
    return this.conn.actAsLogin ?? undefined;
  }

  /** One `update` per item, each with its own op: the copy a rollback puts back is kept per op. */
  async updateMany(ctx: JobContext<unknown>, kind: 'plugin' | 'theme', slugs: string[]): Promise<WpBulkOpResult[]> {
    ctx.info(`Updating ${slugs.length} ${kind}${slugs.length === 1 ? '' : 's'}: ${slugs.join(', ')}`);
    const client = this.client(ctx);
    const results: WpBulkOpResult[] = [];
    let refusal: string | null = null;
    for (const slug of slugs) {
      if (refusal) {
        results.push({ kind, slug, action: 'update', ok: false, from: null, to: null, error: refusal });
        continue;
      }
      ctx.checkCanceled();
      if (kind === 'plugin' && slug === CONNECT_PLUGIN) {
        // Its own update comes from the panel: a fresh link first, so WordPress has the package.
        const offer = this.s.connections.offerFor(this.s.connections.findForSite(this.site.id) ?? this.conn);
        if (offer) await client.ping({ offer }).catch(() => undefined);
      }
      const op = crypto.randomBytes(8).toString('hex');
      try {
        const answer = await client.update({ op, kind, slug });
        const r = answer.result ?? { ok: false, from: null, to: null, rollback: false, error: 'The site gave no result.' };
        if (r.ok && r.rollback) this.updated.push({ kind, slug, op });
        if (r.ok) ctx.info(`${slug}: ${r.from ?? '?'} → ${r.to ?? '?'}`);
        if (r.ok && kind === 'plugin' && slug === CONNECT_PLUGIN) {
          // The new version answers from the next request on: the site page shows it now, not after the hourly check.
          const ping = await client.ping().catch(() => null);
          const row = this.s.connections.findForSite(this.site.id);
          if (ping && row) this.s.connections.mark(row.id, { pluginVersion: ping.plugin, protocol: ping.protocol, offeredVersion: null });
        }
        else ctx.error(`${slug}: ${r.error ?? 'the update failed'}`);
        results.push({ kind, slug, action: 'update', ok: r.ok, from: r.from, to: r.to, error: r.ok ? null : (r.error ?? 'The update failed.') });
      } catch (err) {
        const detail = err instanceof PluginSourceError ? (err.details?.detail as string | undefined) : undefined;
        const error =
          detail === 'filesystem'
            ? 'Updates need FTP details in wp-config.php: WordPress cannot write its own files on this site.'
            : detail === 'file_mods'
              ? 'Updates are switched off on this site (DISALLOW_FILE_MODS in wp-config.php).'
              : errorText(err);
        if (detail === 'filesystem' || detail === 'file_mods') refusal = error;
        ctx.error(`${slug}: ${error}`);
        results.push({ kind, slug, action: 'update', ok: false, from: null, to: null, error });
      }
    }
    this.remember();
    return results;
  }

  async componentAction(kind: 'plugin' | 'theme', slug: string, action: 'activate' | 'deactivate' | 'delete' | 'update'): Promise<void> {
    if (action === 'update') throw new Error('An external site updates through updateMany, which keeps a copy to roll back to');
    if (kind === 'theme' && action === 'deactivate') throw new Error('themes cannot be deactivated; activate another one instead');
    const answer = await this.client().component({ kind, slug, action });
    this.remember();
    if (!answer.ok) throw new Error(answer.error ?? `${action} failed`);
  }

  async install(ctx: JobContext<unknown>, source: InstallSource, activate: boolean): Promise<string> {
    let slug: string;
    let from: { wporg: string } | { url: string };
    if (source.kind === 'wporg') {
      slug = source.slug;
      from = { wporg: source.slug };
      ctx.info(`Installing plugin ${source.slug} from wordpress.org…`);
    } else {
      const row = this.s.db.select().from(plugins).where(eq(plugins.id, source.id)).get();
      if (!row) throw new Error(`Catalog plugin #${source.id} not found`);
      slug = row.slug;
      if (row.kind === 'zip') {
        if (!row.zipPath) throw new Error('Catalog entry has no zip file');
        ctx.info(`Installing plugin "${row.name}" from the panel's catalog…`);
        // A link only this install can use, for ten minutes: the site downloads the zip itself.
        from = { url: this.s.connections.catalogUrl(row.id, this.site.id) };
      } else {
        ctx.info(`Installing plugin ${row.slug} from wordpress.org…`);
        from = { wporg: row.slug };
      }
    }
    const answer = await this.client(ctx).component({ kind: 'plugin', slug, action: 'install', source: from, activate });
    this.remember();
    if (!answer.ok) throw new Error(answer.error ?? 'The install failed');
    return slug;
  }

  /** The offer the last inventory saw, then the database brought up to it in a request of its own. */
  async coreUpdate(ctx: JobContext<unknown>): Promise<{ from: string | null; to: string | null }> {
    const status = this.s.wpInventory.statusRowFor(this.site.id);
    const target = status?.coreUpdateVersion;
    if (!target) throw new Error('WordPress is already up to date (check for updates first)');
    const from = status?.coreVersion ?? null;
    ctx.info(`Updating WordPress core (current: ${from ?? 'unknown'}) to ${target}…`);
    const client = this.client(ctx);
    const answer = await client.update({ op: crypto.randomBytes(8).toString('hex'), kind: 'core', version: target }, { pollMs: this.s.config.nodeEnv === 'test' ? 0 : 5000 });
    const r = answer.result;
    if (!r?.ok) throw new Error(r?.error ?? 'The core update failed');
    const db = await client.update({ op: crypto.randomBytes(8).toString('hex'), kind: 'db' });
    if (db.result && !db.result.ok) ctx.warn(`The database upgrade after the core update failed: ${db.result.error ?? 'no reason given'}`);
    this.remember();
    ctx.info(`Core version now: ${r.to ?? 'unknown'}`);
    return { from: r.from ?? from, to: r.to ?? null };
  }

  /**
   * The site's home page, from the panel, and WPL7 Connect behind it, until both answer or the
   * usual time to settle is up. The ping is a POST, which no page cache answers: a home page
   * served from a cache passes for a site whose PHP no longer runs.
   */
  async healthy(): Promise<boolean> {
    const home = this.s.connections.homeOf(this.site.id);
    if (!home) return false;
    const deadline = Date.now() + this.s.config.probeTimeoutMs;
    for (;;) {
      const reading = await this.s.connections.probe(home);
      if (reading.ok && (await this.connectorAnswers())) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  private async connectorAnswers(): Promise<boolean> {
    try {
      await this.client().ping();
      return true;
    } catch {
      return false;
    }
  }

  backupFirst(ctx: JobContext<unknown>, type: BackupType): Promise<BackupRow> {
    return this.s.externalBackups.create(ctx, this.site, type);
  }

  /**
   * Put back what this run updated. Through the must-use loader, with what was updated left out of
   * the request: a site that an update broke fails before WPL7 Connect loads otherwise.
   */
  async rollback(ctx: JobContext<unknown>): Promise<{ kind: 'plugin' | 'theme'; slug: string; ok: boolean; error?: string }[]> {
    const rescue = this.rescue();
    if (!rescue) return [];
    const client = this.client(ctx);
    const out: { kind: 'plugin' | 'theme'; slug: string; ok: boolean; error?: string }[] = [];
    for (const u of this.updated) {
      try {
        const [item] = await client.rollback(u.op, [{ kind: u.kind, slug: u.slug }], rescue);
        out.push({ kind: u.kind, slug: u.slug, ok: item?.ok === true, ...(item?.ok ? {} : { error: item?.error ?? 'no answer' }) });
      } catch (err) {
        const error =
          err instanceof PluginSourceError && (err.code === 'foreign' || err.code === 'unreachable')
            ? "The site fails before WPL7 Connect loads. Restore the plugin's folder from the last backup."
            : errorText(err);
        out.push({ kind: u.kind, slug: u.slug, ok: false, error });
      }
    }
    return out;
  }

  async cleanup(): Promise<void> {
    for (const u of this.updated) await this.client().cleanup(u.op).catch(() => undefined);
    this.updated.length = 0;
  }

  /** A registered command (section 8); one nobody registered fails the way WP-CLI fails an unknown one. */
  async run(args: string[], opts: CommandOptions): Promise<RunResult> {
    try {
      const res = await this.client().run(args, { stdin: opts.stdin, timeoutMs: Math.max(5_000, opts.timeoutMs) });
      this.remember();
      if (opts.onOutput) for (const line of `${res.stdout}${res.stderr}`.split('\n')) if (line) opts.onOutput(line);
      return res;
    } catch (err) {
      if (err instanceof UnknownCommandError) return { stdout: '', stderr: notRegistered(args[0] ?? '', this.site.slug), exitCode: 1 };
      throw err;
    }
  }

  async help(words: string[]): Promise<RunResult> {
    try {
      const text = await this.client().help(words);
      return { stdout: text, stderr: '', exitCode: 0 };
    } catch (err) {
      if (err instanceof UnknownCommandError) return { stdout: '', stderr: notRegistered(words[0] ?? '', this.site.slug), exitCode: 1 };
      throw err;
    }
  }

  /**
   * The REST bridge (section 6): the request runs inside WordPress, as the user named by `auth`
   * when there is one - no application password needed, or read.
   */
  async rest(call: RestCall, opts: { timeoutMs: number; bodyCap: number }): Promise<WpRestResponse> {
    const { route, query } = splitRestRoute(call.route);
    const started = Date.now();
    try {
      const res = await this.client().rest(
        { method: call.method, route, ...(query ? { query } : {}), ...(call.body !== undefined ? { body: call.body } : {}), ...(call.auth ? { user: call.auth.username } : {}) },
        opts.timeoutMs,
      );
      this.remember();
      const body = res.body.length > opts.bodyCap ? res.body.slice(0, opts.bodyCap) : res.body;
      return {
        status: res.status,
        statusText: '',
        contentType: res.headers['content-type'] ?? null,
        headers: res.headers,
        body,
        truncated: res.truncated || body.length < res.body.length,
        sizeBytes: Buffer.byteLength(res.body),
        durationMs: Date.now() - started,
        error: null,
      };
    } catch (err) {
      return { status: null, statusText: '', contentType: null, headers: {}, body: '', truncated: false, sizeBytes: 0, durationMs: Date.now() - started, error: errorText(err) };
    }
  }

  async loginLink(): Promise<AdminLoginLink> {
    const link = await this.client().login(this.conn.actAsLogin);
    this.remember();
    return { url: link.url, user: link.user, expiresInSeconds: link.expiresIn };
  }

  close(): void {
    this.clientOrNull?.close();
    this.clientOrNull = null;
  }
}
