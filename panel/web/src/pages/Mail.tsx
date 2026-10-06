// @docs mail/overview, mail/setup, mail/traffic
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type {
  MailDomainDto,
  MailMessageDto,
  MailPublishResult,
  MailRecordCheck,
  MailServerSetupDto,
  MailSetupStep,
  MailSiteStatsDto,
} from '../../../shared/types';
import {
  useMailDomains,
  useMailMessages,
  useMailQueue,
  useMailSetup,
  useMailStats,
  useMailStatus,
  useMeta,
  useServers,
  useSites,
} from '../api/hooks';
import { api } from '../api/client';
import {
  Button,
  Card,
  ConfirmDialog,
  CopyField,
  EmptyState,
  ErrorNote,
  Field,
  inputClass,
  Modal,
  Spinner,
  StatusBadge,
  Tabs,
  UpDot,
} from '../components/ui';
import { formatBytes, formatDate, timeAgo } from '../lib/format';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'setup', label: 'Setup guide' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'queue', label: 'Queue' },
  { id: 'deliverability', label: 'DKIM & DMARC' },
];

export function Mail() {
  const [tab, setTab] = useState('overview');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Mail</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Every site sends through one relay per server.
        </p>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'overview' && <OverviewTab />}
      {tab === 'setup' && <SetupTab />}
      {tab === 'traffic' && <TrafficTab />}
      {tab === 'queue' && <QueueTab />}
      {tab === 'deliverability' && <DeliverabilityTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview: is mail working, and a test send

/** `warn`: working, but not the setup it should be - amber rather than a green tick. */
function CheckRow({ ok, warn = false, name, detail }: { ok: boolean; warn?: boolean; name: string; detail: string }) {
  const [glyph, color] = !ok ? ['✗', 'text-red-600'] : warn ? ['!', 'font-bold text-amber-600'] : ['✓', 'text-emerald-600'];
  return (
    <li className="flex items-start gap-2">
      <span className={`inline-block w-3 shrink-0 text-center ${color}`} aria-label={!ok ? 'failed' : warn ? 'warning' : 'ok'}>
        {glyph}
      </span>
      <span>
        <span className="font-medium">{name}</span>
        <span className="ml-2 text-neutral-500">{detail}</span>
      </span>
    </li>
  );
}

function OverviewTab() {
  const status = useMailStatus();
  const stats = useMailStats(24);
  const qc = useQueryClient();

  if (status.isError) return <ErrorNote error={status.error} />;
  if (!status.data) return <Spinner />;

  const anyDirect = status.data.servers.some((s) => s.mode === 'direct');

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Sent (24h)" value={stats.data?.byStatus.sent ?? '–'} />
        <Stat label="Deferred" value={stats.data?.byStatus.deferred ?? '–'} />
        <Stat
          label="Bounced / rejected"
          value={
            stats.data ? stats.data.byStatus.bounced + stats.data.byStatus.rejected + stats.data.byStatus.expired : '–'
          }
        />
        <Stat label="In queue" value={status.data.servers.reduce((n, s) => n + s.queued, 0)} />
      </div>

      {status.data.servers.map((server) => (
        <Card
          key={server.serverId}
          title={
            <span className="flex items-center gap-2">
              <UpDot up={server.ok} />
              {server.serverName}
              <span className="font-normal text-neutral-400">
                {server.mode === 'smarthost' ? `smarthost → ${server.relayhost}` : 'direct delivery'}
              </span>
            </span>
          }
        >
          <ul className="space-y-1.5 text-sm">
            {server.checks.map((c) => (
              <CheckRow key={c.name} ok={c.ok} warn={c.warn} name={c.name} detail={c.detail} />
            ))}
          </ul>
        </Card>
      ))}

      {anyDirect && status.data.reverseDns.length > 0 && (
        <Card title="Reverse DNS (rDNS)">
          <p className="mb-3 text-sm text-neutral-600">
            The server's IP must resolve back to the name its relay announces. Set the PTR record with your VPS
            provider.
          </p>
          <ul className="space-y-1.5 text-sm">
            {status.data.reverseDns.map((r) => (
              <CheckRow key={r.serverId} ok={r.check.verdict === 'ok'} name={`${r.name} (${r.ip})`} detail={r.check.detail} />
            ))}
          </ul>
        </Card>
      )}

      <TestSendCard onSent={() => void qc.invalidateQueries({ queryKey: ['mail-messages'] })} />
      <AbuseCard />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-surface p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-neutral-900">{value}</div>
    </div>
  );
}

