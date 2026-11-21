// @docs get-started/installation, reference/installer-and-scripts
/**
 * `install.sh --restore`: a new server installed from the panel's own nightly snapshot.
 *
 * A snapshot (jobs/handlers/offsite.ts, panelSnapshot) is a folder `panel/<YYYYMMDD-HHMMSS>/` with
 * `panel.db.gz`, `manifest.json` and `sha256sums`, copied to every offsite destination like any
 * backup. This finds the newest one at a destination, through the same provider catalog and rclone
 * wiring the panel copies with (shared/backupProviders.ts), or takes one downloaded by hand. It
 * checks it, puts `panel.db` in place for the panel's first start, and hands setup.sh what
 * deploy/.env needs from the old install, from the manifest. src/cli/restore.ts is the command.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { connectDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import {
  BACKUP_PROVIDERS,
  destinationProblems,
  providerByKey,
  rcloneRemoteFor,
  remoteJoin,
  remotePathFor,
  type CryptKey,
  type ProviderField,
  type RcloneRemote,
} from '../../shared/backupProviders.js';
import type { DockerPort, RunResult } from '../services/docker.js';
import { redactorFor } from '../services/offsite.js';
import { compareVersions } from '../services/updates.js';
import { shellQuote } from '../servers/sshExec.js';
import { confirm, type Prompter } from './prompt.js';

/** A snapshot's files, as panelSnapshot writes them. */
export const SNAPSHOT_DB = 'panel.db.gz';
export const SNAPSHOT_MANIFEST = 'manifest.json';
export const SNAPSHOT_SUMS = 'sha256sums';
/** The panel's backups live under its own slug: `<remote root>/panel/<timestamp>/`. */
const SNAPSHOT_SLUG = 'panel';

/** A snapshot folder's name: its UTC time, with `-2`, `-3`… when two were taken in the same second. */
const SNAPSHOT_NAME = /^(\d{8}-\d{6})(?:-(\d+))?$/;

// ---------------------------------------------------------------------------
// Which snapshot

export interface SnapshotEntry {
  /** The folder's name, `YYYYMMDD-HHMMSS`. */
  ts: string;
}

/** Newest first: by time, then by the suffix a second snapshot in the same second gets. */
export function compareSnapshotNames(a: string, b: string): number {
  const ma = SNAPSHOT_NAME.exec(a);
  const mb = SNAPSHOT_NAME.exec(b);
  if (!ma || !mb) return a < b ? 1 : a > b ? -1 : 0;
  if (ma[1] !== mb[1]) return ma[1]! < mb[1]! ? 1 : -1;
  return Number(mb[2] ?? 1) - Number(ma[2] ?? 1);
}

/**
 * The snapshots in an `rclone lsf -R --files-only` listing of `panel/`, newest first. Only a
 * folder with all three files counts: an upload cut short, by the old server going down for
 * instance, leaves one without them.
 */
export function snapshotsIn(listing: string): SnapshotEntry[] {
  const folders = new Map<string, Set<string>>();
  for (const raw of listing.split('\n')) {
    const [ts, file, ...deeper] = raw.trim().split('/');
    if (!ts || !file || deeper.length > 0 || !SNAPSHOT_NAME.test(ts)) continue;
    const files = folders.get(ts) ?? new Set<string>();
    files.add(file);
    folders.set(ts, files);
  }
  return [...folders]
    .filter(([, files]) => [SNAPSHOT_DB, SNAPSHOT_MANIFEST, SNAPSHOT_SUMS].every((f) => files.has(f)))
    .map(([ts]) => ({ ts }))
    .sort((a, b) => compareSnapshotNames(a.ts, b.ts));
}

