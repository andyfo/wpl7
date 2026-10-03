import { describe, expect, it } from 'vitest';
import type { ServerDto } from '../../shared/types.js';
import { pickTerminalServer } from '../../web/src/pages/terminalTarget.js';

const server = (id: number, name: string): ServerDto => ({
  id,
  name,
  kind: id === 1 ? 'local' : 'ssh',
  sshHost: id === 1 ? null : `${name}.example.test`,
  sshPort: 22,
  sshUser: 'wpl7-panel',
  hostKeySha256: null,
  publicIp: '198.51.100.1',
  devDomain: 'dev.example.test',
  dnsProvider: '',
  status: 'ok',
  lastSeenAt: null,
  lastError: null,
  sitesCount: 0,
  createdAt: 0,
});

const FLEET = [server(1, 'local'), server(2, 'fra-1'), server(3, 'hel-1')];

describe('pickTerminalServer', () => {
  it('waits for the fleet default rather than opening the first server it sees', () => {
    // /api/servers answered; /api/meta, which carries defaultServerId, has not.
    expect(pickTerminalServer(FLEET, { remembered: null, defaultServerId: undefined, metaSettled: false })).toBeNull();
    expect(pickTerminalServer(FLEET, { remembered: null, defaultServerId: 3, metaSettled: true })).toBe(3);
  });

  it('opens the server used last, without waiting for anything', () => {
    expect(pickTerminalServer(FLEET, { remembered: 2, defaultServerId: undefined, metaSettled: false })).toBe(2);
  });

  it('ignores a remembered server that is no longer registered', () => {
    expect(pickTerminalServer(FLEET, { remembered: 99, defaultServerId: undefined, metaSettled: false })).toBeNull();
    expect(pickTerminalServer(FLEET, { remembered: 99, defaultServerId: 2, metaSettled: true })).toBe(2);
  });

  it('falls back to the first server once metadata is settled but useless', () => {
    // A failed /api/meta counts as settled: the page must not wait forever for it.
    expect(pickTerminalServer(FLEET, { remembered: null, defaultServerId: undefined, metaSettled: true })).toBe(1);
    // …and so does a default naming a server that has since been removed.
    expect(pickTerminalServer(FLEET, { remembered: null, defaultServerId: 42, metaSettled: true })).toBe(1);
  });

  it('has nothing to open before the fleet list arrives', () => {
    expect(pickTerminalServer([], { remembered: 2, defaultServerId: 2, metaSettled: true })).toBeNull();
  });
});
