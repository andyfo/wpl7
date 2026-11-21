/**
 * install.sh --restore with the real rclone, the panel's pinned image: a folder here stands in for
 * the destination, through rclone's local backend, holding snapshots as the panel copies them
 * there, in the clear and through crypt. What src/cli/snapshotRestore.ts then does with them is
 * what the restore does on a new server, short of the container it runs in.
 *
 * Opt-in: needs Docker, and pulls the rclone image the first time.
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/snapshotRestore.test.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../../src/config.js';
import { servers } from '../../src/db/schema.js';
import { restorePanel, type Destination, type RestoreDeps, type RestoreDocker } from '../../src/cli/snapshotRestore.js';
import { DockerService } from '../../src/services/docker.js';
import { shellQuote } from '../../src/servers/sshExec.js';
import { rcloneRemoteFor, remoteJoin } from '../../shared/backupProviders.js';
import { createTestDb } from '../helpers.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const MIGRATIONS = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));
const RCLONE = loadConfig({}).rcloneImage;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
// The system's temp folder: Docker Desktop shares it with its VM by default, and a Linux daemon sees it as it is.
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-engine-restore-'));
  dirs.push(dir);
  return dir;
};

/** A snapshot folder as panelSnapshot writes it, of a database whose server 1 pinned a host key. */
function snapshotFolder(dir: string, marker: string): string {
  const db = createTestDb();
  db.update(servers).set({ hostKeySha256: 'SHA256:old-machine' }).where(eq(servers.id, 1)).run();
  db.$client.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('restore.marker', ?, 0)").run(JSON.stringify(marker));
  const gz = zlib.gzipSync(db.$client.serialize());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'panel.db.gz'), gz);
  const manifest = {
    format: 2,
    slug: 'panel',
    type: 'panel',
    createdAt: '2026-10-04T03:00:00.000Z',
    panelDomain: 'panel.example.com',
    panelVersion: '0.4.0',
    env: { PANEL_DOMAIN: 'panel.example.com', DEV_DOMAIN: 'dev.example.com', SMTP_PASSWORD: 'relay password' },
    servers: [{ id: 1, name: 'main', kind: 'local' }],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'sha256sums'), `${crypto.createHash('sha256').update(gz).digest('hex')}  panel.db.gz\n`);
  return dir;
}

const marker = (file: string) => {
  const sqlite = new Database(file, { readonly: true });
  try {
    return (sqlite.prepare("SELECT value FROM settings WHERE key = 'restore.marker'").get() as { value: string }).value;
  } finally {
    sqlite.close();
  }
};

describe.skipIf(!ENABLED)('restoring the panel with the real rclone', { timeout: 300_000 }, () => {
  const docker = new DockerService('wpl7_proxy', 'wpl7_db');
  const remote = tmp();
  /** Docker as the restore uses it, with the stand-in destination mounted into every rclone container. */
  const withRemote: RestoreDocker = {
    imageExists: (tag) => docker.imageExists(tag),
    pullImage: (tag, onProgress) => docker.pullImage(tag, onProgress),
    containerState: (name) => docker.containerState(name),
    runEphemeral: (opts) => docker.runEphemeral({ ...opts, binds: [...(opts.binds ?? []), `${remote}:/remote`] }),
  };

  function deps(): RestoreDeps & { said: string[] } {
    const panel = tmp();
    const said: string[] = [];
    return {
      docker: withRemote,
      rcloneImage: RCLONE,
      dbFile: path.join(panel, 'panel.db'),
      workDir: fs.mkdtempSync(path.join(panel, '.restore-')),
      migrationsFolder: MIGRATIONS,
      runningVersion: '0.4.0',
      io: null,
      say: (line) => void said.push(line),
      // A panel running on this machine for development is none of this test's business.
      panelContainer: null,
      said,
    };
  }

  const destination = (folder: string, crypt: Destination['crypt'] = null): Destination => ({
    provider: 'rclone',
    config: { type: 'local', path: `/remote/${folder}` },
    secrets: {},
    crypt,
  });

  it('takes the newest snapshot from a destination in the clear', async () => {
    snapshotFolder(path.join(remote, 'plain', 'panel', '20261003-030000'), 'older');
    snapshotFolder(path.join(remote, 'plain', 'panel', '20261004-030000'), 'newest');
    // Cut short: no checksums, so not a snapshot to take, however new.
    fs.mkdirSync(path.join(remote, 'plain', 'panel', '20261005-030000'));
    fs.copyFileSync(path.join(remote, 'plain', 'panel', '20261004-030000', 'panel.db.gz'), path.join(remote, 'plain', 'panel', '20261005-030000', 'panel.db.gz'));
    const d = deps();
    const envOut = path.join(tmp(), 'env');

    const result = await restorePanel({ destination: destination('plain'), envOut }, d);

    expect(result.ts).toBe('20261004-030000');
    expect(marker(d.dbFile)).toBe('"newest"');
    expect(fs.readFileSync(envOut, 'utf8')).toBe(
      'SNAPSHOT_TS=20261004-030000\nSNAPSHOT_VERSION=0.4.0\nSNAPSHOT_SERVER=main\nPANEL_DOMAIN=panel.example.com\nDEV_DOMAIN=dev.example.com\nSMTP_PASSWORD=relay password\n',
    );
  });

  it('reads one copied through crypt with the passphrase and salt, and finds nothing without them', async () => {
    const crypt = { password: 'engine-passphrase-0123456789', salt: 'engine-salt-0123456789' };
    const source = snapshotFolder(path.join(tmp(), '20261004-030000'), 'encrypted');
    // Upload it as OffsiteService does: the remote rcloneRemoteFor builds, its prelude, rclone copy.
    if (!(await docker.imageExists(RCLONE))) await docker.pullImage(RCLONE);
    const dest = destination('vault', crypt);
    const upload = rcloneRemoteFor(dest.provider, dest.config, dest.secrets, crypt);
    const res = await withRemote.runEphemeral({
      image: RCLONE,
      entrypoint: ['/bin/sh'],
      cmd: ['-c', [...upload.prelude, `exec rclone ${shellQuote(['copy', '/data', remoteJoin(upload.root, 'panel/20261004-030000')])}`].join('\n')],
      env: upload.env,
      binds: [`${source}:/data:ro`],
      networks: [],
      timeoutMs: 120_000,
    });
    expect(res.exitCode, res.stderr).toBe(0);
    // Names are ciphertext too: nothing at the destination says "panel" or names the snapshot.
    const stored = fs.readdirSync(path.join(remote, 'vault'), { recursive: true }).map(String);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.some((name) => /panel|20261004|manifest|sha256sums/.test(name))).toBe(false);

    const d = deps();
    const result = await restorePanel({ destination: dest }, d);
    expect(result.ts).toBe('20261004-030000');
    expect(marker(d.dbFile)).toBe('"encrypted"');
    const sqlite = new Database(d.dbFile, { readonly: true });
    expect(sqlite.prepare('SELECT host_key_sha256 AS key FROM servers WHERE id = 1').get()).toEqual({ key: null });
    sqlite.close();
    for (const line of d.said) expect(line).not.toContain(crypt.password);

    const wrong = deps();
    await expect(restorePanel({ destination: destination('vault', { ...crypt, salt: 'another-salt-0123456789' }) }, wrong)).rejects.toThrow(
      /no panel snapshots in .*vault\/panel, encrypted\. An encrypted destination also looks empty with a wrong passphrase or salt/,
    );
    expect(fs.existsSync(wrong.dbFile)).toBe(false);
  });
});
