/** What the Overview's PHP card and the mark beside a site's PHP say (web/src/lib/php.ts). */
import { describe, expect, it } from 'vitest';
import type { PhpBranchDto, PhpUpdatesDto } from '../../shared/types.js';
import { compareRelease, phpBehind, phpImageState, phpLines, phpSiteState, phpSummary, phpWhen } from '../../web/src/lib/php.js';

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
    images: [image('fra1', '8.4.28')],
    updating: false,
    doneRecently: false,
    ...over,
  };
}

/** A server's image of the branch, with the job refreshing it. */
function image(serverName: string, release: string | null, refresh: PhpBranchDto['images'][number]['refresh'] = null, serverId = serverName === 'fra1' ? 1 : 2) {
  return { serverId, serverName, release, refresh };
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

const behind = { current: 5, behindCount: 7, behind: [{ slug: 'blog', title: 'Blog', release: '8.4.27', serverId: 1, move: null }] };

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
    const waiting = branch({ ...behind, latest: { ...branch().latest!, advisories }, images: [image('fra1', '8.4.27')] });
    expect(phpLines(data([waiting]), NOW)).toMatchObject([
      { kind: 'release', tone: 'waiting', text: 'PHP 8.4.28 is out. Waiting for its image.', badge: 'Security · 1 critical, 1 high', update: false },
    ]);
    expect(phpLines(data([waiting], { updateNeeded: true }), NOW)).toMatchObject([{ text: 'PHP 8.4.28 is out. Update WPL7 to get it.', update: true }]);
    expect(phpLines(data([branch({ ...behind, updating: true })]), NOW)).toMatchObject([{ tone: 'updating', text: 'Updating sites to PHP 8.4.28: 5 of 12' }]);
    // One server has it, another not, and nothing is moving: the sites behind are named.
    const half = branch({ ...behind, images: [image('fra1', '8.4.28'), image('nyc1', '8.4.27')] });
    expect(phpLines(data([half]), NOW)).toMatchObject([{ tone: 'behind', sites: behind.behind }]);
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

describe('the details of a PHP branch', () => {
  const job = (status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled') => ({ id: 7, status, error: null });

  it("says where each server's image stands", () => {
    const state = (img: ReturnType<typeof image>, over: Partial<PhpUpdatesDto> = {}) => phpImageState(img, '8.4.28', data([], over)).text;
    expect(state(image('fra1', '8.4.28', job('succeeded')))).toBe('Has 8.4.28');
    expect(state(image('fra1', '8.4.27', job('running')), { images: 'build' })).toBe('Building the new image');
    expect(state(image('fra1', '8.4.27', job('queued')))).toBe('Pulling the new image');
    expect(state(image('fra1', '8.4.27', job('failed')))).toBe('Could not get the new image. It tries again within the hour.');
    expect(state(image('fra1', '8.4.27'), { images: 'build' })).toBe("Waiting for Docker's image");
    expect(state(image('fra1', '8.4.27'))).toBe('Waiting for the published image');
    expect(state(image('fra1', '8.4.27'), { updateNeeded: true })).toBe('Needs a WPL7 update');
  });

  it('says where each site still behind stands, and offers to try a failed move again', () => {
    const b = branch({ ...behind, images: [image('fra1', '8.4.28'), image('nyc1', '8.4.27')] });
    const site = (serverId: number, move: ReturnType<typeof job> | null) => phpSiteState({ ...behind.behind[0]!, serverId, move }, b);
    expect(site(1, job('running'))).toEqual({ tone: 'updating', text: 'Moving now', retry: false });
    expect(site(1, job('failed'))).toEqual({ tone: 'behind', text: 'Its move failed', retry: true });
    expect(site(1, job('canceled'))).toEqual({ tone: 'behind', text: 'Its move was stopped', retry: true });
    expect(site(1, null)).toEqual({ tone: 'waiting', text: 'Moves at the next hourly check', retry: false });
    expect(site(2, job('failed'))).toEqual({ tone: 'waiting', text: "Waits for its server's image", retry: false });
  });

  it('says what is happening and what comes next', () => {
    const waiting = branch({ ...behind, images: [image('fra1', '8.4.27')] });
    expect(phpSummary(waiting, data([], { images: 'build' })).text).toBe(
      "Waiting for Docker's WordPress image with PHP 8.4.28, usually a few hours after the release. Each server then builds its own image, and the sites move onto it.",
    );
    expect(phpSummary(waiting, data([], { updateNeeded: true }))).toEqual({
      text: "This install's WPL7 release gets no new site images. A WPL7 update brings PHP 8.4.28.",
      update: true,
    });
    expect(phpSummary(branch({ ...behind, images: [image('fra1', '8.4.27', { id: 7, status: 'running', error: null })] }), data([], { images: 'build' })).text).toBe(
      'Building the site image with PHP 8.4.28. Then the sites move onto it.',
    );
    expect(phpSummary(branch({ ...behind, updating: true }), data([])).text).toBe('Moving the sites onto PHP 8.4.28: 5 of 12 done. Each one restarts for a second or two.');
    expect(phpSummary(branch(behind), data([])).text).toBe('7 of 12 sites still on an older PHP than 8.4.28.');
    expect(phpSummary(branch(), data([])).text).toBe('All 12 sites run PHP 8.4.28.');
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
