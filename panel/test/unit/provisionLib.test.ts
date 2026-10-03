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

describe('install.sh', () => {
  it('hands setup.sh --non-interactive when stdin is a pipe', () => {
    // The documented command is `curl … | bash -s -- …`, which leaves setup.sh holding the
    // exhausted pipe as its stdin. Its admin-password prompt then reads EOF, `read` returns
    // non-zero, and `set -e` ends the install before .env is written or anything is started.
    //
    // Only the decision is exercised here: `id` says root so the installer gets past its own
    // guard, `jq` exists so it does not try to apt-get one, and `curl` fails so it stops at
    // the release lookup rather than reaching the network.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-inst-'));
    stubs.push(dir);
    fs.writeFileSync(path.join(dir, 'id'), '#!/usr/bin/env bash\necho 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'jq'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'curl'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

    const res = spawnSync(
      'bash',
      [path.join(ROOT, 'install.sh'), '--panel-domain=p.example.com', '--dev-domain=d.example.com', '--acme-email=a@b.test'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` } },
    );

    expect(res.stdout).toContain('stdin is not a terminal');
    expect(res.stdout).toContain('admin password is generated');
    // It reached the release lookup, which is where the stubbed curl stops it - so nothing
    // between the decision and there aborted first.
    expect(res.stderr).toContain('GitHub API');
  });
});
