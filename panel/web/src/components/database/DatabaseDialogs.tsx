// @docs databases/overview, sites/database
import { useEffect, useRef, useState } from 'react';
import { extraDbNameSchema } from '../../../../shared/databases';
import type { SiteSummary } from '../../../../shared/types';
import { discardUpload, newDumpUploadId, prepareDump, uploadDump } from '../../api/databases';
import { useRunJob } from '../../api/hooks';
import { formatBytes } from '../../lib/format';
import { Button, ErrorNote, Field, inputClass, Modal, Toggle } from '../ui';

/** What a new database's name box suggests: the site's slug, as database names spell it. */
/** The site's slug as a start for the name; without a leading wp_, which is kept for the sites' own. */
const suggestion = (slug: string) => `${slug.replace(/-/g, '_').replace(/^wp_/, '')}_`;

/**
 * Add another database to a site. On a site's own tab the site is given; on the Databases page it
 * is picked here first.
 */
export function AddDatabaseDialog({
  slug,
  sites,
  onClose,
  onDone,
}: {
  slug?: string;
  /** The sites to pick from, when no site is given. */
  sites?: SiteSummary[];
  onClose: () => void;
  onDone?: () => void;
}) {
  const run = useRunJob([['site-databases'], ['databases']]);
  const choices = (sites ?? []).filter((s) => s.kind !== 'external' && s.status !== 'provisioning' && s.status !== 'deleting');
  const [site, setSite] = useState(slug ?? choices[0]?.slug ?? '');
  const [name, setName] = useState(site ? suggestion(site) : '');
  const [touched, setTouched] = useState(false);
  const check = extraDbNameSchema.safeParse(name);
  const problem = check.success ? null : (check.error.issues[0]?.message ?? 'not a valid name');

  const pick = (next: string) => {
    // Keep what was typed after the suggestion; follow the site only while nothing was.
    if (!touched || name === suggestion(site)) setName(suggestion(next));
    setSite(next);
  };

  return (
    <Modal title="Add database" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!site || problem) return;
          run.mutate(
            { path: `/api/sites/${site}/databases`, body: { name }, action: 'add' },
            {
              onSuccess: () => {
                onDone?.();
                onClose();
              },
            },
          );
        }}
      >
        {!slug && (
          <Field label="Site">
            <select className={inputClass} value={site} onChange={(e) => pick(e.target.value)}>
              {choices.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.title} ({s.slug})
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Name" hint="Lowercase letters, digits and _. It uses the site's database login.">
          <input
            className={inputClass}
            value={name}
            autoFocus
            spellCheck={false}
            onChange={(e) => {
              setTouched(true);
              setName(e.target.value);
            }}
          />
        </Field>
        {problem && (touched || name !== '') && <p className="text-xs text-red-600">{problem}</p>}
        <ErrorNote error={run.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!site || !!problem} title={problem ?? undefined} busy={run.isPending}>
            Add database
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Load a dump into one of a site's databases: the file goes up in chunks (a plain .sql is gzipped
 * first), then a job imports it. The dialog closes once the job is queued; the job console follows it.
 */
export function ImportDialog({ slug, db, onClose }: { slug: string; db: string; onClose: () => void }) {
  const run = useRunJob([['site-databases', slug], ['db-tables', slug], ['db-rows', slug], ['db-structure', slug], ['databases']]);
  const [file, setFile] = useState<File | null>(null);
  const [backupFirst, setBackupFirst] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; total: number; phase: 'compressing' | 'uploading' } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const abort = useRef<AbortController | null>(null);
  /**
   * The upload this dialog fills, and the bytes it sends: tried again, the same file goes to the
   * same id and carries on where it stopped. Null once an import owns it.
   */
  const upload = useRef<{ id: string; file: File; blob: Blob | null } | null>(null);

  // Closed half-way, or after a failure: stop sending, and leave nothing behind on the server.
  useEffect(
    () => () => {
      abort.current?.abort();
      if (upload.current) void discardUpload(slug, upload.current.id);
    },
    [slug],
  );

  const pick = (next: File | null) => {
    if (upload.current && upload.current.file !== next) {
      void discardUpload(slug, upload.current.id);
      upload.current = null;
    }
    setFile(next);
  };

  const start = async () => {
    if (!file) return;
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    upload.current ??= { id: newDumpUploadId(), file, blob: null };
    const current = upload.current;
    try {
      current.blob ??= await prepareDump(file, () => setProgress({ sent: 0, total: file.size, phase: 'compressing' }), controller.signal);
      await uploadDump(slug, current.id, current.blob, (sent, total) => setProgress({ sent, total, phase: 'uploading' }), controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) setError(err);
      setProgress(null);
      return;
    }
    run.mutate(
      { path: `/api/sites/${slug}/databases/${db}/import`, body: { uploadId: current.id, empty, backupFirst }, action: 'import' },
      {
        onSuccess: () => {
          // The job owns the upload now.
          upload.current = null;
          onClose();
        },
        onError: () => setProgress(null),
      },
    );
  };

  const busy = progress !== null || run.isPending;
  return (
    <Modal title={`Import into ${db}`} onClose={onClose} dismissible={!busy}>
      <div className="space-y-4 text-sm">
        <Field label="File" hint=".sql or .sql.gz, up to 4 GB compressed." width="lg">
          <input
            type="file"
            accept=".sql,.gz,application/sql,application/gzip"
            disabled={busy}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className="block text-sm"
          />
        </Field>
        <div className="space-y-2">
          <Toggle checked={backupFirst} onChange={setBackupFirst} disabled={busy} label="Back up the site first" />
          <Toggle
            checked={empty}
            onChange={setEmpty}
            disabled={busy}
            label={`Delete every table in ${db} first`}
          />
        </div>
        {progress && (
          <div>
            <div className="mb-1 text-xs text-neutral-500">
              {progress.phase === 'compressing'
                ? 'Compressing…'
                : `Uploading ${formatBytes(progress.sent)} of ${formatBytes(progress.total)}`}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200">
              <div
                className="h-full bg-emerald-500 transition-[width]"
                style={{ width: `${progress.total ? Math.round((progress.sent / progress.total) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}
        <ErrorNote error={error ?? run.error} />
        <div className="flex justify-end gap-2">
          {/* Not while the import is being asked for: closing would remove the upload it is about to use. */}
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={!file} busy={busy}>
            Import
          </Button>
        </div>
      </div>
    </Modal>
  );
}
