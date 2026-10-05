import { describe, expect, it } from 'vitest';
import { backupIdsQuery, backupsListQuery } from '../../shared/schemas.js';
import {
  BACKUPS_PAGE_SIZE,
  backupFilterParams,
  backupListParams,
  bulkDeleteSafeguard,
  deletedSiteSafeguard,
  hasBackupFilters,
  matchingPhrase,
  parseBackupFilters,
  patchBackupParams,
} from '../../web/src/lib/backupFilters.js';

/**
 * The Backups list keeps its filters in the URL, like the Jobs list. These are the rules that
 * turn a URL into a request the (strict) list API accepts, and a filter change into the next URL.
 */

describe('backup filters from the URL', () => {
  it('reads every filter the page offers', () => {
    expect(parseBackupFilters(new URLSearchParams('siteSlug=shop&deleted=true&type=final&serverId=2&page=3'))).toEqual({
      siteSlug: 'shop',
      deleted: true,
      type: 'final',
      serverId: 2,
      page: 3,
    });
  });

  it('drops what this build does not know instead of sending it to a strict API', () => {
    const f = parseBackupFilters(new URLSearchParams('type=nightly&deleted=yes&serverId=abc&page=0'));
    expect(f).toEqual({ siteSlug: null, deleted: false, type: null, serverId: null, page: 1 });
    expect(hasBackupFilters(f)).toBe(false);
  });

  it('asks the API for exactly what the page shows, in words it accepts', () => {
    const ask = (query: string) => backupListParams(parseBackupFilters(new URLSearchParams(query)));
    expect(ask('')).toEqual({ limit: String(BACKUPS_PAGE_SIZE) });
    expect(ask('deleted=true&page=2')).toEqual({
      deleted: 'true',
      limit: String(BACKUPS_PAGE_SIZE),
      offset: String(BACKUPS_PAGE_SIZE),
    });
    // One site named is narrower than "every deleted site"; the two are never sent together.
    expect(ask('siteSlug=gone&deleted=true')).toEqual({ siteSlug: 'gone', limit: String(BACKUPS_PAGE_SIZE) });
    for (const query of ['', 'siteSlug=panel&type=panel&serverId=3&page=9', 'deleted=true&type=final']) {
      expect(backupsListQuery.safeParse(ask(query)).success).toBe(true);
    }
  });

  it('drops empty values from the URL, and goes back to the first page on any change but paging', () => {
    const start = new URLSearchParams('siteSlug=shop&type=final&page=4');
    expect(patchBackupParams(start, { type: null }).toString()).toBe('siteSlug=shop');
    expect(patchBackupParams(start, { siteSlug: null, deleted: true }).toString()).toBe('type=final&deleted=true');
    expect(patchBackupParams(start, { page: 5 }).toString()).toBe('siteSlug=shop&type=final&page=5');
    expect(patchBackupParams(start, { page: 1 }).toString()).toBe('siteSlug=shop&type=final');
  });
});

describe("deleting a deleted site's backup", () => {
  const gone = (status: 'complete' | 'failed' = 'complete') => ({ siteDeleted: true, siteSlug: 'gone', status });

  it('has the name typed for its last complete backup, whatever failed attempts sit beside it', () => {
    // One restorable backup and one failed row: two rows, but deleting the first loses the site.
    const guard = deletedSiteSafeguard(gone(), [{ slug: 'gone', complete: 1 }]);
    expect(guard.confirmWord).toBe('gone');
    expect(guard.warning).toMatch(/last backup of gone/);
  });

  it('warns without asking for the name while another complete backup is left', () => {
    const guard = deletedSiteSafeguard(gone(), [{ slug: 'gone', complete: 2 }]);
    expect(guard.confirmWord).toBeUndefined();
    expect(guard.warning).toMatch(/gone has been deleted/);
  });

  it('asks nothing for a failed backup, which has no files to lose, or for a site that still exists', () => {
    expect(deletedSiteSafeguard(gone('failed'), [{ slug: 'gone', complete: 1 }])).toEqual({});
    expect(deletedSiteSafeguard({ siteDeleted: false, siteSlug: 'shop', status: 'complete' }, [])).toEqual({});
  });

  it('errs towards asking when the summary does not name the site', () => {
    expect(deletedSiteSafeguard(gone(), []).confirmWord).toBe('gone');
  });
});

describe('bulk delete', () => {
  const filters = (query: string) => parseBackupFilters(new URLSearchParams(query));

  it('asks for the ids of everything the list shows, with its filters and without its paging', () => {
    expect(backupFilterParams(filters('siteSlug=shop&type=manual&page=3'))).toEqual({ siteSlug: 'shop', type: 'manual' });
    // As the list asks: a site named is narrower than "every deleted site", never both.
    expect(backupFilterParams(filters('siteSlug=gone&deleted=true'))).toEqual({ siteSlug: 'gone' });
    for (const query of ['siteSlug=shop', 'deleted=true&type=final', 'serverId=4', '']) {
      expect(backupIdsQuery.safeParse(backupFilterParams(filters(query))).success, query).toBe(true);
    }
  });

  it('says whose backups "all of them" are, as plainly as the filters allow', () => {
    expect(matchingPhrase(filters('siteSlug=shop'))).toBe('of shop');
    expect(matchingPhrase(filters('siteSlug=panel'))).toBe("of the panel's own database");
    expect(matchingPhrase(filters('deleted=true'))).toBe('of deleted sites');
    expect(matchingPhrase(filters('siteSlug=shop&type=manual'))).toBe('that match these filters');
  });

  const shop = { siteDeleted: false, siteSlug: 'shop', status: 'complete' as const };
  const gone = { siteDeleted: true, siteSlug: 'gone', status: 'complete' as const };

  it('is typed for, always: "delete", or the name of a site it takes everything of', () => {
    expect(bulkDeleteSafeguard([shop, shop], [])).toEqual({ confirmWord: 'delete' });
    // Both complete backups of a deleted site: nothing of it left. One of two: still something.
    const last = bulkDeleteSafeguard([gone, gone, shop], [{ slug: 'gone', complete: 2 }]);
    expect(last.confirmWord).toBe('gone');
    expect(last.warning).toMatch(/last backups of gone/);
    expect(bulkDeleteSafeguard([gone], [{ slug: 'gone', complete: 2 }])).toEqual({ confirmWord: 'delete' });
    // A failed one has no files; deleting it loses nothing.
    expect(bulkDeleteSafeguard([{ ...gone, status: 'failed' }], [{ slug: 'gone', complete: 1 }])).toEqual({
      confirmWord: 'delete',
    });
    const two = bulkDeleteSafeguard([gone, { ...gone, siteSlug: 'old' }], [
      { slug: 'gone', complete: 1 },
      { slug: 'old', complete: 1 },
    ]);
    expect(two).toEqual({ confirmWord: 'delete', warning: expect.stringMatching(/last backups of gone and old/) });
  });

  it("asks for a site's name when the selection is every backup it has", () => {
    expect(bulkDeleteSafeguard([shop, shop], [], 'shop')).toEqual({
      confirmWord: 'shop',
      warning: expect.stringMatching(/shop is left with no backups at all/),
    });
    // The panel's own snapshots are not a site's.
    expect(bulkDeleteSafeguard([], [], 'panel')).toEqual({ confirmWord: 'delete' });
  });
});
