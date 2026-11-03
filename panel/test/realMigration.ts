import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { FakeDocker } from './helpers.js';

/**
 * The migration's throwaway container (services/siteMigration.ts), in a test world, which has no
 * containers: the script it really runs, on real PHP, over the site's real folder. What Apache and
 * PHP-FPM make of the result is for test/engine/siteStack.test.ts.
 */

export const HAS_PHP = spawnSync('php', ['-v']).status === 0;

/**
 * From here on `docker` runs the real script for every migration it is asked for. `onServer` is for
 * a server whose files are somewhere else on this machine (MappedFiles). Its PHP has no ini files,
 * which the script doesn't need: the site's limits only matter to a leftover that is lower.
 */
export function useRealMigration(docker: FakeDocker, onServer: (file: string) => string = (file) => file): void {
  const other = docker.ephemeral;
  docker.ephemeral = (opts) => {
    if (!opts.labels?.['wpl7.migration']) return other ? other(opts) : (docker.execQueue.shift() ?? docker.execDefault);
    const folder = opts.binds!.find((bind) => bind.endsWith(':/var/www/html'))!.split(':')[0]!;
    const args = [...opts.cmd];
    const script = args.indexOf('-r') + 1;
    args[script] = args[script]!.replace("const ROOT = '/var/www/html';", `const ROOT = ${JSON.stringify(fs.realpathSync(onServer(folder)))};`);
    const res = spawnSync('php', ['-n', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? -1 };
  };
}
