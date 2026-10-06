// @docs backups/delete
import { backupTypes, type BackupType } from '../../../shared/schemas';
import type { BackupListDto, BackupListItemDto } from '../../../shared/types';

/**
 * The Backups list's filters, kept in the URL for the reasons the Jobs list's are (see
 * jobFilters.ts): a filtered list can be linked to, and Back returns to it. The URL uses the
 * API's own parameter names.
 */

export const BACKUPS_PAGE_SIZE = 50;

export interface BackupFilters {
  /** One site's backups - a deleted site's too. `panel` is the panel's own snapshots. */
  siteSlug: string | null;
  /** Only the backups of sites that no longer exist. Moot once `siteSlug` names one. */
  deleted: boolean;
  type: BackupType | null;
  serverId: number | null;
  /** 1-based, like the pager reads. */
  page: number;
}

const positiveInt = (raw: string | null): number | null => {
  if (raw === null || !/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
};

/** What a URL asks for, minus anything this build does not know: the API refuses those. */
export function parseBackupFilters(params: URLSearchParams): BackupFilters {
  const site = (params.get('siteSlug') ?? '').trim();
  const type = params.get('type');
  return {
    siteSlug: site && site.length <= 64 ? site : null,
    deleted: params.get('deleted') === 'true',
    type: type !== null && (backupTypes as readonly string[]).includes(type) ? (type as BackupType) : null,
    serverId: positiveInt(params.get('serverId')),
    page: positiveInt(params.get('page')) ?? 1,
  };
}

/**
 * The URL after a filter change. Empty values are dropped rather than written as `?type=`,
 * and anything but paging goes back to the first page.
 */
export function patchBackupParams(prev: URLSearchParams, patch: Partial<BackupFilters>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const key of Object.keys(patch) as (keyof BackupFilters)[]) {
    const value = patch[key];
    const text =
      value === null || value === undefined || value === false || value === ''
        ? null
        : key === 'page' && value === 1
          ? null
          : String(value);
    if (text === null) next.delete(key);
    else next.set(key, text);
  }
  if (!('page' in patch)) next.delete('page');
  return next;
}

/** The filters as the API reads them - `GET /api/backups` and `GET /api/backups/ids` alike. */
export function backupFilterParams(filters: BackupFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.siteSlug) out.siteSlug = filters.siteSlug;
  else if (filters.deleted) out.deleted = 'true';
  if (filters.type) out.type = filters.type;
  if (filters.serverId) out.serverId = String(filters.serverId);
  return out;
}

/** The `GET /api/backups` query for these filters: one page of them. */
export function backupListParams(filters: BackupFilters): Record<string, string> {
  const out = backupFilterParams(filters);
  out.limit = String(BACKUPS_PAGE_SIZE);
  if (filters.page > 1) out.offset = String((filters.page - 1) * BACKUPS_PAGE_SIZE);
  return out;
}

/** Whether anything narrows the list (the page does not count). */
export function hasBackupFilters(filters: BackupFilters): boolean {
  return filters.siteSlug !== null || filters.deleted || filters.type !== null || filters.serverId !== null;
}

/**
 * What deleting one of a deleted site's backups says first, and whether the site's name has to
 * be typed. Its backups are all that is left of it, and its last usable one is the site: that
 * one is typed for, like deleting the site itself. Counted in complete backups - a failed one
 * beside it has no files, and must not make the real one look like one of two. Deleting a
 * failed one loses nothing, so it asks for nothing.
 */
export function deletedSiteSafeguard(
  backup: Pick<BackupListItemDto, 'siteDeleted' | 'siteSlug' | 'status'>,
  deletedSites: Pick<BackupListDto['deletedSites'][number], 'slug' | 'complete'>[],
): { warning?: string; confirmWord?: string } {
  if (!backup.siteDeleted || backup.status !== 'complete') return {};
  // Not in the summary is treated as the last one: asking once too often costs a word typed.
  const left = deletedSites.find((d) => d.slug === backup.siteSlug)?.complete ?? 0;
  if (left <= 1) {
    return {
      warning: `This is the last backup of ${backup.siteSlug}, a site that has been deleted. Nothing of it is left after this.`,
      confirmWord: backup.siteSlug,
    };
  }
  return { warning: `${backup.siteSlug} has been deleted; its backups are all that is left of it.` };
}

/** Whether the filters name one site and nothing else: "every backup of shop". */
export const siteOnly = (f: BackupFilters): f is BackupFilters & { siteSlug: string } =>
  f.siteSlug !== null && f.type === null && f.serverId === null;

/** "of shop", "of deleted sites" - whose backups "all 312 backups …" are, as plainly as the filters allow. */
export function matchingPhrase(filters: BackupFilters): string {
  if (siteOnly(filters)) return filters.siteSlug === 'panel' ? "of the panel's own database" : `of ${filters.siteSlug}`;
  if (filters.deleted && filters.siteSlug === null && filters.type === null && filters.serverId === null) {
    return 'of deleted sites';
  }
  return 'that match these filters';
}

const inWords = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * What a bulk delete says first, and what has to be typed. Always something: `delete`, as for
 * deleting plugins in bulk - or the site's name where this takes everything a site has, as
 * deleting the site itself asked for it.
 *
 * `rows` is what is selected, whichever page it is on. A deleted site loses everything when
 * every complete backup it has left is among them - counted as deletedSiteSafeguard counts it,
 * with a site the summary does not name taken as wiped out. `wholeSite` names a site that
 * still exists when the selection is every backup it has ("Select all" on a filter naming
 * only it), which the rows alone cannot tell.
 */
export function bulkDeleteSafeguard(
  rows: Pick<BackupListItemDto, 'siteDeleted' | 'siteSlug' | 'status'>[],
  deletedSites: Pick<BackupListDto['deletedSites'][number], 'slug' | 'complete'>[],
  wholeSite: string | null = null,
): { warning?: string; confirmWord: string } {
  const picked = new Map<string, number>();
  for (const row of rows) {
    if (row.siteDeleted && row.status === 'complete') picked.set(row.siteSlug, (picked.get(row.siteSlug) ?? 0) + 1);
  }
  const wiped = [...picked]
    .filter(([slug, n]) => n >= (deletedSites.find((d) => d.slug === slug)?.complete ?? 0))
    .map(([slug]) => slug);
  if (wiped.length === 1) {
    return {
      warning: `This takes the last backup${picked.get(wiped[0]!)! === 1 ? '' : 's'} of ${wiped[0]}, a site that has been deleted. Nothing of it is left after this.`,
      confirmWord: wiped[0]!,
    };
  }
  if (wiped.length > 1) {
    return {
      warning: `This takes the last backups of ${inWords(wiped)}, sites that have been deleted. Nothing of them is left after this.`,
      confirmWord: 'delete',
    };
  }
  if (wholeSite && wholeSite !== 'panel') {
    return { warning: `${wholeSite} is left with no backups at all until its next one is taken.`, confirmWord: wholeSite };
  }
  return { confirmWord: 'delete' };
}
