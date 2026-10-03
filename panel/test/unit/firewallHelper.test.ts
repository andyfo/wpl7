/**
 * provision/firewall/wpl7-firewall runs as root on every server, from a boot unit and from
 * the panel. Here it runs against a stand-in `nft` that keeps its one table in a file - enough
 * to hold it to its promises: check before loading, only ever its own table, off means off
 * until on, and a boot that can never fail.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HELPER = path.join(ROOT, 'provision/firewall/wpl7-firewall');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const GOOD = [
  'table inet wpl7',
  'delete table inet wpl7',
  'table inet wpl7 {',
  '\tchain prerouting {',
  '\t\ttype filter hook prerouting priority -310; policy accept;',
  '\t}',
  '}',
  '',
].join('\n');

function box() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-fw-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const table = path.join(dir, 'kernel-table');
  const log = path.join(dir, 'nft-calls');
  fs.writeFileSync(
    path.join(bin, 'nft'),
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      `  "list table inet wpl7") [ -f ${JSON.stringify(table)} ] ;;`,
      `  "delete table inet wpl7") rm -f ${JSON.stringify(table)} ;;`,
      '  "-c -f "*) grep -q "policy accept" "${@: -1}" || { echo "Error: syntax error, unexpected string" >&2; exit 1; } ;;',
      `  "-f "*) cp "\${@: -1}" ${JSON.stringify(table)} ;;`,
      '  *) echo "unexpected nft $*" >&2; exit 3 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const srv = path.join(dir, 'srv');
  const rules = path.join(srv, 'wpl7-firewall', 'wpl7.nft');
  const run = (...args: string[]) => {
    const res = spawnSync('bash', [HELPER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SRV_ROOT: srv },
    });
    const line = res.stdout.trim().split('\n').pop() ?? '';
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(line) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { code: res.status, json, stderr: res.stderr };
  };
  const write = (text: string) => {
    fs.mkdirSync(path.dirname(rules), { recursive: true });
    fs.writeFileSync(rules, text);
  };
  /** As if the panel had written the file this long ago. */
  const age = (seconds: number) => {
    const then = Date.now() / 1000 - seconds;
    fs.utimesSync(rules, then, then);
  };
  return {
    run,
    write,
    age,
    rules,
    loaded: () => (fs.existsSync(table) ? fs.readFileSync(table, 'utf8') : null),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

describe('wpl7-firewall', () => {
  it('says nothing is loaded before the panel wrote anything', () => {
    const b = box();
    expect(b.run('status')).toMatchObject({ code: 0, json: { state: 'missing', table: false } });
    expect(b.run('apply')).toMatchObject({ code: 0, json: { state: 'missing' } });
  });

  it('checks the file, then loads it', () => {
    const b = box();
    b.write(GOOD);
    expect(b.run('apply')).toMatchObject({ code: 0, json: { state: 'ok', table: true } });
    expect(b.calls().filter((c) => c.includes('-f'))).toEqual([expect.stringMatching(/^-c -f /), expect.stringMatching(/^-f /)]);
    expect(b.loaded()).toBe(GOOD);
    expect(b.run('status')).toMatchObject({ json: { state: 'ok', table: true } });
  });

  it('refuses a file that reaches beyond its own table, and keeps what is loaded', () => {
    const b = box();
    b.write(GOOD);
    b.run('apply');
    for (const bad of ['flush ruleset', 'table ip filter', 'delete table inet filter', 'add rule inet filter input drop']) {
      b.write(`${bad}\n${GOOD}`);
      const res = b.run('apply');
      expect(res.code, bad).toBe(1);
      expect(res.json).toMatchObject({ state: 'error', message: expect.stringContaining('refused') });
      expect(b.loaded()).toBe(GOOD);
    }
  });

  it("refuses what nft's own check refuses", () => {
    const b = box();
    b.write(GOOD);
    b.run('apply');
    b.write(GOOD.replace('policy accept', 'policy nonsense'));
    const res = b.run('apply');
    expect(res).toMatchObject({ code: 1, json: { state: 'error', message: expect.stringContaining('nft -c: Error: syntax error') } });
    expect(b.loaded()).toBe(GOOD);
  });

  it('stays off until switched on, whatever the panel writes meanwhile', () => {
    const b = box();
    b.write(GOOD);
    b.run('apply');
    expect(b.run('off')).toMatchObject({ code: 0, json: { state: 'off', table: false } });
    expect(b.loaded()).toBeNull();
    expect(b.run('apply')).toMatchObject({ code: 0, json: { state: 'off' } });
    expect(b.loaded()).toBeNull();
    expect(b.run('status')).toMatchObject({ json: { state: 'off' } });
    expect(b.run('boot')).toMatchObject({ code: 0 });
    expect(b.loaded()).toBeNull();
    expect(b.run('on')).toMatchObject({ code: 0, json: { state: 'ok', table: true } });
  });

  it('loads the last list at boot and never fails the boot', () => {
    const b = box();
    expect(b.run('boot').code).toBe(0);
    b.write(GOOD);
    expect(b.run('boot').code).toBe(0);
    expect(b.loaded()).toBe(GOOD);
    b.write(GOOD.replace('policy accept', 'policy nonsense'));
    const res = b.run('boot');
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/could not load/);
  });

  it('gives a timed block what is left of it when the file is loaded late, and none again once it is up', () => {
    const b = box();
    const timed = GOOD.replace('\tchain prerouting {', '\tset timed4 {\n\t\telements = {\n\t\t\t198.18.0.1 timeout 3600s, 198.18.0.2 timeout 50s\n\t\t}\n\t}\n\tchain prerouting {');
    b.write(timed);
    // Written a hundred seconds ago, loaded at boot with the panel down.
    b.age(100);
    expect(b.run('boot').code).toBe(0);
    expect(b.loaded()).toMatch(/198\.18\.0\.1 timeout 3(499|500)s, 198\.18\.0\.2 timeout 1s\n/);
    // What the panel loads straight after writing it is what it wrote.
    b.write(timed);
    expect(b.run('apply')).toMatchObject({ code: 0, json: { state: 'ok' } });
    expect(b.loaded()).toMatch(/198\.18\.0\.1 timeout 3(599|600)s, 198\.18\.0\.2 timeout (49|50)s\n/);
    // The copy it loaded is not left lying about.
    expect(fs.existsSync(`${b.rules}.load`)).toBe(false);
  });

  it('explains itself when called without a command', () => {
    const res = box().run();
    expect(res.code).toBe(2);
  });
});
