/**
 * Zod schemas shared between the API (validation) and the React app (types/forms).
 * These are the source of truth for every request body and the core DTO shapes.
 */
import { z } from 'zod';
import { accessLevels } from './access.js';
import {
  FILE_LIMITS,
  RESERVED_FILE_PREFIX,
  UPLOAD_ID_RE,
  newFileNameProblem,
  parseSiteFilePath,
  siteFileBase,
  utf8Bytes,
} from './siteFilePath.js';
import {
  autoBlockModes,
  customRulesSchema,
  detectionRulesSchema,
  findingStatuses,
  scanOnFindingModes,
  securityLevels,
  securityOverridesSchema,
  trustedProxiesSchema,
} from './security.js';

// ---------------------------------------------------------------------------
// Primitives

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const RESERVED_SLUGS = [
  'panel',
  'mail',
  'mariadb',
  'traefik',
  'www',
  'backups',
  'plugins',
  'tmp',
  'srv',
  'api',
  'admin',
  // All collide with a static page under /sites: /sites/new is the creation wizard,
  // /sites/bulk is fleet-wide WordPress management and /sites/security the fleet's protection,
  // so a site by any of them would be unreachable in the browser while looking perfectly fine
  // in the API.
  'new',
  'bulk',
  'security',
] as const;

export const DOMAIN_RE =
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * A slug being CHOSEN: the character rules plus the reserved-name check.
 *
 * Only for new sites. Addressing an existing one goes through `siteSlugParam` below,
 * because the reserved list grows over time and a site created before a name was reserved
 * must not become unreachable the day it is added - there is no rename, so that would
 * strand it with no way out.
 */
export const slugSchema = z
  .string()
  .regex(SLUG_RE, 'slug must be 3-32 chars of a-z, 0-9 and dashes')
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), 'slug is reserved');

/** A slug being USED to address a site that already exists: character rules only. */
export const siteSlugParam = z.string().regex(SLUG_RE, 'slug must be 3-32 chars of a-z, 0-9 and dashes');

// An empty (or blank) query value is "not given". Coerced as it comes it would be a number, since
// Number('') is 0: `?until=` became a bound no job passes, and a required `?offset=` was taken as 0.
const emptyAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/**
 * A number in a query string: `queryNumber(z.coerce.number().int().min(0).optional())`. Left empty
 * it is not given - so it is optional, takes its default, or is refused when it is required.
 */
const queryNumber = <T extends z.ZodType>(schema: T) => z.preprocess(emptyAsUnset, schema);

export const domainSchema = z
  .string()
  .max(253)
  .transform((s) => s.trim().toLowerCase().replace(/\.$/, ''))
  .pipe(z.string().regex(DOMAIN_RE, 'not a valid hostname'));

// Covers every shape wp.org ships: `de_DE`, bare `el`, UN-region `es_419`, and the
// variant suffixes `de_DE_formal` / `pt_PT_ao90` (digits included - `[a-z]+` rejected
// pt_PT_ao90, a locale the picker offers).
export const localeSchema = z
  .string()
  .regex(
    /^[a-z]{2,3}(_([A-Z]{2}|[0-9]{3}))?(_[a-z0-9]+)?$/,
    'not a valid WordPress locale (e.g. en_US, de_DE, cs_CZ)',
  );

export const phpVersionSchema = z.string().regex(/^8\.\d{1,2}$/, 'not a valid PHP version');

// WP plugin directory slug / installed plugin name (path segment, no traversal).
export const wpPluginNameSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/, 'not a valid plugin name');

/**
 * A query value that may name several of `values`, comma-separated: `?status=failed,canceled`.
 * A single value is still a list of one, which keeps `?status=failed` working as it always has.
 */
const commaList = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(2000)
    .optional()
    .transform((raw) => (raw ? [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))] : []))
    .pipe(z.array(z.enum(values)).max(values.length));

// ---------------------------------------------------------------------------
// Enums

export const siteStatuses = ['provisioning', 'running', 'stopped', 'error', 'deleting'] as const;
export type SiteStatus = (typeof siteStatuses)[number];

export const jobStatuses = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const jobTypes = [
  'demo',
  'site.create',
  'site.delete',
  'site.start',
  'site.stop',
  'site.restart',
  'site.changePhp',
  'site.reconcile',
  'site.updateDomains',
  'site.move',
  'site.moveFinalize',
  'backup.create',
  'backup.restore',
  'backup.offsite',
  'backup.fetch',
  'backup.offsitePurge',
  'panel.snapshot',
  'wp.coreUpdate',
  'wp.pluginTask',
  'wp.themeTask',
  'wp.bulkTask',
  'wp.scanAll',
  'wp.recipes',
  'files.extract',
  'files.compress',
  'server.provision',
  'server.syncPlugins',
  'server.relocateBackups',
  'server.applySiteLimits',
  // Not a site or a server operation: the work the panel does for itself after an update.
  'system.postUpdate',
  // Commands run inside a site's container, on demand or from a schedule.
  'wp.cli',
  'site.shell',
  'wp.rest',
  // The nightly pruning run. Not "maintenance": that word already names the read-only flag
  // an update sets (`system.maintenance`), and the two have nothing to do with each other.
  'system.housekeeping',
  // One site's malware scan, in its server's `scan:<id>` lane beside that site's other jobs.
  'site.malwareScan',
  'plugin.zipCheck',
  // "Reinstall original": a package a scan found changed, downloaded again at its version.
  'wp.reinstall',
] as const;
export type JobType = (typeof jobTypes)[number];

/**
 * How a job came to be queued: an admin in the panel, a request carrying an API key, an AI
 * client's tool call over MCP, a schedule, or the panel itself (a handler's follow-up, a boot
 * sweep). Stored per job, so the list can say "Nightly backups" or 'Claude via MCP (approved
 * by andy)' instead of leaving the reader to guess.
 */
export const jobOrigins = ['user', 'api', 'mcp', 'schedule', 'system'] as const;
export type JobOrigin = (typeof jobOrigins)[number];

/** How the Jobs page groups job types; see shared/jobTypes.ts. */
export const jobCategories = ['sites', 'backups', 'wordpress', 'files', 'security', 'servers', 'system'] as const;
export type JobCategory = (typeof jobCategories)[number];

export const backupTypes = ['manual', 'scheduled', 'pre_restore', 'pre_update', 'final', 'move', 'panel'] as const;
export type BackupType = (typeof backupTypes)[number];

/** Which kinds of backup a destination copies. The transient ones are excluded by default. */
export const offsiteCopyTypes = [
  'scheduled',
  'manual',
  'final',
  'panel',
  'pre_restore',
  'pre_update',
  'move',
] as const;
export const DEFAULT_COPY_TYPES = ['scheduled', 'manual', 'final', 'panel'] as const;

export const copyStatuses = ['pending', 'uploading', 'complete', 'failed'] as const;
export type CopyStatus = (typeof copyStatuses)[number];

