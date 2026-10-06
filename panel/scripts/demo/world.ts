/**
 * The demo's world: the test suite's fake world (test/helpers.ts makeWorld - the real services
 * and routes over in-memory SQLite, with fake Docker, fake hosts and no network), given the
 * demo's names and a few fakes that answer the way a well-used install would: server facts,
 * DNS answers for the mail checks, a published release, the plugin directory.
 */
import type { ExecPort, ExecResult } from '../../src/lib/exec.js';
import { SYSTEM_INFO_SCRIPT } from '../../src/servers/systemInfo.js';
import type { DnsResolver } from '../../src/services/mailDns.js';
import { FakeGitHub, FakeWporg, makeWorld, type TestWorld } from '../../test/helpers.js';
import { ADMIN_PASSWORD, ADMIN_USER, DEV_DOMAIN, PANEL_DOMAIN, SERVERS, type DemoServer } from './data.js';
import { DNS_TXT, DNS_A, DNS_PTR } from './dnsRecords.js';
import { WPORG_PLUGINS } from './plugins.js';

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

/** What a provisioned Ubuntu server answers to the panel's facts script (servers/systemInfo.ts). */
function systemInfo(server: DemoServer): string {
  const uptimeDays = { fra1: 41, nyc1: 41, sin1: 23 }[server.name] ?? 30;
  return [
    server.name,
    '7.0.0-14-generic',
    'x86_64',
    '===',
    'PRETTY_NAME="Ubuntu 26.04 LTS"',
    'NAME="Ubuntu"',
    'VERSION="26.04 LTS (Resolute Raccoon)"',
    '===',
    String(server.cpus),
    '===',
    `${uptimeDays * 86400 + 3725}.42 ${uptimeDays * 86400 * 3}.10`,
    '===',
    'processor\t: 0',
    'model name\t: AMD EPYC Processor',
    '===',
    `MemTotal:       ${server.memGb * 1024 * 1024 - 204800} kB`,
    '===',
    'Docker version 29.8.1, build 7d4bcd8',
  ].join('\n');
}

export function demoExec(server: DemoServer): ExecPort {
  return {
    async run(_cmd, args) {
      if (args[1] === SYSTEM_INFO_SCRIPT) return ok(systemInfo(server));
      return ok();
    },
    async runWithInput(_cmd, _args, input) {
      input.resume();
      return ok();
    },
    async runToStream() {
      return { exitCode: 0, stderr: '' };
    },
  };
}

/** Public DNS as the mail setup guide and the server pages see it, from dnsRecords.ts. */
export const demoResolver: DnsResolver = {
  async resolveTxt(name) {
    const records = DNS_TXT[name.toLowerCase()];
    if (!records) throw Object.assign(new Error(`queryTxt ENODATA ${name}`), { code: 'ENODATA' });
    return records.map((r) => [r]);
  },
  async resolve4(name) {
    const lower = name.toLowerCase();
    const direct = DNS_A[lower];
    if (direct) return [direct];
    // The fleet's dev wildcard points at fra1.
    if (lower.endsWith(`.${DEV_DOMAIN}`)) return [SERVERS[0]!.ip];
    throw Object.assign(new Error(`queryA ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
  },
  async resolveMx(name) {
    if (DNS_TXT[name.toLowerCase()]) return [{ exchange: `mx.${name.toLowerCase()}`, priority: 10 }];
    return [];
  },
  async reverse(ip) {
    const name = DNS_PTR[ip];
    if (!name) throw Object.assign(new Error(`getHostByAddr ENOTFOUND ${ip}`), { code: 'ENOTFOUND' });
    return [name];
  },
};

export async function buildWorld(): Promise<TestWorld> {
  // The release this install runs is the latest one: Settings → Updates says it is up to date.
  const version = process.env.WPL7_VERSION!;
  const github = new FakeGitHub().release({
    version,
    channel: 'stable',
    publishedAt: '2026-09-29T09:12:00Z',
    notesUrl: `https://github.com/andyfo/wpl7/releases/tag/v${version}`,
    images: { panel: `ghcr.io/andyfo/wpl7/panel:${version}`, wordpress: {} },
  });
  const wporg = new FakeWporg([]);
  for (const plugin of WPORG_PLUGINS) wporg.add(plugin.slug, plugin);
  const world = await makeWorld({
    env: {
      PANEL_DOMAIN,
      DEV_DOMAIN,
      PANEL_ADMIN_USER: ADMIN_USER,
      PANEL_ADMIN_PASSWORD: ADMIN_PASSWORD,
      SERVER_PUBLIC_IP: SERVERS[0]!.ip,
      // Sites and the panel are https in every screenshot, as on a real install.
      TLS_MODE: 'letsencrypt',
      WPL7_CHANNEL: 'stable',
    },
    exec: demoExec(SERVERS[0]!),
    resolver: demoResolver,
    github,
    wporg,
    // The feedback dialog is never sent from the demo.
    communityPost: async () => ({ status: 200, text: async () => '' }),
  });
  return world;
}
