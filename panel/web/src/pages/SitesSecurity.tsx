// @docs security/site-protection
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  SCAN_ON_FINDING_INFO,
  SECURITY_LEVEL_INFO,
  blockedRuleLabel,
  effectivePolicy,
  type EffectivePolicy,
  type SecurityLevel,
  type SecurityOverrides,
} from '../../../shared/security';
import type { SecurityOverviewDto, SecuritySiteRowDto } from '../../../shared/types';
import { api } from '../api/client';
import { useSaveSecuritySettings, useScanAll, useSecurityOverview } from '../api/security';
import { Icon } from '../components/Icon';
import { BlockDialog } from '../components/security/BlockDialog';
import { PolicyEditor } from '../components/security/PolicyEditor';
import { ScanOutcomeBadge } from '../components/security/ScanCards';
import { SiteSecuritySettings } from '../components/security/SiteSecuritySettings';
import { Button, Card, EmptyState, ErrorNote, Segmented, Spinner, StatTile, Tabs, Toggle } from '../components/ui';
import { flagOf, timeAgo } from '../lib/format';

const TABS = [
  { id: 'findings', label: 'Findings' },
  { id: 'settings', label: 'Settings' },
];

interface DefaultDraft {
  level: SecurityLevel;
  overrides: SecurityOverrides;
  bypassPrivate: boolean;
}

/**
 * Sites -> Security. Findings: every site on one row with what its scans found and how many
 * requests it blocked, and the latest requests the fleet blocked. Settings: the protection
 * every site gets unless it chose its own, and the sites that did.
 */