/** Delivery outcome of one recipient, as reconstructed from the postfix log. */
export const mailStatuses = ['queued', 'sent', 'deferred', 'bounced', 'expired', 'rejected'] as const;
export type MailStatusName = (typeof mailStatuses)[number];

export const serverKinds = ['local', 'ssh'] as const;
export type ServerKind = (typeof serverKinds)[number];

export const serverStatuses = ['ok', 'unreachable', 'provisioning', 'error'] as const;
export type ServerStatus = (typeof serverStatuses)[number];

export const errorCodes = [
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'job_conflict',
  // A conditional file write whose condition failed: the file changed since it was read,
  // or already exists when it was to be created (RFC 9110 412).
  'precondition_failed',
  // A PHP file that does not parse, refused before it replaced the working one.
  'syntax_error',
  'bad_gateway',
  // A command ran past its time limit and was stopped (HTTP 504).
  'timeout',
  // The panel is mid-update and refusing writes until the new one takes over.
  'maintenance',
  'internal',
] as const;
export type ErrorCode = (typeof errorCodes)[number];

// ---------------------------------------------------------------------------
// Auth

export const loginBody = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
}).strict();

/**
 * The name the panel login box is answered with. No spaces and no empty edges on purpose:
 * it is compared exactly, so a trailing space would become an invisible reason the password
 * "stopped working". Only new names are held to this - whatever PANEL_ADMIN_USER seeded on
 * first boot keeps working untouched.
 */
export const panelUsernameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._@-]{3,60}$/, 'username must be 3-60 chars of a-z, 0-9 and . _ @ -');

/** A password a person will type to sign in. The rule is the same for every account. */
const newPanelPasswordSchema = z.string().min(10).max(200);

/**
 * The caller's own password, re-proved in front of a change to a login - their own or a
 * colleague's. On a colleague's account it is still the caller's: a password gets reset
 * precisely because nobody knows the old one any more.
 */
const callerPasswordSchema = z.string().min(1).max(200);

export const userCreateBody = z.object({
  username: panelUsernameSchema,
  /** The new admin's first password; they can change it on their own page. */
  password: newPanelPasswordSchema,
}).strict();

export const userRenameBody = z.object({
  password: callerPasswordSchema,
  username: panelUsernameSchema,
}).strict();

export const userPasswordBody = z.object({
  password: callerPasswordSchema,
  newPassword: newPanelPasswordSchema,
}).strict();

/**
 * A recovery address. It is not the recovery address yet: that takes following the link the
 * panel sends to it, so the address a reset link goes to is always one somebody reads.
 */
export const userEmailBody = z.object({
  password: callerPasswordSchema,
  email: z.email().max(254),
}).strict();

/** "Forgot your password?" - the username, or the account's confirmed recovery address. */
export const forgotPasswordBody = z.object({
  login: z.string().trim().min(1).max(254),
}).strict();

/** The token from an emailed link, as the page read it out of the part after the `#`. */
const emailedTokenSchema = z.string().min(20).max(200);

export const resetPasswordBody = z.object({
  token: emailedTokenSchema,
  newPassword: newPanelPasswordSchema,
}).strict();

export const confirmEmailBody = z.object({
  token: emailedTokenSchema,
}).strict();

/** Either a six-digit TOTP code or a recovery code; the server tells them apart. */
export const twoFactorCodeSchema = z.string().min(6).max(64);

export const twoFactorCodeBody = z.object({
  code: twoFactorCodeSchema,
}).strict();

/** Re-proving the caller's password guards every change to a second factor. */
export const passwordConfirmBody = z.object({
  password: callerPasswordSchema,
}).strict();

// ---------------------------------------------------------------------------
// Sites

export const sitePluginSelection = z.object({
  /**
   * Left out, the catalog's default plugins - the ones the New Site wizard starts with ticked -
   * so a site made through the API gets the stack a site made in the panel does. `[]` installs
   * none of the catalog.
   */
  catalogIds: z.array(z.number().int().positive()).max(100).optional(),
  extraWporgSlugs: z.array(z.string().regex(/^[a-z0-9-]{1,100}$/)).max(50).default([]),
}).strict();

export const siteCreateBody = z.object({
  title: z.string().min(1).max(200),
  slug: slugSchema.optional(),
  /** Target server; defaults to the `site.defaultServerId` setting (server 1). */
  serverId: z.number().int().positive().optional(),
  domainMode: z.enum(['dev', 'custom']).default('dev'),
  domains: z.array(domainSchema).min(1).max(10).optional(),
  phpVersion: phpVersionSchema.optional(),
  locale: localeSchema.optional(),
  adminUser: z.string().regex(/^[a-zA-Z0-9._@ -]{1,60}$/),
  /** Left out, the `defaultAdminEmail` setting; refused when that is empty too. */
  adminEmail: z.email().optional(),
  adminPassword: z.string().min(10).max(200).optional(),
  plugins: sitePluginSelection.optional(),
  /**
   * WordPress's "Discourage search engines from indexing this site" (Settings -> Reading).
   * On by default: a new site is reachable on its dev hostname from the first minute, and an
   * indexed dev copy competing with the customer's real site is far more expensive to undo
   * than a checkbox. Nothing flips it back - the site has to be released for indexing in
   * WordPress once it is live.
   */
  discourageSearchEngines: z.boolean().default(true),
}).strict()
  .refine((v) => v.domainMode === 'dev' || (v.domains && v.domains.length > 0), {
    message: 'domains required when domainMode is "custom"',
    path: ['domains'],
  });

export const goLiveBody = z.object({
  domains: z.array(domainSchema).min(1).max(10),
  keepDevAlias: z.boolean().default(true),
  /** Create/point the A records via the DNS provider API when the zone is in the account. */
  manageDns: z.boolean().default(false),
}).strict();

export const domainsUpdateBody = z.object({
  domains: z.array(domainSchema).min(1).max(10),
}).strict();

export const phpUpdateBody = z.object({
  phpVersion: phpVersionSchema,
}).strict();

export const siteDeleteQuery = z.object({
  // stringbool, not coerce.boolean: z.coerce.boolean() is Boolean(input), so "false" would be true.
  finalBackup: z.stringbool().default(true),
}).strict();

