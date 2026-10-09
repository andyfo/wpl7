// @docs sites/external
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConnectionDto, SiteDetail } from '../../../../shared/types';
import { api } from '../../api/client';
import { useMeta, useRunJob, useSite } from '../../api/hooks';
import { connectionPath } from '../../lib/connections';
import { JobProgress } from '../JobProgress';
import { Button, Card, ConfirmDialog, ErrorNote, Field, Spinner, Toggle, inputClass } from '../ui';

/** A site hosted elsewhere: who the panel acts as, where its backups are kept, and its connection. */
export function ExternalSettings({ slug }: { slug: string }) {
  const site = useSite(slug);
  const meta = useMeta();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const run = useRunJob([['site', slug], ['sites']]);
  const [actAs, setActAs] = useState<number | null>(null);
  const [serverId, setServerId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<'disconnect' | 'remove' | null>(null);
  const [deleteBackups, setDeleteBackups] = useState(false);

  const removed = run.job?.type === 'site.delete' && run.job.status === 'succeeded';
  useEffect(() => {
    if (removed) void navigate('/sites');
  }, [removed, navigate]);

  const saved = (detail: SiteDetail) => {
    qc.setQueryData(['site', slug], detail);
    void qc.invalidateQueries({ queryKey: ['sites'] });
  };
  const patch = useMutation({
    mutationFn: (body: { actAs?: number; storageServerId?: number }) =>
      api<SiteDetail>(`/api/sites/${slug}/connection`, { method: 'PATCH', body }),
    onSuccess: (detail) => {
      saved(detail);
      setActAs(null);
      setServerId(null);
    },
  });
  const reconnect = useMutation({
    mutationFn: () => api<ConnectionDto>(`/api/sites/${slug}/connection/reconnect`, { method: 'POST' }),
    onSuccess: (conn) => {
      qc.setQueryData(['connection', conn.id], conn);
      void navigate(connectionPath(conn.id));
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api<SiteDetail>(`/api/sites/${slug}/connection/disconnect`, { method: 'POST' }),
    onSuccess: saved,
  });

  const s = site.data;
  if (!s?.external) return <Spinner />;
  const ext = s.external;
  const connected = s.status === 'connected';
  const multiServer = meta.data?.multiServer ?? false;
  const effActAs = actAs ?? ext.actAs?.id ?? null;
  const effServer = serverId ?? ext.storageServerId;

  return (
    <div className="space-y-4">
      <Card title="Acting as">
        <div className="flex items-end gap-2">
          <Field label="Administrator" hint="Updates and logins run as this user.">
            <select className={inputClass} value={effActAs ?? ''} onChange={(e) => setActAs(Number(e.target.value))}>
              {ext.admins.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.login}
                </option>
              ))}
            </select>
          </Field>
          <Button
            disabled={effActAs === null || effActAs === ext.actAs?.id || patch.isPending}
            onClick={() => effActAs !== null && patch.mutate({ actAs: effActAs })}
          >
            Save
          </Button>
        </div>
      </Card>

      {multiServer && (
        <Card title="Backups kept on">
          <div className="flex items-end gap-2">
            <Field label="Server" hint="The next backup starts a new copy there. Earlier backups stay where they are.">
              <select className={inputClass} value={effServer} onChange={(e) => setServerId(Number(e.target.value))}>
                {(meta.data?.servers ?? []).map((srv) => (
                  <option key={srv.id} value={srv.id} disabled={srv.status !== 'ok'}>
                    {srv.name}
                    {srv.status !== 'ok' ? ` (${srv.status})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              disabled={effServer === ext.storageServerId || patch.isPending}
              onClick={() => patch.mutate({ storageServerId: effServer })}
            >
              Save
            </Button>
          </div>
        </Card>
      )}
      <ErrorNote error={patch.error} />

      <Card title="Connection">
        <div className="space-y-3 text-sm">
          <p className="text-neutral-600">
            {connected
              ? `Connected through WPL7 Connect ${ext.pluginVersion ?? ''} at ${ext.home}.`
              : 'Disconnected. Reconnect to manage the site from here again.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}>
              Reconnect
            </Button>
            {connected && (
              <Button variant="secondary" onClick={() => setConfirm('disconnect')}>
                Disconnect
              </Button>
            )}
          </div>
          <p className="text-xs text-neutral-500">Reconnect gives you a new download of the plugin, for the site to connect with again.</p>
          <ErrorNote error={reconnect.error ?? disconnect.error} />
        </div>
      </Card>

      <div>
        <ErrorNote error={run.error} />
        <JobProgress job={run.job} logs={run.logs} />
      </div>

      <Card title="Danger zone">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-neutral-600">
            Removes the site from the panel. It keeps running at {ext.home}.
          </div>
          <Button variant="danger" onClick={() => setConfirm('remove')}>
            Remove from panel
          </Button>
        </div>
      </Card>

      {confirm === 'disconnect' && (
        <ConfirmDialog
          title={`Disconnect ${s.title}`}
          message="The panel stops managing the site, and WPL7 Connect on it forgets the panel. Backups are kept."
          confirmLabel="Disconnect"
          onConfirm={() => disconnect.mutate()}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'remove' && (
        <ConfirmDialog
          title={`Remove ${s.slug}`}
          message={
            <>
              The site keeps running at <b>{ext.home}</b>. The plugin is disconnected.
            </>
          }
          confirmWord={s.slug}
          confirmLabel="Remove from panel"
          onConfirm={() =>
            run.mutate({ path: `/api/sites/${slug}?finalBackup=false&deleteBackups=${deleteBackups}`, method: 'DELETE' })
          }
          onClose={() => setConfirm(null)}
        >
          <Toggle checked={deleteBackups} onChange={setDeleteBackups} label="Also delete its backups" />
        </ConfirmDialog>
      )}
    </div>
  );
}
