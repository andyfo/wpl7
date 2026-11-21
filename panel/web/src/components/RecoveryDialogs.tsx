// @docs servers/recover, backups/restore
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BackupDto, JobDto, ServerDto } from '../../../shared/types';
import { api } from '../api/client';
import { useRunJob, useServerRecovery, useServers, useSiteRecovery } from '../api/hooks';
import { useFollowJob } from './jobConsole/context';
import { Button, ErrorNote, Field, inputClass, Modal, Spinner } from './ui';
import { formatDate } from '../lib/format';
import { SITE_BACKUP_KINDS } from '../lib/backupFilters';
import { backupFrom, defaultServerTarget, recoveryLine } from '../lib/recovery';

const kindLabel = (type: string) => SITE_BACKUP_KINDS.find((k) => k.id === type)?.label ?? type;

/** While the panel asks the server, which takes up to 20 seconds when it does not answer. */
function Asking({ name }: { name: string }) {
  return (
    <p className="flex items-center gap-2 text-neutral-600">
      <Spinner /> Asking {name}…
    </p>
  );
}

/**
 * Bring one site back from a backup: on another server when its own does not answer, or on its
 * own once it is gone from there (services/recovery.ts says which). Closes once the job is
 * queued: the job console follows it from there.
 */
export function RecoverSiteDialog({ slug, serverName, onClose }: { slug: string; serverName: string; onClose: () => void }) {
  const recovery = useSiteRecovery(slug, true);
  const servers = useServers();
  const run = useRunJob([['site', slug], ['sites'], ['servers'], ['backups', slug]]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [backupId, setBackupId] = useState<number | null>(null);
  const r = recovery.data;
  const nameOf = (id: number) => servers.data?.find((srv) => srv.id === id)?.name ?? `server #${id}`;

  const target = r ? (r.targets.find((t) => t.id === targetId) ?? r.targets[0] ?? null) : null;
  const usable = r && target ? r.backups.filter((b) => backupFrom(b, target.id, nameOf) !== null) : [];
  const backup = usable.find((b) => b.id === backupId) ?? usable[0] ?? null;
  const why = !r || r.refusal ? null : !target ? 'There is no server to bring it back on.' : !backup ? `No backup of this site can reach ${target.name}.` : null;

  return (
    <Modal title="Recover site" onClose={onClose}>
      <div className="space-y-4 text-sm">
        {recovery.isPending ? (
          <Asking name={serverName} />
        ) : recovery.error ? (
          <ErrorNote error={recovery.error} />
        ) : r?.refusal ? (
          <p className="text-neutral-700">{r.refusal}</p>
        ) : (
          r && (
            <>
              <Field label="Backup">
                <select className={inputClass} value={backup?.id ?? ''} onChange={(e) => setBackupId(Number(e.target.value))}>
                  {usable.map((b) => (
                    <option key={b.id} value={b.id}>
                      {formatDate(b.createdAt)} · {kindLabel(b.type)} · {target ? backupFrom(b, target.id, nameOf) : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Target server">
                <select className={inputClass} value={target?.id ?? ''} onChange={(e) => setTargetId(Number(e.target.value))}>
                  {r.targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.publicIp ? ` (${t.publicIp})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-neutral-600">The site comes back as it was in this backup, on the server you pick.</p>
              {r.state === 'unreachable' && (
                <p className="text-neutral-600">If {r.serverName} answers again, its copy there is stopped and removed a day later.</p>
              )}
              {why && <p className="text-amber-800">{why}</p>}
              <ErrorNote error={run.error} />
            </>
          )
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {r && !r.refusal ? 'Cancel' : 'Close'}
          </Button>
          {r && !r.refusal && (
            <Button
              disabled={!backup || !target}
              title={why ?? undefined}
              busy={run.active}
              onClick={() =>
                backup &&
                target &&
                run.mutate({ path: `/api/sites/${slug}/recover`, body: { backupId: backup.id, targetServerId: target.id } }, { onSuccess: onClose })
              }
            >
              Recover
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Bring every site of a server back, each from its newest backup that reaches the target: the
 * server's page offers it while the server does not answer, or while its sites are down.
 */
export function RecoverServerDialog({ server, onClose }: { server: ServerDto; onClose: () => void }) {
  const recovery = useServerRecovery(server.id, true);
  const servers = useServers();
  const follow = useFollowJob();
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const r = recovery.data;
  const nameOf = (id: number) => servers.data?.find((srv) => srv.id === id)?.name ?? `server #${id}`;

  const target = r ? (r.targets.find((t) => t.id === targetId) ?? defaultServerTarget(r)) : null;
  const lines = r ? r.sites.map((site) => recoveryLine(site, target, nameOf)) : [];
  const count = lines.filter((line) => 'backup' in line).length;
  const keptElsewhere = r && target && target.id !== r.server.id ? r.external.length : 0;

  const recover = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ jobs: JobDto[] }>(`/api/servers/${server.id}/recover`, { method: 'POST', body: { targetServerId: target.id } });
      for (const job of res.jobs) {
        follow(job, { refresh: [['sites'], ['servers'], ...(job.siteSlug ? [['site', job.siteSlug]] : [])] });
      }
      void qc.invalidateQueries({ queryKey: ['sites'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Recover the sites of ${server.name}`} onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        {recovery.isPending ? (
          <Asking name={server.name} />
        ) : recovery.error ? (
          <ErrorNote error={recovery.error} />
        ) : (
          r && (
            <>
              <p className="text-neutral-600">
                {r.server.answers
                  ? `${server.name} answers. Sites that are gone from it come back from their newest backup.`
                  : `${server.name} does not answer. Its sites come back from their newest backup, and their copies there are stopped if it answers again.`}
              </p>
              <Field label="Target server">
                <select className={inputClass} value={target?.id ?? ''} onChange={(e) => setTargetId(Number(e.target.value))}>
                  {r.targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.publicIp ? ` (${t.publicIp})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              {lines.length === 0 ? (
                <p className="text-neutral-600">It hosts no sites.</p>
              ) : (
                <table className="w-full text-left">
                  <thead className="text-xs text-neutral-500">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Site</th>
                      <th className="py-1 pr-3 font-medium">Backup</th>
                      <th className="py-1 font-medium">From</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {lines.map((line) => (
                      <tr key={line.slug}>
                        <td className="py-1.5 pr-3 font-medium">{line.title}</td>
                        {'backup' in line ? (
                          <>
                            <td className="whitespace-nowrap py-1.5 pr-3">{formatDate(line.backup.createdAt)}</td>
                            <td className="py-1.5">{line.from}</td>
                          </>
                        ) : (
                          <td className="py-1.5 text-neutral-500" colSpan={2}>
                            {line.reason}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {keptElsewhere > 0 && target && (
                <p className="text-neutral-600">
                  {keptElsewhere === 1 ? 'One site hosted elsewhere keeps' : `${keptElsewhere} sites hosted elsewhere keep`} its backups on {target.name} from now on.
                </p>
              )}
              <ErrorNote error={error} />
            </>
          )
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {r && (
            <Button
              disabled={count === 0 && keptElsewhere === 0}
              title={count === 0 ? 'No site can come back on this server.' : undefined}
              busy={busy}
              onClick={() => void recover()}
            >
              {count === 0 ? `Keep their backups on ${target?.name ?? 'it'}` : count === 1 ? 'Recover 1 site' : `Recover ${count} sites`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Make a deleted site again from one of its backups, under its own name: Backups → All backups
 * offers it on a deleted site's complete backups.
 */
export function RestoreDeletedSiteDialog({ backup, onClose }: { backup: BackupDto; onClose: () => void }) {
  const servers = useServers();
  const run = useRunJob([['sites'], ['all-backups']]);
  const ok = (servers.data ?? []).filter((srv) => srv.status === 'ok');
  // Its files are on a server: there it comes back without a download.
  const preferred = backup.filesPresent ? ok.find((srv) => srv.id === backup.serverId) : undefined;
  const [targetId, setTargetId] = useState<number | null>(null);
  const target = ok.find((srv) => srv.id === targetId) ?? preferred ?? ok[0] ?? null;

  return (
    <Modal title={`Restore ${backup.siteSlug}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-neutral-600">The site is made again from this backup, with its name, domains and settings.</p>
        {ok.length > 1 && (
          <Field label="Target server">
            <select className={inputClass} value={target?.id ?? ''} onChange={(e) => setTargetId(Number(e.target.value))}>
              {ok.map((srv) => (
                <option key={srv.id} value={srv.id}>
                  {srv.name}
                  {srv.publicIp ? ` (${srv.publicIp})` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <ErrorNote error={run.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!target}
            busy={run.active}
            onClick={() =>
              target && run.mutate({ path: `/api/backups/${backup.id}/restore-site`, body: { targetServerId: target.id } }, { onSuccess: onClose })
            }
          >
            Restore
          </Button>
        </div>
      </div>
    </Modal>
  );
}
