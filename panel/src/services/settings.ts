import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import type {
  AutoBlockMode,
  DetectionRules,
  ScanOnFinding,
  SecurityLevel,
  SecurityOverrides,
  TrustedProxiesSetting,
} from '../../shared/security.js';

export interface PanelSettings {
  backupCron: string;
  backupRetention: number;
  monitorUptimeIntervalSec: number;
  monitorStatsIntervalSec: number;
  monitorDuIntervalMin: number;
  monitorRetentionDays: number;
  jobsRetentionDays: number;
  /** How long parsed mail-relay traffic is kept. */
  mailRetentionDays: number;
  /**
   * How long the API request log is kept. Short by default: it answers "what did my
   * integration just do", and a row cap (services/apiActivity.ts) bounds it regardless.
   */
  apiActivityRetentionDays: number;
  /** How long per-site visitor statistics are kept. Longer than the rest: a traffic
   * chart is worth little without last year's same month to compare it against. */
  trafficRetentionDays: number;
  /**
   * How long per-address counters are kept. Far shorter than `trafficRetentionDays`: this
   * is the only personal data the statistics hold, and it answers an operational question
   * about the recent past, not a reporting one about the year.
   */
  trafficIpRetentionDays: number;
  /** false = never write a visitor address down; the anonymous counters carry on. */
  trafficStoreIps: boolean;
  /** Per-site hourly send volume above which the mail page flags a site as suspicious. */
  mailAlertPerSitePerHour: number;
  /**
   * Per-site hourly send volume at which the relay stops accepting that site's mail
   * altogether. Deliberately far above the alert threshold: flagging is for "look at this",
   * suspension is for "this is a spam run". 0 disables enforcement.
   */
  mailSuspendPerSitePerHour: number;
  /** Where the panel emails operational alerts (mail suspensions). Empty = log only. */
  alertEmail: string;
  /** CPU cores a site container may use (fractional allowed). 0 = uncapped. */
  siteCpuLimit: number;
  /** Memory ceiling per site container. */
  siteMemoryLimitMb: number;
  /** Process/thread ceiling per site container (fork-bomb guard). 0 = uncapped. */
  sitePidsLimit: number;
  defaultPhpVersion: string;
  defaultLocale: string;
  /**
   * The WordPress admin email a new site starts with: prefilled in the New Site wizard, and
   * used when an API request leaves `adminEmail` out. Empty = none, so both have to give one.
   */
  defaultAdminEmail: string;
  phpVersions: string[];
  defaultServerId: number;
  dnsWildcardServerId: number;
  /**
   * How often the panel re-reads every site's plugins, themes and core version. Every
   * pass is one `wp plugin list` per site, which WordPress turns into a fresh check
   * against api.wordpress.org - so this is the knob between "the dashboard is current"
   * and "stop poking fifty containers".
   */
  wpScanIntervalHours: number;
  /**
   * false = never ask wpvulnerability.net about installed slugs. The panel then shows
   * "feed off" instead of a severity, and nothing about the sites leaves the machine.
   */
  vulnerabilityFeed: boolean;
  /**
   * false = FTP/SFTP off everywhere: every gateway and file server is removed and their ports
   * close. The logins themselves are kept, and come back when it is switched on again.
   */
  ftpEnabled: boolean;
  /** Host port of every server's SFTP. Not 22: that is the host's own sshd, which the panel needs. */
  ftpSftpPort: number;
  /** false = SFTP only: no FTP port and no passive range open on any server. */
  ftpOfferFtps: boolean;
  ftpPort: number;
  /** FTP's data connections, one port each while they last; published 1:1. */
  ftpPassivePortStart: number;
  ftpPassivePortEnd: number;
  /**
   * The proxies whose visitor header is believed: Cloudflare (whose ranges the panel keeps
   * current itself) and any of the operator's own. See lib/clientIp.ts.
   */
  securityTrustedProxies: TrustedProxiesSetting;
  /** The protection level of every site that has not chosen its own (shared/security.ts). */
  securityLevel: SecurityLevel;
  /** Single rules and limits changed for every site that follows the default level. */
  securityOverrides: SecurityOverrides;
  /**
   * Private addresses skip the rate limits. An IPv6 visitor reaches Traefik as the address of
   * Docker's bridge when Docker has no IPv6 networking, so without this every IPv6 visitor of
   * a server would share one allowance - and the panel's own uptime probe would count too.
   */
  securityBypassPrivate: boolean;
  /** 'on': the detector blocks; 'observe': it only records what it would have done; 'off'. */
  securityAutoBlock: AutoBlockMode;
  /** false = no block reaches any server: the network sets are emptied, the list is kept. */
  securityEnforcement: boolean;
  /** Thresholds of the detection rules. */
  securityRules: DetectionRules;
  /** A first automatic block lasts this long... */
  securityBlockMinutes: number;
  /** ...each repeat within 30 days this many times the one before... */
  securityBlockMultiplier: number;
  /** ...and never longer than this. */
  securityBlockMaxDays: number;
  /** More blocks than this in force and the detector stops adding them (and says so). */
  securityMaxActiveBlocks: number;
  /** How long ended blocks are kept for the history and for counting repeats. */
  securityHistoryDays: number;
  /** Malware scans, fleet-wide; a site can say otherwise. */
  scanEnabled: boolean;
  /** false = the panel's own checks only, without AMWScan's signatures. */
  scanSignatures: boolean;
  scanIntervalHours: number;
  /** What happens to confirmed malware; a site can say otherwise. */
  scanOnFinding: ScanOnFinding;
  /** Memory ceiling of each scan's container. */
  scanMemoryMb: number;
  /** A scan still running after this is stopped and reported incomplete. */
  scanTimeoutMin: number;
  /** Quarantined files are deleted after this many days; 0 = kept until deleted by hand. */
  scanQuarantineKeepDays: number;
  /**
   * The MCP server (docs/mcp.md): false = /mcp, /oauth/* and /.well-known/oauth-* answer 404.
   * Off by default. Switching it off pauses the connected apps and keeps them - their tokens
   * work again when it is switched back on.
   */
  mcpEnabled: boolean;
}

