import { describe, expect, it } from 'vitest';
import { cleanText, WporgDirectoryService } from '../../src/services/wporg.js';
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
