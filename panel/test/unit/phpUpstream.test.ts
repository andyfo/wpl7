/**
 * What php.net says about PHP's releases (services/phpUpstream.ts): its release list, its release
 * candidates, the advance notice in its news feed and GitHub's advisories, read as they are
 * published, and kept when a read fails.
 */
import { describe, expect, it } from 'vitest';
import {
  PHP_ACTIVE_URL,
  PHP_ADVISORIES_URL,
  PHP_CANDIDATES_URL,
  PHP_NEWS_URL,
  PhpUpstream,
  noticeSchedule,
  parseActive,
  parseAdvisories,
  parseCandidates,
  parseNotices,
  phpNetDate,
} from '../../src/services/phpUpstream.js';
import { makeWorld } from '../helpers.js';
import { ACTIVE, ADVISORIES, ADVISORY, CANDIDATES, NOTICE, RC, feed, phpNet, release, type Answer } from '../phpFixtures.js';

describe("php.net's answers, read", () => {
  it('reads its dates, and nothing that is not one', () => {
    expect(phpNetDate('21 Oct 2026')).toBe('2026-10-21');
    expect(phpNetDate('05 November 2026')).toBe('2026-11-05');
    expect(phpNetDate('31 Feb 2026')).toBeNull();
    expect(phpNetDate('2026-10-21')).toBeNull();
  });

  it("takes each branch's newest release, and whether it fixed a security issue", () => {
    const active = parseActive({ '8': { ...ACTIVE['8'], '8.2': release('8.3.1', '21 Oct 2026'), '8.1': release('8.1.34', '18 Dec 2025', false) } });
    expect(active['8.4']).toEqual({ version: '8.4.27', date: '2026-10-21', security: true });
    expect(active['8.1']).toEqual({ version: '8.1.34', date: '2025-12-18', security: false });
    // A release filed under another branch says nothing about either.
    expect(active['8.2']).toBeUndefined();
    expect(() => parseActive({ '8': {} })).toThrow(/no releases/);
  });

  it('dates the next release two weeks after a first candidate, and a week after a later one', () => {
    const candidates = parseCandidates(CANDIDATES, parseActive(ACTIVE));
    expect(candidates).toEqual({
      '8.4': { version: '8.4.28RC1', release: '8.4.28', date: '2026-11-05', expected: '2026-11-19' },
      '8.5': { version: '8.5.13RC2', release: '8.5.13', date: '2026-11-12', expected: '2026-11-19' },
    });
    // 8.2.27's entry has no candidate in it, and 8.3.36 is out already.
  });

  it('takes a notice that links to php.net only', () => {
    const elsewhere = NOTICE.replace('href="https://www.php.net/index.php#2026-10-20-1" rel="alternate"', 'href="https://example.com/x" rel="alternate"');
    expect(parseNotices(feed(elsewhere))).toEqual([]);
  });

  it("finds the advance notice of a security release in php.net's news, with its time", () => {
    const notices = parseNotices(feed(RC, ADVISORY, NOTICE));
    expect(notices).toEqual([
      {
        id: 'https://www.php.net/archive/2026.php#2026-10-20-1',
        title: 'Upcoming Critical PHP Security Release',
        url: 'https://www.php.net/index.php#2026-10-20-1',
        publishedAt: Date.parse('2026-10-20T20:32:00Z'),
        scheduledAt: Date.parse('2026-10-21T14:00:00Z'),
        scheduledTime: true,
      },
    ]);
  });

  it('reads the day a notice names, or says it cannot', () => {
    expect(noticeSchedule('It is scheduled for Thursday, November 19, 2026 at 9:00 UTC.')).toEqual({ at: Date.parse('2026-11-19T09:00:00Z'), time: true });
    expect(noticeSchedule('The release is scheduled for 3 December 2026.')).toEqual({ at: Date.parse('2026-12-03T00:00:00Z'), time: false });
    expect(noticeSchedule('It will be released on Tuesday, 1 December 2026 at 13:30 UTC')).toEqual({ at: Date.parse('2026-12-01T13:30:00Z'), time: true });
    expect(noticeSchedule('It is coming soon.')).toBeNull();
    expect(noticeSchedule('scheduled for 30 February 2026')).toBeNull();
  });

  it('takes the advisories that name a release among their patched versions', () => {
    expect(parseAdvisories(ADVISORIES, '8.4.27').map((a) => [a.id, a.severity])).toEqual([
      ['GHSA-w8hw-w9fx-j79w', 'critical'],
      ['GHSA-6wmf-4rv5-p3rp', 'critical'],
    ]);
    expect(parseAdvisories(ADVISORIES, '8.4.26').map((a) => a.id)).toEqual(['GHSA-7875-c8px-7q5f']);
    expect(parseAdvisories(ADVISORIES, '8.4.20')).toEqual([]);
  });
});