export const siteMoveBody = z.object({
  targetServerId: z.number().int().positive(),
  /** Source freeze while copying. Defaults: live site → 'maintenance', dev site → 'none'. */
  quiesce: z.enum(['maintenance', 'stop', 'none']).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Servers

export const serverNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, 'name must be 2-40 chars of a-z, 0-9 and dashes');

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export const serverCreateBody = z.object({
  name: serverNameSchema,
  sshHost: z.string().min(1).max(253),
  sshPort: z.number().int().min(1).max(65535).default(22),
  sshUser: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default('wpl7-panel'),
  /** Auto-detected during verify/provision when omitted. */
  publicIp: z.string().regex(IPV4_RE, 'not a valid IPv4 address').optional(),
  devDomain: domainSchema,
  dnsProvider: z.string().max(40).default(''),
  /** true = blank VPS: connect as rootUser and run the provisioner (202 job). */
  provision: z.boolean().default(false),
  rootUser: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default('root'),
  acmeEmail: z.email().optional(),
}).strict();

export const serverUpdateBody = z.object({
  name: serverNameSchema.optional(),
  sshHost: z.string().min(1).max(253).optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
  publicIp: z.string().regex(IPV4_RE, 'not a valid IPv4 address').optional(),
  devDomain: domainSchema.optional(),
  dnsProvider: z.string().max(40).optional(),
  /** Clear the pinned host key (after a legitimate server reinstall). */
  retrustHostKey: z.boolean().optional(),
  /** Where this server keeps its backups; null goes back to `<SRV_ROOT>/backups`. */
  backupRoot: z.union([z.string().max(4096), z.null()]).optional(),
}).strict();

/** `?refresh=true` bypasses the minute-long cache behind the system-info reading. */
export const serverInfoQuery = z.object({
  refresh: z.stringbool().default(false),
}).strict();

/** `?path=` asks the storage endpoint to describe a candidate instead of the current one. */
export const serverStorageQuery = z.object({
  path: z.string().max(4096).optional(),
}).strict();

export const backupRelocateBody = z.object({
  /** Absolute path to move this server's existing backups to; also becomes its location. */
  to: z.string().min(1).max(4096),
}).strict();

export const serverDeleteQuery = z.object({
  /** Allow deletion even when backup rows still point at this server. */
  force: z.stringbool().default(false),
}).strict();

// ---------------------------------------------------------------------------
// Backups

export const backupCreateBody = z.object({
  note: z.string().max(500).optional(),
}).strict();

export const backupRestoreBody = z.object({
  skipPreRestoreBackup: z.boolean().default(false),
}).strict();

export const backupDeleteQuery = z.object({
  /**
   * Default false: "delete" means gone, including from the bucket. Keeping the offsite
   * copies is the deliberate, opt-in variant.
   */
  keepOffsite: z.stringbool().default(false),
}).strict();

export const backupOffsiteBody = z.object({
  /** Omitted = every enabled destination that has not got this backup yet. */
  destinationId: z.number().int().positive().optional(),
}).strict();

export const backupFetchBody = z.object({
  destinationId: z.number().int().positive(),
}).strict();

/** GET /api/backups: every backup the panel knows of, newest first. */
export const backupsListQuery = z.object({
  /** One site's backups - a deleted site's too. `panel` is the panel's own snapshots. */
  siteSlug: z.string().max(64).optional(),
  /**
   * true = only the backups of sites that no longer exist; false = everything else (the sites
   * there are, and the panel's own snapshots).
   */
  deleted: z.stringbool().optional(),
  type: commaList(backupTypes),
  /** Backups whose files are on this server - or were, for one that is only offsite now. */
  serverId: queryNumber(z.coerce.number().int().positive().optional()),
  limit: queryNumber(z.coerce.number().int().min(1).max(200).default(50)),
  offset: queryNumber(z.coerce.number().int().min(0).default(0)),
}).strict();

export const offsiteEnabledBody = z.object({
  /** false = this site's backups are never copied offsite. */
  enabled: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// Offsite destinations

export const retentionModes = ['panel', 'external'] as const;
export type RetentionMode = (typeof retentionModes)[number];

/** 'crypt' = encrypt every byte and file name before it leaves the server. */
export const encryptionModes = ['none', 'crypt'] as const;
export type EncryptionMode = (typeof encryptionModes)[number];

/** What to do about backups that already exist when a destination is added. */
export const backfillModes = ['none', 'latest', 'all'] as const;

const destinationPolicy = {
  name: z.string().min(1).max(100),
  enabled: z.boolean().optional(),
  copyTypes: z.array(z.enum(offsiteCopyTypes)).min(1).max(offsiteCopyTypes.length).optional(),
  /** 0 = keep every scheduled backup at this destination. */
  retentionScheduled: z.number().int().min(0).max(10_000).optional(),
  retentionMode: z.enum(retentionModes).optional(),
  /** rclone --bwlimit syntax, timetables included. Empty clears it. */
  bwlimit: z.string().max(200).optional(),
  encryption: z.enum(encryptionModes).optional(),
  /**
   * Adopt an existing passphrase instead of generating one - how a destination is re-added
   * after losing `panel.db`, so its backups stay readable. Both halves or neither.
   */
  cryptPassword: z.string().max(512).optional(),
  cryptSalt: z.string().max(512).optional(),
};

export const destinationCreateBody = z
  .object({ ...destinationPolicy, backfill: z.enum(backfillModes).default('none') })
  .loose();

export const destinationUpdateBody = z
  .object({ ...destinationPolicy, name: destinationPolicy.name.optional() })
  .loose();

export const destinationDeleteQuery = z.object({
  /** true = purge the objects this panel wrote as well (never the whole prefix). */
  deleteRemote: z.stringbool().default(false),
}).strict();

export const destinationCopiesQuery = z.object({
  status: z.enum(copyStatuses).optional(),
  limit: queryNumber(z.coerce.number().int().min(1).max(200).default(50)),
  offset: queryNumber(z.coerce.number().int().min(0).default(0)),
}).strict();

// ---------------------------------------------------------------------------
// WordPress management

export const wpPluginInstallBody = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('wporg'), slug: z.string().regex(/^[a-z0-9-]{1,100}$/) }).strict(),
    z.object({ kind: z.literal('catalog'), id: z.number().int().positive() }).strict(),
  ]),
  activate: z.boolean().default(true),
}).strict();

export const wpResetPasswordBody = z.object({
  user: z.string().min(1).max(100),
}).strict();

export const wpMaintenanceBody = z.object({
  enabled: z.boolean(),
}).strict();

export const wpTestEmailBody = z.object({
  to: z.email(),
}).strict();

/** How long a queued command may run before the container's `timeout` stops it. */
export const execTimeoutMin = z.number().int().min(1).max(60).default(10);

export const wpCliArgs = z.array(z.string().max(500)).min(1).max(50);

/** The most a WP-CLI command may be handed on its stdin, in UTF-8 bytes - what the command reads. */
const WP_CLI_MAX_STDIN = 64 * 1024;

/**
 * Text for a WP-CLI command's stdin, followed by end-of-file: what `-` stands for in
 * `wp godmode chat send <id> --message=-`, or the values `--prompt=user_pass` asks for, one per
 * line. It is how wp-cli is handed a value too long for an argument, or one that should not be in
 * one: a command line is written into the job's summary and log, and stdin never is.
 */
export const wpCliStdin = z
  .string()
  .refine(
    (s) => utf8Bytes(s) <= WP_CLI_MAX_STDIN,
    `stdin may be at most ${WP_CLI_MAX_STDIN / 1024} KB, counted in UTF-8 bytes`,
  );

/**
 * Does this `wp` command wait on a WP Godmode chat? `godmode chat wait`, or a `godmode` command
 * given a `--wait` above 0 (`chat send`, `chat answer`, `agent create`) or one it may be handed on
 * stdin through `--prompt`. As a job, such a command holds its server's exec lane - every other
 * site's commands there - for as long as it waits, which is why `POST /wp/cli {async: true}` and
 * custom schedules refuse it: the Godmode endpoints wait without holding anything. It keeps the
 * easy mistake out of the lane, and is not a fence - a `wp eval` that runs one is not caught.
 */
