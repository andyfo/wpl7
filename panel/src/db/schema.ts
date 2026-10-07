// @docs help/faq
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON-encoded
  updatedAt: integer('updated_at').notNull(),
});

export const servers = sqliteTable('servers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(), // 'local' | 'ssh'
  sshHost: text('ssh_host'),
  sshPort: integer('ssh_port').notNull().default(22),
  // LEGACY(ceo) - the column default still says `ceo-panel`, and stays that way. SQLite
  // cannot alter a default in place, so changing it means rebuilding a table that sites,
  // jobs and backups all reference - for a value nothing ever reads: every insert goes
  // through shared/schemas.ts, whose default is `wpl7-panel`.
  sshUser: text('ssh_user').notNull().default('ceo-panel'),
  /** Pinned host key (SHA256:<base64>), captured on first connect (TOFU). */
  hostKeySha256: text('host_key_sha256'),
  publicIp: text('public_ip').notNull().default(''),
  devDomain: text('dev_domain').notNull().default(''),
  dnsProvider: text('dns_provider').notNull().default(''),
  /**
   * Directory this server's backups live under. NULL = the default `<SRV_ROOT>/backups`.
   * Per server rather than fleet-wide because the disks differ per machine - and because
   * server 1 additionally needs the path bind-mounted into the panel container, which only
   * a compose change can do (deploy/docker-compose.backup-root.yml).
   */
  backupRoot: text('backup_root'),
  status: text('status').notNull().default('ok'), // 'ok' | 'unreachable' | 'provisioning' | 'error'
  lastSeenAt: integer('last_seen_at'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sites = sqliteTable(
  'sites',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull().unique(),
    serverId: integer('server_id')
      .notNull()
      .default(1)
      .references(() => servers.id),
    title: text('title').notNull(),
    /** JSON array of hostnames; [0] is the primary (canonical) domain. */
    domains: text('domains').notNull(),
    devHostname: text('dev_hostname'),
    isLive: integer('is_live').notNull().default(0),
    keepDevAlias: integer('keep_dev_alias').notNull().default(1),
    phpVersion: text('php_version').notNull(),
    locale: text('locale').notNull().default('en_US'),
    status: text('status').notNull(),
    dbName: text('db_name').notNull(),
    dbUser: text('db_user').notNull(),
    dbPassword: text('db_password').notNull(),
    wpAdminUser: text('wp_admin_user'),
    wpAdminEmail: text('wp_admin_email'),
    containerName: text('container_name').notNull(),
    /**
     * The prefix of the site's WordPress tables, handed to the container's wp-config.php. `wp_`
     * for every site the panel installed; an imported site keeps the one it came with. Never
     * renamed: code on an imported site may name its tables outright.
     */
    tablePrefix: text('table_prefix').notNull().default('wp_'),
    /**
     * SMTP AUTH password for this site's relay login (`<slug>@<realm>`). The relay refuses
     * to send as a domain that belongs to another site, and the login is how it tells them
     * apart - so this is per-site, not a shared secret. NULL on rows created before mail
     * authentication existed; `site.reconcile` mints one.
     */
    mailPassword: text('mail_password'),
    /** Set when the abuse guard suspended this site's outbound mail; NULL = allowed to send. */
    mailSuspendedAt: integer('mail_suspended_at'),
    mailSuspendReason: text('mail_suspend_reason'),
    /**
     * 0 = the scheduled backup run skips this site. Only that run - which is whatever
     * cron expression `backup.cron` holds, not necessarily a nightly one: manual backups,
     * the pre-restore safety copy, the copy a move takes and the final backup on delete
     * all still happen, because those exist to catch a mistake in progress.
     */
    backupsEnabled: integer('backups_enabled').notNull().default(1),
    /** 0 = this site's backups are never copied to an offsite destination. */
    offsiteEnabled: integer('offsite_enabled').notNull().default(1),
    diskBytes: integer('disk_bytes'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
);

export const backups = sqliteTable(
  'backups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
    /** Denormalized so final backups survive site deletion. */
    siteSlug: text('site_slug').notNull(),
    /** The server whose /srv/backups holds this backup's files. */
    serverId: integer('server_id')
      .notNull()
      .default(1)
      .references(() => servers.id),
    type: text('type').notNull(),
    status: text('status').notNull(),
    /** Absolute path of the backup timestamp directory. */
    path: text('path').notNull(),
    /**
     * The backup root in force when this row was created, so deletion can check
     * `path === <root>/<slug>/<ts>` against the root that actually produced it rather than
     * against whatever the server's root happens to be today. NULL on rows written before
     * roots were selectable; derived as dirname(dirname(path)), the layout being fixed.
     */
    rootPath: text('root_path'),
    /**
     * 0 = the files are gone from the server but the backup still exists offsite. Local
     * pruning sets this instead of deleting a row that an offsite copy still points at;
     * `backup.fetch` sets it back to 1.
     */
    filesPresent: integer('files_present').notNull().default(1),
    sizeBytes: integer('size_bytes'),
    wpVersion: text('wp_version'),
    phpVersion: text('php_version'),
    note: text('note'),
    jobId: integer('job_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('backups_site_created_idx').on(t.siteSlug, t.createdAt)],
);

/**
 * One offsite target: a bucket, an SFTP account, a WebDAV share. Every field an rclone
 * remote needs lives here, split so the API can return the shape of a destination without
 * ever returning what it is authenticated with.
 *
 * Credentials sit in `panel.db` in plaintext, like the site database and relay passwords
 * that are already in it - the file is chmod 600 inside a chmod 700 directory, and the API
 * never reads them back out. Encryption at rest is a change for the whole file, not for
 * this table alone.
 */
export const backupDestinations = sqliteTable('backup_destinations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  /** Preset key from shared/backupProviders.ts (s3, s3-compatible, sftp, ftp, webdav, rclone). */
  provider: text('provider').notNull(),
  /** JSON object of the preset's non-secret fields (endpoint, bucket, prefix, host, user…). */
  config: text('config').notNull(),
  /** JSON object of the preset's secret fields. Never leaves the panel. */
  secrets: text('secrets').notNull(),
  enabled: integer('enabled').notNull().default(1),
  /** JSON string[] of backup types to copy; defaults to scheduled + manual + final. */
  copyTypes: text('copy_types').notNull(),
  /** Only backups created at or after this are eligible - how backfill is controlled. */
  copyFromTs: integer('copy_from_ts').notNull(),
  /** Scheduled backups kept per site at this destination; 0 = keep every one. */
  retentionScheduled: integer('retention_scheduled').notNull().default(30),
  /**
   * 'panel' = the panel prunes old copies. 'external' = it never deletes anything here,
   * for buckets with lifecycle rules, Object Lock, or a key without Delete.
   */
  retentionMode: text('retention_mode').notNull().default('panel'),
  /** rclone --bwlimit syntax, timetables included ("08:00,1M 20:00,off"). NULL = no limit. */
  bwlimit: text('bwlimit'),
  /**
   * 'none' (the default) or 'crypt': encrypt every byte and every file name before it
   * leaves the server, via rclone's crypt backend. Fixed once anything has been copied -
   * changing it would make the existing objects unreadable and unfindable.
   */
  encryption: text('encryption').notNull().default('none'),
  /**
   * The crypt passphrase and its salt (rclone's `password`/`password2`), generated by the
   * panel. Plaintext here like every other credential the panel holds - the point of the
   * encryption is that the *provider* cannot read the backups, not that this file cannot.
   * Without these AND without this database, the copies are unrecoverable by anyone.
   */
  cryptPassword: text('crypt_password'),
  cryptSalt: text('crypt_salt'),
  lastSuccessAt: integer('last_success_at'),
  lastFailureAt: integer('last_failure_at'),
  lastError: text('last_error'),
  /** Last time the operator was emailed about this destination failing (once a day at most). */
  lastAlertAt: integer('last_alert_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** One backup at one destination. The unique index is what makes the reconciler idempotent. */
export const backupCopies = sqliteTable(
  'backup_copies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    backupId: integer('backup_id')
      .notNull()
      .references(() => backups.id, { onDelete: 'cascade' }),
    destinationId: integer('destination_id')
      .notNull()
      .references(() => backupDestinations.id, { onDelete: 'cascade' }),
    /** 'pending' | 'uploading' | 'complete' | 'failed' */
    status: text('status').notNull(),
    /** Path under the destination's remote root: `<prefix>/<slug>/<ts>`. */
    remotePath: text('remote_path').notNull(),
    sizeBytes: integer('size_bytes'),
    attempts: integer('attempts').notNull().default(0),
    /** When a failed copy may be tried again; NULL once it has given up. */
    nextAttemptAt: integer('next_attempt_at'),
    error: text('error'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('backup_copies_backup_dest_idx').on(t.backupId, t.destinationId),
    index('backup_copies_dest_status_idx').on(t.destinationId, t.status),
  ],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    siteId: integer('site_id'),
    siteSlug: text('site_slug'),
    /** Server lane this job occupies; NULL-lane jobs serialize among themselves. */
    serverId: integer('server_id'),
    /** Second lane for two-server jobs (site.move holds source + target). */
    auxServerId: integer('aux_server_id'),
    /** Set on the per-site jobs of one bulk WordPress run; see `batches`. */
    batchId: integer('batch_id'),
    /**
     * A named lane orthogonal to the server lanes, so long uploads do not block a server's
     * Docker/MariaDB work. Jobs sharing a lane name serialize with each other and with
     * nothing else; NULL keeps the original server-lane behaviour.
     */
    lane: text('lane'),
    payload: text('payload').notNull(), // JSON
    status: text('status').notNull(),
    error: text('error'),
    result: text('result'), // JSON
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    /**
     * How the job was queued: 'user' | 'api' | 'mcp' | 'schedule' | 'system' (see src/jobs/actor.ts).
     * NULL on jobs older than the column. Not `trigger`, which is an SQL keyword.
     */
    origin: text('origin'),
    /** Who: the admin's username, `API key "<name>"`, the MCP caller, or the schedule's name. */
    createdBy: text('created_by'),
    /**
     * The schedule that queued it. No FK: drizzle-kit cannot add one with an ON DELETE to an
     * existing table, and a deleted schedule's jobs are history worth keeping anyway.
     */
    scheduleId: integer('schedule_id'),
    /** One line about what this job does, written at enqueue (src/jobs/summaries.ts). */
    summary: text('summary'),
  },
  (t) => [
    index('jobs_status_idx').on(t.status),
    index('jobs_site_created_idx').on(t.siteSlug, t.createdAt),
    index('jobs_status_server_idx').on(t.status, t.serverId),
    index('jobs_batch_idx').on(t.batchId),
    index('jobs_schedule_idx').on(t.scheduleId),
  ],
);

/**
 * Everything that runs on its own, one row each: the built-in tasks (`key` set - their name,
 * cadence and behaviour are code, the row holds only whether they are paused and how their
 * last run went) and the schedules an operator or an API client created (`key` NULL).
 */
export const schedules = sqliteTable('schedules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Built-ins only: `backups`, `wp-scan`, `uptime`, … */
  key: text('key').unique(),
  name: text('name').notNull(),
  description: text('description'),
  /** Custom schedules: shared/scheduleActions.ts `scheduleActions`. */
  action: text('action'),
  target: text('target'), // JSON ScheduleTarget
  params: text('params'), // JSON
  /** Five-field cron on the panel's clock; NULL for a one-off. */
  cron: text('cron'),
  /** A one-off's time (ms). */
  runAt: integer('run_at'),
  enabled: integer('enabled').notNull().default(1),
  pausedAt: integer('paused_at'),
  /** When a custom schedule fires next; NULL while paused or once a one-off has run. */
  nextRunAt: integer('next_run_at'),
  lastRunAt: integer('last_run_at'),
  lastDurationMs: integer('last_duration_ms'),
  lastOutcome: text('last_outcome'), // 'ok' | 'failed' | 'skipped'
  lastError: text('last_error'),
  lastResult: text('last_result'), // JSON ScheduleRunResult
  createdBy: text('created_by'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const jobLogs = sqliteTable(
  'job_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }), // doubles as the polling cursor
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    level: text('level').notNull(),
    message: text('message').notNull(),
    /**
     * The line without what a command printed - a plugin recipe's step, in the log of a job that
     * ran one - which a caller who may not read that gets instead (routes/jobs.ts). NULL: none.
     */
    withoutOutput: text('without_output'),
  },
  (t) => [index('job_logs_job_idx').on(t.jobId, t.id)],
);

export const plugins = sqliteTable(
  'plugins',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(), // 'wporg' | 'zip'
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    zipPath: text('zip_path'),
    isDefault: integer('is_default').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('plugins_kind_slug_idx').on(t.kind, t.slug)],
);

/**
 * What the operator entered for the plugin recipes' inputs (shared/recipes.ts), one row
 * per recipe and input: the license key, the account email that goes with it. Keyed by
 * recipe rather than by catalog zip: the key is for "ACF PRO", however that plugin came
 * to be on a site - catalog install, a customer's upload, a restore. Plaintext, like the
 * site database passwords in `sites`: the value has to be handed to the site in the clear
 * anyway, and every administrator of that site can read it there.
 */
export const recipeInputs = sqliteTable(
  'recipe_inputs',
  {
    recipeId: text('recipe_id').notNull(),
    inputId: text('input_id').notNull(),
    value: text('value').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.recipeId, t.inputId] })],
);

/** What the last recipe run on a site concluded, per recipe - what the site page shows. */
export const siteLicenses = sqliteTable(
  'site_licenses',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    recipeId: text('recipe_id').notNull(),
    /** 'active' | 'failed' | 'inactive' | 'not-set-up' | 'released' (shared/types.ts LicenseStatus). */
    status: text('status').notNull(),
    message: text('message'),
    /** The site URL the run activated for; a later URL change is what invalidates it. */
    url: text('url'),
    checkedAt: integer('checked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.recipeId] })],
);

/**
 * The last good copy of the public catalog (services/catalogSync.ts): one row per entry,
 * payload as published. Read at boot so a panel that cannot reach the catalog right now
 * still has what it last verified; replaced wholesale by every verified fetch.
 */
export const catalogEntries = sqliteTable('catalog_entries', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  typeVersion: integer('type_version').notNull(),
  /** The entry as published, JSON. */
  payload: text('payload').notNull(),
  /** sha256 of `payload`; what "changed since the last fetch" is decided on. */
  hash: text('hash').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
  /** When this entry's content last changed hands - what "updated 2 h ago" shows. */
  changedAt: integer('changed_at'),
});

/**
 * The recipes the operator chose to use (services/licenses.ts). A catalog recipe is
 * installed by reference and follows the catalog's copy; a local one carries its own
 * payload here and is never touched by a fetch. Only installed AND enabled recipes run.
 */
export const installedRecipes = sqliteTable('installed_recipes', {
  recipeId: text('recipe_id').primaryKey(),
  /** 'catalog' | 'local' */
  source: text('source').notNull(),
  enabled: integer('enabled').notNull().default(1),
  /** The recipe itself, JSON - local recipes only. */
  payload: text('payload'),
  installedAt: integer('installed_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
  /**
   * 'read' | 'manage' | 'full' (shared/access.ts). The keys from before there were levels
   * are Full, which is what they always were - nothing that uses one stops working.
   */
  access: text('access').notNull().default('full'),
});

/**
 * The people who sign in to the panel. Every one of them is an admin with the same reach;
 * the owner (`is_owner = 1`, exactly one, held in code rather than by the schema) differs only
 * in that nobody else may change their account or delete it.
 */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  /** argon2id. '' = blanked by hand to get back in; the next boot re-seeds it (db/seed.ts). */
  passwordHash: text('password_hash').notNull(),
  isOwner: integer('is_owner').notNull().default(0),
  /** JSON TotpState, or NULL while two-factor authentication is off. */
  totp: text('totp'),
  /** JSON TotpEnrollment: a secret minted by setup that no code has confirmed yet. */
  totpEnrollment: text('totp_enrollment'),
  /**
   * Where "Forgot your password?" sends its link. Only ever an address somebody proved they
   * read, by following the link sent to it; NULL = no reset by email for this account.
   */
  email: text('email'),
  /** JSON PendingEmail: an address set but not confirmed yet, and the token its link carries. */
  pendingEmail: text('pending_email'),
  /** JSON PasswordReset: the emailed reset link that has not been used yet, if any. */
  passwordReset: text('password_reset'),
  /**
   * Raised every time the account's sessions are revoked. A session carries the generation
   * it was signed in under and counts only while that is still the account's - so a request
   * that was already running at the revocation cannot save its session back to life.
   */
  sessionGeneration: integer('session_generation').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** A completed sign-in - after the code, when 2FA is on. Never touched by a refresh. */
  lastLoginAt: integer('last_login_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    sid: text('sid').primaryKey(),
    data: text('data').notNull(),
    expiresAt: integer('expires_at').notNull(),
    /**
     * Whose session this is, so one admin's sessions can be revoked without touching anyone
     * else's. Deliberately no foreign key: drizzle-kit adds this column with a plain `ADD
     * COLUMN`, which cannot carry `ON DELETE`, so a declared cascade would exist in the
     * snapshot and nowhere else. UsersService.remove() deletes the sessions itself.
     */
    userId: integer('user_id'),
  },
  (t) => [index('sessions_expires_idx').on(t.expiresAt), index('sessions_user_idx').on(t.userId)],
);

export const siteStats = sqliteTable(
  'site_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    up: integer('up'),
    httpMs: integer('http_ms'),
    cpuPct: real('cpu_pct'),
    memBytes: integer('mem_bytes'),
    diskBytes: integer('disk_bytes'),
  },
  (t) => [index('site_stats_site_ts_idx').on(t.siteId, t.ts)],
);

/**
 * Per-site visitor statistics, rolled up by hour from each server's Traefik access log.
 *
 * Traefik is the only place that sees every request for every site with the real client
 * address attached - inside a site container Apache only ever sees the proxy - so its log
 * is what this is reconstructed from, the same way the mail view is reconstructed from
 * postfix's. Counters, not rows per request: a busy site would otherwise put millions of
 * rows a month into a SQLite file whose job is holding panel state.
 */
export const siteTraffic = sqliteTable(
  'site_traffic',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Start of the hour, UTC, in ms. */
    ts: integer('ts').notNull(),
    /** Everything Traefik routed here, bots included; the panel's own probe excluded. */
    requests: integer('requests').notNull().default(0),
    /** Requests for a page (not an asset, not wp-admin/wp-json) that a human made. */
    pageViews: integer('page_views').notNull().default(0),
    /** The share of `requests` whose user agent identifies a crawler. */
    botRequests: integer('bot_requests').notNull().default(0),
    /** Responses with a 5xx status. */
    errors: integer('errors').notNull().default(0),
    bytes: integer('bytes').notNull().default(0),
    /** Total response time across `requests`; divided by it for the average. */
    durationMsSum: integer('duration_ms_sum').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.ts] })],
);

