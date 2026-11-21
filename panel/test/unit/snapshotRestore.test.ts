/**
 * install.sh --restore, the part inside the panel image (src/cli/snapshotRestore.ts): which
 * snapshot, which version may take it, what setup.sh is handed, and the rclone commands. Docker is
 * a fake that serves a "destination" from folders here; test/engine/snapshotRestore.test.ts runs
 * the real rclone.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { servers } from '../../src/db/schema.js';
import { terminalPrompter, type Prompter } from '../../src/cli/prompt.js';
import {
  RESTORE_ENV_KEYS,
  SnapshotRemote,
  checkDatabase,
  compareSnapshotNames,
  envFileText,
  envForSetup,
  localSnapshot,
  parseManifest,
  promptDestination,
  restorePanel,
  snapshotsIn,
  versionProblem,
  type Destination,
  type RestoreDeps,
  type RestoreDocker,
} from '../../src/cli/snapshotRestore.js';
import type { EphemeralOpts, RunResult } from '../../src/services/docker.js';
import { BACKUP_PROVIDERS, rcloneRemoteFor } from '../../shared/backupProviders.js';
import { createTestDb } from '../helpers.js';

const MIGRATIONS = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (name = 'wpl7-restore-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  dirs.push(dir);
  return dir;
};

/** A migrated panel database whose server 1 pinned the old machine's host key, as bytes. */
function panelDb(mutate?: (sqlite: Database.Database) => void): Buffer {
  const db = createTestDb();
  db.update(servers).set({ hostKeySha256: 'SHA256:old-machine' }).where(eq(servers.id, 1)).run();
  db.$client.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('restore.marker', '\"from the snapshot\"', 0)").run();
  mutate?.(db.$client);
  return db.$client.serialize();
}

const MANIFEST = {
  format: 2,
  slug: 'panel',
  type: 'panel',
  createdAt: '2026-10-04T03:00:00.000Z',
  panelDomain: 'panel.example.com',
  panelVersion: '0.4.0',
  env: {
    PANEL_DOMAIN: 'panel.example.com',
    DEV_DOMAIN: 'dev.example.com',
    TLS_MODE: 'letsencrypt',
    ACME_RESOLVER: 'letsencrypt',
    WPL7_CHANNEL: 'stable',
    ACME_EMAIL: 'ops@example.com',
    MAIL_HOSTNAME: 'mail.example.com',
    SMTP_RELAYHOST: '[smtp.example.com]:587',
    SMTP_USERNAME: 'relay@example.com',
    SMTP_PASSWORD: 'pa ss$(word)&|`x`',
  },
  servers: [
    { id: 1, name: 'main', kind: 'local' },
    { id: 2, name: 'worker-1', kind: 'ssh' },
  ],
  note: 'Restore by hand…',
};

/** A snapshot folder as panelSnapshot writes it. */
function writeSnapshot(
  dir: string,
  opts: { db?: Buffer; manifest?: object | null; sums?: 'good' | 'bad' | 'none' } = {},
): string {
  fs.mkdirSync(dir, { recursive: true });
  const gz = zlib.gzipSync(opts.db ?? panelDb());
  fs.writeFileSync(path.join(dir, 'panel.db.gz'), gz);
  if (opts.manifest !== null) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(opts.manifest ?? MANIFEST));
  const sums = opts.sums ?? 'good';
  if (sums !== 'none') {
    const hash = sums === 'good' ? crypto.createHash('sha256').update(gz).digest('hex') : '0'.repeat(64);
    fs.writeFileSync(path.join(dir, 'sha256sums'), `${hash}  panel.db.gz\n`);
  }
  return dir;
}

/** The rclone words a run was given: the last line of its script is `exec rclone …`. */
const rcloneArgs = (opts: EphemeralOpts): string[] => opts.cmd[1]!.split('\n').at(-1)!.split(' ').slice(2);

