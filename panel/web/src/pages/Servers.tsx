// @docs servers/add, servers/overview
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerCheck, ServerDto } from '../../../shared/types';
import { isTerminal, useMeta, useMonitor, useRunJob, useServers, useSshPublicKey } from '../api/hooks';
import { api } from '../api/client';
import {
  Button,
  Card,
  ChecksList,
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
import { JobProgress } from '../components/JobProgress';
import { StorageModal } from '../components/StorageModal';
import { formatBytes, timeAgo } from '../lib/format';

export function Servers() {
  const servers = useServers();
  const monitor = useMonitor();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ServerDto | null>(null);
  const [checksFor, setChecksFor] = useState<{ name: string; checks: ServerCheck[] } | null>(null);
  const [storageFor, setStorageFor] = useState<ServerDto | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const statsById = new Map((monitor.data?.servers ?? []).map((s) => [s.serverId, s]));

  const test = async (server: ServerDto) => {
    setTesting(server.id);
    setActionError(null);
    try {
      const res = await api<{ ok: boolean; checks: ServerCheck[] }>(`/api/servers/${server.id}/test`, {
        method: 'POST',
      });
      setChecksFor({ name: server.name, checks: res.checks });
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (err) {
      setActionError(err);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="page-title">Servers</h1>
        <Button onClick={() => setAddOpen(true)}>Add server</Button>
      </div>

      <Card>
        <ErrorNote error={actionError} />
        {(servers.data ?? []).length === 0 ? (
          <EmptyState>Loading…</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                <th className="pb-2" />
                <th className="pb-2">Server</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Dev domain</th>
                <th className="pb-2 text-right">Sites</th>
                <th className="pb-2 text-right">Load</th>
                <th className="pb-2 text-right">Disk</th>
                <th className="pb-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {(servers.data ?? []).map((server) => {
                const stats = statsById.get(server.id);
                return (
                  <tr
                    key={server.id}
                    // A mouse convenience on top of the real link in the name cell, not a
                    // replacement for it: the name stays an anchor, so the row is still
                    // reachable by keyboard and still opens in a tab on cmd/middle click.
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a, button, input, select')) return;
                      if (e.metaKey || e.ctrlKey) window.open(`/servers/${server.id}`, '_blank');
                      else void navigate(`/servers/${server.id}`);
                    }}
                    className="cursor-pointer border-t border-neutral-100 transition-colors hover:bg-neutral-50"
                  >
                    <td className="py-2.5 pr-2">
                      <UpDot up={server.status === 'ok' ? true : server.status === 'provisioning' ? null : false} />
                    </td>
                    <td className="py-2.5 pr-3">
                      <Link to={`/servers/${server.id}`} className="font-medium hover:underline">
                        {server.name}
                      </Link>
                      <div className="text-xs text-neutral-500" title={server.lastError ?? undefined}>
                        {server.kind === 'local'
                          ? `this machine · ${server.publicIp || 'no public IP'}`
                          : `${server.sshUser}@${server.sshHost}:${server.sshPort} · ${server.publicIp || '?'}`}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <StatusBadge status={server.status} />
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-neutral-600">{server.devDomain || '–'}</td>
                    <td className="py-2.5 pr-3 text-right">{server.sitesCount}</td>
                    <td className="py-2.5 pr-3 text-right text-xs text-neutral-500">
                      {stats ? stats.load1.toFixed(2) : '–'}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-xs text-neutral-500">
                      {stats && stats.diskTotal > 0 ? `${formatBytes(stats.diskUsed)} / ${formatBytes(stats.diskTotal)}` : '–'}
                    </td>
                    <td className="py-2.5 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button small variant="secondary" onClick={() => setStorageFor(server)}>
                          Storage
                        </Button>
                        <Button small variant="secondary" onClick={() => navigate(`/servers/${server.id}/terminal`)}>
                          Terminal
                        </Button>
                        <Button small variant="secondary" disabled={testing === server.id} onClick={() => void test(server)}>
                          {testing === server.id ? <Spinner /> : 'Test'}
                        </Button>
                        {server.kind !== 'local' && (
                          <Button
                            small
                            variant="ghost"
                            disabled={server.sitesCount > 0}
                            onClick={() => setDeleteTarget(server)}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {addOpen && <AddServerModal onClose={() => setAddOpen(false)} />}
      {storageFor && (
        <StorageModal serverId={storageFor.id} serverName={storageFor.name} onClose={() => setStorageFor(null)} />
      )}
      {checksFor && (
        <Modal title={`Checks: ${checksFor.name}`} onClose={() => setChecksFor(null)}>
          <ChecksList checks={checksFor.checks} />
          <div className="mt-4 flex justify-end">
            <Button onClick={() => setChecksFor(null)}>Close</Button>
          </div>
        </Modal>
      )}
      {deleteTarget && (
        <ConfirmDialog
          title={`Remove server "${deleteTarget.name}"`}
          confirmWord={deleteTarget.name}
          confirmLabel="Remove"
          message={
            <>
              Unregisters the server. Files on the machine are left untouched. Remove the panel&apos;s key from{' '}
              <code>~{deleteTarget.sshUser}/.ssh/authorized_keys</code> to revoke access.
            </>
          }
          onConfirm={() => {
            void api(`/api/servers/${deleteTarget.id}?force=true`, { method: 'DELETE' })
              .then(() => qc.invalidateQueries({ queryKey: ['servers'] }))
              .then(() => qc.invalidateQueries({ queryKey: ['meta'] }))
              .catch(setActionError);
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

function AddServerModal({ onClose }: { onClose: () => void }) {
  const meta = useMeta();
  const pubKey = useSshPublicKey();
  const qc = useQueryClient();
  // ['meta'] holds servers[]/multiServer/defaultServerId and is cached for 5 minutes,
  // so without invalidating it the New Site wizard keeps offering the old fleet.
  const run = useRunJob([['servers'], ['meta']]);
  const [mode, setMode] = useState('provision');
  const [name, setName] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [devDomain, setDevDomain] = useState('');
  const [acmeEmail, setAcmeEmail] = useState('');
  const [registerResult, setRegisterResult] = useState<{ checks: ServerCheck[]; failed: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const done = isTerminal(run.job?.status);

  const fleetDevDomain = meta.data?.devDomain ?? '';
  const effectiveDevDomain = devDomain || fleetDevDomain;
  const dnsProvider = meta.data?.dnsManaged ? 'cloudflare' : '';

  const submit = async () => {
    setError(null);
    const body = {
      name,
      sshHost,
      devDomain: effectiveDevDomain,
      dnsProvider,
      provision: mode === 'provision',
      ...(mode === 'provision' ? { acmeEmail } : {}),
    };
    if (mode === 'provision') {
      run.mutate({ path: '/api/servers', body });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<{ checks: ServerCheck[] }>('/api/servers', { method: 'POST', body });
      setRegisterResult({ checks: res.checks, failed: false });
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (err) {
      const checks = (err as { details?: { checks?: ServerCheck[] } }).details?.checks;
      if (checks) setRegisterResult({ checks, failed: true });
      else setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Add server" onClose={onClose}>
      {run.jobId !== null ? (
        <div className="space-y-3">
          <JobProgress job={run.job} logs={run.logs} />
          {done && (
            <div className="flex justify-end">
              <Button onClick={onClose}>{run.job?.status === 'succeeded' ? 'Done' : 'Close'}</Button>
            </div>
          )}
        </div>
      ) : registerResult ? (
        <div className="space-y-4">
          <ChecksList checks={registerResult.checks} />
          {registerResult.failed ? (
            <p className="text-sm text-red-700">Verification failed — the server was not added.</p>
          ) : (
            <p className="text-sm text-emerald-700">Server added. Plugin zips are syncing in the background.</p>
          )}
          <div className="flex justify-end">
            <Button onClick={registerResult.failed ? () => setRegisterResult(null) : onClose}>
              {registerResult.failed ? 'Back' : 'Done'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <Tabs
            tabs={[
              { id: 'provision', label: 'Blank VPS (auto-provision)' },
              { id: 'register', label: 'Already provisioned' },
            ]}
            active={mode}
            onChange={setMode}
          />
          {mode === 'provision' ? (
            <p className="text-neutral-600">
              Point the panel at a fresh Ubuntu 26.04 VPS it can reach as <code>root</code>. Add this SSH key to
              the VPS provider account <em>before</em> creating the server:
            </p>
          ) : (
            <p className="text-neutral-600">
              Run <code>./provision/setup.sh --role=worker --panel-key='&lt;key below&gt;'</code> on the server first,
              then register it here.
            </p>
          )}
          {pubKey.data?.publicKey && <CopyField value={pubKey.data.publicKey} tone="plain" />}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" hint="e.g. s2">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label="SSH host / IP">
              <input className={inputClass} value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
            </Field>
          </div>
          <Field label="Dev domain" hint={fleetDevDomain ? `default: ${fleetDevDomain} (shared fleet dev domain)` : undefined}>
            <input
              className={inputClass}
              value={devDomain}
              placeholder={fleetDevDomain}
              onChange={(e) => setDevDomain(e.target.value)}
            />
          </Field>
          {mode === 'provision' && (
            <Field label="Let's Encrypt email">
              <input className={inputClass} value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)} />
            </Field>
          )}
          <ErrorNote error={error ?? run.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={
                !name || !sshHost || !effectiveDevDomain || (mode === 'provision' && !acmeEmail) || submitting || run.isPending
              }
              onClick={() => void submit()}
            >
              {mode === 'provision' ? 'Provision server' : 'Verify & add'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
