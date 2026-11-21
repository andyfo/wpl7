// @docs get-started/installation, reference/installer-and-scripts
/**
 * node dist/src/cli/restore.js: the panel's database back from a snapshot, before its first start.
 *
 * provision/setup.sh runs it for `--restore` and `--restore-from=` (provision/lib.sh,
 * wpl7_restore_snapshot), inside the panel image it is about to start:
 *
 *   docker run --rm -it --network none \
 *     -v /var/run/docker.sock:/var/run/docker.sock -v /srv:/srv -e SRV_ROOT=/srv \
 *     <panel image> node dist/src/cli/restore.js --env-out=/srv/panel/.restore-env.XXXXXX/env
 *
 * That image, because the database has to be one its migrations can take. SRV_ROOT at the same
 * path on both sides, as the panel mounts it: the rclone container this starts beside itself binds
 * a folder under it, and the Docker daemon reads that path on the host. No network: this talks to
 * the daemon over its socket, and only rclone's container goes out to the destination.
 *
 *   --from=PATH      a snapshot downloaded by hand: its folder, its panel.db.gz, or a folder of them
 *   --env-out=FILE   where the values for deploy/.env go, as KEY=value lines (envFileText)
 *   --prefix=NAME    the path prefix to offer, usually the panel's domain
 *   --replace        replace an existing panel.db without asking
 *
 * Without --from it asks for the destination, so it needs a terminal (`-it`). Exits 0 once panel.db
 * is in place and the env file written, 1 when it stopped, 2 on a wrong flag, 130 on Ctrl-C.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { PANEL_VERSION } from '../lib/version.js';
import { DockerService } from '../services/docker.js';
import { terminalPrompter } from './prompt.js';
import { restorePanel, type RestoreRequest } from './snapshotRestore.js';

const USAGE = 'Usage: node dist/src/cli/restore.js [--from=PATH] [--env-out=FILE] [--prefix=NAME] [--replace]';

function parseArgs(argv: string[]): RestoreRequest | string {
  const req: RestoreRequest = {};
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (flag === '--from' && value) req.from = value;
    else if (flag === '--env-out' && value) req.envOut = value;
    else if (flag === '--prefix') req.prefix = value || undefined;
    else if (arg === '--replace') req.replace = true;
    else return `Unknown flag: ${arg}\n${USAGE}`;
  }
  return req;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const req = parseArgs(argv);
  if (typeof req === 'string') {
    process.stderr.write(`${req}\n`);
    return 2;
  }

  // Only the paths and the rclone image are wanted here, and none of the checks a production
  // panel makes of its own environment, which this container does not have.
  const config = loadConfig({ SRV_ROOT: process.env.SRV_ROOT ?? '/srv' });
  fs.mkdirSync(config.paths.panel, { recursive: true, mode: 0o700 });
  const workDir = fs.mkdtempSync(path.join(config.paths.panel, '.restore-'));
  const cleanUp = () => fs.rmSync(workDir, { recursive: true, force: true });

  // Ctrl-C at a question reaches readline, elsewhere the process. Either way nothing half done may
  // stay behind: the database is only moved into place as the last step, from this folder.
  const interrupted = (code: number) => () => {
    io?.close();
    cleanUp();
    process.stderr.write('\nStopped. No database was put in place.\n');
    process.exit(code);
  };
  const io = process.stdin.isTTY
    ? terminalPrompter({ input: process.stdin, output: process.stdout, onInterrupt: interrupted(130) })
    : null;
  process.on('SIGINT', interrupted(130));
  process.on('SIGTERM', interrupted(143));

  const say = (line: string) => process.stdout.write(`${line}\n`);
  try {
    await restorePanel(req, {
      docker: new DockerService(config.proxyNetwork, config.dbNetwork),
      rcloneImage: config.rcloneImage,
      dbFile: config.paths.dbFile,
      workDir,
      migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)),
      runningVersion: PANEL_VERSION,
      io,
      say,
      panelContainer: 'wpl7-panel',
    });
    return 0;
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    io?.close();
    cleanUp();
  }
}

// Explicitly: Docker's connection pool would otherwise keep the process alive for a while.
process.exit(await main(process.argv.slice(2)));