/**
 * One row per (site, hour, visitor), which is what makes "how many people" answerable
 * without storing a request log.
 *
 * `visitor` is a truncated hash of the client address and user agent under a salt that is
 * thrown away and regenerated every day: within a day the same person collapses to one
 * row, and across days - or across sites - nothing links back to them or to each other.
 * No IP address is written to disk, so this needs no visitor consent to run.
 */
export const siteVisitors = sqliteTable(
  'site_visitors',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Start of the hour, UTC, in ms - the same bucket `site_traffic` uses. */
    ts: integer('ts').notNull(),
    visitor: text('visitor').notNull(),
    /**
     * ISO 3166-1 alpha-2, resolved at ingest and stored here rather than in its own table
     * so "visitors per country" is a `count(distinct visitor)` and not a request count -
     * one person reading ten pages is one German, not ten. NULL = unresolved.
     */
    country: text('country'),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.ts, t.visitor] })],
);

/**
 * Daily request counts per crawler. Separate from `site_visitors` on purpose: a crawler is
 * not a person, has no country worth reporting, and belongs in the operational half of the
 * page - "who is spending this site's CPU" - rather than in the audience half.
 */
export const siteTrafficCrawlers = sqliteTable(
  'site_traffic_crawlers',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Start of the day, UTC, in ms. */
    day: integer('day').notNull(),
    /** Display name with the version stripped, e.g. `Googlebot` (lib/accessLog.ts). */
    crawler: text('crawler').notNull(),
    requests: integer('requests').notNull().default(0),
    lastSeenAt: integer('last_seen_at').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day, t.crawler] })],
);

