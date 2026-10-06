// @docs integrations/api
import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiEventDto } from '../../../../shared/types';
import { useApiActivity, useApiKeys } from '../../api/hooks';
import { api } from '../../api/client';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  Field,
  inputClass,
  Modal,
  Spinner,
  StatTile,
} from '../ui';
import { formatDate, timeAgo } from '../../lib/format';

const PAGE_SIZE = 50;

const WINDOWS = [
  { value: 1, label: 'last hour' },
  { value: 24, label: 'last 24 hours' },
  { value: 24 * 7, label: 'last 7 days' },
  { value: 24 * 30, label: 'last 30 days' },
  { value: 0, label: 'everything kept' },
];

const RETENTIONS = [7, 14, 30, 60, 90, 180, 365];

/**
 * A websocket upgrade (the server terminal) is recorded when the shell opens, so it has
 * no duration to report - the alternative was a row that only appears once the session
 * ends, which is the wrong way round for a root shell.
 */
const isUpgrade = (event: ApiEventDto) => event.status === 101;
const tookOf = (event: ApiEventDto) => (isUpgrade(event) ? '–' : `${event.durationMs} ms`);

/** The list always contains what is actually stored - `PUT /settings` takes any 1-365. */
const retentionOptions = (current: number) =>
  RETENTIONS.includes(current) ? RETENTIONS : [...RETENTIONS, current].sort((a, b) => a - b);

/**
 * What the keys have been doing. One row per request that presented a Bearer token -
 * including the ones that were refused, which is the point: a revoked key still in use by
 * some forgotten script shows up here as a run of 401s and nowhere else.
 *
 * The panel's own browser traffic is deliberately absent. It polls itself every fifteen
 * seconds and would bury everything an integration does.
 */
