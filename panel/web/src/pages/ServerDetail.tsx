// @docs servers/overview
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerCheck, ServerDto, ServerSystemInfoDto } from '../../../shared/types';
import {
  isTerminal,
  useMeta,
  useMonitor,
  useRunJob,
  useServerHistory,
  useServerFtp,
  useServerInfo,
  useServers,
  useSites,
} from '../api/hooks';
import { api } from '../api/client';
import {
  Button,
  Card,
  ChecksList,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  ExternalLinkIcon,
  Field,
  inputClass,
  Modal,
  Spinner,
  StatTile,
  StatusBadge,
  Toggle,
  UpDot,
} from '../components/ui';
import { JobProgress } from '../components/JobProgress';
import { ResourceCharts } from '../components/ResourceCharts';
import { StorageModal } from '../components/StorageModal';
import { serverFtpSummary } from '../lib/ftpStatus';
import { formatBytes, formatDate, formatUptime, timeAgo } from '../lib/format';

/**
 * One machine, end to end: what it is, what it is doing right now, where its backups go,
 * and which sites are on it.
 *
 * The fleet table answers "which server should I look at"; everything that needs more than
 * a table cell to say lives here instead, so the list stays a list.
 */
export function ServerDetail() {
  const { id } = useParams();
  const serverId = Number(id);
  const servers = useServers();
  const monitor = useMonitor();
  const meta = useMeta();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [storageOpen, setStorageOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [checks, setChecks] = useState<ServerCheck[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const update = useRunJob([['servers'], ['meta']]);
  /**
   * The mutation is done the moment the 202 lands; the provisioning run behind it is not,
   * and can take minutes. Clicking again would queue a second `server.provision` for the
   * same machine (the worker only de-duplicates per site) and swap the log being shown for
   * the new job's. The window between the 202 and the first poll counts as running too -
   * that is exactly when a second click is easiest.
   */
  const updating = update.isPending || (update.jobId !== null && !isTerminal(update.job?.status));

  const server = servers.data?.find((s) => s.id === serverId);
  const live = monitor.data?.servers.find((s) => s.serverId === serverId);
  // The monitor's in-memory row is empty until this server answers once after a panel
  // restart, while the samples it recorded before that are still on disk - and drawn in the
  // charts below. Same query key the charts use, so this shares their request.
  const history = useServerHistory(serverId, 1);
  const stats = live && live.memTotal > 0 ? live : (history.data?.samples.at(-1) ?? live);
  const backupRoot = meta.data?.backupRoots.find((r) => r.serverId === serverId);

  if (servers.isPending) return <Spinner />;
  if (!server) {
    return (
      <div className="space-y-4">
        <ErrorNote error={servers.error ?? new Error(`Server #${id} is not registered.`)} />
        <Link className="text-sm underline" to="/servers">
          ← back to servers
        </Link>
      </div>
    );
  }

  const test = async () => {
    setTesting(true);
    setActionError(null);
    try {
      const res = await api<{ ok: boolean; checks: ServerCheck[] }>(`/api/servers/${serverId}/test`, {
        method: 'POST',
      });
      setChecks(res.checks);
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (err) {
      setActionError(err);
    } finally {
      setTesting(false);
    }
  };

  const memPct = stats && stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : null;
  const diskPct = stats && stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <UpDot up={server.status === 'ok' ? true : server.status === 'provisioning' ? null : false} />
            <h1 className="page-title">{server.name}</h1>
            <StatusBadge status={server.status} />
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-600">
              {server.kind === 'local' ? 'panel host' : 'worker'}
            </span>
          </div>
          <div className="mt-1 text-sm text-neutral-500">
            {server.kind === 'local'
              ? `this machine · ${server.publicIp || 'no public IP'}`
              : `${server.sshUser}@${server.sshHost}:${server.sshPort} · ${server.publicIp || 'no public IP'}`}
          </div>
        </div>
        <Link to="/servers" className="text-sm text-neutral-500 hover:underline">
          ← servers
        </Link>
      </div>

      {server.lastError && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <div className="font-medium">Last error</div>
          <p className="mt-1 break-words">{server.lastError}</p>
          <p className="mt-1 text-xs">
            Cleared by the next successful check — run “Test connection” once the cause is fixed.
          </p>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button small variant="secondary" onClick={() => void navigate(`/servers/${serverId}/terminal`)}>
            Terminal
          </Button>
          <Button small variant="secondary" disabled={testing} onClick={() => void test()}>
            {testing ? <Spinner /> : 'Test connection'}
          </Button>
          <Button small variant="secondary" onClick={() => setStorageOpen(true)}>
            Backup storage
          </Button>
          <Button small variant="secondary" onClick={() => setEditOpen(true)}>
            Edit settings
          </Button>
          {server.kind !== 'local' && (
            <Button
              small
              variant="secondary"
              disabled={updating}
              onClick={() => update.mutate({ path: `/api/servers/${serverId}/update`, body: {} })}
            >
              {updating ? <Spinner /> : 'Update stack'}
            </Button>
          )}
          {server.kind !== 'local' && (
            <Button small variant="ghost" disabled={server.sitesCount > 0} onClick={() => setRemoveOpen(true)}>
              Remove server
            </Button>
          )}
        </div>
        <div className="mt-3 space-y-3">
          <ErrorNote error={actionError ?? update.error} />
          <JobProgress job={update.job} logs={update.logs} />
          {checks && (
            <div className="rounded-lg bg-neutral-50 p-3">
              <ChecksList checks={checks} />
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile
          label="Load (1 min)"
          value={stats && stats.memTotal > 0 ? stats.load1.toFixed(2) : '—'}
          sub={stats && stats.memTotal > 0 ? `5 min ${stats.load5.toFixed(2)} · 15 min ${stats.load15.toFixed(2)}` : 'Awaiting samples'}
        />
        <StatTile
          label="Memory"
          value={memPct === null ? '—' : `${memPct.toFixed(0)}%`}
          sub={
            stats && stats.memTotal > 0
              ? `${formatBytes(Math.max(0, stats.memTotal - stats.memUsed))} free of ${formatBytes(stats.memTotal)}`
              : 'Awaiting samples'
          }
        />
        <StatTile
          label="Storage"
          value={diskPct === null ? '—' : `${diskPct.toFixed(0)}%`}
          sub={
            stats && stats.diskTotal > 0
              ? `${formatBytes(Math.max(0, stats.diskTotal - stats.diskUsed))} free of ${formatBytes(stats.diskTotal)}`
              : 'Awaiting samples'
          }
        />
        <StatTile
          label="Sites"
          value={server.sitesCount}
          sub={server.devDomain ? `dev domain ${server.devDomain}` : 'no dev domain set'}
        />
      </div>

      {live && <ResourceCharts servers={[live]} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Configuration">
          <dl className="space-y-2 text-sm">
            <FactRow label="Role" value={server.kind === 'local' ? 'panel host (runs the panel itself)' : 'worker'} />
            {server.kind === 'ssh' && (
              <FactRow label="SSH" value={`${server.sshUser}@${server.sshHost}:${server.sshPort}`} />
            )}
            <FactRow label="Public IP" value={server.publicIp || '– (set it under Edit settings)'} />
            <FactRow label="Dev domain" value={server.devDomain || '–'} />
            <FactRow
              label="Wildcard certificate"
              value={
                <>
                  {server.dnsProvider ? `on, from ${server.dnsProvider === 'cloudflare' ? 'Cloudflare' : server.dnsProvider}` : 'off: a certificate per site'}{' '}
                  <Link className="text-xs text-neutral-500 underline" to="/settings?tab=dns#wildcard">
                    Settings → DNS
                  </Link>
                </>
              }
            />
            <FactRow label="Host key" value={server.hostKeySha256 ?? 'not pinned yet'} />
            <FactRow
              label="Backups"
              value={
                backupRoot
                  ? `${backupRoot.root}${backupRoot.isDefault ? ' (default)' : ''} · ${backupRoot.backups} stored`
                  : '–'
              }
            />
            <FtpRow serverId={serverId} />
            <FactRow label="Registered" value={formatDate(server.createdAt)} />
            <FactRow label="Last seen" value={server.lastSeenAt ? timeAgo(server.lastSeenAt) : 'never'} />
          </dl>
        </Card>
        <MachineCard serverId={serverId} />
      </div>

      <SitesOnServer serverId={serverId} serverName={server.name} />

      {storageOpen && (
        <StorageModal serverId={serverId} serverName={server.name} onClose={() => setStorageOpen(false)} />
      )}
      {editOpen && <EditServerModal server={server} onClose={() => setEditOpen(false)} />}
      {removeOpen && (
        <ConfirmDialog
          title={`Remove server "${server.name}"`}
          confirmWord={server.name}
          confirmLabel="Remove"
          message={
            <>
              This unregisters the server from the panel. Files on the machine are left untouched; backup records
              stored there are dropped. Afterwards remove the panel&apos;s key from{' '}
              <code>~{server.sshUser}/.ssh/authorized_keys</code> to revoke access.
            </>
          }
          onConfirm={() => {
            void api(`/api/servers/${serverId}?force=true`, { method: 'DELETE' })
              .then(() => qc.invalidateQueries({ queryKey: ['servers'] }))
              .then(() => qc.invalidateQueries({ queryKey: ['meta'] }))
              .then(() => navigate('/servers'))
              .catch(setActionError);
          }}
          onClose={() => setRemoveOpen(false)}
        />
      )}
    </div>
  );
}

/** The server's FTP gateway in one line: off, or what it serves and on which ports. */
function FtpRow({ serverId }: { serverId: number }) {
  const ftp = useServerFtp(serverId);
  if (!ftp.data) return null;
  return <FactRow label="FTP / SFTP" value={serverFtpSummary(ftp.data)} />;
}

function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-neutral-500">{label}</dt>
      <dd className="break-all font-medium">{value}</dd>
    </div>
  );
}

function MachineCard({ serverId }: { serverId: number }) {
  const info = useServerInfo(serverId);
  if (info.isPending) {
    return (
      <Card title="Machine">
        <EmptyState>
          <span className="inline-flex items-center gap-2">
            <Spinner />
            Asking the server…
          </span>
        </EmptyState>
      </Card>
    );
  }
  const dto: ServerSystemInfoDto | undefined = info.data;
  if (!dto || !dto.reachable) {
    return (
      <Card title="Machine">
        <p className="text-sm text-neutral-600">
          The server could not be asked what it is.
          {dto?.error ? <span className="mt-1 block break-words text-xs text-red-700">{dto.error}</span> : null}
        </p>
      </Card>
    );
  }
  // Everything here comes from files a Linux host has and nothing else does. A panel run
  // straight on macOS in dev is the honest case for this: it answered, and there was
  // nothing to read.
  const knowsNothing = [dto.os, dto.kernel, dto.cpuModel, dto.cpus, dto.memTotalBytes, dto.uptimeSeconds].every(
    (v) => v === null,
  );
  if (knowsNothing) {
    return (
      <Card title="Machine">
        <p className="text-sm text-neutral-600">
          This server answered but reported none of it — it has no <code>/proc</code> or{' '}
          <code>/etc/os-release</code> to read, which a Linux host always does.
        </p>
      </Card>
    );
  }
  return (
    <Card title="Machine">
      <dl className="space-y-2 text-sm">
        <FactRow label="Operating system" value={dto.os ?? '–'} />
        <FactRow label="Kernel" value={[dto.kernel, dto.arch].filter(Boolean).join(' · ') || '–'} />
        <FactRow label="Hostname" value={dto.hostname ?? '–'} />
        <FactRow
          label="CPU"
          value={[dto.cpus === null ? null : `${dto.cpus} core${dto.cpus === 1 ? '' : 's'}`, dto.cpuModel]
            .filter(Boolean)
            .join(' · ') || '–'}
        />
        <FactRow label="Memory" value={dto.memTotalBytes === null ? '–' : `${formatBytes(dto.memTotalBytes)} total`} />
        <FactRow label="Uptime" value={formatUptime(dto.uptimeSeconds)} />
        <FactRow label="Docker" value={dto.dockerVersion ?? '–'} />
      </dl>
      <p className="mt-3 text-xs text-neutral-400">Read {timeAgo(dto.readAt)}</p>
    </Card>
  );
}

/** The sites this machine runs, each a link into the site it is about. */
function SitesOnServer({ serverId, serverName }: { serverId: number; serverName: string }) {
  const sites = useSites();
  const monitor = useMonitor();
  const meta = useMeta();
  const navigate = useNavigate();
  const scheme = meta.data?.tlsMode === 'none' ? 'http' : 'https';
  const byslug = new Map((monitor.data?.sites ?? []).map((s) => [s.slug, s]));
  const mine = (sites.data ?? []).filter((s) => s.serverId === serverId);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Sites on {serverName}
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">{mine.length}</span>
        </span>
      }
      action={
        <Link className="action-link" to="/sites">
          All sites
        </Link>
      }
    >
      {sites.isPending ? (
        <EmptyState>Loading sites…</EmptyState>
      ) : mine.length === 0 ? (
        <EmptyState>
          No sites on this server yet.{' '}
          <Link className="underline" to="/sites/new">
            Create one
          </Link>
          .
        </EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
              <th className="pb-2" />
              <th className="pb-2">Site</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Mode</th>
              <th className="pb-2">PHP</th>
              <th className="pb-2 text-right">CPU</th>
              <th className="pb-2 text-right">Disk</th>
            </tr>
          </thead>
          <tbody>
            {mine.map((site) => {
              const m = byslug.get(site.slug);
              return (
                <tr
                  key={site.slug}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a, button')) return;
                    if (e.metaKey || e.ctrlKey) window.open(`/sites/${site.slug}`, '_blank');
                    else void navigate(`/sites/${site.slug}`);
                  }}
                  className="cursor-pointer border-t border-neutral-100 transition-colors hover:bg-neutral-50"
                >
                  <td className="py-2.5 pr-2">
                    <UpDot up={m?.up ?? site.up} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <Link to={`/sites/${site.slug}`} className="font-medium hover:underline">
                      {site.title}
                    </Link>
                    <div className="text-xs text-neutral-500">
                      <a
                        href={`${scheme}://${site.primaryDomain}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${site.primaryDomain} in a new tab`}
                        className="inline-flex items-center gap-1 hover:text-neutral-700 hover:underline"
                      >
                        {site.primaryDomain}
                        <ExternalLinkIcon />
                      </a>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <StatusBadge status={site.status} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <StatusBadge status={site.isLive ? 'live' : 'dev'} />
                  </td>
                  <td className="py-2.5 pr-3 text-neutral-600">{site.phpVersion}</td>
                  <td className="py-2.5 pr-3 text-right text-xs text-neutral-500">
                    {m?.cpuPct != null ? `${m.cpuPct.toFixed(1)}%` : '–'}
                  </td>
                  <td className="py-2.5 text-right text-xs text-neutral-500">{formatBytes(site.diskBytes)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/**
 * The editable half of a server row. Nothing here reaches the machine: it changes how the
 * panel addresses it, which is exactly what has to be fixable when the machine moved,
 * was reinstalled, or was auto-detected behind NAT.
 */
function EditServerModal({ server, onClose }: { server: ServerDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(server.name);
  const [publicIp, setPublicIp] = useState(server.publicIp);
  const [devDomain, setDevDomain] = useState(server.devDomain);
  const [sshHost, setSshHost] = useState(server.sshHost ?? '');
  const [sshPort, setSshPort] = useState(String(server.sshPort));
  const [sshUser, setSshUser] = useState(server.sshUser);
  const [retrust, setRetrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {};
    if (name !== server.name) body.name = name;
    if (publicIp !== server.publicIp) body.publicIp = publicIp;
    if (devDomain !== server.devDomain) body.devDomain = devDomain;
    if (server.kind === 'ssh') {
      if (sshHost !== server.sshHost) body.sshHost = sshHost;
      if (Number(sshPort) !== server.sshPort) body.sshPort = Number(sshPort);
      if (sshUser !== server.sshUser) body.sshUser = sshUser;
    }
    if (retrust) body.retrustHostKey = true;
    try {
      await api(`/api/servers/${server.id}`, { method: 'PATCH', body });
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['meta'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Settings: ${server.name}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field
          label="Public IP"
          hint="DNS records and move forwarding are built from this. Auto-detection picks the default route's source address, which is a private one behind NAT."
        >
          <input className={inputClass} value={publicIp} onChange={(e) => setPublicIp(e.target.value)} />
        </Field>
        <Field label="Dev domain" hint="Wildcard hostname new sites on this server get, e.g. dev.example.com.">
          <input className={inputClass} value={devDomain} onChange={(e) => setDevDomain(e.target.value)} />
        </Field>
        {server.kind === 'ssh' && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="SSH host">
              <input className={inputClass} value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
            </Field>
            <Field label="Port">
              <input className={inputClass} value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
            </Field>
            <Field label="User">
              <input className={inputClass} value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
            </Field>
          </div>
        )}
        <Toggle
          checked={retrust}
          onChange={setRetrust}
          label="Forget the pinned SSH host key (only after a legitimate reinstall)"
        />
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
