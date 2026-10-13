// @docs sites/overview
import { useState } from 'react';
import { Link, useNavigate, type NavigateFunction } from 'react-router';
import type { SiteSummary } from '../../../shared/types';
import { useMeta, useSites } from '../api/hooks';
import { Button, Card, EmptyState, ExternalLinkIcon, inputClass, Segmented, SiteHealthBadge, StatusBadge } from '../components/ui';
import { SeverityBadge } from '../components/wp/severity';
import { formatBytes, timeAgo } from '../lib/format';
import { siteHealth } from '../lib/siteHealth';
import { layoutFrom, sitesView, type SitesLayout } from './sitesLayout';

const LAYOUTS = [
  { id: 'split', label: 'Split', title: 'Sites hosted elsewhere in a list of their own' },
  { id: 'single', label: 'Single list', title: 'Every site in one list' },
] as const;

/** Where this browser keeps the layout last chosen. */
const LAYOUT_KEY = 'wpl7-sites-layout';

function storedLayout(): SitesLayout {
  try {
    return layoutFrom(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return 'split';
  }
}

export function Sites() {
  const sites = useSites();
  const meta = useMeta();
  const [serverFilter, setServerFilter] = useState<number | 'all'>('all');
  const [layout, setLayout] = useState<SitesLayout>(storedLayout);
  const multiServer = meta.data?.multiServer ?? false;
  // Whether a site is reachable over https depends on the deployment's TLS mode, not on
  // whether it has gone live: under TLS_MODE=none every "live" link was a dead https URL.
  const scheme = meta.data?.tlsMode === 'none' ? 'http' : 'https';
  const view = sitesView(sites.data ?? [], layout, serverFilter);

  const chooseLayout = (next: SitesLayout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // Storage refused (a private window): the choice lasts until the page is left.
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">Sites</h1>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {view.choice && <Segmented label="Layout" options={LAYOUTS} value={layout} onChange={chooseLayout} />}
          {multiServer && (
            <select
              // inputClass's w-full outranks a width added here, and in a row that wraps it would
              // take a row of its own. A maximum width does not compete with it.
              className={`${inputClass} max-w-fit`}
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
          <Link to="/sites/connect" className="whitespace-nowrap">
            <Button variant="secondary">Connect site</Button>
          </Link>
          <Link to="/sites/import" className="whitespace-nowrap">
            <Button variant="secondary">Import site</Button>
          </Link>
          <Link to="/sites/new" className="whitespace-nowrap">
            <Button>New site</Button>
          </Link>
        </div>
      </div>
      {view.showMain && (
        <Card title={view.choice && !view.single ? 'Hosted' : undefined}>
          {view.main.length === 0 ? (
            <EmptyState>No sites{serverFilter !== 'all' ? ' on this server' : ' yet'}.</EmptyState>
          ) : (
            <SitesTable sites={view.main} multiServer={multiServer} scheme={scheme} single={view.single} />
          )}
        </Card>
      )}
      {view.externalCard.length > 0 && <ExternalSitesCard sites={view.externalCard} />}
    </div>
  );
}

/**
 * A row opens its site. A mouse convenience on top of the real link in the first cell, not a
 * replacement for it: the title stays an anchor so the row is still reachable by keyboard and
 * still opens in a tab on cmd/middle click.
 */
function openSite(navigate: NavigateFunction, slug: string) {
  return (e: React.MouseEvent) => {
    // The domain link and anything else interactive owns its own click.
    if ((e.target as HTMLElement).closest('a, button, input, select')) return;
    if (e.metaKey || e.ctrlKey) window.open(`/sites/${slug}`, '_blank');
    else void navigate(`/sites/${slug}`);
  };
}

/** The sites hosted here or, as a single list, every site: one hosted elsewhere fills what it can. */
function SitesTable({ sites, multiServer, scheme, single }: { sites: SiteSummary[]; multiServer: boolean; scheme: string; single: boolean }) {
  const navigate = useNavigate();
  return (
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
          <th className="pb-2 text-right">{single ? 'Added' : 'Created'}</th>
        </tr>
      </thead>
      <tbody>
        {sites.map((site) => {
          const external = site.kind === 'external';
          return (
            <tr
              key={site.slug}
              onClick={openSite(navigate, site.slug)}
              className="cursor-pointer border-t border-neutral-100 transition-colors hover:bg-neutral-50"
            >
              <td className="py-2.5 pr-3">
                <SiteCell site={site} href={external ? undefined : `${scheme}://${site.primaryDomain}`} />
              </td>
              <td className="py-2.5 pr-3">
                <SiteHealthBadge health={siteHealth(site)} />
              </td>
              <td className="py-2.5 pr-3">
                <StatusBadge status={external ? 'external' : site.isLive ? 'live' : 'dev'} />
              </td>
              {multiServer && (
                <td className="py-2.5 pr-3 text-xs text-neutral-600" title={external ? 'Hosted elsewhere' : undefined}>
                  {external ? '–' : site.serverName}
                </td>
              )}
              <td className="py-2.5 pr-3 text-neutral-600">{site.phpVersion}</td>
              <td className="py-2.5 pr-3 text-right whitespace-nowrap">
                <UpdatesCell site={site} />
              </td>
              <td
                className="py-2.5 pr-3 text-right tabular-nums text-neutral-500"
                title={
                  external
                    ? 'Not counted for sites hosted elsewhere'
                    : site.recentTraffic
                      ? `${site.recentTraffic.pageViews.toLocaleString()} page views in the last 24h`
                      : 'no visits recorded in the last 24h'
                }
              >
                {site.recentTraffic ? site.recentTraffic.visitors.toLocaleString() : '–'}
              </td>
              <td className="py-2.5 text-right text-neutral-500">{formatBytes(site.diskBytes)}</td>
              <td className="py-2.5 text-right text-xs text-neutral-500">{timeAgo(site.createdAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The title, which opens the site's page, and its address, which opens the site in a new tab. */
function SiteCell({ site, href }: { site: SiteSummary; href?: string }) {
  return (
    <>
      <Link to={`/sites/${site.slug}`} className="font-medium hover:underline">
        {site.title}
      </Link>
      <div className="text-xs text-neutral-500">
        <a
          href={href ?? site.external?.home ?? `https://${site.primaryDomain}`}
          target="_blank"
          rel="noreferrer"
          title={`Open ${site.primaryDomain} in a new tab`}
          className="inline-flex items-center gap-1 hover:text-neutral-700 hover:underline"
        >
          {site.primaryDomain}
          <ExternalLinkIcon />
        </a>
      </div>
    </>
  );
}

/** Sites hosted elsewhere, managed through WPL7 Connect. */
function ExternalSitesCard({ sites }: { sites: SiteSummary[] }) {
  const navigate = useNavigate();
  return (
    <Card title="External">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
            <th className="pb-2">Site</th>
            <th className="pb-2">Status</th>
            <th className="pb-2">PHP</th>
            <th className="pb-2 text-right" title="Plugin, theme and core updates found by the last scan">
              Updates
            </th>
            <th className="pb-2 text-right">Last backup</th>
            <th className="pb-2 text-right">Added</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => (
            <tr
              key={site.slug}
              onClick={openSite(navigate, site.slug)}
              className="cursor-pointer border-t border-neutral-100 transition-colors hover:bg-neutral-50"
            >
              <td className="py-2.5 pr-3">
                <SiteCell site={site} />
              </td>
              <td className="py-2.5 pr-3">
                <SiteHealthBadge health={siteHealth(site)} />
              </td>
              <td className="py-2.5 pr-3 text-neutral-600">{site.phpVersion}</td>
              <td className="py-2.5 pr-3 text-right whitespace-nowrap">
                <UpdatesCell site={site} />
              </td>
              <td className="py-2.5 text-right text-xs text-neutral-500">
                {site.external?.lastBackupAt ? timeAgo(site.external.lastBackupAt) : '–'}
              </td>
              <td className="py-2.5 text-right text-xs text-neutral-500">{timeAgo(site.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Updates the last scan found, and the worst known vulnerability. */
function UpdatesCell({ site }: { site: SiteSummary }) {
  if (!site.wp) {
    return (
      <span className="text-neutral-300" title="Not scanned yet">
        –
      </span>
    );
  }
  return (
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
        <SeverityBadge severity={site.wp.worstSeverity} title={`${site.wp.vulnerable} component(s) with a known vulnerability`} />
      )}
    </Link>
  );
}
