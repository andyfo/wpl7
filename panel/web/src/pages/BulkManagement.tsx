import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { BatchDto, JobDto, WpInventoryRow } from '../../../shared/types';
import type { WpBulkAction, WpComponentKind, WpInventoryFilter } from '../../../shared/schemas';
import { api, ApiError } from '../api/client';
import { useBatch, useBatches, useDebounced, useMeta, useWpInventory } from '../api/hooks';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  inputClass,
  JobStatusBadge,
  Spinner,
  StatTile,
  StatusBadge,
  Toggle,
} from '../components/ui';
import {
  allowedActions,
  filtersForKind,
  reconcileSelection,
  targetKey,
  targetsForSites,
  visibleRows,
  visibleTargets,
  type Target,
} from './bulkSelection';
import { BulkRunOptions, type BulkRunOptionsValue } from '../components/wp/BulkRunOptions';
import { FeedFooter } from '../components/wp/FeedFooter';
import { CoverageNote, SeverityBadge } from '../components/wp/severity';
import { VulnerabilityList } from '../components/wp/VulnerabilityList';
import { timeAgo } from '../lib/format';

const KINDS: { id: WpComponentKind; label: string }[] = [
  { id: 'plugin', label: 'Plugins' },
  { id: 'theme', label: 'Themes' },
  { id: 'core', label: 'WordPress core' },
];

const FILTERS: { id: WpInventoryFilter; label: string; hint: string }[] = [
  { id: 'updates', label: 'Has update', hint: 'An update is available on that site.' },
  { id: 'vulnerable', label: 'Vulnerable', hint: 'Matches a known advisory, or the plugin is closed on wordpress.org.' },
  { id: 'inactive', label: 'Inactive', hint: 'Installed but switched off — still a file on disk that can be exploited.' },
  { id: 'closed', label: 'Closed on wp.org', hint: 'Removed from the directory, so it will never be fixed.' },
];

const ACTION_LABELS: Record<WpBulkAction, string> = {
  update: 'Update',
  activate: 'Activate',
  deactivate: 'Deactivate',
  delete: 'Delete',
  'core-update': 'Update WordPress',
};

