// @docs security/site-protection
import { useState, type ReactNode } from 'react';
import { SCAN_ON_FINDING_INFO, SECURITY_LEVEL_INFO, blockedRuleLabel, type CustomRule } from '../../../../shared/security';
import type { SiteSecurityDto } from '../../../../shared/types';
import { useSite } from '../../api/hooks';
import { useSiteBlocked, useSiteSecurity } from '../../api/security';
import { countryName, flagOf, timeAgo } from '../../lib/format';
import { Icon } from '../Icon';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../ui';
import { BlockDialog } from './BlockDialog';
import { FindingsCard, MalwareScanCard, QuarantineCard } from './ScanCards';
import { ProtectionNotices, SiteSecuritySettings } from './SiteSecuritySettings';

/**
 * A site's Security tab: what its scans found and the requests its protection blocked, under a
 * line saying how it is set. The settings themselves open in a sheet - the site page has tabs
 * already, and a tab cannot hold tabs of its own.
 */
export function SiteSecurityTab({ slug }: { slug: string }) {
  const sec = useSiteSecurity(slug);
  const site = useSite(slug);
  const [editing, setEditing] = useState(false);

  if (sec.error) return <ErrorNote error={sec.error} />;
  if (!sec.data) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  const s = sec.data;

  return (
    <div className="space-y-6">
      <ProtectionNotices s={s} />
      <SettingsSummary s={s} onEdit={() => setEditing(true)} />
      <MalwareScanCard slug={slug} scan={s.scan} />
      <FindingsCard slug={slug} />
      <QuarantineCard slug={slug} />
      <BlockedCard slug={slug} rules={s.customRules} />
      {editing && <SiteSecuritySettings slug={slug} title={site.data?.title ?? slug} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** Parts of a line, " · " between them. */
function dotted(parts: ReactNode[]): ReactNode[] {
  return parts.filter(Boolean).flatMap((p, i) => (i === 0 ? [p] : [' · ', p]));
}

const OWN = 'text-amber-700';

/**
 * How the site is set, in two lines - what it chose for itself in the amber the settings use
 * for "changed for this site" - and the way into the settings.
 */
function SettingsSummary({ s, onEdit }: { s: SiteSecurityDto; onEdit: () => void }) {
  const off = s.policy.level === 'off';
  const changes = Object.values(s.policy.sources).filter((from) => from === 'site').length;
  const rules = s.customRules.length;
  const scan = s.scan;
  const protection = dotted([
    s.level === null ? 'the default' : <span key="level" className={OWN}>chosen for this site</span>,
    changes > 0 && (
      <span key="changes" className={OWN}>
        {changes} setting{changes === 1 ? '' : 's'} changed for this site
      </span>
    ),
    rules > 0 && `${rules} rule${rules === 1 ? '' : 's'} of its own${off ? ', not in force' : ''}`,
    s.status.writtenAt && !s.status.unprotected && <span key="since" className="text-neutral-400">in force since {timeAgo(s.status.writtenAt)}</span>,
  ]);
  const scans = dotted([
    scan.enabled === null ? 'the default' : <span key="enabled" className={OWN}>chosen for this site</span>,
    scan.effective.enabled &&
      (scan.onFinding === null ? (
        SCAN_ON_FINDING_INFO[scan.effective.onFinding].label.toLowerCase()
      ) : (
        <span key="on-finding" className={OWN}>
          {SCAN_ON_FINDING_INFO[scan.effective.onFinding].label.toLowerCase()}, chosen for this site
        </span>
      )),
  ]);
  return (
    <div className="panel-card flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-[22px] py-4">
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-5 gap-y-1 text-sm">
        <dt className="text-neutral-500">Protection</dt>
        <dd className="text-neutral-600">
          <b className="font-semibold text-neutral-900">{SECURITY_LEVEL_INFO[s.policy.level].label}</b> - {protection}
        </dd>
        <dt className="text-neutral-500">Malware scans</dt>
        <dd className="text-neutral-600">
          <b className="font-semibold text-neutral-900">{scan.effective.enabled ? 'On' : 'Off'}</b> - {scans}
        </dd>
      </dl>
      <Button variant="secondary" onClick={onEdit}>
        <Icon name="settings" size={15} />
        Settings
      </Button>
    </div>
  );
}

function BlockedCard({ slug, rules }: { slug: string; rules: CustomRule[] }) {
  const blocked = useSiteBlocked(slug);
  const [blocking, setBlocking] = useState<string | null>(null);
  // A rule of the site's own reads as what it is for, when it says.
  const label = (rule: string) => rules.find((r) => `block-${r.id}` === rule)?.note || blockedRuleLabel(rule);
  const totals = Object.entries(blocked.data?.counts7d ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <Card title="Blocked requests">
      <ErrorNote error={blocked.error} />
      {!blocked.data ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          {totals.length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs">
              {totals.map(([rule, n]) => (
                <span key={rule} className="rounded-full bg-neutral-100 px-2.5 py-1 text-neutral-700">
                  {label(rule)} <b className="tabular-nums">{n.toLocaleString()}</b>
                </span>
              ))}
              <span className="self-center text-neutral-400">in the last 7 days</span>
            </div>
          )}
          {blocked.data.items.length === 0 ? (
            <EmptyState>No requests blocked yet.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                    <th className="pb-2">When</th>
                    <th className="pb-2">Rule</th>
                    <th className="pb-2">Request</th>
                    <th className="pb-2">From</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {blocked.data.items.map((r, i) => (
                    <tr key={`${r.ts}-${i}`} className="border-t border-neutral-100">
                      <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-neutral-500">{timeAgo(r.ts)}</td>
                      <td className="py-1.5 pr-3 text-xs">
                        {label(r.rule)} <span className="text-neutral-400">{r.status}</span>
                      </td>
                      <td className="max-w-md truncate py-1.5 pr-3 font-mono text-xs" title={`${r.method} ${r.path}`}>
                        {r.method} {r.path}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-xs">
                        {r.ip ? (
                          <span className="font-mono">{r.ip}</span>
                        ) : (
                          <span className="text-neutral-400" title="Addresses are not stored (Settings → Monitoring → Visitor statistics)">
                            not stored
                          </span>
                        )}
                        {r.country && (
                          <span className="ml-1 text-neutral-500" title={countryName(r.country)}>
                            {flagOf(r.country)}
                          </span>
                        )}
                        {r.via && <span className="ml-1 text-neutral-400">via {r.via}</span>}
                      </td>
                      <td className="py-1.5 text-right">
                        {r.ip && r.rule !== 'blocked-address' && (
                          <Button small variant="ghost" onClick={() => setBlocking(r.ip)}>
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
        </div>
      )}
      {blocking && <BlockDialog address={blocking} siteSlug={slug} onClose={() => setBlocking(null)} />}
    </Card>
  );
}
