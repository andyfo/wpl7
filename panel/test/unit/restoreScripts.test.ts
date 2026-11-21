/**
 * The shell half of `install.sh --restore` (provision/lib.sh, provision/setup.sh, install.sh): the
 * container the restore runs in, the values read back from it, and the restores refused before
 * anything is installed. Every case here stops at a refusal, before a root check or an apt-get.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LIB = path.join(ROOT, 'provision/lib.sh');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-restore-sh-'));
  dirs.push(dir);
  return dir;
};

function shell(body: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\n. ${JSON.stringify(LIB)}\n${body}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** A `docker` ahead of the real one on PATH: prints each argument on a line of its own. */
function stubDocker(exitCode = 0): string {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'docker'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@"\nexit ${exitCode}\n`, { mode: 0o755 });
  return dir;
}

describe('wpl7_restore_env_read', () => {
  it('takes each known key as it is, runs nothing in it, and skips everything else', () => {
    const dir = tmp();
    const file = path.join(dir, 'env');
    const marker = path.join(dir, 'ran');
    fs.writeFileSync(
      file,
      [
        'SNAPSHOT_TS=20261004-030000',
        'PANEL_DOMAIN=panel.example.com',
        `SMTP_PASSWORD=pa ss=$(touch ${marker})&|\`touch ${marker}\`\\x`,
        'not_a_key=x',
        'TWO WORDS=x',
        'NOT_LISTED=y',
        '=no key',
        'no equals sign',
        // The last line without its line break.
        'BACKUP_ROOT=/mnt/backups',
      ].join('\n'),
    );
    const res = shell(
      `wpl7_restore_env_read ${JSON.stringify(file)}
printf '%s\\n' "$RESTORED_SNAPSHOT_TS" "$RESTORED_PANEL_DOMAIN" "$RESTORED_SMTP_PASSWORD" "$RESTORED_BACKUP_ROOT" "\${RESTORED_NOT_LISTED-unset}" "\${RESTORED_DEV_DOMAIN-unset}"`,
    );
    expect(res.stderr).toBe('');
    expect(res.stdout.split('\n')).toEqual([
      '20261004-030000',
      'panel.example.com',
      `pa ss=$(touch ${marker})&|\`touch ${marker}\`\\x`,
      '/mnt/backups',
      'unset',
      'unset',
      '',
    ]);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('wpl7_restore_snapshot', () => {
  const run = (args: string, exitCode = 0) => {
    const res = shell(`wpl7_restore_snapshot ${args}`, { PATH: `${stubDocker(exitCode)}:${process.env.PATH ?? ''}` });
    return { ...res, argv: res.stdout.trim().split('\n') };
  };

  it('runs the restore in the panel image, with the socket and SRV_ROOT at the same path, and no network', () => {
    const { argv, status } = run("ghcr.io/example/panel:0.4.0 /srv /srv/panel/.restore-env.x/env '' panel.example.com 1");
    expect(status).toBe(0);
    expect(argv).toEqual([
      'run', '--rm', '--network', 'none',
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', '/srv:/srv',
      '-e', 'SRV_ROOT=/srv',
      '-it',
      'ghcr.io/example/panel:0.4.0', 'node', 'dist/src/cli/restore.js',
      '--env-out=/srv/panel/.restore-env.x/env', '--prefix=panel.example.com',
    ]);
  });

  it('mounts a snapshot downloaded by hand read-only: a folder as it is, a file with the folder it is in', () => {
    const folder = tmp();
    fs.writeFileSync(path.join(folder, 'panel.db.gz'), '');
    const asFolder = run(`img /data/srv /data/srv/panel/e/env ${JSON.stringify(folder)} '' 0`).argv;
    expect(asFolder).not.toContain('-it');
    expect(asFolder).toContain(`${folder}:/restore-from:ro`);
    expect(asFolder).toContain('/data/srv:/data/srv');
    expect(asFolder).toContain('SRV_ROOT=/data/srv');
    expect(asFolder.at(-1)).toBe('--from=/restore-from');
    expect(asFolder.some((a) => a.startsWith('--prefix'))).toBe(false);

    const asFile = run(`img /srv /srv/panel/e/env ${JSON.stringify(path.join(folder, 'panel.db.gz'))} '' 0`).argv;
    expect(asFile).toContain(`${folder}:/restore-from:ro`);
    expect(asFile.at(-1)).toBe('--from=/restore-from/panel.db.gz');
  });

  it('fails as the restore did', () => {
    expect(run("img /srv /srv/panel/e/env '' '' 1", 1).status).toBe(1);
  });
});

describe('restores refused before anything is installed', () => {
  const setup = (args: string[], script = path.join(ROOT, 'provision/setup.sh')) =>
    spawnSync('bash', [script, ...args], { encoding: 'utf8', input: '' });
  const install = (args: string[]) => spawnSync('bash', [path.join(ROOT, 'install.sh'), ...args], { encoding: 'utf8', input: '' });

  it('refuses a restore on a worker', () => {
    for (const res of [setup(['--restore-from=/tmp', '--role=worker']), install(['--role=worker', '--restore'])]) {
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('A worker has no panel database to restore.');
    }
  });

  it('asks for a terminal when it would have to ask for the destination', () => {
    const res = setup(['--restore']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('needs a terminal');
    expect(res.stderr).toContain('--restore-from=<path>');
    // Piped from curl, which is how install.sh is documented to run.
    const piped = install(['--restore', '--panel-domain=panel.example.com']);
    expect(piped.status).toBe(1);
    expect(piped.stderr).toContain("sudo bash install.sh --restore");
  });

  it('names a snapshot path that is not there, or that Docker cannot mount', () => {
    for (const res of [setup(['--restore-from=/nonexistent/panel.db.gz']), install(['--restore-from=/nonexistent/panel.db.gz'])]) {
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('/nonexistent/panel.db.gz does not exist');
    }
    const colon = path.join(tmp(), 'snap:shot');
    fs.mkdirSync(colon);
    expect(setup([`--restore-from=${colon}`]).stderr).toContain('cannot contain a colon');
  });

  it('refuses an install that is already there', () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, 'provision'));
    fs.mkdirSync(path.join(repo, 'deploy'));
    for (const f of ['setup.sh', 'lib.sh']) fs.copyFileSync(path.join(ROOT, 'provision', f), path.join(repo, 'provision', f));
    fs.writeFileSync(path.join(repo, 'deploy/.env'), 'SERVER_ROLE=main\n');
    const res = setup(['--restore'], path.join(repo, 'provision/setup.sh'));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`this server already has ${path.join(repo, 'deploy/.env')}`);
    expect(res.stderr).toContain('without --restore');
  });
});