export function ActivityTab() {
  const keys = useApiKeys();
  const qc = useQueryClient();
  const [keyId, setKeyId] = useState<number | ''>('');
  const [outcome, setOutcome] = useState('');
  const [method, setMethod] = useState('');
  const [search, setSearch] = useState('');
  const [hours, setHours] = useState(24);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<ApiEventDto | null>(null);
  const [clearing, setClearing] = useState(false);
  const [savingRetention, setSavingRetention] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const activity = useApiActivity({
    keyId,
    outcome,
    method,
    search,
    hours,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['api-activity'] });
  const total = activity.data?.total ?? 0;
  const stats = activity.data?.last24h;
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(0);
  };

  const setRetention = async (days: number) => {
    setSavingRetention(true);
    setError(null);
    try {
      await api('/api/settings', { method: 'PUT', body: { apiActivityRetentionDays: days } });
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setSavingRetention(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="Requests (24h)" value={stats?.requests ?? '–'} />
        <StatTile label="Errors" value={stats?.errors ?? '–'} sub="4xx and 5xx, excluding refusals" />
        <StatTile label="Refused" value={stats?.denied ?? '–'} sub="401 / 403 — a bad or revoked key" />
        <StatTile label="Keys used" value={stats?.keys ?? '–'} sub="distinct keys in the window" />
      </div>

      {(stats?.denied ?? 0) > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {stats?.denied === 1
            ? '1 request was refused in the last 24 hours.'
            : `${stats?.denied} requests were refused in the last 24 hours.`}{' '}
          Filter to <b>refused</b> below: a token this panel does not know is either a typo in a config file or
          something you did not deploy.
        </div>
      )}

      <ErrorNote error={error} />

      <Card>
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="Key">
            <select
              className={inputClass}
              value={keyId}
              onChange={(e) => reset(setKeyId)(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <option value="">any</option>
              {(keys.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Outcome">
            <select className={inputClass} value={outcome} onChange={(e) => reset(setOutcome)(e.target.value)}>
              <option value="">any</option>
              <option value="ok">ok</option>
              <option value="error">error</option>
              <option value="denied">refused</option>
            </select>
          </Field>
          <Field label="Method">
            <select className={inputClass} value={method} onChange={(e) => reset(setMethod)(e.target.value)}>
              <option value="">any</option>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Path contains">
            <input
              className={inputClass}
              placeholder="/api/sites"
              value={search}
              onChange={(e) => reset(setSearch)(e.target.value)}
            />
          </Field>
          <Field label="Window">
            <select className={inputClass} value={hours} onChange={(e) => reset(setHours)(Number(e.target.value))}>
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card
        title={`${total} request${total === 1 ? '' : 's'}`}
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
        <ErrorNote error={activity.error} />
        {(activity.data?.items ?? []).length === 0 ? (
          <EmptyState>
            {activity.isPending ? (
              <Spinner />
            ) : (
              'Nothing recorded. Only requests made with an API key appear here — what you do in this browser does not.'
            )}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="pb-2">When</th>
                  <th className="pb-2">Key</th>
                  <th className="pb-2">Request</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2 pr-3 text-right">Took</th>
                  <th className="pb-2">From</th>
                </tr>
              </thead>
              <tbody>
                {(activity.data?.items ?? []).map((e) => (
                  <tr
                    key={e.id}
                    className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50"
                    onClick={() => setDetail(e)}
                  >
                    <td className="py-2 pr-3 text-xs text-neutral-500" title={formatDate(e.ts)}>
                      {timeAgo(e.ts)}
                    </td>
                    <td className="py-2 pr-3">
                      <KeyCell event={e} />
                    </td>
                    <td className="max-w-[26rem] truncate py-2 pr-3 font-mono text-xs" title={e.path}>
                      <span className="font-semibold">{e.method}</span> {e.path}
                    </td>
                    <td className="py-2 pr-3">
                      <StatusPill status={e.status} code={e.errorCode} />
                    </td>
                    <td className="py-2 pr-3 text-right text-xs text-neutral-500">{tookOf(e)}</td>
                    <td className="py-2 font-mono text-xs text-neutral-500">{e.ip ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Keeping the log">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Keep requests for"
            width="sm"
            hint="Older rows are deleted in the nightly maintenance run. This is a request log, not a rollup: a client that polls every second writes tens of thousands of rows a day."
          >
            <div className="flex items-center gap-2">
              <select
                className={inputClass}
                disabled={savingRetention || !activity.data}
                value={activity.data?.retentionDays ?? 30}
                onChange={(e) => void setRetention(Number(e.target.value))}
              >
                {retentionOptions(activity.data?.retentionDays ?? 30).map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
              {savingRetention && <Spinner />}
            </div>
          </Field>
          <div className="flex flex-col justify-end gap-2">
            <p className="text-xs text-neutral-500">
              Whatever the period says, the newest{' '}
              <b>{(activity.data?.maxRows ?? 100_000).toLocaleString()}</b> requests are what is kept — a ceiling so
              one runaway client cannot grow the panel database without limit.
            </p>
            <div>
              <Button variant="secondary" small onClick={() => setClearing(true)}>
                Delete the log now
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {detail && <EventModal event={detail} onClose={() => setDetail(null)} />}

      {clearing && (
        <ConfirmDialog
          title="Delete the API request log"
          message="Every recorded request is removed. Keys, and what they can do, are untouched."
          confirmLabel="Delete"
          onConfirm={() => {
            setError(null);
            void api('/api/api-keys/activity', { method: 'DELETE' }).then(refresh).catch(setError);
          }}
          onClose={() => setClearing(false)}
        />
      )}
    </div>
  );
}

/**
 * A refused request has no key behind it - naming the prefix is all that can be said. A call
 * an AI app made over MCP names the key or the connected app, and says it came through MCP.
 */
function KeyCell({ event }: { event: ApiEventDto }) {
  const mcp = event.via === 'mcp' && (
    <span className="ml-1.5 rounded bg-violet-100 px-1 py-0.5 text-[10px] font-semibold text-violet-800" title={event.tool ?? 'MCP'}>
      MCP
    </span>
  );
  if (event.keyId === null && event.connectionId === null) {
    return (
      <span className="text-xs text-amber-700" title="This token matched no live key">
        {event.keyPrefix || 'unknown'}…{mcp}
      </span>
    );
  }
  return (
    <span className="text-xs font-medium">
      {event.keyName}
      {mcp}
    </span>
  );
}

/** Who made a request, in words, for the details dialog. */
function callerOf(event: ApiEventDto): string {
  if (event.connectionId !== null) return `${event.keyName} - an app connected over MCP`;
  if (event.keyId === null) return `unrecognised token ${event.keyPrefix}…${event.via === 'mcp' ? ' (at the MCP endpoint)' : ''}`;
  return `${event.keyName} (${event.keyPrefix}…)${event.via === 'mcp' ? ' via MCP' : ''}`;
}

function StatusPill({ status, code }: { status: number; code: string | null }) {
  const tone =
    status < 400
      ? 'bg-emerald-100 text-emerald-800'
      : status === 401 || status === 403
        ? 'bg-amber-100 text-amber-800'
        : 'bg-red-100 text-red-800';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`} title={code ?? undefined}>
      {status}
      {code && status >= 400 ? ` ${code}` : ''}
    </span>
  );
}

function EventModal({ event, onClose }: { event: ApiEventDto; onClose: () => void }) {
  const rows: [string, React.ReactNode][] = [
    ['When', formatDate(event.ts)],
    ['Key', callerOf(event)],
    ...(event.tool ? ([['Tool', <code key="t">{event.tool}</code>]] as [string, React.ReactNode][]) : []),
    ['Request', <code key="r">{`${event.method} ${event.path}`}</code>],
    ['Route', event.route ? <code key="rt">{event.route}</code> : 'no route matched'],
    ['Status', <StatusPill key="s" status={event.status} code={event.errorCode} />],
    ['Took', tookOf(event)],
    ['From', event.ip ?? '–'],
    ['Client', event.userAgent ?? '–'],
  ];
  return (
    <Modal title="Request" onClose={onClose}>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-24 shrink-0 text-neutral-500">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {isUpgrade(event) && (
        <p className="mt-4 text-xs text-neutral-500">
          101 is a websocket upgrade — this key opened an interactive root shell on the server. The row is written
          when the shell opens, so there is no duration and no second row when it closes.
        </p>
      )}
      {event.jobId !== null && (
        <div className="mt-4">
          <Link className="text-sm underline" to={`/jobs/${event.jobId}`} onClick={onClose}>
            Job #{event.jobId} this call started →
          </Link>
        </div>
      )}
    </Modal>
  );
}