/**
 * Daily request counts per client address.
 *
 * This is the one place a visitor's address is written down, and it exists for the
 * operational question the anonymous counters cannot answer: who is hammering this site,
 * who is walking wp-login. Traefik's own container log already holds these addresses for
 * as long as Docker keeps it, so this adds no new category of data - but it does make them
 * queryable, so it gets its own short retention (`trafficIpRetentionDays`, default 7 days)
 * independent of the 90-day anonymous rollups, and can be switched off entirely.
 */
export const siteTrafficIps = sqliteTable(
  'site_traffic_ips',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Start of the day, UTC, in ms. */
    day: integer('day').notNull(),
    ip: text('ip').notNull(),
    requests: integer('requests').notNull().default(0),
    pageViews: integer('page_views').notNull().default(0),
    botRequests: integer('bot_requests').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    country: text('country'),
    lastSeenAt: integer('last_seen_at').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day, t.ip] })],
);

/** Daily page-view counts per URL path; the "top pages" list. Capped per site per day. */
export const siteTrafficPaths = sqliteTable(
  'site_traffic_paths',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Start of the day, UTC, in ms. */
    day: integer('day').notNull(),
    path: text('path').notNull(),
    views: integer('views').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day, t.path] })],
);

/** Daily page-view counts per referring host; '' is the direct/unknown bucket. */
export const siteTrafficReferrers = sqliteTable(
  'site_traffic_referrers',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    referrer: text('referrer').notNull(),
    views: integer('views').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day, t.referrer] })],
);

