// @docs get-started/installation, get-started/quick-start
import fsp from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { servers as serversTable } from './db/schema.js';
import { runMigrations } from './db/migrate.js';
import { seed } from './db/seed.js';
import { ServerRegistry } from './servers/registry.js';
import { TerminalService } from './servers/terminal.js';
import { HostShell } from './servers/hostShell.js';
import { ensurePanelSshKey } from './servers/keys.js';
import { BackupService } from './services/backup.js';
import { OffsiteService } from './services/offsite.js';
import { StorageService } from './services/storage.js';
import { LocalHostExec } from './servers/hostExec.js';
import { SystemInfoService } from './servers/systemInfo.js';
import { DnsService } from './services/dns.js';
import { DnsAccount } from './services/dnsAccount.js';
import { TraefikDnsSync } from './services/traefikDns.js';
import { MonitorService } from './services/monitor.js';
import { SettingsService } from './services/settings.js';
import { SitesService } from './services/sites.js';
import { ApiKeysService } from './services/apiKeys.js';
import { ApiActivityService } from './services/apiActivity.js';
import { PluginCatalogService } from './services/pluginCatalog.js';
import { TwoFactorService } from './services/twoFactor.js';
import { UsersService } from './services/users.js';
import { AccountRecoveryService } from './services/accountRecovery.js';
import { OAuthService } from './services/oauth.js';
import { WporgDirectoryService } from './services/wporg.js';
import { MailService } from './services/mail.js';
import { TrafficService } from './services/traffic.js';
import { UpdateService } from './services/updates.js';
import { SystemUpdateService } from './services/systemUpdate.js';
import { GeoIpService } from './services/geoip.js';
import { VulnerabilityFeedService } from './services/vulnerabilities.js';
import { RecipeCatalog } from './services/catalog.js';
import { LicenseService } from './services/licenses.js';
import { PanelFiles } from './services/panelFiles.js';
import { CatalogSyncService } from './services/catalogSync.js';
import { WpInventoryService } from './services/wpInventory.js';
import { WpBulkService } from './services/wpBulk.js';
import { FtpService } from './services/ftp.js';
import { ProxyRangesService } from './services/proxyRanges.js';
import { SecurityService } from './services/security.js';
import { BlocklistService } from './services/blocklist.js';
import { SecurityEventsService } from './services/securityEvents.js';
import { FirewallSyncService } from './services/firewallSync.js';
import { AttackDetector } from './services/attackDetector.js';
import { IntegrityManifests } from './services/integrityManifests.js';
import { MalwareScanService } from './services/malwareScan.js';
import { PluginZipChecks } from './services/pluginZipChecks.js';
import { QuarantineService } from './services/quarantine.js';
import { ImportService } from './services/imports.js';
import { hostPortFor } from './servers/hostPort.js';
import type { CoreServices, Logger } from './services/index.js';
import { PANEL_VERSION } from './lib/version.js';
import { JobWorker } from './jobs/worker.js';
import { Schedulers } from './jobs/schedulers.js';
import { buildServer } from './server.js';
import type { AppDeps } from './routes/deps.js';

