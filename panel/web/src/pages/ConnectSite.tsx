// @docs sites/external
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectionCodeDto, ConnectionDto } from '../../../shared/types';
import { api } from '../api/client';
import { useConnection } from '../api/hooks';
import { Button, Card, CopyField, ErrorNote, Spinner, Toggle } from '../components/ui';
import { ConnectConfirm } from '../components/connect/ConnectConfirm';
import { ConnectionsList } from '../components/connect/ConnectionsList';
import { CONNECT_STEPS, connectStep } from '../lib/connections';

/** Start the zip's download in the background: the page stays where it is. */
function downloadPlugin(id: number): void {
  const a = document.createElement('a');
  a.href = `/api/connections/${id}/plugin`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Sites → Connect site: a WordPress site hosted elsewhere, managed through the WPL7 Connect plugin.
 * Connect (download the plugin, install it on the site), Confirm (what the site reported, and the
 * choices), Done. `?id=` is the connection the page is about; a reconnect from a site's Settings
 * tab lands here too, and skips Confirm.
 */
export function ConnectSite() {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('id'));
  const id = Number.isInteger(raw) && raw > 0 ? raw : null;
  const conn = useConnection(id);
  // The add's backup job, for the Done step's link: the connection itself does not say.
  const [backupJobId, setBackupJobId] = useState<number | null>(null);
  // A reconnect's connection names its site until the plugin enrolls; after that it is the
  // site's own connection, so the page keeps what it saw.
  const [reconnect, setReconnect] = useState<{ slug: string; title: string } | null>(null);
  const forSite = conn.data?.forSite ?? null;
  if (forSite && reconnect?.slug !== forSite.slug) setReconnect(forSite);
  const steps = reconnect ? (['Connect', 'Done'] as const) : CONNECT_STEPS;
  const step = id === null ? 0 : conn.data ? connectStep(conn.data.status) : 0;
  const shown = reconnect && step === 2 ? 1 : step;

  return (
    <div className="space-y-6">
      <h1 className="page-title">{reconnect ? `Reconnect ${reconnect.title}` : 'Connect a site'}</h1>
      <div className="flex flex-wrap gap-2 text-xs">
        {steps.map((label, i) => (
          <span
            key={label}
            className={`rounded-full px-3 py-1 font-medium ${i === shown ? 'bg-[#18191c] text-white' : i < shown ? 'bg-neutral-300 text-neutral-700' : 'bg-neutral-200 text-neutral-500'}`}
          >
            {i + 1}. {label}
          </span>
        ))}
      </div>

      {id !== null && conn.isPending && <Spinner />}
      <ErrorNote error={conn.error} />
      {id === null && <ConnectStep conn={null} onCreated={(created) => setParams({ id: String(created.id) })} />}
      {conn.data && step === 0 && <ConnectStep conn={conn.data} onCreated={() => undefined} />}
      {conn.data && step === 1 && <ConnectConfirm conn={conn.data} onAdded={setBackupJobId} />}
      {conn.data && step === 2 && <ConnectDoneCard conn={conn.data} reconnect={reconnect !== null} backupJobId={backupJobId} />}
      {id === null && <ConnectionsList />}
    </div>
  );
}