function TestSendCard({ onSent }: { onSent: () => void }) {
  const meta = useMeta();
  const servers = useServers();
  const sites = useSites();
  const [mode, setMode] = useState<'relay' | 'site'>('relay');
  const [serverId, setServerId] = useState<number | ''>('');
  const [slug, setSlug] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const effectiveServerId = serverId === '' ? (meta.data?.defaultServerId ?? 1) : serverId;
  const runnableSites = (sites.data ?? []).filter((s) => s.status === 'running');

  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (mode === 'relay') {
        const res = await api<{ detail: string }>('/api/mail/test', {
          method: 'POST',
          body: { serverId: effectiveServerId, from: from.trim(), to: to.trim() },
        });
        setResult(res.detail);
      } else {
        const res = await api<{ accepted: boolean; detail: string }>(`/api/sites/${slug}/wp/test-email`, {
          method: 'POST',
          body: { to: to.trim() },
        });
        setResult(res.detail);
      }
      onSent();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const ready = mode === 'relay' ? !!from.trim() && !!to.trim() : !!slug && !!to.trim();

  return (
    <Card title="Send a test message">
      <div className="space-y-4 text-sm">
        <div className="flex gap-1 rounded-lg bg-neutral-100 p-1 text-xs font-medium">
          <button
            className={`flex-1 rounded-md px-3 py-1.5 ${mode === 'relay' ? 'bg-surface shadow-sm' : 'text-neutral-600'}`}
            onClick={() => setMode('relay')}
          >
            From the relay
          </button>
          <button
            className={`flex-1 rounded-md px-3 py-1.5 ${mode === 'site' ? 'bg-surface shadow-sm' : 'text-neutral-600'}`}
            onClick={() => setMode('site')}
          >
            From a site (wp_mail)
          </button>
        </div>
        <p className="text-neutral-600">
          {mode === 'relay'
            ? 'Injects a message straight into postfix, skipping WordPress.'
            : 'Runs wp_mail() inside the site container — the full path a plugin takes.'}
        </p>
        <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
          {mode === 'relay' ? (
            <>
              <Field label="From">
                <input
                  className={inputClass}
                  placeholder="wordpress@customerdomain.com"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              {(servers.data ?? []).length > 1 && (
                <Field label="Server">
                  <select
                    className={inputClass}
                    value={effectiveServerId}
                    onChange={(e) => setServerId(Number(e.target.value))}
                  >
                    {(servers.data ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </>
          ) : (
            <Field label="Site">
              <select className={inputClass} value={slug} onChange={(e) => setSlug(e.target.value)}>
                <option value="">Pick a running site…</option>
                {runnableSites.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.slug}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="To">
            <input className={inputClass} placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button disabled={!ready || busy} onClick={() => void send()}>
            {busy ? <Spinner /> : 'Send test'}
          </Button>
          {result && <span className="text-neutral-600">{result}</span>}
        </div>
        <ErrorNote error={error} />
      </div>
    </Card>
  );
}

/**
 * The abuse view. A hacked WordPress install being used as a spam relay looks like a
 * volume spike or a wall of bounces, so both are surfaced against the configured budget
 * rather than left for someone to notice in the raw log.
 */
function AbuseCard() {
  const stats = useMailStats(24);
  const flagged = (stats.data?.topSites ?? []).filter((s) => s.overBudget || s.highFailureRate);

  return (
    <Card
      title="Volume by site (24h)"
      action={<span className="text-xs text-neutral-400">budget: {stats.data?.perSiteHourlyBudget ?? '–'} / site / hour</span>}
    >
      {flagged.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>{flagged.length} site(s) worth a look.</strong> Sudden volume or a wall of bounces usually
          means a compromised install. Past the suspension threshold (Settings → Mail) the relay stops
          accepting a site&apos;s mail.
        </div>
      )}
      {(stats.data?.topSites ?? []).length === 0 ? (
        <EmptyState>No mail sent in the last 24 hours.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
              <th className="pb-2">Site</th>
              <th className="pb-2 text-right">Sent</th>
              <th className="pb-2 text-right">Failed</th>
              <th className="pb-2 text-right">Recipients</th>
              <th className="pb-2 text-right">Last</th>
            </tr>
          </thead>
          <tbody>
            {(stats.data?.topSites ?? []).map((s) => (
              <SiteVolumeRow key={s.siteSlug} row={s} />
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function SiteVolumeRow({ row }: { row: MailSiteStatsDto }) {
  const flagged = row.overBudget || row.highFailureRate;
  return (
    <tr
      className={`border-t border-neutral-100 ${row.mailSuspended ? 'bg-rose-50' : flagged ? 'bg-amber-50' : ''}`}
    >
      <td className="py-2 pr-3">
        {row.siteSlug === '(relay)' ? (
          <span className="text-neutral-500">panel / relay</span>
        ) : (
          <Link className="font-medium hover:underline" to={`/sites/${row.siteSlug}`}>
            {row.siteSlug}
          </Link>
        )}
        {row.mailSuspended && <span className="ml-2 text-xs font-semibold text-rose-700">mail suspended</span>}
        {row.overBudget && <span className="ml-2 text-xs font-semibold text-amber-700">high volume</span>}
        {row.highFailureRate && <span className="ml-2 text-xs font-semibold text-amber-700">many failures</span>}
      </td>
      <td className="py-2 pr-3 text-right">{row.sent}</td>
      <td className="py-2 pr-3 text-right">{row.failed || '–'}</td>
      <td className="py-2 pr-3 text-right">{row.uniqueRecipients}</td>
      <td className="py-2 text-right text-xs text-neutral-500">{timeAgo(row.lastAt)}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Traffic

const STATUS_OPTIONS = ['', 'sent', 'deferred', 'bounced', 'rejected', 'queued', 'expired'];
const PAGE_SIZE = 100;

function TrafficTab() {
  const sites = useSites();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [siteSlug, setSiteSlug] = useState('');
  const [search, setSearch] = useState('');
  const [hours, setHours] = useState(24);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<MailMessageDto | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const messages = useMailMessages({
    status: status || undefined,
    siteSlug: siteSlug || undefined,
    search: search || undefined,
    hours,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const refresh = async () => {
    setRefreshing(true);
    // Pull the relay log now rather than waiting out the scheduler's minute.
    await api('/api/mail/ingest', { method: 'POST' }).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['mail-messages'] });
    setRefreshing(false);
  };

  const total = messages.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="Status">
            <select className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s || 'any'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Site">
            <select className={inputClass} value={siteSlug} onChange={(e) => { setSiteSlug(e.target.value); setPage(0); }}>
              <option value="">any</option>
              {(sites.data ?? []).map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.slug}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Window">
            <select className={inputClass} value={hours} onChange={(e) => { setHours(Number(e.target.value)); setPage(0); }}>
              <option value={1}>last hour</option>
              <option value={24}>last 24 hours</option>
              <option value={24 * 7}>last 7 days</option>
              <option value={24 * 30}>last 30 days</option>
            </select>
          </Field>
          <Field label="Sender or recipient">
            <input
              className={inputClass}
              placeholder="name@domain"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </Field>
          <div className="flex items-end">
            <Button variant="secondary" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? <Spinner /> : 'Refresh now'}
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title={`${total} message${total === 1 ? '' : 's'}`}
        action={
          total > PAGE_SIZE && (
            <span className="flex items-center gap-2 text-xs">
              <Button small variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                ←
              </Button>
              <span className="text-neutral-500">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)}
              </span>
              <Button
                small
                variant="ghost"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                →
              </Button>
            </span>
          )
        }
      >
        <ErrorNote error={messages.error} />
        {(messages.data?.items ?? []).length === 0 ? (
          <EmptyState>
            {messages.isPending ? 'Loading…' : 'No mail matched. Traffic appears within a minute of being sent.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2">When</th>
                  <th className="pb-2">Site</th>
                  <th className="pb-2">From</th>
                  <th className="pb-2">To</th>
                  <th className="pb-2">DKIM</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {(messages.data?.items ?? []).map((m) => (
                  <tr
                    key={m.id}
                    className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50"
                    onClick={() => setDetail(m)}
                  >
                    <td className="py-2 pr-3 text-xs text-neutral-500" title={formatDate(m.lastEventAt)}>
                      {timeAgo(m.lastEventAt)}
                    </td>
                    <td className="py-2 pr-3">{m.siteSlug ?? <span className="text-neutral-400">relay</span>}</td>
                    <td className="max-w-[16rem] truncate py-2 pr-3" title={m.from}>
                      {m.from || '–'}
                    </td>
                    <td className="max-w-[16rem] truncate py-2 pr-3" title={m.to}>
                      {m.to || <span className="text-neutral-400">(pending)</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <DkimPill signed={m.dkimSigned} domain={m.dkimDomain} />
                    </td>
                    <td className="py-2">
                      <StatusBadge status={mailBadge(m.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {detail && <MessageModal message={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** Map mail statuses onto the shared badge palette. */
function mailBadge(status: string): string {
  if (status === 'sent') return 'succeeded';
  if (status === 'deferred' || status === 'queued') return 'queued';
  if (status === 'bounced' || status === 'rejected' || status === 'expired') return 'failed';
  return status;
}

function DkimPill({ signed, domain }: { signed: boolean | null; domain: string | null }) {
  if (signed === null) return <span className="text-xs text-neutral-400">–</span>;
  return signed ? (
    <span className="text-xs font-medium text-emerald-700" title={domain ? `d=${domain}` : undefined}>
      signed
    </span>
  ) : (
    <span className="text-xs font-medium text-amber-700">unsigned</span>
  );
}

function MessageModal({ message, onClose }: { message: MailMessageDto; onClose: () => void }) {
  const rows: [string, React.ReactNode][] = [
    ['Queue id', <code key="q">{message.queueId}</code>],
    ['Server', message.serverName],
    ['Site', message.siteSlug ?? 'panel / relay'],
    ['From', message.from || '–'],
    ['To', message.to || '(not yet delivered)'],
    ['Status', <StatusBadge key="s" status={mailBadge(message.status)} />],
    ['DKIM', <DkimPill key="d" signed={message.dkimSigned} domain={message.dkimDomain} />],
    ['Size', formatBytes(message.sizeBytes)],
    ['Relay', message.relay ?? '–'],
    ['DSN', message.dsn ?? '–'],
    ['Delay', message.delayMs !== null ? `${(message.delayMs / 1000).toFixed(2)}s` : '–'],
    ['Accepted', formatDate(message.firstSeenAt)],
    ['Last event', formatDate(message.lastEventAt)],
  ];
  return (
    <Modal title="Message" onClose={onClose}>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {message.detail && (
        <div className="mt-4">
          <div className="mb-1 text-xs uppercase tracking-wide text-neutral-400">Server response</div>
          <pre className="overflow-x-auto rounded-lg bg-[#18191c] p-3 text-xs text-[#f4f4f5]">{message.detail}</pre>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Queue

function QueueTab() {
  const queue = useMailQueue();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<{ serverId: number; name: string } | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['mail-queue'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const items = queue.data ?? [];
  const servers = [...new Map(items.map((i) => [i.serverId, i.serverName])).entries()];

  return (
    <div className="space-y-4">
      <Card
        title="Postfix queue"
        action={
          servers.length > 0 && (
            <div className="flex gap-2">
              {servers.map(([serverId, name]) => (
                <span key={serverId} className="flex gap-1">
                  <Button
                    small
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void act(() => api(`/api/mail/queue/${serverId}/flush`, { method: 'POST' }))}
                  >
                    Retry all{servers.length > 1 ? ` (${name})` : ''}
                  </Button>
                  <Button small variant="ghost" disabled={busy} onClick={() => setPurgeTarget({ serverId, name })}>
                    Empty
                  </Button>
                </span>
              ))}
            </div>
          )
        }
      >
        <p className="mb-3 text-sm text-neutral-600">
          Accepted but not yet delivered. A few deferred entries are normal; a growing queue is not.
        </p>
        <ErrorNote error={error} />
        {items.length === 0 ? (
          <EmptyState>{queue.isPending ? 'Loading…' : 'Queue is empty.'}</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2">Queued</th>
                <th className="pb-2">Site</th>
                <th className="pb-2">From → to</th>
                <th className="pb-2">Queue</th>
                <th className="pb-2 text-right">Size</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.serverId}-${item.queueId}`} className="border-t border-neutral-100 align-top">
                  <td className="py-2 pr-3 text-xs text-neutral-500" title={formatDate(item.arrivalTime)}>
                    {timeAgo(item.arrivalTime)}
                  </td>
                  <td className="py-2 pr-3">{item.siteSlug ?? <span className="text-neutral-400">relay</span>}</td>
                  <td className="py-2 pr-3">
                    <div className="truncate">{item.sender || '–'}</div>
                    {item.recipients.map((r) => (
                      <div key={r.address} className="text-xs text-neutral-500">
                        → {r.address}
                        {r.reason && <div className="text-amber-700">{r.reason}</div>}
                      </div>
                    ))}
                  </td>
                  <td className="py-2 pr-3 text-xs">{item.queueName}</td>
                  <td className="py-2 pr-3 text-right text-xs text-neutral-500">{formatBytes(item.sizeBytes)}</td>
                  <td className="py-2 text-right">
                    <Button
                      small
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api(`/api/mail/queue/${item.serverId}/${item.queueId}`, { method: 'DELETE' }))
                      }
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {purgeTarget && (
        <ConfirmDialog
          title={`Empty the queue on "${purgeTarget.name}"`}
          confirmWord="delete"
          confirmLabel="Delete all queued mail"
          message="Every message still waiting on this server is discarded, including mail deferred on a temporary failure."
          onConfirm={() => void act(() => api(`/api/mail/queue/${purgeTarget.serverId}/ALL`, { method: 'DELETE' }))}
          onClose={() => setPurgeTarget(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deliverability: DKIM / SPF / DMARC

const VERDICT_STYLE: Record<MailRecordCheck['verdict'], string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  missing: 'text-neutral-500',
  error: 'text-red-700',
};
const VERDICT_MARK: Record<MailRecordCheck['verdict'], string> = { ok: '✓', warn: '!', missing: '·', error: '✗' };

function CheckLine({ label, check }: { label: string; check: MailRecordCheck }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={`w-4 shrink-0 text-center font-bold ${VERDICT_STYLE[check.verdict]}`}>
        {VERDICT_MARK[check.verdict]}
      </span>
      <span className="w-16 shrink-0 font-medium">{label}</span>
      <span className="min-w-0 text-neutral-600">{check.detail}</span>
    </div>
  );
}

function DeliverabilityTab() {
  const domains = useMailDomains(true);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<MailDomainDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['mail-domains'] });
      await qc.invalidateQueries({ queryKey: ['mail-status'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const items = domains.data ?? [];

  return (
    <div className="space-y-4">
      <Card title="How this works">
        <div className="space-y-2 text-sm text-neutral-600">
          <p>
            Three DNS records, added once per domain in the <em>customer&apos;s</em> zone.
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <strong>SPF</strong> — which servers may send for the domain. Exactly one TXT record at the root.
            </li>
            <li>
              <strong>DKIM</strong> — a signature on every message. Generate the key here, publish the record.
            </li>
            <li>
              <strong>DMARC</strong> — what a receiver does when both fail. Start at <code>p=none</code>.
            </li>
          </ul>
        </div>
      </Card>

      <ErrorNote error={error} />

      <Card
        title="Domains"
        action={
          <Button small variant="secondary" disabled={busy !== null} onClick={() => void act('sync', () => api('/api/mail/dkim/sync', { method: 'POST' }))}>
            {busy === 'sync' ? <Spinner /> : 'Re-sync signers'}
          </Button>
        }
      >
        {items.length === 0 ? (
          <EmptyState>{domains.isPending ? 'Checking DNS…' : 'No sending domains yet — create a site first.'}</EmptyState>
        ) : (
          <div className="space-y-4">
            {items.map((d) => (
              <div key={d.domain} className="rounded-xl border border-neutral-200 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">{d.domain}</span>
                    <span className="ml-2 text-xs text-neutral-500">
                      {d.sites.length > 0 ? d.sites.join(', ') : 'no site uses this domain'}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <Button small variant="secondary" onClick={() => setOpen(d)}>
                      Records
                    </Button>
                    {d.dkimKey ? (
                      <>
                        <Button
                          small
                          variant="secondary"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(d.domain, () =>
                              api('/api/mail/dkim', { method: 'POST', body: { domain: d.domain, rotate: true } }),
                            )
                          }
                        >
                          {busy === d.domain ? <Spinner /> : 'Rotate key'}
                        </Button>
                        <Button small variant="ghost" disabled={busy !== null} onClick={() => setDeleteTarget(d.domain)}>
                          Remove key
                        </Button>
                      </>
                    ) : (
                      <Button
                        small
                        disabled={busy !== null}
                        onClick={() => void act(d.domain, () => api('/api/mail/dkim', { method: 'POST', body: { domain: d.domain } }))}
                      >
                        {busy === d.domain ? <Spinner /> : 'Enable DKIM'}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  <CheckLine label="SPF" check={d.spf} />
                  <CheckLine label="DKIM" check={d.dkim} />
                  <CheckLine label="DMARC" check={d.dmarc} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {open && <RecordsModal domain={open} onClose={() => setOpen(null)} />}
      {deleteTarget && (
        <ConfirmDialog
          title={`Remove the DKIM key for "${deleteTarget}"`}
          confirmLabel="Remove key"
          message={
            <>
              Mail from this domain stops being signed immediately. Remove its <code>_domainkey</code> TXT record
              from DNS as well.
            </>
          }
          onConfirm={() => void act(deleteTarget, () => api(`/api/mail/dkim/${deleteTarget}`, { method: 'DELETE' }))}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

function RecordsModal({ domain, onClose }: { domain: MailDomainDto; onClose: () => void }) {
  const [checking, setChecking] = useState(false);
  const qc = useQueryClient();

  const recheck = async () => {
    setChecking(true);
    await api(`/api/mail/domains/${domain.domain}/check`, { method: 'POST' }).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['mail-domains'] });
    setChecking(false);
  };

  return (
    <Modal title={`DNS records for ${domain.domain}`} onClose={onClose}>
      <div className="space-y-5 text-sm">
        <section>
          <h4 className="mb-1 font-semibold">1. SPF</h4>
          <p className="mb-2 text-neutral-600">
            TXT record on <code>{domain.domain}</code>. Merge into an existing SPF record rather than adding a
            second one.
          </p>
          <CopyField value={domain.suggestedSpf} tone="plain" />
          <CheckLine label="Now" check={domain.spf} />
        </section>

        <section>
          <h4 className="mb-1 font-semibold">2. DKIM</h4>
          {domain.dkimKey ? (
            <>
              <p className="mb-2 text-neutral-600">
                TXT record on <code>{domain.dkimKey.recordName}</code>.
              </p>
              <CopyField value={domain.dkimKey.recordValue} tone="plain" />
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-neutral-500">
                  Zone-file form (BIND)
                </summary>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-[#18191c] p-3 text-xs text-[#f4f4f5]">
                  {domain.dkimKey.recordBind}
                </pre>
              </details>
            </>
          ) : (
            <p className="text-neutral-600">
              No key yet — use <strong>Enable DKIM</strong> to generate one.
            </p>
          )}
          <CheckLine label="Now" check={domain.dkim} />
        </section>

        <section>
          <h4 className="mb-1 font-semibold">3. DMARC</h4>
          <p className="mb-2 text-neutral-600">
            TXT record on <code>_dmarc.{domain.domain}</code>. Publish SPF and DKIM first.
          </p>
          <CopyField value={domain.suggestedDmarc} tone="plain" />
          <CheckLine label="Now" check={domain.dmarc} />
        </section>

        <div className="flex justify-between">
          <Button variant="secondary" disabled={checking} onClick={() => void recheck()}>
            {checking ? <Spinner /> : 'Check DNS again'}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Setup guide: what to do, in order, and what the panel can do for you

const VERDICT_PILL: Record<MailRecordCheck['verdict'], string> = {
  ok: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-800',
  missing: 'bg-neutral-200 text-neutral-700',
  error: 'bg-red-100 text-red-800',
};
const VERDICT_WORD: Record<MailRecordCheck['verdict'], string> = {
  ok: 'done',
  warn: 'check',
  missing: 'to do',
  error: 'wrong',
};

function VerdictPill({ verdict }: { verdict: MailRecordCheck['verdict'] }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${VERDICT_PILL[verdict]}`}>
      {VERDICT_WORD[verdict]}
    </span>
  );
}

/** A server or a sending domain, as the step's picker sees it. */
interface SetupEntity {
  id: string;
  label: string;
  ready: boolean;
}

/** Everything one server owes: its hostname resolves here, its PTR matches, port 25 is open. */
const serverReady = (s: MailServerSetupDto): boolean =>
  s.hostnameA.verdict === 'ok' && s.reverseDns.verdict === 'ok' && (s.port25?.ok ?? true);

/**
 * One numbered step on the rail. A step whose items are all green is ticked off; the rest
 * keep their number, so the guide reads as a sequence rather than a pile of cards.
 */
function SetupStep({
  n,
  title,
  count,
  done,
  intro,
  last,
  children,
}: {
  n: number;
  title: string;
  count?: string;
  done?: boolean;
  intro?: ReactNode;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="setup-step">
      <div className="setup-rail">
        <span className={`setup-marker ${done ? 'setup-marker-done' : ''}`}>{done ? '✓' : n}</span>
        {!last && <span className="setup-line" />}
      </div>
      <div className="setup-body">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
          {count && <span className="text-xs text-neutral-500">{count}</span>}
        </div>
        {intro && <p className="mt-1 text-sm text-neutral-600">{intro}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </section>
  );
}

/**
 * Which server or domain the step is showing. A fleet is a row of chips rather than a stack
 * of panels: the chips say what is left, the panel below says how to do it. Hidden when
 * there is nothing to choose between.
 */
function EntityPicker({
  items,
  active,
  onPick,
}: {
  items: SetupEntity[];
  active: string;
  onPick: (id: string) => void;
}) {
  if (items.length < 2) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onPick(item.id)}
          className={`entity-chip ${item.id === active ? 'entity-chip-active' : ''}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${item.ready ? 'bg-emerald-500' : 'bg-amber-400'}`} />
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** One thing to get right, with its live verdict and an optional action. */
function SetupCheck({
  verdict,
  title,
  action,
  children,
}: {
  verdict: MailRecordCheck['verdict'];
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-neutral-100 pt-4 first:border-0 first:pt-0">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <VerdictPill verdict={verdict} />
        <span className="font-medium">{title}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

function SetupTab() {
  const qc = useQueryClient();
  const setup = useMailSetup(true);
  const [rechecking, setRechecking] = useState(false);
  // Null until something is picked, so the default keeps following the data as checks pass.
  const [pickedServer, setPickedServer] = useState<number | null>(null);
  const [pickedDomain, setPickedDomain] = useState<string | null>(null);

  const recheck = async () => {
    setRechecking(true);
    await qc.invalidateQueries({ queryKey: ['mail-setup'] });
    await qc.invalidateQueries({ queryKey: ['mail-domains'] });
    setRechecking(false);
  };

  if (setup.isError) return <ErrorNote error={setup.error} />;
  if (!setup.data) {
    return (
      <div className="py-10 text-center text-sm text-neutral-500">
        <Spinner /> <span className="ml-2">Checking DNS…</span>
      </div>
    );
  }

  const { mode, dns, servers, rdnsGuides, domains } = setup.data;
  const direct = mode === 'direct';
  const serversReady = servers.filter(serverReady).length;
  const domainsReady = domains.filter((d) => d.ready).length;
  // Opens on the first thing that still needs work, which is where the operator was heading.
  const server =
    servers.find((s) => s.serverId === pickedServer) ?? servers.find((s) => !serverReady(s)) ?? servers[0];
  const domain = domains.find((d) => d.domain === pickedDomain) ?? domains.find((d) => !d.ready) ?? domains[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-neutral-600">
          Mail leaves this fleet{' '}
          <strong>{direct ? 'directly, from these servers' : 'through your SMTP provider'}</strong>. Every step
          below is checked against public DNS.
        </p>
        <Button variant="secondary" disabled={rechecking} onClick={() => void recheck()}>
          {rechecking ? <Spinner /> : 'Check DNS again'}
        </Button>
      </div>

      <AutomationNote configured={dns.configured} provider={dns.provider} hint={dns.hint} />

      <div>
        <SetupStep
          n={1}
          title="Servers"
          count={servers.length > 0 ? `${serversReady} of ${servers.length} ready` : undefined}
          done={servers.length > 0 && serversReady === servers.length}
          intro={
            direct
              ? 'Hostname, reverse DNS and port 25 — once per server, not per customer.'
              : 'Less critical with a smarthost, but a correct hostname keeps bounces readable.'
          }
        >
          {server ? (
            <>
              <EntityPicker
                items={servers.map((s) => ({ id: String(s.serverId), label: s.name, ready: serverReady(s) }))}
                active={String(server.serverId)}
                onPick={(id) => setPickedServer(Number(id))}
              />
              <ServerSetupPanel
                key={server.serverId}
                server={server}
                rdnsGuides={rdnsGuides}
                onChanged={() => void recheck()}
              />
            </>
          ) : (
            <p className="text-sm text-neutral-500">No servers yet.</p>
          )}
        </SetupStep>

        <SetupStep
          n={2}
          title="Sending domains"
          count={domains.length > 0 ? `${domainsReady} of ${domains.length} ready` : undefined}
          done={domains.length > 0 && domainsReady === domains.length}
          intro={
            <>
              SPF, DKIM and DMARC, in the <em>customer’s</em> DNS zone. Publish them in the order shown.
            </>
          }
        >
          {domain ? (
            <>
              <EntityPicker
                items={domains.map((d) => ({ id: d.domain, label: d.domain, ready: d.ready }))}
                active={domain.domain}
                onPick={setPickedDomain}
              />
              <DomainSetupPanel key={domain.domain} domain={domain} onPublished={() => void recheck()} />
            </>
          ) : (
            <p className="text-sm text-neutral-500">No sending domains yet — create a site first.</p>
          )}
        </SetupStep>

        <SetupStep n={3} title="Prove it works" last>
          <ul className="ml-4 list-disc space-y-1.5 text-sm text-neutral-600">
            <li>
              <strong>Overview → Send a test message</strong>, once from the relay and once from a site, to a
              Gmail or Outlook address.
            </li>
            <li>
              Check the received headers for <code>DKIM-Signature</code> and for <code>spf=pass</code> /{' '}
              <code>dkim=pass</code> in <code>Authentication-Results</code>.
            </li>
            <li>
              <strong>Traffic</strong> shows the receiving server’s reply; <strong>Queue</strong> shows what could
              not be delivered.
            </li>
            {direct && <li>Warm new IPs up with modest volume for the first couple of weeks.</li>}
          </ul>
        </SetupStep>
      </div>
    </div>
  );
}

/**
 * The honest answer to "can this be automatic?" — yes for DNS records when the panel holds
 * a provider token, never for reverse DNS, which lives outside any DNS zone.
 */
function AutomationNote({ configured, provider, hint }: { configured: boolean; provider: string; hint: string }) {
  if (configured) {
    return (
      <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        <strong>Automatic publishing is on{provider ? ` (${provider})` : ''}.</strong> Use the <em>Publish</em>{' '}
        buttons below for any domain whose zone is in that account. Reverse DNS stays manual.
      </p>
    );
  }
  return (
    <p className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
      <strong>Everything below can be automated.</strong> {hint}{' '}
      <Link className="font-medium underline" to="/settings?tab=dns">
        Settings → DNS
      </Link>
    </p>
  );
}

function ServerSetupPanel({
  server,
  rdnsGuides,
  onChanged,
}: {
  server: MailServerSetupDto;
  rdnsGuides: { id: string; name: string; steps: string[] }[];
  onChanged: () => void;
}) {
  const [guideId, setGuideId] = useState(rdnsGuides[0]?.id ?? 'other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [editingHostname, setEditingHostname] = useState(false);
  // What the dialog did, said here once it has closed: by then the checks below are about the new name.
  const [hostnameNote, setHostnameNote] = useState<string | null>(null);
  const guide = rdnsGuides.find((g) => g.id === guideId) ?? rdnsGuides[0];

  const publishHostname = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/mail/servers/${server.serverId}/publish-hostname`, { method: 'POST' });
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-neutral-800">{server.name}</span>
        <span className="text-xs text-neutral-500">
          {server.ip || 'no public IP'} · {server.mode === 'smarthost' ? 'smarthost' : 'direct delivery'}
        </span>
      </div>
      <ErrorNote error={error} />

      <SetupCheck
        verdict={server.hostnameA.verdict}
        title="Point the mail hostname at this server"
        action={
          <Button small variant="secondary" onClick={() => setEditingHostname(true)}>
            Change hostname
          </Button>
        }
      >
        <p className="text-neutral-600">
          The relay announces itself as <code>{server.hostname || '(not reported yet)'}</code>, which needs an A
          record here before reverse DNS is trusted.
          {server.hostnameOverride !== null && (
            <>
              {' '}
              It was set in the panel
              {server.defaultHostname && (
                <>
                  ; the default is <code>{server.defaultHostname}</code>
                </>
              )}
              .
            </>
          )}
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
          <CopyField
            value={`${server.hostname || 'mail.example.com'}.  A  ${server.ip || '<server IP>'}`}
            tone="plain"
          />
          {server.hostnameAutomatable && server.hostnameA.verdict !== 'ok' && (
            <Button disabled={busy} onClick={() => void publishHostname()}>
              {busy ? <Spinner /> : 'Publish A record'}
            </Button>
          )}
        </div>
        <p className="mt-1 text-xs text-neutral-500">{server.hostnameA.detail}</p>
        {hostnameNote && <p className="mt-2 text-xs text-emerald-700">{hostnameNote}</p>}
        {editingHostname && (
          <HostnameDialog
            server={server}
            onClose={() => setEditingHostname(false)}
            onDone={(detail) => {
              setEditingHostname(false);
              setHostnameNote(detail);
              onChanged();
            }}
          />
        )}
      </SetupCheck>

      <SetupCheck
        verdict={server.reverseDns.verdict}
        title={`Set reverse DNS (PTR) for ${server.ip || 'the server IP'}`}
      >
        <p className="text-neutral-600">
          Set where you rented the server, not in your own DNS. Use exactly the hostname above.
        </p>
        <div className="mt-2">
          <CopyField value={server.hostname || 'mail.example.com'} tone="plain" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-neutral-500">Where did you rent this server?</span>
          <select
            className={`${inputClass} w-auto py-1 text-xs`}
            value={guideId}
            onChange={(e) => setGuideId(e.target.value)}
          >
            {rdnsGuides.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        {guide && (
          <ol className="mt-2 ml-5 list-decimal space-y-1 text-neutral-600">
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-xs text-neutral-500">{server.reverseDns.detail}</p>
      </SetupCheck>

      {server.port25 && (
        <SetupCheck verdict={server.port25.ok ? 'ok' : 'error'} title="Outbound port 25">
          <p className="text-neutral-600">
            Most providers block port 25 for new accounts until you ask. Otherwise set{' '}
            <code>SMTP_RELAYHOST</code> and relay through a provider.
          </p>
          <p className="mt-1 text-xs text-neutral-500">{server.port25.detail}</p>
        </SetupCheck>
      )}
    </div>
  );
}

function DomainSetupPanel({ domain, onPublished }: { domain: MailDomainDto; onPublished: () => void }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MailPublishResult[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const publishable = domain.steps.filter((s) => s.automation.state === 'ready');
  const done = domain.steps.filter((s) => s.automation.state === 'satisfied').length;

  const publish = async () => {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await api<{ results: MailPublishResult[] }>(`/api/mail/domains/${domain.domain}/publish`, {
        method: 'POST',
      });
      setResults(res.results);
      onPublished();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-neutral-800">{domain.domain}</span>
        {domain.ready ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
            ready
          </span>
        ) : (
          <span className="text-xs text-neutral-500">
            {done}/{domain.steps.length} done
          </span>
        )}
        <span className="text-xs text-neutral-400">
          · {domain.sites.length > 0 ? domain.sites.join(', ') : 'no site uses this domain'}
        </span>
        {publishable.length > 0 && (
          <span className="ml-auto">
            <Button small disabled={busy} onClick={() => void publish()}>
              {busy ? <Spinner /> : `Publish ${publishable.length} record${publishable.length === 1 ? '' : 's'}`}
            </Button>
          </span>
        )}
      </div>
      <ErrorNote error={error} />
      {results && <PublishResults results={results} />}
      {domain.steps.map((step, i) => (
        <SetupStepBlock key={step.id} n={i + 1} step={step} />
      ))}
    </div>
  );
}

const OUTCOME_STYLE: Record<MailPublishResult['outcome'], string> = {
  created: 'text-emerald-700',
  updated: 'text-emerald-700',
  unchanged: 'text-neutral-500',
  skipped: 'text-amber-700',
  failed: 'text-red-700',
};

function PublishResults({ results }: { results: MailPublishResult[] }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm">
      <div className="mb-1 font-medium">What the panel just did</div>
      <ul className="space-y-1">
        {results.map((r) => (
          <li key={r.step}>
            <span className="inline-block w-14 font-mono text-xs uppercase text-neutral-500">{r.step}</span>
            <span className={`font-medium ${OUTCOME_STYLE[r.outcome]}`}>{r.outcome}</span>
            <span className="ml-2 text-neutral-600">{r.detail}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-neutral-500">
        Public DNS can take a few minutes to catch up — use <em>Check DNS again</em> above once it has.
      </p>
    </div>
  );
}

function SetupStepBlock({ n, step }: { n: number; step: MailSetupStep }) {
  const auto = step.automation;
  const value = auto.plannedValue ?? step.record.value;
  return (
    <section className="border-t border-neutral-100 pt-4 first:border-0 first:pt-0">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-neutral-400">{n}.</span>
        <VerdictPill verdict={step.status.verdict} />
        <span className="font-medium">{step.title}</span>
      </div>
      <p className="text-sm text-neutral-600">{step.why}</p>

      {auto.state === 'satisfied' ? (
        <p className="mt-2 text-sm text-emerald-700">✓ {auto.detail}</p>
      ) : (
        <>
          <div className="mt-2 grid gap-1 text-xs sm:grid-cols-[4rem_1fr]">
            <span className="text-neutral-400">Type</span>
            <span className="font-mono">{step.record.type}</span>
            <span className="text-neutral-400">Name</span>
            <span className="font-mono break-all">{step.record.name}</span>
          </div>
          {value && (
            <div className="mt-1">
              <CopyField value={value} tone="plain" />
            </div>
          )}
          <p className={`mt-1 text-xs ${auto.state === 'ready' ? 'text-emerald-700' : 'text-neutral-500'}`}>
            {auto.state === 'ready' ? 'The panel can publish this for you: ' : ''}
            {auto.detail}
          </p>
        </>
      )}
      {/*
        Only worth showing what is published when something IS published and it is wrong -
        for a record that simply does not exist yet, `why` and the automation line have
        already said so, and a third sentence saying "not published" is noise.
      */}
      {step.status.found && step.status.verdict !== 'ok' && (
        <>
          <p className="mt-2 text-xs text-neutral-400">Published right now</p>
          <p className="text-xs text-neutral-500">
            <code className="break-all">{step.status.found}</code>
          </p>
          <p className="mt-1 text-xs text-neutral-500">{step.status.detail}</p>
        </>
      )}
    </section>
  );
}


/**
 * Changing the name the relay announces, or going back to the default. The value is
 * per-server: `MAIL_HOSTNAME` in `deploy/.env` is the default, and a name set here overrides it
 * from then on (the panel cannot reach the checkout on its own server, so it keeps the override
 * under /srv instead, where compose reads it back).
 */
function HostnameDialog({
  server,
  onClose,
  onDone,
}: {
  server: MailServerSetupDto;
  onClose: () => void;
  onDone: (detail: string) => void;
}) {
  const [value, setValue] = useState(server.hostname);
  const [busy, setBusy] = useState<'apply' | 'reset' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const next = value.trim().toLowerCase();
  const changed = next !== '' && next !== server.hostname;
  const overridden = server.hostnameOverride !== null;

  const send = async (action: 'apply' | 'reset') => {
    setBusy(action);
    setError(null);
    try {
      const res = await api<{ effective: string; applied: boolean; detail: string }>(
        `/api/mail/servers/${server.serverId}/hostname`,
        action === 'apply' ? { method: 'PUT', body: { hostname: next } } : { method: 'DELETE' },
      );
      onDone(res.detail);
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  return (
    <Modal title={`Mail hostname: ${server.name}`} onClose={onClose} dismissible={!changed && busy === null}>
      <form
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed && busy === null) void send('apply');
        }}
      >
        <Field label="Hostname" hint="Any name you control and can resolve. It need not be the panel's domain.">
          <input
            className={`${inputClass} font-mono`}
            value={value}
            placeholder="smtp.example.com"
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </Field>

        <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">Default</span>
            <code className="text-xs">{server.defaultHostname ?? 'unknown'}</code>
            {!overridden && server.defaultHostname !== null && <span className="text-xs text-neutral-500">· in use</span>}
            {overridden && (
              <span className="ml-auto">
                <Button small variant="secondary" disabled={busy !== null} onClick={() => void send('reset')}>
                  {busy === 'reset' ? <Spinner /> : 'Reset to default'}
                </Button>
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            <code>MAIL_HOSTNAME</code> in <code>deploy/.env</code>.{' '}
            {server.defaultHostname === null && 'The relay did not say which name that is: it is not running, or not answering. '}
            {overridden && (
              <>
                The name in use, <code>{server.hostnameOverride}</code>, was set in the panel and wins over it.
              </>
            )}
          </p>
        </div>

        <ErrorNote error={error} />
        <p className="text-xs text-neutral-500">
          Applied immediately, and kept when the relay restarts. Receivers treat a new name as a new sender, and
          the A record and reverse DNS read red until they point at it.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!changed || busy !== null}>
            {busy === 'apply' ? <Spinner /> : 'Apply'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
