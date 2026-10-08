// @docs backups/delete, backups/overview
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { BackupIdsDto, BackupListItemDto } from '../../../shared/types';
import { MAX_BULK_BACKUP_DELETE, type BackupType } from '../../../shared/schemas';
import { api } from '../api/client';
import { useAllBackups, useMeta, useRunJob, useSites } from '../api/hooks';
import {
  BackupActions,
  BulkDeleteBackupsDialog,
  DeleteBackupDialog,
  FetchBackDialog,
  OffsiteBadges,
  RestoreBackupDialog,
} from '../components/backups/BackupParts';
import { JobProgress } from '../components/JobProgress';
import { Icon } from '../components/Icon';
import { Button, Card, EmptyState, ErrorNote, Field, inputClass, Spinner, StatusBadge } from '../components/ui';
import {
  BACKUPS_PAGE_SIZE,
  backupFilterParams,
  bulkDeleteSafeguard,
  deletedSiteSafeguard,
  hasBackupFilters,
  matchingPhrase,
  parseBackupFilters,
  patchBackupParams,
  siteOnly,
  type BackupFilters,
} from '../lib/backupFilters';
import { formatBytes, formatDate, timeAgo } from '../lib/format';

/** What a site's backups can be, in the Kind filter. The panel's own is a "whose", under Site. */
const SITE_KINDS: { id: BackupType; label: string }[] = [
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'manual', label: 'Manual' },
  { id: 'final', label: 'Final, taken on deletion' },
  { id: 'pre_update', label: 'Before an update' },
  { id: 'pre_restore', label: 'Before a restore' },
  { id: 'move', label: 'Server move' },
  { id: 'import', label: 'Import' },
];

/** The Site filter's value for "every deleted site"; a slug never starts with @. */
const DELETED = '@deleted';

/** Deleted sites named one by one above the list; the rest are one click further. */
const DELETED_CHIPS = 8;

/**
 * Every backup the panel knows of, newest first. A site's Backups tab lists that site's; this
 * is also the one place the backups of a deleted site are still listed, which is the reason
 * this page exists.
 */
