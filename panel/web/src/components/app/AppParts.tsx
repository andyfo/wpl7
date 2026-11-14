// @docs sites/container
/**
 * A container app's own parts of its page: the label beside its name, its image on the Overview,
 * the Deploys tab and the Logs tab.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppDeployDto, JobDto, SiteDetail } from '../../../../shared/types';
import type { AppDeployOrigin } from '../../../../shared/schemas';
import { api } from '../../api/client';
import { useRunJob } from '../../api/hooks';
import { imageOf, shortDigest, uploadAppImage, useAppLogs } from '../../api/apps';
import { useFollowJob } from '../jobConsole/context';
import { Button, Card, EmptyState, ErrorNote, Spinner, Toggle } from '../ui';
import { formatDate, timeAgo } from '../../lib/format';

/** Beside a container app's name, in the site list and on its page. */
export function AppLabel() {
  return (
    <span
      className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-teal-800"
      title="A container app: one container from your own image"
    >
      App
    </span>
  );
}

const ORIGIN: Record<AppDeployOrigin, string> = {
  create: 'Created',
  auto: 'New image',
  hook: 'Deploy hook',
  user: 'Deploy now',
  rollback: 'Roll back',
  upload: 'Upload',
};

const UPDATES = { auto: 'Automatic', ask: 'Ask first', pinned: 'Pinned' } as const;

/** The image an app runs, and what deploys it: on its Overview. */
export function AppImageCard({ site }: { site: SiteDetail }) {
  const app = site.container!;
  const run = useRunJob([['site', site.slug], ['app-deploys', site.slug]]);
  const last = app.deploys[0];
  const registry = app.source === 'registry';
  const routes = { serving: 'In force', held: 'Held for a deploy (503)', none: 'Off while it is stopped' }[app.routesState];
  return (
    <Card title="Image">
      {app.pendingDigest && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <span>
            A new image is waiting: <code>{shortDigest(app.pendingDigest)}</code>
          </span>
          <Button small busy={run.busy('update')} onClick={() => run.mutate({ path: `/api/sites/${site.slug}/app/deploy`, body: {}, action: 'update' })}>
            Update
          </Button>
        </div>
      )}
      <dl className="space-y-2 text-sm">
        <Row label="From">{registry ? <code className="break-all">{app.reference}</code> : 'An uploaded archive'}</Row>
        <Row label="Runs">
          <code>{imageOf(app)}</code>
          {last?.result === 'ok' && <span className="text-neutral-500"> · since {timeAgo(last.startedAt)}</span>}
        </Row>
        <Row label="Updates">
          {UPDATES[app.updates.mode]}
          {registry && app.updates.mode !== 'pinned' && app.updates.checkedAt && (
            <span className="text-neutral-500"> · checked {timeAgo(app.updates.checkedAt)}</span>
          )}
        </Row>
        {app.updates.checkError && <Row label="Last check"><span className="text-red-700">{app.updates.checkError}</span></Row>}
        <Row label="Routes">
          {routes}
          {app.routesProblem && <span className="text-red-700"> · {app.routesProblem}</span>}
        </Row>
        {last && last.result !== 'ok' && (
          <Row label="Last deploy">
            <span className={last.result === 'failed' ? 'text-red-700' : 'text-neutral-600'}>
              {last.result === 'failed' ? 'Failed' : 'Running'} {timeAgo(last.startedAt)}.
            </span>{' '}
            <Link className="underline" to={`/sites/${site.slug}?tab=deploys`}>
              Deploys
            </Link>
          </Row>
        )}
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {registry ? (
          <Button small busy={run.busy('deploy')} onClick={() => run.mutate({ path: `/api/sites/${site.slug}/app/deploy`, body: {}, action: 'deploy' })}>
            Deploy now
          </Button>
        ) : (
          <UploadImageButton slug={site.slug} />
        )}
        <span className="text-xs text-neutral-500">
          {registry ? 'Deploys what the reference names now, behind the health check.' : 'Deploys a new archive behind the health check.'}
        </span>
      </div>
      <ErrorNote error={run.error} />
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
      <dd className="min-w-0 font-medium">{children}</dd>
    </div>
  );
}

/** Upload a `docker save` archive and deploy it. */
function UploadImageButton({ slug }: { slug: string }) {
  const follow = useFollowJob();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pick = (file: File) => {
    setError(null);
    void uploadAppImage(file, (sent, total) => setProgress({ sent, total }))
      .then((uploadId) => api<{ job: JobDto }>(`/api/sites/${slug}/app/image`, { method: 'POST', body: { uploadId } }))
      .then((res) => follow(res.job, { refresh: [['site', slug], ['app-deploys', slug]] }))
      .catch(setError)
      .finally(() => setProgress(null));
  };
  return (
    <>
      <input ref={input} type="file" className="hidden" accept=".tar" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      <Button small busy={progress !== null} onClick={() => input.current?.click()}>
        {progress ? `Uploading ${Math.round((progress.sent / Math.max(1, progress.total)) * 100)} %` : 'Upload new image'}
      </Button>
      <ErrorNote error={error} />
    </>
  );
}

