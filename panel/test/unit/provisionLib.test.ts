/**
 * The shell half of an update.
 *
 * These scripts run with `set -euo pipefail` in a systemd unit, or over SSH on a machine
 * nobody is watching - so a mistake here is not a failed command, it is a provision that
 * stops half way, or an update that stops between replacing the panel and deciding whether
 * to roll back. Worth the subprocess.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LIB = path.join(ROOT, 'provision/lib.sh');

/** A `docker inspect` that answers whatever the test needs, ahead of the real one on PATH. */
function stubDocker(status: string, health: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-stub-'));
  fs.writeFileSync(
    path.join(dir, 'docker'),
    ['#!/usr/bin/env bash', `case "$*" in`, `  *State.Status*) echo '${status}' ;;`, `  *) echo '${health}' ;;`, 'esac', ''].join(
      '\n',
    ),
    { mode: 0o755 },
  );
  stubs.push(dir);
  return dir;
}

const stubs: string[] = [];
afterAll(() => {
  for (const dir of stubs) fs.rmSync(dir, { recursive: true, force: true });
});

function runShell(body: string, stubDir: string) {
  return spawnSync('bash', ['-c', `set -euo pipefail\n. ${JSON.stringify(LIB)}\n${body}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}` },
  });
}

describe('wpl7_wait_healthy', () => {
  it('runs under nounset, with and without an explicit timeout', () => {
    const stub = stubDocker('running', 'healthy');

    // Both forms. Bash expands every word of a `local` before assigning any of them, so a
    // deadline computed on the same line as the timeout reads it while it is still unset -
    // which under `set -u` aborts update.sh on its first health gate, after the panel has
    // been replaced and before anything can roll it back.
    for (const call of ['wpl7_wait_healthy wpl7-panel 5', 'wpl7_wait_healthy wpl7-panel']) {
      const res = runShell(call, stub);
      expect(res.stderr).not.toContain('unbound variable');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('running/healthy');
    }
  });

  it('reports a container that died rather than waiting out the clock', () => {
    const res = runShell('wpl7_wait_healthy wpl7-panel 30', stubDocker('exited', 'unhealthy'));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('exited');
  });
});

describe('wpl7_mail_hostname_set', () => {
  /** A deploy/.env and a /srv/mail, as `setup.sh --mail-hostname=` finds them. */
  function install(env: string, relayEnv: string | null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-mailhost-'));
    stubs.push(dir);
    const envFile = path.join(dir, '.env');
    const relayFile = path.join(dir, 'relay.env');
    fs.writeFileSync(envFile, env);
    if (relayEnv !== null) fs.writeFileSync(relayFile, relayEnv);
    const run = (name: string) =>
      runShell(`wpl7_mail_hostname_set ${JSON.stringify(envFile)} ${JSON.stringify(relayFile)} ${name}`, dir);
    return { envFile, relayFile, run };
  }
  const PANEL_FILE = '# Written by the WPL7 panel (Mail -> Setup guide).\nPOSTFIX_myhostname=srv.example.com\n';

  it('clears the name set in the panel even when .env already holds the one asked for', () => {
    // The override in relay.env wins over .env, so with .env already saying the name, it is
    // the one thing in the way - and a check on .env alone left it there, silently winning.
    const box = install('DEV_DOMAIN=dev.example.com\nMAIL_HOSTNAME=mail.example.com\n', PANEL_FILE);

    const res = box.run('mail.example.com');

    expect(res.status).toBe(0);
    expect(fs.existsSync(box.relayFile)).toBe(false);
    expect(fs.readFileSync(box.envFile, 'utf8')).toBe('DEV_DOMAIN=dev.example.com\nMAIL_HOSTNAME=mail.example.com\n');
    expect(res.stdout).toContain('Cleared the hostname set in the panel (srv.example.com)');
    expect(res.stdout).toContain('Next: add an A record for mail.example.com');
  });

  it('changes .env, and keeps the panel settings that are not the hostname', () => {
    const box = install('MAIL_HOSTNAME=mail.example.com\n', `${PANEL_FILE}POSTFIX_smtp_tls_loglevel=1\n`);

    const res = box.run('smtp.example.com');

    expect(res.status).toBe(0);
    expect(fs.readFileSync(box.envFile, 'utf8')).toBe('MAIL_HOSTNAME=smtp.example.com\n');
    const kept = fs.readFileSync(box.relayFile, 'utf8');
    expect(kept).toContain('POSTFIX_smtp_tls_loglevel=1');
    expect(kept).not.toContain('POSTFIX_myhostname');
    expect(res.stdout).toContain('MAIL_HOSTNAME: mail.example.com -> smtp.example.com');
  });

  it('says so when there is nothing to change', () => {
    const box = install('MAIL_HOSTNAME=mail.example.com\n', null);

    const res = box.run('mail.example.com');

    expect(res.status).toBe(0);
    expect(fs.existsSync(box.relayFile)).toBe(false);
    expect(res.stdout).toContain('already announces mail.example.com');
    expect(res.stdout).not.toContain('Next:');
  });
});

