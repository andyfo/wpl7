// @docs backups/delete-old
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MAX_BACKUP_KEEP_DAYS, MAX_BULK_BACKUP_DELETE, type BackupType } from '../../../../shared/schemas';
import type { BackupIdsDto } from '../../../../shared/types';
import { api } from '../../api/client';
import { useDebounced } from '../../api/hooks';
import {
  purgeParams,
  purgeProblem,
  purgeSafeguard,
  SITE_BACKUP_KINDS,
  type PurgeCriteria,
  type PurgeScope,
} from '../../lib/backupFilters';
import { formatBytes } from '../../lib/format';
import { Button, compactInputClass, Field, inputClass, Modal, Spinner, Toggle, ErrorNote } from '../ui';

const SCOPES: { id: PurgeScope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'sites', label: 'Chosen sites' },
  { id: 'deleted', label: 'Deleted sites' },
  { id: 'panel', label: "The panel's own database" },
];

/** A longer list of sites to choose from gets a box to filter it. */
const FILTER_FROM = 10;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * Delete old backups: whose, taken how long ago, of which kind - and what that comes to, before
 * anything is deleted. What it deletes is the ids the summary was counted from (GET
 * /api/backups/ids), handed to the bulk delete: a backup taken or a site deleted after the
 * summary was read does not change what goes.
 */
