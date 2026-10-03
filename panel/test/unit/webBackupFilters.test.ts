import { describe, expect, it } from 'vitest';
import { backupsListQuery } from '../../shared/schemas.js';
import {
  BACKUPS_PAGE_SIZE,
  backupListParams,
  deletedSiteSafeguard,
  hasBackupFilters,
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