/** `20261004-030000` as `2026-10-04 03:00 UTC`. */
export function describeSnapshot(ts: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(ts);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC` : ts;
}

// ---------------------------------------------------------------------------
// What the snapshot says

export interface SnapshotManifest {
  /** 1 before panelVersion and env were added, 2 since. */
  format: number;
  panelDomain: string | null;
  panelVersion: string | null;
  /** Format 2: the parts of deploy/.env the database does not hold. */
  env: Record<string, string>;
  /** The server the panel ran on, as the panel named it. */
  localServer: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export function parseManifest(source: string): SnapshotManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error(`${SNAPSHOT_MANIFEST} is not readable JSON.`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error(`${SNAPSHOT_MANIFEST} is not a manifest.`);
  const m = raw as Record<string, unknown>;
  if (m.type !== 'panel') {
    throw new Error(`This ${SNAPSHOT_MANIFEST} belongs to a site's backup, not to a panel snapshot.`);
  }
  const env: Record<string, string> = {};
  if (typeof m.env === 'object' && m.env !== null) {
    for (const [key, value] of Object.entries(m.env as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  const local = Array.isArray(m.servers)
    ? (m.servers as unknown[]).find(
        (s): s is { name: string } =>
          typeof s === 'object' && s !== null && (s as { kind?: unknown }).kind === 'local' && typeof (s as { name?: unknown }).name === 'string',
      )
    : undefined;
  return {
    format: typeof m.format === 'number' ? m.format : 1,
    panelDomain: text(m.panelDomain),
    panelVersion: text(m.panelVersion),
    env,
    localServer: local?.name ?? null,
  };
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * What deploy/.env takes back from a snapshot, in the order setup.sh applies it, and what each
 * value must look like. These go into compose's interpolation, Traefik's router rules among it, so
 * a value that does not fit is left out: setup.sh then asks for it, or uses its default.
 */
const ENV_RULES: [key: string, rule: RegExp][] = [
  ['PANEL_DOMAIN', HOSTNAME],
  ['DEV_DOMAIN', HOSTNAME],
  ['ACME_EMAIL', /^[^\s@]+@[^\s@]+$/],
  ['TLS_MODE', /^(letsencrypt|staging|none)$/],
  ['ACME_RESOLVER', /^(letsencrypt|letsencrypt-staging)$/],
  ['DNS_PROVIDER', /^[a-z0-9]+$/],
  ['WPL7_CHANNEL', /^(stable|edge)$/],
  ['MAIL_HOSTNAME', HOSTNAME],
  ['SMTP_RELAYHOST', /^\S+$/],
  ['SMTP_USERNAME', /^.+$/],
  ['SMTP_PASSWORD', /^.+$/],
  ['BACKUP_ROOT', /^\/(?!.*\.\.)[A-Za-z0-9._\-/]*$/],
  ['HETZNER_API_KEY', /^[A-Za-z0-9._-]+$/],
  ['DO_AUTH_TOKEN', /^[A-Za-z0-9._-]+$/],
];
export const RESTORE_ENV_KEYS = ENV_RULES.map(([key]) => key);

// A line of the env file holds one value: no line breaks, and nothing a terminal would act on.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The deploy/.env values a snapshot gives setup.sh. A format 1 snapshot has no `env`, only the
 * panel's domain. Keys this does not know are ignored: a newer panel may write more.
 */
export function envForSetup(manifest: SnapshotManifest): { values: Record<string, string>; dropped: string[] } {
  const source: Record<string, string> = { ...manifest.env };
  if (!source.PANEL_DOMAIN && manifest.panelDomain) source.PANEL_DOMAIN = manifest.panelDomain;
  const values: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, rule] of ENV_RULES) {
    const value = source[key];
    if (value === undefined || value === '') continue;
    if (CONTROL.test(value) || !rule.test(value)) dropped.push(key);
    else values[key] = value;
  }
  return { values, dropped };
}

/**
 * The file setup.sh reads (provision/lib.sh, wpl7_restore_env_read): `KEY=value` lines, the value
 * as it goes into deploy/.env, unquoted. First what the snapshot is, for setup.sh's last message,
 * then the deploy/.env values. Never sourced, and every value is one line (envForSetup).
 */
export function envFileText(info: { ts: string | null; manifest: SnapshotManifest | null }, values: Record<string, string>): string {
  const lines: string[] = [];
  if (info.ts) lines.push(`SNAPSHOT_TS=${info.ts}`);
  const version = info.manifest?.panelVersion;
  if (version && !CONTROL.test(version)) lines.push(`SNAPSHOT_VERSION=${version}`);
  const server = info.manifest?.localServer;
  if (server && !CONTROL.test(server)) lines.push(`SNAPSHOT_SERVER=${server}`);
  for (const key of RESTORE_ENV_KEYS) if (values[key] !== undefined) lines.push(`${key}=${values[key]}`);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

// ---------------------------------------------------------------------------
// Which version may restore it

const CORE = /^v?(\d+\.\d+\.\d+)/;

/** What to install instead, for a snapshot this installer cannot take. */
export function installHint(version: string | null): string {
  if (version && version.includes('-edge.')) return 'Install from the edge channel: install.sh --restore --channel=edge';
  if (version && /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version) && !/-(dev|source)$/.test(version)) {
    const v = version.replace(/^v/, '');
    return `Install ${v} or newer: install.sh --restore --version=${v}`;
  }
  return 'Install the version the old panel ran, or a newer one.';
}

/**
 * Why `running` cannot restore a snapshot `snapshot` made, or null. A database only moves forward:
 * migrations add to it, and none takes it back to an older panel.
 *
 * Only the release number counts here. Edge builds are prereleases of the next version
 * (0.4.0-edge.<commit>), which semver ranks below a release they may well be newer than, so an
 * order between prereleases says nothing. Those, and builds with no number, are left to the check
 * of the database's own migrations (checkDatabase), which is exact.
 */
export function versionProblem(snapshot: string | null, running: string): string | null {
  const a = snapshot ? CORE.exec(snapshot) : null;
  const b = CORE.exec(running);
  if (!a || !b || compareVersions(a[1]!, b[1]!) <= 0) return null;
  return `This snapshot is from WPL7 ${snapshot}, newer than this installer's ${running}. Its database cannot go back a version. ${installHint(snapshot)}`;
}

/**
 * Is this a panel database this build can run? SQLite checks the file is whole, and drizzle's own
 * table says which migrations it has had. A database a newer build migrated has tables and columns
 * this one does not know, and its migrator would find nothing to do and carry on regardless.
 */
export function checkDatabase(file: string, migrationsFolder: string, made: { version: string | null; running: string }): void {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== 'SQLite format 3\u0000') throw new Error('The snapshot does not hold a SQLite database.');

  const sqlite = new Database(file, { fileMustExist: true });
  try {
    const verdict = sqlite.pragma('quick_check', { simple: true });
    if (verdict !== 'ok') throw new Error(`The snapshot's database is damaged: ${String(verdict)}`);
    const table = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
    if (!table) throw new Error('This is not a WPL7 panel database: it has no record of migrations.');
    const row = sqlite.prepare('SELECT MAX(created_at) AS newest FROM __drizzle_migrations').get() as { newest: number | string | null };
    const applied = Number(row.newest ?? 0);
    const known = Math.max(0, ...readMigrationFiles({ migrationsFolder }).map((m) => m.folderMillis));
    if (applied > known) {
      const from = made.version ? `WPL7 ${made.version}` : 'a newer WPL7';
      throw new Error(
        `This snapshot's database was migrated by ${from}, past what this installer's ${made.running} knows. ` +
          `Its database cannot go back a version. ${installHint(made.version)}`,
      );
    }
  } finally {
    sqlite.close();
  }
}

