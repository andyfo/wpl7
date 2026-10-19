// @docs sites/database
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { MariaSQL, sql } from '@codemirror/lang-sql';
import { DB_LIMITS } from '../../../../shared/databases';
import type { DbQueryDto, DbQueryResultDto } from '../../../../shared/types';
import { runDbSql } from '../../api/databases';
import { Button, ErrorNote, compactInputClass } from '../ui';
import { themeExtensions } from '../files/codemirror';
import { CellView } from './cells';

const HISTORY_KEPT = 25;
/** Longer queries are not kept: browser storage is small, and shared with the rest of the panel. */
const HISTORY_QUERY_CHARS = 10_000;
const historyKey = (slug: string) => `wpl7.sql.${slug}`;
/** The key that runs a query, as this computer's keyboard calls it (CodeMirror's Mod). */
const RUN_KEYS = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘+Enter' : 'Ctrl+Enter';

function readHistory(slug: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(historyKey(slug)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * SQL, run as the site's own database user: statement after statement, stopping at the first
 * error. Its recent queries are kept in this browser, per site.
 */
export default function SqlView({
  slug,
  db,
  user,
  tables,
  initial,
}: {
  slug: string;
  db: string;
  user: string;
  tables: string[];
  initial: string | null;
}) {
  const [history, setHistory] = useState(() => readHistory(slug));
  const [text, setText] = useState(() => initial ?? history[0] ?? 'SELECT * FROM `wp_options` LIMIT 50;');
  const [result, setResult] = useState<DbQueryDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const latest = useRef(text);
  latest.current = text;
  const qc = useQueryClient();

  const run = async () => {
    const sqlText = latest.current.trim();
    if (!sqlText || running) return;
    setRunning(true);
    setError(null);
    let outcome: DbQueryDto;
    try {
      outcome = await runDbSql(slug, db, sqlText);
    } catch (err) {
      setError(err);
      setRunning(false);
      return;
    }
    setResult(outcome);
    setRunning(false);
    // A statement that changed something: the tables, rows and structure shown elsewhere are old.
    if (outcome.results.some((r) => r.kind === 'ok')) {
      for (const key of ['db-tables', 'db-rows', 'db-structure']) void qc.invalidateQueries({ queryKey: [key, slug, db] });
    }
    if (sqlText.length <= HISTORY_QUERY_CHARS) {
      const next = [sqlText, ...history.filter((h) => h !== sqlText)].slice(0, HISTORY_KEPT);
      setHistory(next);
      try {
        localStorage.setItem(historyKey(slug), JSON.stringify(next));
      } catch {
        // Storage full or off: the list lasts as long as the page.
      }
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  return (
    <div className="space-y-3">
      <SqlEditor value={text} onChange={setText} onRun={() => void runRef.current()} tables={tables} />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void run()} busy={running}>
          Run
        </Button>
        <span className="text-xs text-neutral-500">
          {RUN_KEYS} · as {user} · stops at the first error
        </span>
        {history.length > 0 && (
          <select
            className={`${compactInputClass} ml-auto max-w-xs py-1 text-xs`}
            value=""
            aria-label="Recent queries"
            onChange={(e) => {
              if (e.target.value) setText(e.target.value);
            }}
          >
            <option value="">Recent queries</option>
            {history.map((h) => (
              <option key={h} value={h}>
                {h.replace(/\s+/g, ' ').slice(0, 80)}
              </option>
            ))}
          </select>
        )}
      </div>
      <ErrorNote error={error} />
      {result && (
        <div className="space-y-3">
          {result.results.map((r, i) => (
            <ResultBlock key={i} index={i} count={result.results.length} result={r} />
          ))}
          <p className="text-xs text-neutral-400">{result.ms} ms in all</p>
        </div>
      )}
    </div>
  );
}

function ResultBlock({ index, count, result: r }: { index: number; count: number; result: DbQueryResultDto }) {
  const which = count > 1 ? `Statement ${index + 1}: ` : '';
  if (r.kind === 'error') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
        {which}
        {r.message}
      </div>
    );
  }
  if (r.kind === 'ok') {
    return (
      <div className="rounded-lg border border-neutral-200 px-3 py-2 text-sm">
        {which}
        {r.affected.toLocaleString()} {r.affected === 1 ? 'row' : 'rows'} affected
        {r.insertId && ` · new id ${r.insertId}`}
        {r.warnings > 0 && ` · ${r.warnings} warnings`}
        <span className="ml-2 text-xs text-neutral-400">{r.ms} ms</span>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-1 text-xs text-neutral-500">
        {which}
        {r.rows.length.toLocaleString()} {r.rows.length === 1 ? 'row' : 'rows'}
        {r.truncated && ` - the first ${DB_LIMITS.resultRows.toLocaleString()} only; add LIMIT or WHERE to see others`}
        <span className="ml-2 text-neutral-400">{r.ms} ms</span>
      </div>
      {r.columns.length > 0 && (
        <div className="max-h-[28rem] overflow-auto rounded-lg border border-neutral-200">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-neutral-50">
              <tr>
                {r.columns.map((c, i) => (
                  <th key={i} className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-neutral-600" title={c.type}>
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.rows.map((row, i) => (
                <tr key={i} className="border-t border-neutral-100">
                  {row.map((cell, ci) => (
                    <td key={ci} className={`max-w-[22rem] truncate px-2 py-1 ${r.columns[ci]?.kind === 'number' ? 'text-right' : ''}`}>
                      <CellView cell={cell} kind={r.columns[ci]?.kind ?? 'other'} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** CodeMirror with MariaDB's SQL, the database's table names to complete, and Ctrl/Cmd+Enter to run. */
function SqlEditor({
  value,
  onChange,
  onRun,
  tables,
}: {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  tables: string[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onRun });
  handlers.current = { onChange, onRun };

  useEffect(() => {
    const theme = themeExtensions();
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                handlers.current.onRun();
                return true;
              },
            },
          ]),
          basicSetup,
          sql({ dialect: MariaSQL, upperCaseKeywords: true, schema: Object.fromEntries(tables.map((t) => [t, []])) }),
          theme.extensions,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    const stop = theme.watch(editor);
    return () => {
      stop();
      editor.destroy();
      view.current = null;
    };
    // Built once per table list: the text is pushed in below, not by rebuilding the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join('\u0000')]);

  // A query picked from the recent ones, or opened from a table, replaces the text.
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className="h-56 overflow-hidden rounded-lg border border-neutral-200" />;
}
