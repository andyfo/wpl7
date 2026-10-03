import fs from 'node:fs';
import type { ExecResult } from '../lib/exec.js';
import { CommandNotFoundError, hostExec } from '../lib/exec.js';
import type { HostShell } from './hostShell.js';
import type { ServerRegistry } from './registry.js';
import { shellQuote } from './sshExec.js';

/**
 * A command run as root on a server itself - not in the panel's container, and not in a
 * site's. What the network layer of the blocked addresses needs (`wpl7-firewall`), and nothing
 * else so far.
 *
 * On a worker that is its ordinary exec port: SSH with `sudo`, as every host operation there.
 * Server 1 is where the panel's own container runs, so its exec port is the container; the
 * host is reached the way the Update button reaches it, over the host shell (servers/hostShell.ts).
 * A panel running outside any container (`npm run dev`) is on the host already.
 */
export interface HostPort {
  run(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
}

export function hostPortFor(
  serverId: number,
  deps: { servers: ServerRegistry; hostShell: HostShell | null; inContainer?: () => boolean },
): HostPort {
  const row = deps.servers.rowById(serverId);
  if (row?.kind === 'ssh') {
    const handle = deps.servers.handleFor(serverId);
    return { run: (cmd, args, opts) => handle.exec.run(cmd, args, opts) };
  }
  const inContainer = deps.inContainer ?? (() => fs.existsSync('/.dockerenv'));
  if (inContainer() && deps.hostShell) {
    const shell = deps.hostShell;
    return { run: (cmd, args, opts) => shell.run(shellQuote([cmd, ...args]), { timeoutMs: opts?.timeoutMs }) };
  }
  return {
    run: (cmd, args, opts) =>
      hostExec.run(cmd, args, { timeoutMs: opts?.timeoutMs }).catch((err: unknown) => {
        // A missing command exits 127 here too, as it does through SSH and the host shell.
        if (err instanceof CommandNotFoundError) return { stdout: '', stderr: `${cmd}: command not found`, exitCode: 127 };
        throw err;
      }),
  };
}
