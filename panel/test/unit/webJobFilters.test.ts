import { describe, expect, it } from 'vitest';
import { jobsListQuery } from '../../shared/schemas.js';
import {
  EMPTY_JOB_FILTERS,
  JOB_WINDOWS,
  hasFilters,
  jobListParams,
  parseJobFilters,
  patchJobParams,
} from '../../web/src/lib/jobFilters.js';

/**
 * The Jobs list keeps its filters in the URL. These are the rules that turn a URL into a
 * request the (strict) list API accepts, and a filter change into the next URL.
 */

describe('job filters from the URL', () => {
  it('reads every filter the page offers', () => {
    const f = parseJobFilters(
      new URLSearchParams(
        'q=akismet&status=failed,queued&type=wp.bulkTask&category=wordpress&origin=schedule' +
          '&siteSlug=shop&serverId=2&scheduleId=7&batchId=3&window=24h&page=3',
      ),
    );
    expect(f).toEqual({
      q: 'akismet',
      // Canonical order, whatever the URL said.
      status: ['queued', 'failed'],
      type: 'wp.bulkTask',
      category: 'wordpress',
      origin: 'schedule',
      siteSlug: 'shop',
      serverId: 2,
      scheduleId: 7,
      batchId: 3,
      window: '24h',
      page: 3,
    });
  });

  it('drops what this build does not know instead of sending it to a strict API', () => {
    const f = parseJobFilters(
      new URLSearchParams('status=failed,exploded&type=site.teleport&category=x&origin=robot&window=1y&serverId=abc&page=0'),
    );
    expect(f.status).toEqual(['failed']);
    expect(f.type).toBeNull();
    expect(f.category).toBeNull();
    expect(f.origin).toBeNull();
    expect(f.window).toBeNull();
    expect(f.serverId).toBeNull();
    expect(f.page).toBe(1);
  });

  it('reads an empty URL as no filters at all', () => {
    const f = parseJobFilters(new URLSearchParams());
    expect(f).toEqual(EMPTY_JOB_FILTERS);
    expect(hasFilters(f)).toBe(false);
    expect(hasFilters({ ...f, page: 4 })).toBe(false);
    expect(hasFilters({ ...f, window: '7d' })).toBe(true);
  });

  it('never produces a query the list API refuses', () => {
    const f = parseJobFilters(new URLSearchParams('q=%23123&status=running&origin=api&window=1h&page=2&bogus=1'));
    const params = jobListParams(f, 1_000_000_000_000);
    expect(jobsListQuery.safeParse(params).success).toBe(true);
    expect(Object.keys(params).sort()).toEqual(['limit', 'offset', 'origin', 'q', 'since', 'status']);
  });
});

describe('the list request', () => {
  it('turns the window into `since` at the moment of asking', () => {
    const now = 1_700_000_000_000;
    expect(jobListParams({ window: '24h' }, now).since).toBe(String(now - JOB_WINDOWS['24h']));
    // A list polled for an hour asks for the last 24 hours as of now, not as of opening.
    expect(jobListParams({ window: '24h' }, now + 3_600_000).since).toBe(String(now + 3_600_000 - 86_400_000));
  });

  it('pages by the page size, or by the limit a short list asks for', () => {
    expect(jobListParams({ page: 1 }, 0)).toEqual({ limit: '50' });
    expect(jobListParams({ page: 3 }, 0)).toEqual({ limit: '50', offset: '100' });
    expect(jobListParams({ limit: 5 }, 0)).toEqual({ limit: '5' });
  });

  it('leaves out what is not set', () => {
    expect(jobListParams(EMPTY_JOB_FILTERS, 0)).toEqual({ limit: '50' });
  });
});

describe('changing a filter', () => {
  it('goes back to the first page unless the change is the page', () => {
    const prev = new URLSearchParams('status=failed&page=4');
    expect(patchJobParams(prev, { origin: 'api' }).toString()).toBe('status=failed&origin=api');
    expect(patchJobParams(prev, { page: 5 }).toString()).toBe('status=failed&page=5');
    // Page 1 is the default, so it is not written.
    expect(patchJobParams(prev, { page: 1 }).toString()).toBe('status=failed');
  });

  it('removes a filter set to nothing rather than writing an empty value', () => {
    const prev = new URLSearchParams('q=x&status=failed&type=wp.cli&siteSlug=shop');
    const next = patchJobParams(prev, { q: '  ', status: [], type: null, siteSlug: '' });
    expect(next.toString()).toBe('');
  });

  it('writes lists comma-separated and keeps what it was not asked to change', () => {
    const next = patchJobParams(new URLSearchParams('window=7d'), { status: ['queued', 'running'], scheduleId: 12 });
    expect(next.get('status')).toBe('queued,running');
    expect(next.get('scheduleId')).toBe('12');
    expect(next.get('window')).toBe('7d');
    expect(parseJobFilters(next).status).toEqual(['queued', 'running']);
  });

  it('does not change the URL it was given', () => {
    const prev = new URLSearchParams('status=failed');
    patchJobParams(prev, { status: [] });
    expect(prev.toString()).toBe('status=failed');
  });
});