/**
 * Docker, with rclone answering from folders here: `snapshots` maps a snapshot's name to the
 * folder holding its files, as the destination would.
 */
function fakeDocker(remote: { snapshots?: Record<string, string>; listing?: RunResult; running?: boolean } = {}) {
  const calls: EphemeralOpts[] = [];
  const docker: RestoreDocker = {
    imageExists: async () => true,
    pullImage: async () => undefined,
    containerState: async () => (remote.running ? 'running' : 'missing'),
    async runEphemeral(opts) {
      calls.push(opts);
      const [verb, source] = rcloneArgs(opts);
      if (verb === 'lsf') {
        if (remote.listing) return remote.listing;
        const lines = Object.entries(remote.snapshots ?? {}).flatMap(([ts, dir]) => fs.readdirSync(dir).map((f) => `${ts}/${f}`));
        return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
      }
      if (verb === 'copy') {
        const ts = source!.split('/').at(-1)!;
        const into = opts.binds![0]!.split(':')[0]!;
        for (const f of fs.readdirSync(remote.snapshots![ts]!)) fs.copyFileSync(path.join(remote.snapshots![ts]!, f), path.join(into, f));
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected rclone ${verb}`);
    },
  };
  return { docker, calls };
}

/**
 * Answers in order. A visible question takes a string; a hidden one only takes `{ secret }`, so a
 * test fails when a secret would have been asked for in the open.
 */
function scripted(answers: (string | { secret: string })[]) {
  const asked: string[] = [];
  const said: string[] = [];
  const next = (question: string, hidden: boolean): string => {
    asked.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`No answer left for "${question}"`);
    if ((typeof answer === 'object') !== hidden) {
      throw new Error(`"${question}" was asked ${hidden ? 'hidden' : 'in the open'}, but the answer is ${hidden ? 'not secret' : 'secret'}`);
    }
    return typeof answer === 'object' ? answer.secret : answer;
  };
  const io: Prompter = {
    ask: async (question, def) => next(question, false) || (def ?? ''),
    secret: async (question) => next(question, true),
    secretLines: async (question) => next(question, true),
    say: (line = '') => void said.push(line),
  };
  return { io, asked, said, left: () => answers.length };
}

function deps(over: Partial<RestoreDeps> & { docker: RestoreDocker }): RestoreDeps & { said: string[] } {
  const panelDir = tmp('wpl7-panel-');
  const said: string[] = [];
  return {
    rcloneImage: 'rclone/rclone:1.71',
    dbFile: path.join(panelDir, 'panel.db'),
    workDir: fs.mkdtempSync(path.join(panelDir, '.restore-')),
    migrationsFolder: MIGRATIONS,
    runningVersion: '0.4.0',
    io: null,
    say: (line) => void said.push(line),
    panelContainer: 'wpl7-panel',
    said,
    ...over,
  };
}

const S3: Destination = {
  provider: 's3',
  config: { accessKeyId: 'AKIAEXAMPLE', region: 'eu-central-1', bucket: 'my-backups', prefix: 'panel.example.com' },
  secrets: { secretAccessKey: 'very-secret-access-key' },
  crypt: null,
};

const settingIn = (file: string, key: string) => {
  const sqlite = new Database(file, { readonly: true });
  try {
    return (sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  } finally {
    sqlite.close();
  }
};

describe('which snapshot', () => {
  it('takes the newest folder an upload finished, and nothing that is not a snapshot', () => {
    const files = (ts: string, names = ['manifest.json', 'panel.db.gz', 'sha256sums']) => names.map((n) => `${ts}/${n}`);
    const listing = [
      ...files('20261003-030000'),
      ...files('20261004-030000'),
      ...files('20261004-030000-2'),
      // Cut short when the old server went down: no checksums, so no snapshot.
      ...files('20261005-030000', ['panel.db.gz']),
      '.ceo-probe-a1b2c3d4',
      'notes.txt',
      '20261006-030000/deeper/panel.db.gz',
      ...files('20261004-03'),
      '',
    ].join('\n');
    expect(snapshotsIn(listing).map((s) => s.ts)).toEqual(['20261004-030000-2', '20261004-030000', '20261003-030000']);
  });

  it('puts a tenth snapshot of the same second after the ninth', () => {
    expect(['20261004-030000-9', '20261004-030000-10', '20261004-030000'].sort(compareSnapshotNames)).toEqual([
      '20261004-030000-10',
      '20261004-030000-9',
      '20261004-030000',
    ]);
  });

  it('finds the newest snapshot in a backup root\'s panel folder downloaded by hand', () => {
    const root = tmp();
    writeSnapshot(path.join(root, '20261002-030000'));
    writeSnapshot(path.join(root, '20261003-030000'));
    fs.mkdirSync(path.join(root, '20261004-030000.fetching'));
    expect(localSnapshot(root)).toMatchObject({ ts: '20261003-030000', db: path.join(root, '20261003-030000', 'panel.db.gz') });
  });
});

describe('which version may restore it', () => {
  it('refuses a snapshot from a newer release, and names the release to install', () => {
    const problem = versionProblem('0.5.0', '0.4.0');
    expect(problem).toContain('0.5.0');
    expect(problem).toContain('install.sh --restore --version=0.5.0');
  });

  it('sends a newer edge build to the edge channel', () => {
    expect(versionProblem('0.5.0-edge.1a2b3c4', '0.4.0')).toContain('install.sh --restore --channel=edge');
  });

  it('leaves prereleases of the same release, older snapshots and builds without a number to the database check', () => {
    expect(versionProblem('0.4.0-edge.1a2b3c4', '0.4.0')).toBeNull();
    expect(versionProblem('0.4.0', '0.4.0-edge.1a2b3c4')).toBeNull();
    expect(versionProblem('0.4.0-beta.2', '0.4.0-beta.1')).toBeNull();
    expect(versionProblem('0.3.2', '0.4.0')).toBeNull();
    expect(versionProblem('dev', '0.4.0')).toBeNull();
    expect(versionProblem('0.4.0', 'dev')).toBeNull();
    expect(versionProblem(null, '0.4.0')).toBeNull();
  });

  it('refuses a database a newer build migrated, whatever its version says', () => {
    const file = path.join(tmp(), 'panel.db');
    fs.writeFileSync(
      file,
      panelDb((sqlite) => {
        const newest = (sqlite.prepare('SELECT MAX(created_at) AS m FROM __drizzle_migrations').get() as { m: number }).m;
        sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('a-later-migration', newest + 1);
      }),
    );
    expect(() => checkDatabase(file, MIGRATIONS, { version: '0.4.0-edge.1a2b3c4', running: '0.4.0' })).toThrow(
      /migrated by WPL7 0\.4\.0-edge\.1a2b3c4.*--channel=edge/,
    );
  });

  it('takes a database this build migrated, and nothing that is not one', () => {
    const dir = tmp();
    const good = path.join(dir, 'good.db');
    fs.writeFileSync(good, panelDb());
    expect(() => checkDatabase(good, MIGRATIONS, { version: '0.4.0', running: '0.4.0' })).not.toThrow();

    const text = path.join(dir, 'text.db');
    fs.writeFileSync(text, 'not a database at all');
    expect(() => checkDatabase(text, MIGRATIONS, { version: null, running: '0.4.0' })).toThrow(/not hold a SQLite database/);

    const other = path.join(dir, 'other.db');
    const sqlite = new Database(other);
    sqlite.exec('CREATE TABLE notes (body TEXT)');
    sqlite.close();
    expect(() => checkDatabase(other, MIGRATIONS, { version: null, running: '0.4.0' })).toThrow(/not a WPL7 panel database/);
  });
});

describe('what setup.sh is handed', () => {
  it('passes the manifest env on, the snapshot first, each value exactly as it was', () => {
    const manifest = parseManifest(JSON.stringify(MANIFEST));
    const { values, dropped } = envForSetup(manifest);
    expect(dropped).toEqual([]);
    expect(envFileText({ ts: '20261004-030000', manifest }, values)).toBe(
      [
        'SNAPSHOT_TS=20261004-030000',
        'SNAPSHOT_VERSION=0.4.0',
        'SNAPSHOT_SERVER=main',
        'PANEL_DOMAIN=panel.example.com',
        'DEV_DOMAIN=dev.example.com',
        'ACME_EMAIL=ops@example.com',
        'TLS_MODE=letsencrypt',
        'ACME_RESOLVER=letsencrypt',
        'WPL7_CHANNEL=stable',
        'MAIL_HOSTNAME=mail.example.com',
        'SMTP_RELAYHOST=[smtp.example.com]:587',
        'SMTP_USERNAME=relay@example.com',
        'SMTP_PASSWORD=pa ss$(word)&|`x`',
        '',
      ].join('\n'),
    );
  });

  it('takes the panel domain from a format 1 snapshot, which has no env', () => {
    const manifest = parseManifest(JSON.stringify({ format: 1, slug: 'panel', type: 'panel', panelDomain: 'panel.example.com', servers: [] }));
    expect(manifest.panelVersion).toBeNull();
    expect(envForSetup(manifest).values).toEqual({ PANEL_DOMAIN: 'panel.example.com' });
  });

  it('leaves out a value that does not fit where it goes, and keys it does not know', () => {
    const manifest = parseManifest(
      JSON.stringify({
        ...MANIFEST,
        env: {
          PANEL_DOMAIN: 'panel.example.com`) || Host(`elsewhere.example',
          TLS_MODE: 'sometimes',
          SMTP_PASSWORD: 'two\nlines',
          BACKUP_ROOT: 'mnt/backups',
          DEV_DOMAIN: 'dev.example.com',
          SOMETHING_NEW: 'x',
        },
      }),
    );
    const { values, dropped } = envForSetup(manifest);
    expect(dropped.sort()).toEqual(['BACKUP_ROOT', 'PANEL_DOMAIN', 'SMTP_PASSWORD', 'TLS_MODE']);
    expect(values).toEqual({ DEV_DOMAIN: 'dev.example.com' });
    expect(envForSetup(parseManifest(JSON.stringify({ ...MANIFEST, env: { BACKUP_ROOT: '/mnt/../etc' } }))).dropped).toEqual(['BACKUP_ROOT']);
    expect(RESTORE_ENV_KEYS).not.toContain('SOMETHING_NEW');
  });

  it('refuses the manifest of a site backup, and one that is not JSON', () => {
    expect(() => parseManifest(JSON.stringify({ format: 2, slug: 'shop', type: 'scheduled' }))).toThrow(/a site's backup/);
    expect(() => parseManifest('{"format": 2,')).toThrow(/not readable JSON/);
  });
});

describe('rclone, as the panel runs it', () => {
  const SAMPLES: Destination[] = [
    S3,
    {
      provider: 's3-compatible',
      config: { vendor: 'r2', endpoint: 'abc.r2.cloudflarestorage.com', accessKeyId: 'r2key', region: 'auto', bucket: 'b2', prefix: 'panel.example.com' },
      secrets: { secretAccessKey: 'r2-secret-access-key' },
      crypt: null,
    },
    { provider: 'sftp', config: { host: 'backup.example.com', user: 'u', path: 'backups/panel' }, secrets: { pass: 'sftp-password-1' }, crypt: null },
    { provider: 'ftp', config: { host: 'ftp.example.com', user: 'u', tls: 'explicit', path: 'backups' }, secrets: { pass: 'ftp-password-1' }, crypt: null },
    { provider: 'webdav', config: { url: 'https://cloud.example.com/dav', user: 'u', path: 'backups' }, secrets: { pass: 'dav-password-1' }, crypt: null },
    { provider: 'rclone', config: { type: 'b2', path: 'bucket/panel' }, secrets: { account: 'acct', key: 'b2-application-key' }, crypt: null },
  ];

  it('covers every provider the panel copies to', () => {
    expect(SAMPLES.map((s) => s.provider).sort()).toEqual(BACKUP_PROVIDERS.map((p) => p.key).sort());
  });

  it.each(SAMPLES)('lists $provider under panel/ with the remote the panel builds, secrets in the environment only', async (dest) => {
    const { docker, calls } = fakeDocker({ snapshots: {} });
    await new SnapshotRemote(docker, 'rclone/rclone:1.71', dest).list();
    const remote = rcloneRemoteFor(dest.provider, dest.config, dest.secrets);
    const run = calls[0]!;
    expect(run.env).toEqual(remote.env);
    expect(run.cmd[1]).toBe([...remote.prelude, `exec rclone lsf -R --files-only --max-depth 2 ${remote.root}/panel`].join('\n'));
    expect(run.networks).toEqual([]);
    for (const secret of Object.values(dest.secrets)) expect(run.cmd.join(' ')).not.toContain(secret);
  });

  it('reads an encrypted destination through crypt, anchored at the bucket and prefix as the panel writes it', async () => {
    const crypt = { password: 'the-long-passphrase', salt: 'the-long-salt-value' };
    const snapshot = writeSnapshot(path.join(tmp(), 'src'));
    const { docker, calls } = fakeDocker({ snapshots: { '20261004-030000': snapshot } });
    const remote = new SnapshotRemote(docker, 'rclone/rclone:1.71', { ...S3, crypt });
    expect(remote.display).toBe('my-backups/panel.example.com/panel, encrypted');
    await remote.list();
    await remote.download('20261004-030000', tmp(), () => undefined);

    expect(rcloneArgs(calls[0]!).at(-1)).toBe('CRYPT:panel');
    expect(rcloneArgs(calls[1]!).slice(0, 3)).toEqual(['copy', 'CRYPT:panel/20261004-030000', '/data']);
    expect(calls[1]!.env).toContain('RCLONE_CONFIG_CRYPT_REMOTE=DEST:my-backups/panel.example.com');
    expect(calls[1]!.env).toContain('WPL7_CRYPT_PASSWORD=the-long-passphrase');
    for (const run of calls) {
      expect(run.cmd.join(' ')).not.toContain('the-long-passphrase');
      expect(run.cmd.join(' ')).not.toContain('the-long-salt-value');
      expect(run.cmd[1]).toContain('rclone obscure "$WPL7_CRYPT_PASSWORD"');
    }
  });

  it('scrubs the credentials out of what rclone says', async () => {
    const { docker } = fakeDocker({
      listing: { stdout: '', stderr: 'AccessDenied for key very-secret-access-key', exitCode: 1 },
    });
    const err = await new SnapshotRemote(docker, 'rclone/rclone:1.71', S3).list().catch((e: Error) => e);
    expect(String(err)).toContain('Could not list my-backups/panel.example.com/panel');
    expect(String(err)).toContain('••••••');
    expect(String(err)).not.toContain('very-secret-access-key');
  });

  // What rclone 1.71 prints, every run beginning with the notice of a config file it does not need.
  const NOTICE = '2026/11/19 14:20:34 NOTICE: Config file "/config/rclone/rclone.conf" not found - using defaults';

  it('reads a folder that is not there as no snapshots', async () => {
    const stderr = `${NOTICE}\n2026/11/19 14:20:34 ERROR : error listing: directory not found\n`;
    const { docker } = fakeDocker({ listing: { stdout: '', stderr, exitCode: 3 } });
    expect(await new SnapshotRemote(docker, 'rclone/rclone:1.71', S3).list()).toEqual([]);
  });

  it('reports a refused login as it is, though the notice before it says "not found"', async () => {
    const stderr = `${NOTICE}\n2026/11/19 14:20:34 CRITICAL: Failed to create file system for "DEST:backups/panel": read metadata failed: 401 Unauthorized\n`;
    const { docker } = fakeDocker({ listing: { stdout: '', stderr, exitCode: 1 } });
    const err = await new SnapshotRemote(docker, 'rclone/rclone:1.71', S3).list().catch((e: Error) => e);
    expect(String(err)).toMatch(/^Error: Could not list my-backups\/panel\.example\.com\/panel: 2026\/11\/19 14:20:34 CRITICAL: .*401 Unauthorized$/);
  });
});

describe('the restore', () => {
  it('puts the newest snapshot in place and hands setup.sh its env', async () => {
    const remoteDir = tmp();
    const older = writeSnapshot(path.join(remoteDir, '20261003-030000'), { manifest: { ...MANIFEST, env: { PANEL_DOMAIN: 'old.example.com' } } });
    const newest = writeSnapshot(path.join(remoteDir, '20261004-030000'));
    const { docker } = fakeDocker({ snapshots: { '20261003-030000': older, '20261004-030000': newest } });
    const d = deps({ docker });
    // What the panel being replaced left beside its database must not be replayed into this one.
    fs.writeFileSync(`${d.dbFile}-wal`, 'stale');
    const envOut = path.join(tmp(), 'env');

    const result = await restorePanel({ destination: S3, envOut }, d);

    expect(result.ts).toBe('20261004-030000');
    expect(fs.statSync(d.dbFile).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${d.dbFile}-wal`)).toBe(false);
    expect(settingIn(d.dbFile, 'restore.marker')).toBe('"from the snapshot"');
    const sqlite = new Database(d.dbFile, { readonly: true });
    expect(sqlite.prepare('SELECT host_key_sha256 AS key FROM servers WHERE id = 1').get()).toEqual({ key: null });
    sqlite.close();
    expect(fs.readFileSync(envOut, 'utf8')).toContain('PANEL_DOMAIN=panel.example.com\n');
    expect(fs.statSync(envOut).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(d.workDir).filter((f) => f.endsWith('.db'))).toEqual([]);
  });

  it('offers the next older snapshot when the newest does not check out', async () => {
    const remoteDir = tmp();
    const older = writeSnapshot(path.join(remoteDir, '20261003-030000'));
    const damaged = writeSnapshot(path.join(remoteDir, '20261004-030000'), { sums: 'bad' });
    const { docker } = fakeDocker({ snapshots: { '20261003-030000': older, '20261004-030000': damaged } });
    // Enter twice: the newest first, then the older one it offers.
    const { io, said } = scripted(['', '']);
    const d = deps({ docker, io });

    expect((await restorePanel({ destination: S3 }, d)).ts).toBe('20261003-030000');
    expect(d.said.join('\n')).toContain('20261004-030000: panel.db.gz does not match its checksum');
    expect(said.join('\n')).toContain('20261003-030000  2026-10-03 03:00 UTC');
  });

  it('refuses a snapshot from a newer panel and leaves nothing behind', async () => {
    const snapshot = writeSnapshot(path.join(tmp(), '20261004-030000'), { manifest: { ...MANIFEST, panelVersion: '0.5.0' } });
    const d = deps({ docker: fakeDocker().docker });
    const envOut = path.join(tmp(), 'env');
    await expect(restorePanel({ from: snapshot, envOut }, d)).rejects.toThrow(/install\.sh --restore --version=0\.5\.0/);
    expect(fs.existsSync(d.dbFile)).toBe(false);
    expect(fs.existsSync(envOut)).toBe(false);
  });

  it('will not replace a panel database unless told to, nor one the panel has open', async () => {
    const snapshot = writeSnapshot(path.join(tmp(), '20261004-030000'));
    const d = deps({ docker: fakeDocker().docker });
    fs.writeFileSync(d.dbFile, 'the one there already');
    await expect(restorePanel({ from: snapshot }, d)).rejects.toThrow(/Move it away first/);
    expect(fs.readFileSync(d.dbFile, 'utf8')).toBe('the one there already');

    await restorePanel({ from: snapshot, replace: true }, d);
    expect(settingIn(d.dbFile, 'restore.marker')).toBe('"from the snapshot"');

    const running = deps({ docker: fakeDocker({ running: true }).docker });
    await expect(restorePanel({ from: snapshot }, running)).rejects.toThrow(/docker stop wpl7-panel/);
  });

  it('takes a panel.db.gz downloaded on its own, and leaves the domains to setup.sh', async () => {
    const dir = writeSnapshot(path.join(tmp(), 'download'), { manifest: null, sums: 'none' });
    const d = deps({ docker: fakeDocker().docker });
    const envOut = path.join(tmp(), 'env');
    const result = await restorePanel({ from: path.join(dir, 'panel.db.gz'), envOut }, d);
    expect(result.manifest).toBeNull();
    expect(fs.readFileSync(envOut, 'utf8')).toBe('');
    expect(d.said.join('\n')).toContain('its checksum is not checked');
    expect(settingIn(d.dbFile, 'restore.marker')).toBe('"from the snapshot"');
  });

  it('checks a downloaded snapshot against its sha256sums', async () => {
    const dir = writeSnapshot(path.join(tmp(), '20261004-030000'), { sums: 'bad' });
    await expect(restorePanel({ from: dir }, deps({ docker: fakeDocker().docker }))).rejects.toThrow(/does not match its checksum/);
  });

  it('says why a destination looks empty, and asks for it again', async () => {
    const snapshot = writeSnapshot(path.join(tmp(), '20261004-030000'));
    let listed = 0;
    const { docker } = fakeDocker({ snapshots: { '20261004-030000': snapshot } });
    const firstEmpty: RestoreDocker = {
      ...docker,
      runEphemeral: async (opts) =>
        rcloneArgs(opts)[0] === 'lsf' && listed++ === 0 ? { stdout: '', stderr: '', exitCode: 0 } : docker.runEphemeral(opts),
    };
    const { io, left } = scripted([
      // Amazon S3, its fields, not encrypted.
      '1', 'AKIAEXAMPLE', { secret: 'very-secret-access-key' }, 'eu-central-1', 'my-backups', 'wrong.example.com', 'n',
      // Again: every visible answer is offered back, the secret is kept with Enter.
      'y', '', '', { secret: '' }, '', '', 'panel.example.com', '',
      // The newest snapshot.
      '',
    ]);
    const d = deps({ docker: firstEmpty, io });
    const result = await restorePanel({}, d);
    expect(result.ts).toBe('20261004-030000');
    expect(left()).toBe(0);
    expect(d.said).toContain(
      "There are no panel snapshots in my-backups/wrong.example.com/panel. Check the bucket and the path prefix: the prefix is usually the old panel's domain. " +
        'A destination has them only while it copies the panel kind of backup, as it does by default.',
    );
  });
});

