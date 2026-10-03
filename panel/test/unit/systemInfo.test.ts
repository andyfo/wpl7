import { describe, expect, it } from 'vitest';
import { parseSystemInfo, SYSTEM_INFO_SCRIPT, SystemInfoService } from '../../src/servers/systemInfo.js';
import { formatUptime } from '../../web/src/lib/format.js';
import { FakeExec, makeWorld } from '../helpers.js';

/** What SYSTEM_INFO_SCRIPT prints on an ordinary Ubuntu host. */
const UBUNTU = `web-01
6.8.0-45-generic
x86_64
===
PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
===
4
===
1923847.31 7512345.02
===
processor\t: 0
vendor_id\t: GenuineIntel
cpu family\t: 6
model\t\t: 85
model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
stepping\t: 7
===
MemTotal:        8127484 kB
MemFree:         1037112 kB
MemAvailable:    5231008 kB
===
Docker version 27.3.1, build ce12230
`;

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('parseSystemInfo', () => {
  it('reads what an Ubuntu host reports', () => {
    expect(parseSystemInfo(UBUNTU)).toEqual({
      os: 'Ubuntu 24.04.1 LTS',
      kernel: '6.8.0-45-generic',
      arch: 'x86_64',
      hostname: 'web-01',
      cpuModel: 'Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz',
      cpus: 4,
      memTotalBytes: 8127484 * 1024,
      uptimeSeconds: 1923847.31,
      dockerVersion: 'Docker version 27.3.1, build ce12230',
    });
  });

  it('leaves every field it was not told about null rather than guessing', () => {
    // A host with no /etc/os-release, no Docker CLI and an ARM /proc/cpuinfo (which has no
    // "model name" line at all) still yields a usable reading of the rest.
    const partial = ['pi', '6.6.51+rpt-rpi-v8', 'aarch64', '===', '', '===', '4', '===', '', '===', '', '===', '', '===', ''].join('\n');
    expect(parseSystemInfo(partial)).toMatchObject({
      os: null,
      kernel: '6.6.51+rpt-rpi-v8',
      hostname: 'pi',
      cpus: 4,
      cpuModel: null,
      memTotalBytes: null,
      uptimeSeconds: null,
      dockerVersion: null,
    });
  });

  it('falls back to NAME + VERSION when os-release has no PRETTY_NAME', () => {
    const noPretty = UBUNTU.replace(/^PRETTY_NAME=.*$/m, '');
    expect(parseSystemInfo(noPretty).os).toBe('Ubuntu 24.04.1 LTS (Noble Numbat)');
  });

  it('survives a reply that was cut short', () => {
    expect(parseSystemInfo('')).toMatchObject({ os: null, kernel: null, cpus: null });
    expect(parseSystemInfo('web-01\n6.8.0\n')).toMatchObject({ hostname: 'web-01', kernel: '6.8.0', arch: null });
  });
});

describe('SystemInfoService', () => {
  it('asks the server once and serves the reading from memory afterwards', async () => {
    const exec = new FakeExec();
    exec.resultDefault = { stdout: UBUNTU, stderr: '', exitCode: 0 };
    const w = await makeWorld({ exec });
    const service = new SystemInfoService(w.servers, log);

    const first = await service.describe(1);
    expect(first).toMatchObject({ serverId: 1, reachable: true, error: null, os: 'Ubuntu 24.04.1 LTS', cpus: 4 });
    const infoCalls = () => exec.calls.filter((c) => c.args[1] === SYSTEM_INFO_SCRIPT).length;
    expect(infoCalls()).toBe(1);

    await service.describe(1);
    expect(infoCalls()).toBe(1); // cached

    await service.describe(1, { refresh: true });
    expect(infoCalls()).toBe(2);
  });

  it('reports an unreachable server as unreachable instead of as a blank machine', async () => {
    const w = await makeWorld();
    const broken = w.addSshServer('s2');
    // Mutate the registered fake, not the copy addSshServer handed back: the registry
    // builds its handle from the former.
    w.remote(broken.id).exec = {
      run: () => Promise.reject(new Error('connect ETIMEDOUT 198.51.100.7:22')),
      runWithInput: () => Promise.reject(new Error('nope')),
      runToStream: () => Promise.reject(new Error('nope')),
    };
    const service = new SystemInfoService(w.servers, log);

    const dto = await service.describe(broken.id);
    expect(dto.reachable).toBe(false);
    expect(dto.error).toMatch(/ETIMEDOUT/);
    expect(dto.os).toBeNull();
  });

  it('refuses an id that is not a server', async () => {
    const w = await makeWorld();
    await expect(new SystemInfoService(w.servers, log).describe(404)).rejects.toThrow(/not found/);
  });
});

describe('formatUptime', () => {
  it('shows the two largest units and nothing smaller', () => {
    expect(formatUptime(1923847)).toBe('22d 6h');
    expect(formatUptime(9000)).toBe('2h 30m');
    expect(formatUptime(300)).toBe('5m');
    expect(formatUptime(null)).toBe('–');
    expect(formatUptime(-1)).toBe('–');
  });
});