export const serverStats = sqliteTable(
  'server_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: integer('server_id')
      .notNull()
      .default(1)
      .references(() => servers.id),
    ts: integer('ts').notNull(),
    load1: real('load1').notNull(),
    load5: real('load5').notNull(),
    load15: real('load15').notNull(),
    memTotal: integer('mem_total').notNull(),
    memUsed: integer('mem_used').notNull(),
    diskTotal: integer('disk_total').notNull(),
    diskUsed: integer('disk_used').notNull(),
  },
  (t) => [
    index('server_stats_ts_idx').on(t.ts),
    index('server_stats_server_ts_idx').on(t.serverId, t.ts),
  ],
);

/**
 * Deferred decommission bookkeeping for site moves: the source copy is only torn down
 * after DNS verifiably points at the target (or manually). No FK cascade on purpose -
 * the row must survive odd states and drive cleanup even if the site changes again.
 */
export const moveCleanups = sqliteTable(
  'move_cleanups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id').notNull(),
    siteSlug: text('site_slug').notNull(),
    sourceServerId: integer('source_server_id').notNull(),
    targetServerId: integer('target_server_id').notNull(),
    containerName: text('container_name').notNull(),
    dbName: text('db_name').notNull(),
    dbUser: text('db_user').notNull(),
    /** Recorded (not re-derived) so cleanup removes exactly what the move left behind. */
    filesPath: text('files_path').notNull(),
    /** JSON string[]: custom hosts that must resolve to targetIp before auto-finalize. */
    verifyHosts: text('verify_hosts').notNull(),
    targetIp: text('target_ip').notNull(),
    /** Traefik file-provider proxy config written on the source (live sites), if any. */
    proxyConfigPath: text('proxy_config_path'),
    status: text('status').notNull(), // 'pending' | 'done'
    createdAt: integer('created_at').notNull(),
    finalizedAt: integer('finalized_at'),
  },
  (t) => [index('move_cleanups_status_idx').on(t.status)],
);

/**
 * Per-site WordPress state: core version, what the last scan found and the denormalised
 * counters the site list and the fleet tiles read.
 *
 * This is a snapshot, not a live view. Asking a container for its plugin list means a
 * `docker exec` and a round trip to api.wordpress.org, which is fine for one site page and
 * impossible for a table covering fifty sites - so the scan job writes here (every
 * `wp.scanIntervalHours`, after every WordPress job, and on demand) and every read is
 * SQLite. `scanned_at IS NULL` therefore means "never asked", which the UI must show as
 * such rather than as "nothing installed".
 */
export const siteWpStatus = sqliteTable('site_wp_status', {
  siteId: integer('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  coreVersion: text('core_version'),
  coreUpdateVersion: text('core_update_version'),
  /** 'major' | 'minor', as `wp core check-update` classifies it. */
  coreUpdateType: text('core_update_type'),
  scannedAt: integer('scanned_at'),
  scanError: text('scan_error'),
  /**
   * 1 = the listing had to be taken with --skip-plugins --skip-themes because a plugin
   * fatals under wp-cli. The inventory is then the files on disk without any update
   * information a premium plugin's own updater would have contributed.
   */
  partial: integer('partial').notNull().default(0),
  /** Recomputed by recount() after every scan and every feed refresh. */
  updatesCount: integer('updates_count').notNull().default(0),
  vulnerableCount: integer('vulnerable_count').notNull().default(0),
  /** 'critical' | 'high' | 'medium' | 'low' | NULL when nothing is known against it. */
  worstSeverity: text('worst_severity'),
});

/**
 * One row per installed plugin and theme per site, as of `site_wp_status.scanned_at`.
 * Rows that a scan no longer sees are deleted, so this table is the fleet's inventory and
 * not a history of what was ever installed.
 */
export const siteWpComponents = sqliteTable(
  'site_wp_components',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** 'plugin' | 'theme'. */
    kind: text('kind').notNull(),
    /** Directory slug, which is both what wp-cli takes and what the feed keys on. */
    slug: text('slug').notNull(),
    title: text('title').notNull().default(''),
    /** plugin: active|inactive|must-use|dropin|active-network; theme: active|parent|inactive. */
    status: text('status').notNull(),
    version: text('version').notNull().default(''),
    updateVersion: text('update_version'),
    /** 'none' | 'available' | 'higher' (installed newer than the directory's latest). */
    updateState: text('update_state').notNull().default('none'),
    autoUpdate: integer('auto_update').notNull().default(0),
    /** Plugin main file (`akismet/akismet.php`); themes have none. */
    file: text('file'),
    seenAt: integer('seen_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.kind, t.slug] }),
    // The fleet page groups by (kind, slug) across every site; this is that query.
    index('site_wp_components_kind_slug_idx').on(t.kind, t.slug),
  ],
);

/**
 * Cached wpvulnerability.net answers, one row per slug rather than per slug@version: the
 * whole fleet shares ~200 plugin slugs but ~1500 site-plugin pairs, and the feed's answer
 * covers every version anyway (each advisory carries its own affected range). Matching
 * installed versions against those ranges happens on read, so a feed refresh changes every
 * site's verdict without touching a single container.
 *
 * For `kind = 'core'` the slug is the WordPress version, because that endpoint is
 * version-scoped: its advisories carry no range and all apply to the version queried.
 */
export const vulnFeed = sqliteTable(
  'vuln_feed',
  {
    /** 'plugin' | 'theme' | 'core'. */
    kind: text('kind').notNull(),
    slug: text('slug').notNull(),
    /** Last successful fetch; NULL while only failed attempts exist. */
    fetchedAt: integer('fetched_at'),
    /** Last attempt, successful or not - what the staleness check backs off on. */
    attemptedAt: integer('attempted_at').notNull(),
    /** Message of the last failed lookup; NULL after a success. */
    error: text('error'),
    /**
     * 1 = the feed has a record for this slug. 0 means it answered "no such slug", which
     * is "no data" (a premium or custom plugin) and must never be shown as "clean".
     */
    known: integer('known').notNull().default(0),
    /** 1 = closed on wordpress.org, so it will never receive another fix. */
    closed: integer('closed').notNull().default(0),
    closedReason: text('closed_reason'),
    /** When the last release was published (ms); the feed's `latest` is a timestamp. */
    latestReleaseAt: integer('latest_release_at'),
    /** JSON array of normalised advisories: range, severity, CVSS, fixedIn, links. */
    advisories: text('advisories').notNull().default('[]'),
  },
  (t) => [primaryKey({ columns: [t.kind, t.slug] })],
);

/**
 * One fleet-wide bulk run. The work itself is one `wp.bulkTask` job per site - which is
 * what keeps the existing guarantees (one active job per site, one running job per server,
 * per-job logs, cancellation) - and this row is what ties them together for the progress
 * view, together with the sites that could not be included at all.
 */
export const batches = sqliteTable(
  'batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 'wp.bulk' for now; the column exists so a second kind needs no migration. */
    kind: text('kind').notNull(),
    action: text('action').notNull(),
    /** JSON: {backupFirst, healthCheck} - what the dialog was set to. */
    options: text('options').notNull().default('{}'),
    /** JSON [{siteSlug, reason}]: sites whose lane was busy when the batch was created. */
    skipped: text('skipped').notNull().default('[]'),
    /** How many (site, component) operations were requested. */
    targetCount: integer('target_count').notNull().default(0),
    totalJobs: integer('total_jobs').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('batches_created_idx').on(t.createdAt)],
);

