import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  isTerminal,
  useBackups,
  useMeta,
  useRunJob,
  useServers,
  useSite,
  useSiteHistory,
  useSiteTraffic,
} from '../api/hooks';
import type { BackupDto } from '../../../shared/types';
import { api } from '../api/client';
import {
  Button,
  Card,
  ConfirmDialog,
  CopyField,
  EmptyState,
  ErrorNote,
  ExternalLinkIcon,
  Field,
  inputClass,
  Modal,
  SiteHealthBadge,
  Spinner,
  StatTile,
  StatusBadge,
  Tabs,
  Toggle,
} from '../components/ui';
import { BarChart } from '../components/BarChart';
import {
  BackupActions,
  DeleteBackupDialog,
  FetchBackDialog,
  OffsiteBadges,
  RestoreBackupDialog,
} from '../components/backups/BackupParts';
import { describeCron } from '../../../shared/cron';
import { JobProgress } from '../components/JobProgress';
import { Sparkline } from '../components/Sparkline';
import { WordPressTab } from '../components/wp/WordPressTab';
import { FilesTab } from '../components/files/FilesTab';
import { FtpTab } from '../components/ftp/FtpTab';
import { SiteSecurityTab } from '../components/security/SiteSecurityTab';
import { BlockDialog } from '../components/security/BlockDialog';
import { countryName, flagOf, formatBytes, formatDate, localeName, timeAgo } from '../lib/format';
import { siteHealth } from '../lib/siteHealth';

const SITE_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'visitors', label: 'Visitors' },
  { id: 'backups', label: 'Backups' },
  { id: 'wordpress', label: 'WordPress' },
  { id: 'files', label: 'Files' },
  { id: 'ftp', label: 'FTP' },
  { id: 'security', label: 'Security' },
  { id: 'settings', label: 'Settings' },
];

export function SiteDetail() {
  const { slug = '' } = useParams();
  const site = useSite(slug);
  // In the URL, so a folder in the Files tab (and the file open in its editor) can be linked
  // to, and reloading the page stays where it was.
  const [params, setParams] = useSearchParams();
  const tab = SITE_TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'overview';
  const setTab = (id: string) => setParams(id === 'overview' ? {} : { tab: id });

  // Only a site that never loaded is an error page. A refresh that fails - the 15-second
  // poll, a network blip, an expired session - keeps the page as it was, with the error above
  // it: unmounting the tabs would throw away an upload under way, or the editor's unsaved text.
  if (site.isError && !site.data) {
    return (
      <div className="space-y-4">
        <ErrorNote error={site.error} />
        <Link className="text-sm underline" to="/sites">← back to sites</Link>
      </div>
    );
  }
  if (!site.data) return <Spinner />;
  const s = site.data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="page-title">{s.title}</h1>
            <SiteHealthBadge health={siteHealth(s)} />
            <StatusBadge status={s.isLive ? 'live' : 'dev'} />
          </div>
          <a
            href={s.url}
            target="_blank"
            rel="noreferrer"
            title={`Open ${s.url} in a new tab`}
            className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-700 hover:underline"
          >
            {s.url}
            <ExternalLinkIcon />
          </a>
        </div>
        <Link to="/sites" className="text-sm text-neutral-500 hover:underline">← sites</Link>
      </div>

      {site.isError && <ErrorNote error={site.error} />}

      <Tabs tabs={SITE_TABS} active={tab} onChange={setTab} />

      {tab === 'overview' && <OverviewTab slug={slug} />}
      {tab === 'visitors' && <VisitorsTab slug={slug} />}
      {tab === 'security' && <SiteSecurityTab slug={slug} />}
      {tab === 'backups' && <BackupsTab slug={slug} />}
      {tab === 'wordpress' && <WordPressTab slug={slug} />}
      {/* Keyed: another site's page is a fresh tab, never this one's selection or dialogs. */}
      {tab === 'files' && <FilesTab key={slug} slug={slug} />}
      {tab === 'ftp' && <FtpTab key={slug} slug={slug} />}
      {tab === 'settings' && <SettingsTab slug={slug} />}
    </div>
  );
}

// --------------------------------------------------------------- Overview