export function BulkManagement() {
  const [params, setParams] = useSearchParams();
  const meta = useMeta();
  const qc = useQueryClient();
  const [kind, setKind] = useState<WpComponentKind>((params.get('kind') as WpComponentKind) ?? 'plugin');
  const [filters, setFilters] = useState<WpInventoryFilter[]>(
    (params.get('filter')?.split(',').filter(Boolean) as WpInventoryFilter[]) ?? [],
  );
  const [search, setSearch] = useState('');
  const [serverId, setServerId] = useState<number | 'all'>('all');
  const [includeStopped, setIncludeStopped] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Map<string, Target>>(new Map());
  const [runOptions, setRunOptions] = useState<BulkRunOptionsValue>({ backupFirst: true, healthCheck: true });
  const [pendingAction, setPendingAction] = useState<WpBulkAction | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [batchId, setBatchId] = useState<number | null>(null);
  /** What the batch on screen was actually asked to do, so "retry skipped" can repeat it. */
  const [submitted, setSubmitted] = useState<{ batchId: number; targets: Target[] } | null>(null);
  const [scanning, setScanning] = useState(false);

  const q = useDebounced(search.trim(), 300);
  const inventory = useWpInventory({
    kind,
    filter: filters,
    q: q || undefined,
    serverId: serverId === 'all' ? undefined : serverId,
    includeStopped,
  });
  const batch = useBatch(batchId);
  const batches = useBatches();
  const multiServer = meta.data?.multiServer ?? false;
  const rows = inventory.data?.rows ?? [];

  /** Every selectable row currently on screen, keyed the way the selection is. */
  const visible = useMemo(() => visibleRows(rows), [rows]);

  /**
   * Keep the selection inside what is on screen.
   *
   * The action bar only ever reasoned about visible rows, so a selected row hidden by a
   * later search or by a refresh that dropped it would have travelled invisibly into the
   * next Delete. Anything no longer listed is dropped from the selection instead.
   */
  useEffect(() => {
    setSelected((prev) => reconcileSelection(prev, visible));
  }, [visible]);

  const selectedRows = useMemo(
    () =>
      [...selected.keys()]
        .map((key) => visible.get(key))
        .filter((v) => v !== undefined)
        .map((v) => ({ kind: v!.kind, row: v!.row })),
    [selected, visible],
  );
  const actions = allowedActions(selectedRows);
  const selectedSites = new Set([...selected.values()].map((t) => t.siteSlug));

  const setFilterChip = (id: WpInventoryFilter, on: boolean) => {
    const next = on ? [...new Set([...filters, id])] : filters.filter((f) => f !== id);
    setFilters(next);
    const p = new URLSearchParams(params);
    if (next.length > 0) p.set('filter', next.join(','));
    else p.delete('filter');
    setParams(p, { replace: true });
    // A row that scrolls out of the filter must not stay selected and silently join the
    // next action: the selection means "these ones", not "whatever matched at the time".
    setSelected(new Map());
  };

  const toggleTarget = (target: Target, on: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (on) next.set(targetKey(target), target);
      else next.delete(targetKey(target));
      return next;
    });
  };

  /** The aggregate checkbox selects exactly the per-site rows the filter is showing. */
  const toggleGroup = (group: WpInventoryRow, on: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const siteRow of group.siteRows) {
        const target = { siteSlug: siteRow.siteSlug, kind: group.kind, slug: group.slug };
        if (on) next.set(targetKey(target), target);
        else next.delete(targetKey(target));
      }
      return next;
    });
  };

  const groupState = (group: WpInventoryRow): 'none' | 'some' | 'all' => {
    const keys = group.siteRows.map((r) => targetKey({ siteSlug: r.siteSlug, kind: group.kind, slug: group.slug }));
    const hits = keys.filter((k) => selected.has(k)).length;
    return hits === 0 ? 'none' : hits === keys.length ? 'all' : 'some';
  };

  const runBatch = async (action: WpBulkAction) => {
    setError(null);
    try {
      // Belt and braces on top of the reconciliation effect: what runs is what the table
      // was showing when the button was pressed, never a leftover from an earlier filter.
      const targets = visibleTargets(selected, visible);
      if (targets.length === 0) throw new Error('Nothing selected is still on screen; make a selection again.');
      const res = await api<{ batch: BatchDto }>('/api/wp/bulk', {
        method: 'POST',
        body: {
          action,
          targets: targets.map((t) => ({
            siteSlug: t.siteSlug,
            kind: t.kind,
            ...(t.kind === 'core' ? {} : { slug: t.slug }),
          })),
          backupFirst: runOptions.backupFirst,
          healthCheck: runOptions.healthCheck,
        },
      });
      setBatchId(res.batch.id);
      setSubmitted({ batchId: res.batch.id, targets });
      setSelected(new Map());
      await qc.invalidateQueries({ queryKey: ['wp-batches'] });
    } catch (err) {
      setError(err);
    }
  };

  const rescanAll = async () => {
    setScanning(true);
    setError(null);
    try {
      await api('/api/wp/scan', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['wp-inventory'] });
    } catch (err) {
      setError(err);
    } finally {
      setScanning(false);
    }
  };

  const fleet = inventory.data?.fleet;
  const scanJob = inventory.data?.scanJob ?? null;
  const scanActive = scanJob && (scanJob.status === 'queued' || scanJob.status === 'running');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Bulk management</h1>
          <p className="text-sm text-neutral-500">
            Every plugin, theme and WordPress version across the fleet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {scanActive ? (
            <span className="text-xs text-neutral-500">
              scan {scanJob.status} ·{' '}
              <Link to={`/jobs/${scanJob.id}`} className="underline">
                job #{scanJob.id}
              </Link>
            </span>
          ) : (
            scanJob && (
              <span className="text-xs text-neutral-400">
                last scan {timeAgo(scanJob.finishedAt ?? scanJob.createdAt)}
                {scanJob.status === 'failed' && ' (failed)'}
              </span>
            )
          )}
          <Button variant="secondary" disabled={scanning || !!scanActive} onClick={() => void rescanAll()}>
            {scanActive ? 'Scanning…' : 'Rescan all'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Sites scanned"
          value={fleet ? `${fleet.scanned}/${fleet.sites}` : '…'}
          sub={
            fleet && fleet.neverScanned > 0
              ? `${fleet.neverScanned} never scanned`
              : fleet?.lastScanAt
                ? `newest ${timeAgo(fleet.lastScanAt)}`
                : undefined
          }
        />
        <StatTile label="With updates" value={fleet?.sitesWithUpdates ?? '…'} sub="sites needing at least one" />
        <StatTile label="Vulnerable" value={fleet?.sitesVulnerable ?? '…'} sub="sites with a known advisory" />
        <StatTile label="Core outdated" value={fleet?.coreOutdated ?? '…'} sub="sites behind on WordPress" />
      </div>

      <ErrorNote error={error} />
      {error instanceof ApiError && Array.isArray(error.details) && (
        <ul className="rounded-lg bg-red-50 px-4 py-2 text-xs text-red-700">
          {(error.details as string[]).map((line) => (
            <li key={line}>• {line}</li>
          ))}
        </ul>
      )}

      {batchId !== null && batch.data && (
        <BatchProgress
          batch={batch.data.batch}
          jobs={batch.data.jobs}
          onClose={() => setBatchId(null)}
          // Only offered for a run started in this browser session: without the original
          // target list there is nothing honest to reselect (see onRetrySkipped).
          onRetrySkipped={
            submitted?.batchId === batch.data.batch.id
              ? (slugs) => {
                  // Exactly what was asked for on those sites - not everything the table
                  // happens to show for them now, which would quietly widen a delete.
                  setSelected(targetsForSites(submitted.targets, slugs));
                  setBatchId(null);
                }
              : undefined
          }
        />
      )}

      <Card>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => {
                  setKind(k.id);
                  setSelected(new Map());
                  // "Inactive" and "Closed on wp.org" mean nothing for core, and their chips
                  // are disabled here - carrying them over would filter every row away with
                  // no control left to undo it.
                  const kept = filtersForKind(k.id, filters);
                  setFilters(kept);
                  const p = new URLSearchParams(params);
                  p.set('kind', k.id);
                  if (kept.length > 0) p.set('filter', kept.join(','));
                  else p.delete('filter');
                  setParams(p, { replace: true });
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  kind === k.id ? 'button-primary' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => {
              const on = filters.includes(f.id);
              const disabled = kind === 'core' && (f.id === 'inactive' || f.id === 'closed');
              return (
                <button
                  key={f.id}
                  title={disabled ? 'Does not apply to WordPress core.' : f.hint}
                  disabled={disabled}
                  onClick={() => setFilterChip(f.id, !on)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    on
                      ? 'border-neutral-900 button-primary'
                      : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
            <input
              className={`${inputClass} ml-auto w-56`}
              placeholder="Search name or slug…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {multiServer && (
              <select
                className={`${inputClass} w-auto`}
                value={serverId}
                onChange={(e) => {
                  setServerId(e.target.value === 'all' ? 'all' : Number(e.target.value));
                  setSelected(new Map());
                }}
              >
                <option value="all">All servers</option>
                {(meta.data?.servers ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <Toggle
            checked={includeStopped}
            onChange={(v) => {
              setIncludeStopped(v);
              setSelected(new Map());
            }}
            label="Include stopped sites"
          />
        </div>
      </Card>

      <Card>
        {inventory.isLoading && !inventory.data ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState>
            {fleet && fleet.scanned === 0
              ? 'No site has been scanned yet — run “Rescan all”.'
              : 'Nothing matches these filters.'}
          </EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="w-8 pb-2" />
                <th className="pb-2">{kind === 'core' ? 'Version' : 'Component'}</th>
                <th className="pb-2 pr-3 text-right">Sites</th>
                <th className="pb-2 pr-3 text-right">Updates</th>
                <th className="pb-2 pr-3 text-right">Vulnerable</th>
                <th className="pb-2">Versions</th>
                <th className="w-8 pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((group) => {
                const key = `${group.kind}:${group.slug}`;
                const state = groupState(group);
                const open = expanded.has(key);
                return (
                  // Fragment, keyed: an aggregate row and its expanded per-site table are
                  // two siblings of one <tbody>, and React keys the array element.
                  <Fragment key={key}>
                    <tr className="border-t border-neutral-100">
                      <td className="py-2">
                        <input
                          type="checkbox"
                          checked={state === 'all'}
                          ref={(el) => {
                            if (el) el.indeterminate = state === 'some';
                          }}
                          onChange={(e) => toggleGroup(group, e.target.checked)}
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <button
                            className="font-medium hover:underline"
                            onClick={() =>
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              })
                            }
                          >
                            {group.title}
                          </button>
                          {group.kind !== 'core' && (
                            <span className="font-mono text-xs text-neutral-400">{group.slug}</span>
                          )}
                          {group.worstSeverity && <SeverityBadge severity={group.worstSeverity} />}
                          {group.closedOnWporg && (
                            <span
                              title={`Closed on wordpress.org${group.closedReason ? ` (${group.closedReason.replace(/-/g, ' ')})` : ''}`}
                              className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-red-800"
                            >
                              closed
                            </span>
                          )}
                          <CoverageNote coverage={group.feedCoverage} />
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-neutral-600">{group.sites}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {group.updates > 0 ? (
                          <span className="font-medium text-amber-600">{group.updates}</span>
                        ) : (
                          <span className="text-neutral-300">–</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {group.vulnerable > 0 ? (
                          <span className="font-medium text-red-700">{group.vulnerable}</span>
                        ) : (
                          <span className="text-neutral-300">–</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs text-neutral-500">
                        {group.versions.length > 2
                          ? `${group.versions[0]} – ${group.versions[group.versions.length - 1]} (${group.versions.length})`
                          : group.versions.join(', ')}
                        {group.updateVersion && <span className="ml-1 text-amber-600">→ {group.updateVersion}</span>}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          small
                          variant="ghost"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        >
                          {open ? '▾' : '▸'}
                        </Button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-neutral-50/60">
                        <td />
                        <td colSpan={6} className="py-2 pr-3">
                          <table className="w-full text-xs">
                            <tbody>
                              {group.siteRows.map((siteRow) => {
                                const target = {
                                  siteSlug: siteRow.siteSlug,
                                  kind: group.kind,
                                  slug: group.slug,
                                };
                                return (
                                  <tr key={siteRow.siteSlug} className="border-t border-neutral-200/70">
                                    <td className="w-8 py-1.5">
                                      <input
                                        type="checkbox"
                                        checked={selected.has(targetKey(target))}
                                        onChange={(e) => toggleTarget(target, e.target.checked)}
                                      />
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      <Link to={`/sites/${siteRow.siteSlug}`} className="font-medium hover:underline">
                                        {siteRow.siteTitle}
                                      </Link>
                                      {multiServer && (
                                        <span className="ml-2 text-neutral-400">{siteRow.serverName}</span>
                                      )}
                                      {siteRow.siteStatus !== 'running' && (
                                        <span className="ml-2">
                                          <StatusBadge status={siteRow.siteStatus} />
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap">
                                      {siteRow.version}
                                      {siteRow.updateVersion && siteRow.updateState === 'available' && (
                                        <span className="ml-1 font-medium text-amber-600">
                                          → {siteRow.updateVersion}
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      {group.kind !== 'core' && <StatusBadge status={siteRow.status} />}
                                    </td>
                                    <td className="py-1.5">
                                      {siteRow.worstSeverity && <SeverityBadge severity={siteRow.worstSeverity} />}
                                      {siteRow.vulnerabilities.length > 0 && (
                                        <div className="mt-1">
                                          <VulnerabilityList items={siteRow.vulnerabilities} />
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {inventory.data && (
          <div className="mt-4 border-t border-neutral-100 pt-3">
            <FeedFooter enabled={inventory.data.feed.enabled} refreshedAt={inventory.data.feed.refreshedAt} />
          </div>
        )}
      </Card>

      {(batches.data ?? []).length > 0 && (
        <Card title="Recent bulk runs">
          <table className="w-full text-sm">
            <tbody>
              {(batches.data ?? []).map((b) => (
                <tr key={b.id} className="border-t border-neutral-100">
                  <td className="py-2 pr-3 text-xs text-neutral-400">#{b.id}</td>
                  <td className="py-2 pr-3 font-medium">{ACTION_LABELS[b.action] ?? b.action}</td>
                  <td className="py-2 pr-3 text-xs text-neutral-500">
                    {b.targets} item{b.targets === 1 ? '' : 's'} · {b.totalJobs} site
                    {b.totalJobs === 1 ? '' : 's'}
                    {b.skipped.length > 0 && ` · ${b.skipped.length} skipped`}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    <span className="text-emerald-700">{b.counts.succeeded} ok</span>
                    {b.counts.failed > 0 && <span className="ml-2 text-red-700">{b.counts.failed} failed</span>}
                    {b.counts.queued + b.counts.running > 0 && (
                      <span className="ml-2 text-amber-700">{b.counts.queued + b.counts.running} pending</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right text-xs text-neutral-500">{timeAgo(b.createdAt)}</td>
                  <td className="py-2 text-right">
                    <Button small variant="ghost" onClick={() => setBatchId(b.id)}>
                      Show
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Sticky action bar: appears only with a selection, and offers only what every
          selected row will accept - the server enforces the same rules. */}
      {selected.size > 0 && (
        <div className="sticky bottom-4 z-20 rounded-xl border border-neutral-300 bg-surface p-4 shadow-lg">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">
              {selected.size} item{selected.size === 1 ? '' : 's'} on {selectedSites.size} site
              {selectedSites.size === 1 ? '' : 's'}
            </span>
            <Button small variant="ghost" onClick={() => setSelected(new Map())}>
              Clear
            </Button>
            <span className="ml-auto flex flex-wrap gap-2">
              {(['update', 'core-update', 'activate', 'deactivate', 'delete'] as WpBulkAction[])
                .filter((a) => actions.has(a))
                .map((action) => (
                  <Button
                    key={action}
                    small
                    variant={action === 'delete' ? 'danger' : action === 'update' || action === 'core-update' ? 'primary' : 'secondary'}
                    onClick={() => setPendingAction(action)}
                  >
                    {ACTION_LABELS[action]}
                  </Button>
                ))}
            </span>
          </div>
          {actions.size === 0 && (
            <p className="mt-2 text-xs text-neutral-500">
              No single action applies to everything selected. Narrow the selection with the filter chips.
            </p>
          )}
        </div>
      )}

      {pendingAction && (
        <ConfirmDialog
          title={`${ACTION_LABELS[pendingAction]} ${selected.size} item${selected.size === 1 ? '' : 's'}`}
          message={
            <>
              One job per site, {selectedSites.size} in total. A site already busy with another job is
              reported as skipped.
            </>
          }
          confirmWord={pendingAction === 'delete' ? 'delete' : undefined}
          confirmLabel={`${ACTION_LABELS[pendingAction]} now`}
          onClose={() => setPendingAction(null)}
          onConfirm={() => void runBatch(pendingAction)}
        >
          <BulkRunOptions value={runOptions} onChange={setRunOptions} />
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Per-site progress of one bulk run, plus what it could not include. */
function BatchProgress({
  batch,
  jobs,
  onClose,
  onRetrySkipped,
}: {
  batch: BatchDto;
  jobs: JobDto[];
  onClose: () => void;
  onRetrySkipped?: (siteSlugs: string[]) => void;
}) {
  const qc = useQueryClient();
  const done = jobs.length > 0 && jobs.every((j) => ['succeeded', 'failed', 'canceled'].includes(j.status));
  return (
    <Card
      title={`Bulk run #${batch.id} — ${ACTION_LABELS[batch.action] ?? batch.action}`}
      action={
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span>
            {batch.counts.succeeded}/{batch.totalJobs} done
            {batch.counts.failed > 0 && ` · ${batch.counts.failed} failed`}
          </span>
          <Button small variant="ghost" onClick={onClose}>
            hide
          </Button>
        </div>
      }
    >
      {jobs.length === 0 ? (
        <EmptyState>No jobs were queued for this run.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {jobs.map((job) => {
              const ops = Array.isArray(job.result?.ops) ? (job.result!.ops as { ok: boolean }[]) : [];
              const failed = ops.filter((o) => !o.ok).length;
              return (
                <tr key={job.id} className="border-t border-neutral-100 align-top">
                  <td className="py-2 pr-3 font-medium">{job.siteSlug}</td>
                  <td className="py-2 pr-3">
                    <JobStatusBadge status={job.status} stopping={job.cancelRequested} />
                  </td>
                  <td className="py-2 pr-3 text-xs text-neutral-500">
                    {ops.length > 0 && `${ops.length - failed}/${ops.length} operations ok`}
                    {job.error && <div className="text-red-700">{job.error}</div>}
                    {typeof job.result?.backupId === 'number' && (
                      <div>
                        pre-update backup #{String(job.result.backupId)} —{' '}
                        <Link to={`/sites/${job.siteSlug}`} className="underline">
                          Backups tab
                        </Link>
                      </div>
                    )}
                  </td>
                  <td className="py-2 text-right text-xs">
                    <Link to={`/jobs/${job.id}`} className="text-neutral-500 underline">
                      log
                    </Link>
                    {job.status === 'queued' && (
                      <Button
                        small
                        variant="ghost"
                        onClick={() =>
                          void api(`/api/jobs/${job.id}/cancel`, { method: 'POST' })
                            .catch(() => undefined)
                            .then(() => qc.invalidateQueries({ queryKey: ['wp-batch', batch.id] }))
                        }
                      >
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {batch.skipped.length > 0 && (
        <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <div className="font-medium">{batch.skipped.length} site(s) skipped — another job held their turn:</div>
          <ul className="mt-1 space-y-0.5">
            {batch.skipped.map((s) => (
              <li key={s.siteSlug}>
                <b>{s.siteSlug}</b>: {s.reason}
              </li>
            ))}
          </ul>
          {done && onRetrySkipped && (
            <div className="mt-2">
              <Button small variant="secondary" onClick={() => onRetrySkipped(batch.skipped.map((s) => s.siteSlug))}>
                Reselect skipped sites
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