// --------------------------------------------------------------- Deploys

export function AppDeploysTab({ slug }: { slug: string }) {
  const deploys = useQuery({
    queryKey: ['app-deploys', slug],
    queryFn: () => api<{ items: AppDeployDto[] }>(`/api/sites/${slug}/app/deploys`),
    refetchInterval: 15_000,
  });
  const run = useRunJob([['site', slug], ['app-deploys', slug]]);
  const [open, setOpen] = useState<number | null>(null);
  if (!deploys.data) return deploys.error ? <ErrorNote error={deploys.error} /> : <Spinner />;
  const items = deploys.data.items;
  const current = items.find((d) => d.result === 'ok');
  return (
    <Card title="Deploys">
      {items.length === 0 ? (
        <EmptyState>No deploys yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Image</th>
                <th className="py-2 pr-4 font-medium">How</th>
                <th className="py-2 pr-4 font-medium">Result</th>
                <th className="py-2 pr-4 font-medium" title="How long the app answered 503 while its container was replaced">Gap</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <DeployRow
                  key={d.id}
                  d={d}
                  current={d.id === current?.id}
                  open={open === d.id}
                  onToggle={() => setOpen(open === d.id ? null : d.id)}
                  rollBack={() => run.mutate({ path: `/api/sites/${slug}/app/deploy`, body: { deployId: d.id }, action: `rollback-${d.id}` })}
                  busy={run.busy(`rollback-${d.id}`)}
                  disabled={run.active}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorNote error={run.error} />
    </Card>
  );
}

function DeployRow({
  d,
  current,
  open,
  onToggle,
  rollBack,
  busy,
  disabled,
}: {
  d: AppDeployDto;
  current: boolean;
  open: boolean;
  onToggle: () => void;
  rollBack: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  const failed = d.result === 'failed';
  return (
    <>
      <tr className="border-t border-neutral-100 align-top">
        <td className="py-2 pr-4 whitespace-nowrap" title={formatDate(d.startedAt)}>
          {timeAgo(d.startedAt)}
        </td>
        <td className="py-2 pr-4">
          <code>{imageOf(d)}</code>
          {current && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">runs</span>}
        </td>
        <td className="py-2 pr-4 whitespace-nowrap">
          {ORIGIN[d.origin]}
          {d.actor && d.actor !== 'hook' && <span className="text-neutral-500"> · {d.actor}</span>}
        </td>
        <td className="py-2 pr-4">
          {failed ? (
            <button type="button" className="text-left text-red-700 underline" onClick={onToggle}>
              Failed
            </button>
          ) : d.result === 'running' ? (
            'Running'
          ) : (
            <span className="text-emerald-700">Done{d.tookMs !== null ? ` in ${Math.round(d.tookMs / 1000)} s` : ''}</span>
          )}
        </td>
        <td className="py-2 pr-4 whitespace-nowrap">{d.gapMs !== null ? `${(d.gapMs / 1000).toFixed(1)} s` : '–'}</td>
        <td className="py-2 text-right">
          {!current && d.result === 'ok' && (
            <span title={d.canRollBack ? undefined : 'Its image is gone, and an upload cannot be pulled again.'}>
              <Button small variant="secondary" disabled={!d.canRollBack || disabled} busy={busy} onClick={rollBack}>
                Roll back
              </Button>
            </span>
          )}
        </td>
      </tr>
      {failed && open && (
        <tr>
          <td colSpan={6} className="pb-3">
            <p className="text-sm text-red-800">{d.error}</p>
            {d.logTail && <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-neutral-900 p-3 text-xs text-neutral-100">{d.logTail}</pre>}
          </td>
        </tr>
      )}
    </>
  );
}

// --------------------------------------------------------------- Logs

const clock = (ts: string) => (ts ? new Date(ts).toLocaleTimeString() : '');

export function AppLogsTab({ slug }: { slug: string }) {
  const [follow, setFollow] = useState(true);
  const logs = useAppLogs(slug, follow);
  const box = useRef<HTMLPreElement>(null);
  const qc = useQueryClient();
  const lines = logs.data?.lines ?? [];
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [follow, lines.length]);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <Toggle checked={follow} onChange={setFollow} label="Follow" />
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-500">The newest 1,000 lines.</span>
          <Button small variant="secondary" onClick={() => void qc.invalidateQueries({ queryKey: ['app-logs', slug] })}>
            Refresh
          </Button>
        </div>
      </div>
      <ErrorNote error={logs.error} />
      {logs.data && lines.length === 0 ? (
        <EmptyState>Nothing logged yet.</EmptyState>
      ) : (
        <pre ref={box} className="max-h-[32rem] overflow-auto rounded-lg bg-neutral-900 p-3 text-xs leading-5 text-neutral-100">
          {lines.map((l, i) => (
            <div key={i}>
              <span className="select-none text-neutral-500">{clock(l.ts)} </span>
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </Card>
  );
}
