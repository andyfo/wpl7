import { describe, expect, it } from 'vitest';
import { cleanText, WporgDirectoryService, wporgListing } from '../../src/services/wporg.js';
import { AppError } from '../../src/lib/errors.js';

/** A trimmed-down copy of a real api.wordpress.org query_plugins payload. */
const searchPayload = {
  info: { page: 1, pages: 50, results: 8017 },
  plugins: [
    {
      name: 'Yoast SEO &#8211; Advanced SEO',
      slug: 'wordpress-seo',
      version: '28.5',
      author: '<a href="https://profiles.wordpress.org/yoast/">Yoast</a>',
      short_description: 'Real-time SEO guidance.',
      active_installs: 10000000,
      rating: 96,
      num_ratings: 27819,
      requires: '6.9',
      requires_php: '7.4',
      tested: '7.1.1',
      last_updated: '2026-09-15 6:43am GMT',
      homepage: 'https://yoa.st/1uj',
      icons: { '1x': 'https://ps.w.org/wordpress-seo/assets/icon-128x128.gif', '2x': 'https://ps.w.org/x-256.gif' },
    },
  ],
};

/** Records every requested URL and answers from a queue of responses. */
function stubFetch(responses: { status: number; body: unknown }[]) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    const next = responses.shift() ?? { status: 200, body: { plugins: [], info: {} } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('cleanText', () => {
  it('strips the directory’s markup and decodes entities', () => {
    expect(cleanText('<a href="#">Yoast</a>')).toBe('Yoast');
    expect(cleanText('Yoast SEO &#8211; Advanced &amp; fast')).toBe('Yoast SEO – Advanced & fast');
    expect(cleanText('WP&nbsp;Rocket&hellip;')).toBe('WP Rocket…');
    expect(cleanText(undefined)).toBe('');
  });
});

describe('WporgDirectoryService.search', () => {
  it('queries the directory and maps results to DTOs', async () => {
    const { fetchImpl, urls } = stubFetch([{ status: 200, body: searchPayload }]);
    const svc = new WporgDirectoryService({ fetchImpl });

    const res = await svc.search('seo');

    expect(urls[0]).toContain('action=query_plugins');
    expect(urls[0]).toContain('request%5Bsearch%5D=seo');
    // The heavy default fields are switched off so a typeahead response stays small.
    expect(urls[0]).toContain('request%5Bfields%5D%5Bsections%5D=0');
    expect(res.total).toBe(8017);
    expect(res.items).toEqual([
      {
        slug: 'wordpress-seo',
        name: 'Yoast SEO – Advanced SEO',
        author: 'Yoast',
        shortDescription: 'Real-time SEO guidance.',
        version: '28.5',
        activeInstalls: 10000000,
        rating: 96,
        numRatings: 27819,
        requiresWp: '6.9',
        requiresPhp: '7.4',
        testedUpTo: '7.1.1',
        lastUpdated: '2026-09-15 6:43am GMT',
        homepage: 'https://yoa.st/1uj',
        icon: 'https://ps.w.org/x-256.gif',
      },
    ]);
  });

  it('serves a repeated search from cache', async () => {
    const { fetchImpl, urls } = stubFetch([{ status: 200, body: searchPayload }]);
    const svc = new WporgDirectoryService({ fetchImpl });

    await svc.search('seo');
    await svc.search('  SEO  ');

    expect(urls).toHaveLength(1);
  });

  it('re-queries once the cache entry has expired', async () => {
    const { fetchImpl, urls } = stubFetch([
      { status: 200, body: searchPayload },
      { status: 200, body: searchPayload },
    ]);
    const svc = new WporgDirectoryService({ fetchImpl, searchTtlMs: 0 });

    await svc.search('seo');
    await svc.search('seo');

    expect(urls).toHaveLength(2);
  });
});

describe('WporgDirectoryService.info', () => {
  it('returns the plugin for a slug the directory knows', async () => {
    const { fetchImpl, urls } = stubFetch([{ status: 200, body: searchPayload.plugins[0] }]);
    const svc = new WporgDirectoryService({ fetchImpl });

    const found = await svc.info('wordpress-seo');

    expect(urls[0]).toContain('action=plugin_information');
    expect(urls[0]).toContain('request%5Bslug%5D=wordpress-seo');
    expect(found?.name).toBe('Yoast SEO – Advanced SEO');
  });

  it('returns null for the directory’s 404, and caches the miss', async () => {
    const { fetchImpl, urls } = stubFetch([{ status: 404, body: { error: 'Plugin not found.' } }]);
    const svc = new WporgDirectoryService({ fetchImpl });

    expect(await svc.info('totally-not-a-real-plugin')).toBeNull();
    // A cached null matters: the catalog check runs on every add attempt.
    expect(await svc.info('totally-not-a-real-plugin')).toBeNull();
    expect(urls).toHaveLength(1);
  });

  it('reports an unreachable directory as a bad gateway, not as "not found"', async () => {
    const fetchImpl = (() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof fetch;
    const svc = new WporgDirectoryService({ fetchImpl });

    await expect(svc.info('akismet')).rejects.toMatchObject({
      code: 'bad_gateway',
      message: expect.stringContaining('Could not reach the wordpress.org plugin directory'),
    });
  });

  it('treats a directory 500 as an outage rather than a missing plugin', async () => {
    const { fetchImpl } = stubFetch([{ status: 500, body: null }]);
    const svc = new WporgDirectoryService({ fetchImpl });

    const err = await svc.info('akismet').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(502);
  });
});

describe('wporgListing', () => {
  /** The directory's answer for a closed plugin, as it came for one on 2026-10-20. */
  const closedBody = (reason: string) => ({
    error: 'closed',
    name: 'Old Plugin',
    slug: 'old-plugin',
    description: 'This plugin has been closed as of January 30, 2021 and is not available for download.',
    closed: true,
    closed_date: '2021-01-30',
    reason,
    reason_text: 'Security Issue',
  });

  it('reads a plugin the directory lists, asking for a small answer', async () => {
    const { fetchImpl, urls } = stubFetch([{ status: 200, body: { name: 'bbPress', slug: 'bbpress', version: '2.6.20' } }]);

    expect(await wporgListing('plugin', 'bbpress', fetchImpl)).toEqual({ state: 'listed' });
    expect(urls[0]).toContain('/plugins/info/1.2/?action=plugin_information');
    expect(urls[0]).toContain('request%5Bslug%5D=bbpress');
    // The readme alone is tens of kilobytes on a popular plugin.
    expect(urls[0]).toContain('request%5Bfields%5D%5Bsections%5D=0');
  });

  it('reads a closed plugin with its reason, and "unknown" as no reason', async () => {
    const { fetchImpl } = stubFetch([
      { status: 404, body: closedBody('security-issue') },
      { status: 404, body: closedBody('unknown') },
    ]);

    expect(await wporgListing('plugin', 'old-plugin', fetchImpl)).toEqual({ state: 'closed', reason: 'security-issue' });
    expect(await wporgListing('plugin', 'old-plugin', fetchImpl)).toEqual({ state: 'closed', reason: null });
  });

  it('reads a slug the directory never had as absent', async () => {
    const { fetchImpl, urls } = stubFetch([
      { status: 404, body: { error: 'Plugin not found.' } },
      { status: 404, body: { error: 'Theme not found' } },
    ]);

    expect(await wporgListing('plugin', 'acme-premium', fetchImpl)).toEqual({ state: 'absent' });
    expect(await wporgListing('theme', 'acme-theme', fetchImpl)).toEqual({ state: 'absent' });
    expect(urls[1]).toContain('/themes/info/1.2/?action=theme_information');
  });

  it('reads a theme the directory lists', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { name: 'Twenty Twenty-Five', slug: 'twentytwentyfive', version: '1.5' } }]);

    expect(await wporgListing('theme', 'twentytwentyfive', fetchImpl)).toEqual({ state: 'listed' });
  });

  it('throws on any answer that does not say, so nothing reads as listed by accident', async () => {
    const { fetchImpl } = stubFetch([
      { status: 503, body: null },
      // Another slug's record, a record with no version, and a shape of another API.
      { status: 200, body: { name: 'Other', slug: 'other', version: '1.0' } },
      { status: 200, body: { name: 'bbPress', slug: 'bbpress' } },
      { status: 200, body: { error: 0, data: { name: 'bbPress' } } },
    ]);
    for (let i = 0; i < 4; i++) await expect(wporgListing('plugin', 'bbpress', fetchImpl)).rejects.toThrow(/wordpress.org answered HTTP/);

    const offline = (() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof fetch;
    await expect(wporgListing('plugin', 'bbpress', offline)).rejects.toThrow('ENOTFOUND');
  });

  it('never reads a closure as listed, whatever the status', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { ...closedBody('author-request'), version: '1.0' } }]);

    expect(await wporgListing('plugin', 'old-plugin', fetchImpl)).toEqual({ state: 'closed', reason: 'author-request' });
  });
});
