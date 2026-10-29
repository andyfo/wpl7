// @docs sites/database
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DB_ANY_COLUMN,
  DB_ANY_COLUMN_OPS,
  DB_FILTER_LABELS,
  DB_FILTER_LIST,
  DB_FILTER_UNARY,
  DB_LIMITS,
  dbFilterOps,
  type DbFilterOp,
  type DbRowFilter,
  type DbRowKey,
} from '../../../../shared/databases';
import type { DbCell, DbColumnDto, DbRowsPageDto } from '../../../../shared/types';
import { deleteDbRows, useDbRows, useDbTables, type RowsQuery } from '../../api/databases';
import { formatBytes } from '../../lib/format';
import { Button, ConfirmDialog, EmptyState, ErrorNote, Spinner, compactInputClass, inputClass } from '../ui';
import { CellView, cellText } from './cells';
import { RowSheet, type RowSheetMode } from './RowSheet';
import { NewTableDialog, StructureEditor } from './StructureEditor';

const PAGE_SIZES = [25, 50, 100, 250, 500] as const;

/** The tables of one database on the left, and the one picked on the right. */
export function TablesView({
  slug,
  db,
  table,
  onTable,
  onOpenSql,
}: {
  slug: string;
  db: string;
  table: string | null;
  onTable: (table: string | null) => void;
  onOpenSql: (sql: string) => void;
}) {
  const tables = useDbTables(slug, db);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  if (tables.isError && !tables.data) return <ErrorNote error={tables.error} />;
  if (!tables.data) return <Spinner />;
  const shown = tables.data.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const current = tables.data.find((t) => t.name === table) ?? null;
  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <aside className="shrink-0 lg:w-60">
        <div className="mb-2 flex gap-1.5">
          <input
            className={`${inputClass} min-w-0 flex-1`}
            placeholder={`Filter ${tables.data.length} tables`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Button small variant="secondary" onClick={() => setCreating(true)} title="New table">
            New
          </Button>
        </div>
        {tables.data.length === 0 ? (
          <EmptyState>No tables.</EmptyState>
        ) : (
          <ul className="max-h-[36rem] space-y-0.5 overflow-y-auto pr-1 text-sm">
            {shown.map((t) => (
              <li key={t.name}>
                <button
                  type="button"
                  onClick={() => onTable(t.name)}
                  className={`flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left ${
                    t.name === table ? 'bg-neutral-100 font-medium text-neutral-900' : 'text-neutral-700 hover:bg-neutral-50'
                  }`}
                >
                  <span className="truncate font-mono text-[13px]">{t.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">
                    {t.type === 'view' ? 'view' : (t.rows ?? 0).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <div className="min-w-0 flex-1">
        {current ? (
          <TableView
            key={`${db}/${current.name}`}
            slug={slug}
            db={db}
            table={current.name}
            bytes={current.bytes}
            tables={tables.data.map((t) => t.name)}
            onTable={onTable}
            onOpenSql={onOpenSql}
          />
        ) : table ? (
          <EmptyState>There is no table called {table} here.</EmptyState>
        ) : (
          <EmptyState>Pick a table to see its rows.</EmptyState>
        )}
      </div>
      {creating && (
        <NewTableDialog
          slug={slug}
          db={db}
          tables={tables.data.map((t) => t.name)}
          onCreated={(name) => {
            setCreating(false);
            onTable(name);
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

/** One table: its rows a page at a time - filtered, sorted, picked - or its structure. */
function TableView({
  slug,
  db,
  table,
  bytes,
  tables,
  onTable,
  onOpenSql,
}: {
  slug: string;
  db: string;
  table: string;
  bytes: number | null;
  tables: string[];
  onTable: (table: string | null) => void;
  onOpenSql: (sql: string) => void;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState<RowsQuery>({ offset: 0, limit: 50, sort: null, dir: 'asc', filters: [], match: 'all' });
  const [structure, setStructure] = useState(false);
  const [sheet, setSheet] = useState<RowSheetMode | null>(null);
  const [picked, setPicked] = useState<Map<string, DbRowKey>>(new Map());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const rows = useDbRows(slug, db, table, q);
  const page = rows.data;
  // The columns from the last page that loaded: the filters stay usable when a page fails, so the
  // filter that made it fail can be taken off.
  const [lastColumns, setLastColumns] = useState<DbColumnDto[] | null>(null);
  useEffect(() => {
    if (page) setLastColumns(page.columns);
  }, [page]);
  // Picks are of rows on this page: another page, order or filter starts with none.
  const queryId = JSON.stringify(q);
  useEffect(() => setPicked(new Map()), [queryId]);
  // Every row of the last page deleted: back to the page before, rather than "empty".
  useEffect(() => {
    if (page && !rows.isPlaceholderData && page.rows.length === 0 && q.offset > 0) {
      setQ((prev) => ({ ...prev, offset: Math.max(0, prev.offset - prev.limit) }));
    }
  }, [page, rows.isPlaceholderData, q.offset]);
  const refetch = () => {
    setPicked(new Map());
    void qc.invalidateQueries({ queryKey: ['db-rows', slug, db, table] });
    void qc.invalidateQueries({ queryKey: ['db-tables', slug, db] });
  };
  const keyOf = (pageData: DbRowsPageDto, row: DbCell[]): DbRowKey | null => {
    if (!pageData.key) return null;
    const out: DbRowKey = {};
    for (const k of pageData.key) {
      const at = pageData.columns.findIndex((c) => c.name === k);
      const cell = row[at];
      // A key value that came cut or as bytes cannot find its row again.
      if (cell === undefined || (cell !== null && typeof cell !== 'string')) return null;
      out[k] = cell;
    }
    return out;
  };
  const keyId = (key: DbRowKey) => JSON.stringify(key);
  const openRow = (row: DbCell[], key: DbRowKey | null) => {
    if (!page) return;
    setSheet(key ? { kind: 'edit', key } : { kind: 'view', columns: page.columns, values: row, keyCut: !!page.key });
  };
  const setSort = (column: string) =>
    setQ((prev) => ({
      ...prev,
      offset: 0,
      sort: column,
      dir: prev.sort === column && prev.dir === 'asc' ? 'desc' : 'asc',
    }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono font-medium">{table}</span>
          <span className="ml-2 text-xs text-neutral-500">
            {page?.estimate != null && `about ${page.estimate.toLocaleString()} rows`}
            {bytes != null && ` · ${formatBytes(bytes)}`}
          </span>
        </div>
        <div className="flex gap-2">
          <Button small variant="secondary" onClick={() => setStructure((s) => !s)}>
            {structure ? 'Rows' : 'Structure'}
          </Button>
          {!structure && (
            <Button
              small
              onClick={() => setSheet({ kind: 'new' })}
              disabled={!page?.key}
              title={page && !page.key ? 'This table has no primary key: insert rows with SQL' : undefined}
            >
              Insert row
            </Button>
          )}
        </div>
      </div>

      {structure ? (
        <StructureEditor slug={slug} db={db} table={table} tables={tables} onTable={onTable} />
      ) : (
        <>
          {(page?.columns ?? lastColumns) && (
            <FilterBar
              columns={(page?.columns ?? lastColumns)!}
              filters={q.filters}
              match={q.match}
              onChange={(filters, match) => setQ({ ...q, offset: 0, filters, match })}
            />
          )}
          <ErrorNote error={rows.error} />
          {!page && rows.error ? (
            <div className="flex gap-2">
              <Button small variant="secondary" onClick={() => void rows.refetch()}>
                Try again
              </Button>
              {(q.filters.length > 0 || q.offset > 0 || q.sort) && (
                <Button small variant="secondary" onClick={() => setQ({ ...q, offset: 0, sort: null, filters: [], match: 'all' })}>
                  Show the first rows
                </Button>
              )}
            </div>
          ) : !page ? (
            <Spinner />
          ) : page.rows.length === 0 ? (
            <EmptyState>{q.filters.length > 0 ? 'No row matches.' : 'The table is empty.'}</EmptyState>
          ) : (
            <div className={`overflow-x-auto rounded-lg border border-neutral-200 ${rows.isFetching ? 'opacity-70' : ''}`}>
              <table className="w-full text-[13px]">
                <thead className="bg-neutral-50">
                  <tr>
                    {page.key && (
                      <th className="w-8 px-2 py-1.5">
                        <input
                          type="checkbox"
                          aria-label="Pick every row on this page"
                          checked={picked.size > 0 && page.rows.every((r) => { const k = keyOf(page, r); return !!k && picked.has(keyId(k)); })}
                          onChange={(e) => {
                            const next = new Map<string, DbRowKey>();
                            if (e.target.checked) {
                              for (const r of page.rows) {
                                const k = keyOf(page, r);
                                if (k) next.set(keyId(k), k);
                              }
                            }
                            setPicked(next);
                          }}
                        />
                      </th>
                    )}
                    {page.columns.map((c) => (
                      <th key={c.name} className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-neutral-600">
                        <button type="button" onClick={() => setSort(c.name)} title={`${c.type}${c.key === 'PRI' ? ' · key' : ''}`} className="hover:underline">
                          {c.name}
                          {q.sort === c.name && <span className="ml-1 text-neutral-400">{q.dir === 'asc' ? '▲' : '▼'}</span>}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, i) => {
                    const key = keyOf(page, row);
                    return (
                      <tr
                        key={key ? keyId(key) : i}
                        className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 focus:bg-neutral-50 focus:outline-none"
                        tabIndex={0}
                        onClick={() => openRow(row, key)}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                          e.preventDefault();
                          openRow(row, key);
                        }}
                      >
                        {page.key && (
                          <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                            {key && (
                              <input
                                type="checkbox"
                                aria-label="Pick this row"
                                checked={picked.has(keyId(key))}
                                onChange={(e) => {
                                  const next = new Map(picked);
                                  if (e.target.checked) next.set(keyId(key), key);
                                  else next.delete(keyId(key));
                                  setPicked(next);
                                }}
                              />
                            )}
                          </td>
                        )}
                        {page.columns.map((c, ci) => (
                          <td
                            key={c.name}
                            className={`max-w-[22rem] truncate px-2 py-1 ${c.kind === 'number' ? 'text-right' : ''}`}
                            title={cellText(row[ci] ?? null)?.slice(0, 500) ?? undefined}
                          >
                            <CellView cell={row[ci] ?? null} kind={c.kind} />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {page && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
              <div className="flex items-center gap-2">
                {page.rows.length > 0 && (
                  <span className="tabular-nums">
                    Rows {(q.offset + 1).toLocaleString()}–{(q.offset + page.rows.length).toLocaleString()}
                  </span>
                )}
                <Button small variant="secondary" disabled={q.offset === 0} onClick={() => setQ({ ...q, offset: Math.max(0, q.offset - q.limit) })}>
                  Previous
                </Button>
                <Button small variant="secondary" disabled={!page.hasMore} onClick={() => setQ({ ...q, offset: q.offset + q.limit })}>
                  Next
                </Button>
                <select
                  className={`${compactInputClass} py-0.5 text-xs`}
                  value={q.limit}
                  aria-label="Rows per page"
                  onChange={(e) => setQ({ ...q, offset: 0, limit: Number(e.target.value) })}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n} per page
                    </option>
                  ))}
                </select>
                {picked.size > 0 && (
                  <Button small variant="danger" onClick={() => setConfirmDelete(true)}>
                    Delete {picked.size} {picked.size === 1 ? 'row' : 'rows'}
                  </Button>
                )}
              </div>
              <button type="button" className="truncate font-mono hover:underline" title="Open in SQL" onClick={() => onOpenSql(page.sql)}>
                {page.sql}
              </button>
            </div>
          )}
          <ErrorNote error={deleteError} />
        </>
      )}

      {sheet && (
        <RowSheet
          slug={slug}
          db={db}
          table={table}
          mode={sheet}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            refetch();
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${picked.size} ${picked.size === 1 ? 'row' : 'rows'}`}
          message={`From ${table}. It cannot be undone, except from a backup.`}
          confirmLabel="Delete"
          onConfirm={() => {
            setDeleteError(null);
            // Picks are of one page, and a page is never more rows than one delete takes.
            deleteDbRows(slug, db, table, [...picked.values()]).then(refetch, setDeleteError);
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

/** One condition as it is being written: the value is kept even for a comparison that takes none. */
interface DraftFilter {
  column: string;
  op: DbFilterOp;
  value: string;
}

const toDraft = (f: DbRowFilter): DraftFilter => ({ column: f.column, op: f.op, value: f.value ?? '' });
/** The comparisons that look for a part of the text, or for one of a list. */
const SEARCHES: readonly DbFilterOp[] = ['contains', 'notContains', 'startsWith', 'endsWith', ...DB_FILTER_LIST];
const fromDraft = (f: DraftFilter): DbRowFilter =>
  DB_FILTER_UNARY.includes(f.op) ? { column: f.column, op: f.op } : { column: f.column, op: f.op, value: f.value };

/**
 * The filters on a table view: rows of column, comparison and value, kept as a draft until Search.
 * "Any column" looks in every column but the binary ones.
 */
function FilterBar({
  columns,
  filters,
  match,
  onChange,
}: {
  columns: DbColumnDto[];
  filters: DbRowFilter[];
  match: 'all' | 'any';
  onChange: (filters: DbRowFilter[], match: 'all' | 'any') => void;
}) {
  // Text is what a filter usually looks for: a name, a slug, a URL - not the row's id.
  const firstText = (columns.find((c) => c.kind === 'text') ?? columns[0])?.name ?? DB_ANY_COLUMN;
  const blank = (): DraftFilter => ({ column: firstText, op: 'contains', value: '' });
  const [rows, setRows] = useState<DraftFilter[]>(() => (filters.length > 0 ? filters.map(toDraft) : [blank()]));
  const [how, setHow] = useState(match);
  // What is in force changed from outside (a table switched, "Show the first rows"): follow it.
  const applied = JSON.stringify([filters, match]);
  useEffect(() => {
    setRows(filters.length > 0 ? filters.map(toDraft) : [blank()]);
    setHow(match);
  }, [applied]);

  // A search or a list with no value filters nothing: such a row is left out. "= (nothing)" is
  // kept: it looks for empty text.
  const ready = rows.filter((r) => r.value !== '' || !SEARCHES.includes(r.op)).map(fromDraft);
  const dirty = JSON.stringify([ready, ready.length > 1 ? how : 'all']) !== JSON.stringify([filters, filters.length > 1 ? match : 'all']);
  const set = (i: number, patch: Partial<DraftFilter>) =>
    setRows((all) =>
      all.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        // "Any column" takes only the comparisons that read as a search.
        if (next.column === DB_ANY_COLUMN && !DB_ANY_COLUMN_OPS.includes(next.op)) next.op = 'contains';
        return next;
      }),
    );

  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onChange(ready, ready.length > 1 ? how : 'all');
      }}
    >
      {rows.map((r, i) => {
        const ops = r.column === DB_ANY_COLUMN ? DB_ANY_COLUMN_OPS : dbFilterOps;
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            {i > 0 ? (
              <span className="w-10 text-right text-xs text-neutral-500">{how === 'any' ? 'or' : 'and'}</span>
            ) : (
              rows.length > 1 && <span className="w-10" />
            )}
            <select
              className={`${compactInputClass} py-1 text-xs`}
              value={r.column}
              onChange={(e) => set(i, { column: e.target.value })}
              aria-label="Column"
            >
              <option value={DB_ANY_COLUMN}>Any column</option>
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className={`${compactInputClass} py-1 text-xs`}
              value={r.op}
              onChange={(e) => set(i, { op: e.target.value as DbFilterOp })}
              aria-label="Comparison"
            >
              {ops.map((o) => (
                <option key={o} value={o}>
                  {DB_FILTER_LABELS[o]}
                </option>
              ))}
            </select>
            {!DB_FILTER_UNARY.includes(r.op) && (
              <input
                className={`${compactInputClass} w-48 py-1 text-xs`}
                placeholder={DB_FILTER_LIST.includes(r.op) ? 'a, b, c' : 'Value'}
                value={r.value}
                onChange={(e) => set(i, { value: e.target.value })}
                aria-label="Value"
              />
            )}
            {rows.length > 1 && (
              <button
                type="button"
                aria-label="Remove this condition"
                className="px-1 text-neutral-400 hover:text-neutral-700"
                onClick={() => setRows((all) => all.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button small variant={dirty ? 'primary' : 'secondary'} type="submit">
          Search
        </Button>
        {rows.length < DB_LIMITS.filters && (
          <button type="button" className="text-neutral-600 underline" onClick={() => setRows((all) => [...all, blank()])}>
            Add condition
          </button>
        )}
        {rows.length > 1 && (
          <select
            className={`${compactInputClass} py-0.5 text-xs`}
            value={how}
            onChange={(e) => setHow(e.target.value as 'all' | 'any')}
            aria-label="Rows must match"
          >
            <option value="all">Match all</option>
            <option value="any">Match any</option>
          </select>
        )}
        {filters.length > 0 && (
          <button type="button" className="text-neutral-500 underline" onClick={() => onChange([], 'all')}>
            Clear
          </button>
        )}
      </div>
    </form>
  );
}

