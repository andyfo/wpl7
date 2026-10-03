import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MountOption, ServerStorageDto } from '../../../shared/types';
import { backupRootProblem, normalizeAbsolutePath } from '../../../shared/backupRoot';
import { api } from '../api/client';
import { isTerminal, useJob, useServerStorage } from '../api/hooks';
import { formatBytes } from '../lib/format';
import { JobProgress } from './JobProgress';
import { Button, CopyField, ErrorNote, Field, inputClass, Modal, Spinner, Toggle } from './ui';

/**
 * Where one server keeps its backups.
 *
 * The form is deliberately about the machine rather than about a text field: it shows the
 * disk the current location sits on, how much is free, how many backups are already there,
 * and every filesystem the server has as a one-click suggestion — because "which disk" is
 * the question being answered, and a path is only how the answer is spelled.
 *
 * Server 1 has a second constraint nothing else has. The panel runs in a container that can
 * only see what compose mounted, and it cannot recreate itself to mount more. So when the
 * chosen path is not mounted into the panel, this shows the two commands to run instead of
 * an Apply button that would quietly not work.
 */
export function StorageModal({
  serverId,
  serverName,
  onClose,
}: {
  serverId: number;
  serverName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState<string | null>(null);
  const [moveExisting, setMoveExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const job = useJob(jobId);

  // Two queries on purpose: the left half always describes where backups are now, the right
  // half describes wherever the field currently points.
  const current = useServerStorage(serverId);
  const candidate = useServerStorage(serverId, typed ?? undefined);

  const srvHint = current.data?.defaultRoot.replace(/\/backups$/, '') ?? '/srv';
  const trimmed = typed === null ? null : typed.trim();
  const localProblem = trimmed === null || trimmed === '' ? null : backupRootProblem(trimmed, srvHint);
  const dirty = trimmed !== null && trimmed !== '' && trimmed !== current.data?.backupRoot;

  /**
   * Is the candidate query talking about what is in the box right now? It is debounced, and
   * while the field is empty it even shares its cache key with the current location — so
   * for a moment after every click it still holds another directory's answer, and a verdict
   * on the wrong directory is worse than none. This is why a green "Ready" and a "move
   * these backups" toggle used to flash up for a path the panel was about to refuse.
   */
  const probeIsCurrent = candidate.probedPath === (typed ?? '');
  const settled =
    trimmed && !localProblem && probeIsCurrent && candidate.data?.backupRoot === normalizeAbsolutePath(trimmed)
      ? candidate.data
      : undefined;
  // A check that came back as an error is not a check still running: retries are off, so
  // without this the form would sit on "Checking…" with Apply greyed out and no way out.
  const checkFailed = !!trimmed && !localProblem && probeIsCurrent && candidate.isError;
  const checking = !!trimmed && !localProblem && !settled && !checkFailed;
  /**
   * What the notes below the field are talking about. An untouched form has no candidate to
   * report on - but it still has to show the instructions box when the location in force is
   * one the panel cannot write to, which is a standing problem and not a typing mistake.
   */
  const focus = typed === null ? current.data : settled;
  const blocked = !!localProblem || !settled || !settled.visibleInPanel;
  const existingHere = current.data?.backups.count ?? 0;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['server-storage'] });
    void qc.invalidateQueries({ queryKey: ['servers'] });
    void qc.invalidateQueries({ queryKey: ['meta'] });
  };

  const apply = async () => {
    if (!dirty) return;
    setBusy(true);
    setError(null);
    try {
      if (moveExisting && existingHere > 0) {
        const res = await api<{ job: { id: number } }>(`/api/servers/${serverId}/backups/relocate`, {
          method: 'POST',
          body: { to: trimmed! },
        });
        setJobId(res.job.id);
      } else {
        await api(`/api/servers/${serverId}`, { method: 'PATCH', body: { backupRoot: trimmed! } });
        refresh();
        onClose();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (jobId !== null) {
    return (
      <Modal title={`Moving backups on "${serverName}"`} onClose={onClose}>
        <div className="space-y-3">
          <JobProgress job={job.job} logs={job.logs} />
          {isTerminal(job.job?.status) && (
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  refresh();
                  onClose();
                }}
              >
                Done
              </Button>
            </div>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Backup storage on "${serverName}"`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        {current.isPending ? (
          <div className="py-6 text-center">
            <Spinner />
          </div>
        ) : current.isError ? (
          <CheckFailed
            error={current.error}
            onRetry={() => void current.refetch()}
            what="read this server's backup location"
          />
        ) : (
          <CurrentLocation dto={current.data} />
        )}

        <Field label="Location" hint="Backups are written to <location>/<site>/<timestamp>.">
          <input
            className={inputClass}
            value={typed ?? current.data?.backupRoot ?? ''}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
          />
        </Field>

        {localProblem ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{localProblem}</p>
        ) : checkFailed ? (
          <CheckFailed error={candidate.error} onRetry={() => void candidate.refetch()} />
        ) : checking ? (
          <p className="text-xs text-neutral-500">Checking…</p>
        ) : (
          // With the instructions box showing, the same sentence opens it - saying it twice
          // reads as two separate problems. An untouched form says nothing at all: "Ready"
          // under a field nobody has edited is a verdict on an edit that never happened.
          settled && !settled.mountInstructions && <CandidateNote dto={settled} />
        )}

        <Disks
          mounts={current.data?.mounts ?? []}
          currentDisk={current.data?.disk ?? null}
          currentRoot={current.data?.backupRoot ?? ''}
          onPick={setTyped}
        />

        {current.data?.discoveryError && (
          <p className="text-xs text-amber-700">
            Could not inspect this server&apos;s disks: {current.data.discoveryError}
          </p>
        )}

        {focus?.mountInstructions && (
          <MountInstructions dto={focus} defaultRoot={current.data?.defaultRoot ?? '/srv/backups'} />
        )}

        {existingHere > 0 && dirty && !blocked && (
          <Toggle
            checked={moveExisting}
            onChange={setMoveExisting}
            label={`Move the ${existingHere} backup(s) already here (copy, verify, then remove)`}
          />
        )}

        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button disabled={!dirty || blocked || busy} onClick={() => void apply()}>
            {busy ? <Spinner /> : moveExisting && existingHere > 0 ? 'Apply and move backups' : 'Apply'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * A lookup that failed rather than one still running. Both halves of this form are a
 * request to the server, and either can fail on its own - saying which, and offering the
 * one button that can do anything about it, is the difference between a stuck dialog and
 * a slow one.
 */
function CheckFailed({
  error,
  onRetry,
  what = 'check this location',
}: {
  error: unknown;
  onRetry: () => void;
  what?: string;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
      <p>
        Could not {what}: {message}
      </p>
      <button type="button" className="mt-1 font-medium underline" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function CurrentLocation({ dto }: { dto: ServerStorageDto | undefined }) {
  if (!dto) return null;
  return (
    <div className="rounded-lg bg-neutral-50 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <code className="text-xs">{dto.backupRoot}</code>
        {dto.isDefault && <span className="shrink-0 text-[11px] text-neutral-500">default location</span>}
      </div>
      <div className="mt-1 text-xs text-neutral-500">
        {dto.disk ? (
          <>
            {dto.disk.source} ({dto.disk.fstype}) · {formatBytes(dto.disk.freeBytes)} free of{' '}
            {formatBytes(dto.disk.totalBytes)}
          </>
        ) : (
          'disk unknown'
        )}
        {' · '}
        {dto.backups.count} backup(s) here, {formatBytes(dto.backups.bytes)}
      </div>
    </div>
  );
}

/**
 * The disks this machine has. Each row is one filesystem, named by its mount point and its
 * device — what it *is* — with the path that clicking it would use spelled out underneath.
 * Labelling the row with that path instead (which this did) invented a filesystem nobody
 * has: "/backups" is not a disk, it is a directory that would be created on the disk
 * mounted at "/".
 *
 * The disk the backups already sit on is shown, because how full it is belongs in this
 * list, but it is not offered as a choice: picking it would mean a second backup directory
 * on the disk the backups are already on, at the cost of a container remount.
 */
function Disks({
  mounts,
  currentDisk,
  currentRoot,
  onPick,
}: {
  mounts: MountOption[];
  currentDisk: MountOption | null;
  currentRoot: string;
  onPick: (path: string) => void;
}) {
  if (mounts.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
        Disks on this server
      </div>
      <ul className="space-y-1">
        {mounts.map((m) => {
          const inUse = currentDisk !== null && m.target === currentDisk.target;
          const head = (
            <>
              <div className="flex items-center justify-between gap-3">
                <span>
                  <code className="text-xs font-medium">{m.target}</code>
                  <span className="ml-2 text-xs text-neutral-500">
                    {m.source} · {m.fstype}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatBytes(m.freeBytes)} free of {formatBytes(m.totalBytes)}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-neutral-500">
                {inUse ? (
                  <>
                    backups are already on this disk, in <code>{currentRoot}</code>
                  </>
                ) : (
                  <>
                    use <code>{m.suggested}</code>
                  </>
                )}
              </div>
            </>
          );
          return (
            <li key={`${m.target}:${m.source}`}>
              {inUse ? (
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5">{head}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => onPick(m.suggested)}
                  className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-left hover:bg-neutral-50"
                >
                  {head}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CandidateNote({ dto }: { dto: ServerStorageDto }) {
  if (dto.reason) {
    // "Does not exist yet" is information, not a problem: it gets created on apply.
    const benign = !dto.exists && dto.visibleInPanel;
    return <p className={`text-xs ${benign ? 'text-neutral-500' : 'text-amber-700'}`}>{dto.reason}</p>;
  }
  return (
    <p className="text-xs text-emerald-700">
      Ready
      {dto.disk ? ` — ${dto.disk.source} (${dto.disk.fstype}), ${formatBytes(dto.disk.freeBytes)} free` : ''}
      {dto.backups.count > 0 ? ` · ${dto.backups.count} backup(s) already here` : ''}
    </p>
  );
}

/**
 * The one case the panel cannot fix for itself: a path outside what compose mounted into
 * its container. Mounting it needs a compose change and a recreate, which is the one thing
 * a process cannot do to its own container — so this is a two-step recipe, not an error.
 */
function MountInstructions({ dto, defaultRoot }: { dto: ServerStorageDto; defaultRoot: string }) {
  const steps = dto.mountInstructions!;
  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <p className="text-xs font-medium text-amber-900">
        <code>{dto.backupRoot}</code> is not mounted into the panel container yet.
      </p>
      <p className="text-xs text-amber-900">
        The panel cannot recreate itself, so this takes two steps on the host:
      </p>
      <p className="text-xs text-amber-900">
        <b>1.</b> Add this line to <code>deploy/.env</code>
      </p>
      <CopyField value={steps.envLine} tone="plain" />
      <p className="text-xs text-amber-900">
        <b>2.</b> Recreate the panel — which creates the directory and mounts it
      </p>
      <CopyField value={steps.command} tone="plain" />
      <p className="text-xs text-amber-900">
        Come back here afterwards and apply. Or mount the disk at <code>{defaultRoot}</code> instead and change
        nothing here.
      </p>
    </div>
  );
}