export function Backups() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseBackupFilters(params), [params]);
  const patch = (change: Partial<BackupFilters>) =>
    setParams((prev) => patchBackupParams(prev, change), { replace: true });
  const meta = useMeta();
  const sites = useSites();
  const list = useAllBackups(filters);
  // ['backups'] too: a bulk delete empties the sites' own Backups tabs as well.
  const run = useRunJob([['all-backups'], ['backups']]);
  const qc = useQueryClient();
  const [restoreFor, setRestoreFor] = useState<BackupListItemDto | null>(null);
  const [fetchFor, setFetchFor] = useState<BackupListItemDto | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  /** Backups ticked: on this page, or - after "Select all" - on every page. */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /**
   * What "Select all" fetched: every backup the filters matched at that moment, by id. Kept as
   * it was until the selection is cleared. The list goes on refreshing underneath, and a backup
   * taken since - or the backups of a site deleted since, which "deleted" now matches - were
   * never shown to anybody, so they must not join a selection made before them.
   */
  const [snapshot, setSnapshot] = useState<Map<number, BackupIdsDto['items'][number]> | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const data = list.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const deletedSites = data?.deletedSites ?? [];
  const page = filters.page;
  const multiServer = meta.data?.multiServer ?? false;
  const offsiteConfigured = meta.data?.offsiteConfigured ?? false;
  const serverNames = useMemo(() => new Map((meta.data?.servers ?? []).map((s) => [s.id, s.name])), [meta.data]);
  const serverName = (id: number) => serverNames.get(id) ?? `server #${id}`;
  const siteList = useMemo(() => [...(sites.data ?? [])].sort((a, b) => a.slug.localeCompare(b.slug)), [sites.data]);
  const filtered = hasBackupFilters(filters);
  // Resolved from the list rather than held, so a refetch that drops the row closes the dialog.
  const deleteTarget = items.find((b) => b.id === deleteId);
  const selectedDeleted = filters.siteSlug ? deletedSites.find((d) => d.slug === filters.siteSlug) : undefined;

  // What can be ticked: not a backup still being written, nor one a deletion already has.
  const selectable = useMemo(() => items.filter((b) => b.status !== 'creating' && b.deletingJobId === null), [items]);
  const clearSelection = () => {
    setSelected(new Set());
    setSnapshot(null);
  };
  // A selection is made under these filters, on this page: either changing starts it over.
  const listKey = params.toString();
  const listKeyNow = useRef(listKey);
  listKeyNow.current = listKey;
  useEffect(clearSelection, [listKey]);
  // Ticked on this page, a row a refetch dropped (deleted elsewhere, pruned) leaves the
  // selection, so nothing ticked out of sight travels into the next Delete. "Select all" is a
  // list of ids fetched once, most of them out of sight by design: it stays as it was fetched.
  useEffect(() => {
    if (snapshot) return;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(selectable.map((b) => b.id));
      const kept = new Set([...prev].filter((id) => visible.has(id)));
      return kept.size === prev.size ? prev : kept;
    });
  }, [selectable, snapshot]);
  const ticked = selectable.filter((b) => selected.has(b.id)).length;
  const pageTick = ticked === 0 ? 'none' : ticked === selectable.length ? 'all' : 'some';
  const tick = (b: BackupListItemDto, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(b.id);
      else next.delete(b.id);
      return next;
    });
  // Everything a filter matches, beyond this page: offered once the whole page is ticked. Never
  // with no filter at all - "every backup there is" is not a thing to select by accident.
  const canSelectAll = !snapshot && filtered && pageTick === 'all' && total > items.length;
  const selectAll = async () => {
    const asked = listKey;
    setSelectingAll(true);
    setActionError(null);
    try {
      const res = await api<BackupIdsDto>(`/api/backups/ids?${new URLSearchParams(backupFilterParams(filters))}`);
      if (listKeyNow.current !== asked) return; // the filters moved on while it was asked
      if (res.total > res.items.length) {
        throw new Error(
          `These filters match ${res.total.toLocaleString()} backups; one bulk delete takes at most ${MAX_BULK_BACKUP_DELETE.toLocaleString()}. Narrow them first.`,
        );
      }
      setSnapshot(new Map(res.items.map((item) => [item.id, item])));
      setSelected(new Set(res.items.map((item) => item.id)));
    } catch (err) {
      setActionError(err);
    } finally {
      setSelectingAll(false);
    }
  };
  // "All 312 of shop" while the selection is still exactly what Select all fetched.
  const wholeSnapshot =
    snapshot !== null && selected.size === snapshot.size && [...snapshot.keys()].every((id) => selected.has(id));
  const bulkCount = selected.size;

  const siteValue = filters.siteSlug ?? (filters.deleted ? DELETED : '');
  const pickSite = (value: string) =>
    patch(value === DELETED ? { siteSlug: null, deleted: true } : { siteSlug: value || null, deleted: false });
  const knownSite = (slug: string) =>
    slug === 'panel' || siteList.some((s) => s.slug === slug) || deletedSites.some((d) => d.slug === slug);

  const refresh = (slug?: string) => {
    void qc.invalidateQueries({ queryKey: ['all-backups'] });
    if (slug) void qc.invalidateQueries({ queryKey: ['backups', slug] });
  };

  const pager =
    total > BACKUPS_PAGE_SIZE ? (
      <span className="flex items-center gap-2 text-xs">
        <Button small variant="ghost" disabled={page <= 1} onClick={() => patch({ page: page - 1 })}>
          ←
        </Button>
        <span className="text-neutral-500 tabular-nums">
          {(page - 1) * BACKUPS_PAGE_SIZE + 1}–{Math.min(page * BACKUPS_PAGE_SIZE, total)}
        </span>
        <Button small variant="ghost" disabled={page * BACKUPS_PAGE_SIZE >= total} onClick={() => patch({ page: page + 1 })}>
          →
        </Button>
      </span>
    ) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Backups</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Every backup on every server, including the backups of sites that have been deleted.
          </p>
        </div>
        <Link
          to="/backups/storage"
          className="inline-flex items-center gap-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-900"
        >
          Storage
          <Icon name="arrow" size={14} />
        </Link>
      </div>

      <Card>
        <div className="space-y-4">
          <div className={`grid gap-3 sm:grid-cols-2 ${multiServer ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
            <Field label="Site" width="full">
              <select className={inputClass} value={siteValue} onChange={(e) => pickSite(e.target.value)}>
                <option value="">All sites</option>
                {(deletedSites.length > 0 || filters.deleted) && <option value={DELETED}>Every deleted site</option>}
                <option value="panel">The panel's own database</option>
                {filters.siteSlug && !knownSite(filters.siteSlug) && (
                  // A link can name a slug with no backups (left) and no site; say so rather than guess.
                  <option value={filters.siteSlug}>{filters.siteSlug}</option>
                )}
                {siteList.length > 0 && (
                  <optgroup label="Sites">
                    {siteList.map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.slug}
                      </option>
                    ))}
                  </optgroup>
                )}
                {deletedSites.length > 0 && (
                  <optgroup label="Deleted sites">
                    {deletedSites.map((d) => (
                      <option key={d.slug} value={d.slug}>
                        {d.slug} (deleted)
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Field>
            <Field label="Kind" width="full">
              <select
                className={inputClass}
                value={filters.type ?? ''}
                onChange={(e) => patch({ type: (e.target.value || null) as BackupType | null })}
              >
                <option value="">All kinds</option>
                {SITE_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
                {filters.type === 'panel' && <option value="panel">Panel database</option>}
              </select>
            </Field>
            {multiServer && (
              <Field label="Server" width="full">
                <select
                  className={inputClass}
                  value={filters.serverId ?? ''}
                  onChange={(e) => patch({ serverId: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">All servers</option>
                  {filters.serverId !== null && !serverNames.has(filters.serverId) && (
                    <option value={filters.serverId}>Server #{filters.serverId}</option>
                  )}
                  {(meta.data?.servers ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {filtered && (
              <div className="flex items-end">
                <Button small variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Clear filters
                </Button>
              </div>
            )}
          </div>

          {deletedSites.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-neutral-100 pt-3" role="group" aria-label="Deleted sites">
              <span className="mr-1 text-xs font-medium text-neutral-500">Deleted sites</span>
              <button
                type="button"
                aria-pressed={filters.deleted && !filters.siteSlug}
                className={`entity-chip ${filters.deleted && !filters.siteSlug ? 'entity-chip-active' : ''}`}
                onClick={() => pickSite(DELETED)}
              >
                All
                <span className="tabular-nums opacity-70">{deletedSites.reduce((n, d) => n + d.backups, 0)}</span>
              </button>
              {deletedSites.slice(0, DELETED_CHIPS).map((d) => (
                <button
                  key={d.slug}
                  type="button"
                  aria-pressed={filters.siteSlug === d.slug}
                  title={`Last backed up ${formatDate(d.lastBackupAt)} · ${formatBytes(d.sizeBytes)}`}
                  className={`entity-chip ${filters.siteSlug === d.slug ? 'entity-chip-active' : ''}`}
                  onClick={() => pickSite(d.slug)}
                >
                  {d.slug}
                  <span className="tabular-nums opacity-70">{d.backups}</span>
                </button>
              ))}
              {deletedSites.length > DELETED_CHIPS && (
                <span className="text-xs text-neutral-400">
                  and {deletedSites.length - DELETED_CHIPS} more under Site
                </span>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card
        title={
          <span className="flex items-center gap-3">
            {data ? `${total.toLocaleString()} ${total === 1 ? 'backup' : 'backups'}` : 'Backups'}
            {list.isPlaceholderData && <Spinner />}
          </span>
        }
        action={pager}
      >
        <div className="space-y-3">
          <ErrorNote error={list.error} />
          <ErrorNote error={run.error} />
          <ErrorNote error={actionError} />
          <JobProgress job={run.job} logs={run.logs} />
          {selectedDeleted && (
            // Retention is per slug and does not know a site is gone: its scheduled backups are
            // still thinned to the newest N, here and at each destination. Everything else stays.
            <p className="rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
              <b>{selectedDeleted.slug}</b> has been deleted; these backups are what is left of it. The final backup
              and every other kind stay until you delete them, but scheduled ones still follow the{' '}
              <Link className="underline" to="/settings#backups">
                retention setting
              </Link>
              , like any site's. To bring it back, create a site named <code>{selectedDeleted.slug}</code>
              {multiServer && items[0] ? ` on ${serverName(items[0].serverId)}` : ''} and restore one of them from
              that site's Backups tab.
            </p>
          )}
          {!data ? (
            list.isPending ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : null
          ) : items.length === 0 ? (
            <EmptyState>
              {total > 0 && page > 1 ? (
                <>
                  This page is past the end of the list.{' '}
                  <button type="button" className="underline" onClick={() => patch({ page: 1 })}>
                    Back to the first page
                  </button>
                </>
              ) : filtered ? (
                <>
                  No backups match these filters.{' '}
                  <button type="button" className="underline" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                    Clear filters
                  </button>
                </>
              ) : (
                'No backups yet.'
              )}
            </EmptyState>
          ) : (
            <table className={`w-full text-sm transition-opacity ${list.isPlaceholderData ? 'opacity-60' : ''}`}>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="w-7 pb-2 pr-2">
                    <input
                      type="checkbox"
                      aria-label="Select every backup on this page"
                      disabled={selectable.length === 0}
                      checked={pageTick === 'all'}
                      ref={(el) => {
                        if (el) el.indeterminate = pageTick === 'some';
                      }}
                      onChange={(e) => {
                        if (!e.target.checked) clearSelection();
                        else setSelected((prev) => new Set([...prev, ...selectable.map((b) => b.id)]));
                      }}
                    />
                  </th>
                  <th className="pb-2 pr-3">When</th>
                  <th className="pb-2 pr-3">Site</th>
                  <th className="hidden pb-2 pr-3 sm:table-cell">Type</th>
                  <th className="hidden pb-2 pr-3 sm:table-cell">Status</th>
                  {offsiteConfigured && <th className="hidden pb-2 pr-3 md:table-cell">Remote</th>}
                  <th className="hidden pb-2 pr-3 text-right sm:table-cell">Size</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id} className={`border-t border-neutral-100 align-top ${selected.has(b.id) ? 'bg-neutral-50' : ''}`}>
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        aria-label={`Select backup #${b.id}`}
                        disabled={!selectable.includes(b)}
                        title={
                          b.status === 'creating' ? 'Still being written' : b.deletingJobId !== null ? 'Being deleted' : undefined
                        }
                        checked={selected.has(b.id)}
                        onChange={(e) => tick(b, e.target.checked)}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <span className="whitespace-nowrap" title={formatDate(b.createdAt)}>
                        {timeAgo(b.createdAt)}
                      </span>
                      {/* A panel snapshot's note only says what the Site column already does. */}
                      {b.note && b.type !== 'panel' && (
                        <div className="hidden max-w-48 truncate text-xs text-neutral-500 sm:block" title={b.note}>
                          {b.note}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <SiteCell backup={b} />
                      {/* A phone has no room for a Type column; the badge rides along. */}
                      <div className="mt-0.5 sm:hidden">
                        <StatusBadge status={b.type} />
                      </div>
                      {multiServer && (
                        <div
                          className="text-xs text-neutral-400"
                          title={b.rootPath ? `${b.rootPath}/${b.siteSlug}/…` : undefined}
                        >
                          {serverName(b.serverId)}
                        </div>
                      )}
                    </td>
                    <td className="hidden py-2 pr-3 sm:table-cell">
                      <StatusBadge status={b.type} />
                    </td>
                    <td className="hidden py-2 pr-3 sm:table-cell">
                      <StatusBadge status={b.status} />
                      {!b.filesPresent && <div className="mt-0.5 text-[10px] text-neutral-400">remote only</div>}
                    </td>
                    {offsiteConfigured && (
                      <td className="hidden py-2 pr-3 md:table-cell">
                        <OffsiteBadges copies={b.copies} />
                      </td>
                    )}
                    <td className="hidden whitespace-nowrap py-2 pr-3 text-right text-neutral-500 sm:table-cell">
                      {formatBytes(b.sizeBytes)}
                    </td>
                    <td className="py-2 text-right">
                      <BackupActions
                        backup={b}
                        canRestore={!b.siteDeleted && b.type !== 'panel'}
                        onRestore={() => setRestoreFor(b)}
                        onFetch={() => setFetchFor(b)}
                        onDelete={() => setDeleteId(b.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {pager && items.length > 0 && <div className="flex justify-end">{pager}</div>}
        </div>
      </Card>

      {/* Sticky, like the bulk WordPress page's: there only while something is ticked. */}
      {bulkCount > 0 && (
        <div className="sticky bottom-4 z-20 rounded-xl border border-neutral-300 bg-surface p-4 shadow-lg">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-medium">
              {wholeSnapshot
                ? `All ${bulkCount.toLocaleString()} backups ${matchingPhrase(filters)} selected`
                : `${bulkCount.toLocaleString()} ${bulkCount === 1 ? 'backup' : 'backups'} selected`}
            </span>
            {canSelectAll && (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-sm underline disabled:opacity-60"
                disabled={selectingAll}
                onClick={() => void selectAll()}
              >
                Select all {total.toLocaleString()} backups {matchingPhrase(filters)}
                {selectingAll && <Spinner />}
              </button>
            )}
            <Button small variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
            <span className="ml-auto">
              <Button small variant="danger" onClick={() => setBulkOpen(true)}>
                Delete {bulkCount.toLocaleString()}
              </Button>
            </span>
          </div>
        </div>
      )}

      {restoreFor && (
        <RestoreBackupDialog
          site={restoreFor.siteTitle ?? restoreFor.siteSlug}
          onConfirm={() => {
            setActionError(null);
            run.mutate({ path: `/api/backups/${restoreFor.id}/restore`, body: {} });
          }}
          onClose={() => setRestoreFor(null)}
        />
      )}
      {fetchFor && (
        <FetchBackDialog
          backup={fetchFor}
          target={
            fetchFor.siteDeleted || fetchFor.type === 'panel'
              ? multiServer
                ? `"${serverName(fetchFor.serverId)}"`
                : 'the server'
              : `the server ${fetchFor.siteSlug} runs on`
          }
          onClose={() => setFetchFor(null)}
          onConfirm={(destinationId) => {
            setActionError(null);
            run.mutate({ path: `/api/backups/${fetchFor.id}/fetch`, body: { destinationId } });
            setFetchFor(null);
          }}
        />
      )}
      {bulkOpen && bulkCount > 0 && (
        <BulkDelete
          ids={[...selected]}
          snapshot={snapshot}
          allFetched={wholeSnapshot}
          // Everything the filters match now - not only at Select all: a backup taken since means
          // the site is not left with none.
          everything={selected.size === total && (snapshot ? wholeSnapshot : total === items.length)}
          items={items}
          filters={filters}
          deletedSites={deletedSites}
          onClose={() => setBulkOpen(false)}
          onConfirm={(ids) => {
            setActionError(null);
            run.mutate(
              { path: '/api/backups/bulk-delete', body: { ids } },
              {
                onSuccess: () => {
                  clearSelection();
                  // Now, not when the job ends: the rows it has yet to reach say so meanwhile.
                  refresh();
                },
              },
            );
          }}
        />
      )}
      {deleteTarget && (
        <DeleteBackupDialog
          backup={deleteTarget}
          {...deletedSiteSafeguard(deleteTarget, deletedSites)}
          onClose={() => setDeleteId(null)}
          onDone={() => refresh(deleteTarget.siteSlug)}
          onError={setActionError}
        />
      )}
    </div>
  );
}

/**
 * The bulk delete's dialog. It deletes exactly the ids selected - ticked here, or fetched by
 * "Select all" - and says what they are from what is known of each: the row on this page, or
 * what Select all was told about the ones elsewhere.
 */
function BulkDelete({
  ids,
  snapshot,
  allFetched,
  everything,
  items,
  filters,
  deletedSites,
  onConfirm,
  onClose,
}: {
  ids: number[];
  snapshot: Map<number, BackupIdsDto['items'][number]> | null;
  /** The selection is still exactly what Select all fetched. */
  allFetched: boolean;
  /** The selection is every backup the filters match, as the list reads now. */
  everything: boolean;
  items: BackupListItemDto[];
  filters: BackupFilters;
  deletedSites: { slug: string; complete: number }[];
  onConfirm: (ids: number[]) => void;
  onClose: () => void;
}) {
  const onPage = new Map(items.map((b) => [b.id, b]));
  const known = ids.map((id) => snapshot?.get(id) ?? onPage.get(id)).filter((b) => b !== undefined);
  const completeCopies = (b: BackupListItemDto) => b.copies.filter((c) => c.status === 'complete');
  const remote = snapshot
    ? {
        copies: ids.reduce((n, id) => {
          const b = snapshot.get(id) ?? onPage.get(id);
          return n + (b === undefined ? 0 : 'remoteCopies' in b ? b.remoteCopies : completeCopies(b).length);
        }, 0),
        destinations: null,
      }
    : (() => {
        const copies = ids.flatMap((id) => (onPage.has(id) ? completeCopies(onPage.get(id)!) : []));
        return { copies: copies.length, destinations: [...new Set(copies.map((c) => c.destinationName))] };
      })();
  // A site that still exists has no summary to count against; "every backup of it" is known
  // only from the filters, when the selection is all of what they match.
  const wholeSite =
    everything && siteOnly(filters) && !deletedSites.some((d) => d.slug === filters.siteSlug) ? filters.siteSlug : null;
  const guard = bulkDeleteSafeguard(known, deletedSites, wholeSite);
  const n = ids.length;
  return (
    <BulkDeleteBackupsDialog
      title={
        allFetched
          ? `Delete all ${n.toLocaleString()} backups ${matchingPhrase(filters)}`
          : `Delete ${n.toLocaleString()} ${n === 1 ? 'backup' : 'backups'}`
      }
      remote={remote}
      warning={guard.warning}
      confirmWord={guard.confirmWord}
      onClose={onClose}
      onConfirm={() => onConfirm(ids)}
    />
  );
}

/** Whose backup: a site that exists links to its Backups tab; a deleted one says so. */
function SiteCell({ backup: b }: { backup: BackupListItemDto }) {
  if (b.type === 'panel') return <span className="font-medium">Panel database</span>;
  if (b.siteDeleted) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{b.siteSlug}</span>
        <span className="rounded-full bg-neutral-200 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
          deleted
        </span>
      </span>
    );
  }
  return (
    <Link
      to={`/sites/${b.siteSlug}?tab=backups`}
      className="font-medium hover:underline"
      title={b.siteTitle && b.siteTitle !== b.siteSlug ? b.siteTitle : undefined}
    >
      {b.siteSlug}
    </Link>
  );
}
