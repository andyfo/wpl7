/**
 * What the demo's containers answer when the panel asks them something: the mail relay its
 * hostname, milter and queue, and the site containers what WordPress would say. The fake Docker
 * (test/helpers.ts) answers everything else with an empty success. Set DEMO_DEBUG=1 to log the
 * commands nothing here answers.
 */
import type { Writable } from 'node:stream';
import type { ExecOpts, RunResult } from '../../src/services/docker.js';
import type { FakeDocker, TestWorld } from '../../test/helpers.js';
import { DEV_DOMAIN, SERVERS } from './data.js';
import { MAIL_HOSTNAMES } from './dnsRecords.js';
import { answerFileScript, writeTo } from './files.js';
import { INVENTORY, WORDPRESS } from './plugins.js';

const ok = (stdout = ''): RunResult => ({ stdout, stderr: '', exitCode: 0 });

/** Sites in maintenance mode, whose container has a .maintenance file. */
export const IN_MAINTENANCE = new Set(['cedar-stone']);

function siteAnswer(slug: string, cmd: string[]): RunResult | null {
  const line = cmd.join(' ');
  if (cmd[0] === 'wp' && cmd[1] === 'core' && cmd[2] === 'version') return ok(`${INVENTORY[slug]?.core ?? WORDPRESS}\n`);
  if (cmd[0] === 'wp' && cmd[1] === 'maintenance-mode' && (cmd[2] === 'status' || cmd[2] === 'is-active')) {
    return IN_MAINTENANCE.has(slug) ? ok('Maintenance mode is active.\n') : { stdout: '', stderr: '', exitCode: 1 };
  }
  if (/test -f .*\.maintenance/.test(line) || /\[ -f .*\.maintenance/.test(line)) {
    return IN_MAINTENANCE.has(slug) ? ok() : { stdout: '', stderr: '', exitCode: 1 };
  }
  return null;
}

export function installDemoDocker(world: TestWorld): void {
  for (const server of SERVERS) {
    const docker: FakeDocker = server.id === 1 ? world.docker : world.remote(server.id).docker;
    const original = docker.exec.bind(docker);
    docker.exec = async (name: string, cmd: string[], opts?: ExecOpts): Promise<RunResult> => {
      if (name === 'wpl7-mail') {
        if (cmd[0] === 'postconf' && cmd.includes('myhostname')) {
          return ok(`${MAIL_HOSTNAMES[server.name] ?? `mail.${DEV_DOMAIN}`}\n\ninet:wpl7-dkim:8891\n`);
        }
        if (cmd[0] === 'postqueue' && cmd[1] === '-j') return ok('');
        if (cmd[0] === 'sh' && /nc -z/.test(cmd[2] ?? '')) return ok('open\n');
      }
      if (name.startsWith('wp-')) {
        const answer = siteAnswer(name.slice(3), cmd) ?? answerFileScript(name.slice(3), cmd);
        if (answer) return { ...answer, stdout: answer.stdout.toString() };
      }
      const result = await original(name, cmd, opts);
      if (process.env.DEMO_DEBUG) console.log(`[demo] exec ${server.name} ${name}: ${cmd.join(' ').slice(0, 160)}`);
      return result;
    };
    const originalStream = docker.execToStream.bind(docker);
    docker.execToStream = async (name: string, cmd: string[], stdout: Writable, opts?: ExecOpts) => {
      if (name.startsWith('wp-')) {
        const answer = answerFileScript(name.slice(3), cmd);
        if (answer) {
          writeTo(stdout, answer.stdout);
          return { exitCode: answer.exitCode, stderr: answer.stderr };
        }
      }
      if (process.env.DEMO_DEBUG) console.log(`[demo] stream ${server.name} ${name}: ${cmd.join(' ').slice(0, 160)}`);
      return originalStream(name, cmd, stdout, opts);
    };
  }
}
