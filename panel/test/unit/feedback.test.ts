import { describe, expect, it } from 'vitest';
import type { ServerSystemInfoDto, SystemVersionDto } from '../../shared/types.js';
import { environmentBlock, feedbackText, feedbackUrl, type FeedbackDraft } from '../../web/src/lib/feedback.js';

const REPO = 'https://github.com/andyfo/wpl7';

const VERSION: SystemVersionDto = {
  version: '0.2.0',
  gitSha: 'abc1234def5678',
  channel: 'stable',
  source: 'image',
  latest: null,
  updateAvailable: false,
  checkedAt: null,
  error: null,
  nextCheckAt: null,
};

const HOST: ServerSystemInfoDto = {
  serverId: 1,
  reachable: true,
  error: null,
  os: 'Ubuntu 24.04.1 LTS',
  kernel: '6.8.0-45-generic',
  arch: 'x86_64',
  hostname: 'web-01',
  cpuModel: 'Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz',
  cpus: 4,
  memTotalBytes: 8_322_543_616,
  uptimeSeconds: 1_923_847,
  dockerVersion: 'Docker version 27.3.1, build ce12230',
  readAt: 1_700_000_000_000,
};

const draft = (over: Partial<Omit<FeedbackDraft, 'kind'>> & { kind?: 'bug' | 'feature' } = {}) => ({
  kind: 'bug',
  summary: 'Creating a site fails',
  details: 'It stops at the plugin step.',
  environment: '',
  versionLine: '0.2.0 (stable)',
  ...over,
});

describe('feedbackUrl', () => {
  it('fills the bug form by field id, and its version field too', () => {
    const url = new URL(feedbackUrl(REPO, draft()));
    expect(url.pathname).toBe('/andyfo/wpl7/issues/new');
    expect(url.searchParams.get('template')).toBe('bug.yml');
    expect(url.searchParams.get('title')).toBe('Creating a site fails');
    expect(url.searchParams.get('what')).toBe('It stops at the plugin step.');
    expect(url.searchParams.get('version')).toBe('0.2.0 (stable)');
  });

  it('uses the feature form and its own first field for a change request', () => {
    const url = new URL(feedbackUrl(REPO, draft({ kind: 'feature' })));
    expect(url.searchParams.get('template')).toBe('feature.yml');
    expect(url.searchParams.get('problem')).toBe('It stops at the plugin step.');
    // The feature form has no version field, so prefilling one would be a phantom parameter.
    expect(url.searchParams.get('version')).toBeNull();
  });

  it('appends the environment block to what was typed', () => {
    const url = new URL(feedbackUrl(REPO, draft({ environment: '```\nWPL7 0.2.0\n```' })));
    expect(url.searchParams.get('what')).toBe('It stops at the plugin step.\n\n```\nWPL7 0.2.0\n```');
  });

  it('does not double the slash when the repository URL carries one', () => {
    expect(new URL(feedbackUrl(`${REPO}/`, draft())).pathname).toBe('/andyfo/wpl7/issues/new');
  });

  /**
   * GitHub answers an over-long URL with 414 rather than opening the form, and a long
   * paragraph of non-ASCII triples once encoded - so the cut has to be decided on the
   * encoded length, not on what was typed.
   */
  it('shortens a very long report until the link fits, and says that it did', () => {
    const url = feedbackUrl(REPO, draft({ details: 'ě'.repeat(20_000) }));
    expect(url.length).toBeLessThanOrEqual(6000);
    const what = new URL(url).searchParams.get('what')!;
    expect(what).toContain('cut short to fit in a link');
    expect(what.length).toBeLessThan(20_000);
  });

  it('keeps the whole report in the text a sender can paste instead', () => {
    const long = 'ě'.repeat(20_000);
    expect(feedbackText(draft({ details: long }))).toContain(long);
  });
});

describe('environmentBlock', () => {
  it('names the build and the machine, and nothing that identifies anybody', () => {
    const block = environmentBlock(VERSION, HOST, 'v22.11.0');
    expect(block).toContain('WPL7 0.2.0 (stable channel, released image)');
    expect(block).toContain('commit abc1234');
    expect(block).toContain('Ubuntu 24.04.1 LTS');
    expect(block).toContain('6.8.0-45-generic x86_64');
    expect(block).toContain('Node v22.11.0');
    // The panel knows all of these and none of them helps read a bug report.
    expect(block).not.toContain('web-01');
    expect(block).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('leaves the commit out of a build that has none, rather than printing "unknown"', () => {
    const block = environmentBlock({ ...VERSION, gitSha: 'unknown' }, HOST, 'v22.11.0');
    expect(block).not.toContain('commit');
  });

  it('says so when the machine could not be asked', () => {
    expect(environmentBlock(VERSION, null, 'v22.11.0')).toContain('machine unknown');
  });

  it('describes a checkout build as one', () => {
    expect(environmentBlock({ ...VERSION, source: 'build' }, HOST, 'v22.11.0')).toContain('built from a checkout');
  });
});