export function waitsOnGodmode(args: readonly string[]): boolean {
  const words = args.filter((a) => !a.startsWith('-'));
  if (words[0] !== 'godmode') return false;
  if (words[1] === 'chat' && words[2] === 'wait') return true;
  return args.some((arg) => {
    const flag = /^--(wait|prompt)(?:=([\s\S]*))?$/.exec(arg);
    if (!flag) return false;
    const [, name, value] = flag;
    // A bare --prompt asks for every argument, --wait among them.
    if (name === 'prompt') return value === undefined || value.split(',').some((key) => key.trim() === 'wait');
    // WP-CLI hands a bare `--wait` over as true and `--wait=` as '': WP Godmode waits on neither.
    // It reads a number with PHP's `$`, which lets a trailing newline through, hence the trim.
    const seconds = value === undefined || value.trim() === '' ? 0 : Number(value.trim());
    return Number.isFinite(seconds) && seconds > 0;
  });
}

/** Why a WP Godmode wait is refused as a job, in the words the API and the schedules both use. */
export const GODMODE_WAIT_REFUSAL =
  'A WP Godmode wait cannot run as a job: it would hold the command lane of every site on its server while it ' +
  'waits. Wait on the chat with GET /api/sites/<slug>/godmode/chats/<chatId>?wait=40 instead, or run the command ' +
  'without "async", within the request.';

export const wpCliBody = z.object({
  args: wpCliArgs,
  stdin: wpCliStdin.optional(),
  /** Queue a `wp.cli` job (202) instead of answering within the request's ~55 s. */
  async: z.boolean().default(false),
  /** Async runs only; a synchronous run is bounded by the request. */
  timeoutMin: execTimeoutMin,
}).strict();

/** A shell command for a site's container: `sh -c <command>` as www-data, always queued. */
export const siteShellCommand = z
  .string()
  .max(4000)
  .refine((c) => c.trim().length > 0, 'the command is empty');

export const siteShellBody = z.object({
  command: siteShellCommand,
  timeoutMin: execTimeoutMin,
}).strict();

export const wpRestMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type WpRestMethod = (typeof wpRestMethods)[number];

/**
 * A REST route as typed - `wp/v2/posts?per_page=5`, or pasted as `/wp-json/wp/v2/posts` - split
 * into the route WordPress matches (`/wp/v2/posts`) and the query string after it.
 */
export function splitRestRoute(input: string): { route: string; query: string } {
  const text = input.trim();
  const q = text.indexOf('?');
  let path = (q === -1 ? text : text.slice(0, q)).replace(/^\/+/, '');
  if (path === 'wp-json' || path.startsWith('wp-json/')) path = path.slice('wp-json'.length).replace(/^\/+/, '');
  return { route: `/${path}`, query: q === -1 ? '' : text.slice(q + 1) };
}

/** `/wp-json/wp/v2/posts?per_page=5` - how the route is written wherever a person reads it. */
export function restRouteText(input: string): string {
  const { route, query } = splitRestRoute(input);
  return `/wp-json${route}${query ? `?${query}` : ''}`;
}

/** The part of the address after /wp-json/. Always this site's own: never a whole URL. */
export const wpRestRoute = z
  .string()
  .trim()
  .min(1, 'the route is empty')
  .max(2000)
  .refine((r) => !/^[a-z][a-z0-9+.-]*:/i.test(r), 'give the route after /wp-json/ (wp/v2/posts), not a whole address')
  .refine((r) => !/[\s#\u0000-\u001f\u007f]/.test(r), 'a route has no spaces, "#" or control characters; percent-encode them');

/** The largest JSON body a request may carry, serialized. */
export const WP_REST_MAX_BODY = 64 * 1024;

/**
 * Signed in the way WordPress takes from outside: a user and one of their application
 * passwords (Users → Profile → Application Passwords), never the login password. Stored with
 * the schedule and never shown again; see docs/jobs.md.
 */
export const wpRestAuth = z
  .object({
    /** The user's login, or their email address. */
    username: z
      .string()
      .trim()
      .min(1, 'the username is empty')
      .max(100)
      .refine((u) => !/[:\u0000-\u001f\u007f]/.test(u), 'a username for HTTP Basic sign-in has no ":" or control characters'),
    /** As WordPress shows it, spaces and all - it ignores them. */
    applicationPassword: z
      .string()
      .min(1, 'the application password is empty')
      .max(200)
      .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), 'the application password has control characters in it'),
  })
  .strict();

/** One definition, so the JSON Schema a client reads has it once rather than per use. */
const jsonValue = z.json();

const wpRestFields = {
  method: z.enum(wpRestMethods).default('GET'),
  route: wpRestRoute,
  /** Sent as `application/json`. An object, or a list for the endpoints that take one. */
  body: z
    .union([z.record(z.string(), jsonValue), z.array(jsonValue)])
    .refine((b) => JSON.stringify(b).length <= WP_REST_MAX_BODY, `the body may be at most ${WP_REST_MAX_BODY / 1024} KB of JSON`)
    .optional(),
  auth: wpRestAuth.optional(),
};

const noBodyOnGet = (r: { method: WpRestMethod; body?: unknown }) => r.method !== 'GET' || r.body === undefined;
const noBodyOnGetIssue = { message: 'A GET request has no body; put its parameters in the query string', path: ['body'] };

/**
 * A request to one of a site's WordPress REST API routes, made from inside its own container
 * (src/services/wpRest.ts) - what a schedule's `wp.rest` action and a `wp.rest` job carry.
 */
export const wpRestRequest = z
  .object({ ...wpRestFields, timeoutMin: execTimeoutMin })
  .strict()
  .refine(noBodyOnGet, noBodyOnGetIssue);
export type WpRestRequest = z.infer<typeof wpRestRequest>;

export const wpRestBody = z
  .object({
    ...wpRestFields,
    /** Queue a `wp.rest` job (202) instead of answering with the response. */
    async: z.boolean().default(false),
    /** Async runs only; a synchronous request is bounded by this one (~50 s). */
    timeoutMin: execTimeoutMin,
  })
  .strict()
  .refine(noBodyOnGet, noBodyOnGetIssue);

/**
 * A WP Godmode chat's id: a UUID, which the plugin writes in lower case - so one pasted in upper
 * case is taken, and lowered before it reaches `wp godmode`.
 */
export const godmodeChatId = z.guid('a chat id is a UUID').transform((id) => id.toLowerCase());

/** The longest `wait`: the answer is back well inside the ~55 s a request is given. */
export const GODMODE_MAX_WAIT_S = 40;