export function SitesSecurity() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'findings';
  const overview = useSecurityOverview();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: { securityBypassPrivate: boolean } }>('/api/settings').then((r) => r.settings),
  });
  const save = useSaveSecuritySettings();
  // The page's, not the Settings tab's: a change to the default not saved yet outlives a look
  // at the findings, and its Save stays in view on either tab.
  const [draft, setDraft] = useState<DefaultDraft | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [editing, setEditing] = useState<SecuritySiteRowDto | null>(null);
  const lastSaved = useRef<string | null>(null);

  const saved: DefaultDraft | null =
    overview.data && settings.data
      ? { level: overview.data.fleet.level, overrides: overview.data.fleet.overrides, bypassPrivate: settings.data.securityBypassPrivate !== false }
      : null;
  useEffect(() => {
    if (!saved) return;
    setDraft((d) => (d === null || JSON.stringify(d) === lastSaved.current ? saved : d));
    lastSaved.current = JSON.stringify(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview.data, settings.data]);

  const preview = useMemo(
    () => (draft ? effectivePolicy({ level: draft.level, overrides: draft.overrides }, { level: null, overrides: {}, customRules: [] }) : null),
    [draft],
  );

  if (overview.error) return <ErrorNote error={overview.error} />;
  if (!overview.data || !draft || !preview || !saved) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  const o = overview.data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const serverTrouble = o.servers.filter((s) => s.state === 'error' || s.state === 'unreachable');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Security</h1>
        <p className="text-sm text-neutral-500">What every site&rsquo;s malware scans found and its protection blocked - and the settings behind them.</p>
      </div>

      {serverTrouble.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {serverTrouble.map((s) => (
            <div key={s.serverId}>
              <b>{s.serverName}:</b> {s.state === 'unreachable' ? 'the panel cannot reach it, so changes have not been applied there.' : `its rules could not be updated: ${s.message}`}
            </div>
          ))}
        </div>
      )}

      <Tabs tabs={TABS} active={tab} onChange={(id) => setParams(id === 'findings' ? {} : { tab: id })} />
      {tab === 'findings' && <FindingsTab o={o} onBlock={setBlocking} />}
      {tab === 'settings' && <SettingsTab o={o} draft={draft} preview={preview} onChange={setDraft} onEdit={setEditing} />}

      {dirty && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-neutral-200 bg-surface p-3 shadow-lg">
          <span className="mr-auto text-sm text-neutral-600">
            The default protection has changes not saved yet.
            {tab !== 'settings' && (
              <>
                {' '}
                <Link className="underline" to="?tab=settings">
                  See them
                </Link>
              </>
            )}
          </span>
          <ErrorNote error={save.error} />
          <Button variant="secondary" onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate({ securityLevel: draft.level, securityOverrides: draft.overrides, securityBypassPrivate: draft.bypassPrivate })}
          >
            {save.isPending ? 'Saving…' : 'Save the default'}
          </Button>
        </div>
      )}

      {blocking && <BlockDialog address={blocking} onClose={() => setBlocking(null)} />}
      {editing && <SiteSecuritySettings slug={editing.slug} title={editing.title} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Findings: what the scans found and the requests blocked, site by site

function FindingsTab({ o, onBlock }: { o: SecurityOverviewDto; onBlock: (address: string) => void }) {
  const scanAll = useScanAll();
  const openFindings = o.sites.reduce((n, s) => n + s.openFindings, 0);
  const knownMalware = o.sites.reduce((n, s) => n + s.openConfirmed, 0);
  const withFindings = o.sites.filter((s) => s.openFindings > 0).length;
  const protectedCount = o.sites.filter((s) => s.level !== 'off' && s.status === 'running' && !s.protection.unprotected).length;
  const running = o.sites.filter((s) => s.status === 'running').length;
  const scanning = o.sites.filter((s) => s.scanActive).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Open findings"
          value={openFindings.toLocaleString()}
          sub={
            withFindings > 0
              ? `on ${withFindings} site${withFindings === 1 ? '' : 's'}${knownMalware > 0 ? `, ${knownMalware.toLocaleString()} known malware` : ''}`
              : 'none open'
          }
        />
        <StatTile label="Blocked requests" value={o.blocked24h.toLocaleString()} sub="in the last 24 hours" />
        <StatTile
          label="Blocked addresses"
          value={o.activeBlocks.toLocaleString()}
          sub={
            <Link className="underline" to="/servers/security">
              on every server
            </Link>
          }
        />
        <StatTile label="Protected" value={`${protectedCount}/${running}`} sub="running sites with their rules in force" />
      </div>

      <Card
        title="Sites"
        action={
          <div className="flex items-center gap-3">
            {scanning > 0 && <span className="text-xs text-neutral-500">{scanning} scan{scanning === 1 ? '' : 's'} queued or running</span>}
            <Button small variant="secondary" disabled={scanAll.isPending} onClick={() => scanAll.mutate(undefined)}>
              Scan all sites
            </Button>
          </div>
        }
      >
        <ErrorNote error={scanAll.error} />
        {scanAll.data && (
          <p className="mb-3 text-sm text-neutral-600">
            {scanAll.data.queued.length > 0 ? `Queued ${scanAll.data.queued.length} scan${scanAll.data.queued.length === 1 ? '' : 's'}.` : 'Nothing new to queue.'}{' '}
            {scanAll.data.already.length > 0 && `${scanAll.data.already.length} already waiting or running.`}
          </p>
        )}
        {o.sites.length === 0 ? (
          <EmptyState>No sites yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2 pr-3">Site</th>
                  <th className="pb-2 pr-3">Findings</th>
                  <th className="pb-2 pr-3">Last scan</th>
                  <th className="pb-2 pr-3">Protection</th>
                  <th className="pb-2 text-right">Blocked requests, 24 h</th>
                </tr>
              </thead>
              <tbody>
                {o.sites.map((s) => (
                  <tr key={s.slug} className="border-t border-neutral-100">
                    <td className="py-2 pr-3">
                      <Link className="font-medium underline decoration-neutral-300" to={`/sites/${s.slug}?tab=security`}>
                        {s.title}
                      </Link>
                      <div className="text-xs text-neutral-500">
                        {s.slug}
                        {s.serverName && ` · ${s.serverName}`}
                        {s.status !== 'running' && ` · ${s.status}`}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      {s.openFindings > 0 ? (
                        <Link className="font-medium text-red-700 underline" to={`/sites/${s.slug}?tab=security`}>
                          {s.openFindings.toLocaleString()} open
                        </Link>
                      ) : (
                        <span className="text-neutral-400">none open</span>
                      )}
                      {s.openConfirmed > 0 && <div className="text-xs text-red-700">{s.openConfirmed.toLocaleString()} known malware</div>}
                      {s.quarantined > 0 && <div className="text-xs text-neutral-500">{s.quarantined.toLocaleString()} in quarantine</div>}
                    </td>
                    <td className="py-2 pr-3">
                      {s.scanActive ? (
                        <span className="text-xs text-sky-700">scanning…</span>
                      ) : !s.scanEnabled ? (
                        <span className="text-xs text-neutral-400">scans off</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <ScanOutcomeBadge outcome={s.lastScanOutcome} />
                          {s.lastScanAt && <span className="text-xs text-neutral-500">{timeAgo(s.lastScanAt)}</span>}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{SECURITY_LEVEL_INFO[s.level].label}</span>
                      {s.customised && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">customised</span>}
                      {s.protection.unprotected && (
                        <div className="text-xs text-amber-800" title={s.protection.unprotected}>
                          not in force
                        </div>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">{s.blocked24h > 0 ? s.blocked24h.toLocaleString() : <span className="text-neutral-400">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Blocked requests">
        {o.recentBlocked.length === 0 ? (
          <EmptyState>No requests blocked yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2">When</th>
                  <th className="pb-2">Site</th>
                  <th className="pb-2">Rule</th>
                  <th className="pb-2">Request</th>
                  <th className="pb-2">From</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {o.recentBlocked.map((r, i) => (
                  <tr key={`${r.ts}-${i}`} className="border-t border-neutral-100">
                    <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-neutral-500">{timeAgo(r.ts)}</td>
                    <td className="py-1.5 pr-3 text-xs">
                      {r.siteSlug ? (
                        <Link className="underline decoration-neutral-300" to={`/sites/${r.siteSlug}?tab=security`}>
                          {r.siteSlug}
                        </Link>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-xs">{blockedRuleLabel(r.rule)}</td>
                    <td className="max-w-sm truncate py-1.5 pr-3 font-mono text-xs" title={`${r.method} ${r.path}`}>
                      {r.method} {r.path}
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-xs">
                      {r.ip ? <span className="font-mono">{r.ip}</span> : <span className="text-neutral-400">not stored</span>}
                      {r.country && <span className="ml-1">{flagOf(r.country)}</span>}
                    </td>
                    <td className="py-1.5 text-right">
                      {r.ip && r.rule !== 'blocked-address' && (
                        <Button small variant="ghost" onClick={() => onBlock(r.ip!)}>
                          Block
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings: the default, and the sites that chose something else

function SettingsTab({
  o,
  draft,
  preview,
  onChange,
  onEdit,
}: {
  o: SecurityOverviewDto;
  draft: DefaultDraft;
  preview: EffectivePolicy;
  onChange: (next: DefaultDraft) => void;
  onEdit: (site: SecuritySiteRowDto) => void;
}) {
  const own = o.sites.filter((s) => ownSettings(s).length > 0);
  return (
    <div className="space-y-6">
      {own.length > 0 && (
        <Card title="Sites with settings of their own">
          <p className="text-sm text-neutral-600">What these sites chose for themselves. Everything else they take from the default below.</p>
          <div className="mt-2 divide-y divide-neutral-100">
            {own.map((s) => (
              <div key={s.slug} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2.5">
                <div className="min-w-0">
                  <Link className="font-medium underline decoration-neutral-300" to={`/sites/${s.slug}?tab=security`}>
                    {s.title}
                  </Link>
                  <span className="ml-2 text-xs text-neutral-500">
                    {s.slug}
                    {s.serverName && ` · ${s.serverName}`}
                  </span>
                  <div className="text-xs text-amber-700">{ownSettings(s).join(' · ')}</div>
                </div>
                <Button small variant="secondary" onClick={() => onEdit(s)}>
                  <Icon name="settings" size={13} />
                  Settings
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Default protection">
        <div className="space-y-5">
          <div>
            <Segmented
              label="Default level"
              options={[
                { id: 'off', label: 'Off' },
                { id: 'standard', label: 'Standard' },
                { id: 'strict', label: 'Strict' },
              ]}
              value={draft.level}
              onChange={(level) => onChange({ ...draft, level })}
            />
            <p className="measure mt-2 text-sm text-neutral-600">{SECURITY_LEVEL_INFO[draft.level].summary}</p>
            <p className="mt-1 text-xs text-neutral-500">
              Every site that uses the default gets this, with the changes below. A site that chose its own level keeps it.
            </p>
          </div>
          <PolicyEditor policy={preview} overrides={draft.overrides} scope="fleet" onChange={(overrides) => onChange({ ...draft, overrides })} />
          <Toggle
            checked={draft.bypassPrivate}
            onChange={(bypassPrivate) => onChange({ ...draft, bypassPrivate })}
            label={
              <span>
                Private addresses are never limited
                <span className="measure block text-xs text-neutral-500">
                  Without IPv6 in Docker every IPv6 visitor reaches a site as one private address, and so does the panel&rsquo;s own uptime probe:
                  limiting them would limit all of them together.
                </span>
              </span>
            }
          />
        </div>
      </Card>
    </div>
  );
}

/** What a site chose for itself, a few words each: ["Level: Strict", "2 settings changed", "Scans off"]. */
function ownSettings(s: SecuritySiteRowDto): string[] {
  const { level, changes, customRules, scanEnabled, scanOnFinding } = s.own;
  return [
    level !== null ? `Level: ${SECURITY_LEVEL_INFO[level].label}` : null,
    changes > 0 ? `${changes} setting${changes === 1 ? '' : 's'} changed${level === 'off' ? ', kept for when it is back on' : ''}` : null,
    customRules > 0 ? `${customRules} rule${customRules === 1 ? '' : 's'} of its own` : null,
    scanEnabled !== null ? (scanEnabled ? 'Scans on' : 'Scans off') : null,
    scanOnFinding !== null ? `On a finding: ${SCAN_ON_FINDING_INFO[scanOnFinding].label.toLowerCase()}` : null,
  ].filter((x): x is string => x !== null);
}
