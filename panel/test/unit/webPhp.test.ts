/** What the Overview's PHP card and the mark beside a site's PHP say (web/src/lib/php.ts). */
import { describe, expect, it } from 'vitest';
import type { PhpBranchDto, PhpUpdatesDto } from '../../shared/types.js';
import { compareRelease, phpBehind, phpLines, phpWhen } from '../../web/src/lib/php.js';

const NOW = Date.parse('2026-11-19T10:00:00Z');

function branch(over: Partial<PhpBranchDto> = {}): PhpBranchDto {
  return {
    branch: '8.4',
    latest: { version: '8.4.28', date: '2026-11-19', security: true, seenAt: NOW, advisories: [] },
    next: null,
    sites: 12,
    current: 12,
    behind: [],
    behindCount: 0,
    images: [{ serverId: 1, serverName: 'fra1', release: '8.4.28' }],
    updating: false,
    doneRecently: false,
    ...over,
  };
}

const data = (branches: PhpBranchDto[], over: Partial<PhpUpdatesDto> = {}): PhpUpdatesDto => ({
  checkedAt: NOW,
  error: null,
  notice: null,
  branches,
  images: 'registry',
  updateNeeded: false,
  serverErrors: [],
  ...over,
});

const behind = { current: 5, behindCount: 7, behind: [{ slug: 'blog', title: 'Blog', release: '8.4.27' }] };

describe('the PHP card', () => {
  it('says nothing when nothing is happening', () => {
    expect(phpLines(data([branch()]), NOW)).toEqual([]);
  });

  it('shows an advance notice with its time', () => {
    const lines = phpLines(
      data([branch()], {
        notice: { id: 'n', title: 'Upcoming Critical PHP Security Release', url: 'https://www.php.net/x', publishedAt: NOW, scheduledAt: Date.parse('2026-10-21T14:00:00Z'), scheduledTime: true },
      }),
      NOW,
    );
    expect(lines).toEqual([{ kind: 'notice', text: 'PHP security release on Wed 21 Oct, 14:00 UTC', url: 'https://www.php.net/x' }]);
  });

  it('waits for the image, then counts the sites moving, then names the ones left behind', () => {
    const advisories = [
      { id: 'a', cve: null, severity: 'high', summary: '', url: '' },
      { id: 'b', cve: null, severity: 'critical', summary: '', url: '' },
    ];
    const waiting = branch({ ...behind, latest: { ...branch().latest!, advisories }, images: [{ serverId: 1, serverName: 'fra1', release: '8.4.27' }] });
    expect(phpLines(data([waiting]), NOW)).toMatchObject([
      { kind: 'release', tone: 'waiting', text: 'PHP 8.4.28 is out. Waiting for its image.', badge: 'Security · 1 critical, 1 high', update: false },
    ]);
    expect(phpLines(data([waiting], { updateNeeded: true }), NOW)).toMatchObject([{ text: 'PHP 8.4.28 is out. Update WPL7 to get it.', update: true }]);
    expect(phpLines(data([branch({ ...behind, updating: true })]), NOW)).toMatchObject([{ tone: 'updating', text: 'Updating sites to PHP 8.4.28: 5 of 12' }]);
    // One server has it, another not yet: still on its way.
    const half = branch({ ...behind, images: [{ serverId: 1, serverName: 'fra1', release: '8.4.28' }, { serverId: 2, serverName: 'nyc1', release: '8.4.27' }] });
    expect(phpLines(data([half]), NOW)).toMatchObject([{ tone: 'updating' }]);
    expect(phpLines(data([branch(behind)]), NOW)).toMatchObject([
      { tone: 'behind', text: '7 of 12 sites still on an older PHP than 8.4.28', sites: behind.behind, more: 6 },
    ]);
  });

  it('says for a day that every site made it', () => {
    expect(phpLines(data([branch({ doneRecently: true })]), NOW)).toMatchObject([{ tone: 'done', text: 'All sites run PHP 8.4.28', badge: null }]);
  });

  it('leaves out a branch no site runs', () => {
    expect(phpLines(data([branch({ ...behind, sites: 0 })]), NOW)).toEqual([]);
  });

  it('dates the next releases a week ahead, and says when one is due', () => {
    const next = (release: string, expected: string) => ({ version: `${release}RC1`, release, date: '2026-11-05', expected });
    const lines = phpLines(
      data([
        branch({ next: next('8.4.29', '2026-11-26') }),
        branch({ branch: '8.5', next: next('8.5.14', '2026-11-26') }),
        branch({ branch: '8.3', next: next('8.3.38', '2026-12-17') }),
      ]),
      NOW,
    );
    expect(lines).toEqual([{ kind: 'next', text: 'Next: PHP 8.4.29 and 8.5.14, expected Thu 26 Nov' }]);
    expect(phpLines(data([branch({ next: next('8.4.29', '2026-11-18') })]), NOW)).toEqual([{ kind: 'next', text: 'Next: PHP 8.4.29, due now' }]);
    expect(phpLines(data([branch({ next: next('8.4.29', '2026-11-01') })]), NOW)).toEqual([]);
  });
});

describe('the mark beside a PHP release', () => {
  const php = data([branch()]);
  it('marks a hosted site behind the newest release of its branch', () => {
    expect(phpBehind({ kind: 'hosted', app: 'wordpress', phpVersion: '8.4', phpRelease: '8.4.27' }, php)).toEqual({ version: '8.4.28', security: true });
    expect(phpBehind({ kind: 'hosted', app: 'wordpress', phpVersion: '8.4', phpRelease: '8.4.28' }, php)).toBeNull();
  });
  it('leaves alone a site the panel does not update, and one whose release is not known', () => {
    expect(phpBehind({ kind: 'external', phpVersion: '8.4', phpRelease: '8.4.20' }, php)).toBeNull();
    expect(phpBehind({ kind: 'hosted', app: 'container', phpVersion: '', phpRelease: null }, php)).toBeNull();
    expect(phpBehind({ kind: 'hosted', phpVersion: '8.4', phpRelease: null }, php)).toBeNull();
    expect(phpBehind({ kind: 'hosted', phpVersion: '8.4', phpRelease: '8.4.27' }, undefined)).toBeNull();
  });
  it('compares releases by their numbers', () => {
    expect(compareRelease('8.4.9', '8.4.10')).toBe(-1);
    expect(compareRelease('8.4.28', '8.4.28')).toBe(0);
    expect(phpWhen(Date.parse('2026-11-19T00:00:00Z'), false)).toBe('Thu 19 Nov');
  });
});