/**
 * Reading a WP Godmode chat. `wait` above 0 is `wp godmode chat wait` for up to that many seconds,
 * which answers early once nothing in the chat is working or something in it asks a question; 0,
 * the default, is `chat read`, at once. `after` is the turn cursor an earlier answer gave (-1: from
 * the start), and `last` how many turns a read shows when it has no `after` - the plugin ignores
 * it beside one, and a wait answers with its own digest. `pending` reads only the cards waiting for
 * an answer, in full: wait and read cut long plans (`plan_cut: true`) and texts
 * ("…[N characters cut]…"), and a card is shown to the user whole before it is answered.
 */
export const godmodeChatQuery = z
  .object({
    wait: queryNumber(z.coerce.number().int().min(0).max(GODMODE_MAX_WAIT_S).default(0)),
    // Blank is "not given" rather than 0, which would skip the chat's first turn.
    after: queryNumber(z.coerce.number().int().min(-1).optional()),
    last: queryNumber(z.coerce.number().int().min(1).max(50).optional()),
    pending: z.preprocess(emptyAsUnset, z.stringbool().optional()),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.last !== undefined && q.wait > 0) {
      ctx.addIssue({ code: 'custom', path: ['last'], message: '`last` is for reading a chat (wait=0); a wait answers with its own digest' });
    }
    if (q.last !== undefined && q.after !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['last'], message: '`last` counts back from the end; with `after` the read starts at the cursor instead' });
    }
    if (q.pending && (q.wait > 0 || q.after !== undefined || q.last !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['pending'], message: '`pending` reads the waiting cards alone: no `wait`, `after` or `last` beside it' });
    }
  });

/** `GET …/godmode/chats`: the chats WP Godmode's sidebar shows, or one chat's or agent's sub-chats. */
export const godmodeChatListQuery = z.object({ parent: godmodeChatId.optional() }).strict();

/**
 * A WP-CLI command to explain, as `wp help` takes it: its words, space-separated - `godmode`,
 * `godmode chat send`, `plugin list`. Words only, never a flag, so nothing but help can run.
 */
export const wpCliHelpQuery = z
  .object({
    command: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v),
      z
        .string()
        .max(200)
        .regex(/^([a-z0-9][a-z0-9_-]*( [a-z0-9][a-z0-9_-]*){0,5})?$/, 'a WP-CLI command: up to six words of a-z, 0-9, - and _, e.g. "godmode chat send"')
        .optional(),
    ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Files (Web FTP). Paths follow shared/siteFilePath.ts: relative to the site's WordPress
// folder, '' being the folder itself.

/** A path inside the site, normalised (`/wp-content/` -> `wp-content`); `''` is the site folder. */
export const sitePathSchema = z
  .string()
  .max(4096)
  .superRefine((s, ctx) => {
    const parsed = parseSiteFilePath(s);
    if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.problem });
  })
  .transform((s) => {
    const parsed = parseSiteFilePath(s);
    return parsed.ok ? parsed.path : '';
  });

/** Something inside the site - never the site folder itself, which nothing may move or delete. */
export const siteEntryPathSchema = sitePathSchema.refine((p) => p !== '', 'Name something inside the site folder');

/**
 * An entry the request may create or overwrite. The panel's own temporary files are off
 * limits: a save or an upload in progress must not be clobbered through the API.
 */
export const siteWritablePathSchema = siteEntryPathSchema.refine(
  (p) => !siteFileBase(p).startsWith(RESERVED_FILE_PREFIX),
  `Names starting with "${RESERVED_FILE_PREFIX}" are reserved for the panel`,
);

