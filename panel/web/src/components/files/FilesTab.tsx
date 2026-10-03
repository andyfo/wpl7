import { lazy, Suspense, useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { SiteFileEntryDto } from '../../../../shared/types';
import { FILE_LIMITS, joinSiteFilePath, siteFileBase, siteFileParent } from '../../../../shared/siteFilePath';
import { ApiError } from '../../api/client';
import { downloadUrl, fileOp, saveFile } from '../../api/files';
import { useRunJob, useSiteFiles } from '../../api/hooks';
import { imageTypeFor, isKnownBinary, isZip } from '../../lib/fileKinds';
import { Button, ConfirmDialog, EmptyState, ErrorNote, inputClass, Spinner } from '../ui';
import { Icon } from '../Icon';
import { JobProgress } from '../JobProgress';
import { isFolderLike, type MenuItem } from './common';
import { FileTable } from './FileTable';
import { ChmodDialog, CompressDialog, ExtractDialog, MoveDialog, NewEntryDialog } from './FileDialogs';
import { SearchPanel } from './SearchPanel';
import { UploadPanel, useUploads } from './UploadPanel';
import { ImagePreview } from './ImagePreview';

// The editor is the heaviest thing in the panel (CodeMirror and its languages); it loads
// the first time a file is opened, not with the site page.
const FileEditor = lazy(() => import('./FileEditor'));

/** Paths the delete confirmation lists by name; a whole folder's worth is summed up after them. */
const DELETE_LISTED = 100;

type Dialog =
  | { kind: 'new-file' }
  | { kind: 'new-folder' }
  | { kind: 'move'; path: string }
  | { kind: 'copy'; path: string }
  | { kind: 'chmod'; path: string; entry: SiteFileEntryDto }
  | { kind: 'delete'; paths: string[]; folders: boolean }
  | { kind: 'extract'; path: string }
  | { kind: 'compress'; paths: string[] }
  | { kind: 'fix-ownership' }
  | { kind: 'replace'; files: File[]; existing: string[] };

/**
 * Web FTP: a site's files, from its WordPress folder down. Everything here happens inside the
 * site's own container as its own user (see services/siteFiles.ts on the panel side), so what
 * the tab can do is exactly what the site's PHP can do.
 *
 * The folder and the open file live in the URL (`?tab=files&dir=…&file=…`), so a folder can be
 * linked to, and Back closes the editor or goes up.
 */
export function FilesTab({ slug }: { slug: string }) {
  const [params, setParams] = useSearchParams();
  const dir = params.get('dir') ?? '';
  const file = params.get('file');
  const line = Number(params.get('line')) || undefined;
  const editAsText = params.get('edit') === '1';
  const qc = useQueryClient();
  const listing = useSiteFiles(slug, dir);
  // The selection and an open dialog belong to the folder they were made in. Back, Forward
  // and a search result change `dir` without goTo(), and a name picked in one folder must
  // never be acted on in another: `config.php` ticked in a subfolder is not the site's own.
  const [selection, setSelection] = useState<{ dir: string; names: ReadonlySet<string> }>({ dir, names: new Set() });
  const [dialogAt, setDialogAt] = useState<{ dir: string; dialog: Dialog } | null>(null);
  const dialog = dialogAt?.dir === dir ? dialogAt.dialog : null;
  const setDialog = (next: Dialog | null) => setDialogAt(next ? { dir, dialog: next } : null);
  const setSelected = (names: ReadonlySet<string>) => setSelection({ dir, names });
  const [filter, setFilter] = useState('');
  const [searching, setSearching] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const archiveJob = useRunJob([['site-files', slug]]);
  const startJob = useRunJob([['site-files', slug], ['site', slug]]);

  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ['site-files', slug] }), [qc, slug]);
  const uploads = useUploads(slug, refresh);

  const navigate = (next: Record<string, string | undefined>, replace = false) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p);
        out.set('tab', 'files');
        for (const [k, v] of Object.entries(next)) {
          if (v === undefined || v === '') out.delete(k);
          else out.set(k, v);
        }
        return out;
      },
      { replace },
    );
  const goTo = (path: string) => {
    setSelected(new Set());
    setFilter('');
    setNotice(null);
    navigate({ dir: path, file: undefined, line: undefined, edit: undefined });
  };
  const openFile = (path: string, opts: { line?: number; asText?: boolean } = {}) =>
    navigate({
      dir: siteFileParent(path),
      file: path,
      line: opts.line ? String(opts.line) : undefined,
      edit: opts.asText ? '1' : undefined,
    });
  const closeFile = () => navigate({ file: undefined, line: undefined, edit: undefined });

  const entries = listing.data?.entries ?? [];
  const pathOf = (e: SiteFileEntryDto) => joinSiteFilePath(dir, e.name);
  // What is selected in this folder, of what it holds now: a name deleted or renamed since
  // it was ticked is no longer selected.
  const selected = useMemo(
    () => new Set(selection.dir === dir ? entries.filter((e) => selection.names.has(e.name)).map((e) => e.name) : []),
    [selection, dir, entries],
  );

  /** A click on a row: into a folder, an image into the preview, text into the editor, the rest downloads. */
  const openEntry = (e: SiteFileEntryDto) => {
    const path = pathOf(e);
    setNotice(null);
    if (isFolderLike(e)) return goTo(path);
    if (e.type === 'link' && e.targetType === null) {
      return setNotice(`"${e.name}" points to ${e.target ?? 'nothing'}, which does not exist.`);
    }
    if (e.type === 'other') return setNotice(`"${e.name}" is not a regular file (a socket, a device or a pipe).`);
    if (imageTypeFor(e.name)) return openFile(path);
    if (isKnownBinary(e.name) || (e.type === 'file' && e.size > FILE_LIMITS.editBytes)) {
      return location.assign(downloadUrl(slug, path));
    }
    openFile(path);
  };

  const run = (work: Promise<unknown>) => {
    setActionError(null);
    // Refreshed either way: a batch that failed part-way changed some of the folder.
    work.catch(setActionError).finally(refresh);
  };

  /**
   * Delete in requests of at most FILE_LIMITS.batchPaths - a whole folder can be selected,
   * and one request may name no more. Each request deletes all of its paths or none; the
   * ones before a failure stay deleted, and the notice says how many that was. The selection
   * is let go only once everything went.
   */
  const deletePaths = async (paths: string[]) => {
    const from = dir;
    let deleted = 0;
    setNotice(null);
    try {
      for (let i = 0; i < paths.length; i += FILE_LIMITS.batchPaths) {
        const batch = paths.slice(i, i + FILE_LIMITS.batchPaths);
        await fileOp<{ deleted: number }>(slug, 'delete', { paths: batch });
        deleted += batch.length;
      }
      setSelection((s) => (s.dir === from ? { dir: from, names: new Set() } : s));
    } catch (err) {
      if (deleted > 0) setNotice(`Deleted ${deleted} of ${paths.length} before the error below.`);
      throw err;
    }
  };

  const menuFor = (e: SiteFileEntryDto): MenuItem[] => {
    const path = pathOf(e);
    const folder = isFolderLike(e);
    const items: MenuItem[] = [];
    if (!folder) items.push({ label: imageTypeFor(e.name) ? 'Preview' : 'Open', onSelect: () => openEntry(e) });
    if (imageTypeFor(e.name) === 'image/svg+xml') items.push({ label: 'Edit as text', onSelect: () => openFile(path, { asText: true }) });
    items.push({ label: folder ? 'Download as .tar.gz' : 'Download', onSelect: () => location.assign(downloadUrl(slug, path)) });
    if (isZip(e.name)) items.push({ label: 'Extract…', onSelect: () => setDialog({ kind: 'extract', path }) });
    items.push(
      { label: 'Compress to .zip…', onSelect: () => setDialog({ kind: 'compress', paths: [path] }) },
      { label: 'Rename or move…', onSelect: () => setDialog({ kind: 'move', path }) },
      { label: 'Duplicate…', onSelect: () => setDialog({ kind: 'copy', path }) },
      {
        label: 'Permissions…',
        onSelect: () => setDialog({ kind: 'chmod', path, entry: e }),
        disabled: e.type === 'link',
        title: e.type === 'link' ? 'A link has no permissions of its own' : undefined,
      },
      { label: 'Delete…', danger: true, onSelect: () => setDialog({ kind: 'delete', paths: [path], folders: e.type === 'dir' }) },
    );
    return items;
  };

  const queueUploads = (files: File[]) => {
    if (files.length === 0) return;
    const existing = new Set(entries.filter((e) => !isFolderLike(e)).map((e) => e.name));
    const clashes = files.filter((f) => existing.has(f.name)).map((f) => f.name);
    if (clashes.length > 0) return setDialog({ kind: 'replace', files, existing: clashes });
    uploads.add(files, dir, () => false);
  };

  const listingError = listing.error;
  const stopped = listingError instanceof ApiError && listingError.status === 409 && /start the site/.test(listingError.message);
  const missing = listingError instanceof ApiError && listingError.status === 404;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (stopped) return;
    // A dropped folder arrives as a "file" too; only the entry API can tell them apart.
    const dropped = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const isFolder = dropped.map((i) => i.webkitGetAsEntry?.()?.isDirectory === true);
    const folders = isFolder.filter(Boolean).length;
    const files = [...e.dataTransfer.files].filter((_f, i) => !isFolder[i]);
    if (folders > 0) setNotice('Folders cannot be uploaded as they are: zip the folder, upload the .zip, then Extract it here.');
    queueUploads(files);
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? entries.filter((e) => e.name.toLowerCase().includes(f)) : entries;
  }, [entries, filter]);
  const openEntryDto = file ? (entries.find((e) => pathOf(e) === file) ?? null) : null;
  const selectedPaths = [...selected].map((name) => joinSiteFilePath(dir, name));
  // Compress is one archive, so one request, and a request names at most this many.
  const tooManyToCompress = selected.size > FILE_LIMITS.batchPaths;

  // The open file, over whatever the tab shows beneath it - including "the site is stopped",
  // which a refresh can turn up while the editor holds unsaved text.
  const openView =
    file && imageTypeFor(file) && !editAsText ? (
      <ImagePreview
        slug={slug}
        path={file}
        onClose={closeFile}
        onEdit={imageTypeFor(file) === 'image/svg+xml' ? () => openFile(file, { asText: true }) : undefined}
      />
    ) : (
      file && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-surface">
              <Spinner />
            </div>
          }
        >
          <FileEditor
            key={file}
            slug={slug}
            path={file}
            entry={openEntryDto}
            line={line}
            onClose={closeFile}
            onSaved={refresh}
          />
        </Suspense>
      )
    );

  return (
    <div
      className="relative space-y-3"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        // Taken even while the site is stopped: a file dropped where nothing takes it is
        // opened by the browser, which leaves the panel.
        e.preventDefault();
        if (!stopped) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {stopped ? (
        <div className="panel-card">
          <div className="panel-card-body space-y-3">
            <EmptyState>
              The site is stopped. Its files can be browsed and edited while it runs.
              <div className="mt-3">
                <Button
                  small
                  disabled={startJob.isPending || (startJob.job !== null && startJob.job.status !== 'failed')}
                  onClick={() => startJob.mutate({ path: `/api/sites/${slug}/start` })}
                >
                  Start the site
                </Button>
              </div>
            </EmptyState>
            <JobProgress job={startJob.job} logs={startJob.logs} />
            <ErrorNote error={startJob.error} />
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Breadcrumbs slug={slug} dir={dir} onGo={goTo} />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button small variant={searching ? 'primary' : 'secondary'} onClick={() => setSearching((v) => !v)}>
                <Icon name="search" size={14} /> Search
              </Button>
              <Button small variant="secondary" onClick={() => fileInput.current?.click()} disabled={!listing.data?.writable}>
                <Icon name="upload" size={14} /> Upload
              </Button>
              <Button small variant="secondary" onClick={() => setDialog({ kind: 'new-file' })} disabled={!listing.data?.writable}>
                New file
              </Button>
              <Button small variant="secondary" onClick={() => setDialog({ kind: 'new-folder' })} disabled={!listing.data?.writable}>
                New folder
              </Button>
              <button
                type="button"
                aria-label="Refresh"
                title="Refresh"
                onClick={refresh}
                className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
              >
                <Icon name="refresh" size={16} />
              </button>
              <FolderMenu
                onDownload={() => location.assign(downloadUrl(slug, dir))}
                onFixOwnership={() => setDialog({ kind: 'fix-ownership' })}
              />
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                queueUploads([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </div>

          {searching && (
            <SearchPanel
              slug={slug}
              dir={dir}
              onOpenFolder={goTo}
              onOpenFile={(path, at) => openFile(path, { line: at })}
              onClose={() => setSearching(false)}
            />
          )}
          <UploadPanel uploads={uploads} />
          <JobProgress job={archiveJob.job} logs={archiveJob.logs} />
          {notice && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</div>}
          <ErrorNote error={actionError} />
          {listing.data && !listing.data.writable && (
            <p className="text-xs text-amber-700">
              The site's user (www-data) cannot change this folder, so nothing can be added or renamed here. "Fix ownership"
              in the ⋯ menu hands it back to the site.
            </p>
          )}

          <div className="panel-card">
            <div className="flex flex-wrap items-center gap-3 border-b border-neutral-100 px-4 py-2.5">
              <input
                className={`${inputClass} max-w-64 py-1.5 text-xs`}
                placeholder="Filter this folder"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {selected.size > 0 ? (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-neutral-600">{selected.size} selected</span>
                  <Button
                    small
                    variant="secondary"
                    disabled={tooManyToCompress}
                    onClick={() => setDialog({ kind: 'compress', paths: selectedPaths })}
                  >
                    Compress
                  </Button>
                  <Button
                    small
                    variant="danger"
                    onClick={() =>
                      setDialog({
                        kind: 'delete',
                        paths: selectedPaths,
                        folders: entries.some((e) => selected.has(e.name) && e.type === 'dir'),
                      })
                    }
                  >
                    Delete
                  </Button>
                  <Button small variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                  {tooManyToCompress && (
                    <span className="text-xs text-neutral-500">
                      Compress takes {FILE_LIMITS.batchPaths} at most - compress the folder that holds them instead
                    </span>
                  )}
                </div>
              ) : (
                listing.data && (
                  <span className="text-xs text-neutral-500">
                    {entries.length} item{entries.length === 1 ? '' : 's'}
                    {listing.data.truncated && ` - only the first ${FILE_LIMITS.listEntries} are listed; search to find the rest`}
                  </span>
                )
              )}
              <span className="ml-auto text-xs text-neutral-400">Drop files here to upload them to this folder</span>
            </div>
            {listing.isPending ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : missing ? (
              <EmptyState>
                This folder does not exist (any more).{' '}
                <button type="button" className="underline" onClick={() => goTo('')}>
                  Go to the site folder
                </button>
              </EmptyState>
            ) : listingError ? (
              <div className="p-4">
                <ErrorNote error={listingError} />
              </div>
            ) : (
              <FileTable
                entries={shown}
                parent={dir === '' ? null : siteFileParent(dir)}
                selected={selected}
                onSelect={setSelected}
                onOpen={openEntry}
                onUp={() => goTo(siteFileParent(dir))}
                menuFor={menuFor}
                emptyText={filter ? 'Nothing here matches the filter.' : 'This folder is empty.'}
              />
            )}
          </div>

          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent-soft)_70%,transparent)]">
              <span className="rounded-lg bg-surface px-4 py-2 text-sm font-medium shadow">
                Drop to upload to <span className="font-mono">{dir === '' ? 'the site folder' : dir}</span>
              </span>
            </div>
          )}
        </>
      )}

      {openView}

      {dialog?.kind === 'new-file' && (
        <NewEntryDialog
          kind="file"
          dir={dir}
          onClose={() => setDialog(null)}
          onCreate={async (path) => {
            await saveFile(slug, path, new Uint8Array(0), { createOnly: true });
            refresh();
            openFile(path);
          }}
        />
      )}
      {dialog?.kind === 'new-folder' && (
        <NewEntryDialog
          kind="folder"
          dir={dir}
          onClose={() => setDialog(null)}
          onCreate={(path) => fileOp(slug, 'mkdir', { path }).then(refresh)}
        />
      )}
      {(dialog?.kind === 'move' || dialog?.kind === 'copy') && (
        <MoveDialog
          mode={dialog.kind}
          entryPath={dialog.path}
          onClose={() => setDialog(null)}
          onSubmit={(to, overwrite) =>
            fileOp(slug, dialog.kind, dialog.kind === 'move' ? { from: dialog.path, to, overwrite } : { from: dialog.path, to }).then(
              () => {
                setSelected(new Set());
                refresh();
              },
            )
          }
        />
      )}
      {dialog?.kind === 'chmod' && (
        <ChmodDialog
          entry={dialog.entry}
          path={dialog.path}
          onClose={() => setDialog(null)}
          onSubmit={(mode) => fileOp(slug, 'chmod', { path: dialog.path, mode }).then(refresh)}
        />
      )}
      {dialog?.kind === 'extract' && (
        <ExtractDialog
          path={dialog.path}
          onClose={() => setDialog(null)}
          onSubmit={(to, overwrite) =>
            archiveJob.mutateAsync({ path: `/api/sites/${slug}/files/extract`, body: { path: dialog.path, to, overwrite } })
          }
        />
      )}
      {dialog?.kind === 'compress' && (
        <CompressDialog
          dir={dir}
          paths={dialog.paths}
          onClose={() => setDialog(null)}
          onSubmit={(to, overwrite) =>
            archiveJob
              .mutateAsync({ path: `/api/sites/${slug}/files/compress`, body: { paths: dialog.paths, to, overwrite } })
              .then(() => setSelected(new Set()))
          }
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={dialog.paths.length === 1 ? `Delete ${siteFileBase(dialog.paths[0]!)}?` : `Delete ${dialog.paths.length} items?`}
          message={
            <>
              {dialog.folders ? 'Folders are deleted with everything in them. ' : ''}This cannot be undone - a backup is
              the only way back.
              <ul className="mt-2 max-h-40 overflow-y-auto font-mono text-xs text-neutral-600">
                {dialog.paths.slice(0, DELETE_LISTED).map((p) => (
                  <li key={p}>
                    <bdi>{p}</bdi>
                  </li>
                ))}
                {dialog.paths.length > DELETE_LISTED && <li>… and {dialog.paths.length - DELETE_LISTED} more</li>}
              </ul>
            </>
          }
          confirmWord={dialog.folders ? 'delete' : undefined}
          confirmLabel="Delete"
          onConfirm={() => run(deletePaths(dialog.paths))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'fix-ownership' && (
        <ConfirmDialog
          title="Fix ownership"
          message={
            <>
              Hands everything in <span className="font-mono">{dir === '' ? 'the site folder' : dir}</span> back to the
              site's own user (www-data). Use it when files a root shell or an old panel left behind cannot be edited here.
              Symlinks are changed themselves, never what they point at.
            </>
          }
          confirmLabel="Fix ownership"
          onConfirm={() => run(fileOp(slug, 'fix-ownership', { path: dir }))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'replace' && (
        <ReplaceDialog
          existing={dialog.existing}
          others={dialog.files.length - dialog.existing.length}
          onClose={() => setDialog(null)}
          onChoose={(replace) => {
            const clash = new Set(dialog.existing);
            const files = replace ? dialog.files : dialog.files.filter((f) => !clash.has(f.name));
            uploads.add(files, dir, (name) => replace && clash.has(name));
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function Breadcrumbs({ slug, dir, onGo }: { slug: string; dir: string; onGo: (path: string) => void }) {
  const parts = dir === '' ? [] : dir.split('/');
  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-sm">
      <button type="button" className="font-semibold text-neutral-800 hover:underline" onClick={() => onGo('')}>
        {slug}
      </button>
      {parts.map((part, i) => {
        const path = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <span key={path} className="flex items-center gap-1">
            <span className="text-neutral-400">/</span>
            {last ? (
              <span className="text-neutral-800">
                <bdi>{part}</bdi>
              </span>
            ) : (
              <button type="button" className="text-neutral-600 hover:underline" onClick={() => onGo(path)}>
                <bdi>{part}</bdi>
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function FolderMenu({ onDownload, onFixOwnership }: { onDownload: () => void; onFixOwnership: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOpen(false)}>
      <button
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 min-w-52 rounded-lg border border-neutral-200 bg-surface py-1 shadow-lg">
          {[
            { label: 'Download this folder (.tar.gz)', onSelect: onDownload },
            { label: 'Fix ownership…', onSelect: onFixOwnership },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReplaceDialog({
  existing,
  others,
  onChoose,
  onClose,
}: {
  existing: string[];
  /** Files in the same drop that clash with nothing. */
  others: number;
  onChoose: (replace: boolean) => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title={existing.length === 1 ? `${existing[0]} already exists` : `${existing.length} files already exist`}
      message={
        <>
          Replace {existing.length === 1 ? 'it' : 'them'} with the upload?
          <ul className="mt-2 max-h-32 overflow-y-auto font-mono text-xs text-neutral-600">
            {existing.map((n) => (
              <li key={n}>
                <bdi>{n}</bdi>
              </li>
            ))}
          </ul>
        </>
      }
      confirmLabel="Replace"
      onConfirm={() => onChoose(true)}
      onClose={onClose}
    >
      {others > 0 && (
        <Button variant="secondary" small onClick={() => onChoose(false)}>
          Upload the other {others === 1 ? 'file' : `${others} files`} only
        </Button>
      )}
    </ConfirmDialog>
  );
}
