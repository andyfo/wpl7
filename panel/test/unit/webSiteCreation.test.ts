import { describe, expect, it } from 'vitest';
import type { JobDto } from '../../shared/types.js';
import { createJobFor, draftOf, keepDraft, type NewSiteDraft } from '../../web/src/lib/siteCreation.js';

/**
 * New site sends its form, then opens the site's own page, which shows the create it started.
 * These are the rules that page finds that job by, and the form it can go back to.
 */

const job = (over: Partial<JobDto>): JobDto => ({
  id: 1,
  type: 'site.create',
  status: 'running',
  siteSlug: 'shop',
  batchId: null,
  error: null,
  result: null,
  createdAt: 1_000,
  startedAt: null,
  finishedAt: null,
  summary: null,
  origin: 'user',
  createdBy: 'admin',
  scheduleId: null,
  serverId: 1,
  cancelRequested: false,
  ...over,
});

describe("a site's create, among the jobs this tab started", () => {
  it('is the newest create of that slug', () => {
    const jobs = [
      job({ id: 3 }),
      job({ id: 7, createdAt: 2_000 }),
      job({ id: 9, siteSlug: 'blog' }),
      job({ id: 11, type: 'site.restart' }),
      null,
    ];
    expect(createJobFor(jobs, 'shop', null)?.id).toBe(7);
    expect(createJobFor(jobs, 'blog', null)?.id).toBe(9);
    expect(createJobFor(jobs, 'news', null)).toBeNull();
  });

  it('is never one from before the site: that made an earlier site of the same name', () => {
    const jobs = [job({ id: 3, createdAt: 1_000 })];
    // Queued in the same transaction as the site, a moment after it.
    expect(createJobFor(jobs, 'shop', 1_000)?.id).toBe(3);
    expect(createJobFor(jobs, 'shop', 999)?.id).toBe(3);
    expect(createJobFor(jobs, 'shop', 1_001)).toBeNull();
  });
});

describe('the form a create was sent with', () => {
  it('is kept by its job, for Back to the form', () => {
    const draft: NewSiteDraft = {
      title: 'Shop',
      slugEdited: '',
      serverId: null,
      customDomain: true,
      domainsText: 'shop.example.com',
      adminUser: 'boss',
      adminEmail: null,
      generatePw: false,
      adminPassword: 'correct-horse-battery',
      locale: 'de_DE',
      phpVersion: null,
      discourageSearch: false,
      selectedCatalog: [2, 5],
      extraPlugins: [],
    };
    keepDraft(41, draft);
    expect(draftOf(41)).toEqual(draft);
    expect(draftOf(42)).toBeNull();
  });
});
