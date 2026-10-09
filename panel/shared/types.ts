/** DTO shapes returned by the API, consumed by the React app. */
import type { AccessLevel } from './access.js';
import type { WpLocale } from './locales.js';
import type { RecipeHook } from './recipes.js';
import type {
  BackupType,
  CopyStatus,
  ImportRunBody,
  ImportStatus,
  JobCategory,
  JobOrigin,
  JobStatus,
  JobType,
  MailStatusName,
  ServerKind,
  ServerStatus,
  ConnectionStatus,
  SiteKind,
  SiteStatus,
  WpBulkAction,
  WpComponentKind,
} from './schemas.js';
import type { ScheduleAction, ScheduleTarget, ScheduleTargetKind } from './scheduleActions.js';
import type {
  AutoBlockMode,
  BlockEndReason,
  CustomRule,
  DetectionRuleId,
  EffectivePolicy,
  FindingConfidence,
  FindingKind,
  FindingSeverity,
  FindingStatus,
  FleetSecurity,
  ScanOnFinding,
  ScanOutcome,
  SecurityLevel,
  SecurityOverrides,
} from './security.js';

export interface SiteSummary {
  id: number;
  slug: string;
  title: string;
  serverId: number;
  serverName: string;
  primaryDomain: string;
  domains: string[];
  devHostname: string | null;
  isLive: boolean;
  phpVersion: string;
  status: SiteStatus;
  /**
   * Last HTTP probe verdict. `null` = no probe has completed since the panel started;
   * it is deliberately separate from `status`, which is the panel's *intent* for the
   * site (what the last job left it as), not a live reading. The two disagreeing is
   * the interesting case, not a bug - see `siteHealth` in the web app, which is the
   * one place that turns the pair into a single state for a human.
   */
  up: boolean | null;
  /** What the probe got back; `null` = nothing answered at all (refused, timed out). */
  httpStatus: number | null;
  /** When the probe last ran; `null` before the first tick after a panel restart. */
  lastCheckedAt: number | null;
  diskBytes: number | null;
  /** Unique visitors and page views over the last 24h; null before any traffic is collected. */
  recentTraffic: { visitors: number; pageViews: number } | null;
  /** WordPress snapshot counters; null until this site has been scanned once. */
  wp: SiteWpSummary | null;
  /**
   * `hosted`: in a container on `serverId`. `external`: hosted elsewhere and reached through the
   * WPL7 Connect plugin; `serverId` is then the server that keeps its backups, and `external`
   * says how the connection stands.
   */
  kind: SiteKind;
  external: ExternalSiteSummary | null;
  createdAt: number;
}

/** A site hosted elsewhere, as the site list shows it. */
export interface ExternalSiteSummary {
  /** The site's address, as its plugin reported it: the connection is bound to it. */
  home: string;
  /** Whether the plugin answered the panel's last request; null before the first. */
  reachable: boolean | null;
  lastContactAt: number | null;
  lastBackupAt: number | null;
  /** WPL7 Connect's version on the site. */
  pluginVersion: string | null;
}

/** Something the panel says about a connected site's set-up. `blocking`: it cannot be added. */
export interface ConnectWarning {
  code: string;
  blocking: boolean;
  message: string;
  /** What it is about, when there is one thing: the site's new address for `home_changed`. */
  value?: string;
}

/** A site hosted elsewhere in full: its site page reads it. Never carries a key. */
export interface ExternalSiteDto extends ExternalSiteSummary {
  connectionId: number;
  protocol: number | null;
  /** From the last inventory or report. */
  wpVersion: string | null;
  /** Why the last request failed, while it is the latest news. */
  lastError: string | null;
  /** The administrator updates and logins run as. */
  actAs: { id: number; login: string } | null;
  /** The site's administrators, as its plugin last reported them. */
  admins: { id: number; login: string }[];
  storageServerId: number;
  storageServerName: string;
  /** The size of the site's copy on the backup server, after the last backup. */
  mirrorBytes: number | null;
  certExpiresAt: number | null;
  warnings: ConnectWarning[];
  /** The commands plugins registered on WPL7 Connect (`/wp/cli` runs only these). */
  commands: string[];
  /** A newer WPL7 Connect the panel offers this site; null when it runs the panel's own. */
  offer: { version: string } | null;
  /** The address the site answers with now, when it is not the one the connection is bound to. */
  homeChanged: string | null;
  allowHttp: boolean;
}

/** The denormalised part of a site's WordPress snapshot, cheap enough for a list. */
export interface SiteWpSummary {
  scannedAt: number;
  /** Plugins + themes with an available update, plus 1 when core has one. */
  updates: number;
  /** Components matching at least one known advisory, or closed on wordpress.org. */
  vulnerable: number;
  worstSeverity: VulnSeverity | null;
  /** The core version an update is available for, e.g. "6.8.3"; null when up to date. */
  coreUpdate: string | null;
}

export interface SiteDetail extends SiteSummary {
  locale: string;
  adminUser: string | null;
  adminEmail: string | null;
  dbName: string;
  /** The prefix of the site's WordPress tables: `wp_`, or what an imported site came with. */
  tablePrefix: string;
  /** 'unknown' = the hosting server could not be asked (unreachable); the rest of the detail is served from the registry. */
  containerState: 'running' | 'created' | 'exited' | 'missing' | 'unknown';
  url: string;
  keepDevAlias: boolean;
  /** False = the scheduled backup run skips this site; every other kind still runs. */
  backupsEnabled: boolean;
  /** False = this site's backups are never copied to an offsite destination. */
  offsiteEnabled: boolean;
  /** Set when the relay is refusing this site's outbound mail (abuse guard or an operator). */
  mailSuspended: { since: number; reason: string } | null;
  /** Set while an old copy from a move is still parked on the source server. */
  pendingMoveCleanup: {
    id: number;
    sourceServerName: string;
    targetIp: string;
    hostsPending: string[];
    since: number;
  } | null;
  /**
   * The import this site came from, when it did. `connected`: the plugin on the old site still
   * answers it. `refreshJobId`: the refresh from the old site that is queued or running.
   */
  importSource: {
    importId: number;
    url: string | null;
    status: ImportStatus;
    connected: boolean;
    importedAt: number | null;
    refreshJobId: number | null;
  } | null;
  /** Set for an external site. */
  external: ExternalSiteDto | null;
}

// ---------------------------------------------------------------------------
// Site imports

/** Something the Confirm step tells the admin about the old site. `blocking`: the import cannot start. */
export interface ImportWarning {
  code: string;
  blocking: boolean;
  message: string;
}

/** A constant from the old wp-config.php that can be carried over. The value itself stays on the panel. */
export interface ImportConstantDto {
  name: string;
  type: 'string' | 'bool' | 'int' | 'float' | 'null';
  /** The value as shown: masked when the name reads like a secret. */
  preview: string;
  /** Ticked on the Confirm step to begin with. */
  ticked: boolean;
  /** Why it starts unticked. */
  note: string | null;
}

/** What the Confirm step starts with. */
export interface ImportSuggestionsDto {
  title: string;
  slug: string;
  phpVersion: string | null;
  deactivatePlugins: string[];
  removeDropins: string[];
  removeMuPlugins: string[];
}

/** The old site, as its plugin reported it. */
export interface ImportSourceDto {
  home: string;
  siteurl: string;
  title: string;
  wpVersion: string;
  phpVersion: string;
  tablePrefix: string;
  locale: string;
  /** The old site's "Search engine visibility". */
  searchEnginesAllowed: boolean;
  https: boolean;
  abspath: string;
  files: { count: number; bytes: number; partial: boolean };
  db: { server: string; bytes: number; tables: number };
  plugins: { slug: string; name: string; version: string; active: boolean }[];
  theme: { slug: string; name: string; version: string } | null;
  dropins: string[];
  muPlugins: { file: string; name: string }[];
  pluginVersion: string;
}

/** How far a pull has got. */
export interface ImportProgressDto {
  phase: 'snapshot' | 'files' | 'db' | 'done';
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  tablesDone: number;
  tablesTotal: number;
}

/** One import in the list. */
export interface ImportSummaryDto {
  id: number;
  status: ImportStatus;
  /** The old site's address once it connected, else what the admin typed (or null). */
  source: string | null;
  siteSlug: string | null;
  /** The new site's address, once there is a site. */
  siteUrl: string | null;
  serverName: string | null;
  jobId: number | null;
  lastError: string | null;
  progress: ImportProgressDto | null;
  createdAt: number;
  startedAt: number | null;
  importedAt: number | null;
  expiresAt: number | null;
}

/** One import in full: the Connect, Confirm and Import steps read it. Never carries the token. */
export interface ImportDto extends ImportSummaryDto {
  allowHttp: boolean;
  /** The plugin on the old site can still be reached through this import (its token is live). */
  connected: boolean;
  /** The personalised plugin can be downloaded (`GET /api/imports/:id/plugin`). */
  canDownload: boolean;
  connectedAt: number | null;
  report: ImportSourceDto | null;
  warnings: ImportWarning[];
  /** Why Start import is refused right now, or null. */
  blockedReason: string | null;
  suggestions: ImportSuggestionsDto | null;
  constants: ImportConstantDto[];
  choices: ImportRunBody | null;
}

