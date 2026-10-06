// @docs sites/ftp-sftp
import type { FtpServerStatusDto, FtpStatusDto, SiteFtpDto } from '../../../shared/types';

/**
 * What the FTP tab and the server page say about FTP. Kept out of the components so the rules
 * can be tested without a browser (test/unit/ftpStatus.test.ts).
 *
 * The one rule underneath all of it: access is only called gone once the server has confirmed
 * it. Switching FTP off in Settings, or a login expiring, is a wish until a sync on that server
 * has taken the gateway down - and a server the panel cannot reach keeps serving meanwhile.
 */

export type FtpTone = 'ok' | 'busy' | 'bad' | 'idle';

export interface FtpStatusView {
  label: string;
  tone: FtpTone;
  detail: string | null;
}

/** A sync found nothing FTP running on the server, or took it down: not just "nobody looked". */
export const confirmedOff = (s: FtpStatusDto): boolean => s.state === 'off' && s.checkedAt !== null;

/** The site has logins, and every one of them has expired. */
export const allExpired = (f: SiteFtpDto): boolean => f.users.length > 0 && f.users.every((u) => u.expired);

export function siteFtpStatus(f: SiteFtpDto): FtpStatusView {
  const server = `"${f.serverName}"`;
  if (f.users.length === 0) {
    if (f.applied) return { label: 'No logins', tone: 'idle', detail: null };
    // The last login is deleted here but not yet on the server - where it still works.
    if (f.status.state === 'unreachable') {
      return {
        label: 'Server unreachable',
        tone: 'bad',
        detail: `The panel cannot reach ${server}: the deleted login still works there until it can.`,
      };
    }
    if (f.status.state === 'error') return { label: 'Error', tone: 'bad', detail: f.status.message };
    return { label: 'Removing…', tone: 'busy', detail: `Taking the last login off ${server}.` };
  }
  // What that means for the logins is the banner's to say (ftpOffBanner); these say why.
  if (!f.enabled) {
    if (confirmedOff(f.status)) return { label: 'Off', tone: 'idle', detail: 'Switched off in Settings.' };
    if (f.status.state === 'unreachable') {
      return { label: 'Server unreachable', tone: 'bad', detail: `The panel cannot reach ${server} to take FTP off it.` };
    }
    if (f.status.state === 'error') {
      return {
        label: 'Error',
        tone: 'bad',
        detail: `Taking FTP off ${server} failed: ${f.status.message ?? 'see the panel log'}`,
      };
    }
    return { label: 'Switching off…', tone: 'busy', detail: `Taking FTP off ${server}.` };
  }
  if (f.paused) {
    return { label: 'Paused', tone: 'busy', detail: 'A restore, move or delete of this site is running; FTP is back when it ends.' };
  }
  if (f.status.state === 'unreachable') {
    return { label: 'Server unreachable', tone: 'bad', detail: `The panel cannot reach ${server}; changes wait for it.` };
  }
  if (f.status.state === 'error') return { label: 'Error', tone: 'bad', detail: f.status.message };
  // Nothing serves this site's files then - not a setup that is taking long. The server may be
  // off altogether, when no other site there has a live login.
  if (allExpired(f)) {
    if (!f.applied) return { label: 'Applying…', tone: 'busy', detail: `Taking the expired logins off ${server}.` };
    return {
      label: 'Expired',
      tone: 'idle',
      detail: 'Every login here has expired. Edit one to give it a new expiry date.',
    };
  }
  if (!f.applied || f.status.state !== 'ready') {
    return { label: 'Applying…', tone: 'busy', detail: f.status.message ?? `Setting up on ${server}.` };
  }
  return { label: 'Ready', tone: 'ok', detail: null };
}

/** The switch in Settings is off, and whether that is true of this site's server yet. */
export function ftpOffBanner(f: SiteFtpDto): { tone: 'amber' | 'red'; text: string } | null {
  if (f.enabled) return null;
  if (f.users.length === 0 || confirmedOff(f.status)) {
    return {
      tone: 'amber',
      text: 'FTP and SFTP are switched off for every server (Settings → Sites → FTP & SFTP). The logins below are kept, and work again once it is switched back on.',
    };
  }
  return {
    tone: f.status.state === 'unreachable' || f.status.state === 'error' ? 'red' : 'amber',
    text: `FTP and SFTP are switched off in Settings, but "${f.serverName}" has not confirmed it yet: until it does, the logins below may still work there.`,
  };
}

/** Something is on its way to the server, so the tab looks again in seconds rather than half a minute. */
export function siteFtpSettling(f: SiteFtpDto): boolean {
  if (!f.applied) return true;
  if (f.users.length === 0) return false;
  const s = f.status;
  if (!f.enabled) return !confirmedOff(s) && s.state !== 'unreachable' && s.state !== 'error';
  return !allExpired(f) && s.state === 'starting';
}

/** The server page's one line about its gateway. */
export function serverFtpSummary(f: FtpServerStatusDto): string {
  const s = f.status;
  const why = s.message ?? 'see the site FTP tab';
  if (!f.enabled) {
    if (confirmedOff(s) || (f.logins === 0 && s.state === 'off')) return 'switched off in Settings';
    if (s.state === 'unreachable') return 'switched off in Settings - not confirmed: the panel cannot reach the server';
    if (s.state === 'error') return `switched off in Settings - taking it off failed: ${why}`;
    return 'switched off in Settings - taking it off…';
  }
  if (f.activeLogins === 0) {
    if (s.state === 'unreachable') return 'no active logins - not confirmed off: the panel cannot reach the server';
    if (s.state === 'error') return `error: ${why}`;
    if (s.state === 'off') return f.logins === 0 ? 'off - none of its sites has a login' : 'off - every login on its sites has expired';
    return 'no active logins - taking it off…';
  }
  const state =
    s.state === 'ready'
      ? 'ready'
      : s.state === 'error'
        ? `error: ${why}`
        : s.state === 'unreachable'
          ? 'waiting for the server'
          : 'starting';
  const expired = f.logins - f.activeLogins;
  const logins = `${f.logins} login${f.logins === 1 ? '' : 's'}${expired > 0 ? ` (${expired} expired)` : ''}`;
  const ports = [`SFTP :${f.endpoint.sftp.port}`, ...(f.endpoint.ftp.available ? [`FTPS :${f.endpoint.ftp.port}`] : [])];
  return `${state} · ${logins} on ${f.sites} site${f.sites === 1 ? '' : 's'} · ${ports.join(', ')}`;
}