function OverviewTab({ slug }: { slug: string }) {
  const site = useSite(slug);
  const history = useSiteHistory(slug);
  const meta = useMeta();
  const run = useRunJob([['site', slug]]);
  const finalize = useRunJob([['site', slug]]);
  const qc = useQueryClient();
  const [mailBusy, setMailBusy] = useState(false);
  const [mailError, setMailError] = useState<unknown>(null);
  const [goLiveOpen, setGoLiveOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const s = site.data;
  if (!s) return <Spinner />;

  const samples = history.data ?? [];
  const multiServer = meta.data?.multiServer ?? false;
  const cleanup = s.pendingMoveCleanup;
  const mailSuspended = s.mailSuspended;
  const health = siteHealth(s);

  return (
    <div className="space-y-4">
      {health.tone === 'bad' && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <div className="font-medium">{health.label}</div>
          <p className="mt-1">{health.detail}</p>
          {health.fix && <p className="mt-1">{health.fix}</p>}
          {health.action && (
            <div className="mt-2">
              <Button
                small
                disabled={run.isPending}
                onClick={() => run.mutate({ path: `/api/sites/${slug}/${health.action!.path}` })}
              >
                {health.action.label}
              </Button>
            </div>
          )}
        </div>
      )}
      {mailSuspended && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
          <div className="font-medium">Outbound mail suspended</div>
          <p className="mt-1">
            The relay is refusing this site's mail: <b>{mailSuspended.reason}</b>. The site keeps serving
            pages. Check Mail → Volume by site before resuming.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <Button
              small
              disabled={mailBusy}
              onClick={() => {
                setMailBusy(true);
                setMailError(null);
                void api(`/api/sites/${slug}/mail-suspension`, { method: 'PUT', body: { suspended: false } })
                  .then(() => qc.invalidateQueries({ queryKey: ['site', slug] }))
                  .catch(setMailError)
                  .finally(() => setMailBusy(false));
              }}
            >
              Resume mail
            </Button>
            <span className="text-xs">since {timeAgo(mailSuspended.since)}</span>
          </div>
          <div className="mt-2">
            <ErrorNote error={mailError} />
          </div>
        </div>
      )}
      {cleanup && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-medium">Move cleanup pending</div>
          <p className="mt-1">
            A frozen copy from the last move is still on <b>{cleanup.sourceServerName}</b>
            {cleanup.hostsPending.length > 0 ? (
              <>
                {' '}— removed once {cleanup.hostsPending.join(', ')} point
                {cleanup.hostsPending.length === 1 ? 's' : ''} at <code>{cleanup.targetIp}</code> (checked daily).
              </>
            ) : (
              <> — finalize to remove it.</>
            )}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <Button small onClick={() => finalize.mutate({ path: `/api/sites/${slug}/move/finalize` })} disabled={finalize.isPending}>
              Finalize now
            </Button>
            <span className="text-xs">since {timeAgo(cleanup.since)}</span>
          </div>
          <div className="mt-2">
            <ErrorNote error={finalize.error} />
            <JobProgress job={finalize.job} logs={finalize.logs} />
          </div>
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button small variant="secondary" onClick={() => run.mutate({ path: `/api/sites/${slug}/start` })}>Start</Button>
          <Button small variant="secondary" onClick={() => run.mutate({ path: `/api/sites/${slug}/stop` })}>Stop</Button>
          <Button small variant="secondary" onClick={() => run.mutate({ path: `/api/sites/${slug}/restart` })}>Restart</Button>
          {/* Rebuilds the container from the current spec. Next to Restart because that is
              where you look for it, and because it is the heavier version of the same idea. */}
          <Button small variant="secondary" onClick={() => run.mutate({ path: `/api/sites/${slug}/reconcile` })}>
            Recreate container
          </Button>
          <WpAdminLoginButton slug={slug} running={s.containerState === 'running'} />
          {!s.isLive && (
            <Button small onClick={() => setGoLiveOpen(true)}>
              Go live →
            </Button>
          )}
          {multiServer && (
            <Button small variant="secondary" onClick={() => setMoveOpen(true)}>
              Move server
            </Button>
          )}
        </div>
        <div className="mt-3">
          <ErrorNote error={run.error} />
          <JobProgress job={run.job} logs={run.logs} />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Facts">
          <dl className="space-y-2 text-sm">
            <FactRow label="Domains" value={s.domains.join(', ')} />
            {s.devHostname && <FactRow label="Dev hostname" value={s.devHostname} />}
            {multiServer && <FactRow label="Server" value={s.serverName} />}
            <FactRow label="PHP" value={s.phpVersion} />
            <FactRow label="Language" value={localeName(meta.data?.locales, s.locale)} />
            <FactRow label="Container" value={s.containerState} />
            <FactRow label="Database" value={s.dbName} />
            <FactRow label="WP admin" value={`${s.adminUser ?? '–'} <${s.adminEmail ?? '–'}>`} />
            <FactRow label="Disk" value={formatBytes(s.diskBytes)} />
            <FactRow label="Created" value={formatDate(s.createdAt)} />
          </dl>
        </Card>
        <Card title="Last 24h">
          <div className="space-y-4 text-sm">
            <div>
              <div className="mb-1 text-xs text-neutral-500">Response time</div>
              <Sparkline values={samples.map((x) => x.httpMs)} formatValue={(v) => `${Math.round(v)} ms`} />
            </div>
            <div>
              <div className="mb-1 text-xs text-neutral-500">
                CPU <span className="text-neutral-400">— % of one core</span>
              </div>
              <Sparkline values={samples.map((x) => x.cpuPct)} formatValue={(v) => `${v.toFixed(1)} %`} />
            </div>
            <div>
              <div className="mb-1 text-xs text-neutral-500">Memory</div>
              <Sparkline values={samples.map((x) => x.memBytes)} formatValue={(v) => formatBytes(v)} />
            </div>
          </div>
        </Card>
      </div>

      {goLiveOpen && <GoLiveModal slug={slug} onClose={() => setGoLiveOpen(false)} />}
      {moveOpen && <MoveModal slug={slug} onClose={() => setMoveOpen(false)} />}
    </div>
  );
}