/** For the plugin's own form, when it came without its connection file (`GET /api/imports/:id/code`). */
export interface ImportConnectionCodeDto {
  /** The panel's address, as the plugin calls it. */
  panel: string;
  /** The import's token. */
  code: string;
}

// ---------------------------------------------------------------------------
// Connections: sites hosted elsewhere, through WPL7 Connect

/** A connection that is not a site yet: Sites → Connect a site lists them. */
export interface ConnectionSummaryDto {
  id: number;
  status: ConnectionStatus;
  /** The site's address once its plugin enrolled, else what the admin typed (or null). */
  source: string | null;
  /** The site a reconnect is for. */
  forSite: { slug: string; title: string } | null;
  /** The site this connection belongs to, once it was added (or reconnected). */
  site: { slug: string; title: string } | null;
  createdAt: number;
  enrolledAt: number | null;
  expiresAt: number | null;
}

/** The site as its plugin reported it, for the Confirm step. */
export interface ConnectSourceDto {
  home: string;
  title: string;
  wpVersion: string;
  phpVersion: string;
  tablePrefix: string;
  locale: string;
  https: boolean;
  files: { count: number; bytes: number; partial: boolean };
  db: { server: string; bytes: number; tables: number };
  plugins: number;
  theme: { slug: string; name: string } | null;
  pluginVersion: string;
  admins: { id: number; login: string; name: string }[];
  /** How WordPress writes files there: `direct` takes updates as they are. */
  fsMethod: string;
  fileMods: boolean;
  /** The must-use loader is in place: rollback works when an update breaks the site. */
  loader: boolean;
  commands: string[];
}

/** One connection in full: the Connect and Confirm steps read it. Never carries a key or the token. */
export interface ConnectionDto extends ConnectionSummaryDto {
  allowHttp: boolean;
  /** The plugin can be downloaded (`GET /api/connections/:id/plugin`). */
  canDownload: boolean;
  report: ConnectSourceDto | null;
  warnings: ConnectWarning[];
  /** Why Add site is refused right now, or null. */
  blockedReason: string | null;
  /** The panel's last attempt to reach the plugin. */
  check: { at: number; reachable: boolean; transport: 'rest' | 'query' | null; error: string | null } | null;
  /** What the Confirm step's fields start with. */
  suggestions: { slug: string; title: string; actAs: number | null; storageServerId: number } | null;
}

/** For the plugin's own form, when it came without its connection file (`GET /api/connections/:id/code`). */
export interface ConnectionCodeDto {
  panel: string;
  /** The enrollment token and the panel's public key, `<token>.<key>`. */
  code: string;
}

/** What the plugin's admin page shows while the panel works (`GET /api/migrate/status`). */
export interface MigrateStatusDto {
  status: ImportStatus;
  phase: ImportProgressDto['phase'] | null;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  tablesDone: number;
  tablesTotal: number;
  siteUrl?: string;
  message?: string;
}

export interface JobDto {
  id: number;
  type: JobType;
  status: JobStatus;
  siteSlug: string | null;
  /** Set on the jobs of one bulk run; null for everything else. */
  batchId: number | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /**
   * One line about this particular job ("Update plugin akismet", "wp cache flush"), written
   * when it was queued. Never names the site or server - those are fields of their own - and
   * never carries a password. Null on jobs queued before the panel recorded it.
   */
  summary: string | null;
  /** How it was queued; null on jobs older than this field. */
  origin: JobOrigin | null;
  /** Who: the admin's username, `API key "<name>"`, or the schedule's name. */
  createdBy: string | null;
  /** The schedule that queued it - by timer or by "Run now". */
  scheduleId: number | null;
  /** The server it runs on, including jobs in a named lane (offsite:<id>, exec:<id>). */
  serverId: number | null;
  /** A running job asked to stop; it does at its next safe step. */
  cancelRequested: boolean;
}

/** `GET /jobs`. */
export interface JobListDto {
  items: JobDto[];
  total: number;
  /** Per status, under every filter except the status one - what the status chips show. */
  counts: Record<JobStatus, number>;
  /** Finished jobs older than this are removed by the nightly housekeeping. */
  retentionDays: number;
}

