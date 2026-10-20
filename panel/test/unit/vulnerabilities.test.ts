import { describe, expect, it } from 'vitest';
import { VulnerabilityFeedService, normalizeAdvisory } from '../../src/services/vulnerabilities.js';
import { SettingsService } from '../../src/services/settings.js';
import { createTestDb, makeTestConfig } from '../helpers.js';
import { seed } from '../../src/db/seed.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The real envelope shape, trimmed to what the parser reads (verified live 2026-09-20). */
function pluginBody(
  slug: string,
  opts: {
    name?: string | null;
    closed?: number | null;
    closedReason?: string | null;
    latest?: string | null;
    vulnerability?: unknown[] | null;
  } = {},
) {
  return {
    error: 0,
    message: null,
    data: {
      name: opts.name === undefined ? 'Contact Form 7' : opts.name,
      plugin: slug,
      link: `https://wordpress.org/plugins/${slug}/`,
      latest: opts.latest ?? null,
      closed: opts.closed ?? 0,
      closed_reason: opts.closedReason ?? null,
      closed_date: null,
      vulnerability: opts.vulnerability === undefined ? null : opts.vulnerability,
    },
    updated: 1789908504,
  };
}

const advisory = (over: Record<string, unknown> = {}) => ({
  uuid: 'uuid-1',
  name: 'Contact Form 7 [contact-form-7] < 5.3.2',
  description: null,
  operator: { min_version: null, min_operator: null, max_version: '5.3.2', max_operator: 'lt', unfixed: '0', closed: '0' },
  source: [
    {
      id: 'CVE-2020-35489',
      name: 'CVE-2020-35489',
      link: 'https://www.cve.org/CVERecord?id=CVE-2020-35489',
      description: '…',
      date: '2020-12-17',
    },
    {
      id: '7391118e',
      name: 'Contact Form 7 &lt; 5.3.2 - Unrestricted File Upload',
      link: 'https://wpscan.com/vulnerability/7391118e',
      description: '…',
      date: null,
    },
  ],
  impact: {
    cvss: { score: '10.0', severity: 'c' },
    cvss3: { score: '10.0', severity: 'critical' },
    cwe: [],
  },
  ...over,
});

/** An answer with a status other than 200, as wordpress.org gives for a closed plugin. */
class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/** wordpress.org's directory answers for one plugin or theme, as the tests script them. */
const wporgKey = (kind: 'plugin' | 'theme', slug: string) => `wporg/${kind}/${slug}`;
const listed = (slug: string) => ({ name: slug, slug, version: '2.6.20' });
const closedOnWporg = (reason: string) =>
  new Reply(404, { error: 'closed', closed: true, closed_date: '2021-01-30', reason, reason_text: reason });

interface Scripted {
  /** Path (or `wporg/<kind>/<slug>`) -> response body, a Reply, or an Error to throw. */
  answers: Map<string, unknown | Error>;
  /** The feed's URLs, asked in order. */
  calls: string[];
  /** wordpress.org's directory, asked in order, as `wporg/<kind>/<slug>`. */
  wporg: string[];
  /** Highest number of requests in flight at once. */
  peak: number;
}

function scriptedFetch(answers: Map<string, unknown | Error>, opts: { holdMs?: number } = {}) {
  const state: Scripted = { answers, calls: [], wporg: [], peak: 0 };
  let inFlight = 0;
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    const parsed = new URL(url);
    const key =
      parsed.hostname === 'api.wordpress.org'
        ? wporgKey(parsed.pathname.startsWith('/plugins/') ? 'plugin' : 'theme', parsed.searchParams.get('request[slug]') ?? '')
        : url.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
    (parsed.hostname === 'api.wordpress.org' ? state.wporg : state.calls).push(parsed.hostname === 'api.wordpress.org' ? key : url);
    inFlight++;
    state.peak = Math.max(state.peak, inFlight);
    try {
      if (opts.holdMs) await new Promise((r) => setTimeout(r, opts.holdMs));
      const answer = answers.get(key);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) return new Response('nope', { status: 404 });
      const reply = answer instanceof Reply ? answer : new Reply(200, answer);
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    } finally {
      inFlight--;
    }
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