describe('reading php.net', () => {
  const answers = () => ({
    [PHP_ACTIVE_URL]: { status: 200, body: ACTIVE },
    [PHP_CANDIDATES_URL]: { status: 200, body: CANDIDATES },
    [PHP_NEWS_URL]: { status: 200, body: feed(NOTICE), headers: { etag: 'W/"1"', 'last-modified': 'Tue, 20 Oct 2026 20:40:00 GMT' } },
    [PHP_ADVISORIES_URL]: { status: 200, body: ADVISORIES },
  });

  it('keeps what it read, and when it first saw each release', async () => {
    const w = await makeWorld();
    const net = phpNet(answers());
    const upstream = new PhpUpstream(w.core.settings, w.core.log, net.fetch);
    await upstream.refresh();
    const first = upstream.facts();
    expect(first.error).toBeNull();
    expect(first.releases['8.4']).toMatchObject({ version: '8.4.27', date: '2026-10-21', security: true });
    expect(first.candidates['8.4']?.release).toBe('8.4.28');
    expect(first.notice?.scheduledAt).toBe(Date.parse('2026-10-21T14:00:00Z'));
    expect(first.advisories['8.4.27']?.items).toHaveLength(2);

    await upstream.refresh();
    expect(upstream.facts().releases['8.4']!.seenAt).toBe(first.releases['8.4']!.seenAt);
  });

  it('asks for the news feed only if it changed, and keeps the notice when it has not', async () => {
    const w = await makeWorld();
    const script = answers();
    const net = phpNet(script);
    const upstream = new PhpUpstream(w.core.settings, w.core.log, net.fetch);
    await upstream.refresh();
    script[PHP_NEWS_URL] = { status: 304 };
    await upstream.refresh();
    const asked = net.calls.filter((c) => c.url === PHP_NEWS_URL);
    expect(asked[1]!.headers['if-none-match']).toBe('W/"1"');
    expect(asked[1]!.headers['if-modified-since']).toBe('Tue, 20 Oct 2026 20:40:00 GMT');
    expect(upstream.facts().notice?.title).toBe('Upcoming Critical PHP Security Release');
  });

  it('asks GitHub once per security release, and again an hour after a failure', async () => {
    const w = await makeWorld();
    const script: Record<string, Answer> = { ...answers(), [PHP_ADVISORIES_URL]: { status: 403, body: { message: 'rate limited' } } };
    const net = phpNet(script);
    const upstream = new PhpUpstream(w.core.settings, w.core.log, net.fetch, 'ghp_token');
    await upstream.refresh();
    expect(upstream.facts().advisories['8.4.27']?.error).toMatch(/403/);
    script[PHP_ADVISORIES_URL] = { status: 200, body: ADVISORIES };
    await upstream.refresh();
    // Not again within the hour.
    expect(net.calls.filter((c) => c.url === PHP_ADVISORIES_URL)).toHaveLength(1);
    expect(net.calls.find((c) => c.url === PHP_ADVISORIES_URL)!.headers.authorization).toBe('Bearer ghp_token');
  });

  it('keeps what it had when php.net cannot be read, and says why', async () => {
    const w = await makeWorld();
    const script: Record<string, Answer> = answers();
    const upstream = new PhpUpstream(w.core.settings, w.core.log, phpNet(script).fetch);
    await upstream.refresh();
    script[PHP_ACTIVE_URL] = { status: 502 };
    await upstream.refresh();
    const facts = upstream.facts();
    expect(facts.error).toMatch(/php\.net could not be read: www\.php\.net answered 502/);
    expect(facts.releases['8.4']?.version).toBe('8.4.27');
  });

  it('drops a candidate whose release came out while the candidates could not be read', async () => {
    const w = await makeWorld();
    const script: Record<string, Answer> = answers();
    const upstream = new PhpUpstream(w.core.settings, w.core.log, phpNet(script).fetch);
    await upstream.refresh();
    script[PHP_ACTIVE_URL] = { status: 200, body: { '8': { ...ACTIVE['8'], '8.4': release('8.4.28', '19 Nov 2026') } } };
    script[PHP_CANDIDATES_URL] = { status: 500 };
    await upstream.refresh();
    expect(upstream.facts().candidates['8.4']).toBeUndefined();
    expect(upstream.facts().candidates['8.5']?.release).toBe('8.5.13');
  });
});