export type SiteWpStatusRow = typeof siteWpStatus.$inferSelect;
export type SiteWpComponentRow = typeof siteWpComponents.$inferSelect;
export type VulnFeedRow = typeof vulnFeed.$inferSelect;
export type BatchRow = typeof batches.$inferSelect;

export type ServerRow = typeof servers.$inferSelect;
export type SiteRow = typeof sites.$inferSelect;
export type MoveCleanupRow = typeof moveCleanups.$inferSelect;
export type BackupRow = typeof backups.$inferSelect;
export type BackupDestinationRow = typeof backupDestinations.$inferSelect;
export type BackupCopyRow = typeof backupCopies.$inferSelect;
export type SiteTrafficRow = typeof siteTraffic.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type PluginRow = typeof plugins.$inferSelect;
export type RecipeInputRow = typeof recipeInputs.$inferSelect;
export type SiteLicenseRow = typeof siteLicenses.$inferSelect;
export type CatalogEntryRow = typeof catalogEntries.$inferSelect;
export type InstalledRecipeRow = typeof installedRecipes.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type UserRow = typeof users.$inferSelect;

/**
 * Outbound mail traffic, reconstructed from the postfix log of every server.
 * One row per (queue id, recipient): a message to three people is three rows, which is
 * the granularity both the traffic view and the abuse counters need. The row is created
 * as soon as postfix accepts the message (recipient still unknown, `to_addr` empty) and
 * is completed when the delivery attempt is logged.
 */
export const mailMessages = sqliteTable(
  'mail_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: integer('server_id').notNull().default(1),
    /** Postfix queue id; unique per server for the lifetime of the message. */
    queueId: text('queue_id').notNull(),
    /** Sending site, resolved from the `client=wp-<slug>.<network>[ip]` log field. */
    siteSlug: text('site_slug'),
    clientHost: text('client_host'),
    fromAddr: text('from_addr').notNull().default(''),
    /** Empty until postfix logs the delivery attempt for this recipient. */
    toAddr: text('to_addr').notNull().default(''),
    sizeBytes: integer('size_bytes'),
    nrcpt: integer('nrcpt'),
    /** 'queued' | 'sent' | 'deferred' | 'bounced' | 'expired' | 'rejected' */
    status: text('status').notNull(),
    dsn: text('dsn'),
    relay: text('relay'),
    delayMs: integer('delay_ms'),
    /** Remote response or reject reason, trimmed. */
    detail: text('detail'),
    /** 1 = our milter signed it, 0 = it was not signed, NULL = no DKIM line seen. */
    dkimSigned: integer('dkim_signed'),
    dkimDomain: text('dkim_domain'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastEventAt: integer('last_event_at').notNull(),
  },
  (t) => [
    uniqueIndex('mail_messages_queue_rcpt_idx').on(t.serverId, t.queueId, t.toAddr),
    index('mail_messages_last_event_idx').on(t.lastEventAt),
    index('mail_messages_site_idx').on(t.siteSlug, t.lastEventAt),
    index('mail_messages_status_idx').on(t.status, t.lastEventAt),
  ],
);

/**
 * DKIM signing keys, owned by the panel rather than by any one server: the private key
 * lives here and is materialized onto every server's `wpl7-dkim` volume. Keeping the panel
 * as the source of truth means a site move needs no key migration - the target already
 * signs for the domain.
 */
export const mailDkimKeys = sqliteTable(
  'mail_dkim_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domain: text('domain').notNull().unique(),
    selector: text('selector').notNull(),
    /** PKCS#1 PEM, the format opendkim expects. */
    privateKeyPem: text('private_key_pem').notNull(),
    /** base64 SPKI, i.e. the `p=` value of the DNS record. */
    publicKeyB64: text('public_key_b64').notNull(),
    createdAt: integer('created_at').notNull(),
    rotatedAt: integer('rotated_at'),
  },
);

export type MailMessageRow = typeof mailMessages.$inferSelect;
export type MailDkimKeyRow = typeof mailDkimKeys.$inferSelect;

/**
 * One row per update that has been applied to this install, and what the panel did about it
 * afterwards.
 *
 * `provision/update.sh` finishes when the new panel is healthy; some of what a release needs
 * can only be done by that new panel - recreating site containers under a changed policy,
 * pushing the new bundle to worker servers - and those are jobs, with logs and rollbacks, not
 * steps in a shell script. The row is what stops them running twice, and what an operator
 * reads six months later to find out whether they ever ran at all.
 */
