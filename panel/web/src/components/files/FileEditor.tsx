// @docs sites/files
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, type Text } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import type { SiteFileEntryDto } from '../../../../shared/types';
import { FILE_LIMITS } from '../../../../shared/siteFilePath';
import { ApiError, holdOffLoginRedirect } from '../../api/client';
import { downloadUrl, readFile, saveFile } from '../../api/files';
import { decodeFile, encodeFile, type LineEndings } from '../../lib/fileText';
import { isPhp, languageFor } from '../../lib/fileKinds';
import { formatBytes } from '../../lib/format';
import { Button, ConfirmDialog, ErrorNote, Spinner } from '../ui';
import { languageExtension, themeExtensions } from './codemirror';
import { ownerName } from './common';

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; error: unknown }
  | { status: 'binary'; size: number }
  | { status: 'not-utf8'; preview: string }
  | { status: 'text'; text: string; bom: boolean; eol: LineEndings; etag: string; size: number };

type Problem =
  | { kind: 'conflict' }
  | { kind: 'syntax'; message: string; line: number | null }
  | { kind: 'session' }
  | { kind: 'error'; error: unknown };

/**
 * The file editor: CodeMirror over the whole page. Lazy-loaded (see FilesTab) - the editor
 * and its languages are the heaviest thing in the panel, and most visits never open a file.
 *
 * A save is conditional on the version that was opened: if the file changed on the server
 * meanwhile (a plugin update, a colleague), the save is refused and the operator chooses.
 * PHP is checked before it replaces anything, so a typo in functions.php is an error message
 * here rather than a white screen on the site.
 */