describe('asking for the destination', () => {
  it('asks the fields of a preset in the form\'s order, secrets hidden, then the passphrase', async () => {
    const { io, asked, left } = scripted([
      '1', 'AKIAEXAMPLE', { secret: 'very-secret-access-key' }, 'eu-central-1', 'my-backups', '', 'y',
      { secret: 'the-long-passphrase' }, { secret: 'the-long-salt-value' },
    ]);
    const dest = await promptDestination(io, { prefix: 'panel.example.com' });
    expect(dest).toEqual({ ...S3, crypt: { password: 'the-long-passphrase', salt: 'the-long-salt-value' } });
    expect(asked).toContain('Path prefix (optional)');
    expect(left()).toBe(0);
  });

  it('fills in a vendor\'s endpoint and region, but not a pattern with a part to fill in', async () => {
    const wasabi = scripted(['2', '4', '', 'key', { secret: 'secret-access-key' }, '', 'bucket', 'panel.example.com', '']);
    expect((await promptDestination(wasabi.io)).config).toMatchObject({
      vendor: 'wasabi',
      endpoint: 's3.eu-central-1.wasabisys.com',
      region: 'eu-central-1',
    });

    const r2 = scripted(['2', '3', 'acct.r2.cloudflarestorage.com', 'key', { secret: 'secret-access-key' }, '', 'bucket', '', '']);
    const dest = await promptDestination(r2.io);
    expect(r2.asked).toContain('Endpoint (e.g. <account-id>.r2.cloudflarestorage.com)');
    expect(dest.config).toMatchObject({ vendor: 'r2', endpoint: 'acct.r2.cloudflarestorage.com', region: 'auto' });
  });

  it('asks again with the answers kept when the destination is incomplete', async () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n';
    const { io, said } = scripted([
      // SFTP with neither a password nor a key.
      '3', 'backup.example.com', '', 'u', { secret: '' }, { secret: '' }, '', 'backups/panel',
      // Once more, the same answers offered, now with a key.
      '', '', '', '', { secret: '' }, { secret: pem }, '', '', 'n',
    ]);
    const dest = await promptDestination(io);
    expect(said).toContain('Give either a password or a private key.');
    expect(dest).toEqual({
      provider: 'sftp',
      config: { host: 'backup.example.com', port: '22', user: 'u', path: 'backups/panel' },
      secrets: { keyPem: pem },
      crypt: null,
    });
  });

  it('takes a custom remote\'s other settings as secrets', async () => {
    const { io } = scripted(['6', 'b2', 'bucket/panel', 'account', { secret: 'acct-id' }, 'key', { secret: 'b2-application-key' }, '', 'n']);
    expect(await promptDestination(io)).toEqual({
      provider: 'rclone',
      config: { type: 'b2', path: 'bucket/panel' },
      secrets: { account: 'acct-id', key: 'b2-application-key' },
      crypt: null,
    });
  });
});