async function main(): Promise<void> {
  const config = loadConfig();
  for (const dir of [config.paths.sites, config.paths.backups, config.paths.plugins, config.paths.panel]) {
    await fsp.mkdir(dir, { recursive: true });
  }

  const db = openDb(config.paths.dbFile);
  runMigrations(db);
  const { generatedOwnerPassword, adoptedLegacyAdmin } = await seed(db, config);
  await ensurePanelSshKey(config);

  // Server 1 may keep its backups somewhere other than <SRV_ROOT>/backups (a second disk
  // bind-mounted by deploy/docker-compose.backup-root.yml). Create it here for the same
  // reason the rest of the layout is created here: the first scheduled run must not be the
  // thing that discovers the directory is missing.
  const localBackupRoot = db.select().from(serversTable).where(eq(serversTable.id, 1)).get()?.backupRoot;
  if (localBackupRoot && localBackupRoot !== config.paths.backups) {
    await fsp.mkdir(localBackupRoot, { recursive: true, mode: 0o700 });
  }

  const log: Logger = {
    info: (m) => console.log(`[panel] ${m}`),
    warn: (m) => console.warn(`[panel] WARN ${m}`),
    error: (m) => console.error(`[panel] ERROR ${m}`),
  };
  if (adoptedLegacyAdmin) {
    log.info('The panel login is now the owner account (Users); its password, 2FA and sessions carried over');
  }

  const servers = new ServerRegistry(db, config, log);
  const settings = new SettingsService(db);
  const backup = new BackupService(db, config, servers);
  const monitor = new MonitorService(db, config, servers);
  // The Cloudflare token in Settings -> DNS: the panel's own records from the first request on,
  // and every server's Traefik given a copy for the wildcard certificate's DNS challenges.
  const dns = new DnsService(null, log);
  const dnsAccount = new DnsAccount(settings, dns, servers, config, log);
  dnsAccount.load();
  const traefikDns = new TraefikDnsSync(config, servers, () => dnsAccount.token(), log);
  dnsAccount.onChange = () => void traefikDns.kickAll();
  // The mail setup guide publishes SPF/DKIM/DMARC through the same token, when there is one.
  const mail = new MailService(db, config, servers, settings, log, undefined, dns);
  const geoip = new GeoIpService(config, log);
  // The country table sits on disk from the last weekly download, but nothing read it in
  // before the nightly housekeeping asked whether it was stale - so for the hours between a
  // restart (every deploy is one) and 04:00, every visitor's country was blank. A lookup
  // before this finishes answers "unknown", which is what it said anyway.
  void geoip.load();
  const proxyRanges = new ProxyRangesService(settings, log);
  const traffic = new TrafficService(db, servers, settings, log, geoip, () => proxyRanges.trusted());
  const updates = new UpdateService(settings, config, log);

  const offsite = new OffsiteService(db, config, servers, backup, mail, log);
  // Read-only root shell on the panel's own host, so the Storage form can list the disks
  // this machine has rather than the ones its container happens to see.
  const hostExec = new LocalHostExec(db, config, log);
  const storage = new StorageService(db, config, servers, backup, log, hostExec);
  const vulnerabilities = new VulnerabilityFeedService(db, settings, log);
  // Plugin recipes: the public catalog's last verified copy over the files bundled with this
  // version (panel/catalog). Anything unreadable is logged and skipped, never fatal.
  const catalog = new RecipeCatalog(log);
  const panelFiles = new PanelFiles(db);
  const licenses = new LicenseService(db, config, catalog, panelFiles);
  const catalogSync = new CatalogSyncService(db, config, settings, catalog, log);
  licenses.reload = () => catalogSync.rebuild();
  catalogSync.rebuild();

  // A new release is worth an email: an operator does not live in the panel, and an update
  // that sits unnoticed for weeks is what a checker exists to prevent. Silently skipped when
  // no alert address is configured (Settings -> Mail).
  updates.onNewRelease = (release) => {
    void mail
      .notifyOperator(
        `${release.version} is available`,
        [
          `This server is running ${PANEL_VERSION}; ${release.version} was published on the ` +
            `${release.channel} channel${release.publishedAt ? ` (${release.publishedAt})` : ''}.`,
          release.notesUrl ? `Release notes: ${release.notesUrl}` : '',
          '',
          'Apply it from Settings -> Updates in the panel, or on the server with:',
          `  ./provision/update.sh --to=${release.version}`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .catch((err: unknown) => log.warn(`Update notification failed: ${String(err)}`));
  };

  const ftp = new FtpService(db, config, servers, settings, log);
  const security = new SecurityService(db, config, servers, settings, proxyRanges, log);
  // New Cloudflare ranges, or a proxy added in Settings: every site's limits key on them.
  // (and the blocked addresses behind a proxy key on them too - see the firewall below).
  proxyRanges.onChange = () => {
    void security.kickAll();
    void firewall.kickAll();
  };
  const blocklist = new BlocklistService(db, settings, servers, proxyRanges, geoip, log);
  const securityEvents = new SecurityEventsService(db, settings, geoip, blocklist);
  const detector = new AttackDetector(settings, blocklist, log);
  const integrityManifests = new IntegrityManifests(db, log);
  const quarantine = new QuarantineService(db, config, servers, log);
  const pluginZipChecks = new PluginZipChecks(db, servers, settings, (subject, body) => mail.notifyOperator(subject, body), log);
  const malwareScan = new MalwareScanService(db, config, servers, settings, integrityManifests, pluginZipChecks, panelFiles, quarantine, (subject, body) => mail.notifyOperator(subject, body), log);
  const importsService = new ImportService(db, config, settings, servers, log);
  // Requests the rules blocked are counted from the same read of the log as the visits.
  traffic.onEvents((serverId, events, chunk) => {
    securityEvents.fold(events);
    security.noteTraefikLog(chunk);
    detector.feed(serverId, events);
  });

  const hostShell = new HostShell(db, config, servers, log);
  const system = new SystemUpdateService(db, config, settings, updates, hostShell, log);
  const firewall = new FirewallSyncService(config, servers, settings, blocklist, proxyRanges, (id) => hostPortFor(id, { servers, hostShell }), log);
  // A block made, lifted or ended reaches every server; a burst of them as one load each.
  blocklist.onChange = () => void firewall.kickAll();
  // The inventory needs the rest of the bundle to scan a site, and the bundle needs it to
  // answer `GET /sites` - so it is constructed against the same object it lands in. The
  // same goes for `worker`, which JobWorker's own constructor fills in - see CoreServices.
  const core = {
    config,
    db,
    servers,
    backup,
    offsite,
    storage,
    monitor,
    settings,
    dns,
    dnsAccount,
    traefikDns,
    mail,
    traffic,
    geoip,
    vulnerabilities,
    licenses,
    catalogSync,
    ftp,
    proxyRanges,
    security,
    blocklist,
    securityEvents,
    firewall,
    detector,
    integrityManifests,
    malwareScan,
    pluginZipChecks,
    panelFiles,
    quarantine,
    imports: importsService,
    updates,
    system,
    log,
  } as CoreServices;
  core.wpInventory = new WpInventoryService(core, vulnerabilities);
  const worker = new JobWorker(db, core);
  // Circular by nature: the reconciler enqueues jobs, the worker runs handlers that need
  // the service. Attached once here rather than threaded through every handler.
  offsite.attachWorker(worker);
  importsService.attachWorker(worker);
  const schedulers = new Schedulers(core, worker);
  const wporg = new WporgDirectoryService();
  const users = new UsersService(db);
  const deps: AppDeps = {
    ...core,
    worker,
    sites: new SitesService(core, worker),
    apiKeys: new ApiKeysService(db),
    apiActivity: new ApiActivityService(db),
    users,
    twoFactor: new TwoFactorService(users, config.panelDomain || 'wpl7'),
    recovery: new AccountRecoveryService(users, mail, config, log),
    oauth: new OAuthService(db, config, settings, log),
    pluginCatalog: new PluginCatalogService(db, config.paths.plugins, wporg),
    wpBulk: new WpBulkService(core, worker, core.wpInventory),
    wporg,
    serverInfo: new SystemInfoService(servers, log, hostExec),
    terminal: new TerminalService(db, config, servers, log),
    schedulers,
  };

  installCrashHandlers(log);

  if (config.dnsProvider && config.dnsProvider !== 'cloudflare' && !dns.enabled) {
    log.warn(
      `DNS_PROVIDER=${config.dnsProvider}: Traefik answers DNS challenges with it, but the panel ` +
        `writes records through Cloudflare only, and Settings -> DNS has no Cloudflare token. Per-site ` +
        `records will not be created or flipped on move - manage them by hand, or see docs/dns.md.`,
    );
  }

  const app = await buildServer(deps);

  worker.reconcileOnBoot();
  // After the worker's sweep, which fails the jobs a restart cut short: their imports follow.
  importsService.reconcileOnBoot();
  worker.start();
  schedulers.start();

  // The relay reads its sender-authorization maps and credential database from disk, and
  // both are panel state. Publishing them at boot means a restored /srv/panel, a rebuilt
  // mail container or a hand-edited file converges without waiting for the next site
  // operation - and it is how a fresh install gets a valid /etc/sasl2/smtpd.conf at all.
  //
  // The signer then, the same way: its config and signing policy come from this panel, and a
  // new policy has to reach every server however the update arrived. Only a signer whose
  // config differs is rewritten and restarted.
  void mail
    .syncMailAuthEverywhere()
    .then((results) => {
      for (const failed of results.filter((r) => !r.ok)) {
        log.warn(`Mail relay auth not published on "${failed.name}": ${failed.detail}`);
      }
    })
    .catch((err: unknown) => log.warn(`Mail relay auth publish failed: ${String(err)}`))
    .then(() => mail.convergeSigners())
    .then((results) => {
      for (const server of results ?? []) {
        if (server.error) log.warn(`DKIM signer not brought up to date on "${server.name}": ${server.error}`);
        else if (server.synced) log.info(`DKIM signer on "${server.name}" brought up to date and restarted`);
      }
    })
    .catch((err: unknown) => log.warn(`DKIM signer check failed: ${String(err)}`));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`panel listening on :${config.port} (tls mode: ${config.tlsMode}, dev domain: ${config.devDomain})`);

  // This panel may be the one an update just installed, or the one a rollback brought back.
  // Either way something has to clear the maintenance flag and queue the work only the new
  // panel can do - the per-version steps and the worker servers.
  //
  // After listen(), not before: update.sh is waiting on this very process to answer its
  // health check and does not record an outcome until it does, so a boot-time question is
  // always asked one step too early. See reconcileHostUpdate().
  void system
    .reconcileHostUpdate(worker)
    .catch((err: unknown) => log.warn(`Could not reconcile the last update: ${String(err)}`));

  if (generatedOwnerPassword) {
    // Printed once, when no PANEL_ADMIN_PASSWORD was provided: on the very first boot, or on
    // the boot after the owner's password hash was blanked to get back in.
    const { username, password, reason } = generatedOwnerPassword;
    console.log('='.repeat(72));
    console.log(
      reason === 'first-boot'
        ? `  First boot: owner account "${username}" created`
        : `  Owner password reset: "${username}" had no password, so it has a new one`,
    );
    console.log(`  Generated password: ${password}`);
    console.log('  Printed once. Change it after signing in (Users -> your account).');
    console.log('='.repeat(72));
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received; shutting down…`);
    schedulers.stop();
    await worker.stop();
    await app.close();
    hostExec.close();
    await servers.closeAll();
    db.$client.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * The panel is a single process running the API, the job worker and every server's SSH
 * pool, so one stray stream error used to take all of it down. Socket-level noise
 * (EPIPE/ECONNRESET from a peer that hung up) is logged and survived; anything else is
 * genuinely unexpected, so we log the full stack and exit for the supervisor to restart
 * us - reconcileOnBoot() then marks the interrupted jobs failed rather than leaving them
 * "running" forever.
 */
function installCrashHandlers(log: Logger): void {
  const benign = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    if (err.code && benign.has(err.code)) {
      log.warn(`Ignoring ${err.code} from a torn-down stream: ${err.message}`);
      return;
    }
    console.error('[panel] uncaught exception:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    // Never fatal: a background best-effort task losing its handler must not evict
    // every in-flight job on every server.
    console.error('[panel] unhandled rejection:', reason);
  });
}

main().catch((err) => {
  console.error('[panel] fatal:', err);
  process.exit(1);
});
