// @docs databases/overview
import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { DatabaseListItemDto } from '../../../shared/types';
import { dbExportUrl, scanDatabases, useDatabaseList } from '../api/databases';
import { useMeta, useRunJob, useSites } from '../api/hooks';
import { formatBytes, timeAgo } from '../lib/format';
import { Button, Card, ConfirmDialog, EmptyState, ErrorNote, Spinner, compactInputClass, inputClass } from '../components/ui';
import { AddDatabaseDialog } from '../components/database/DatabaseDialogs';

/**
 * Every database on every server, with the site each belongs to and how big it is - as the last
 * read of each server found them - and the ones no site uses, which can be deleted here.
 */
export function Databases() {
  const list = useDatabaseList();
  const sites = useSites();
  const meta = useMeta();
  const qc = useQueryClient();
  const run = useRunJob([['databases']]);
  const [query, setQuery] = useState('');
  const [server, setServer] = useState<number | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<DatabaseListItemDto | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<unknown>(null);
  const multiServer = meta.data?.multiServer ?? false;

  const refresh = async () => {
    setScanning(true);
    setScanError(null);
    try {
      qc.setQueryData(['databases'], await scanDatabases());
      void qc.invalidateQueries({ queryKey: ['site-databases'] });
    } catch (err) {
      setScanError(err);
    } finally {
      setScanning(false);
    }
  };

  const items = (list.data?.databases ?? []).filter(
    (d) =>
      (server === 'all' || d.serverId === server) &&
      (query.trim() === '' ||
        [d.name, 'slug' in d.use ? d.use.slug : '', 'title' in d.use ? d.use.title : ''].some((s) =>
          s.toLowerCase().includes(query.trim().toLowerCase()),
        )),
  );
  const used = items.filter((d) => d.use.kind !== 'unused');
  const unused = items.filter((d) => d.use.kind === 'unused');
  const scans = list.data?.servers ?? [];
  const failed = scans.filter((s) => s.error);
  const oldest = scans.reduce<number | null>((min, s) => (s.scannedAt && (min === null || s.scannedAt < min) ? s.scannedAt : min), null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="page-title">Databases</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void refresh()} busy={scanning}>
            Refresh
          </Button>
          <Button onClick={() => setAdding(true)} disabled={!sites.data?.length} title={sites.data?.length ? undefined : 'There is no site to add one to'}>
            Add database
          </Button>
        </div>
      </div>
      <ErrorNote error={list.error ?? scanError ?? run.error} />
      {failed.map((s) => (
        <div key={s.id} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {s.name}: its databases could not be read ({s.error}).
        </div>
      ))}

      {!list.data ? (
        <Spinner />
      ) : (
        <Card>
          <div className="mb-3 flex flex-wrap gap-2">
            <input
              className={`${inputClass} max-w-xs`}
              placeholder="Search databases and sites"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {multiServer && (
              <select
                className={compactInputClass}
                value={String(server)}
                aria-label="Server"
                onChange={(e) => setServer(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              >
                <option value="all">All servers</option>
                {scans.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {used.length === 0 ? (
            <EmptyState>{query || server !== 'all' ? 'Nothing matches.' : 'No databases yet.'}</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                    <th className="pb-2">Database</th>
                    <th className="pb-2">Site</th>
                    {multiServer && <th className="pb-2">Server</th>}
                    <th className="pb-2 text-right">Size</th>
                    <th className="pb-2 text-right">Tables</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {used.map((d) => (
                    <UsedRow key={`${d.serverId}/${d.name}`} d={d} multiServer={multiServer} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-neutral-500">{oldest ? `Sizes from ${timeAgo(oldest)}.` : 'Sizes not read yet.'}</p>
        </Card>
      )}

      {unused.length > 0 && (
        <Card title="Not used by any site">
          <p className="mb-3 text-xs text-neutral-500">Left behind by a deleted or moved site, or made by hand.</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">Database</th>
                {multiServer && <th className="pb-2">Server</th>}
                <th className="pb-2 text-right">Size</th>
                <th className="pb-2 text-right">Tables</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {unused.map((d) => (
                <tr key={`${d.serverId}/${d.name}`} className="border-t border-neutral-100">
                  <td className="py-2 pr-3 font-mono">{d.name}</td>
                  {multiServer && <td className="py-2 pr-3 text-neutral-600">{d.serverName}</td>}
                  <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">{formatBytes(d.size?.bytes)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">{d.size?.tables ?? '–'}</td>
                  <td className="py-2 text-right">
                    <Button small variant="danger" busy={run.busy(`delete:${d.serverId}/${d.name}`)} onClick={() => setDeleting(d)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {adding && <AddDatabaseDialog sites={sites.data ?? []} onClose={() => setAdding(false)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}`}
          message={
            <>
              Deletes <b>{deleting.name}</b>
              {multiServer ? ` from ${deleting.serverName}` : ''} and everything in it. No site uses it, and no backup has it.
            </>
          }
          confirmWord={deleting.name}
          confirmLabel="Delete database"
          onConfirm={() =>
            run.mutate({
              path: `/api/databases/${deleting.serverId}/${encodeURIComponent(deleting.name)}`,
              method: 'DELETE',
              action: `delete:${deleting.serverId}/${deleting.name}`,
            })
          }
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function UsedRow({ d, multiServer }: { d: DatabaseListItemDto; multiServer: boolean }) {
  const site = d.use.kind === 'site' || d.use.kind === 'extra' ? d.use : null;
  const browse = site
    ? `/sites/${site.slug}?tab=database${d.use.kind === 'extra' ? `&db=${encodeURIComponent(d.name)}` : ''}`
    : null;
  return (
    <tr className="border-t border-neutral-100">
      <td className="py-2 pr-3">
        {browse && !d.missing ? (
          <Link to={browse} className="font-mono hover:underline">
            {d.name}
          </Link>
        ) : (
          <span className="font-mono">{d.name}</span>
        )}
        {d.missing && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">Missing</span>}
        {d.use.kind === 'moveCopy' && (
          <span className="ml-2 rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-semibold text-neutral-700">Old copy (move)</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {site ? (
          <Link to={`/sites/${site.slug}`} className="hover:underline">
            {site.title}
          </Link>
        ) : d.use.kind === 'moveCopy' ? (
          <span className="text-neutral-500">{d.use.slug}</span>
        ) : null}
        {d.use.kind === 'site' && <span className="ml-2 text-xs text-neutral-400">WordPress</span>}
      </td>
      {multiServer && <td className="py-2 pr-3 text-neutral-600">{d.serverName}</td>}
      <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">{d.size ? formatBytes(d.size.bytes) : '–'}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">{d.size?.tables ?? '–'}</td>
      <td className="whitespace-nowrap py-2 text-right">
        {site && !d.missing && (
          <a className="px-1.5 text-xs font-medium text-neutral-600 hover:underline" href={dbExportUrl(site.slug, d.name)} download title="Download a dump (.sql.gz)">
            Export
          </a>
        )}
      </td>
    </tr>
  );
}