describe('wpl7_stamp', () => {
  it('falls back instead of dying when there is no panel to read a version from', () => {
    // A worker server is a real caller: the bundle the panel pushes it is provision/ +
    // deploy/, with no panel/package.json anywhere. Callers run with pipefail, where a sed
    // that cannot open the file fails the whole assignment - and with it the provision,
    // before any image is built or the stack is started.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-bundle-'));
    stubs.push(empty);

    const res = runShell(`wpl7_stamp ${JSON.stringify(empty)} source; echo "STAMPED:$WPL7_VERSION"`, empty);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('STAMPED:0.0.0-source');
  });

  it('reads the version from package.json when the panel is there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-checkout-'));
    stubs.push(dir);
    fs.mkdirSync(path.join(dir, 'panel'));
    fs.writeFileSync(path.join(dir, 'panel/package.json'), JSON.stringify({ version: '9.9.9' }));

    const res = runShell(`wpl7_stamp ${JSON.stringify(dir)} source; echo "STAMPED:$WPL7_VERSION"`, dir);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('STAMPED:9.9.9-source');
  });
});

/** A folder of commands for a script's PATH: name -> bash body. Every stub logs its call to `calls`. */
function stubCommands(commands: Record<string, string>): { dir: string; calls: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-inst-'));
  stubs.push(dir);
  const log = path.join(dir, 'calls.log');
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\necho "${name} $*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { dir, calls };
}

const INSTALL_FLAGS = ['--panel-domain=p.example.com', '--dev-domain=d.example.com', '--acme-email=a@b.test'];

describe('install.sh', () => {
  it('hands setup.sh --non-interactive when stdin is a pipe', () => {
    // The documented command is `curl … | bash -s -- …`, which leaves setup.sh holding the
    // exhausted pipe as its stdin. Its admin-password prompt then reads EOF, `read` returns
    // non-zero, and `set -e` ends the install before .env is written or anything is started.
    //
    // Only the decision is exercised here: `uname` says x86-64 and `id` says root so the
    // installer gets past its own guards, `jq` exists so it does not try to apt-get one, and
    // `curl` fails so it stops at the release lookup rather than reaching the network.
    const { dir } = stubCommands({ uname: 'echo x86_64', id: 'echo 0', jq: 'exit 0', curl: 'exit 1' });

    const res = spawnSync('bash', [path.join(ROOT, 'install.sh'), ...INSTALL_FLAGS], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });

    expect(res.stdout).toContain('stdin is not a terminal');
    expect(res.stdout).toContain('admin password is generated');
    // It reached the release lookup, which is where the stubbed curl stops it - so nothing
    // between the decision and there aborted first.
    expect(res.stderr).toContain('Could not reach github.com');
  });

  it('stops on an ARM server before it changes or fetches anything', () => {
    // The released images are x86-64 only: on ARM the panel and the DKIM signer exit with
    // "exec format error", and the install used to end with "WPL7 is up" all the same.
    const { dir, calls } = stubCommands({ uname: 'echo aarch64', id: 'echo 0', 'apt-get': 'exit 1', curl: 'exit 1' });

    const res = spawnSync('bash', [path.join(ROOT, 'install.sh'), '--dry-run', ...INSTALL_FLAGS], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('This is an ARM server (aarch64). WPL7 runs on x86-64 (amd64) servers only');
    expect(calls()).toEqual(['uname -m']);
  });

  it('runs dry on a server without jq: finds the release and installs nothing', () => {
    // A blank server has no jq, and a dry run must not install it. It used to skip the install
    // and then need jq to read the release anyway, which it reported as an unreachable GitHub.
    // The PATH is the stubs alone, so there is no jq on it.
    const target = path.join(os.tmpdir(), `wpl7-dry-${process.pid}`);
    const { dir, calls } = stubCommands({
      uname: 'echo x86_64',
      id: 'echo 0',
      tar: 'exit 1',
      'apt-get': 'exit 1',
      // github.com as install.sh asks it: the latest release's redirect, then the manifest
      // followed by the HTTP status on a line of its own.
      curl: [
        'case "$*" in',
        '  *redirect_url*) printf %s https://github.com/andyfo/wpl7/releases/tag/v1.2.3 ;;',
        `  */releases/download/v1.2.3/manifest.json*) printf '{"version": "1.2.3"}\\n\\n200' ;;`,
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
    });
    fs.symlinkSync(spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim(), path.join(dir, 'bash'));

    const res = spawnSync(path.join(dir, 'bash'), [path.join(ROOT, 'install.sh'), '--dry-run', `--dir=${target}`, ...INSTALL_FLAGS], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: dir, WPL7_REPO: 'andyfo/wpl7' },
    });

    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('would run: env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq');
    expect(res.stdout).toContain('andyfo/wpl7 v1.2.3 (stable). jq is not installed, so a dry run does not read its manifest.');
    expect(res.stdout).toContain(`would run: ${target}/provision/setup.sh`);
    expect(calls().filter((c) => !c.startsWith('curl ') && !c.startsWith('uname ') && !c.startsWith('id '))).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('setup.sh', () => {
  it('stops on an ARM server before it installs anything', () => {
    // The same guard as install.sh's, for what runs setup.sh directly: a checkout, and the
    // panel's Add server. A checkout builds the panel and the site images here, but the DKIM
    // signer's comes from Docker Hub for x86-64 only.
    const { dir, calls } = stubCommands({ uname: 'echo aarch64', id: 'echo 0', 'apt-get': 'exit 1' });

    const res = spawnSync('bash', [path.join(ROOT, 'provision/setup.sh'), '--role=worker', '--non-interactive'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('This is an ARM server (aarch64). WPL7 runs on x86-64 (amd64) servers only');
    expect(calls()).toEqual(['uname -m']);
  });
});