export function DeleteOldBackupsDialog({
  initial,
  sites,
  servers,
  onConfirm,
  onClose,
}: {
  initial: PurgeCriteria;
  /** The sites to choose from: the ones there are, and the deleted ones that still have backups. */
  sites: { slug: string; deleted: boolean }[];
  /** Offered as a choice with more than one. */
  servers: { id: number; name: string }[];
  /** `keepNewest` asks the deletion to check again, as it goes, that each site keeps its newest. */
  onConfirm: (ids: number[], keepNewest: boolean) => void;
  onClose: () => void;
}) {
  const [criteria, setCriteria] = useState(initial);
  const [daysText, setDaysText] = useState(String(initial.olderThanDays ?? 30));
  const [filter, setFilter] = useState('');
  const [typed, setTyped] = useState('');
  const set = (patch: Partial<PurgeCriteria>) => setCriteria((c) => ({ ...c, ...patch }));

  const problem = purgeProblem(criteria);
  const asked = useDebounced(criteria, 300);
  const askedKey = JSON.stringify(asked);
  const askable = purgeProblem(asked) === null;
  const preview = useQuery({
    queryKey: ['backup-purge', askedKey],
    // The ids it answers are what goes, whatever the criteria would match a minute later.
    queryFn: () => api<BackupIdsDto>(`/api/backups/ids?${new URLSearchParams(purgeParams(asked)!)}`),
    enabled: askable,
    refetchOnWindowFocus: false,
  });
  // What was typed was typed for what was on screen: other choices ask for it again.
  useEffect(() => setTyped(''), [askedKey]);

  const settled = problem === null && JSON.stringify(criteria) === askedKey && !preview.isFetching && preview.data !== undefined;
  const data = settled ? preview.data : undefined;
  const items = data?.items ?? [];
  const tooMany = data !== undefined && data.total > items.length;
  const guard = purgeSafeguard(data?.leavesNone ?? []);
  const armed = data !== undefined && items.length > 0 && !tooMany && typed === guard.confirmWord;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? sites.filter((s) => s.slug.includes(q)) : sites;
  }, [sites, filter]);
  const chosen = new Set(criteria.sites);
  const choose = (slug: string, on: boolean) =>
    set({ sites: on ? [...criteria.sites, slug] : criteria.sites.filter((s) => s !== slug) });

  return (
    <Modal title="Delete old backups" onClose={onClose}>
      <div className="space-y-4 text-sm text-neutral-700">
        <fieldset>
          <legend className="mb-1.5 font-medium">Whose</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {SCOPES.map((scope) => (
              <label key={scope.id} className="flex items-center gap-2">
                <input type="radio" name="purge-scope" checked={criteria.scope === scope.id} onChange={() => set({ scope: scope.id })} />
                {scope.label}
              </label>
            ))}
          </div>
          {criteria.scope === 'sites' && (
            <div className="mt-2 space-y-2">
              {sites.length > FILTER_FROM && (
                <input
                  className={`${compactInputClass} w-full`}
                  placeholder="Filter sites"
                  aria-label="Filter sites"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              <div className="max-h-44 overflow-y-auto rounded-lg border border-neutral-200 px-3 py-2">
                {shown.length === 0 ? (
                  <span className="text-xs text-neutral-500">No site matches.</span>
                ) : (
                  shown.map((site) => (
                    <label key={site.slug} className="flex items-center gap-2 py-0.5">
                      <input type="checkbox" checked={chosen.has(site.slug)} onChange={(e) => choose(site.slug, e.target.checked)} />
                      {site.slug}
                      {site.deleted && (
                        <span className="rounded-full bg-neutral-200 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
                          deleted
                        </span>
                      )}
                    </label>
                  ))
                )}
              </div>
              <span className="block text-xs text-neutral-500">{plural(criteria.sites.length, 'site')} chosen</span>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 font-medium">Taken</legend>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="purge-age"
                checked={criteria.olderThanDays !== null}
                onChange={() => set({ olderThanDays: Number(daysText) })}
              />
              More than
              <input
                type="number"
                className={`${compactInputClass} w-20`}
                aria-label="Days"
                min={1}
                max={MAX_BACKUP_KEEP_DAYS}
                value={daysText}
                onChange={(e) => {
                  setDaysText(e.target.value);
                  // Left empty it is 0, which purgeProblem refuses.
                  set({ olderThanDays: Number(e.target.value) });
                }}
              />
              days ago
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="purge-age" checked={criteria.olderThanDays === null} onChange={() => set({ olderThanDays: null })} />
              Any time
            </label>
          </div>
        </fieldset>

        {servers.length > 1 && (
          <Field label="Server">
            <select
              className={inputClass}
              value={criteria.serverId ?? ''}
              onChange={(e) => set({ serverId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">All servers</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {criteria.scope !== 'panel' && (
          <Field label="Kind" width="sm">
            <select
              className={inputClass}
              value={criteria.kind ?? ''}
              onChange={(e) => set({ kind: (e.target.value || null) as BackupType | null })}
            >
              <option value="">All kinds</option>
              {SITE_BACKUP_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Toggle
          checked={criteria.keepNewest}
          onChange={(keepNewest) => set({ keepNewest })}
          label={criteria.scope === 'panel' ? 'Keep the newest one' : "Keep each site's newest backup"}
        />

        <div className="rounded-lg bg-neutral-50 px-3 py-2" aria-live="polite">
          {problem ? (
            <span className="text-neutral-500">{problem}</span>
          ) : preview.error ? (
            <ErrorNote error={preview.error} />
          ) : !data ? (
            <Spinner />
          ) : items.length === 0 ? (
            'No backups match.'
          ) : tooMany ? (
            <>
              These match {data.total.toLocaleString()} backups, and one deletion takes at most{' '}
              {MAX_BULK_BACKUP_DELETE.toLocaleString()}. Choose fewer sites, or older backups.
            </>
          ) : (
            <Summary items={items} />
          )}
          {data && !tooMany && guard.warning && <b className="mt-1 block">{guard.warning}</b>}
        </div>

        {data && items.length > 0 && !tooMany && (
          <Field label={`Type "${guard.confirmWord}" to confirm`}>
            <input className={inputClass} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!armed}
            onClick={() => {
              onConfirm(
                items.map((b) => b.id),
                criteria.keepNewest,
              );
              onClose();
            }}
          >
            {data && items.length > 0 && !tooMany ? `Delete ${plural(items.length, 'backup')}` : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** "312 backups of 14 sites, 45.2 GB. Their 40 remote copies are deleted too." */
function Summary({ items }: { items: BackupIdsDto['items'] }) {
  const slugs = new Set(items.map((b) => b.siteSlug));
  const panel = slugs.has('panel');
  const siteCount = slugs.size - (panel ? 1 : 0);
  const whose =
    siteCount === 0 ? "of the panel's own database" : `of ${plural(siteCount, 'site')}${panel ? ' and the panel' : ''}`;
  const size = items.reduce((n, b) => n + (b.sizeBytes ?? 0), 0);
  const remote = items.reduce((n, b) => n + b.remoteCopies, 0);
  return (
    <>
      {plural(items.length, 'backup')} {whose}, {formatBytes(size)}.
      {remote > 0 && ` Their ${plural(remote, 'remote copy', 'remote copies')} ${remote === 1 ? 'is' : 'are'} deleted too.`}
    </>
  );
}
