/**
 * What the demo's containers answer when the panel asks them something: the mail relay its
 * hostname, milter and queue, and the site containers what WordPress would say - or, in the PHP
 * site's, that there is no WordPress. The fake Docker (test/helpers.ts) answers everything else
 * with an empty success. Set DEMO_DEBUG=1 to log the commands nothing here answers.
 */
import type { Writable } from 'node:stream';
import type { ExecOpts, RunResult } from '../../src/services/docker.js';
import type { FakeDocker, TestWorld } from '../../test/helpers.js';
import { DEV_DOMAIN, SERVERS, isPhpSlug } from './data.js';
import { MAIL_HOSTNAMES } from './dnsRecords.js';
import { answerFileScript, answerTestDir, writeTo } from './files.js';
import { INVENTORY, WORDPRESS } from './plugins.js';

const ok = (stdout = ''): RunResult => ({ stdout, stderr: '', exitCode: 0 });

/** Sites in maintenance mode, whose container has a .maintenance file. */
export const IN_MAINTENANCE = new Set(['cedar-stone']);

/** WP-CLI in a PHP site's container, which has the same image and no WordPress in its folder. */
const NO_WORDPRESS: RunResult = {
  stdout: '',
  stderr: 'Error: This does not seem to be a WordPress installation.\nThe used path is: /var/www/html/\nPass --path=`path/to/wordpress` or run `wp core download`.\n',
  exitCode: 1,
};

function siteAnswer(slug: string, cmd: string[]): RunResult | null {
  const line = cmd.join(' ');
  const php = isPhpSlug(slug);
  // Check a URL, on the Caching card. A PHP site's nginx passes every request through: its page cache is off.
  if (cmd[0] === 'curl') return ok(php ? 'HTTP/1.1 200 OK\r\nX-Cache-Status: BYPASS\r\nX-Cache-Skipped: off\r\n\r\n' : 'HTTP/1.1 200 OK\r\nX-Cache-Status: HIT\r\n\r\n');
  if (php && cmd[0] === 'wp') return NO_WORDPRESS;
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
        const answer = siteAnswer(name.slice(3), cmd) ?? answerFileScript(name.slice(3), cmd) ?? answerTestDir(name.slice(3), cmd);
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