/** A path whose last name is a NEW one: the stricter rules of newFileNameProblem. */
export const siteNewPathSchema = siteEntryPathSchema.superRefine((p, ctx) => {
  const problem = newFileNameProblem(siteFileBase(p));
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

export const siteFilesQuery = z.object({
  path: sitePathSchema.default(''),
}).strict();

export const siteFileQuery = z.object({
  path: siteEntryPathSchema,
}).strict();

export const siteFileWriteQuery = z.object({
  path: siteWritablePathSchema,
  /** Refuse to save PHP that does not parse (`php -l` inside the container), with 422. */
  lint: z.enum(['php']).optional(),
}).strict();

export const siteUploadParams = z.object({
  slug: siteSlugParam,
  id: z.string().regex(UPLOAD_ID_RE, 'an upload id is 16-64 characters of A-Z, a-z, 0-9, _ and -'),
});

export const siteUploadQuery = z.object({
  path: siteNewPathSchema,
  /** Where this chunk goes: the number of bytes already received. */
  offset: queryNumber(z.coerce.number().int().min(0)),
  /** The size of the whole file; the chunk that completes it puts the file in place. */
  size: queryNumber(z.coerce.number().int().min(0).max(FILE_LIMITS.uploadBytes)),
  overwrite: z.stringbool().default(false),
}).strict();

export const siteUploadAbortQuery = z.object({
  path: siteNewPathSchema,
}).strict();

export const siteFileMkdirBody = z.object({
  path: siteNewPathSchema,
}).strict();

export const siteFileMoveBody = z.object({
  from: siteEntryPathSchema,
  to: siteNewPathSchema,
  overwrite: z.boolean().default(false),
}).strict();

export const siteFileCopyBody = z.object({
  from: siteEntryPathSchema,
  to: siteNewPathSchema,
}).strict();

export const siteFileDeleteBody = z.object({
  paths: z.array(siteEntryPathSchema).min(1).max(FILE_LIMITS.batchPaths),
}).strict();

export const siteFileChmodBody = z.object({
  path: siteEntryPathSchema,
  mode: z.string().regex(/^[0-7]{3}$/, 'mode is three octal digits, like 644'),
}).strict();

export const siteFileFixOwnershipBody = z.object({
  path: sitePathSchema.default(''),
}).strict();

const searchGlob = z.string().regex(/^[A-Za-z0-9_.*?\-]{1,50}$/, 'a file pattern is letters, digits, "." "_" "-" "*" and "?"');

export const siteFileSearchQuery = z.object({
  path: sitePathSchema.default(''),
  q: z
    .string()
    .min(1)
    .max(200)
    .refine((q) => !q.includes('\0') && !q.includes('\n'), 'the search text cannot contain NUL or a line break'),
  /** `name`: file and folder names. `content`: the text inside files (binary files are skipped). */
  mode: z.enum(['name', 'content']).default('name'),
  /** Match case exactly (default: ignore case). */
  case: z.stringbool().default(false),
  /** Content search only: `q` is an extended regular expression rather than plain text. */
  regex: z.stringbool().default(false),
  /** Content search only: comma-separated file patterns, e.g. `*.php,*.js`. */
  include: z
    .string()
    .max(500)
    .optional()
    .transform((raw) => (raw ? raw.split(',').map((g) => g.trim()).filter(Boolean) : []))
    .pipe(z.array(searchGlob).max(10)),
}).strict();

export const siteFileExtractBody = z.object({
  path: siteEntryPathSchema.refine((p) => /\.zip$/i.test(p), 'only .zip archives can be extracted'),
  /** The folder to extract into; it must exist. Default: the site folder. */
  to: sitePathSchema.default(''),
  overwrite: z.boolean().default(false),
}).strict();

export const siteFileCompressBody = z.object({
  /** Entries of ONE folder, compressed together. */
  paths: z.array(siteEntryPathSchema).min(1).max(FILE_LIMITS.batchPaths),
  /** The archive to write, in that same folder. */
  to: siteNewPathSchema.refine((p) => /\.zip$/i.test(p), 'the archive name must end in .zip'),
  overwrite: z.boolean().default(false),
}).strict();

// ---------------------------------------------------------------------------
// Plugin recipes and license keys (shared/recipes.ts)

export const recipeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'not a recipe id');

/** A value for one of a recipe's inputs - a license key, an account email. */
export const recipeInputBody = z.object({
  value: z.string().trim().min(1).max(500),
}).strict();

/** Which recipe hook to run from the site page; `afterInstall` is what "Activate" means. */
export const licenseApplyBody = z.object({
  recipeId: recipeIdSchema.optional(),
  hook: z.enum(['afterInstall', 'verify']).default('afterInstall'),
}).strict();

export const recipeEnabledBody = z.object({
  enabled: z.boolean(),
}).strict();

/** A recipe of the operator's own, in the catalog's format; validated against it on arrival. */
export const localRecipeBody = z.object({
  recipe: z.record(z.string(), z.unknown()),
}).strict();

// ---------------------------------------------------------------------------
// WordPress inventory, bulk management and vulnerabilities

/** What the snapshot holds per site. `core` is one row per site, not one per slug. */
export const wpComponentKinds = ['plugin', 'theme', 'core'] as const;
export type WpComponentKind = (typeof wpComponentKinds)[number];

/**
 * What a bulk run does to its targets. `core-update` is its own action rather than
 * `update` on kind `core` because the fleet page picks one action for a whole selection,
 * and "update these plugins" must not be able to drag a core upgrade along with it.
 */
export const wpBulkActions = ['update', 'activate', 'deactivate', 'delete', 'core-update'] as const;
export type WpBulkAction = (typeof wpBulkActions)[number];

/** Per-component operations, in the order the job runs them. */
export const wpComponentActions = ['update', 'activate', 'deactivate', 'delete'] as const;
export type WpComponentAction = (typeof wpComponentActions)[number];

export const wpBulkOp = z
  .object({
    kind: z.enum(wpComponentKinds),
    /** Directory slug as wp-cli names it; omitted (and ignored) for `core`. */
    slug: wpPluginNameSchema.optional(),
    action: z.enum(wpComponentActions),
  })
  .strict()
  .refine((op) => (op.kind === 'core' ? op.action === 'update' : !!op.slug), {
    message: 'plugin and theme operations need a slug; core only supports "update"',
  });

/** Single-site bulk run: the site page's "Update all" and "Fix vulnerable" buttons. */
export const wpBulkOpsBody = z
  .object({
    ops: z.array(wpBulkOp).min(1).max(300),
    /** Take a `pre_update` backup before touching anything. */
    backupFirst: z.boolean().default(false),
    /** Ask the site for its home page afterwards and fail the job when it stops answering. */
    healthCheck: z.boolean().default(true),
  })
  .strict();

/** Fleet-wide run: one action, many (site, component) targets, one batch. */
export const wpFleetBulkBody = z
  .object({
    action: z.enum(wpBulkActions),
    targets: z
      .array(
        z
          .object({
            siteSlug: siteSlugParam,
            kind: z.enum(wpComponentKinds),
            slug: wpPluginNameSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
    backupFirst: z.boolean().default(false),
    healthCheck: z.boolean().default(true),
  })
  .strict();

export const wpInventoryFilters = ['updates', 'vulnerable', 'inactive', 'closed'] as const;
export type WpInventoryFilter = (typeof wpInventoryFilters)[number];

export const wpInventoryQuery = z
  .object({
    kind: z.enum(wpComponentKinds).default('plugin'),
    /**
     * Comma-separated and AND-ed, because the filter chips combine: "Vulnerable" plus
     * "Has update" is exactly the set that one click of *Update* can fix.
     */
    filter: z
      .string()
      .max(100)
      .optional()
      .transform((raw) => (raw ? raw.split(',').map((f) => f.trim()).filter(Boolean) : []))
      .pipe(z.array(z.enum(wpInventoryFilters)).max(4)),
    /** Substring match on slug and title. */
    q: z.string().max(100).optional(),
    serverId: queryNumber(z.coerce.number().int().positive().optional()),
    siteSlug: z.string().max(64).optional(),
    /**
     * Stopped sites are hidden by default: nothing can be installed or updated in a
     * container that is not running, so offering their components invites jobs that spend
     * their time starting and stopping a site nobody asked to wake.
     */
    includeStopped: z.stringbool().default(false),
  })
  .strict();

export const wpBatchesQuery = z
  .object({
    limit: queryNumber(z.coerce.number().int().min(1).max(50).default(10)),
  })
  .strict();

// ---------------------------------------------------------------------------
// Plugin catalog

export const pluginCreateBody = z.object({
  kind: z.literal('wporg'),
  slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
  name: z.string().min(1).max(200).optional(),
  isDefault: z.boolean().default(false),
  /**
   * Skip the wordpress.org existence check. Only for installs whose panel has no outbound
   * internet access - a slug that is not in the directory cannot be installed by `wp`.
   */
  force: z.boolean().default(false),
}).strict();

export const pluginSearchQuery = z.object({
  q: z.string().min(2, 'Type at least 2 characters to search').max(100),
  page: queryNumber(z.coerce.number().int().min(1).max(50).default(1)),
}).strict();

export const pluginUpdateBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()
  // Both fields optional means `{}` validates, and drizzle then throws "No values to set"
  // as a 500. Require at least one so it is a plain 400.
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one of "name" or "isDefault"',
  });

// ---------------------------------------------------------------------------
// Jobs

export const jobsListQuery = z.object({
  status: commaList(jobStatuses),
  type: commaList(jobTypes),
  category: commaList(jobCategories),
  origin: commaList(jobOrigins),
  /**
   * `#123` (or a bare number) is that job. Anything else is a case-insensitive substring of
   * the summary, type, site, error or who started it - or of a job type's label.
   */
  q: z.string().trim().max(200).optional(),
  siteSlug: z.string().max(64).optional(),
  /** Jobs on this server, including the ones in its named lanes (offsite:<id>, exec:<id>). */
  serverId: queryNumber(z.coerce.number().int().positive().optional()),
  /** Every job one schedule created (see GET /schedules). */
  scheduleId: queryNumber(z.coerce.number().int().positive().optional()),
  /** All the jobs of one bulk run (see POST /wp/bulk). */
  batchId: queryNumber(z.coerce.number().int().positive().optional()),
  /** Queued at or after / before this time (ms since the epoch). */
  since: queryNumber(z.coerce.number().int().min(0).optional()),
  until: queryNumber(z.coerce.number().int().min(0).optional()),
  limit: queryNumber(z.coerce.number().int().min(1).max(200).default(50)),
  offset: queryNumber(z.coerce.number().int().min(0).default(0)),
}).strict();

export const jobDetailQuery = z.object({
  logAfter: queryNumber(z.coerce.number().int().min(0).default(0)),
}).strict();

// ---------------------------------------------------------------------------
// API keys / settings / monitor

/**
 * A question or an idea, on its way to the project's community. Bugs and feature requests
 * never come here - the browser opens those as GitHub issues under the sender's own account.
 */
export const feedbackBody = z
  .object({
    summary: z.string().min(1).max(120),
    details: z.string().min(1).max(8000),
    /** The build-and-machine block the dialog showed, or empty when it was switched off. */
    environment: z.string().max(2000).default(''),
  })
  .strict();

export const apiKeyCreateBody = z.object({
  name: z.string().min(1).max(100),
  /** Full unless asked otherwise, so a script that creates keys gets what it always got. */
  access: z.enum(accessLevels).default('full'),
}).strict();

// ---------------------------------------------------------------------------
// MCP and its OAuth sign-in (docs/mcp.md)

/** The approval page sends its own query string as it is: what it shows is what is used. */
export const oauthCheckBody = z.object({
  query: z.string().max(8192),
}).strict();

export const oauthDecisionBody = z.object({
  query: z.string().max(8192),
  approve: z.boolean(),
  /** The admin's choice, whatever the app asked for. Read only unless they picked more. */
  access: z.enum(accessLevels).default('read'),
}).strict();

export const mcpConnectionUpdateBody = z.object({
  access: z.enum(accessLevels),
}).strict();

/** The API activity log's filters. `hours: 0` means "everything still stored". */
export const apiActivityQuery = z.object({
  keyId: queryNumber(z.coerce.number().int().positive().optional()),
  outcome: z.enum(['ok', 'error', 'denied']).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  /** Substring of the request path. */
  search: z.string().max(200).optional(),
  hours: queryNumber(z.coerce.number().int().min(0).max(24 * 365).default(24)),
  limit: queryNumber(z.coerce.number().int().min(1).max(200).default(50)),
  offset: queryNumber(z.coerce.number().int().min(0).default(0)),
}).strict();

export const backupsEnabledBody = z
  .object({
    /** false = the scheduled run skips this site; every other backup still runs. */
    enabled: z.boolean(),
  })
  .strict();

export const mailSuspensionBody = z
  .object({
    suspended: z.boolean(),
    reason: z.string().max(200).optional(),
  })
  .strict();

export const settingsUpdateBody = z.object({
  backupCron: z.string().min(9).max(100).optional(),
  backupRetention: z.number().int().min(1).max(365).optional(),
  monitorUptimeIntervalSec: z.number().int().min(15).max(3600).optional(),
  monitorStatsIntervalSec: z.number().int().min(15).max(3600).optional(),
  monitorDuIntervalMin: z.number().int().min(5).max(1440).optional(),
  monitorRetentionDays: z.number().int().min(1).max(90).optional(),
  jobsRetentionDays: z.number().int().min(7).max(365).optional(),
  mailRetentionDays: z.number().int().min(1).max(365).optional(),
  /** How long the API request log is kept (API keys -> Activity). */
  apiActivityRetentionDays: z.number().int().min(1).max(365).optional(),
  trafficRetentionDays: z.number().int().min(1).max(730).optional(),
  trafficIpRetentionDays: z.number().int().min(1).max(90).optional(),
  trafficStoreIps: z.boolean().optional(),
  mailAlertPerSitePerHour: z.number().int().min(10).max(100000).optional(),
  /** 0 = never suspend a site's mail automatically. */
  mailSuspendPerSitePerHour: z.number().int().min(0).max(1000000).optional(),
  alertEmail: z.union([z.email(), z.literal('')]).optional(),
  /** 0 = uncapped. Fractional cores allowed. */
  siteCpuLimit: z.number().min(0).max(64).optional(),
  siteMemoryLimitMb: z.number().int().min(128).max(65536).optional(),
  /** 0 = uncapped. */
  sitePidsLimit: z.number().int().min(0).max(100000).optional(),
  defaultPhpVersion: phpVersionSchema.optional(),
  defaultLocale: localeSchema.optional(),
  /** Prefilled in the New Site wizard and used by a create that leaves it out. '' = none. */
  defaultAdminEmail: z.union([z.email(), z.literal('')]).optional(),
  phpVersions: z.array(phpVersionSchema).min(1).max(10).optional(),
  defaultServerId: z.number().int().positive().optional(),
  /** How often the panel re-reads every site's plugin/theme/core state. */
  wpScanIntervalHours: z.number().int().min(1).max(168).optional(),
  /** false = stop asking wpvulnerability.net about installed slugs (nothing leaves the box). */
  vulnerabilityFeed: z.boolean().optional(),
  /** FTP/SFTP logins: the fleet-wide switch, and the host ports every server's gateway uses. */
  ftpEnabled: z.boolean().optional(),
  ftpSftpPort: z.number().int().min(1).max(65535).optional(),
  ftpOfferFtps: z.boolean().optional(),
  ftpPort: z.number().int().min(1).max(65535).optional(),
  ftpPassivePortStart: z.number().int().min(1024).max(65535).optional(),
  ftpPassivePortEnd: z.number().int().min(1024).max(65535).optional(),
  /** Cloudflare on or off, and the operator's own proxies (docs/security.md). */
  securityTrustedProxies: trustedProxiesSchema.optional(),
  /** The default protection level, and what the default changes on top of it. */
  securityLevel: z.enum(securityLevels).optional(),
  securityOverrides: securityOverridesSchema.optional(),
  securityBypassPrivate: z.boolean().optional(),
  /** Automatic blocking: on, observe (record only) or off. */
  securityAutoBlock: z.enum(autoBlockModes).optional(),
  /** false = blocks stay on the list but reach no server. */
  securityEnforcement: z.boolean().optional(),
  securityRules: detectionRulesSchema.optional(),
  securityBlockMinutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
  securityBlockMultiplier: z.number().int().min(1).max(10).optional(),
  securityBlockMaxDays: z.number().int().min(1).max(365).optional(),
  securityMaxActiveBlocks: z.number().int().min(100).max(50_000).optional(),
  securityHistoryDays: z.number().int().min(1).max(365).optional(),
  scanEnabled: z.boolean().optional(),
  scanSignatures: z.boolean().optional(),
  scanIntervalHours: z.number().int().min(1).max(24 * 30).optional(),
  scanOnFinding: z.enum(scanOnFindingModes).optional(),
  scanMemoryMb: z.number().int().min(256).max(4096).optional(),
  scanTimeoutMin: z.number().int().min(5).max(240).optional(),
  /** 0 = quarantined files are kept until deleted by hand. */
  scanQuarantineKeepDays: z.number().int().min(0).max(3650).optional(),
  /** The MCP server for AI apps (docs/mcp.md); needs PANEL_DOMAIN and TLS in production. */
  mcpEnabled: z.boolean().optional(),
}).strict();

export const historyQuery = z.object({
  hours: queryNumber(z.coerce.number().int().min(1).max(168).default(24)),
}).strict();

export const siteTrafficQuery = z.object({
  /** <= 2 gives hourly buckets, more gives daily ones (services/traffic.ts). */
  days: queryNumber(z.coerce.number().int().min(1).max(365).default(30)),
}).strict();

// ---------------------------------------------------------------------------
// Mail

export const mailMessagesQuery = z.object({
  siteSlug: z.string().max(64).optional(),
  status: z.enum(mailStatuses).optional(),
  serverId: queryNumber(z.coerce.number().int().positive().optional()),
  /** Substring match on sender and recipient. */
  search: z.string().max(200).optional(),
  hours: queryNumber(z.coerce.number().int().min(1).max(24 * 90).optional()),
  limit: queryNumber(z.coerce.number().int().min(1).max(500).default(100)),
  offset: queryNumber(z.coerce.number().int().min(0).default(0)),
}).strict();

export const mailStatsQuery = z.object({
  hours: queryNumber(z.coerce.number().int().min(1).max(24 * 30).default(24)),
}).strict();

export const mailQueueQuery = z.object({
  serverId: queryNumber(z.coerce.number().int().positive().optional()),
}).strict();

export const mailTestBody = z.object({
  serverId: z.number().int().positive().optional(),
  /** Envelope sender; pick a domain that has a DKIM key to exercise signing too. */
  from: z.email(),
  to: z.email(),
  subject: z.string().min(1).max(200).optional(),
}).strict();

export const mailHostnameBody = z.object({
  /** The name postfix announces in HELO; needs its own A record and a matching PTR. */
  hostname: domainSchema,
}).strict();

export const mailDkimCreateBody = z.object({
  domain: domainSchema,
  /** Replace the key of a domain that already has one (same selector). */
  rotate: z.boolean().default(false),
}).strict();

export const mailDomainsQuery = z.object({
  domain: z.string().max(253).optional(),
}).strict();

export const mailQueueActionParams = z.object({
  serverId: z.coerce.number().int().positive(),
  queueId: z.string().regex(/^(ALL|[A-Za-z0-9]{6,20})$/, 'not a valid postfix queue id'),
});

// ---------------------------------------------------------------------------
// FTP & SFTP logins (services/ftp.ts)

/**
 * 3-32 characters of a-z, 0-9 and . _ -, starting and ending with a letter or digit, so a
 * site's own slug always fits. What a client sends is lowercased and trimmed the same way
 * by the gateway, so "Alice " is "alice" at both ends.
 */
export const FTP_USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;

export const ftpUsernameSchema = z
  .string()
  .max(64)
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().regex(FTP_USERNAME_RE, 'username must be 3-32 chars of a-z, 0-9 and . _ -, starting and ending with a letter or digit'));

/** A password typed in rather than generated. Long, because FTP logins are what gets brute-forced. */
export const ftpPasswordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(128)
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s), 'password cannot contain control characters');

