// @docs servers/overview
import { Link } from 'react-router';
import type { SiteSummary } from '../../../shared/types';
import { useJobs, useMeta, useMonitor, useOffsiteOverview, useSites } from '../api/hooks';
import { jobLabel } from '../../../shared/jobTypes';
import { Card, EmptyState, ErrorNote, JobStatusBadge, SiteHealthBadge, StatTile, StatusBadge } from '../components/ui';
import { Icon } from '../components/Icon';
import { ResourceCharts } from '../components/ResourceCharts';
import { formatBytes, timeAgo } from '../lib/format';
import { siteHealth } from '../lib/siteHealth';

export function Dashboard() {
  const monitor = useMonitor();
  const meta = useMeta();
  const sites = useSites();
  const jobs = useJobs({ limit: 5 });
  const offsite = useOffsiteOverview(meta.data?.offsiteConfigured ?? false);
  const byslug = new Map((monitor.data?.sites ?? []).map((s) => [s.slug, s]));
  const multiServer = meta.data?.multiServer ?? false;
  const serverRows = monitor.data?.servers ?? [];
  const reporting = serverRows.filter((s) => s.status === 'ok' && s.memTotal > 0);
  const diskReporting = serverRows.filter((s) => s.status === 'ok' && s.diskTotal > 0);
  const freeMemory = reporting.reduce((sum, s) => sum + Math.max(0, s.memTotal - s.memUsed), 0);
  const freeDisk = diskReporting.reduce((sum, s) => sum + Math.max(0, s.diskTotal - s.diskUsed), 0);
  // The monitor's copy of a site's probe is the fresher of the two (the sites list is a
  // snapshot taken when that query last ran), and both feed the same rule - so the tile
  // cannot claim a site is fine while its own row two cards below says it is offline.
  const healthOf = (site: SiteSummary) => siteHealth({ ...site, ...byslug.get(site.slug) });
  const health = (sites.data ?? []).map(healthOf);
  const online = health.filter((h) => h.tone === 'ok').length;
  const wrong = health.filter((h) => h.tone === 'bad').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 pb-2">
        <h1 className="page-title">Overview</h1>
        <Link
          className="button-primary inline-flex shrink-0 items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-medium"
          to="/sites/new"
        >
          <Icon name="plus" size={16} />
          New site
        </Link>
      </div>

      <ErrorNote error={monitor.error || sites.error} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile
          label="Total sites"
          value={sites.data?.length ?? '—'}
          sub={
            sites.data ? (
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${wrong > 0 ? 'bg-red-500' : 'bg-emerald-500'}`} />
                {online} online
                {wrong > 0 && ` · ${wrong} not serving`}
              </span>
            ) : (
              'Loading sites…'
            )
          }
        />
        <StatTile
          label="Connected servers"
          value={monitor.data ? serverRows.length.toString().padStart(2, '0') : '—'}
          sub={
            monitor.data
              ? `${serverRows.filter((s) => s.status === 'ok').length} healthy · ${serverRows.filter((s) => s.status !== 'ok').length} need attention`
              : 'Connecting…'
          }
        />
        <StatTile
          label="Available memory"
          value={reporting.length ? formatBytes(freeMemory) : '—'}
          sub={
            reporting.length
              ? `Across ${reporting.length} reporting ${reporting.length === 1 ? 'server' : 'servers'}`
              : 'Awaiting resource data'
          }
        />
        <StatTile
          label="Available storage"
          value={diskReporting.length ? formatBytes(freeDisk) : '—'}
          sub={
            diskReporting.length
              ? `Across ${diskReporting.length} reporting ${diskReporting.length === 1 ? 'server' : 'servers'}`
              : 'Awaiting resource data'
          }
        />
      </div>

      <ResourceCharts servers={serverRows} />

      <WordPressTile sites={sites.data ?? []} />

      {offsite.data && offsite.data.destinations.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-surface px-4 py-2.5 text-sm shadow-sm">
          <span className="font-medium text-neutral-700">Remote copies</span>
          <span className="text-neutral-500">
            {offsite.data.lastSuccessAt ? `last success ${timeAgo(offsite.data.lastSuccessAt)}` : 'none yet'}
            {offsite.data.last24h.completed > 0 && ` · ${offsite.data.last24h.completed} in the last 24h`}
            {offsite.data.last24h.pending > 0 && ` · ${offsite.data.last24h.pending} waiting`}
          </span>
          {offsite.data.last24h.failed > 0 && (
            <span className="font-medium text-red-700">{offsite.data.last24h.failed} failed</span>
          )}
          <Link className="ml-auto text-xs text-neutral-500 hover:underline" to="/backups/storage">
            destinations →
          </Link>
        </div>
      )}

      {multiServer && (
        <Card
          title="Server fleet"
          action={
            <Link className="action-link" to="/servers">
              Manage servers
              <Icon name="arrow" size={13} />
            </Link>
          }
        >
          <table className="dashboard-table w-full text-sm">
            <thead>
              <tr>
                <th>Server</th>
                <th>Status</th>
                <th>Load</th>
                <th>Memory used</th>
                <th>Storage used</th>
              </tr>
            </thead>
            <tbody>
              {serverRows.map((srv) => (
                <tr key={srv.serverId} className="border-b border-neutral-100 last:border-0">
                  <td className="pr-3 font-medium">{srv.name}</td>
                  <td className="pr-3">
                    <StatusBadge status={srv.status} />
                  </td>
                  <td className="pr-3 text-xs text-neutral-500">{srv.memTotal > 0 ? srv.load1.toFixed(2) : '—'}</td>
                  <td className="pr-3 text-xs text-neutral-500">
                    {srv.memTotal > 0 ? `${formatBytes(srv.memUsed)} / ${formatBytes(srv.memTotal)}` : '—'}
                  </td>
                  <td className="text-xs text-neutral-500">
                    {srv.diskTotal > 0 ? `${formatBytes(srv.diskUsed)} / ${formatBytes(srv.diskTotal)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card
        title={
          <span className="flex items-center gap-2">
            Your sites{' '}
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
              {sites.data?.length ?? '—'}
            </span>
          </span>
        }
        action={
          <Link className="action-link" to="/sites">
            View all sites
            <Icon name="arrow" size={13} />
          </Link>
        }
      >
        {sites.isPending ? (
          <EmptyState>Loading sites…</EmptyState>
        ) : sites.isError ? (
          <EmptyState>Sites are temporarily unavailable.</EmptyState>
        ) : (sites.data ?? []).length === 0 ? (
          <EmptyState>
            No sites yet.{' '}
            <Link className="underline" to="/sites/new">
              Create your first site
            </Link>
            .
          </EmptyState>
        ) : (
          <table className="dashboard-table w-full text-sm">
            <thead>
              <tr>
                <th>Site / domain</th>
                <th>Status</th>
                {multiServer && <th>Server</th>}
                <th>Runtime</th>
                <th>CPU</th>
                <th className="!text-right">Storage</th>
              </tr>
            </thead>
            <tbody>
              {(sites.data ?? []).map((site) => {
                const m = byslug.get(site.slug);
                return (
                  <tr key={site.slug} className="border-b border-neutral-100 last:border-0">
                    <td className="pr-4">
                      <div className="flex items-center gap-3">
                        <span className="site-monogram">{site.title.slice(0, 1).toUpperCase()}</span>
                        <div>
                          <Link to={`/sites/${site.slug}`} className="text-xs font-semibold hover:underline">
                            {site.title}
                          </Link>
                          <div className="mt-1 text-[11px] text-neutral-500">{site.primaryDomain}</div>
                        </div>
                      </div>
                    </td>
                    <td className="pr-3">
                      <SiteHealthBadge health={healthOf(site)} />
                    </td>
                    {multiServer && (
                      <td className="pr-3 text-xs text-neutral-500">{site.kind === 'external' ? 'External' : site.serverName}</td>
                    )}
                    <td className="pr-3 text-xs text-neutral-500">PHP {site.phpVersion}</td>
                    <td className="pr-3 text-xs text-neutral-500">
                      {m?.cpuPct != null ? `${m.cpuPct.toFixed(1)}%` : '—'}
                    </td>
                    <td className="text-right text-xs text-neutral-500">{formatBytes(site.diskBytes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Recent activity"
        action={
          <Link className="action-link" to="/jobs">
            All jobs
            <Icon name="arrow" size={13} />
          </Link>
        }
      >
        <ErrorNote error={jobs.error} />
        {jobs.isPending ? (
          <EmptyState>Loading activity…</EmptyState>
        ) : !jobs.isError && (jobs.data?.items ?? []).length === 0 ? (
          <EmptyState>No jobs yet.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {(jobs.data?.items ?? []).map((job) => (
                <tr key={job.id} className="border-b border-neutral-100 last:border-0">
                  <td className="py-3 pr-3 text-xs text-neutral-400">#{job.id}</td>
                  <td className="py-3 pr-3">
                    <Link to={`/jobs/${job.id}`} className="text-xs font-medium hover:underline">
                      {jobLabel(job.type)}
                    </Link>
                    {job.siteSlug && <span className="ml-2 text-[11px] text-neutral-500">{job.siteSlug}</span>}
                  </td>
                  <td className="py-3 pr-3">
                    <JobStatusBadge status={job.status} stopping={job.cancelRequested} />
                  </td>
                  <td className="whitespace-nowrap py-3 text-right text-[11px] text-neutral-500">
                    {timeAgo(job.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/**
 * One line on the WordPress state of the whole fleet, linking into the filter that shows
 * exactly the rows it is talking about. Hidden entirely until at least one site has been
 * scanned - an empty "0 updates" tile on a fresh install says nothing true.
 */
function WordPressTile({ sites }: { sites: SiteSummary[] }) {
  const scanned = sites.filter((s) => s.wp !== null);
  if (scanned.length === 0) return null;
  const updates = scanned.reduce((n, s) => n + (s.wp?.updates ?? 0), 0);
  const sitesWithUpdates = scanned.filter((s) => (s.wp?.updates ?? 0) > 0).length;
  const vulnerable = scanned.filter((s) => (s.wp?.vulnerable ?? 0) > 0).length;
  if (updates === 0 && vulnerable === 0) {
    return (
      <Card title="WordPress">
        <p className="text-sm text-neutral-600">
          Every scanned site is up to date.{' '}
          <Link to="/sites/bulk" className="underline">
            Bulk management
          </Link>
        </p>
      </Card>
    );
  }
  return (
    <Card title="WordPress">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <Link to="/sites/bulk?filter=updates" className="hover:underline">
          <b className="text-amber-600">{updates}</b> update{updates === 1 ? '' : 's'} on {sitesWithUpdates} site
          {sitesWithUpdates === 1 ? '' : 's'}
        </Link>
        {vulnerable > 0 && (
          <Link to="/sites/bulk?filter=vulnerable" className="hover:underline">
            <b className="text-red-700">{vulnerable}</b> site{vulnerable === 1 ? '' : 's'} with a known vulnerability
          </Link>
        )}
        <Link to="/sites/bulk" className="ml-auto text-xs text-neutral-500 hover:underline">
          bulk management →
        </Link>
      </div>
    </Card>
  );
}