export default function FileEditor({
  slug,
  path,
  entry,
  line,
  onClose,
  onSaved,
}: {
  slug: string;
  path: string;
  /** The listing's entry, when the editor was opened from one (for ownership and size). */
  entry: SiteFileEntryDto | null;
  /** Put the cursor here once loaded (from a content search). */
  line?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [wrap, setWrap] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedDoc = useRef<Text | null>(null);
  const etagRef = useRef('');
  const wrapCompartment = useRef(new Compartment());
  const readOnly = entry ? !entry.writable : false;

  useEffect(() => {
    let alive = true;
    setLoaded({ status: 'loading' });
    setProblem(null);
    readFile(slug, path)
      .then(({ bytes, etag }) => {
        if (!alive) return;
        const decoded = decodeFile(bytes);
        if (decoded.kind === 'binary') return setLoaded({ status: 'binary', size: bytes.length });
        if (decoded.kind === 'not-utf8') return setLoaded({ status: 'not-utf8', preview: decoded.preview });
        etagRef.current = etag;
        setLoaded({ status: 'text', ...decoded, etag, size: bytes.length });
      })
      .catch((error: unknown) => alive && setLoaded({ status: 'failed', error }));
    return () => {
      alive = false;
    };
  }, [slug, path, reloadKey]);

  // A ref, not the `saving` state: two Cmd-S presses in one tick would both see the old state
  // and send two saves with the same If-Match - and the second would come back a conflict.
  const savingRef = useRef(false);
  const save = useCallback(
    async (opts: { overwrite?: boolean; skipLint?: boolean } = {}) => {
      const view = viewRef.current;
      if (!view || savingRef.current || readOnly || loaded.status !== 'text') return;
      savingRef.current = true;
      const doc = view.state.doc;
      // A file that mixed its line endings is saved with \n throughout (the header says so).
      const bytes = encodeFile(doc.toString(), { bom: loaded.bom, eol: loaded.eol === 'crlf' ? 'crlf' : 'lf' });
      setSaving(true);
      setProblem(null);
      try {
        const written = await saveFile(slug, path, bytes, {
          etag: opts.overwrite ? undefined : etagRef.current,
          lint: isPhp(path) && !opts.skipLint,
        });
        if (written.etag) etagRef.current = written.etag;
        savedDoc.current = doc;
        setDirty(!view.state.doc.eq(doc));
        setSavedAt(Date.now());
        onSaved();
        view.focus();
      } catch (err) {
        if (err instanceof ApiError && err.status === 412) setProblem({ kind: 'conflict' });
        else if (err instanceof ApiError && err.status === 422) {
          const at = (err.details as { line?: number | null } | undefined)?.line ?? null;
          setProblem({ kind: 'syntax', message: err.message, line: at });
        } else if (err instanceof ApiError && err.status === 401) setProblem({ kind: 'session' });
        else setProblem({ kind: 'error', error: err });
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [slug, path, readOnly, loaded, onSaved],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  const gotoLine = (n: number) => {
    const view = viewRef.current;
    if (!view) return;
    const target = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
    view.dispatch({
      selection: { anchor: target.from, head: target.to },
      effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
    });
    view.focus();
  };

  useEffect(() => {
    if (loaded.status !== 'text' || !hostRef.current) return;
    const language = new Compartment();
    const theme = themeExtensions();
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: loaded.text,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          theme.extensions,
          language.of([]),
          wrapCompartment.current.of([]),
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && savedDoc.current) setDirty(!u.state.doc.eq(savedDoc.current));
            if (u.docChanged || u.selectionSet) {
              const head = u.state.selection.main.head;
              const at = u.state.doc.lineAt(head);
              setCursor({ line: at.number, col: head - at.from + 1 });
            }
          }),
        ],
      }),
    });
    savedDoc.current = view.state.doc;
    viewRef.current = view;
    setDirty(false);
    const unwatch = theme.watch(view);
    let alive = true;
    void languageExtension(languageFor(path)).then((ext) => {
      if (alive) view.dispatch({ effects: language.reconfigure(ext) });
    });
    if (line) gotoLine(line);
    else view.focus();
    return () => {
      alive = false;
      unwatch();
      view.destroy();
      viewRef.current = null;
    };
    // `line` only matters when the file (re)loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, path, readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap, loaded]);

  // Unsaved changes survive nothing by accident: not a click elsewhere in the panel, not the
  // back button, not closing the tab - and not a background poll finding the session expired,
  // which would otherwise send the page to /login (see holdOffLoginRedirect).
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    const release = holdOffLoginRedirect();
    return () => {
      window.removeEventListener('beforeunload', warn);
      release();
    };
  }, [dirty]);

  // Cmd/Ctrl-S saves wherever the focus is while the editor is open - after a click on a
  // button it is no longer in the editor, and the browser's own "Save page" is never wanted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ConfirmDialog calls onConfirm and then onClose; only a dialog that was NOT confirmed
  // may reset the blocker (resetting one that is already proceeding is an error).
  const discarding = useRef(false);

  const lang = languageFor(path);
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface" role="dialog" aria-label={`Editing ${path}`}>
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium" title={path}>
            <bdi>{path}</bdi>
            {dirty && <span className="ml-2 text-amber-600" title="Unsaved changes">●</span>}
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-neutral-500">
            {loaded.status === 'text' && (
              <>
                <span>{lang === 'plain' ? 'Plain text' : lang.toUpperCase()}</span>
                {loaded.eol === 'crlf' && <span>CRLF line endings (kept)</span>}
                {loaded.eol === 'mixed' && (
                  <span className="text-amber-700">Mixed line endings: saving converts them to \n</span>
                )}
                {loaded.bom && <span>UTF-8 with BOM (kept)</span>}
              </>
            )}
            {readOnly && entry && (
              <span className="text-amber-700">
                Read-only: owned by {ownerName(entry.uid)}, which the site cannot write. "Fix ownership" in the Files
                menu hands it back.
              </span>
            )}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        <a className="text-sm text-neutral-600 hover:underline" href={downloadUrl(slug, path)}>
          Download
        </a>
        <Button
          small
          onClick={() => void save()}
          disabled={!dirty || saving || readOnly || loaded.status !== 'text'}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button small variant="secondary" onClick={onClose}>
          Close
        </Button>
      </header>

      {problem && (
        <div className="border-b border-neutral-200 px-4 py-2 text-sm">
          {problem.kind === 'conflict' && (
            <div className="flex flex-wrap items-center gap-2 text-amber-800">
              <span>This file changed on the server since you opened it.</span>
              <Button small variant="danger" onClick={() => void save({ overwrite: true })}>
                Overwrite with mine
              </Button>
              <Button small variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
                Load theirs (discard mine)
              </Button>
            </div>
          )}
          {problem.kind === 'syntax' && (
            <div className="flex flex-wrap items-center gap-2 text-red-700">
              <span>{problem.message}</span>
              {problem.line !== null && (
                <Button small variant="secondary" onClick={() => gotoLine(problem.line!)}>
                  Go to line {problem.line}
                </Button>
              )}
              <Button small variant="danger" onClick={() => void save({ skipLint: true })}>
                Save anyway
              </Button>
            </div>
          )}
          {problem.kind === 'session' && (
            <p className="text-amber-800">
              Your session expired, so nothing was saved. Sign in again in another tab, then save here - your changes are
              still in the editor.
            </p>
          )}
          {problem.kind === 'error' && <ErrorNote error={problem.error} />}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {loaded.status === 'loading' && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {loaded.status === 'failed' && (
          <div className="p-6">
            <ErrorNote error={loaded.error} />
          </div>
        )}
        {loaded.status === 'binary' && (
          <div className="p-6 text-sm text-neutral-600">
            This is a binary file ({formatBytes(loaded.size)}), so it cannot be edited here.{' '}
            <a className="underline" href={downloadUrl(slug, path)}>
              Download it
            </a>
            .
          </div>
        )}
        {loaded.status === 'not-utf8' && (
          <div className="flex h-full flex-col">
            <p className="px-4 py-2 text-sm text-amber-800">
              This file is not UTF-8 text, so saving from here would change every non-ASCII character. It is shown read-only
              (the first part, as Windows-1252).
            </p>
            <pre className="min-h-0 flex-1 overflow-auto px-4 font-mono text-xs">{loaded.preview}</pre>
          </div>
        )}
        <div ref={hostRef} className={loaded.status === 'text' ? 'h-full' : 'hidden'} />
      </div>

      <footer className="flex items-center gap-4 border-t border-neutral-200 px-4 py-1.5 text-xs text-neutral-500">
        {loaded.status === 'text' && (
          <>
            <span>
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span>{formatBytes(loaded.size)}</span>
            {isPhp(path) && <span>PHP is checked before it is saved</span>}
          </>
        )}
        <span className="ml-auto">
          {dirty ? 'Unsaved changes' : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()}` : ''}
          {loaded.status === 'text' && loaded.size > FILE_LIMITS.editBytes / 2 && ' · large file'}
        </span>
      </footer>

      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message={
            <>
              <span className="font-mono">{path}</span> has changes that are not saved yet.
            </>
          }
          confirmLabel="Discard"
          onConfirm={() => {
            discarding.current = true;
            blocker.proceed();
          }}
          onClose={() => {
            if (!discarding.current) blocker.reset();
            discarding.current = false;
          }}
        />
      )}
    </div>
  );
}
