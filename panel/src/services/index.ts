import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { ServerRegistry } from '../servers/registry.js';
import type { BackupService } from './backup.js';
import type { OffsiteService } from './offsite.js';
import type { StorageService } from './storage.js';
import type { DnsService } from './dns.js';
import type { DnsAccount } from './dnsAccount.js';
import type { TraefikDnsSync } from './traefikDns.js';
import type { MailService } from './mail.js';
import type { MonitorService } from './monitor.js';
import type { SettingsService } from './settings.js';
import type { TrafficService } from './traffic.js';
import type { UpdateService } from './updates.js';
import type { SystemUpdateService } from './systemUpdate.js';
import type { JobWorker } from '../jobs/worker.js';
import type { GeoIpService } from './geoip.js';
import type { WpInventoryService } from './wpInventory.js';
import type { VulnerabilityFeedService } from './vulnerabilities.js';
import type { LicenseService } from './licenses.js';
import type { CatalogSyncService } from './catalogSync.js';
import type { FtpService } from './ftp.js';
import type { ProxyRangesService } from './proxyRanges.js';
import type { SecurityService } from './security.js';
import type { BlocklistService } from './blocklist.js';
import type { SecurityEventsService } from './securityEvents.js';
import type { FirewallSyncService } from './firewallSync.js';
import type { AttackDetector } from './attackDetector.js';
import type { IntegrityManifests } from './integrityManifests.js';
import type { MalwareScanService } from './malwareScan.js';
import type { PanelFiles } from './panelFiles.js';
import type { PluginZipChecks } from './pluginZipChecks.js';
import type { QuarantineService } from './quarantine.js';
import type { ImportService } from './imports.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Dependency bundle handed to job handlers and routes. Constructed once in index.ts, faked in tests.
 * Per-server ports (docker/exec/files/dbAdmin/wp) are reached ONLY through
 * `servers.handleFor(site.serverId)` - never as singletons - so an operation can't
 * accidentally run against the wrong machine.
 */
export interface CoreServices {
  config: Config;
  db: Db;
  servers: ServerRegistry;
  backup: BackupService;
  /** Offsite copies of backups: destinations, the reconciler and the rclone runner. */
  offsite: OffsiteService;
  /** Where each server keeps its backups, and the discovery behind the Storage form. */
  storage: StorageService;
  monitor: MonitorService;
  settings: SettingsService;
  /** The panel's own records, in the Cloudflare account Settings -> DNS holds the token of. */
  dns: DnsService;
  /** That token: kept write-only, checked, and handed on. */
  dnsAccount: DnsAccount;
  /** Every server's Traefik given the same token, for the wildcard certificate's DNS challenges. */
  traefikDns: TraefikDnsSync;
  mail: MailService;
  traffic: TrafficService;
  geoip: GeoIpService;
  /** Per-site WordPress snapshot (plugins, themes, core) and the fleet view over it. */
  wpInventory: WpInventoryService;
  /** Cached wpvulnerability.net answers plus the version-range matcher. */
  vulnerabilities: VulnerabilityFeedService;
  updates: UpdateService;
  /** The Update button, and the maintenance flag the post-update job has to clear. */
  system: SystemUpdateService;
  /**
   * The queue, so a handler can queue more work. Set by JobWorker's own constructor rather
   * than by every caller: the worker is built from this object, so it cannot be in it yet
   * when it is created, and a handler that has to reach the queue through a global instead
   * is worse than one line of self-registration.
   */
  worker: JobWorker;
  /** Plugin recipes (bundled catalog), the license keys stored for them, and the runner. */
  licenses: LicenseService;
  /** The public catalog: hourly fetch, signature check, last verified copy. */
  catalogSync: CatalogSyncService;
  /** FTP/SFTP logins: the logins themselves, and each server's gateway and file servers. */
  ftp: FtpService;
  /** Cloudflare's and Jetpack's published ranges, and which proxies' visitor header is believed. */
  proxyRanges: ProxyRangesService;
  /** Each site's protection policy, and every server's rules folder kept in line with it. */
  security: SecurityService;
  /** Blocked addresses, the never-block list, and who is protected from blocking and why. */
  blocklist: BlocklistService;
  /** Requests each site's protection blocked, counted from the access log. */
  securityEvents: SecurityEventsService;
  /** The block list in force on every server: the network layer and the HTTP one. */
  firewall: FirewallSyncService;
  /** Attack detection over every server's access log: who to block, and why not when not. */
  detector: AttackDetector;
  /** wordpress.org's published checksums, fetched for scans that have no network of their own. */
  integrityManifests: IntegrityManifests;
  /** One site's malware scan, and the findings every scan keeps. */
  malwareScan: MalwareScanService;
  pluginZipChecks: PluginZipChecks;
  /** What the panel wrote into each site's files: a scan holds them to it. */
  panelFiles: PanelFiles;
  /** Files moved out of sites, kept beside them until restored or deleted. */
  quarantine: QuarantineService;
  /** Imports of existing WordPress sites through the migration plugin. */
  imports: ImportService;
  log: Logger;
}