/**
 * One-click WordPress admin login: the panel mints a single-use token and this opens a tab
 * that spends it. The tab is opened synchronously inside the click handler and pointed at
 * the URL afterwards - opening it once the request has resolved is what popup blockers
 * stop. Blocked anyway: the link is offered instead (single-use, expires in two minutes).
 */
function WpAdminLoginButton({ slug, running }: { slug: string; running: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);

  const login = async () => {
    setBusy(true);
    setError(null);
    setBlockedUrl(null);
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null; // the customer's site never gets a handle on the panel window
    try {
      const res = await api<{ url: string }>(`/api/sites/${slug}/wp/admin-login`, { method: 'POST' });
      if (tab) tab.location.replace(res.url);
      else setBlockedUrl(res.url);
    } catch (err) {
      tab?.close();
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button small variant="secondary" disabled={!running || busy} onClick={() => void login()}>
        {busy ? 'Signing in…' : 'Log in to WordPress'}
      </Button>
      {blockedUrl && (
        <a
          className="inline-flex items-center gap-1 text-xs underline"
          href={blockedUrl}
          target="_blank"
          rel="noreferrer"
        >
          Popup blocked — open wp-admin (link works once, for two minutes)
          <ExternalLinkIcon />
        </a>
      )}
      <ErrorNote error={error} />
    </>
  );
}

function MoveModal({ slug, onClose }: { slug: string; onClose: () => void }) {
  const site = useSite(slug);
  const meta = useMeta();
  const servers = useServers();
  const run = useRunJob([['site', slug], ['servers']]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [quiesce, setQuiesce] = useState<'maintenance' | 'none'>('maintenance');
  const done = isTerminal(run.job?.status);
  const s = site.data;
  if (!s) return null;

  const candidates = (servers.data ?? []).filter((srv) => srv.id !== s.serverId && srv.status === 'ok');
  const target = candidates.find((srv) => srv.id === targetId) ?? candidates[0] ?? null;
  const customHosts = s.domains.filter((d) => d !== s.devHostname);
  const dnsManaged = meta.data?.dnsManaged ?? false;

  return (
    <Modal title="Move to another server" onClose={onClose}>
      {run.jobId === null ? (
        <div className="space-y-4 text-sm">
          {candidates.length === 0 ? (
            <p className="text-neutral-600">No other healthy server available.</p>
          ) : (
            <>
              <Field label="Target server">
                <select
                  className={inputClass}
                  value={target?.id ?? ''}
                  onChange={(e) => setTargetId(Number(e.target.value))}
                >
                  {candidates.map((srv) => (
                    <option key={srv.id} value={srv.id}>
                      {srv.name} ({srv.publicIp || srv.sshHost})
                    </option>
                  ))}
                </select>
              </Field>
              <div className="rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
                Files and database are copied over, the site starts on the new server, then traffic switches:
                {s.devHostname && (
                  <div className="mt-1">
                    • <code>{s.devHostname}</code>{' '}
                    {dnsManaged ? 'flips automatically via the DNS API.' : 'needs its DNS record updated manually.'}
                  </div>
                )}
                {customHosts.length > 0 && (
                  <div className="mt-1">
                    • The old server forwards visitors until your DNS change propagates.
                  </div>
                )}
              </div>
              {customHosts.length > 0 && target && (
                <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                  <div className="mb-1 font-medium">Update these A records to the new server:</div>
                  {customHosts.map((h) => (
                    <div key={h}>
                      <code>{h}</code> → <code>{target.publicIp || '(target IP)'}</code>
                    </div>
                  ))}
                  {target.publicIp && <div className="mt-2"><CopyField value={target.publicIp} tone="plain" /></div>}
                  <div className="mt-1">
                    Tip: lower the records&apos; TTL to 300 beforehand.
                    {meta.data?.mailMode === 'direct' && ' Also add the new IP to the domains’ SPF records (docs/dns.md).'}
                  </div>
                </div>
              )}
              {s.isLive && (
                <div className="space-y-1.5">
                  <div className="font-medium">While copying:</div>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={quiesce === 'maintenance'} onChange={() => setQuiesce('maintenance')} />
                    Freeze the site (maintenance page) — nothing gets lost
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={quiesce === 'none'} onChange={() => setQuiesce('none')} />
                    Keep serving — changes made during the copy are lost
                  </label>
                </div>
              )}
              <ErrorNote error={run.error} />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button
                  disabled={!target || run.isPending}
                  onClick={() =>
                    target &&
                    run.mutate({
                      path: `/api/sites/${slug}/move`,
                      body: { targetServerId: target.id, ...(s.isLive ? { quiesce } : {}) },
                    })
                  }
                >
                  Move site
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <JobProgress job={run.job} logs={run.logs} />
          {done && (
            <div className="flex justify-end">
              <Button onClick={onClose}>{run.job?.status === 'succeeded' ? 'Done' : 'Close'}</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
      <dd className="break-all font-medium">{value}</dd>
    </div>
  );
}

function GoLiveModal({ slug, onClose }: { slug: string; onClose: () => void }) {
  const meta = useMeta();
  const run = useRunJob([['site', slug]]);
  const [domainsText, setDomainsText] = useState('');
  const [keepDevAlias, setKeepDevAlias] = useState(true);
  const [manageDns, setManageDns] = useState(false);
  const domains = domainsText.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const done = isTerminal(run.job?.status);

  return (
    <Modal title="Go live" onClose={onClose}>
      {run.jobId === null ? (
        <div className="space-y-4 text-sm">
          <p className="text-neutral-600">
            The site keeps serving while the certificate is issued, then the canonical URL flips. Zero downtime.
          </p>
          <Field label="Production domains (first = primary)" hint="e.g. customer.com www.customer.com">
            <input className={inputClass} value={domainsText} onChange={(e) => setDomainsText(e.target.value)} autoFocus />
          </Field>
          <Toggle checked={keepDevAlias} onChange={setKeepDevAlias} label="Keep the dev hostname as a 301 redirect" />
          {meta.data?.dnsManaged && (
            <Toggle
              checked={manageDns}
              onChange={setManageDns}
              label={
                <span>
                  Point them at this server through Cloudflare
                  <span className="block text-xs text-neutral-500">
                    Creates or replaces their <code>A</code> records, where the token in Settings → DNS reaches the zone.
                  </span>
                </span>
              }
            />
          )}
          <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            {manageDns
              ? 'A domain whose zone the token does not reach still needs its A record pointed at this server by hand.'
              : <>Before continuing, point DNS at this server: an <code>A</code> record for the apex and for <code>www</code>.</>}
            {meta.data?.mailMode === 'smarthost' && ' For email deliverability also add your SMTP provider’s SPF/DKIM records.'}
          </div>
          <ErrorNote error={run.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              disabled={domains.length === 0 || run.isPending}
              onClick={() =>
                run.mutate({ path: `/api/sites/${slug}/go-live`, body: { domains, keepDevAlias, ...(manageDns ? { manageDns: true } : {}) } })
              }
            >
              Go live
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <JobProgress job={run.job} logs={run.logs} />
          {done && (
            <div className="flex justify-end">
              <Button onClick={onClose}>{run.job?.status === 'succeeded' ? 'Done' : 'Close'}</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// --------------------------------------------------------------- Visitors

const RANGES = [
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

function VisitorsTab({ slug }: { slug: string }) {
  const [days, setDays] = useState(30);
  const [blocking, setBlocking] = useState<string | null>(null);
  const traffic = useSiteTraffic(slug, days);
  // Already in the cache from the page around this tab, and the source of the origin the
  // recorded paths hang off - the log only ever gives us the path.
  const site = useSite(slug);
  const t = traffic.data;

  if (traffic.isError) return <ErrorNote error={traffic.error} />;
  if (!t) return <Spinner />;

  const hourly = t.bucket === 'hour';
  const label = (ts: number) =>
    new Date(ts).toLocaleString(undefined, hourly ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' });
  const perDay = Math.max(1, Math.round(t.days));

  return (
    <div className="space-y-4">
      {!t.collecting && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-medium">Not collecting yet</div>
          <p className="mt-1">
            Traefik is not writing an access log on this server. Redeploy the stack
            (<code>./provision/deploy.sh</code>) to switch it on. Nothing is backfilled.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {RANGES.map((r) => (
            <Button key={r.days} small variant={r.days === days ? 'primary' : 'secondary'} onClick={() => setDays(r.days)}>
              {r.label}
            </Button>
          ))}
        </div>
        <span className="text-xs text-neutral-500">
          updates every minute · crawlers excluded
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Visitors"
          value={t.totals.visitors.toLocaleString()}
          sub={days > 1 ? `${Math.round(t.totals.visitors / perDay).toLocaleString()} a day · daily uniques added up` : 'unique in the last 24h'}
        />
        <StatTile
          label="Page views"
          value={t.totals.pageViews.toLocaleString()}
          sub={`${t.totals.requests.toLocaleString()} requests in total`}
        />
        <StatTile
          label="Traffic"
          value={formatBytes(t.totals.bytes)}
          sub={t.totals.avgMs === null ? 'no requests yet' : `${t.totals.avgMs} ms average response`}
        />
        <StatTile
          label="Crawlers"
          value={t.totals.botRequests.toLocaleString()}
          sub={t.totals.errors > 0 ? `${t.totals.errors.toLocaleString()} server errors (5xx)` : 'no server errors'}
        />
      </div>

      <Card title={hourly ? 'Visitors per hour' : 'Visitors per day'}>
        <BarChart
          data={t.series.map((p) => ({
            ts: p.ts,
            value: p.visitors,
            detail: [`${p.pageViews.toLocaleString()} page views`],
          }))}
          formatValue={(v) => `${v.toLocaleString()} ${v === 1 ? 'visitor' : 'visitors'}`}
          formatLabel={label}
          emptyLabel={t.collecting ? 'No visits recorded in this period.' : 'Nothing collected yet.'}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top pages">
          {t.topPages.length === 0 ? (
            <EmptyState>No page views recorded yet.</EmptyState>
          ) : (
            <TrafficList
              rows={t.topPages.map((p) => ({
                key: p.path,
                label: p.path,
                views: p.views,
                href: pageHref(site.data?.url, p.path),
              }))}
            />
          )}
        </Card>
        <Card title="Where visitors came from">
          {t.topReferrers.length === 0 ? (
            <EmptyState>No referrals recorded.</EmptyState>
          ) : (
            <TrafficList rows={t.topReferrers.map((r) => ({ key: r.referrer, label: r.referrer, views: r.views }))} />
          )}
        </Card>
        <Card title="Countries">
          {!t.countryData ? (
            <EmptyState>The country table has not been downloaded yet.</EmptyState>
          ) : t.topCountries.length === 0 ? (
            <EmptyState>No countries resolved in this period.</EmptyState>
          ) : (
            <>
              <TrafficList
                rows={t.topCountries.map((c) => ({
                  key: c.country,
                  label: `${flagOf(c.country)} ${countryName(c.country)}`,
                  views: c.visitors,
                }))}
              />
              <p className="mt-2 text-xs text-neutral-400">
                Distinct visitors, by the address block's registered country.
              </p>
            </>
          )}
        </Card>
        <Card title="Crawlers">
          {t.topCrawlers.length === 0 ? (
            <EmptyState>No crawler traffic recorded yet.</EmptyState>
          ) : (
            <>
              <TrafficList
                rows={t.topCrawlers.map((c) => ({
                  key: c.crawler,
                  label: c.crawler,
                  views: c.requests,
                  hint: `last seen ${timeAgo(c.lastSeenAt)}`,
                }))}
              />
              <p className="mt-2 text-xs text-neutral-400">Requests, not visitors.</p>
            </>
          )}
        </Card>
      </div>

      <Card title="Busiest addresses">
        {!t.ipsCollected ? (
          <EmptyState>Address collection is off (Settings → Monitoring → Visitor statistics).</EmptyState>
        ) : t.topIps.length === 0 ? (
          <EmptyState>No requests recorded yet.</EmptyState>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2">Address</th>
                  <th className="pb-2">Country</th>
                  <th className="pb-2 text-right">Requests</th>
                  <th className="pb-2 text-right">Pages</th>
                  <th className="pb-2 text-right">Crawler</th>
                  <th className="pb-2 text-right">5xx</th>
                  <th className="pb-2 text-right">Last seen</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {t.topIps.map((row) => (
                  <tr key={row.ip} className="border-t border-neutral-100">
                    <td className="py-2 pr-3 font-mono text-xs">{row.ip}</td>
                    <td className="py-2 pr-3 text-neutral-600">
                      {row.country ? `${flagOf(row.country)} ${row.country}` : '–'}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{row.requests.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">
                      {row.pageViews.toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">
                      {row.botRequests > 0 ? row.botRequests.toLocaleString() : '–'}
                    </td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${row.errors > 0 ? 'text-red-600' : 'text-neutral-500'}`}>
                      {row.errors > 0 ? row.errors.toLocaleString() : '–'}
                    </td>
                    <td className="py-2 text-right text-xs text-neutral-500">{timeAgo(row.lastSeenAt)}</td>
                    <td className="py-2 pl-2 text-right">
                      <Button small variant="ghost" onClick={() => setBlocking(row.ip)}>
                        Block
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-neutral-400">
              Includes crawlers. Addresses are kept {t.ipRetentionDays}{' '}
              {t.ipRetentionDays === 1 ? 'day' : 'days'}.
            </p>
          </>
        )}
      </Card>

      <p className="text-xs text-neutral-500">
        Visitors are counted from a one-way hash of address and browser, under a key discarded every night. Addresses
        themselves are kept only as Settings → Monitoring → Visitor statistics says - and a blocked address for as long as it is
        blocked, and 30 days after.
      </p>
      {blocking && <BlockDialog address={blocking} siteSlug={slug} onClose={() => setBlocking(null)} />}
    </div>
  );
}

/**
 * The backup schedule as a lower-case clause that reads inside a sentence: "Runs at 03:00,
 * every day". Falls back to the raw expression for a pattern the describer cannot read,
 * which is still more use than a word that might be wrong.
 */
function cronSentence(expr: string | undefined): string {
  if (!expr) return 'on the configured schedule';
  const described = describeCron(expr);
  if (!described) return `on the schedule \`${expr}\``;
  return described.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase());
}

/**
 * The page itself, for a path the access log recorded. The host is pinned to the site's own
 * origin rather than resolved from the path: a request line is whatever the client sent, and
 * a logged "//elsewhere.example/" must not turn into a link to elsewhere. Paths the ingest
 * truncated (it caps them at 200 characters) would only 404, so those stay plain text.
 */
function pageHref(siteUrl: string | undefined, path: string): string | undefined {
  if (!siteUrl || path.endsWith('…')) return undefined;
  try {
    const url = new URL(siteUrl);
    url.pathname = path.startsWith('/') ? path : `/${path}`;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Shared "label + count + share" list, with the bar carrying the proportion. */
function TrafficList({
  rows,
}: {
  rows: { key: string; label: string; views: number; hint?: string; href?: string }[];
}) {
  const max = Math.max(...rows.map((r) => r.views), 1);
  return (
    <ul className="space-y-1.5 text-sm">
      {rows.map((r) => (
        <li key={r.key} className="relative flex items-center justify-between gap-3 rounded px-2 py-1">
          <span
            className="absolute inset-y-0 left-0 rounded bg-sky-50"
            style={{ width: `${(r.views / max) * 100}%` }}
            aria-hidden
          />
          {r.href ? (
            <a
              href={r.href}
              target="_blank"
              rel="noreferrer"
              title={`Open ${r.href} in a new tab`}
              className="relative flex min-w-0 items-center gap-1 overflow-hidden text-neutral-800 hover:underline"
            >
              <span className="truncate">{r.label}</span>
              <ExternalLinkIcon />
            </a>
          ) : (
            <span className="relative truncate text-neutral-800" title={r.hint ?? r.label}>
              {r.label}
            </span>
          )}
          <span className="relative shrink-0 tabular-nums text-neutral-500">{r.views.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

// --------------------------------------------------------------- Backups

function BackupsTab({ slug }: { slug: string }) {
  const backups = useBackups(slug);
  const site = useSite(slug);
  const meta = useMeta();
  const run = useRunJob([['backups', slug]]);
  const qc = useQueryClient();
  const serverNameById = new Map((meta.data?.servers ?? []).map((s) => [s.id, s.name]));
  const [restoreId, setRestoreId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [offsiteBusy, setOffsiteBusy] = useState(false);
  const [fetchFor, setFetchFor] = useState<BackupDto | null>(null);
  const scheduled = site.data?.backupsEnabled ?? true;
  const offsite = site.data?.offsiteEnabled ?? true;
  const offsiteConfigured = meta.data?.offsiteConfigured ?? false;
  // Resolved from the list rather than held in state: a refetch that drops the row (it was
  // pruned, or deleted in another tab) closes the dialog instead of rendering half of one.
  const deleteTarget = (backups.data ?? []).find((b) => b.id === deleteId);
  /** Roots that are simply "where backups go"; anything else is worth pointing out. */
  const defaultRoots = new Set((meta.data?.backupRoots ?? []).filter((r) => r.isDefault).map((r) => r.root));
  // Described, not assumed: the schedule is an operator-editable cron expression, so this
  // page has no business calling it "nightly" - it may well be hourly or once a week.
  const schedule = cronSentence(meta.data?.backupCron);

  return (
    <div className="space-y-4">
      <Card title="Scheduled backups">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Toggle
              checked={scheduled}
              onChange={(enabled) => {
                setScheduleBusy(true);
                setActionError(null);
                void api(`/api/sites/${slug}/backups-enabled`, { method: 'PUT', body: { enabled } })
                  .then(() => qc.invalidateQueries({ queryKey: ['site', slug] }))
                  .catch(setActionError)
                  .finally(() => setScheduleBusy(false));
              }}
              label={`Include this site in the periodic backups${scheduleBusy ? ' (saving…)' : ''}`}
            />
            <span className="max-w-xl text-xs text-neutral-500">
              {scheduled && meta.data?.backupsPaused ? (
                // Paused for the whole panel on the Schedules page: this site's switch is on,
                // but saying "Runs at 03:00" would promise a backup that is not coming.
                <span className="text-amber-800">
                  Scheduled backups are <b>paused</b> for every site.{' '}
                  <Link className="underline" to="/jobs/schedules#schedule-backups">
                    Resume them on the Schedules page
                  </Link>
                  .
                </span>
              ) : scheduled ? (
                <>
                  Runs <b>{schedule}</b>. Schedule and retention in Settings.
                </>
              ) : (
                <>
                  Off — the periodic run skips this site. <b>Back up now</b> and the safety copies taken
                  before a restore, move or deletion still work.
                </>
              )}
            </span>
          </div>
          {offsiteConfigured && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-3">
              <Toggle
                checked={offsite}
                onChange={(enabled) => {
                  setOffsiteBusy(true);
                  setActionError(null);
                  void api(`/api/sites/${slug}/offsite-enabled`, { method: 'PUT', body: { enabled } })
                    .then(() => qc.invalidateQueries({ queryKey: ['site', slug] }))
                    .catch(setActionError)
                    .finally(() => setOffsiteBusy(false));
                }}
                label={`Copy this site's backups to a remote destination${offsiteBusy ? ' (saving…)' : ''}`}
              />
              <span className="max-w-xl text-xs text-neutral-500">
                {offsite ? (
                  <>
                    Every new backup is also copied to the{' '}
                    <Link className="underline" to="/backups/storage">remote destinations</Link>.
                  </>
                ) : (
                  <>Off — new backups stay on this server. Existing copies are kept.</>
                )}
              </span>
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Backups"
        action={
          <span className="flex items-center gap-3">
            {(backups.data ?? []).length > 1 && (
              // Ticking several and deleting them at once is the Backups list's, filtered to this site.
              <Link
                to={`/backups?siteSlug=${encodeURIComponent(slug)}`}
                className="text-xs text-neutral-500 transition-colors hover:text-neutral-900 hover:underline"
              >
                Bulk delete
              </Link>
            )}
            <Button small onClick={() => run.mutate({ path: `/api/sites/${slug}/backups`, body: {} })}>
              Back up now
            </Button>
          </span>
        }
      >
        <div className="mb-3">
          <ErrorNote error={run.error} />
          <ErrorNote error={actionError} />
          <JobProgress job={run.job} logs={run.logs} />
        </div>
        {(backups.data ?? []).length === 0 ? (
          <EmptyState>No backups yet.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">When</th>
                <th className="pb-2">Type</th>
                <th className="pb-2">Status</th>
                {offsiteConfigured && <th className="pb-2">Remote</th>}
                <th className="pb-2">WP</th>
                <th className="pb-2 text-right">Size</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {(backups.data ?? []).map((b) => (
                <tr key={b.id} className="border-t border-neutral-100">
                  <td className="py-2 pr-3">
                    <span title={formatDate(b.createdAt)}>{timeAgo(b.createdAt)}</span>
                    {b.note && <div className="text-xs text-neutral-500">{b.note}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={b.type} />
                    {site.data && b.serverId !== site.data.serverId && (
                      <div
                        className="mt-0.5 text-[10px] text-neutral-400"
                        // The path, because on a fleet with per-server locations "on s2" is
                        // no longer enough to find the files by hand.
                        title={b.rootPath ? `${b.rootPath}/${b.siteSlug}/…` : undefined}
                      >
                        on {serverNameById.get(b.serverId) ?? `server #${b.serverId}`}
                      </div>
                    )}
                    {b.rootPath && !defaultRoots.has(b.rootPath) && b.serverId === site.data?.serverId && (
                      <div className="mt-0.5 text-[10px] text-neutral-400" title={`${b.rootPath}/${b.siteSlug}/…`}>
                        on a custom location
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={b.status} />
                    {!b.filesPresent && (
                      <div className="mt-0.5 text-[10px] text-neutral-400">remote only</div>
                    )}
                  </td>
                  {offsiteConfigured && (
                    <td className="py-2 pr-3">
                      <OffsiteBadges copies={b.copies} />
                    </td>
                  )}
                  <td className="py-2 pr-3 text-neutral-600">{b.wpVersion ?? '–'}</td>
                  <td className="py-2 pr-3 text-right text-neutral-500">{formatBytes(b.sizeBytes)}</td>
                  <td className="py-2 text-right">
                    <BackupActions
                      backup={b}
                      canRestore
                      onRestore={() => setRestoreId(b.id)}
                      onFetch={() => setFetchFor(b)}
                      onDelete={() => setDeleteId(b.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {restoreId !== null && (
        <RestoreBackupDialog
          onConfirm={() => run.mutate({ path: `/api/backups/${restoreId}/restore`, body: {} })}
          onClose={() => setRestoreId(null)}
        />
      )}
      {deleteTarget && (
        <DeleteBackupDialog
          backup={deleteTarget}
          onClose={() => setDeleteId(null)}
          onDone={() => qc.invalidateQueries({ queryKey: ['backups', slug] })}
          onError={setActionError}
        />
      )}
      {fetchFor && (
        <FetchBackDialog
          backup={fetchFor}
          onClose={() => setFetchFor(null)}
          onConfirm={(destinationId) => {
            setActionError(null);
            run.mutate({ path: `/api/backups/${fetchFor.id}/fetch`, body: { destinationId } });
            setFetchFor(null);
          }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------- Settings

function SettingsTab({ slug }: { slug: string }) {
  const site = useSite(slug);
  const meta = useMeta();
  const run = useRunJob([['site', slug]]);
  const navigate = useNavigate();
  const [phpVersion, setPhpVersion] = useState<string | null>(null);
  const [domainsText, setDomainsText] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [finalBackup, setFinalBackup] = useState(true);
  const [deleteBackups, setDeleteBackups] = useState(false);
  const s = site.data;
  if (!s) return <Spinner />;

  const effPhp = phpVersion ?? s.phpVersion;
  const effDomains = domainsText ?? s.domains.filter((d) => d !== s.devHostname).join(' ');
  const deleted = run.job?.type === 'site.delete' && run.job.status === 'succeeded';
  useEffect(() => {
    if (deleted) navigate('/sites');
  }, [deleted, navigate]);

  return (
    <div className="space-y-4">
      <Card title="PHP version">
        <div className="flex items-end gap-2">
          <Field label="Version" width="sm">
            <select className={inputClass} value={effPhp} onChange={(e) => setPhpVersion(e.target.value)}>
              {(meta.data?.phpVersions ?? [s.phpVersion]).map((v) => (
                <option key={v} value={v}>PHP {v}</option>
              ))}
            </select>
          </Field>
          <Button
            disabled={effPhp === s.phpVersion || run.isPending}
            onClick={() => run.mutate({ path: `/api/sites/${slug}/php`, method: 'PUT', body: { phpVersion: effPhp } })}
          >
            Switch
          </Button>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          The container is recreated with the new PHP image. Rolls back if the site stops responding.
        </p>
      </Card>

      <Card title="Domains">
        <Field label="Domains (first = primary)" hint="The dev hostname is managed automatically." width="lg">
          <input className={inputClass} value={effDomains} onChange={(e) => setDomainsText(e.target.value)} />
        </Field>
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={run.isPending || effDomains.trim().length === 0}
            onClick={() =>
              run.mutate({
                path: `/api/sites/${slug}/domains`,
                method: 'PUT',
                body: { domains: effDomains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean) },
              })
            }
          >
            Update domains
          </Button>
          <span className="measure text-xs text-amber-700">
            Changing the primary domain rewrites URLs in the database. Take a backup first.
          </span>
        </div>
      </Card>

      <div>
        <ErrorNote error={run.error} />
        <JobProgress job={run.job} logs={run.logs} />
      </div>

      <Card title="Danger zone">
        <div className="flex items-center justify-between">
          <div className="text-sm text-neutral-600">
            Deleting removes the container, database and files{finalBackup ? ' (after a final backup)' : ''}
            {deleteBackups ? (finalBackup ? ', and every other backup' : ', and every backup') : ''}.
          </div>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete site
          </Button>
        </div>
      </Card>

      {deleteOpen && (
        <ConfirmDialog
          title={`Delete ${s.slug}`}
          message={
            <>
              This permanently deletes the site <b>{s.title}</b> — container, database and files.
            </>
          }
          confirmWord={s.slug}
          confirmLabel="Delete site"
          onConfirm={() =>
            run.mutate({
              path: `/api/sites/${slug}?finalBackup=${finalBackup}&deleteBackups=${deleteBackups}`,
              method: 'DELETE',
            })
          }
          onClose={() => setDeleteOpen(false)}
        >
          <div className="space-y-3">
            <Toggle checked={finalBackup} onChange={setFinalBackup} label="Take a final backup first (kept until you delete it)" />
            <DeleteBackupsToggle
              slug={slug}
              checked={deleteBackups}
              onChange={setDeleteBackups}
              finalBackup={finalBackup}
            />
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * The delete dialog's second switch: the backups the site already has go too. Off by default -
 * a site's backups outliving it is the safe way round. With a final backup, that one stays, and
 * is the one backup the site leaves behind. Counted from the site's Backups tab, which lists up
 * to 200; not offered at all to a site that has none.
 */
function DeleteBackupsToggle({
  slug,
  checked,
  onChange,
  finalBackup,
}: {
  slug: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  finalBackup: boolean;
}) {
  const backups = useBackups(slug);
  const items = backups.data ?? [];
  if (backups.data && items.length === 0) return null;
  const n = items.length;
  const remote = items.filter((b) => b.copies.some((c) => c.status === 'complete')).length;
  const label =
    n === 0
      ? 'Delete its existing backups too'
      : `Delete its ${n}${n >= 200 ? '+' : ''} existing backup${n === 1 ? '' : 's'} too${remote > 0 ? ', remote copies included' : ''}`;
  return (
    <div className="space-y-1.5">
      <Toggle checked={checked} onChange={onChange} label={label} />
      {checked && (
        <p className={`ml-11 text-xs ${finalBackup ? 'text-neutral-500' : 'font-medium text-red-700'}`}>
          {finalBackup
            ? 'The final backup is kept: it is the one backup the site leaves behind.'
            : 'Nothing of the site is left afterwards — no files, no database, no backup.'}
        </p>
      )}
    </div>
  );
}
