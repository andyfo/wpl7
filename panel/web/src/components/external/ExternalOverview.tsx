// @docs sites/external
import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useMeta, useRunJob, useSite, useSiteHistory } from '../../api/hooks';
import { formatDate, timeAgo } from '../../lib/format';
import { siteHealth } from '../../lib/siteHealth';
import { JobProgress } from '../JobProgress';
import { Sparkline } from '../Sparkline';
import { Button, Card, ErrorNote, Spinner } from '../ui';
import { WpAdminLoginButton } from '../WpAdminLoginButton';

/** A site hosted elsewhere: how it answers, what WPL7 Connect says about it, and what can be done from here. */
export function ExternalOverview({ slug }: { slug: string }) {
  const site = useSite(slug);
  const history = useSiteHistory(slug);
  const meta = useMeta();
  const run = useRunJob([['site', slug], ['backups', slug], ['wp-status', slug]]);
  const qc = useQueryClient();
  const [homeBusy, setHomeBusy] = useState(false);
  const [homeError, setHomeError] = useState<unknown>(null);
  const s = site.data;
  if (!s?.external) return <Spinner />;

  const ext = s.external;
  const health = siteHealth(s);
  const connected = s.status === 'connected';
  const multiServer = meta.data?.multiServer ?? false;
  const samples = history.data ?? [];

  const rebindHome = () => {
    setHomeBusy(true);
    setHomeError(null);
    void api(`/api/sites/${slug}/connection`, { method: 'PATCH', body: { useNewHome: true } })
      .then(() => qc.invalidateQueries({ queryKey: ['site', slug] }))
      .catch(setHomeError)
      .finally(() => setHomeBusy(false));
  };

  return (
    <div className="space-y-4">
      {health.tone === 'bad' && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <div className="font-medium">{health.label}</div>
          <p className="mt-1">{health.detail}</p>
          {health.fix && <p className="mt-1">{health.fix}</p>}
          {ext.reachable === false && ext.lastError && <p className="mt-1 text-xs">Last error: {ext.lastError}</p>}
        </div>
      )}
      {s.status === 'disconnected' && (
        <div className="rounded-xl border border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-700">
          <div className="font-medium">Disconnected</div>
          <p className="mt-1">
            The panel no longer reaches this site. Its backups are kept.{' '}
            <Link className="underline" to={`/sites/${slug}?tab=settings`}>
              Reconnect it
            </Link>
            .
          </p>
        </div>
      )}
      {ext.homeChanged && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-medium">The site's address is now {ext.homeChanged}</div>
          <p className="mt-1">WPL7 Connect refuses the panel's requests until the panel uses the new address.</p>
          <div className="mt-2">
            <Button small disabled={homeBusy} onClick={rebindHome}>
              Use the new address
            </Button>
          </div>
          <div className="mt-2">
            <ErrorNote error={homeError} />
          </div>
        </div>
      )}
      {ext.warnings.length > 0 && (
        <ul className="space-y-2 text-sm">
          {ext.warnings.map((w) => (
            <li key={w.code} className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
              {w.message}
            </li>
          ))}
        </ul>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <WpAdminLoginButton slug={slug} running={connected} />
          <Button
            small
            variant="secondary"
            disabled={!connected || run.isPending}
            onClick={() => run.mutate({ path: `/api/sites/${slug}/backups`, body: {} })}
          >
            Back up now
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-neutral-600">
          <span>Connected through WPL7 Connect {ext.pluginVersion ?? ''}</span>
          {ext.offer && connected && (
            <Button
              small
              disabled={run.isPending}
              onClick={() =>
                run.mutate({
                  path: `/api/sites/${slug}/wp/bulk`,
                  body: { ops: [{ kind: 'plugin', slug: 'wpl7-connect', action: 'update' }], backupFirst: false, healthCheck: true },
                })
              }
            >
              Update to {ext.offer.version}
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
            <Fact label="Address" value={ext.home} />
            <Fact label="WordPress" value={ext.wpVersion ?? '–'} />
            <Fact label="PHP" value={s.phpVersion} />
            <Fact label="Certificate" value={ext.certExpiresAt ? `expires ${formatDate(ext.certExpiresAt)}` : '–'} />
            {multiServer && <Fact label="Backups kept on" value={ext.storageServerName} />}
            <Fact label="Acting as" value={ext.actAs?.login ?? '–'} />
            <Fact label="Last contact" value={ext.lastContactAt ? timeAgo(ext.lastContactAt) : 'never'} />
            <Fact label="Added" value={formatDate(s.createdAt)} />
          </dl>
        </Card>
        <Card title="Last 24h">
          <div className="text-sm">
            <div className="mb-1 text-xs text-neutral-500">Response time</div>
            <Sparkline values={samples.map((x) => x.httpMs)} formatValue={(v) => `${Math.round(v)} ms`} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-neutral-500">{label}</dt>
      <dd className="break-all font-medium">{value}</dd>
    </div>
  );
}