/** Step 1: the plugin, and the wait for the site to connect with it. */
function ConnectStep({ conn, onCreated }: { conn: ConnectionDto | null; onCreated: (created: ConnectionDto) => void }) {
  const qc = useQueryClient();
  const [allowHttp, setAllowHttp] = useState(false);
  const create = useMutation({
    mutationFn: () => api<ConnectionDto>('/api/connections', { method: 'POST', body: { allowHttp } }),
    onSuccess: (created) => {
      qc.setQueryData(['connection', created.id], created);
      void qc.invalidateQueries({ queryKey: ['connections'] });
      onCreated(created);
      downloadPlugin(created.id);
    },
  });

  if (conn && (conn.status === 'expired' || conn.status === 'disconnected')) {
    return (
      <Card title="Connect the site">
        <div className="space-y-3">
          <ErrorNote error={conn.status === 'expired' && !conn.enrolledAt ? 'This connection has ended: the site did not connect in time.' : 'This connection has ended.'} />
          <Link to="/sites/connect">
            <Button>Start over</Button>
          </Link>
        </div>
      </Card>
    );
  }

  const locked = conn !== null;
  const reconnect = conn?.forSite ?? null;
  return (
    <Card title="Connect the site">
      <div className="space-y-4 text-sm">
        <div>
          <span title={locked ? 'Set before the plugin is downloaded.' : undefined} className="inline-block">
            <Toggle
              checked={conn ? conn.allowHttp : allowHttp}
              onChange={setAllowHttp}
              disabled={locked}
              label={
                <span>
                  The site has no HTTPS
                  <span className="block text-xs text-neutral-500">
                    {locked ? 'Set before the plugin is downloaded.' : 'Allows plain HTTP. Backups and logins can then be read on the way.'}
                  </span>
                </span>
              }
            />
          </span>
        </div>
        {conn ? (
          <a
            className="button-primary inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors"
            href={`/api/connections/${conn.id}/plugin`}
            download
          >
            Download plugin
          </a>
        ) : (
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            Download plugin
          </Button>
        )}
        <ErrorNote error={create.error} />
        <ol className="list-decimal space-y-1 pl-5 text-neutral-700">
          <li>
            Install the zip on {reconnect ? <b>{conn?.source ?? 'the site'}</b> : 'the site'}: <b>Plugins → Add New → Upload Plugin</b>.
            {reconnect && <> If WordPress asks, choose <b>Replace current with uploaded</b>.</>}
          </li>
          <li>Activate it.</li>
          <li>Come back here. The site connects on its own.</li>
        </ol>
        {conn && (
          <div className="flex items-center gap-2 text-neutral-600">
            <Spinner /> Waiting for the site…
          </div>
        )}
        {conn?.canDownload && <ConnectionCode id={conn.id} />}
      </div>
    </Card>
  );
}

/** For the plugin's own form, when it came without its connection file. Fetched only when opened. */
function ConnectionCode({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const code = useQuery({
    queryKey: ['connection', id, 'code'],
    queryFn: () => api<ConnectionCodeDto>(`/api/connections/${id}/code`),
    enabled: open,
    staleTime: Infinity,
  });
  return (
    <details className="text-neutral-600" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer">The plugin asks for a connection code</summary>
      <div className="mt-2 space-y-2">
        {code.isPending && open && <Spinner />}
        <ErrorNote error={code.error} />
        {code.data && (
          <>
            <div className="text-xs font-medium text-neutral-500">Panel address</div>
            <CopyField value={code.data.panel} tone="plain" />
            <div className="text-xs font-medium text-neutral-500">Connection code</div>
            <CopyField value={code.data.code} />
          </>
        )}
      </div>
    </details>
  );
}

/** The last step: the site is in the panel. */
function ConnectDoneCard({ conn, reconnect, backupJobId }: { conn: ConnectionDto; reconnect: boolean; backupJobId: number | null }) {
  const home = conn.source;
  return (
    <Card title={reconnect ? 'Reconnected' : 'Connected'}>
      <div className="space-y-3 text-sm">
        {home && (
          <p>
            {reconnect ? 'Reconnected' : 'Connected'}:{' '}
            <a className="underline" href={home} target="_blank" rel="noreferrer">
              {home}
            </a>
          </p>
        )}
        {backupJobId !== null && (
          <p>
            <Link className="underline" to={`/jobs/${backupJobId}`}>
              The first backup
            </Link>{' '}
            is running.
          </p>
        )}
        {conn.site && (
          <Link to={`/sites/${conn.site.slug}`}>
            <Button>Open site page</Button>
          </Link>
        )}
      </div>
    </Card>
  );
}
