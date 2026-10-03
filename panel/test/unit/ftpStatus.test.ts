import { describe, expect, it } from 'vitest';
import type { FtpServerStatusDto, FtpStatusDto, SiteFtpDto, SiteFtpUserDto } from '../../shared/types.js';
import {
  ftpOffBanner,
  serverFtpSummary,
  siteFtpSettling,
  siteFtpStatus,
} from '../../web/src/lib/ftpStatus.js';

/**
 * What the FTP tab and the server page say about a site's or a server's FTP. The rule under
 * test: access is only called gone once a sync on the server has confirmed it.
 */

const endpoint: SiteFtpDto['endpoint'] = {
  host: '203.0.113.10',
  sftp: { port: 2222, hostKeys: [] },
  ftp: { available: true, reason: null, port: 21, passivePorts: { start: 30000, end: 30015 }, certFingerprint: null },
};

const user = (over: Partial<SiteFtpUserDto> = {}): SiteFtpUserDto => ({
  id: 1,
  username: 'alpha',
  folder: '',
  expiresAt: null,
  expired: false,
  createdBy: null,
  passwordSetAt: 1,
  createdAt: 1,
  ...over,
});

const status = (state: FtpStatusDto['state'], over: Partial<FtpStatusDto> = {}): FtpStatusDto => ({
  state,
  message: null,
  checkedAt: 1000,
  ...over,
});

const site = (over: Partial<SiteFtpDto> = {}): SiteFtpDto => ({
  enabled: true,
  serverId: 2,
  serverName: 'web-2',
  endpoint,
  status: status('ready'),
  applied: true,
  paused: false,
  users: [user()],
  ...over,
});

const server = (over: Partial<FtpServerStatusDto> = {}): FtpServerStatusDto => ({
  serverId: 2,
  enabled: true,
  endpoint,
  status: status('ready'),
  sites: 1,
  logins: 1,
  activeLogins: 1,
  ...over,
});

describe('a site whose FTP is switched off in Settings', () => {
  it('is off once its server has confirmed it', () => {
    const f = site({ enabled: false, status: status('off') });
    expect(siteFtpStatus(f)).toMatchObject({ label: 'Off', tone: 'idle' });
    expect(ftpOffBanner(f)).toMatchObject({ tone: 'amber', text: expect.stringContaining('work again once it is switched back on') });
    expect(siteFtpSettling(f)).toBe(false);
  });

  it('is not called off while its server cannot be reached: the logins may still work there', () => {
    const f = site({ enabled: false, status: status('unreachable', { message: 'connect ETIMEDOUT' }) });
    expect(siteFtpStatus(f)).toMatchObject({ label: 'Server unreachable', tone: 'bad', detail: expect.stringContaining('cannot reach "web-2"') });
    expect(ftpOffBanner(f)).toMatchObject({ tone: 'red', text: expect.stringContaining('may still work there') });
    expect(ftpOffBanner(f)!.text).not.toMatch(/work again once/);
  });

  it('says so when taking FTP off the server failed', () => {
    const f = site({ enabled: false, status: status('error', { message: 'permission denied' }) });
    expect(siteFtpStatus(f)).toMatchObject({ label: 'Error', tone: 'bad', detail: expect.stringContaining('permission denied') });
    expect(ftpOffBanner(f)!.tone).toBe('red');
  });

  it('is switching off while the teardown is on its way, and looks again soon', () => {
    for (const s of [status('ready'), status('starting'), status('off', { checkedAt: null })]) {
      const f = site({ enabled: false, status: s });
      expect(siteFtpStatus(f)).toMatchObject({ label: 'Switching off…', tone: 'busy' });
      expect(siteFtpSettling(f)).toBe(true);
      expect(ftpOffBanner(f)!.text).toMatch(/has not confirmed it yet/);
    }
  });
});

describe('a site whose logins have all expired', () => {
  const expired = [user({ expiresAt: 1, expired: true }), user({ id: 2, username: 'alpha-2', expiresAt: 5, expired: true })];

  it('is settled once the expiry reached the server - not a setup that is taking long', () => {
    // The server's only live logins were these: the sync tore it down.
    for (const s of [status('off'), status('ready')]) {
      const f = site({ users: expired, status: s });
      expect(siteFtpStatus(f)).toMatchObject({ label: 'Expired', tone: 'idle' });
      expect(siteFtpSettling(f)).toBe(false);
    }
  });

  it('is applying while the expiry is on its way to the server', () => {
    const f = site({ users: expired, status: status('ready'), applied: false });
    expect(siteFtpStatus(f)).toMatchObject({ label: 'Applying…', tone: 'busy', detail: expect.stringContaining('expired logins') });
    expect(siteFtpSettling(f)).toBe(true);
  });

  it('still shows trouble on the server', () => {
    expect(siteFtpStatus(site({ users: expired, status: status('unreachable') })).tone).toBe('bad');
  });

  it('is ready as long as one login is still live', () => {
    const f = site({ users: [expired[0]!, user({ id: 3, username: 'alpha-3' })] });
    expect(siteFtpStatus(f)).toMatchObject({ label: 'Ready', tone: 'ok' });
  });
});

describe('the everyday states', () => {
  it('applies, then is ready', () => {
    expect(siteFtpStatus(site({ applied: false, status: status('starting') })).label).toBe('Applying…');
    expect(siteFtpSettling(site({ status: status('starting') }))).toBe(true);
    expect(siteFtpStatus(site())).toMatchObject({ label: 'Ready', tone: 'ok' });
    expect(siteFtpSettling(site())).toBe(false);
  });

  it('keeps a deleted last login visible until the server has dropped it', () => {
    expect(siteFtpStatus(site({ users: [], applied: false })).label).toBe('Removing…');
    expect(siteFtpStatus(site({ users: [], applied: false, status: status('unreachable') })).detail).toMatch(
      /deleted login still works there/,
    );
    expect(siteFtpStatus(site({ users: [], applied: true, status: status('off') })).label).toBe('No logins');
  });
});

describe("the server page's line", () => {
  it('only says switched off once the server confirmed it', () => {
    expect(serverFtpSummary(server({ enabled: false, status: status('off') }))).toBe('switched off in Settings');
    expect(serverFtpSummary(server({ enabled: false, status: status('unreachable') }))).toMatch(/not confirmed/);
    expect(serverFtpSummary(server({ enabled: false, status: status('error', { message: 'boom' }) }))).toMatch(/failed: boom/);
    expect(serverFtpSummary(server({ enabled: false, status: status('ready') }))).toMatch(/taking it off…/);
  });

  it('calls a server whose logins all expired off, not starting', () => {
    const f = server({ logins: 2, activeLogins: 0, status: status('off') });
    expect(serverFtpSummary(f)).toBe('off - every login on its sites has expired');
    expect(serverFtpSummary(server({ logins: 0, activeLogins: 0, status: status('off') }))).toBe('off - none of its sites has a login');
  });

  it('counts the expired logins apart from the live ones', () => {
    expect(serverFtpSummary(server({ logins: 3, activeLogins: 2, sites: 2 }))).toBe(
      'ready · 3 logins (1 expired) on 2 sites · SFTP :2222, FTPS :21',
    );
  });
});