const KEY_MAP: Record<keyof PanelSettings, string> = {
  backupCron: 'backup.cron',
  backupRetention: 'backup.retention',
  monitorUptimeIntervalSec: 'monitor.uptimeIntervalSec',
  monitorStatsIntervalSec: 'monitor.statsIntervalSec',
  monitorDuIntervalMin: 'monitor.duIntervalMin',
  monitorRetentionDays: 'monitor.retentionDays',
  jobsRetentionDays: 'jobs.retentionDays',
  mailRetentionDays: 'mail.retentionDays',
  apiActivityRetentionDays: 'apiActivity.retentionDays',
  trafficRetentionDays: 'traffic.retentionDays',
  trafficIpRetentionDays: 'traffic.ipRetentionDays',
  trafficStoreIps: 'traffic.storeIps',
  mailAlertPerSitePerHour: 'mail.alertPerSitePerHour',
  mailSuspendPerSitePerHour: 'mail.suspendPerSitePerHour',
  alertEmail: 'alerts.email',
  siteCpuLimit: 'site.cpuLimit',
  siteMemoryLimitMb: 'site.memoryLimitMb',
  sitePidsLimit: 'site.pidsLimit',
  defaultPhpVersion: 'site.defaultPhpVersion',
  defaultLocale: 'site.defaultLocale',
  defaultAdminEmail: 'site.defaultAdminEmail',
  phpVersions: 'site.phpVersions',
  defaultServerId: 'site.defaultServerId',
  dnsWildcardServerId: 'dns.wildcardServerId',
  wpScanIntervalHours: 'wp.scanIntervalHours',
  vulnerabilityFeed: 'wp.vulnerabilityFeed',
  ftpEnabled: 'ftp.enabled',
  ftpSftpPort: 'ftp.sftpPort',
  ftpOfferFtps: 'ftp.offerFtps',
  ftpPort: 'ftp.ftpPort',
  ftpPassivePortStart: 'ftp.passivePortStart',
  ftpPassivePortEnd: 'ftp.passivePortEnd',
  securityTrustedProxies: 'security.trustedProxies',
  securityLevel: 'security.level',
  securityOverrides: 'security.overrides',
  securityBypassPrivate: 'security.bypassPrivate',
  securityAutoBlock: 'security.autoBlock',
  securityEnforcement: 'security.enforcement',
  securityRules: 'security.rules',
  securityBlockMinutes: 'security.blockMinutes',
  securityBlockMultiplier: 'security.blockMultiplier',
  securityBlockMaxDays: 'security.blockMaxDays',
  securityMaxActiveBlocks: 'security.maxActiveBlocks',
  securityHistoryDays: 'security.historyDays',
  scanEnabled: 'scan.enabled',
  scanSignatures: 'scan.signatures',
  scanIntervalHours: 'scan.intervalHours',
  scanOnFinding: 'scan.onFinding',
  scanMemoryMb: 'scan.memoryMb',
  scanTimeoutMin: 'scan.timeoutMin',
  scanQuarantineKeepDays: 'scan.quarantineKeepDays',
  mcpEnabled: 'mcp.enabled',
};

export class SettingsService {
  constructor(private readonly db: Db) {}

  getRaw(key: string): unknown {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? JSON.parse(row.value) : undefined;
  }

  setRaw(key: string, value: unknown): void {
    const now = Date.now();
    this.db
      .insert(settings)
      .values({ key, value: JSON.stringify(value), updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: now } })
      .run();
  }

  /** Set only when the key does not exist yet (first-boot seeding). */
  seedRaw(key: string, value: unknown): void {
    if (this.getRaw(key) === undefined) this.setRaw(key, value);
  }

  get<K extends keyof PanelSettings>(key: K): PanelSettings[K] {
    return this.getRaw(KEY_MAP[key]) as PanelSettings[K];
  }

  set<K extends keyof PanelSettings>(key: K, value: PanelSettings[K]): void {
    this.setRaw(KEY_MAP[key], value);
  }

  getAll(): PanelSettings {
    const out = {} as Record<keyof PanelSettings, unknown>;
    for (const key of Object.keys(KEY_MAP) as (keyof PanelSettings)[]) {
      out[key] = this.getRaw(KEY_MAP[key]);
    }
    return out as unknown as PanelSettings;
  }

  update(patch: Partial<PanelSettings>): PanelSettings {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      this.set(key as keyof PanelSettings, value as never);
    }
    return this.getAll();
  }
}
