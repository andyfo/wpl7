/**
 * deploy/.env as Docker Compose reads it: each value `wpl7_env_set` writes (provision/lib.sh) reaches
 * a container as it was given, through `docker compose --env-file`, the way every service in
 * deploy/docker-compose.yml takes its settings. Compose expands `$` in a value written plain and cuts
 * ` #…` off as a comment, so the writer quotes what compose would change; this checks that compose
 * reads those quotes as the writer means them.
 *
 * Opt-in: needs Docker and its compose plugin, and pulls busybox the first time. Another compose,
 * such as a release binary downloaded to try it, goes in WPL7_ENGINE_COMPOSE.
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/envFile.test.ts
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../provision/lib.sh');
const COMPOSE = process.env.WPL7_ENGINE_COMPOSE ? [process.env.WPL7_ENGINE_COMPOSE] : ['docker', 'compose'];

/** Passwords and tokens as people type them: every character compose treats as its own, and some it doesn't. */
const VALUES = [
  'plain-value_1.2',
  '[smtp.example.com]:587',
  'relay@example.com',
  'pa$word',
  '$HOME',
  '${HOME}',
  '$$',
  'a$',
  'a #b',
  '#hash',
  'a#b',
  "it's",
  "'single'",
  'q"q',
  '"double"',
  'a\\b',
  'ends\\',
  'x\\ny',
  'a\\$b',
  'a`id`b',
  '$(id)',
  ' spaced ',
  'two  spaces',
  'tab\there',
  'x=y=z',
  'ümlaut€',
  '!bang!',
  '&|;<>*?~',
  '{}[]()',
  '',
];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: { ...process.env, ...opts.env } });
  if (res.error) throw res.error;
  return res;
}

describe.skipIf(!ENABLED)('deploy/.env through Docker Compose', () => {
  it('hands a container every value wpl7_env_set wrote, as it was given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-engine-env-'));
    dirs.push(dir);
    const env = path.join(dir, '.env');
    fs.writeFileSync(env, '');
    const names = VALUES.map((_, i) => `V${i}`);
    const written = run('bash', ['-c', `set -euo pipefail\n. "$LIB"\n${names.map((n) => `wpl7_env_set "$F" ${n} "$IN_${n}"`).join('\n')}`], {
      env: { LIB, F: env, ...Object.fromEntries(VALUES.map((v, i) => [`IN_V${i}`, v])) },
    });
    expect(written.stderr).toBe('');
    expect(written.status).toBe(0);

    fs.writeFileSync(
      path.join(dir, 'compose.yml'),
      ['services:', '  probe:', '    image: busybox:1.37', '    environment:', ...names.map((n) => `      ${n}: \${${n}:-}`), ''].join('\n'),
    );
    const version = run(COMPOSE[0]!, [...COMPOSE.slice(1), 'version', '--short']);
    console.log(`compose ${version.stdout.trim()}`);
    const project = `wpl7-env-${process.pid}`;
    const compose = (...args: string[]) => run(COMPOSE[0]!, [...COMPOSE.slice(1), '-p', project, '--env-file', env, '-f', 'compose.yml', ...args], { cwd: dir });
    try {
      // NUL after each: any value survives, an empty one and one with a line break among them.
      const seen = compose('run', '--rm', '--no-deps', '-T', 'probe', 'sh', '-c', names.map((n) => `printf '%s\\0' "$${n}"`).join('; '));
      expect(seen.status, seen.stderr).toBe(0);
      expect(seen.stdout.split('\0').slice(0, -1)).toEqual(VALUES);
    } finally {
      compose('down', '--remove-orphans');
    }
  }, 180_000);
});
