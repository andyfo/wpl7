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

interface Scripted {
  /** slug -> response body, or an Error to throw. */
  answers: Map<string, unknown | Error>;
  calls: string[];
  /** Highest number of requests in flight at once. */
  peak: number;
}

function scriptedFetch(answers: Map<string, unknown | Error>, opts: { holdMs?: number } = {}) {
  const state: Scripted = { answers, calls: [], peak: 0 };
  let inFlight = 0;
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    state.calls.push(url);
    inFlight++;
    state.peak = Math.max(state.peak, inFlight);
    try {
      if (opts.holdMs) await new Promise((r) => setTimeout(r, opts.holdMs));
      const key = url.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
      const answer = answers.get(key);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) return new Response('nope', { status: 404 });
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
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
  const feed = new VulnerabilityFeedService(db, settings, log, {
    fetchImpl,
    now: opts.now,
    concurrency: opts.concurrency,
  });
  return { db, feed, settings, state };
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

  it('surfaces a plugin closed on wordpress.org', async () => {
    const answers = new Map<string, unknown | Error>([
      [
        '/plugin/total-donations',
        pluginBody('total-donations', { name: 'Total Donations', closed: 1, closedReason: 'security-issue' }),
      ],
    ]);
    const { feed } = await makeFeed(answers);
    await feed.refresh([{ kind: 'plugin', slug: 'total-donations' }]);

    const verdict = feed.verdictFor('plugin', 'total-donations', '2.0');
    expect(verdict.closedOnWporg).toBe(true);
    expect(verdict.closedReason).toBe('security-issue');
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
