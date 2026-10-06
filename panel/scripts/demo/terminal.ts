/**
 * The web terminal: a session that opens on a `docker ps` the server has just answered, so the
 * Terminal shot shows the stack and its sites. The test suite's fake shell (test/helpers.ts
 * FakeShell) stands in for SSH; nothing connects anywhere.
 */
import type { OpenTerminal, ShellConnectFn } from '../../src/servers/terminal.js';
import type { TestWorld } from '../../test/helpers.js';

const GREEN = '\x1b[1;32m';
const BLUE = '\x1b[1;34m';
const RESET = '\x1b[0m';

function session(host: string): string {
  const prompt = `${GREEN}root@${host}${RESET}:${BLUE}~${RESET}# `;
  const rows = [
    ['NAMES', 'IMAGE', 'STATUS'],
    ['wp-oak-and-ivy', 'wpl7-wordpress:php8.4', 'Up 9 minutes'],
    ['wp-lumen-law', 'wpl7-wordpress:php8.3', 'Up 7 days'],
    ['wp-blue-fern', 'wpl7-wordpress:php8.2', 'Up 7 days'],
    ['wp-alpine-dental', 'wpl7-wordpress:php8.3', 'Up 7 days'],
    ['wp-northwind-bakery', 'wpl7-wordpress:php8.4', 'Up 7 days'],
    ['wpl7-panel', 'ghcr.io/andyfo/wpl7/panel:0.3.0', 'Up 7 days (healthy)'],
    ['wpl7-dkim', 'instrumentisto/opendkim:latest', 'Up 7 days'],
    ['wpl7-mail', 'boky/postfix:latest', 'Up 7 days (healthy)'],
    ['wpl7-mariadb', 'mariadb:11.4', 'Up 7 days (healthy)'],
    ['wpl7-traefik', 'traefik:v3.7', 'Up 7 days'],
  ];
  const widths = [0, 1].map((i) => Math.max(...rows.map((r) => r[i]!.length)) + 3);
  const table = rows.map((r) => `${r[0]!.padEnd(widths[0]!)}${r[1]!.padEnd(widths[1]!)}${r[2]}`).join('\r\n');
  return [
    `Welcome to Ubuntu 26.04 LTS (GNU/Linux 7.0.0-14-generic x86_64)\r\n\r\n`,
    `${prompt}docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'\r\n`,
    `${table}\r\n`,
    `${prompt}uptime\r\n`,
    ` 10:00:12 up 41 days,  1:02,  0 users,  load average: 1.38, 1.27, 1.17\r\n`,
    prompt,
  ].join('');
}

export function installDemoTerminal(world: TestWorld): void {
  const terminal = world.deps.terminal as unknown as { connect: ShellConnectFn };
  terminal.connect = async (opts) => {
    const open: OpenTerminal = await world.shell.connect(opts);
    const host = world.servers.listRows().find((r) => r.sshHost === opts.host || r.publicIp === opts.host)?.name ?? 'fra1';
    setTimeout(() => (open as unknown as { output(data: string): void }).output(session(host)), 250);
    return open;
  };
}