export const ftpUserCreateBody = z.object({
  username: ftpUsernameSchema,
  /** Leave out to have one generated; it is returned once, in the answer. */
  password: ftpPasswordSchema.optional(),
  /** Keep the login inside this folder of the site; '' (the default) = the whole site. */
  folder: sitePathSchema.default(''),
  /** Unix ms after which the login stops working; null = never. */
  expiresAt: z.number().int().positive().nullable().default(null),
}).strict();

export const ftpUserUpdateBody = z
  .object({
    folder: sitePathSchema.optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((b) => b.folder !== undefined || b.expiresAt !== undefined, 'Send a folder or an expiry to change');

export const ftpPasswordBody = z
  .object({
    /** Leave out to have one generated; it is returned once, in the answer. */
    password: ftpPasswordSchema.optional(),
  })
  .strict();

export const ftpUserParams = z.object({
  slug: siteSlugParam,
  id: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Inferred request types

export type LoginBody = z.infer<typeof loginBody>;
export type SiteCreateBody = z.infer<typeof siteCreateBody>;
export type GoLiveBody = z.infer<typeof goLiveBody>;
export type SettingsUpdateBody = z.infer<typeof settingsUpdateBody>;
export type MailSuspensionBody = z.infer<typeof mailSuspensionBody>;
export type BackupsEnabledBody = z.infer<typeof backupsEnabledBody>;
export type WpPluginInstallBody = z.infer<typeof wpPluginInstallBody>;
export type SiteMoveBody = z.infer<typeof siteMoveBody>;
export type ServerCreateBody = z.infer<typeof serverCreateBody>;
export type ServerUpdateBody = z.infer<typeof serverUpdateBody>;
export type MailTestBody = z.infer<typeof mailTestBody>;
export type MailHostnameBody = z.infer<typeof mailHostnameBody>;
export type MailMessagesQuery = z.infer<typeof mailMessagesQuery>;
export type ApiActivityQuery = z.infer<typeof apiActivityQuery>;
export type WpBulkOpsBody = z.infer<typeof wpBulkOpsBody>;
export type WpFleetBulkBody = z.infer<typeof wpFleetBulkBody>;
export type WpInventoryQuery = z.infer<typeof wpInventoryQuery>;
export type WpBulkOp = z.infer<typeof wpBulkOp>;
export type FtpUserCreateBody = z.input<typeof ftpUserCreateBody>;
export type FtpUserUpdateBody = z.input<typeof ftpUserUpdateBody>;

// ---------------------------------------------------------------------------
// Security (docs/security.md)

/** A site's own protection. Each part left out is kept as it is; `level: null` follows the default. */
export const siteSecurityUpdateBody = z
  .object({
    level: z.enum(securityLevels).nullable().optional(),
    overrides: securityOverridesSchema.optional(),
    customRules: customRulesSchema.optional(),
  })
  .strict();

/** A site's own scan settings; null follows the fleet's. */
export const scanSettingsBody = z
  .object({
    enabled: z.boolean().nullable().optional(),
    onFinding: z.enum(scanOnFindingModes).nullable().optional(),
  })
  .strict();

export const findingsQuery = z.object({
  status: z.enum([...findingStatuses, 'all']).default('open'),
});

export const scansRequestBody = z
  .object({
    /** Left out: every site that scans are on for. */
    slugs: z.array(siteSlugParam).min(1).max(1000).optional(),
  })
  .strict();

export const blockedRequestsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  rule: z.string().trim().max(80).optional(),
});

export const blockCreateBody = z
  .object({
    address: z.string().trim().min(2).max(64),
    /** How long; left out or null = until lifted. */
    minutes: z.number().int().min(1).max(365 * 24 * 60).nullable().optional(),
    note: z.string().trim().max(200).optional(),
    /** The site it was seen on, for the record. */
    siteSlug: siteSlugParam.optional(),
  })
  .strict();

export const blocksQuery = z.object({
  state: z.enum(['active', 'history']).default('active'),
  q: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const neverBlockCreateBody = z
  .object({
    address: z.string().trim().min(2).max(64),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

export const securityCheckQuery = z.object({ address: z.string().trim().min(2).max(64) });