/** `GET /jobs/types`: the catalog in shared/jobTypes.ts, plus each type's time limit. */
export interface JobTypeInfoDto {
  type: JobType;
  label: string;
  description: string;
  category: JobCategory;
  internal: boolean;
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Schedules

export type ScheduleKind = 'builtin' | 'custom';
/** `jobs`: built-ins that queue jobs; `background`: ticks that run inside the panel. */
export type ScheduleGroup = 'jobs' | 'background' | 'custom';
export type ScheduleOutcome = 'ok' | 'failed' | 'skipped';

export interface ScheduleSkip {
  siteSlug: string | null;
  reason: string;
}

/** What one run did, as stored with the schedule. */
export interface ScheduleRunResult {
  /** Jobs it queued. */
  jobs: number;
  /** Sites it left out, and why (at most 20 kept). */
  skipped: ScheduleSkip[];
  /** A sentence for runs that queue nothing ("Nothing to update", "Missed while the panel was down"). */
  message: string | null;
}

export interface ScheduleDto {
  id: number;
  /** Built-ins only: `backups`, `wp-scan`, `uptime`, … Also accepted in place of the id. */
  key: string | null;
  kind: ScheduleKind;
  group: ScheduleGroup;
  name: string;
  description: string;
  /** Custom schedules only. */
  action: ScheduleAction | null;
  target: ScheduleTarget | null;
  /** Slugs in a `sites` target that no longer exist; each run skips them. */
  missing: string[];
  params: Record<string, unknown> | null;
  cadence: {
    cron: string | null;
    everyMs: number | null;
    runAt: number | null;
    /** In words: "At 03:00, every day.", "Every minute", "Once, on …". */
    text: string;
  };
  /** Where the cadence is changed, for built-ins whose cadence is a setting. */
  settingsHref: string | null;
  enabled: boolean;
  pausedAt: number | null;
  pausable: boolean;
  /** Why it cannot be paused. */
  lockedReason: string | null;
  /** What stops while it is paused. */
  pauseWarning: string | null;
  /** A run is in progress right now. */
  running: boolean;
  /** A one-off that has run; it stays for its history until deleted or given a new time. */
  finished: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastOutcome: ScheduleOutcome | null;
  lastError: string | null;
  lastResult: ScheduleRunResult | null;
  /** Status counts of the jobs its last run queued; null when it queued none. */
  lastJobs: Partial<Record<JobStatus, number>> | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** `POST /schedules/:id/run`. Background tasks answer `{running: true}` and nothing else. */
export interface ScheduleRunDto {
  jobs: JobDto[];
  skipped: ScheduleSkip[];
  running: boolean;
}

/** One entry of `GET /schedules/actions`. */
export interface ScheduleActionDto {
  action: ScheduleAction;
  label: string;
  description: string;
  category: JobCategory;
  targets: readonly ScheduleTargetKind[];
  jobType: JobType;
  /** JSON Schema (draft 2020-12) of `params`, as the request accepts it. */
  paramsSchema: Record<string, unknown>;
}

export interface ScheduleActionsDto {
  actions: ScheduleActionDto[];
  /** JSON Schema of `target`. */
  targetSchema: Record<string, unknown>;
  /** JSON Schema of the whole `POST /schedules` body. */
  createBodySchema: Record<string, unknown>;
  minGapMinutes: number;
  maxCustomSchedules: number;
  /** The clock cron expressions run on. */
  timezone: string;
}

export interface JobLogLine {
  seq: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface BackupDto {
  id: number;
  siteSlug: string;
  serverId: number;
  type: BackupType;
  status: 'creating' | 'complete' | 'failed';
  sizeBytes: number | null;
  wpVersion: string | null;
  phpVersion: string | null;
  note: string | null;
  jobId: number | null;
  /** False = the files were pruned locally and this backup now exists only offsite. */
  filesPresent: boolean;
  /** Where the files are (or were) on the server; null on rows predating per-server roots. */
  rootPath: string | null;
  /** One entry per destination that has, or should have, this backup. */
  copies: BackupCopyDto[];
  /** The queued or running `backup.delete` job that is about to remove this backup, if any. */
  deletingJobId: number | null;
  createdAt: number;
}

/** A backup in the list of every backup (GET /api/backups): whose it is, as well as what. */
export interface BackupListItemDto extends BackupDto {
  /** The site's title while it exists. Null once it is deleted, and for a panel snapshot. */
  siteTitle: string | null;
  /** No site of this slug exists any more. A panel snapshot is never one. */
  siteDeleted: boolean;
  /** The site's kind while it exists: an external site's backups are restored by hand. */
  siteKind: SiteKind | null;
}

export interface BackupListDto {
  items: BackupListItemDto[];
  /** Every backup the filters match, across all pages. */
  total: number;
  /**
   * Sites that no longer exist but still have backups, most recently backed up first -
   * whatever the filters. Nowhere else in the panel still names them. `backups` counts every
   * row the list shows; `complete` only the ones that can be restored - a failed backup has
   * no files, and must not stand in for a site's last usable one.
   */
  deletedSites: { slug: string; backups: number; complete: number; lastBackupAt: number; sizeBytes: number }[];
}

/**
 * `GET /api/backups/ids`: every backup some filters match that a bulk delete could take - not
 * one still being written, nor one a deletion already has - newest first, with what deleting
 * them asks about. At most MAX_BULK_BACKUP_DELETE of them; `total` says how many there are.
 */
export interface BackupIdsDto {
  items: {
    id: number;
    siteSlug: string;
    siteDeleted: boolean;
    status: 'complete' | 'failed';
    /** Completed copies at remote destinations, which a delete removes too. */
    remoteCopies: number;
  }[];
  total: number;
}

/** One backup at one offsite destination. */
export interface BackupCopyDto {
  id: number;
  backupId: number;
  destinationId: number;
  destinationName: string;
  /** Set on the failures view, where a copy is shown without its backup's context. */
  siteSlug: string | null;
  backupType: BackupType | null;
  backupCreatedAt: number | null;
  status: CopyStatus;
  remotePath: string;
  sizeBytes: number | null;
  attempts: number;
  /** When the next retry is due; null once it has given up (or has nothing to retry). */
  nextAttemptAt: number | null;
  error: string | null;
  completedAt: number | null;
  createdAt: number;
}

/** An offsite destination as the API describes it — never including its credentials. */
export interface BackupDestinationDto {
  id: number;
  provider: string;
  providerLabel: string;
  name: string;
  /** Non-secret fields only (endpoint, bucket, prefix, host, user…). */
  config: Record<string, string>;
  /** Which secret fields have a stored value. Never the values themselves. */
  secretsSet: string[];
  enabled: boolean;
  copyTypes: BackupType[];
  /** Scheduled backups kept per site here; 0 = keep every one. */
  retentionScheduled: number;
  /** 'external' = the provider's own lifecycle rules own deletion; the panel never deletes. */
  retentionMode: 'panel' | 'external';
  bwlimit: string | null;
  /**
   * 'crypt' = contents and file names are encrypted on the server before upload, so the
   * provider holds ciphertext only. Fixed once the destination holds any copy.
   */
  encryption: 'none' | 'crypt';
  stats: { complete: number; pending: number; failed: number; bytes: number };
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface OffsiteOverviewDto {
  destinations: BackupDestinationDto[];
  /** Newest success across all destinations; null before anything has been copied. */
  lastSuccessAt: number | null;
  last24h: { completed: number; failed: number; pending: number };
  /** Most recent failed copies, for the Storage page's failures view. */
  failures: BackupCopyDto[];
}

/**
 * A catalog zip's malware check (services/pluginZipChecks.ts): what it holds, and what
 * AMWScan says about it. A site's copy of a file is vouched for when it is the same as the
 * zip's - but not a file the check flagged, until someone has reviewed those.
 */
export interface PluginZipCheckDto {
  /** pending: never finished; done; incomplete: not every file checked - vouches for nothing; failed. */
  status: 'pending' | 'done' | 'incomplete' | 'failed';
  /** A check is queued or running. */
  checking: boolean;
  folder: string | null;
  version: string | null;
  files: number | null;
  /** Files AMWScan flagged at all, and matches of known malware among its findings. */
  flagged: number;
  confirmed: number;
  problem: string | null;
  checkedAt: number | null;
  /** Someone said the flagged files are the plugin's own - of exactly these findings. */
  reviewed: { at: number; by: string | null } | null;
  needsReview: boolean;
}

export interface PluginZipFindingDto {
  path: string;
  kind: FindingKind;
  label: string;
  severity: FindingSeverity;
  rule: string | null;
  line: number | null;
  detail: string | null;
}

export interface PluginDto {
  id: number;
  kind: 'wporg' | 'zip';
  slug: string;
  name: string;
  /**
   * The folder it installs into, as `wp plugin list` names it - what a recipe applies to. The
   * slug for wordpress.org; for an upload, the zip's top-level folder, or null when the zip
   * has no single one (or cannot be read).
   */
  pluginDir: string | null;
  isDefault: boolean;
  zipPath: string | null;
  createdAt: number;
  /** An uploaded zip's malware check; null for wordpress.org entries and unchecked zips. */
  check: PluginZipCheckDto | null;
}

/** A plugin as the wordpress.org directory describes it (search results, slug lookups). */
export interface WporgPluginDto {
  slug: string;
  name: string;
  author: string;
  shortDescription: string;
  version: string;
  activeInstalls: number;
  /** 0-100, as the directory reports it. */
  rating: number;
  numRatings: number;
  requiresWp: string | null;
  requiresPhp: string | null;
  testedUpTo: string | null;
  /** Directory-formatted, e.g. "2026-09-15 6:43am GMT". */
  lastUpdated: string | null;
  homepage: string | null;
  icon: string | null;
}

export interface ApiKeyDto {
  id: number;
  name: string;
  prefix: string;
  /** What the key may do (shared/access.ts); keys from before there were levels are Full. */
  access: AccessLevel;
  createdAt: number;
  lastUsedAt: number | null;
  /** Requests this key made in the last 24 hours (API activity log). */
  requests24h: number;
}

/** `denied` is 401/403 - the panel refusing, which reads differently from a 500. */
export type ApiEventOutcome = 'ok' | 'error' | 'denied';

/** One recorded API-key request. Session requests are never recorded. */
export interface ApiEventDto {
  id: number;
  ts: number;
  /** null when the token matched no live key - an unknown or revoked credential. */
  keyId: number | null;
  keyName: string;
  keyPrefix: string;
  method: string;
  path: string;
  /** Route pattern the path matched ('/api/sites/:slug'); null for a 404. */
  route: string | null;
  status: number;
  outcome: ApiEventOutcome;
  errorCode: string | null;
  durationMs: number;
  ip: string | null;
  userAgent: string | null;
  /** Job the call queued, so the row links straight to it. */
  jobId: number | null;
  /** 'mcp' when the MCP server made the call for one of its tools. */
  via: 'mcp' | null;
  /** The connected app behind an MCP call, when it was one rather than a key. */
  connectionId: number | null;
  /** The MCP tool that made the call. */
  tool: string | null;
}

/** An app connected over MCP through OAuth (Integrations -> MCP). */
export interface McpConnectionDto {
  id: number;
  /** The name the app registered with - its own claim, shown quoted. */
  app: string;
  /** Where its sign-in returned to: a website's host, `localhost:1234`, or an app's `cursor:`. */
  redirectHost: string;
  /** The admin who approved it. The app acts as itself, never as them. */
  approvedBy: { id: number; username: string };
  access: AccessLevel;
  createdAt: number;
  lastUsedAt: number | null;
}

/** The ten minutes after "Connect an app", in which one app may register and be approved. */
export interface McpWindowDto {
  until: number;
  /** Opened by the admin looking - only they can approve in it. */
  byMe: boolean;
  openedBy: string | null;
  /** The app that registered in it, once one has. */
  registered: { name: string; redirectHosts: string[] } | null;
}

/** `GET /api/mcp`: everything the MCP page shows. */
export interface McpPageDto {
  enabled: boolean;
  /** Why MCP cannot run on this install (no PANEL_DOMAIN, no TLS); null when it can. */
  unavailable: string | null;
  /** The server URL an app is given, when there is one. */
  url: string | null;
  window: McpWindowDto | null;
  connections: McpConnectionDto[];
  /** The newest requests MCP made into the API. */
  activity: ApiEventDto[];
}

/** `POST /api/oauth/authorize/check`: what the approval page shows before anyone clicks. */
export type OAuthCheckDto =
  | {
      status: 'ready';
      client: { name: string };
      /** Where the browser goes afterwards: shown first, because it is the part that cannot lie. */
      redirect: { kind: 'web' | 'loopback' | 'app'; host: string };
      /** The level the app asked for - information only; the admin's choice is what counts. */
      requested: AccessLevel | null;
    }
  /** No connection window of this admin's is open for this app. */
  | { status: 'closed'; reason: string }
  /** `returnTo`: where the error can be sent back to the app, once the admin clicks. */
  | { status: 'error'; message: string; returnTo: string | null };

export interface ApiActivityDto {
  items: ApiEventDto[];
  /** Rows matching the filter, not rows on the page. */
  total: number;
  last24h: { requests: number; errors: number; denied: number; keys: number };
  /** Current retention window, so the table can say what it is not showing. */
  retentionDays: number;
  /** Hard ceiling on stored rows, whatever the retention window says. */
  maxRows: number;
}

export interface WpPluginRow {
  name: string;
  status: string;
  version: string;
  update_version: string | null;
}

// ---------------------------------------------------------------------------
// WordPress inventory, known vulnerabilities and bulk management
//
// Everything here is read out of the per-site snapshot in SQLite (`site_wp_status`,
// `site_wp_components`) joined against the cached vulnerability feed - never out of a
// live `docker exec`. A fleet page over fifty sites cannot afford one wp-cli call per
// row, and the verdict has to change when the feed changes, not when a container is
// next reachable.

/** Severity as the feed reports it, normalised to words. */
export type VulnSeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

/**
 * How much the feed actually knows about a slug:
 * - `known`   — it is in wpvulnerability.net's database and the answer is current
 * - `unknown` — it answered, but has no record of this slug (premium plugin, custom code):
 *               "we have no data", which is emphatically not "this is clean"
 * - `pending` — not looked up yet (first scan, or the slug appeared since the last refresh)
 * - `stale`   — the cached answer is older than its TTL and the refresh has not run
 * - `error`   — the last lookup failed; the cached answer, if any, is what is shown
 * - `off`     — the feed is switched off in Settings, so nothing is checked at all
 */
export type FeedCoverage = 'known' | 'unknown' | 'pending' | 'stale' | 'error' | 'off';

export interface VulnerabilityDto {
  /** The feed's own uuid for the advisory; stable, so it can key a list. */
  id: string;
  title: string;
  severity: VulnSeverity;
  /** CVSS base score, 0-10; null when the advisory carries no scoring. */
  cvss: number | null;
  /** First release that carries the fix, when the advisory names one. */
  fixedIn: string | null;
  /** True = the feed says there is no fixed release yet. */
  unfixed: boolean;
  cves: string[];
  link: string | null;
  publishedAt: number | null;
  /**
   * 'unknown' = the advisory's version range could not be evaluated (missing or
   * unrecognised operator), so it is shown rather than hidden, flagged as unconfirmed.
   */
  versionMatch: 'match' | 'unknown';
}

/** Which of the four management actions this component will accept right now. */
export interface WpComponentActions {
  activate: boolean;
  deactivate: boolean;
  update: boolean;
  delete: boolean;
}

export interface WpComponentDto {
  kind: 'plugin' | 'theme';
  /** Directory slug - what wp-cli takes as an argument and what the feed keys on. */
  slug: string;
  title: string;
  /** plugin: active | inactive | must-use | dropin | active-network; theme: active | parent | inactive. */
  status: string;
  version: string;
  updateVersion: string | null;
  updateState: 'none' | 'available' | 'higher';
  autoUpdate: boolean;
  actionable: WpComponentActions;
  /** Why the refused actions are refused, ready to be a tooltip. */
  blockedReason: string | null;
  /**
   * True when this component is vulnerable AND the update on offer clears every advisory
   * that currently matches. False when there is nothing to fix, when no update is offered,
   * or - the case that matters - when the offered release is still inside an advisory's
   * affected range, so calling it a fix would be a lie.
   */
  updateFixes: boolean;
  vulnerabilities: VulnerabilityDto[];
  worstSeverity: VulnSeverity | null;
  /** Pulled from wordpress.org - it will never get another fix. */
  closedOnWporg: boolean;
  /** The directory's own reason slug, e.g. "security-issue" / "author-request". */
  closedReason: string | null;
  feedCoverage: FeedCoverage;
}

export interface WpCoreStatusDto {
  version: string | null;
  updateVersion: string | null;
  updateType: 'major' | 'minor' | null;
  vulnerabilities: VulnerabilityDto[];
  worstSeverity: VulnSeverity | null;
  feedCoverage: FeedCoverage;
}

export interface SiteWpStatusDto {
  siteSlug: string;
  /** null = never scanned. Everything else is empty in that case, not "nothing installed". */
  scannedAt: number | null;
  /** True when wp-cli had to be re-run with --skip-plugins, so update info is incomplete. */
  partial: boolean;
  scanError: string | null;
  core: WpCoreStatusDto;
  plugins: WpComponentDto[];
  themes: WpComponentDto[];
  counts: { updates: number; vulnerable: number; inactive: number; closed: number };
  feed: { enabled: boolean; refreshedAt: number | null };
}

/** One site's copy of a component, in the fleet table's expanded row. */
export interface WpInventorySiteRow {
  siteSlug: string;
  siteTitle: string;
  siteStatus: SiteStatus;
  /** `external`: hosted elsewhere; `serverName` then says "External". */
  siteKind: SiteKind;
  serverId: number;
  serverName: string;
  scannedAt: number | null;
  version: string;
  updateVersion: string | null;
  updateState: 'none' | 'available' | 'higher';
  status: string;
  autoUpdate: boolean;
  worstSeverity: VulnSeverity | null;
  vulnerabilities: VulnerabilityDto[];
  actionable: WpComponentActions;
  blockedReason: string | null;
}

/** One component slug across the whole fleet. */
export interface WpInventoryRow {
  kind: WpComponentKind;
  /** For `core` this is the version string, which is what the feed keys core on. */
  slug: string;
  title: string;
  sites: number;
  updates: number;
  vulnerable: number;
  inactive: number;
  /** Distinct installed versions, lowest first. */
  versions: string[];
  /** Highest available update across the fleet, when any site reports one. */
  updateVersion: string | null;
  worstSeverity: VulnSeverity | null;
  closedOnWporg: boolean;
  closedReason: string | null;
  feedCoverage: FeedCoverage;
  siteRows: WpInventorySiteRow[];
}

export interface WpInventoryDto {
  kind: WpComponentKind;
  rows: WpInventoryRow[];
  fleet: {
    /** Sites the filters considered (running ones unless `includeStopped`). */
    sites: number;
    scanned: number;
    neverScanned: number;
    sitesWithUpdates: number;
    sitesVulnerable: number;
    coreOutdated: number;
    lastScanAt: number | null;
  };
  feed: { enabled: boolean; refreshedAt: number | null };
  /** The queued/running fleet scan, so the page can show it without a second request. */
  scanJob: JobDto | null;
}

export interface BatchDto {
  id: number;
  kind: 'wp.bulk';
  action: WpBulkAction;
  options: { backupFirst: boolean; healthCheck: boolean };
  /** How many (site, component) operations the batch was asked to run. */
  targets: number;
  totalJobs: number;
  /** Sites left out because another job held their lane; retryable as-is. */
  skipped: { siteSlug: string; reason: string }[];
  counts: Record<JobStatus, number>;
  createdAt: number;
}

/** Outcome of one operation inside a `wp.bulkTask` job, as its result records it. */
export interface WpBulkOpResult {
  kind: WpComponentKind;
  slug: string | null;
  action: string;
  ok: boolean;
  from: string | null;
  to: string | null;
  error: string | null;
  /** A site hosted elsewhere stopped answering after the run, and WPL7 Connect put this back as it was. */
  rolledBack?: boolean;
}

export interface ServerStatsDto {
  load1: number;
  load5: number;
  load15: number;
  memTotal: number;
  memUsed: number;
  diskTotal: number;
  diskUsed: number;
}

export interface ServerHistoryDto {
  samples: (ServerStatsDto & { ts: number })[];
  since: number;
  until: number;
  bucketMs: number;
  sampleIntervalMs: number;
}

export interface ServerCheck {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * Working, but not the setup it should be - mail going out unsigned, say. Shown amber, and
   * unlike `ok: false` it does not count against the server as a whole.
   */
  warn?: boolean;
}

export interface ServerDto {
  id: number;
  name: string;
  kind: ServerKind;
  sshHost: string | null;
  sshPort: number;
  sshUser: string;
  hostKeySha256: string | null;
  publicIp: string;
  devDomain: string;
  dnsProvider: string;
  status: ServerStatus;
  lastSeenAt: number | null;
  lastError: string | null;
  sitesCount: number;
  createdAt: number;
}

/**
 * How a server's Traefik answers the DNS challenges behind the wildcard certificate, read off
 * its container: `file` = the panel's copy of the Cloudflare token; `env` = CF_DNS_API_TOKEN
 * from that server's deploy/.env (a stack started from a compose file older than Settings ->
 * DNS); `other` = another provider, credentials in that .env; `none` = no DNS resolver at all;
 * `stopped` = not running.
 */
export type TraefikDnsMode = 'file' | 'env' | 'other' | 'none' | 'stopped';

/** One server in Settings -> DNS. */
export interface DnsServerDto {
  id: number;
  name: string;
  devDomain: string;
  status: ServerStatus;
  /** The server's setting: non-empty = its dev sites share one wildcard certificate, from this provider. */
  dnsProvider: string;
  /** What new dev sites there actually get: '' when the setting names Cloudflare and there is no token. */
  wildcardProvider: string;
  /** Its Traefik and the panel's token, as last checked. */
  traefik: {
    state: 'ok' | 'error' | 'unknown';
    mode: TraefikDnsMode | null;
    /** The provider its DNS resolver is started with. */
    provider: string | null;
    /** `env` only: whether that .env holds a token at all. */
    envToken: boolean;
    /** Traefik was restarted to read a changed token. */
    restartedAt: number | null;
    checkedAt: number | null;
    message: string | null;
  };
}

export interface DnsStatusDto {
  /** The provider the panel writes records with. */
  provider: 'cloudflare';
  token: {
    configured: boolean;
    setAt: number | null;
    /** deploy/.env holds a CF_DNS_API_TOKEN that is not this one: read once, on first boot, and not since. */
    envDiffers: boolean;
  };
  /** Where `*.<dev domain>` points; sites on other servers get a record of their own. */
  wildcardServerId: number;
  servers: DnsServerDto[];
}

/** What Settings -> DNS -> Check found a token reaches. */
export interface DnsTokenCheckDto {
  /** Cloudflare took the token and it reads at least one zone. */
  ok: boolean;
  /** What Cloudflare said when it refused the token, or why it could not be reached. */
  error: string | null;
  /** The zones it can read, at most the first 50. */
  zones: string[];
  zoneCount: number;
  /** Every dev domain the fleet uses, with the zone it is in and whether the token reads its records. */
  devDomains: {
    domain: string;
    servers: string[];
    zone: string | null;
    records: 'readable' | 'refused' | null;
    detail: string | null;
  }[];
}

/** One filesystem the server has mounted, offered as a quick pick in the Storage form. */
export interface MountOption {
  target: string;
  source: string;
  fstype: string;
  totalBytes: number;
  freeBytes: number;
  /** `<target>/backups` — what clicking the quick pick fills in. */
  suggested: string;
}

/** Where one server keeps its backups, and whether that location actually works. */
export interface ServerStorageDto {
  serverId: number;
  serverName: string;
  kind: ServerKind;
  /** The location in force (or the candidate being validated). */
  backupRoot: string;
  defaultRoot: string;
  isDefault: boolean;
  exists: boolean;
  writable: boolean;
  /**
   * Server 1 only: whether the path is mounted into the panel container. A path the host
   * has and the container has not is legal, and unusable until compose says otherwise.
   */
  visibleInPanel: boolean;
  /** One sentence naming what stands in the way; null when the location is usable. */
  reason: string | null;
  /** Set when `visibleInPanel` is false: the exact .env line and command to run. */
  mountInstructions: { envLine: string; command: string } | null;
  /** The filesystem the location sits on. */
  disk: MountOption | null;
  /** Backups this server already keeps at this location. */
  backups: { count: number; bytes: number };
  mounts: MountOption[];
  /** False = the server could not be asked (unreachable, or no host SSH). */
  discovered: boolean;
  discoveryError: string | null;
}

/**
 * What a server says about itself. Everything is nullable: an old kernel without
 * `/etc/os-release`, a container-less `nproc`, a host with no Docker CLI on PATH - none of
 * those make the rest of the reading worthless, so each field is missing on its own.
 */
export interface ServerSystemInfoDto {
  serverId: number;
  /** False = the server could not be asked at all; `error` says why. */
  reachable: boolean;
  error: string | null;
  os: string | null;
  kernel: string | null;
  arch: string | null;
  hostname: string | null;
  cpuModel: string | null;
  cpus: number | null;
  memTotalBytes: number | null;
  /** Seconds since the machine booted. */
  uptimeSeconds: number | null;
  dockerVersion: string | null;
  /** When the reading was taken; it is cached for a minute on the server. */
  readAt: number;
}

/** Per-server stats row in the monitor overview. */
export interface ServerMonitorDto extends ServerStatsDto {
  serverId: number;
  name: string;
  status: ServerStatus;
}

// ---------------------------------------------------------------------------
// Visitor statistics

export interface SiteTrafficPoint {
  /** Start of the bucket (hour or day, per `SiteTrafficDto.bucket`). */
  ts: number;
  /** Everything Traefik routed to the site, crawlers included. */
  requests: number;
  /** Requests for a page (not an asset, not wp-admin) that a non-crawler made. */
  pageViews: number;
  /** Distinct people in this bucket. Never comparable across buckets — see the DTO. */
  visitors: number;
  botRequests: number;
  /** Responses with a 5xx status. */
  errors: number;
  bytes: number;
  /** Mean response time across `requests`; null when the bucket is empty. */
  avgMs: number | null;
}

export interface SiteTrafficDto {
  days: number;
  bucket: 'hour' | 'day';
  since: number;
  /**
   * False when this site's server has never emitted an access-log line — which is how a
   * genuinely quiet site is told apart from a stack deployed before access logging existed
   * and never redeployed since.
   */
  collecting: boolean;
  totals: {
    requests: number;
    pageViews: number;
    /**
     * Daily unique visitors added up over the range. Visitors are identified by a hash
     * under a salt that is discarded every night, so somebody who came on two days is two
     * ids on purpose and cannot be deduplicated across them.
     */
    visitors: number;
    botRequests: number;
    errors: number;
    bytes: number;
    avgMs: number | null;
  };
  series: SiteTrafficPoint[];
  topPages: { path: string; views: number }[];
  /** Referring hosts; the direct/unknown bucket is left out. */
  topReferrers: { referrer: string; views: number }[];
  /**
   * Distinct visitors per ISO 3166-1 alpha-2 country. Addresses that resolve to no
   * registry delegation are left out rather than shown as a nameless bar.
   */
  topCountries: { country: string; visitors: number }[];
  /** Crawlers by request count, version stripped so one bot is one row. */
  topCrawlers: { crawler: string; requests: number; lastSeenAt: number }[];
  /** Busiest client addresses. Empty when address collection is switched off. */
  topIps: {
    ip: string;
    requests: number;
    pageViews: number;
    botRequests: number;
    errors: number;
    country: string | null;
    lastSeenAt: number;
  }[];
  /** False = the panel is not writing addresses down (`trafficStoreIps`). */
  ipsCollected: boolean;
  /** How long addresses are kept - deliberately shorter than the anonymous rollups. */
  ipRetentionDays: number;
  /** False = the country table has not been downloaded yet, so countries are empty. */
  countryData: boolean;
}

export interface SiteMonitorDto {
  slug: string;
  serverId: number;
  up: boolean | null;
  /** Status code behind `up`; `null` = nothing answered at all (refused, timed out). */
  httpStatus: number | null;
  httpMs: number | null;
  lastCheckedAt: number | null;
  cpuPct: number | null;
  memBytes: number | null;
  diskBytes: number | null;
}

// ---------------------------------------------------------------------------
// Mail

/** Result of one deliverability lookup (SPF, DKIM, DMARC or reverse DNS). */
export interface MailRecordCheck {
  verdict: 'ok' | 'warn' | 'missing' | 'error';
  found: string | null;
  detail: string;
}

export interface MailServerStatusDto {
  serverId: number;
  serverName: string;
  ok: boolean;
  relayRunning: boolean;
  dkimRunning: boolean;
  mode: 'smarthost' | 'direct';
  /** Name postfix announces in HELO/EHLO; reverse DNS should match it. */
  hostname: string;
  relayhost: string;
  queued: number;
  deferred: number;
  signedDomains: number;
  checks: ServerCheck[];
}

export interface MailMessageDto {
  id: number;
  serverId: number;
  serverName: string;
  queueId: string;
  /** Sending site, taken from the connecting container rather than the From: header. */
  siteSlug: string | null;
  from: string;
  to: string;
  status: MailStatusName;
  sizeBytes: number | null;
  relay: string | null;
  dsn: string | null;
  delayMs: number | null;
  detail: string | null;
  /** null = no signing verdict was logged for this message. */
  dkimSigned: boolean | null;
  dkimDomain: string | null;
  firstSeenAt: number;
  lastEventAt: number;
}

export interface MailQueueDto {
  serverId: number;
  serverName: string;
  queueId: string;
  /** 'incoming' | 'active' | 'deferred' | 'hold' */
  queueName: string;
  arrivalTime: number;
  sizeBytes: number;
  sender: string;
  recipients: { address: string; reason: string | null }[];
  siteSlug: string | null;
}

export interface MailSiteStatsDto {
  siteSlug: string;
  sent: number;
  failed: number;
  total: number;
  uniqueRecipients: number;
  lastAt: number;
  /** Volume past the configured per-site budget for the window. */
  overBudget: boolean;
  /** Enough failures that the recipient list looks scraped rather than real. */
  highFailureRate: boolean;
  /** The relay is currently refusing this site's mail (abuse guard or an operator). */
  mailSuspended: boolean;
}

export interface MailStatsDto {
  hours: number;
  total: number;
  byStatus: Record<MailStatusName, number>;
  perHour: { ts: number; sent: number; failed: number }[];
  topSites: MailSiteStatsDto[];
  topRecipientDomains: { domain: string; count: number }[];
  perSiteHourlyBudget: number;
}

export interface MailDkimKeyDto {
  domain: string;
  selector: string;
  /** Hostname the TXT record is published under. */
  recordName: string;
  recordValue: string;
  /** Same record pre-split into 255-character strings, for BIND-style zone files. */
  recordBind: string;
  createdAt: number;
  rotatedAt: number | null;
}

export interface MailDomainDto {
  domain: string;
  sites: string[];
  dkim: MailRecordCheck;
  spf: MailRecordCheck;
  dmarc: MailRecordCheck;
  dkimKey: MailDkimKeyDto | null;
  suggestedSpf: string;
  suggestedDmarc: string;
  /** Ordered setup for this domain, with what the panel could publish for each step. */
  steps: MailSetupStep[];
  /** True once every step is satisfied. */
  ready: boolean;
}

/** Whether the panel can publish a record itself, and what doing so would change. */
export interface MailStepAutomation {
  /**
   * 'ready'     — the panel can write this record now
   * 'satisfied' — nothing to do
   * 'manual'    — has to be added by hand (no DNS API, or not safe to automate)
   * 'blocked'   — something must be fixed first
   */
  state: 'ready' | 'satisfied' | 'manual' | 'blocked';
  /** The value that would be written; for SPF this is the merged record, not just ours. */
  plannedValue: string | null;
  detail: string;
}

export interface MailSetupStep {
  id: 'spf' | 'dkim' | 'dmarc';
  title: string;
  /** One sentence on what breaks without it. */
  why: string;
  record: { type: 'TXT'; name: string; value: string };
  /** Live state of the record as published right now. */
  status: MailRecordCheck;
  automation: MailStepAutomation;
}

/** Outcome of one automated publish. */
export interface MailPublishResult {
  step: 'spf' | 'dkim' | 'dmarc';
  outcome: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';
  detail: string;
}

/** Everything the per-server half of the setup guide needs. */
export interface MailServerSetupDto {
  serverId: number;
  name: string;
  ip: string;
  /** Name postfix announces in HELO; both the A record and the PTR should point at it. */
  hostname: string;
  /**
   * What it announces without an override: MAIL_HOSTNAME in deploy/.env, as this server's
   * relay was created with it. Null when the relay cannot say (it is not running).
   */
  defaultHostname: string | null;
  /** The name set in the panel, which wins over the default; null when there is none. */
  hostnameOverride: string | null;
  mode: 'smarthost' | 'direct';
  /** Does the mail hostname resolve to this server? */
  hostnameA: MailRecordCheck;
  reverseDns: MailRecordCheck;
  /** Direct mode only: whether outbound port 25 is open. */
  port25: { ok: boolean; detail: string } | null;
  /** The panel can write the hostname A record itself when the zone is in its DNS account. */
  hostnameAutomatable: boolean;
}

export interface MailSetupDto {
  mode: 'smarthost' | 'direct';
  dns: {
    /** A DNS provider token is configured, so automated publishing is possible at all. */
    configured: boolean;
    provider: string;
    /** What to set to turn automation on, when it is off. */
    hint: string;
  };
  servers: MailServerSetupDto[];
  /** Per-provider reverse-DNS instructions; rDNS cannot be set through a DNS API. */
  rdnsGuides: { id: string; name: string; steps: string[] }[];
  domains: MailDomainDto[];
}

export interface MailOverviewDto {
  servers: MailServerStatusDto[];
  reverseDns: { serverId: number; name: string; ip: string; check: MailRecordCheck }[];
  mode: 'smarthost' | 'direct';
}

export interface MetaDto {
  phpVersions: string[];
  defaultPhpVersion: string;
  defaultLocale: string;
  /** What the New Site wizard's admin email starts as; '' = none set, the field starts empty. */
  defaultAdminEmail: string;
  /** Every language WordPress offers, for the language pickers. */
  locales: WpLocale[];
  devDomain: string;
  /** Hostname the panel itself answers on; '' when it was never configured. */
  panelDomain: string;
  tlsMode: 'letsencrypt' | 'staging' | 'none';
  mailMode: 'smarthost' | 'direct';
  /** Stamped into the image at build time; `<package version>-dev` outside one. */
  version: string;
  /** Short commit the image was built from, or `unknown` outside an image. */
  gitSha: string;
  /** IANA zone of the panel process - the clock cron schedules run on. */
  timezone: string;
  /**
   * The backup schedule, so a page that talks about it can say what it actually is. It is
   * editable (Settings), so nothing in the UI may assume it is nightly.
   */
  backupCron: string;
  /** The scheduled backup run is paused on the Schedules page: `backupCron` is not running. */
  backupsPaused: boolean;
  /** Where each server keeps its backups, so a page can say so without a second call. */
  backupRoots: { serverId: number; serverName: string; root: string; isDefault: boolean; backups: number }[];
  /** True once at least one offsite destination exists; gates the offsite UI. */
  offsiteConfigured: boolean;
  servers: { id: number; name: string; devDomain: string; status: ServerStatus }[];
  defaultServerId: number;
  /** More than one server registered — UI shows server pickers / move actions. */
  multiServer: boolean;
  /** Panel can manage DNS records via the provider API. */
  dnsManaged: boolean;
  /** Which releases this install follows. */
  channel: 'stable' | 'edge';
  /** A newer version exists on that channel, as of the last successful check. */
  updateAvailable: boolean;
  /** Set while an update is in flight: every page shows a banner and writes are refused. */
  maintenance: { reason: string; since: number } | null;
  /** The repository this install follows - a fork's own - whose issues the Support page links. */
  repoUrl: string;
  /** This project's community, or empty when the install points at none. */
  communityUrl: string;
}

/** A release this install could move to. */
export interface UpdateReleaseDto {
  version: string;
  channel: 'stable' | 'edge';
  /** ISO 8601, as published. */
  publishedAt: string;
  notesUrl: string;
  /** Sites may be unreachable while it applies (a MariaDB major bump, say). */
  requiresDowntime: boolean;
  /** Oldest version it can be applied to directly; null when it says nothing. */
  minUpgradeFrom: string | null;
}

/** `state.json`, exactly as provision/update.sh writes it. */
export interface UpdateStateDto {
  id: string;
  from: string;
  to: string;
  channel: string;
  phase: 'fetching' | 'preflight' | 'switching' | 'healthcheck' | 'switched' | 'failed';
  rolledBack: boolean | null;
  startedAt: string;
  finishedAt: string | null;
  /** Things the operator should know but that do not stop the update. */
  warnings: string[];
  error: string | null;
  /** Panel container log from the moment it failed; empty otherwise. */
  logTail: string[];
  pid: number | null;
}

/** One per-version step the panel ran for itself after an update. */
export interface UpdateStepDto {
  key: string;
  title: string;
  outcome: 'done' | 'failed';
  detail: string;
}

export interface UpdateHistoryDto {
  id: string;
  fromVersion: string;
  toVersion: string;
  startedAt: number;
  finishedAt: number | null;
  /** `failed` here means the follow-up failed, never the update itself. */
  status: 'running' | 'done' | 'failed';
  steps: UpdateStepDto[];
}

export interface UpdateStatusDto {
  /** systemd says the unit is active. False once it has switched or failed. */
  running: boolean;
  /** Set while an update is in flight: the worker stops claiming jobs and writes are refused. */
  maintenance: { reason: string; since: number } | null;
  /** Null until an update has run on this install at least once. */
  state: UpdateStateDto | null;
  log: string[];
  /** What the panel did for itself after each update, newest first. */
  history: UpdateHistoryDto[];
}

export interface SystemVersionDto {
  version: string;
  gitSha: string;
  channel: 'stable' | 'edge';
  /** `image` = this box pulls the released panel; `build` = it compiles its own. */
  source: 'image' | 'build';
  latest: UpdateReleaseDto | null;
  updateAvailable: boolean;
  /** Last check that reached GitHub, or null if none ever has. */
  checkedAt: number | null;
  /**
   * Why the last attempt failed. A checker that could not ask must not be confused with one
   * that asked and found nothing, so this is its own field and the UI has three states.
   */
  error: string | null;
  nextCheckAt: number | null;
}

/**
 * What the About page says about this install: where its code comes from, and what it is
 * running on. Deliberately not part of `/api/meta`, which every page loads on mount - this
 * one asks the host a question and may do a DNS lookup.
 */
export interface SystemAboutDto {
  /** The repository this install follows. A fork's own, not necessarily upstream's. */
  repoUrl: string;
  /** The machine the panel itself runs on - server 1, read exactly as the server page reads it. */
  host: ServerSystemInfoDto;
  /** The address this install answers on, or null when nothing has ever established one. */
  publicIp: string | null;
  /**
   * What DNS calls that address. Null is an ordinary answer, not a failure: most hosts leave
   * the PTR unset, and only mail delivery minds (Mail -> Setup is where it is a verdict).
   */
  reverseDns: string | null;
  /** This project's community, or empty when the install points at none. */
  communityUrl: string;
  /** Where the panel itself is served, when it has a domain rather than an address. */
  panelDomain: string;
  /** The Node this panel process runs on, and how long this process has been up. */
  node: string;
  panelUptimeSeconds: number;
}

export interface TwoFactorStatusDto {
  enabled: boolean;
  /** When the authenticator was enrolled; null while 2FA is off. */
  confirmedAt: number | null;
  /** Recovery codes not yet spent, out of the ten issued. */
  recoveryCodesLeft: number;
}

/** One admin account. There are no roles: the owner differs only in who may change it. */
export interface PanelUserDto {
  id: number;
  username: string;
  /** The first admin, created at setup. Nobody else may change their account or delete it. */
  isOwner: boolean;
  /** Where "Forgot your password?" sends its link - always a confirmed address; null = none. */
  email: string | null;
  /** An address waiting for its confirmation link to be followed, until that link expires. */
  pendingEmail: string | null;
  twoFactor: TwoFactorStatusDto;
  createdAt: number;
  /** The last completed sign-in; null for an account that has never been used. */
  lastLoginAt: number | null;
}

export interface MeDto {
  /** The signed-in admin; null for an API key, which belongs to no one account. */
  user: PanelUserDto | null;
  authVia: 'session' | 'apiKey' | 'mcp' | null;
}

/** What `POST /users/:id/totp/setup` hands the enrolment screen. Never stored by the browser. */
export interface TwoFactorEnrollmentDto {
  /** Base32, for the people who type it in instead of scanning. */
  secret: string;
  otpauthUrl: string;
  /** `data:image/svg+xml;base64,…` — goes straight into an `<img src>`. */
  qrDataUrl: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Web-terminal wire protocol (GET /api/servers/:id/terminal, WebSocket):
 * binary frames carry raw terminal bytes in both directions; text frames carry
 * one JSON control message. Unknown/malformed control messages are ignored.
 */
export type TerminalClientMsg = { t: 'resize'; cols: number; rows: number };

export type TerminalServerMsg =
  | { t: 'status'; message: string }
  | { t: 'ready' }
  | { t: 'exit'; code: number | null }
  | { t: 'error'; message: string };

// ---------------------------------------------------------------------------
// Plugin recipes and license keys (shared/recipes.ts, docs/licenses.md)

/**
 * What the last recipe run concluded for one plugin on one site. `unknown` is the UI's
 * word for "never run here"; the others are recorded by the panel. `not-set-up`: an input
 * of the recipe has no value yet, so nothing ran.
 */
export type LicenseStatus = 'active' | 'failed' | 'inactive' | 'not-set-up' | 'released' | 'unknown';

/** One of a recipe's inputs, with what is stored for it. */
export interface RecipeInputDto {
  id: string;
  label: string;
  hint: string | null;
  /** Write-only: `display` carries the last characters, never the value. */
  secret: boolean;
  /** PHP constant the panel defines with the value on every site running the plugin, if any. */
  constant: string | null;
  set: boolean;
  /** The value itself for an input that is not secret, the masked tail of a secret one; null when unset. */
  display: string | null;
  updatedAt: number | null;
}

export interface RecipeDto {
  id: string;
  name: string;
  /** Plugin directory the recipe applies to, as `wp plugin list` names it. */
  plugin: string;
  version: string | null;
  /** The recipe's own sentence, or one the panel derives from its hooks when it has none. */
  description: string;
  vendorUrl: string | null;
  /** Where the copy in use comes from. A local recipe is the operator's own and never follows the catalog. */
  source: 'local' | 'catalog' | 'bundled';
  /** Chosen by the operator; only installed and enabled recipes run on sites. */
  installed: boolean;
  enabled: boolean;
  /** When the recipe in use last changed: the catalog fetch that changed it, or the local edit. */
  changedAt: number | null;
  /** Sites whose last inventory has the plugin - what makes a recipe relevant to this panel. */
  sites: number;
  /** The panel's own plugin catalog has an entry that installs into that folder (a zip: the folder inside it). */
  inPluginCatalog: boolean;
  /** What the operator enters for the recipe - one field each on the Recipes page. */
  inputs: RecipeInputDto[];
  /** Steps per hook, so the UI can say what the recipe does without listing them. */
  hooks: Record<RecipeHook, number>;
}

export interface SiteLicenseDto {
  recipeId: string;
  name: string;
  plugin: string;
  /** The plugin is in the site's last inventory snapshot. */
  installed: boolean;
  /** 'active' | 'inactive' | … as the snapshot has it; null when not installed. */
  pluginStatus: string | null;
  /** Every input of the recipe has a value, so it can run. */
  ready: boolean;
  status: LicenseStatus;
  message: string | null;
  /** Site URL the last successful run activated for. */
  url: string | null;
  checkedAt: number | null;
}

/** The public catalog as this panel sees it (docs/licenses.md, "The catalog"). */
export interface CatalogStateDto {
  /** null = fetching is off (WPL7_CATALOG_URL=off); bundled recipes only. */
  url: string | null;
  /** Entries in the last verified copy, and how many of them this panel version cannot use. */
  entries: number;
  unsupported: number;
  /** When the catalog itself was generated, as it states. */
  generatedAt: string | null;
  commit: string | null;
  fetchedAt: number | null;
  /** When the content last changed hands (an entry added, changed or removed). */
  changedAt: number | null;
  /** The last fetch's failure, or null when it succeeded; the previous copy stays in use. */
  error: string | null;
  keyId: string | null;
  /** Recipes known to this panel, by where their copy comes from. */
  recipes: { local: number; catalog: number; bundled: number };
}

// ---------------------------------------------------------------------------
// Files (Web FTP). Paths are relative to the site's WordPress folder - see
// shared/siteFilePath.ts.

export type SiteFileType = 'file' | 'dir' | 'link' | 'other';

export interface SiteFileEntryDto {
  name: string;
  /**
   * False when the name on disk is not valid UTF-8. It is listed (with replacement
   * characters) but cannot be addressed through the API, which speaks UTF-8.
   */
  nameOk: boolean;
  type: SiteFileType;
  /** Links only: what the link says it points at, verbatim - for display, never followed by the panel. */
  target: string | null;
  /** Links only: what the target is, or null when it does not exist (a dangling link). */
  targetType: SiteFileType | null;
  /** Bytes. For a link, the length of the link itself. */
  size: number;
  mtimeMs: number;
  /** Permission bits in octal, e.g. "644"; four digits when a special bit is set ("2775"). */
  mode: string;
  uid: number;
  gid: number;
  /** For the site's own user (www-data), which is who every file operation runs as. */
  readable: boolean;
  writable: boolean;
}

export interface SiteDirListingDto {
  path: string;
  /** Whether the site's user may create, rename and delete entries in this folder. */
  writable: boolean;
  entries: SiteFileEntryDto[];
  /** The folder holds more than FILE_LIMITS.listEntries entries; only that many are listed. */
  truncated: boolean;
}

export interface SiteFileWrittenDto {
  path: string;
  entry: SiteFileEntryDto;
  /** The new content's SHA-256: send it as `If-Match` on the next save. Null when not computed (uploads). */
  etag: string | null;
}

export interface SiteUploadChunkDto {
  /** Bytes received so far; the next chunk's `offset`. */
  received: number;
  /** Set by the chunk that completed the file: it is in place now. */
  written: SiteFileWrittenDto | null;
}

export interface SiteFileSearchMatchDto {
  path: string;
  /** Name searches: what the match is. */
  type?: SiteFileType;
  /** Content searches: the 1-based line, and the line itself (cut at 500 characters). */
  line?: number;
  text?: string;
}

export interface SiteFileSearchDto {
  mode: 'name' | 'content';
  /** The folder that was searched. */
  path: string;
  matches: SiteFileSearchMatchDto[];
  /** More matches than FILE_LIMITS.searchResults; only the first are listed. */
  truncated: boolean;
  /** The search ran out of time (45 s); the matches are what it found until then. */
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// FTP & SFTP logins (services/ftp.ts). A login belongs to one site and reaches only that
// site's files; each server runs a gateway for the logins of the sites it hosts.

/**
 * - `off`: nothing FTP runs on the server (no logins there, or FTP is switched off)
 * - `starting`: the gateway or a file server is being set up
 * - `ready`: everything the logins need is running
 * - `error`: something is not (the message says what)
 * - `unreachable`: the panel cannot reach the server; changes wait for it
 */
export type FtpServiceState = 'off' | 'starting' | 'ready' | 'error' | 'unreachable';

export interface FtpStatusDto {
  state: FtpServiceState;
  message: string | null;
  /**
   * When the look that found this state started; null = the panel has not finished one since it
   * started. `off` with a date is confirmed: FTP was found gone from the server, or taken off it.
   */
  checkedAt: number | null;
}

/** Where and how a client connects to one server's gateway. */
export interface FtpEndpointDto {
  /**
   * The server's public IPv4, which always works. Any hostname that points straight at it
   * does too - but not one behind a proxy such as Cloudflare's, which passes web traffic only.
   */
  host: string | null;
  sftp: {
    port: number;
    /** What SFTP clients show on first connect; empty until the gateway was first set up. */
    hostKeys: { type: string; fingerprint: string }[];
  };
  ftp: {
    /** False when FTP is switched off, or the server has no public IPv4 for passive mode. */
    available: boolean;
    reason: string | null;
    port: number;
    passivePorts: { start: number; end: number };
    /** SHA-256 of the gateway's self-signed certificate, which FTP clients ask to trust once. */
    certFingerprint: string | null;
  };
}

export interface SiteFtpUserDto {
  id: number;
  username: string;
  /** Site-relative folder the login is kept inside; '' = the whole site. */
  folder: string;
  expiresAt: number | null;
  expired: boolean;
  createdBy: string | null;
  passwordSetAt: number;
  createdAt: number;
}

export interface SiteFtpDto {
  /** The fleet-wide switch (Settings -> Sites -> FTP & SFTP). */
  enabled: boolean;
  serverId: number;
  serverName: string;
  endpoint: FtpEndpointDto;
  status: FtpStatusDto;
  /** False while the latest change to this site's logins has not reached its server yet. */
  applied: boolean;
  /** A restore, move or delete has this site's FTP stopped until it ends. */
  paused: boolean;
  users: SiteFtpUserDto[];
}

export interface FtpServerStatusDto {
  serverId: number;
  enabled: boolean;
  endpoint: FtpEndpointDto;
  status: FtpStatusDto;
  /** Sites on this server with at least one login, and how many logins they have. */
  sites: number;
  logins: number;
  /** The logins that have not expired: what the gateway serves. None left means nothing runs. */
  activeLogins: number;
}

/** A login as created, or after a password reset: the password is in here once, never again. */
export interface SiteFtpUserCreatedDto {
  user: SiteFtpUserDto;
  /** Only when the panel generated it. */
  password: string | null;
}

// ---------------------------------------------------------------------------
// Security: blocked addresses

/** What the detector saw when it blocked (or would have blocked) an address. */
export interface SecurityBlockEvidence {
  /** Events counted towards the rule, in its window. */
  count: number;
  threshold: number;
  windowMin: number;
  /** Sites the address was seen on (slugs), most first. */
  sites: string[];
  /** A few of the paths it asked for. */
  samplePaths: string[];
  userAgent: string | null;
  /** The trusted proxy it came through, when it did. */
  via: string | null;
}

export interface SecurityBlockDto {
  id: number;
  /** An address, or a range: an IPv6 visitor is blocked by its /64. */
  address: string;
  family: 4 | 6;
  /** 'detector' | 'manual' | 'api'. */
  source: string;
  rule: DetectionRuleId | null;
  reason: string;
  evidence: SecurityBlockEvidence | null;
  siteSlug: string | null;
  serverName: string | null;
  country: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
  /** null = until lifted. */
  expiresAt: number | null;
  endedAt: number | null;
  endReason: BlockEndReason | null;
  endedBy: string | null;
  strike: number;
  /** Requests the HTTP layer blocked; the network layer drops without counting. */
  hits: number;
  lastHitAt: number | null;
  /** In force right now. */
  active: boolean;
}

export interface SecurityBlockListDto {
  items: SecurityBlockDto[];
  total: number;
  activeCount: number;
  maxActive: number;
}

export interface NeverBlockDto {
  id: number;
  address: string;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
}

export interface AdminAddressDto {
  address: string;
  username: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** One thing the detector decided, kept for the Detection tab. */
export interface SecurityDecisionDto {
  at: number;
  address: string;
  rule: DetectionRuleId;
  /** 'blocked', 'observed' (observe mode), or 'skipped' with the reason. */
  action: 'blocked' | 'observed' | 'skipped';
  reason: string;
  count: number;
  sites: string[];
  blockId: number | null;
}

export interface SecurityDetectionDto {
  mode: AutoBlockMode;
  /** Addresses being watched right now, and how many the memory holds at most. */
  tracked: number;
  maxTracked: number;
  decisions: SecurityDecisionDto[];
}

/** Why an address could not be blocked, or null. */
export interface SecurityCheckDto {
  address: string;
  valid: boolean;
  problem: string | null;
  protectedBecause: string | null;
  blockedBy: SecurityBlockDto | null;
  country: string | null;
}

/** A request a site's protection blocked. */
export interface BlockedRequestDto {
  ts: number;
  /** `files`, `limit-login`, `block-<id>`, `blocked-address`... */
  rule: string;
  /** null while addresses are not stored (Settings -> Monitoring -> Visitor statistics). */
  ip: string | null;
  country: string | null;
  via: string | null;
  method: string;
  path: string;
  status: number;
  siteSlug: string | null;
}

/**
 * Where a server stands with blocked addresses. `ok`: the network layer is loaded. `http-only`:
 * it could not be loaded, and Traefik refuses direct visitors instead (at most 2,000).
 * `off`: switched off on the server itself (`wpl7-firewall off`). `not-installed`: the server
 * has not been set up again since Security arrived (provision/setup.sh installs the helper).
 */
export type FirewallState = 'ok' | 'http-only' | 'off' | 'not-installed' | 'unreachable' | 'error' | 'unknown';

export interface FirewallServerDto {
  serverId: number;
  serverName: string;
  state: FirewallState;
  message: string | null;
  checkedAt: number | null;
  /** When the network layer was last loaded there. */
  appliedAt: number | null;
  /** Blocks in the network layer. */
  networkEntries: number;
  /** Blocks matched behind trusted proxies, and refused to direct visitors by Traefik. */
  httpProxied: number;
  httpDirect: number;
  /** Left out of the HTTP layer: past its ceilings, or a range a header cannot be matched against. */
  httpSkipped: number;
}

export interface FirewallOverviewDto {
  /** false = no block reaches any server (Settings: enforcement off). */
  enforced: boolean;
  activeBlocks: number;
  servers: FirewallServerDto[];
}

// ---------------------------------------------------------------------------
// Security: site protection and malware scans

/** Whether a site's rules are in force on its server, and if not, why (the banner on its tab). */
export interface ProtectionStatusDto {
  applied: boolean;
  unprotected: string | null;
  writtenAt: number | null;
}

/** A rule of the site's that Traefik would not use; the rest of its rules keep working. */
export interface RuleRejectionDto {
  router: string;
  message: string;
  at: number;
}

export interface ScanDto {
  id: number;
  /** 'schedule' | 'manual' | 'rescan' | 'import'. */
  trigger: string;
  status: ScanOutcome;
  startedAt: number;
  finishedAt: number | null;
  /** Every file the check walked. */
  filesScanned: number | null;
  findingsTotal: number | null;
  findingsNew: number | null;
  /** `core`, `plugin:<slug>`, `theme:<slug>` with no published checksums to hold them to. */
  noChecksums: string[];
  /** Why it is incomplete, failed or superseded. */
  error: string | null;
  /** What each engine did: its state, what it read, how long it took. */
  engines: Record<string, unknown>;
  /** Files the scanner could only partly read - too large - that nothing vouched for. */
  partlyScanned: { count: number; files: { path: string; bytes: number | null }[] };
  jobId: number | null;
}

export interface SiteScanDto {
  /** The site's own setting; null = the fleet's. */
  enabled: boolean | null;
  onFinding: ScanOnFinding | null;
  /** What is in force. */
  effective: { enabled: boolean; onFinding: ScanOnFinding; signatures: boolean };
  /** The default's, which a null above follows. */
  defaults: { enabled: boolean; onFinding: ScanOnFinding };
  last: ScanDto | null;
  /** A scan queued or running for this site. */
  active: { jobId: number; status: JobStatus } | null;
  /** When the schedule will queue the next one; null while scans are off for the site. */
  nextDueAt: number | null;
  requestedAt: number | null;
  openFindings: number;
  openConfirmed: number;
  quarantined: number;
  /** Failed scans in a row. */
  failures: number;
}

export interface SiteSecurityDto {
  slug: string;
  /** The site's own level; null = it follows the default. */
  level: SecurityLevel | null;
  overrides: SecurityOverrides;
  customRules: CustomRule[];
  /** What is in force: the level, every rule and limit, and where each came from. */
  policy: EffectivePolicy;
  fleet: FleetSecurity;
  status: ProtectionStatusDto;
  rejections: RuleRejectionDto[];
  /** Requests blocked in the last seven days, per rule (`files`, `limit-login`, `block-<id>`...). */
  blocked7d: Record<string, number>;
  scan: SiteScanDto;
}

export interface FindingDto {
  id: number;
  engine: 'check' | 'signatures';
  kind: FindingKind;
  confidence: FindingConfidence;
  severity: FindingSeverity;
  /** Relative to the site's WordPress folder. */
  path: string;
  line: number | null;
  rule: string | null;
  detail: string | null;
  /** `core`, `plugin:<slug>`: the package it belongs to. */
  package: string | null;
  packageVersion: string | null;
  sha256: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  status: FindingStatus;
  statusAt: number | null;
  statusBy: string | null;
  /** A package's file, changed or missing: Reinstall original puts it right. */
  canReinstall: boolean;
  /** WPL7's own file, changed: Put back writes the panel's version again. */
  canPutBack: boolean;
  /** Why it cannot be moved to quarantine by hand; null when it can. */
  quarantineProblem: string | null;
  /**
   * A catalog zip's check flagged the same file and nobody has reviewed it: one review on the
   * Plugins page vouches for every site's unchanged copy.
   */
  zipReview: { pluginId: number; name: string; version: string | null } | null;
}

export interface QuarantineItemDto {
  id: number;
  path: string;
  sizeBytes: number | null;
  sha256: string;
  reason: string | null;
  movedAt: number;
  movedBy: string;
  state: 'kept' | 'restored' | 'deleted';
  restoredAt: number | null;
  restoredBy: string | null;
  deletedAt: number | null;
  deletedBy: string | null;
}

/** One row of Sites -> Security. */
export interface SecuritySiteRowDto {
  slug: string;
  title: string;
  status: string;
  serverName: string | null;
  level: SecurityLevel;
  /** The site chose its own level, rules, limits or custom rules. */
  customised: boolean;
  /** What the site sets for itself rather than taking from the default. */
  own: {
    /** null = the default's level. */
    level: SecurityLevel | null;
    /** Rules, limits, headers and in-container settings it changes (kept, not in force, while Off). */
    changes: number;
    customRules: number;
    /** null = the default's. */
    scanEnabled: boolean | null;
    scanOnFinding: ScanOnFinding | null;
  };
  blocked24h: number;
  protection: ProtectionStatusDto;
  scanEnabled: boolean;
  lastScanOutcome: ScanOutcome | null;
  lastScanAt: number | null;
  scanActive: boolean;
  openFindings: number;
  openConfirmed: number;
  quarantined: number;
}

export interface SecurityOverviewDto {
  fleet: FleetSecurity;
  /** The default as it stands, for the "Default protection" card. */
  fleetPolicy: EffectivePolicy;
  sites: SecuritySiteRowDto[];
  /** Each server's rules folder. */
  servers: { serverId: number; serverName: string; state: string; message: string | null; syncedAt: number | null }[];
  blocked24h: number;
  activeBlocks: number;
  /** The latest blocked requests, across the fleet. */
  recentBlocked: BlockedRequestDto[];
  scansInFlight: number;
}
