// @docs sites/external
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { describeCron } from '../../../../shared/cron';
import type { ConnectionDto, JobDto, SiteSummary } from '../../../../shared/types';
import { api } from '../../api/client';
import { useMeta } from '../../api/hooks';
import { formatBytes, localeName } from '../../lib/format';
import { Button, Card, ConfirmDialog, ErrorNote, Field, Spinner, Toggle, inputClass } from '../ui';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
/** As the panel holds it (CHECK_FRESH_MS): an older check is made again before Add site. */
const CHECK_FRESH_MS = 10 * 60_000;

/**
 * Step 2: what the site reported, what stands in the way, whether the panel reaches it, and the
 * choices - its name in the panel, the administrator to act as, where its backups are kept.
 */
export function ConnectConfirm({ conn, onAdded }: { conn: ConnectionDto; onAdded: (backupJobId: number | null) => void }) {
  const meta = useMeta();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const report = conn.report!;
  const s = conn.suggestions!;
  const [slug, setSlug] = useState(s.slug);
  const [actAs, setActAs] = useState<number | null>(s.actAs);
  const [serverId, setServerId] = useState<number>(s.storageServerId);
  const [backups, setBackups] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['connection', conn.id] });
    void qc.invalidateQueries({ queryKey: ['connections'] });
  };
  const check = useMutation({
    mutationFn: () => api<ConnectionDto>(`/api/connections/${conn.id}/check`, { method: 'POST' }),
    onSuccess: (dto) => qc.setQueryData(['connection', conn.id], dto),
  });
  // Add site needs a fresh check: made on arrival, and again once it is old. A check that
  // could not be made at all (an error, not an unreachable site) waits for Check again.
  const stale = !conn.check || Date.now() - conn.check.at > CHECK_FRESH_MS;
  const { mutate: runCheck, isPending: checking, isError: checkFailed } = check;
  useEffect(() => {
    if (stale && !checking && !checkFailed) runCheck();
  }, [stale, checking, checkFailed, runCheck]);

  const remove = useMutation({
    mutationFn: () => api(`/api/connections/${conn.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['connections'] });
      void navigate('/sites/connect');
    },
  });
  const servers = meta.data?.servers ?? [];
  const multiServer = meta.data?.multiServer ?? false;
  const add = useMutation({
    mutationFn: () =>
      api<{ site: SiteSummary; jobs: JobDto[] }>(`/api/connections/${conn.id}/add`, {
        method: 'POST',
        body: {
          slug,
          ...(actAs !== null ? { actAs } : {}),
          ...(multiServer ? { storageServerId: serverId } : {}),
          backups,
        },
      }),
    onSuccess: (res) => {
      onAdded(res.jobs.find((j) => j.type === 'backup.create')?.id ?? null);
      refresh();
      void qc.invalidateQueries({ queryKey: ['sites'] });
    },
  });

  const blocking = conn.warnings.filter((w) => w.blocking);
  const others = conn.warnings.filter((w) => !w.blocking);
  const reachable = conn.check?.reachable === true && !stale;
  const reason =
    conn.blockedReason ??
    (report.admins.length === 0
      ? 'The site has no administrator to act as.'
      : checking
        ? 'Checking that the panel reaches the site…'
        : !reachable
          ? 'The panel cannot reach the site yet.'
          : !SLUG_RE.test(slug)
            ? 'The name is not valid.'
            : null);
  const schedule = meta.data?.backupCron ? describeCron(meta.data.backupCron) : null;

  return (
    <div className="space-y-6">
      <Card title="The site">
        <dl className="space-y-2 text-sm">
          <Fact label="Address" value={report.home} />
          <Fact label="Title" value={report.title || '–'} />
          <Fact label="WordPress" value={report.wpVersion} />
          <Fact label="PHP" value={report.phpVersion} />
          <Fact label="Language" value={localeName(meta.data?.locales, report.locale)} />
          <Fact label="Plugins" value={String(report.plugins)} />
          <Fact label="Theme" value={report.theme?.name || report.theme?.slug || '–'} />
          <Fact
            label="Files"
            value={`${report.files.count.toLocaleString('en-US')} · ${formatBytes(report.files.bytes)}${report.files.partial ? ' (estimate)' : ''}`}
          />
          <Fact label="Database" value={`${report.db.tables} tables · ${formatBytes(report.db.bytes)} · ${report.db.server}`} />
        </dl>
      </Card>

      {conn.warnings.length > 0 && (
        <Card title="Before you add it">
          <ul className="space-y-2 text-sm">
            {blocking.map((w) => (
              <li key={w.code} className="rounded-lg bg-red-50 px-3 py-2 text-red-800">
                {w.message}
              </li>
            ))}
            {others.map((w) => (
              <li key={w.code} className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                {w.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Connection"
        action={
          <Button small variant="secondary" onClick={() => runCheck()} disabled={checking}>
            Check again
          </Button>
        }
      >
        <div className="space-y-2 text-sm">
          {checking ? (
            <div className="flex items-center gap-2 text-neutral-600">
              <Spinner /> Checking…
            </div>
          ) : conn.check?.reachable ? (
            <p className="text-emerald-700">The panel reaches the site.</p>
          ) : conn.check ? (
            <>
              <p className="text-red-700">The panel cannot reach the site: {conn.check.error}</p>
              <p className="text-neutral-600">
                A firewall or security plugin may block it. Let requests to <code>/wp-json/wpl7-connect/</code> and{' '}
                <code>?wpl7-connect=</code> through.
              </p>
            </>
          ) : null}
          <ErrorNote error={check.error} />
        </div>
      </Card>

      <Card title="In the panel">
        <div className="space-y-4">
          <Field
            label="Name in the panel"
            hint={SLUG_RE.test(slug) ? 'In the site page address and backup names.' : '3-32 characters: a-z, 0-9 and dashes, not at either end.'}
          >
            <input className={inputClass} value={slug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
          <Field label="Act as" hint="Updates and logins run as this user.">
            <select className={inputClass} value={actAs ?? ''} onChange={(e) => setActAs(Number(e.target.value))}>
              {report.admins.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.login}
                  {a.name && a.name !== a.login ? ` (${a.name})` : ''}
                </option>
              ))}
            </select>
          </Field>
          {multiServer && (
            <Field label="Keep backups on">
              <select className={inputClass} value={serverId} onChange={(e) => setServerId(Number(e.target.value))}>
                {servers.map((srv) => (
                  <option key={srv.id} value={srv.id} disabled={srv.status !== 'ok'}>
                    {srv.name}
                    {srv.status !== 'ok' ? ` (${srv.status})` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Toggle
            checked={backups}
            onChange={setBackups}
            label={
              <span>
                Scheduled backups
                {schedule && <span className="block text-xs text-neutral-500">{schedule}</span>}
              </span>
            }
          />
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <span title={reason ?? undefined} className="inline-block">
          <Button disabled={reason !== null || add.isPending} onClick={() => add.mutate()}>
            Add site
          </Button>
        </span>
        <Button variant="secondary" onClick={() => setDeleting(true)}>
          Delete connection
        </Button>
      </div>
      {reason && <p className={`text-sm ${blocking.length > 0 ? 'text-red-700' : 'text-neutral-500'}`}>{reason}</p>}
      <ErrorNote error={add.error ?? remove.error} />
      {deleting && (
        <ConfirmDialog
          title="Delete connection"
          message="The panel forgets this connection. Delete the plugin from the site too."
          confirmLabel="Delete connection"
          onConfirm={() => remove.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
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