export const systemUpdates = sqliteTable('system_updates', {
  /** update.sh's own run id, straight out of state.json - so "did I already do this?" is a lookup. */
  id: text('id').primaryKey(),
  fromVersion: text('from_version').notNull(),
  toVersion: text('to_version').notNull(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  /** 'running' | 'done' | 'failed' - failed here never means the update failed, only its follow-up. */
  status: text('status').notNull(),
  /** JSON array of { key, title, outcome, detail }, in the order they ran. */
  steps: text('steps').notNull().default('[]'),
});

export type SystemUpdateRow = typeof systemUpdates.$inferSelect;

/**
 * One row per API-key request: what a token did, when, and what it got back.
 *
 * Only requests that presented a Bearer token are recorded - the panel's own browser
 * session would drown the log in polling and answers a question ("what am I doing?")
 * nobody has. A token that was refused is recorded too, with `key_id` NULL: an unknown
 * or revoked key hammering the panel is exactly what this log exists to show.
 *
 * `key_prefix` is the first 12 characters of the token, which is the same non-secret
 * prefix the key list displays. The rest of the token is never written down.
 */
export const apiEvents = sqliteTable(
  'api_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    /** NULL when the presented token matched no live key. */
    keyId: integer('key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    /** Name at the time of the call, so a revoked key still reads as itself. */
    keyName: text('key_name').notNull().default(''),
    keyPrefix: text('key_prefix').notNull().default(''),
    method: text('method').notNull(),
    /** Request path with the query string stripped. */
    path: text('path').notNull(),
    /** Matched route pattern ('/api/sites/:slug'); NULL when nothing matched. */
    route: text('route'),
    status: integer('status').notNull(),
    /** The error envelope's `code` for a non-2xx answer. */
    errorCode: text('error_code'),
    durationMs: integer('duration_ms').notNull().default(0),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Job the call queued, read off the `Location` header, so a row links to its job. */
    jobId: integer('job_id'),
    /** 'mcp' when the MCP server made the call for one of its tools; NULL when it came straight in. */
    via: text('via'),
    /**
     * The connected app behind an MCP call (`oauth_grants.id`), when it was one rather than a
     * key. No foreign key, for the reason `sessions.user_id` has none; grant ids are never
     * reused, so one that points nowhere is a connection since revoked.
     */
    connectionId: integer('connection_id'),
    /** The MCP tool that made the call. */
    tool: text('tool'),
  },
  (t) => [
    index('api_events_ts_idx').on(t.ts),
    index('api_events_key_idx').on(t.keyId, t.ts),
    index('api_events_status_idx').on(t.status, t.ts),
  ],
);

export type ApiEventRow = typeof apiEvents.$inferSelect;

/**
 * A server's FTP gateway identity (services/ftp.ts): its SSH host keys and its FTPS
 * certificate. Minted the first time one of the server's sites gets an FTP login, then kept for
 * as long as the server exists - a client that trusted the gateway once must not be asked
 * again because the panel made new ones. Plaintext, like the DKIM keys: they are written onto
 * the server in the clear either way.
 */
export const ftpServers = sqliteTable('ftp_servers', {
  serverId: integer('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  /** OpenSSH private keys. */
  hostKeyEd25519: text('host_key_ed25519').notNull(),
  hostKeyRsa: text('host_key_rsa').notNull(),
  /** Self-signed; FTP clients show its fingerprint and ask to trust it once. */
  tlsCertPem: text('tls_cert_pem').notNull(),
  /** PKCS#8. */
  tlsKeyPem: text('tls_key_pem').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * The link between the gateway and one site's file server, for a site that has FTP logins:
 * the file server's host key (which the gateway pins) and the gateway's key into it.
 *
 * `client_key` is how access is taken away. SFTPGo does not end a session when its login is
 * removed, so any change that narrows access replaces this key: the file server is recreated
 * with only the new one, and a session still holding the old key is refused its next file.
 */
export const siteFtp = sqliteTable('site_ftp', {
  siteId: integer('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  fileServerHostKey: text('file_server_host_key').notNull(),
  clientKey: text('client_key').notNull(),
  /** Last change the server has to be told about; the site is "applied" once a sync is newer. */
  changedAt: integer('changed_at').notNull(),
  rotatedAt: integer('rotated_at').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * FTP/SFTP logins. Each belongs to one site and reaches only that site's files. Usernames
 * are unique across the panel, not per site: a site moves between servers, and every
 * server's gateway has to be able to take all of its logins.
 */
export const siteFtpUsers = sqliteTable(
  'site_ftp_users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    username: text('username').notNull().unique(),
    /** argon2id in SFTPGo's parameter order (services/ftpKeys.ts). The password itself is never stored. */
    passwordHash: text('password_hash').notNull(),
    /** Site-relative folder the login is kept inside; '' = the whole site. */
    folder: text('folder').notNull().default(''),
    /** Unix ms after which the login stops working; NULL = never. */
    expiresAt: integer('expires_at'),
    /** Who made it: an admin's username, or an API key's name. */
    createdBy: text('created_by'),
    passwordSetAt: integer('password_set_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('site_ftp_users_site_idx').on(t.siteId)],
);

export type FtpServerRow = typeof ftpServers.$inferSelect;
export type SiteFtpRow = typeof siteFtp.$inferSelect;
export type SiteFtpUserRow = typeof siteFtpUsers.$inferSelect;

// ---------------------------------------------------------------------------
// Security (docs/security.md)

/**
 * A site's own protection settings. No row, or a NULL column, means "follow the fleet
 * default" (settings `security.*`, `scan.*`) - which is what every site does until someone
 * changes one of its settings, so a changed default reaches every such site at once.
 */
export const siteSecurity = sqliteTable('site_security', {
  siteId: integer('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  /** 'off' | 'standard' | 'strict'; NULL = the fleet default. */
  level: text('level'),
  /** JSON SecurityOverrides (shared/security.ts): single rules and limits changed for this site. */
  overrides: text('overrides').notNull().default('{}'),
  /** JSON CustomRule[]. */
  customRules: text('custom_rules').notNull().default('[]'),
  /** 0/1; NULL = the fleet setting `scan.enabled`. */
  scanEnabled: integer('scan_enabled'),
  /** ScanOnFinding; NULL = the fleet setting `scan.onFinding`. */
  scanOnFinding: text('scan_on_finding'),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by'),
});

/**
 * Requests a site's protection blocked, per day and rule: `files`, `limit-login`,
 * `block-<id>` for a custom rule, `blocked-address`. Counted from Traefik's access log, where
 * the router that answered names the rule (shared/security.ts securityName).
 */
export const siteBlocked = sqliteTable(
  'site_blocked',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Start of the day, UTC, in ms. */
    day: integer('day').notNull(),
    rule: text('rule').notNull(),
    requests: integer('requests').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day, t.rule] })],
);

/**
 * The last blocked requests, per site (the newest 500 are kept). The address follows the
 * visitor statistics' rules: not written while `traffic.storeIps` is off, and blanked after
 * `traffic.ipRetentionDays`. The path never carries its query string.
 */
export const siteBlockedRecent = sqliteTable(
  'site_blocked_recent',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    rule: text('rule').notNull(),
    ip: text('ip'),
    country: text('country'),
    /** The trusted proxy the request came through, if any. */
    via: text('via'),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
  },
  (t) => [index('site_blocked_recent_site_ts_idx').on(t.siteId, t.ts), index('site_blocked_recent_ts_idx').on(t.ts)],
);

/**
 * Addresses refused at every server of the fleet: by the network firewall for direct visitors,
 * by Traefik for visitors behind a trusted proxy. One row per block, kept after it ends for
 * the history (`security.historyDays`) and for counting repeats; only one per address may be
 * in force at a time.
 */
export const securityBlocks = sqliteTable(
  'security_blocks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Canonical address or range (shared/cidr.ts): `203.0.113.7`, `2001:db8:1:2::/64`. */
    address: text('address').notNull(),
    family: integer('family').notNull(),
    /** 'detector' | 'manual' | 'api' - and whatever feeds the list later. */
    source: text('source').notNull(),
    /** The detection rule that fired; NULL for a block made by hand. */
    rule: text('rule'),
    reason: text('reason').notNull(),
    /** JSON: what the detector saw - counts, sample paths, sites. */
    evidence: text('evidence'),
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
    serverId: integer('server_id').references(() => servers.id, { onDelete: 'set null' }),
    country: text('country'),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull(),
    /** NULL = until lifted. */
    expiresAt: integer('expires_at'),
    endedAt: integer('ended_at'),
    /** 'expired' | 'lifted' | 'observed' (what observe mode would have done). */
    endReason: text('end_reason'),
    endedBy: text('ended_by'),
    /** Which automatic block of this address in the last 30 days this is; decides the length. */
    strike: integer('strike').notNull().default(1),
    /** Blocked requests the HTTP layer saw (the network layer drops without a log). */
    hits: integer('hits').notNull().default(0),
    lastHitAt: integer('last_hit_at'),
  },
  (t) => [
    uniqueIndex('security_blocks_active_idx').on(t.address).where(sql`ended_at IS NULL`),
    index('security_blocks_address_idx').on(t.address, t.createdAt),
    index('security_blocks_created_idx').on(t.createdAt),
  ],
);

/** Addresses and ranges never blocked, by the detector or by hand. */
export const securityNeverBlock = sqliteTable('security_never_block', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  address: text('address').notNull().unique(),
  note: text('note'),
  createdBy: text('created_by'),
  createdAt: integer('created_at').notNull(),
});

/**
 * Where the panel's own administrators have been signing in from. An address that used the
 * panel within 30 days is never blocked: the detector locking out the person who would lift
 * the block is the failure that matters most.
 */
export const securityAdminAddresses = sqliteTable(
  'security_admin_addresses',
  {
    address: text('address').primaryKey(),
    /** The admin or API key seen last from it. */
    username: text('username').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (t) => [index('security_admin_addresses_seen_idx').on(t.lastSeenAt)],
);

/** Where each site stands with malware scans; the row the site list and the scheduler read. */
export const siteScanStatus = sqliteTable('site_scan_status', {
  siteId: integer('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  lastScanId: integer('last_scan_id'),
  lastStartedAt: integer('last_started_at'),
  lastFinishedAt: integer('last_finished_at'),
  /** ScanOutcome of the last scan that finished. */
  lastOutcome: text('last_outcome'),
  /** Open findings, and how many of them are confirmed malware. */
  openFindings: integer('open_findings').notNull().default(0),
  openConfirmed: integer('open_confirmed').notNull().default(0),
  quarantined: integer('quarantined').notNull().default(0),
  /** Scans in a row that failed; three is an alert. */
  failures: integer('failures').notNull().default(0),
  lastAlertAt: integer('last_alert_at'),
  /** Set by "Scan now" and by a superseded scan: scanned at the next tick, schedule or not. */
  requestedAt: integer('requested_at'),
});

export const siteScans = sqliteTable(
  'site_scans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    serverId: integer('server_id'),
    jobId: integer('job_id'),
    /** 'schedule' | 'manual' | 'rescan' | 'import'. */
    trigger: text('trigger').notNull(),
    /** ScanOutcome. */
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    /** JSON {check, signatures}: what each engine did, how far it got, how long it took. */
    engines: text('engines').notNull().default('{}'),
    filesScanned: integer('files_scanned'),
    findingsTotal: integer('findings_total'),
    findingsNew: integer('findings_new'),
    /** JSON string[]: `plugin:<slug>`, `theme:<slug>` with no public checksums to compare against. */
    noChecksums: text('no_checksums'),
    error: text('error'),
  },
  (t) => [index('site_scans_site_started_idx').on(t.siteId, t.startedAt)],
);

/**
 * What scans found, one row per site and finding. A finding is the same finding in the next
 * scan when its fingerprint is (engine, kind, path, rule - never the line, which moves), so
 * "ignored" and "resolved" survive a rescan, and one that comes back is reopened.
 */
export const siteScanFindings = sqliteTable(
  'site_scan_findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    /** 'check' (the panel's own) | 'signatures' (AMWScan). */
    engine: text('engine').notNull(),
    /** FindingKind (shared/security.ts). */
    kind: text('kind').notNull(),
    /** 'confirmed' | 'suspicious'. */
    confidence: text('confidence').notNull(),
    /** 'high' | 'medium' | 'low'. */
    severity: text('severity').notNull(),
    /** Relative to the site's WordPress folder. */
    path: text('path').notNull(),
    line: integer('line'),
    rule: text('rule'),
    detail: text('detail'),
    /** `core`, `plugin:<slug>`, `theme:<slug>`: the package the file belongs to, if any. */
    package: text('package'),
    packageVersion: text('package_version'),
    sha256: text('sha256'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    lastScanId: integer('last_scan_id'),
    /** 'open' | 'ignored' | 'resolved' | 'quarantined'. */
    status: text('status').notNull().default('open'),
    statusAt: integer('status_at'),
    statusBy: text('status_by'),
  },
  (t) => [
    uniqueIndex('site_scan_findings_fingerprint_idx').on(t.siteId, t.fingerprint),
    index('site_scan_findings_status_idx').on(t.siteId, t.status),
  ],
);

/**
 * The panel's own files in a site (services/panelFiles.ts) and every hash it wrote each with:
 * a malware scan holds the file to them. Several per file, so a restored backup's older copy
 * is still one the panel wrote.
 */
export const sitePanelFiles = sqliteTable(
  'site_panel_files',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Relative to the site's WordPress folder. */
    path: text('path').notNull(),
    sha256: text('sha256').notNull(),
    /** When the panel last wrote it with this content, or found it already so. */
    writtenAt: integer('written_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.path, t.sha256] })],
);

/**
 * Files moved out of a site into `<SRV_ROOT>/sites/<slug>/quarantine/`, beside its folder and
 * mounted into nothing. Never deleted on their own unless `scan.quarantineKeepDays` says so.
 */
export const siteQuarantine = sqliteTable(
  'site_quarantine',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    findingId: integer('finding_id').references(() => siteScanFindings.id, { onDelete: 'set null' }),
    /** Where it was, relative to the site's WordPress folder. */
    path: text('path').notNull(),
    /** Its name in the quarantine folder. */
    storedName: text('stored_name').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes'),
    /** Octal permission bits it had, put back on restore. */
    mode: text('mode'),
    reason: text('reason'),
    movedAt: integer('moved_at').notNull(),
    /** 'automatic', or the admin who pressed the button. */
    movedBy: text('moved_by').notNull(),
    restoredAt: integer('restored_at'),
    restoredBy: text('restored_by'),
    deletedAt: integer('deleted_at'),
    deletedBy: text('deleted_by'),
  },
  (t) => [index('site_quarantine_site_idx').on(t.siteId, t.movedAt)],
);

/**
 * wordpress.org's published checksums, fetched by the panel and handed to the scan - which
 * runs with no network at all. Keyed `core:<version>:<locale>`, `plugin:<slug>:<version>`; a
 * release never changes, so a row is good for as long as anybody runs that version.
 */
export const integrityManifests = sqliteTable('integrity_manifests', {
  key: text('key').primaryKey(),
  /** 'core' | 'plugin'. */
  kind: text('kind').notNull(),
  slug: text('slug').notNull(),
  version: text('version').notNull(),
  locale: text('locale'),
  /** 'ok' | 'none' (nothing published for it) | 'error' (retried later). */
  status: text('status').notNull(),
  /** JSON {path: hash}. */
  files: text('files'),
  /** 'md5' | 'sha256'. */
  hashType: text('hash_type'),
  fetchedAt: integer('fetched_at').notNull(),
  error: text('error'),
});

/**
 * A zip in the plugin catalog, held once to what it holds (services/pluginZipChecks.ts): each
 * file's hash, and what AMWScan says about them. A site's plugin of the same folder and
 * version has every file that matches vouched for - but none the check flagged, until a
 * person has looked at those. One row per catalog zip; a zip at a path never changes.
 */
export const pluginZipChecks = sqliteTable('plugin_zip_checks', {
  pluginId: integer('plugin_id')
    .primaryKey()
    .references(() => plugins.id, { onDelete: 'cascade' }),
  /** 'queued' | 'running' | 'done' | 'failed'. */
  status: text('status').notNull(),
  /** sha256 of the zip file the result is about. */
  zipSha256: text('zip_sha256'),
  /** The AMWScan version it ran with: a newer one checks the zip again. */
  scanner: text('scanner'),
  /** The zip's one top-level folder, and the Version its plugin header says. */
  folder: text('folder'),
  version: text('version'),
  files: integer('files'),
  /** JSON {path in the folder: sha256}. */
  manifest: text('manifest'),
  /** JSON [{path, kind, confidence, severity, rule, line, detail}] - AMWScan's, paths in the folder. */
  findings: text('findings'),
  /** Findings that are known malware (a signature or a known-malware hash). */
  confirmed: integer('confirmed').notNull().default(0),
  /** Why the check failed or is incomplete, in words for the page. */
  problem: text('problem'),
  requestedAt: integer('requested_at'),
  checkedAt: integer('checked_at'),
  /** Who said the flagged files are the plugin's own, and of which findings exactly. */
  reviewedAt: integer('reviewed_at'),
  reviewedBy: text('reviewed_by'),
  reviewedDigest: text('reviewed_digest'),
  /** The zip hash an alert went out for: once per zip. */
  alertedFor: text('alerted_for'),
});

export type PluginZipCheckRow = typeof pluginZipChecks.$inferSelect;
export type SiteSecurityRow = typeof siteSecurity.$inferSelect;
export type SecurityBlockRow = typeof securityBlocks.$inferSelect;
export type SecurityNeverBlockRow = typeof securityNeverBlock.$inferSelect;
export type SiteScanStatusRow = typeof siteScanStatus.$inferSelect;
export type SiteScanRow = typeof siteScans.$inferSelect;
export type SiteScanFindingRow = typeof siteScanFindings.$inferSelect;
export type SiteQuarantineRow = typeof siteQuarantine.$inferSelect;
export type IntegrityManifestRow = typeof integrityManifests.$inferSelect;

/**
 * Apps that registered to connect over MCP (OAuth dynamic client registration, RFC 7591;
 * services/oauth.ts). Registration is only open while an admin has a connection window open,
 * and a client nobody approved is pruned.
 */
export const oauthClients = sqliteTable(
  'oauth_clients',
  {
    clientId: text('client_id').primaryKey(),
    /** 'dcr' - registered here. Leaves room for client ID metadata documents (CIMD). */
    kind: text('kind').notNull().default('dcr'),
    /** As the app gave it: shown quoted on the approval page, never trusted. */
    name: text('name').notNull(),
    /** JSON string[], each one checked by shared/oauth.ts at registration. */
    redirectUris: text('redirect_uris').notNull(),
    createdIp: text('created_ip'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('oauth_clients_created_idx').on(t.createdAt)],
);

/**
 * The connections: an app an admin approved, and what it may do. Removing the admin removes
 * their connections; revoking one deletes it. Autoincrement, so an id is never handed out
 * twice - an authorization code in memory names its grant, and must never find a new one.
 */
export const oauthGrants = sqliteTable(
  'oauth_grants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    /** The admin who approved it. The app acts as itself, never as them. */
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'read' | 'manage' | 'full' - the admin's choice, changeable on the MCP page. */
    access: text('access').notNull(),
    /** The MCP endpoint the tokens are for (RFC 8707). */
    resource: text('resource').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('oauth_grants_user_idx').on(t.userId), index('oauth_grants_client_idx').on(t.clientId)],
);

/**
 * Access and refresh tokens of a connection, by sha256: the tokens themselves are never
 * stored. A refresh token is rotated on use; `rotated_at` keeps the old one answerable for a
 * short grace, after which presenting it again ends the connection (services/oauth.ts).
 */
export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    grantId: integer('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'access' | 'refresh'
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    rotatedAt: integer('rotated_at'),
  },
  (t) => [index('oauth_tokens_grant_idx').on(t.grantId), index('oauth_tokens_expires_idx').on(t.expiresAt)],
);

export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthGrantRow = typeof oauthGrants.$inferSelect;
export type OAuthTokenRow = typeof oauthTokens.$inferSelect;

/**
 * One import of an existing WordPress site (services/imports.ts, docs/internal/import-protocol.md):
 * the migration plugin installed on the old site, what it reported about it, what the admin chose
 * at Confirm, and how far the pull has got.
 *
 * `token` is kept as it is, not only as a hash: the panel signs every request to the plugin with
 * it, as it reads site database passwords and destination credentials back from this file. It is
 * nulled when the import is disconnected, which ends the plugin's answering to it.
 */
export const imports = sqliteTable(
  'imports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    token: text('token'),
    /** sha256 of the token: how the plugin's own calls find their import. */
    tokenHash: text('token_hash').notNull(),
    /** 'pending' | 'connected' | 'queued' | 'pulling' | 'pulled' | 'finishing' | 'done' | 'failed' | 'expired' */
    status: text('status').notNull(),
    /** What the admin typed, if anything; the old site's real address is `home_url`. */
    sourceUrl: text('source_url'),
    /** The old site's `home`, bound at its first connect: another site cannot connect with the token. */
    homeUrl: text('home_url'),
    endpointUrl: text('endpoint_url'),
    /** 1 = the admin allowed the old site to be reached over plain http. */
    allowHttp: integer('allow_http').notNull().default(0),
    pluginVersion: text('plugin_version'),
    protocol: integer('protocol'),
    wpVersion: text('wp_version'),
    phpVersion: text('php_version'),
    tablePrefix: text('table_prefix'),
    multisite: integer('multisite'),
    /** The old site's "Search engine visibility": 1 = allowed. */
    blogPublic: integer('blog_public'),
    filesBytes: integer('files_bytes'),
    dbBytes: integer('db_bytes'),
    fileCount: integer('file_count'),
    tableCount: integer('table_count'),
    /** JSON: the old site's report as the plugin sent it, checked (services/importInspect.ts). */
    report: text('report'),
    /** JSON ImportWarning[]: what the report says about importing it. */
    warnings: text('warnings'),
    /** JSON ImportChoices: what the admin chose at Confirm. */
    choices: text('choices'),
    /** JSON ImportCursor: how far the pull has got; the staging folder's import.json is its twin. */
    cursor: text('cursor'),
    /** `<srvRoot>/wpl7-import/<id>` on the target server. */
    stagingPath: text('staging_path'),
    siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
    serverId: integer('server_id').references(() => servers.id, { onDelete: 'set null' }),
    /** The job working on it now, or the last one that did. */
    jobId: integer('job_id'),
    lastError: text('last_error'),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    connectedAt: integer('connected_at'),
    /** When an import that is waiting (pending, connected) or done expires; see ImportService. */
    expiresAt: integer('expires_at'),
    startedAt: integer('started_at'),
    pulledAt: integer('pulled_at'),
    importedAt: integer('imported_at'),
    disconnectedAt: integer('disconnected_at'),
  },
  (t) => [
    uniqueIndex('imports_token_hash_idx').on(t.tokenHash),
    index('imports_status_idx').on(t.status),
    index('imports_site_idx').on(t.siteId),
  ],
);

export type ImportRow = typeof imports.$inferSelect;