describe('the terminal', () => {
  /** A terminal as readline sees one: it then draws what is typed itself, as on a real one in raw mode. */
  function terminal() {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk: Buffer) => (shown += chunk.toString()));
    let interrupted = 0;
    const io = terminalPrompter({ input, output, onInterrupt: () => void interrupted++ });
    return { io, type: (keys: string) => input.write(keys), shown: () => shown, interrupted: () => interrupted };
  }

  it('shows what is typed for a question, nothing of a secret or a pasted key', async () => {
    const t = terminal();
    const bucket = t.io.ask('Bucket', 'my-backups');
    t.type('other-bucket\r');
    expect(await bucket).toBe('other-bucket');
    const region = t.io.ask('Region', 'eu-central-1');
    t.type('\r');
    expect(await region).toBe('eu-central-1');

    const pass = t.io.secret('Passphrase');
    t.type('  the-long-passphrase \r');
    expect(await pass).toBe('the-long-passphrase');

    const key = t.io.secretLines('Private key', /^-----END [A-Z0-9 ]+-----$/);
    t.type('-----BEGIN OPENSSH PRIVATE KEY-----\rb3BlbnNzaC1rZXk\r-----END OPENSSH PRIVATE KEY-----\r');
    expect(await key).toBe('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n');
    t.io.close();

    expect(t.shown()).toContain('Bucket [my-backups]: ');
    expect(t.shown()).toContain('other-bucket');
    expect(t.shown()).toContain('Passphrase: ');
    expect(t.shown()).not.toContain('the-long-passphrase');
    expect(t.shown()).not.toContain('b3BlbnNzaC1rZXk');
  });

  it('hands Ctrl-C at a question on, and a question the input ended under fails', async () => {
    const t = terminal();
    const pending = t.io.ask('Bucket');
    t.type('\u0003');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.interrupted()).toBe(1);
    t.io.close();
    await expect(pending).rejects.toThrow(/input ended/);
  });
});
