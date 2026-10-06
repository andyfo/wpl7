/**
 * The demo's files live in a temporary directory, but the panel shows them where a real install
 * keeps them: /srv. A screenshot must not show the path of the machine it was taken on, and the
 * docs describe /srv. So the config's site, backup, plugin and panel folders read /srv, and every
 * server's file access is mapped from /srv to the temporary directory. The panel's database and
 * SSH key stay where makeWorld put them.
 */
import type { FilesPort } from '../../src/lib/files.js';
import type { TestWorld } from '../../test/helpers.js';
import { SERVERS } from './data.js';

export const SHOWN_SRV = '/srv';
let realRoot = '';

/** Where a /srv path really is on this machine's disk. */
export function onDisk(p: string): string {
  return p === SHOWN_SRV || p.startsWith(`${SHOWN_SRV}/`) ? realRoot + p.slice(SHOWN_SRV.length) : p;
}

/** Every method of a files port, with each path argument mapped onto the real disk. */
function mapped(inner: FilesPort): FilesPort {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args.map((a) => (typeof a === 'string' ? onDisk(a) : a)));
    },
  });
}

export function presentSrvAs(world: TestWorld): void {
  realRoot = world.config.srvRoot;
  const config = world.config as unknown as { srvRoot: string; paths: Record<string, string> };
  config.srvRoot = SHOWN_SRV;
  for (const key of ['sites', 'backups', 'plugins', 'panel']) {
    config.paths[key] = config.paths[key]!.replace(realRoot, SHOWN_SRV);
  }
  for (const server of SERVERS) {
    const handle = world.servers.handleFor(server.id);
    handle.files = mapped(handle.files);
  }
}