/**
 * The restored database runs on a new machine: forget the host key server 1's row pinned for the
 * old one. The panel's web terminal and its updates reach this host over SSH, and would otherwise
 * refuse it as a changed key. The panel pins this machine's key on its first connection, as it did
 * on the old one's first install.
 */
export function forgetLocalHostKey(file: string): void {
  const sqlite = new Database(file, { fileMustExist: true });
  try {
    connectDb(sqlite)
      .update(servers)
      .set({ hostKeySha256: null })
      .where(and(eq(servers.id, 1), eq(servers.kind, 'local')))
      .run();
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// The files

/**
 * Check each file `sha256sums` lists, as `sha256sum -c --strict` does. `required` must be among
 * them: a list that leaves the database out vouches for nothing.
 */
export async function verifySums(dir: string, required: string): Promise<void> {
  const listed = new Map<string, string>();
  for (const line of (await fsp.readFile(path.join(dir, SNAPSHOT_SUMS), 'utf8')).split('\n')) {
    if (line.trim() === '') continue;
    const m = /^([0-9a-fA-F]{64}) [ *]([^/]+)$/.exec(line.trimEnd());
    if (!m || m[2] === '.' || m[2] === '..') throw new Error(`${SNAPSHOT_SUMS} has a line that is not a checksum.`);
    listed.set(m[2]!, m[1]!.toLowerCase());
  }
  if (!listed.has(required)) throw new Error(`${SNAPSHOT_SUMS} does not list ${required}.`);
  for (const [name, expected] of listed) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error(`${name} is missing, though ${SNAPSHOT_SUMS} lists it.`);
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    if (hash.digest('hex') !== expected) throw new Error(`${name} does not match its checksum: the download is damaged.`);
  }
}

/** A snapshot on this machine: what `--restore-from` names, or what was just downloaded. */
export interface LocalSnapshot {
  db: string;
  manifest: string | null;
  sums: string | null;
  ts: string | null;
}

const exists = (file: string) => fs.existsSync(file);

function snapshotAt(dir: string, db: string): LocalSnapshot {
  const manifest = path.join(dir, SNAPSHOT_MANIFEST);
  const sums = path.join(dir, SNAPSHOT_SUMS);
  const name = path.basename(dir);
  return {
    db,
    manifest: exists(manifest) ? manifest : null,
    sums: exists(sums) ? sums : null,
    ts: SNAPSHOT_NAME.test(name) ? name : null,
  };
}

/**
 * What `--restore-from` names: a snapshot's folder, its panel.db.gz on its own, or a backup root's
 * `panel/` folder of them, of which the newest is taken.
 */
export function localSnapshot(from: string): LocalSnapshot {
  const stat = fs.statSync(from, { throwIfNoEntry: false });
  if (!stat) throw new Error(`${from} does not exist.`);
  if (stat.isFile()) return snapshotAt(path.dirname(from), from);
  const db = path.join(from, SNAPSHOT_DB);
  if (exists(db)) return snapshotAt(from, db);
  const newest = fs
    .readdirSync(from)
    .filter((name) => SNAPSHOT_NAME.test(name) && exists(path.join(from, name, SNAPSHOT_DB)))
    .sort(compareSnapshotNames)[0];
  if (!newest) throw new Error(`There is no ${SNAPSHOT_DB} in ${from}, nor a snapshot folder holding one.`);
  return snapshotAt(path.join(from, newest), path.join(from, newest, SNAPSHOT_DB));
}

/** Unpack the snapshot's database to `to`: gzipped as the panel writes it, or already unpacked by hand. */
export async function unpackDatabase(from: string, to: string): Promise<void> {
  const head = Buffer.alloc(2);
  const fd = fs.openSync(from, 'r');
  try {
    fs.readSync(fd, head, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  const source = fs.createReadStream(from);
  const target = fs.createWriteStream(to, { mode: 0o600 });
  if (head[0] !== 0x1f || head[1] !== 0x8b) return pipeline(source, target);
  // Without its sha256sums, a download cut short is first noticed here.
  await pipeline(source, zlib.createGunzip(), target).catch((err: unknown) => {
    throw new Error(`${path.basename(from)} does not unpack, so it is damaged or incomplete: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// ---------------------------------------------------------------------------
// The destination

export interface Destination {
  provider: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  crypt: CryptKey | null;
}

/** What the restore asks Docker for: rclone in a container beside it, as the panel runs it. */
export type RestoreDocker = Pick<DockerPort, 'runEphemeral' | 'imageExists' | 'pullImage' | 'containerState'>;

/** The address of a snapshot as rclone reads it, through the crypt remote when there is one. */
export function snapshotTarget(remote: RcloneRemote, ts?: string): string {
  const dir = remoteJoin(remote.root, SNAPSHOT_SLUG);
  return ts ? remoteJoin(dir, ts) : dir;
}

/**
 * A destination's snapshots, through rclone in a throwaway container on this machine: the
 * remote's environment and prelude from rcloneRemoteFor, credentials in the container's
 * environment only, and everything rclone says scrubbed of them, as OffsiteService does it.
 */
export class SnapshotRemote {
  private readonly remote: RcloneRemote;
  private readonly redact: (text: string) => string;
  /** Where the snapshots are, without a credential: for messages. */
  readonly display: string;

  constructor(
    private readonly docker: RestoreDocker,
    private readonly image: string,
    readonly destination: Destination,
  ) {
    this.remote = rcloneRemoteFor(destination.provider, destination.config, destination.secrets, destination.crypt);
    this.redact = redactorFor([
      ...Object.values(destination.secrets),
      ...(destination.crypt ? [destination.crypt.password, destination.crypt.salt] : []),
    ]);
    const where = remotePathFor(destination.provider, destination.config, SNAPSHOT_SLUG, '');
    this.display = `${where}${destination.crypt ? ', encrypted' : ''}`;
  }

  async ensureImage(say: (line: string) => void): Promise<void> {
    if (await this.docker.imageExists(this.image)) return;
    say(`Pulling ${this.image}…`);
    await this.docker.pullImage(this.image);
  }

  /** The complete snapshots, newest first. None when the folder does not exist. */
  async list(): Promise<SnapshotEntry[]> {
    const res = await this.rclone(['lsf', '-R', '--files-only', '--max-depth', '2', snapshotTarget(this.remote)], {
      timeoutMs: 10 * 60_000,
    });
    // 3 is rclone's exit code for a directory that is not there, and only for that. Its words are
    // no test: every run says "not found", in the notice CONFIG_NOTICE matches, a refused login too.
    if (res.exitCode === RCLONE_DIRECTORY_NOT_FOUND) return [];
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      throw new Error(`Could not list ${this.display}: ${detail.slice(0, 500) || `rclone exited ${res.exitCode}`}`);
    }
    return snapshotsIn(res.stdout);
  }

  /** Copy one snapshot's files into `dir`, a folder under SRV_ROOT that the daemon sees at the same path. */
  async download(ts: string, dir: string, onLine: (line: string) => void): Promise<void> {
    const res = await this.rclone(
      [
        'copy',
        snapshotTarget(this.remote, ts),
        '/data',
        '--retries',
        '3',
        '--low-level-retries',
        '10',
        '--stats',
        '30s',
        '--stats-one-line',
        '--stats-log-level',
        'NOTICE',
      ],
      { binds: [`${dir}:/data`], timeoutMs: 2 * 3600_000, onLine },
    );
    if (res.exitCode !== 0) {
      throw new Error(`Could not download ${ts}: ${(res.stderr || res.stdout).trim().slice(0, 500) || `rclone exited ${res.exitCode}`}`);
    }
  }

  private async rclone(
    args: string[],
    opts: { binds?: string[]; timeoutMs: number; onLine?: (line: string) => void },
  ): Promise<RunResult> {
    const script = [...this.remote.prelude, `exec rclone ${shellQuote(args)}`].join('\n');
    const res = await this.docker.runEphemeral({
      image: this.image,
      entrypoint: ['/bin/sh'],
      cmd: ['-c', script],
      env: this.remote.env,
      binds: opts.binds,
      // The default bridge: rclone needs the internet, and nothing of the stack.
      networks: [],
      labels: { 'ceo.role': 'offsite' },
      timeoutMs: opts.timeoutMs,
      onOutput: opts.onLine
        ? (line) => {
            if (!CONFIG_NOTICE.test(line)) opts.onLine!(this.redact(line));
          }
        : undefined,
    });
    const said = (text: string) => this.redact(text.split('\n').filter((line) => !CONFIG_NOTICE.test(line)).join('\n'));
    return { ...res, stdout: said(res.stdout), stderr: said(res.stderr) };
  }
}

/** rclone's exit code for "directory not found". */
const RCLONE_DIRECTORY_NOT_FOUND = 3;

/**
 * What every run here begins with: the remote lives in the environment, never in a config file.
 * Left out of what the restore shows, and out of the start of every error message.
 */
const CONFIG_NOTICE = /NOTICE: Config file ".*" not found - using defaults/;

const GROUP_HEADINGS: Record<string, string> = { object: 'Object storage', servers: 'Servers', advanced: 'Advanced' };

/** One choice from a numbered list; a number or the value itself answers. */
async function choose(
  io: Prompter,
  question: string,
  options: { value: string; label: string; group?: string }[],
  def: string | undefined,
): Promise<string> {
  let group: string | undefined;
  const indent = options.some((o) => o.group) ? '    ' : '  ';
  options.forEach((o, i) => {
    if (o.group && o.group !== group) {
      group = o.group;
      io.say(`  ${GROUP_HEADINGS[o.group] ?? o.group}`);
    }
    io.say(`${indent}${i + 1}  ${o.label}`);
  });
  const defIndex = options.findIndex((o) => o.value === def);
  for (;;) {
    const answer = await io.ask(question, defIndex >= 0 ? String(defIndex + 1) : undefined);
    const byNumber = /^\d+$/.test(answer) ? options[Number(answer) - 1] : undefined;
    const picked = byNumber ?? options.find((o) => o.value === answer);
    if (picked) return picked.value;
    io.say(`Answer with a number from 1 to ${options.length}.`);
  }
}

const PEM_END = /^-----END [A-Z0-9 ]+-----$/;

/** One field of the catalog, asked the way the Add remote destination form shows it. */
async function askField(
  io: Prompter,
  field: ProviderField,
  def: string | undefined,
  previousSecret: string | undefined,
): Promise<string> {
  const label = `${field.label}${field.required ? '' : ' (optional)'}`;
  if (field.hint && field.key !== 'prefix') io.say(`  ${field.hint}`);
  if (field.kind === 'select' && field.options) {
    return choose(io, field.label, field.options.map((o) => ({ value: o.value, label: o.label })), def ?? field.default);
  }
  if (field.secret) {
    const keep = previousSecret ? ' Enter alone keeps the one typed before.' : field.required ? '' : ' Enter alone leaves it out.';
    for (;;) {
      const answer =
        field.kind === 'textarea'
          ? await io.secretLines(`${label}: paste it, then press Enter. Nothing shows while you paste.${keep}`, PEM_END)
          : await io.secret(previousSecret ? `${label}, or Enter to keep the one typed before` : label);
      if (answer.trim() === '' && previousSecret) return previousSecret;
      if (answer.trim() !== '') return answer;
      if (!field.required) return '';
    }
  }
  const example = !def && field.placeholder ? ` (e.g. ${field.placeholder})` : '';
  for (;;) {
    const answer = await io.ask(`${label}${example}`, def || undefined);
    if (answer === '' && field.required) continue;
    if (field.kind === 'number' && answer !== '' && !/^\d+$/.test(answer)) {
      io.say(`${field.label} is a number.`);
      continue;
    }
    return answer;
  }
}

/**
 * The destination the old panel copied its backups to, asked field by field from the provider
 * catalog: the same providers and fields as **Add remote destination**, checked by the same rules.
 *
 * `prefix` is offered as the path prefix: setup.sh passes the panel domain when it was given one,
 * which is what the form fills that field with. `previous` is a first try that did not work, whose
 * answers are offered again.
 */
export async function promptDestination(io: Prompter, opts: { prefix?: string; previous?: Destination } = {}): Promise<Destination> {
  const previous = opts.previous;
  io.say('Where did the old panel copy its backups to?');
  const provider = await choose(
    io,
    'Provider',
    BACKUP_PROVIDERS.map((p) => ({ value: p.key, label: p.label, group: p.group })),
    previous?.provider ?? BACKUP_PROVIDERS[0]!.key,
  );
  const preset = providerByKey(provider)!;
  const same = previous?.provider === provider ? previous : undefined;
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  // A vendor fills in the endpoint pattern and region for that vendor, as it does in the form.
  const presetValues: Record<string, string> = {};

  for (const field of preset.fields) {
    if (field.key === 'prefix') io.say("  The old panel's domain, unless it was changed when the destination was added.");
    const offered = same?.config[field.key] ?? presetValues[field.key] ?? field.default ?? (field.key === 'prefix' ? opts.prefix : undefined);
    // A pattern with a part to fill in (`<account-id>.r2…`) is an example to follow, not an answer.
    const def = offered && !offered.includes('<') ? offered : undefined;
    const value = await askField(io, def === undefined && offered ? { ...field, placeholder: offered } : field, def, same?.secrets[field.key]);
    if (value === '') continue;
    if (field.secret) secrets[field.key] = value;
    else config[field.key] = value;
    const option = field.options?.find((o) => o.value === value);
    if (option?.preset) Object.assign(presetValues, option.preset);
    if (field.warnWhen && value === field.warnWhen.value) io.say(field.warnWhen.message);
  }

  if (preset.freeform) {
    io.say('Any other settings of the rclone remote, by their rclone names. Values do not show.');
    for (;;) {
      const name = (await io.ask('Setting name, or Enter when done')).trim();
      if (name === '') break;
      if (!/^[a-z0-9_]+$/i.test(name)) {
        io.say('A setting name is letters, digits and underscores.');
        continue;
      }
      const value = await io.secret(`Value of ${name}`);
      if (value !== '') secrets[name.toLowerCase()] = value;
    }
  }

  const problems = destinationProblems(provider, config, secrets);
  if (problems.length > 0) {
    for (const p of problems) io.say(p);
    io.say('Once more:');
    return promptDestination(io, { prefix: opts.prefix, previous: { provider, config, secrets, crypt: null } });
  }

  let crypt: CryptKey | null = null;
  if (await confirm(io, 'Are the backups there encrypted?', previous?.crypt != null)) {
    io.say('The passphrase and its salt, as the panel showed them when the destination was added.');
    let password = '';
    let salt = '';
    while (password === '') password = (await io.secret('Passphrase')) || (previous?.crypt?.password ?? '');
    while (salt === '') salt = (await io.secret('Salt')) || (previous?.crypt?.salt ?? '');
    crypt = { password, salt };
  }
  return { provider, config, secrets, crypt };
}

// ---------------------------------------------------------------------------
// The restore

export interface RestoreDeps {
  docker: RestoreDocker;
  rcloneImage: string;
  /** `<SRV_ROOT>/panel/panel.db`. */
  dbFile: string;
  /**
   * A private folder beside `dbFile`, on the same file system so the database is moved into place
   * in one step. Under SRV_ROOT, so the Docker daemon finds a download's bind source at this path.
   * The caller makes it and removes it.
   */
  workDir: string;
  migrationsFolder: string;
  /** The panel version this runs as: the image setup.sh is about to start. */
  runningVersion: string;
  /** Nobody to ask when null: every answer then has to be in the request. */
  io: Prompter | null;
  say: (line: string) => void;
  /** The panel's container, which must not run while its database is replaced. Null skips the check. */
  panelContainer: string | null;
}

export interface RestoreRequest {
  /** A snapshot downloaded by hand, instead of a destination. */
  from?: string;
  /** The path prefix to offer: the panel's domain, when setup.sh was given one. */
  prefix?: string;
  /** Where the values for deploy/.env go (envFileText). */
  envOut?: string;
  /** Replace an existing panel.db without asking. */
  replace?: boolean;
  /** The destination, instead of asking for it. */
  destination?: Destination;
  /** The snapshot to take, instead of asking or taking the newest. */
  snapshot?: string;
}

export interface RestoreResult {
  ts: string | null;
  manifest: SnapshotManifest | null;
  env: Record<string, string>;
}

/** Restore the panel's database from a snapshot, and write what deploy/.env needs from it. */
export async function restorePanel(req: RestoreRequest, deps: RestoreDeps): Promise<RestoreResult> {
  const { say } = deps;
  if (deps.panelContainer && (await deps.docker.containerState(deps.panelContainer)) === 'running') {
    throw new Error(`The panel is running on this server. Stop it first: docker stop ${deps.panelContainer}`);
  }
  if (fs.existsSync(deps.dbFile) && !req.replace) {
    const replace = deps.io ? await confirm(deps.io, `There is a panel database at ${deps.dbFile} already. Replace it?`, false) : false;
    if (!replace) throw new Error(`There is a panel database at ${deps.dbFile} already. Move it away first.`);
  }

  const snapshot = req.from ? await checkLocal(req.from, say) : await fetchSnapshot(req, deps);
  const manifest = snapshot.manifest ? parseManifest(await fsp.readFile(snapshot.manifest, 'utf8')) : null;
  const problem = versionProblem(manifest?.panelVersion ?? null, deps.runningVersion);
  if (problem) throw new Error(problem);

  // Unpacked and checked beside its final place, and moved there only once the values for
  // deploy/.env are written: a restore that stops on the way leaves no database behind.
  const prepared = path.join(deps.workDir, 'panel.db');
  await unpackDatabase(snapshot.db, prepared);
  checkDatabase(prepared, deps.migrationsFolder, { version: manifest?.panelVersion ?? null, running: deps.runningVersion });
  forgetLocalHostKey(prepared);

  const { values, dropped } = manifest ? envForSetup(manifest) : { values: {}, dropped: [] };
  if (dropped.length > 0) say(`Left out, as they do not look right: ${dropped.join(', ')}. setup.sh asks for these or uses its defaults.`);
  if (!manifest) say(`There is no ${SNAPSHOT_MANIFEST}, so setup.sh asks for the panel's domains as on a new install.`);
  if (req.envOut) {
    const temp = `${req.envOut}.part`;
    await fsp.writeFile(temp, envFileText({ ts: snapshot.ts, manifest }, values), { mode: 0o600 });
    await fsp.rename(temp, req.envOut);
  }

  // A -wal or -shm beside it belongs to the database being replaced, and SQLite would replay it
  // into this one.
  for (const suffix of ['-wal', '-shm']) await fsp.rm(`${deps.dbFile}${suffix}`, { force: true });
  await fsp.rename(prepared, deps.dbFile);
  await fsp.chmod(deps.dbFile, 0o600);

  const when = snapshot.ts ? ` of ${describeSnapshot(snapshot.ts)}` : '';
  const by = manifest?.panelVersion ? `, made by WPL7 ${manifest.panelVersion}` : '';
  say(`The panel's database is back from the snapshot${when}${by}: ${deps.dbFile}`);
  return { ts: snapshot.ts, manifest, env: values };
}

async function checkLocal(from: string, say: (line: string) => void): Promise<LocalSnapshot> {
  const snapshot = localSnapshot(from);
  say(`Restoring from ${snapshot.db}`);
  if (snapshot.sums) await verifySums(path.dirname(snapshot.sums), path.basename(snapshot.db));
  else say(`There is no ${SNAPSHOT_SUMS} beside it, so its checksum is not checked.`);
  return snapshot;
}

/** Ask for the destination until its snapshots can be listed, then download one that checks out. */
async function fetchSnapshot(req: RestoreRequest, deps: RestoreDeps): Promise<LocalSnapshot> {
  const { io, say } = deps;
  if (!req.destination && !io) throw new Error('There is nobody to ask for the destination: give a snapshot downloaded by hand.');
  let previous: Destination | undefined;
  for (;;) {
    const destination = req.destination ?? (await promptDestination(io!, { prefix: req.prefix, previous }));
    const remote = new SnapshotRemote(deps.docker, deps.rcloneImage, destination);
    await remote.ensureImage(say);
    say(`Looking for panel snapshots in ${remote.display}…`);

    let found: SnapshotEntry[] = [];
    let trouble: string | null = null;
    try {
      found = await remote.list();
      if (found.length === 0) trouble = nothingFound(remote.display, destination);
    } catch (err) {
      trouble = err instanceof Error ? err.message : String(err);
    }
    if (trouble) {
      if (req.destination || !io) throw new Error(trouble);
      say(trouble);
      if (!(await confirm(io, 'Enter the destination again?', true))) throw new Error('No snapshot was restored.');
      previous = destination;
      continue;
    }

    let ts = req.snapshot ?? (io ? await chooseSnapshot(io, found, found[0]!.ts) : found[0]!.ts);
    if (!found.some((s) => s.ts === ts)) throw new Error(`There is no snapshot ${ts} in ${remote.display}.`);
    for (;;) {
      const dir = path.join(deps.workDir, ts);
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { mode: 0o700 });
      say(`Downloading ${ts}…`);
      try {
        await remote.download(ts, dir, (line) => say(`  rclone: ${line}`));
        await verifySums(dir, SNAPSHOT_DB);
        parseManifest(await fsp.readFile(path.join(dir, SNAPSHOT_MANIFEST), 'utf8'));
        return snapshotAt(dir, path.join(dir, SNAPSHOT_DB));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (req.snapshot || !io) throw new Error(`${ts}: ${message}`);
        say(`${ts}: ${message}`);
        say('Pick another snapshot, or press Ctrl-C to stop.');
        const older = found.find((s) => compareSnapshotNames(s.ts, ts) > 0)?.ts ?? found[0]!.ts;
        ts = await chooseSnapshot(io, found, older);
      }
    }
  }
}

function nothingFound(display: string, destination: Destination): string {
  const preset = providerByKey(destination.provider);
  const where =
    preset?.group === 'object'
      ? "Check the bucket and the path prefix: the prefix is usually the old panel's domain."
      : 'Check the remote directory.';
  return [
    `There are no panel snapshots in ${display}.`,
    destination.crypt ? 'An encrypted destination also looks empty with a wrong passphrase or salt.' : '',
    where,
    'A destination has them only while it copies the panel kind of backup, as it does by default.',
  ]
    .filter(Boolean)
    .join(' ');
}

async function chooseSnapshot(io: Prompter, found: SnapshotEntry[], def: string): Promise<string> {
  io.say(`${found.length === 1 ? 'One snapshot' : `${found.length} snapshots`} there. The newest:`);
  for (const s of found.slice(0, 5)) io.say(`  ${s.ts}  ${describeSnapshot(s.ts)}`);
  for (;;) {
    const answer = await io.ask('Snapshot to restore', def);
    if (found.some((s) => s.ts === answer)) return answer;
    io.say(`There is no snapshot ${answer} there.`);
  }
}
