// @docs sites/overview
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMeta, useSites } from '../api/hooks';
import { Button, Card, EmptyState, ExternalLinkIcon, inputClass, SiteHealthBadge, StatusBadge } from '../components/ui';
import { SeverityBadge } from '../components/wp/severity';
import { formatBytes, timeAgo } from '../lib/format';
import { siteHealth } from '../lib/siteHealth';

export function Sites() {
  const sites = useSites();
  const meta = useMeta();
  const navigate = useNavigate();
  const [serverFilter, setServerFilter] = useState<number | 'all'>('all');
  const multiServer = meta.data?.multiServer ?? false;
  // Whether a site is reachable over https depends on the deployment's TLS mode, not on
  // whether it has gone live: under TLS_MODE=none every "live" link was a dead https URL.
  const scheme = meta.data?.tlsMode === 'none' ? 'http' : 'https';
  const filtered = (sites.data ?? []).filter((s) => serverFilter === 'all' || s.serverId === serverFilter);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="page-title">Sites</h1>
        <div className="flex items-center gap-2">
          {multiServer && (
            <select
              className={`${inputClass} w-auto`}
              value={serverFilter}
              onChange={(e) => setServerFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            >
              <option value="all">All servers</option>
              {(meta.data?.servers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <Link to="/sites/import">
            <Button variant="secondary">Import site</Button>
          </Link>
          <Link to="/sites/new">
            <Button>New site</Button>
          </Link>
        </div>
      </div>
      <Card>
        {filtered.length === 0 ? (
          <EmptyState>No sites{serverFilter !== 'all' ? ' on this server' : ' yet'}.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">Site</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Mode</th>
                {multiServer && <th className="pb-2">Server</th>}
                <th className="pb-2">PHP</th>
                <th className="pb-2 text-right" title="Plugin, theme and core updates found by the last scan">
                  Updates
                </th>
                <th className="pb-2 text-right" title="Unique visitors in the last 24 hours">
                  Visitors
                </th>
                <th className="pb-2 text-right">Disk</th>
                <th className="pb-2 text-right">Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((site) => (
                <tr
                  key={site.slug}
                  // A mouse convenience on top of the real link in the first cell, not a
                  // replacement for it: the title stays an anchor so the row is still
                  // reachable by keyboard and still opens in a tab on cmd/middle click.
                  onClick={(e) => {
                    // The domain link and anything else interactive owns its own click.
                    if ((e.target as HTMLElement).closest('a, button, input, select')) return;
                    if (e.metaKey || e.ctrlKey) window.open(`/sites/${site.slug}`, '_blank');
                    else void navigate(`/sites/${site.slug}`);
                  }}
                  className="cursor-pointer border-t border-neutral-100 transition-colors hover:bg-neutral-50"
                >
                  <td className="py-2.5 pr-3">
                    <Link to={`/sites/${site.slug}`} className="font-medium hover:underline">
                      {site.title}
                    </Link>
                    <div className="text-xs text-neutral-500">
                      <a
                        href={`${scheme}://${site.primaryDomain}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${site.primaryDomain} in a new tab`}
                        className="inline-flex items-center gap-1 hover:text-neutral-700 hover:underline"
                      >
                        {site.primaryDomain}
                        <ExternalLinkIcon />
                      </a>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <SiteHealthBadge health={siteHealth(site)} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <StatusBadge status={site.isLive ? 'live' : 'dev'} />
                  </td>
                  {multiServer && <td className="py-2.5 pr-3 text-xs text-neutral-600">{site.serverName}</td>}
                  <td className="py-2.5 pr-3 text-neutral-600">{site.phpVersion}</td>
                  <td className="py-2.5 pr-3 text-right whitespace-nowrap">
                    {site.wp ? (
                      <Link
                        to={`/sites/${site.slug}`}
                        className="inline-flex items-center justify-end gap-1.5"
                        title={`Scanned ${timeAgo(site.wp.scannedAt)}${site.wp.coreUpdate ? ` · WordPress ${site.wp.coreUpdate} available` : ''}`}
                      >
                        {site.wp.updates > 0 ? (
                          <span className="font-medium text-amber-600 tabular-nums">{site.wp.updates} ↑</span>
                        ) : (
                          <span className="text-neutral-300">0</span>
                        )}
                        {site.wp.vulnerable > 0 && site.wp.worstSeverity && (
                          <SeverityBadge
                            severity={site.wp.worstSeverity}
                            title={`${site.wp.vulnerable} component(s) with a known vulnerability`}
                          />
                        )}
                      </Link>
                    ) : (
                      <span className="text-neutral-300" title="Not scanned yet">
                        –
                      </span>
                    )}
                  </td>
                  <td
                    className="py-2.5 pr-3 text-right tabular-nums text-neutral-500"
                    title={
                      site.recentTraffic
                        ? `${site.recentTraffic.pageViews.toLocaleString()} page views in the last 24h`
                        : 'no visits recorded in the last 24h'
                    }
                  >
                    {site.recentTraffic ? site.recentTraffic.visitors.toLocaleString() : '–'}
                  </td>
                  <td className="py-2.5 text-right text-neutral-500">{formatBytes(site.diskBytes)}</td>
                  <td className="py-2.5 text-right text-xs text-neutral-500">{timeAgo(site.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
