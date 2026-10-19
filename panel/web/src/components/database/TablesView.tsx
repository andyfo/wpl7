// @docs sites/database
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DB_FILTER_LABELS,
  DB_FILTER_UNARY,
  DB_LIMITS,
  dbFilterOps,
  type DbFilterOp,
  type DbRowFilter,
  type DbRowKey,
} from '../../../../shared/databases';
import type { DbCell, DbColumnDto, DbRowsPageDto, DbTableStructureDto } from '../../../../shared/types';
import { deleteDbRows, useDbRows, useDbStructure, useDbTables, type RowsQuery } from '../../api/databases';
import { formatBytes } from '../../lib/format';
import { Button, ConfirmDialog, EmptyState, ErrorNote, Spinner, compactInputClass, inputClass } from '../ui';
import { CellView, cellText } from './cells';
import { RowSheet, type RowSheetMode } from './RowSheet';

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
  if (tables.isError && !tables.data) return <ErrorNote error={tables.error} />;
  if (!tables.data) return <Spinner />;
  const shown = tables.data.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const current = tables.data.find((t) => t.name === table) ?? null;
  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <aside className="shrink-0 lg:w-60">
        <input
          className={`${inputClass} mb-2`}
          placeholder={`Filter ${tables.data.length} tables`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
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
            onOpenSql={onOpenSql}
          />
        ) : table ? (
          <EmptyState>There is no table called {table} here.</EmptyState>
        ) : (
          <EmptyState>Pick a table to see its rows.</EmptyState>
        )}
      </div>
    </div>
  );
}

/** One table: its rows a page at a time - filtered, sorted, picked - or its structure. */
function TableView({
  slug,
  db,
  table,
  bytes,
  onOpenSql,
}: {
  slug: string;
  db: string;
  table: string;
  bytes: number | null;
  onOpenSql: (sql: string) => void;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState<RowsQuery>({ offset: 0, limit: 50, sort: null, dir: 'asc', filters: [] });
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
        <StructureView slug={slug} db={db} table={table} />
      ) : (
        <>
          {(page?.columns ?? lastColumns) && (
            <FilterBar
              columns={(page?.columns ?? lastColumns)!}
              filters={q.filters}
              onChange={(filters) => setQ({ ...q, offset: 0, filters })}
            />
          )}
          <ErrorNote error={rows.error} />
          {!page && rows.error ? (
            <div className="flex gap-2">
              <Button small variant="secondary" onClick={() => void rows.refetch()}>
                Try again
              </Button>
              {(q.filters.length > 0 || q.offset > 0 || q.sort) && (
                <Button small variant="secondary" onClick={() => setQ({ ...q, offset: 0, sort: null, filters: [] })}>
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

/** The filters on a table view: the ones in force, and a row to add one. */
function FilterBar({
  columns,
  filters,
  onChange,
}: {
  columns: DbColumnDto[];
  filters: DbRowFilter[];
  onChange: (filters: DbRowFilter[]) => void;
}) {
  // Text is what a filter usually looks for: a name, a slug, a URL - not the row's id.
  const [column, setColumn] = useState((columns.find((c) => c.kind === 'text') ?? columns[0])?.name ?? '');
  const [op, setOp] = useState<DbFilterOp>('contains');
  const [value, setValue] = useState('');
  const unary = DB_FILTER_UNARY.includes(op);
  const add = () => {
    if (!column || filters.length >= DB_LIMITS.filters) return;
    onChange([...filters, unary ? { column, op } : { column, op, value }]);
    setValue('');
  };
  return (
    <div className="space-y-2">
      {filters.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {filters.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs">
              <span className="font-mono">{f.column}</span> {DB_FILTER_LABELS[f.op]}
              {!DB_FILTER_UNARY.includes(f.op) && <span className="font-medium">“{f.value}”</span>}
              <button type="button" aria-label="Remove this filter" className="ml-0.5 text-neutral-400 hover:text-neutral-700" onClick={() => onChange(filters.filter((_, j) => j !== i))}>
                ✕
              </button>
            </span>
          ))}
          {filters.length > 1 && (
            <button type="button" className="text-xs text-neutral-500 underline" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
      )}
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <select className={`${compactInputClass} py-1 text-xs`} value={column} onChange={(e) => setColumn(e.target.value)} aria-label="Column">
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <select className={`${compactInputClass} py-1 text-xs`} value={op} onChange={(e) => setOp(e.target.value as DbFilterOp)} aria-label="Comparison">
          {dbFilterOps.map((o) => (
            <option key={o} value={o}>
              {DB_FILTER_LABELS[o]}
            </option>
          ))}
        </select>
        {!unary && (
          <input
            className={`${compactInputClass} w-48 py-1 text-xs`}
            placeholder="Value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Value"
          />
        )}
        <Button small variant="secondary" type="submit" disabled={filters.length >= DB_LIMITS.filters}>
          Filter
        </Button>
      </form>
    </div>
  );
}

function StructureView({ slug, db, table }: { slug: string; db: string; table: string }) {
  const s = useDbStructure(slug, db, table);
  if (s.isError && !s.data) return <ErrorNote error={s.error} />;
  if (!s.data) return <Spinner />;
  return <Structure s={s.data} />;
}

function Structure({ s }: { s: DbTableStructureDto }) {
  const keyNames = useMemo(() => new Set(s.key ?? []), [s.key]);
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full text-[13px]">
          <thead className="bg-neutral-50 text-left text-neutral-600">
            <tr>
              <th className="px-2 py-1.5 font-medium">Column</th>
              <th className="px-2 py-1.5 font-medium">Type</th>
              <th className="px-2 py-1.5 font-medium">NULL</th>
              <th className="px-2 py-1.5 font-medium">Default</th>
              <th className="px-2 py-1.5 font-medium">Extra</th>
            </tr>
          </thead>
          <tbody>
            {s.columns.map((c) => (
              <tr key={c.name} className="border-t border-neutral-100">
                <td className="px-2 py-1 font-mono">
                  {c.name}
                  {keyNames.has(c.name) && <span className="ml-1.5 text-[11px] text-neutral-400">key</span>}
                </td>
                <td className="px-2 py-1 font-mono text-neutral-600">{c.type}</td>
                <td className="px-2 py-1">{c.nullable ? 'yes' : 'no'}</td>
                <td className="px-2 py-1 font-mono text-neutral-600">{c.default ?? ''}</td>
                <td className="px-2 py-1 text-neutral-600">{c.extra}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.indexes.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Indexes</h3>
          <ul className="space-y-0.5 text-[13px]">
            {s.indexes.map((i) => (
              <li key={i.name}>
                <span className="font-mono">{i.name}</span>
                <span className="text-neutral-500">
                  {' '}
                  ({i.columns.join(', ')}){i.unique ? ' · unique' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!s.key && s.type === 'table' && (
        <p className="text-xs text-neutral-500">No primary key: rows are read only here. Change them with SQL.</p>
      )}
    </div>
  );
}