async function makeFeed(
  answers: Map<string, unknown | Error>,
  opts: { now?: () => number; holdMs?: number; concurrency?: number } = {},
) {
  const db = createTestDb();
  const config = makeTestConfig();
  await seed(db, config);
  const settings = new SettingsService(db);
  const { fetchImpl, state } = scriptedFetch(answers, { holdMs: opts.holdMs });
  const warnings: string[] = [];
  const feed = new VulnerabilityFeedService(db, settings, { ...log, warn: (m: string) => void warnings.push(m) }, {
    fetchImpl,
    now: opts.now,
    concurrency: opts.concurrency,
  });
  return { db, feed, settings, state, warnings };
}

describe('VulnerabilityFeedService', () => {
  it('caches per slug, so a second fleet-wide refresh fetches nothing', async () => {
    const answers = new Map<string, unknown | Error>([
      ['/plugin/contact-form-7', pluginBody('contact-form-7', { vulnerability: [advisory()] })],
    ]);
    const { feed, state } = await makeFeed(answers);

    const first = await feed.refresh([
      { kind: 'plugin', slug: 'contact-form-7' },
      // The same slug installed on three sites is still one lookup.
      { kind: 'plugin', slug: 'contact-form-7' },
    ]);
    expect(first.fetched).toBe(1);
    expect(state.calls).toHaveLength(1);

    const second = await feed.refresh([{ kind: 'plugin', slug: 'contact-form-7' }]);
    expect(second.fetched).toBe(0);
    expect(second.skipped).toBe(1);
    expect(state.calls).toHaveLength(1);
  });

  it('re-fetches after the 24h TTL, and on demand with force', async () => {
    const answers = new Map<string, unknown | Error>([['/plugin/akismet', pluginBody('akismet')]]);
    let now = 1_000_000;
    const { feed, state } = await makeFeed(answers, { now: () => now });

    await feed.refresh([{ kind: 'plugin', slug: 'akismet' }]);
    expect(state.calls).toHaveLength(1);

    now += 23 * 3600_000;
    await feed.refresh([{ kind: 'plugin', slug: 'akismet' }]);
    expect(state.calls).toHaveLength(1);

    now += 2 * 3600_000; // past 24h
    await feed.refresh([{ kind: 'plugin', slug: 'akismet' }]);
    expect(state.calls).toHaveLength(2);

    await feed.refresh([{ kind: 'plugin', slug: 'akismet' }], { force: true });
    expect(state.calls).toHaveLength(3);
  });

  it('matches an "affected below X" advisory against the installed version', async () => {
    const answers = new Map<string, unknown | Error>([
      ['/plugin/contact-form-7', pluginBody('contact-form-7', { vulnerability: [advisory()] })],
    ]);
    const { feed } = await makeFeed(answers);
    await feed.refresh([{ kind: 'plugin', slug: 'contact-form-7' }]);

    const vulnerable = feed.verdictFor('plugin', 'contact-form-7', '5.3.1');
    expect(vulnerable.vulnerabilities).toHaveLength(1);
    expect(vulnerable.worstSeverity).toBe('critical');
    expect(vulnerable.vulnerabilities[0]!.cvss).toBe(10);
    expect(vulnerable.vulnerabilities[0]!.fixedIn).toBe('5.3.2');
    expect(vulnerable.vulnerabilities[0]!.cves).toEqual(['CVE-2020-35489']);
    // Entities are decoded and the CVE id is not used as the headline.
    expect(vulnerable.vulnerabilities[0]!.title).toBe('Contact Form 7 < 5.3.2 - Unrestricted File Upload');

    const patched = feed.verdictFor('plugin', 'contact-form-7', '5.3.2');
    expect(patched.vulnerabilities).toHaveLength(0);
    expect(patched.worstSeverity).toBeNull();
    expect(patched.coverage).toBe('known');
  });

  it('tells "not in their database" apart from "nothing known against it"', async () => {
    const answers = new Map<string, unknown | Error>([
      // name: null is how the feed says "no such slug".
      ['/plugin/acme-premium', pluginBody('acme-premium', { name: null, closed: null })],
      ['/plugin/akismet', pluginBody('akismet', { name: 'Akismet' })],
    ]);
    const { feed } = await makeFeed(answers);
    await feed.refresh([
      { kind: 'plugin', slug: 'acme-premium' },
      { kind: 'plugin', slug: 'akismet' },
    ]);

    expect(feed.verdictFor('plugin', 'acme-premium', '1.0').coverage).toBe('unknown');
    expect(feed.verdictFor('plugin', 'akismet', '5.0').coverage).toBe('known');
  });

  it("surfaces a plugin closed on wordpress.org, with the directory's reason", async () => {
    const answers = new Map<string, unknown | Error>([
      ['/plugin/total-donations', pluginBody('total-donations', { name: 'Total Donations', closed: 1, closedReason: 'unknown' })],
      [wporgKey('plugin', 'total-donations'), closedOnWporg('security-issue')],
    ]);
    const { feed } = await makeFeed(answers);
    await feed.refresh([{ kind: 'plugin', slug: 'total-donations' }]);

    const verdict = feed.verdictFor('plugin', 'total-donations', '2.0');
    expect(verdict.closedOnWporg).toBe(true);
    expect(verdict.closedReason).toBe('security-issue');
  });

  it('does not call a plugin closed while wordpress.org lists it', async () => {
    const answers = new Map<string, unknown | Error>([
      // The feed's answer for a plugin the directory had open and up to date.
      ['/plugin/bbpress', pluginBody('bbpress', { name: 'bbPress', closed: 1, closedReason: 'unknown' })],
      [wporgKey('plugin', 'bbpress'), listed('bbpress')],
      ['/plugin/akismet', pluginBody('akismet', { name: 'Akismet' })],
    ]);
    const { feed, state } = await makeFeed(answers);
    await feed.refresh([
      { kind: 'plugin', slug: 'bbpress' },
      { kind: 'plugin', slug: 'akismet' },
    ]);

    const verdict = feed.verdictFor('plugin', 'bbpress', '2.6.20');
    expect(verdict.closedOnWporg).toBe(false);
    expect(verdict.closedReason).toBeNull();
    expect(verdict.coverage).toBe('known');
    expect(state.wporg.sort()).toEqual([wporgKey('plugin', 'akismet'), wporgKey('plugin', 'bbpress')]);
  });

  it('shows a plugin wordpress.org closed that the feed does not flag', async () => {
    const answers = new Map<string, unknown | Error>([
      ['/plugin/captcha', pluginBody('captcha', { name: 'Captcha', closed: null })],
      [wporgKey('plugin', 'captcha'), closedOnWporg('security-issue')],
    ]);
    const { feed } = await makeFeed(answers);
    await feed.refresh([{ kind: 'plugin', slug: 'captcha' }]);

    expect(feed.verdictFor('plugin', 'captcha', '4.4.5')).toMatchObject({ closedOnWporg: true, closedReason: 'security-issue' });
  });

  it('asks about a theme only when the feed calls it closed', async () => {
    const answers = new Map<string, unknown | Error>([
      ['/theme/open-theme', pluginBody('open-theme', { name: 'Open Theme' })],
      ['/theme/flagged-theme', pluginBody('flagged-theme', { name: 'Flagged Theme', closed: 1 })],
      [wporgKey('theme', 'flagged-theme'), listed('flagged-theme')],
    ]);
    const { feed, state } = await makeFeed(answers);
    await feed.refresh([
      { kind: 'theme', slug: 'open-theme' },
      { kind: 'theme', slug: 'flagged-theme' },
    ]);

    // The themes directory never says closed, so asking about an open theme could change nothing.
    expect(state.wporg).toEqual([wporgKey('theme', 'flagged-theme')]);
    expect(feed.verdictFor('theme', 'flagged-theme', '1.0').closedOnWporg).toBe(false);
  });

  it('says once, not once per plugin, that wordpress.org did not answer', async () => {
    const answers = new Map<string, unknown | Error>();
    const refs = Array.from({ length: 5 }, (_, i) => {
      answers.set(`/plugin/p${i}`, pluginBody(`p${i}`, { name: `P${i}` }));
      answers.set(wporgKey('plugin', `p${i}`), new Error('getaddrinfo ENOTFOUND api.wordpress.org'));
      return { kind: 'plugin' as const, slug: `p${i}` };
    });
    const { feed, warnings } = await makeFeed(answers);
    const res = await feed.refresh(refs);

    expect(res).toMatchObject({ fetched: 5, failed: 0 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/wordpress\.org did not say whether plugin "p\d", plugin "p\d", plugin "p\d" and 2 more are closed/);
    expect(warnings[0]).toContain('ENOTFOUND');
  });

  it('keeps a theme the directory does not have as closed, and clears one it lists', async () => {
    const answers = new Map<string, unknown | Error>([
      ['/theme/gone', pluginBody('gone', { name: 'Gone', closed: 1, closedReason: 'guideline-violation' })],
      [wporgKey('theme', 'gone'), new Reply(404, { error: 'Theme not found' })],
      ['/theme/back', pluginBody('back', { name: 'Back', closed: 1 })],
      [wporgKey('theme', 'back'), listed('back')],
    ]);
    const { feed } = await makeFeed(answers);
    await feed.refresh([
      { kind: 'theme', slug: 'gone' },
      { kind: 'theme', slug: 'back' },
    ]);

    expect(feed.verdictFor('theme', 'gone', '1.0')).toMatchObject({ closedOnWporg: true, closedReason: 'guideline-violation' });
    expect(feed.verdictFor('theme', 'back', '1.0').closedOnWporg).toBe(false);
  });

  it('keeps what it said before while wordpress.org does not answer', async () => {
    const answers = new Map<string, unknown | Error>([
      ['/plugin/reopened', pluginBody('reopened', { name: 'Reopened', closed: 1 })],
      [wporgKey('plugin', 'reopened'), listed('reopened')],
      ['/plugin/fresh', pluginBody('fresh', { name: 'Fresh', closed: 1, closedReason: 'author-request' })],
      [wporgKey('plugin', 'fresh'), new Error('network down')],
    ]);
    let now = 1_000_000;
    const { feed } = await makeFeed(answers, { now: () => now });
    await feed.refresh([
      { kind: 'plugin', slug: 'reopened' },
      { kind: 'plugin', slug: 'fresh' },
    ]);
    // Nothing said before: the feed's word stands.
    expect(feed.verdictFor('plugin', 'fresh', '1.0')).toMatchObject({ closedOnWporg: true, closedReason: 'author-request' });
    expect(feed.verdictFor('plugin', 'reopened', '1.0').closedOnWporg).toBe(false);

    // A day on, the directory is out of reach: the open verdict stays, so no new alert goes out.
    answers.set(wporgKey('plugin', 'reopened'), new Reply(503, null));
    now += 25 * 3600_000;
    const res = await feed.refresh([{ kind: 'plugin', slug: 'reopened' }]);
    expect(res.failed).toBe(0);
    expect(feed.verdictFor('plugin', 'reopened', '1.0')).toMatchObject({ closedOnWporg: false, coverage: 'known' });
  });

  it('asks about a closed plugin again after an hour, an open one after a day', async () => {
    const answers = new Map<string, unknown | Error>([
      ['/plugin/closed-one', pluginBody('closed-one', { name: 'Closed', closed: 1 })],
      [wporgKey('plugin', 'closed-one'), closedOnWporg('security-issue')],
      ['/plugin/open-one', pluginBody('open-one', { name: 'Open' })],
    ]);
    let now = 1_000_000;
    const { feed, state } = await makeFeed(answers, { now: () => now });
    const refs = [
      { kind: 'plugin' as const, slug: 'closed-one' },
      { kind: 'plugin' as const, slug: 'open-one' },
    ];
    await feed.refresh(refs);

    now += 2 * 3600_000;
    const second = await feed.refresh(refs);
    expect(second.refreshed).toEqual([{ kind: 'plugin', slug: 'closed-one' }]);
    // The feed and the directory, twice each for the closed one and once for the open one.
    expect(state.calls.filter((c) => c.includes('closed-one'))).toHaveLength(2);
    expect(state.wporg.filter((c) => c.endsWith('/closed-one'))).toHaveLength(2);
    expect(state.wporg.filter((c) => c.endsWith('/open-one'))).toHaveLength(1);

    // Reopened since: the next pass clears it.
    answers.set(wporgKey('plugin', 'closed-one'), listed('closed-one'));
    now += 2 * 3600_000;
    await feed.refresh(refs);
    expect(feed.verdictFor('plugin', 'closed-one', '1.0').closedOnWporg).toBe(false);
  });

  it('keeps the previous answer when a lookup fails, and isolates the failure', async () => {
    const answers = new Map<string, unknown | Error>([
      ['/plugin/good', pluginBody('good', { name: 'Good' })],
      ['/plugin/bad', new Error('network down')],
    ]);
    let now = 1_000_000;
    const { feed, state } = await makeFeed(answers, { now: () => now });

    const first = await feed.refresh([
      { kind: 'plugin', slug: 'good' },
      { kind: 'plugin', slug: 'bad' },
    ]);
    expect(first.fetched).toBe(1);
    expect(first.failed).toBe(1);
    // The good slug landed despite the bad one.
    expect(feed.verdictFor('plugin', 'good', '1.0').coverage).toBe('known');
    expect(feed.verdictFor('plugin', 'bad', '1.0').coverage).toBe('error');

    // A failed slug is not retried on every scan - it backs off for an hour.
    await feed.refresh([{ kind: 'plugin', slug: 'bad' }]);
    expect(state.calls.filter((c) => c.includes('/bad/'))).toHaveLength(1);
    now += 2 * 3600_000;
    await feed.refresh([{ kind: 'plugin', slug: 'bad' }]);
    expect(state.calls.filter((c) => c.includes('/bad/'))).toHaveLength(2);

    // And when it finally answers, the row becomes a normal cached answer.
    answers.set('/plugin/bad', pluginBody('bad', { name: 'Bad' }));
    now += 2 * 3600_000;
    await feed.refresh([{ kind: 'plugin', slug: 'bad' }]);
    expect(feed.verdictFor('plugin', 'bad', '1.0').coverage).toBe('known');
  });

  it('keeps a previously cached answer visible while a later lookup is failing', async () => {
    const answers = new Map<string, unknown | Error>([
      ['/plugin/cf7', pluginBody('cf7', { name: 'CF7', vulnerability: [advisory()] })],
    ]);
    let now = 1_000_000;
    const { feed } = await makeFeed(answers, { now: () => now });
    await feed.refresh([{ kind: 'plugin', slug: 'cf7' }]);

    answers.set('/plugin/cf7', new Error('feed unreachable'));
    now += 25 * 3600_000;
    await feed.refresh([{ kind: 'plugin', slug: 'cf7' }]);

    // Stale-if-error: the advisory is still reported, flagged as a failed check.
    const verdict = feed.verdictFor('plugin', 'cf7', '5.3.1');
    expect(verdict.vulnerabilities).toHaveLength(1);
    expect(verdict.coverage).toBe('error');
  });

  it('marks a cached answer stale once it is past its TTL', async () => {
    const answers = new Map<string, unknown | Error>([['/plugin/akismet', pluginBody('akismet', { name: 'Akismet' })]]);
    let now = 1_000_000;
    const { feed } = await makeFeed(answers, { now: () => now });
    await feed.refresh([{ kind: 'plugin', slug: 'akismet' }]);
    expect(feed.verdictFor('plugin', 'akismet', '5.0').coverage).toBe('known');
    now += 25 * 3600_000;
    expect(feed.verdictFor('plugin', 'akismet', '5.0').coverage).toBe('stale');
  });

  it('treats core advisories as applying to the version that was queried', async () => {
    const answers = new Map<string, unknown | Error>([
      [
        '/core/6.8.2',
        {
          error: 0,
          message: null,
          data: {
            core: '6.8.2',
            link: null,
            vulnerability: [
              {
                uuid: 'core-1',
                name: '6.8.2',
                description: null,
                // Core entries carry NO operator at all - the endpoint is version-scoped.
                source: [{ id: 'x', name: 'WordPress <= 6.9.1 - XXE via getID3', link: 'https://example.test', date: '2026-01-02' }],
                impact: { cvss: { score: '5.9', severity: 'm' }, cvss3: { score: '5.9', severity: 'medium' } },
              },
              // An entry with no scoring at all: `impact` comes back as an empty ARRAY.
              { uuid: 'core-2', name: '6.8.2', description: null, source: [], impact: [] },
            ],
          },
          updated: 1789908504,
        },
      ],
    ]);
    const { feed } = await makeFeed(answers);
    await feed.refresh([{ kind: 'core', slug: '6.8.2' }]);

    const verdict = feed.verdictFor('core', '6.8.2', '6.8.2');
    expect(verdict.vulnerabilities).toHaveLength(2);
    expect(verdict.worstSeverity).toBe('medium');
    expect(verdict.vulnerabilities[0]!.severity).toBe('medium');
    expect(verdict.vulnerabilities[1]!.severity).toBe('unknown');
    expect(verdict.vulnerabilities[1]!.cvss).toBeNull();
  });

  it('never runs more than four lookups at once', async () => {
    const answers = new Map<string, unknown | Error>();
    const refs = Array.from({ length: 20 }, (_, i) => {
      answers.set(`/plugin/p${i}`, pluginBody(`p${i}`, { name: `P${i}` }));
      return { kind: 'plugin' as const, slug: `p${i}` };
    });
    const { feed, state } = await makeFeed(answers, { holdMs: 5 });
    await feed.refresh(refs);
    expect(state.calls).toHaveLength(20);
    expect(state.peak).toBeLessThanOrEqual(4);
  });

  it('does nothing at all while the feed is switched off', async () => {
    const answers = new Map<string, unknown | Error>([['/plugin/akismet', pluginBody('akismet')]]);
    const { feed, settings } = await makeFeed(answers);
    await feed.refresh([{ kind: 'plugin', slug: 'akismet' }]);

    settings.set('vulnerabilityFeed', false);
    expect(feed.enabled).toBe(false);
    const res = await feed.refresh([{ kind: 'plugin', slug: 'akismet' }], { force: true });
    expect(res.fetched).toBe(0);
    // The rows stay, but nothing is rated while it is off.
    const verdict = feed.verdictFor('plugin', 'akismet', '1.0');
    expect(verdict.coverage).toBe('off');
    expect(verdict.vulnerabilities).toHaveLength(0);
  });

  it('reads an unfixed advisory as having no fixed release', () => {
    const unfixed = normalizeAdvisory(
      advisory({
        operator: { min_version: '1.0', min_operator: 'ge', max_version: '2.0', max_operator: 'le', unfixed: '1', closed: '0' },
      }) as unknown as Record<string, unknown>,
      0,
    );
    expect(unfixed.unfixed).toBe(true);
    expect(unfixed.fixedIn).toBeNull();

    // `le` names a version that is still affected, so it is not a fix either.
    const le = normalizeAdvisory(
      advisory({
        operator: { min_version: null, min_operator: null, max_version: '2.0', max_operator: 'le', unfixed: '0', closed: '0' },
      }) as unknown as Record<string, unknown>,
      0,
    );
    expect(le.fixedIn).toBeNull();
  });

  it('derives a severity word from a bare score when the feed gives no verdict', () => {
    const scored = normalizeAdvisory(
      advisory({ impact: { cvss: { score: '9.8' }, cvss3: { score: '9.8' } } }) as unknown as Record<string, unknown>,
      0,
    );
    expect(scored.severity).toBe('critical');
    expect(scored.cvss).toBe(9.8);
  });
});
