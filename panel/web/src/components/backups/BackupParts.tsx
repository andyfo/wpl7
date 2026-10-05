import { useState } from 'react';
import { Link } from 'react-router';
import type { BackupCopyDto, BackupDto } from '../../../../shared/types';
import { api } from '../../api/client';
import { formatDate } from '../../lib/format';
import { Button, ConfirmDialog, Field, inputClass, Modal, Spinner, Toggle } from '../ui';

/**
 * The pieces a list of backups is made of, shared by a site's Backups tab and the Backups
 * page that lists every site's - including the sites that no longer exist.
 */

/**
 * One badge per destination this backup is meant to reach. A backup that exists in three
 * places and a backup that exists in one look different at a glance, which is the only
 * thing this column is for.
 */
export function OffsiteBadges({ copies }: { copies: BackupCopyDto[] }) {
  if (copies.length === 0) return <span className="text-xs text-neutral-400">–</span>;
  const style: Record<string, string> = {
    complete: 'bg-emerald-100 text-emerald-800',
    uploading: 'bg-amber-100 text-amber-800',
    pending: 'bg-neutral-200 text-neutral-600',
    failed: 'bg-red-100 text-red-800',
  };
  const glyph: Record<string, string> = { complete: '✓', uploading: '↑', pending: '…', failed: '✗' };
  return (
    <div className="flex flex-wrap gap-1">
      {copies.map((c) => (
        <span
          key={c.id}
          title={c.error ?? `${c.destinationName}: ${c.status}${c.completedAt ? ` (${formatDate(c.completedAt)})` : ''}`}
          className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${style[c.status] ?? 'bg-neutral-200'}`}
        >
          {glyph[c.status] ?? '?'} {c.destinationName}
        </span>
      ))}
    </div>
  );
}

/**
 * What can be done with a backup where it is listed. Only a complete one has files to download,
 * restore or fetch: a failed one never had any, and one being written has none yet.
 * `canRestore` is false where there is no site to restore onto - the panel's own snapshots, and
 * a deleted site's backups. One a deletion job is about to remove offers nothing but that job.
 */
export function BackupActions({
  backup,
  canRestore,
  onRestore,
  onFetch,
  onDelete,
}: {
  backup: BackupDto;
  canRestore: boolean;
  onRestore: () => void;
  onFetch: () => void;
  onDelete: () => void;
}) {
  const complete = backup.status === 'complete';
  if (backup.deletingJobId !== null) {
    return (
      <Link
        to={`/jobs/${backup.deletingJobId}`}
        className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-neutral-500 hover:underline"
      >
        <Spinner />
        Deleting…
      </Link>
    );
  }
  return (
    // Stacked on a phone, where three buttons side by side push the table off the screen.
    <div className="flex flex-col items-end gap-1 sm:flex-row sm:justify-end sm:gap-1.5">
      {complete && backup.filesPresent && (
        <>
          <a href={`/api/backups/${backup.id}/download`}>
            <Button small variant="ghost">Download</Button>
          </a>
          {canRestore && (
            <Button small variant="secondary" onClick={onRestore}>
              Restore
            </Button>
          )}
        </>
      )}
      {complete && !backup.filesPresent && (
        <Button small variant="secondary" onClick={onFetch}>
          <span className="whitespace-nowrap">Fetch back</span>
        </Button>
      )}
      <Button
        small
        variant="ghost"
        disabled={backup.status === 'creating'}
        title={backup.status === 'creating' ? 'Still being written' : undefined}
        onClick={onDelete}
      >
        Delete
      </Button>
    </div>
  );
}

/** Restoring replaces a live site; the dialog says which one when the page lists several. */
export function RestoreBackupDialog({
  site,
  onConfirm,
  onClose,
}: {
  /** The site's name, where it is not obvious from the page. */
  site?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title="Restore backup"
      message={
        <>
          Replaces {site ? <><b>{site}</b>'s</> : "the site's"} <b>files and database</b>. A safety backup is
          taken first, and the site is briefly stopped.
        </>
      }
      confirmLabel="Restore"
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

/** Pick which destination to pull a remote-only backup back from. */
export function FetchBackDialog({
  backup,
  target = "this site's server",
  onClose,
  onConfirm,
}: {
  backup: BackupDto;
  /** Where the files land, in words: the site's server, or the one a deleted site was on. */
  target?: string;
  onClose: () => void;
  onConfirm: (destinationId: number) => void;
}) {
  const available = backup.copies.filter((c) => c.status === 'complete');
  const [destinationId, setDestinationId] = useState(available[0]?.destinationId ?? 0);
  return (
    <Modal title="Fetch this backup back" onClose={onClose}>
      <div className="space-y-4 text-sm text-neutral-700">
        <p>The files are downloaded back onto {target} and verified.</p>
        {available.length > 1 && (
          <Field label="From">
            <select
              className={inputClass}
              value={destinationId}
              onChange={(e) => setDestinationId(Number(e.target.value))}
            >
              {available.map((c) => (
                <option key={c.id} value={c.destinationId}>
                  {c.destinationName}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!destinationId} onClick={() => onConfirm(destinationId)}>
            Fetch back
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Deleting a backup means deleting it, remote copies included — keeping them is the
 * deliberate choice, not the accidental one.
 */
export function DeleteBackupDialog({
  backup,
  warning,
  confirmWord,
  onClose,
  onDone,
  onError,
}: {
  backup: BackupDto;
  /**
   * Said first, in bold: what this backup is that makes deleting it worse than usual. Not while
   * the remote copies are being kept, which keeps the backup.
   */
  warning?: string;
  /** Has to be typed to delete it, for the one whose loss cannot be made good. */
  confirmWord?: string;
  onClose: () => void;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const offsiteCopies = backup.copies.filter((c) => c.status === 'complete');
  const [keepOffsite, setKeepOffsite] = useState(false);
  return (
    <ConfirmDialog
      title="Delete backup"
      confirmLabel="Delete"
      // Keeping the remote copies keeps the backup, so there is nothing to type then.
      confirmWord={keepOffsite ? undefined : confirmWord}
      message={
        <>
          {warning && !keepOffsite && <b className="mb-2 block">{warning}</b>}
          {offsiteCopies.length === 0 ? (
            'The backup files are removed permanently.'
          ) : keepOffsite ? (
            <>The files on the server are removed; the {offsiteCopies.length} remote copy/copies are kept.</>
          ) : (
            <>
              The backup files are removed permanently, <b>including</b> the {offsiteCopies.length} remote
              copy/copies ({offsiteCopies.map((c) => c.destinationName).join(', ')}).
            </>
          )}
        </>
      }
      onConfirm={() => {
        onError(null);
        void api(`/api/backups/${backup.id}?keepOffsite=${keepOffsite}`, { method: 'DELETE' })
          .then(onDone)
          .catch(onError);
      }}
      onClose={onClose}
    >
      {offsiteCopies.length > 0 && backup.filesPresent && (
        <Toggle checked={keepOffsite} onChange={setKeepOffsite} label="Keep the remote copies" />
      )}
    </ConfirmDialog>
  );
}

/**
 * Deleting several backups at once. Always typed for (see bulkDeleteSafeguard), and said in
 * full: how many, that their remote copies go too, and what a deleted site is left with.
 */
export function BulkDeleteBackupsDialog({
  title,
  remote,
  warning,
  confirmWord,
  onConfirm,
  onClose,
}: {
  title: string;
  /**
   * The completed remote copies of the backups selected. `destinations` is null where the
   * selection reaches past this page and only the count is known.
   */
  remote: { copies: number; destinations: string[] | null };
  warning?: string;
  confirmWord: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title={title}
      confirmLabel="Delete"
      confirmWord={confirmWord}
      message={
        <>
          {warning && <b className="mb-2 block">{warning}</b>}
          {remote.copies === 0 ? (
            'Their files are removed permanently.'
          ) : (
            <>
              Their files are removed permanently, <b>including</b> the {remote.copies} remote copy/copies
              {remote.destinations ? ` (${remote.destinations.join(', ')})` : ''}.
            </>
          )}
          <span className="mt-2 block text-xs text-neutral-500">
            One job deletes them in turn. A backup another job may be using is left alone, and the job names it.
          </span>
        </>
      }
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
