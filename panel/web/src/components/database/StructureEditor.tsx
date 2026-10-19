// @docs sites/database-structure
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DB_COLUMN_TYPE_RE,
  dbForeignKeyActions,
  type DbAlterChange,
  type DbColumnDef,
  type DbIndexKind,
} from '../../../../shared/databases';
import type { DbColumnDto, DbTableStructureDto } from '../../../../shared/types';
import { previewStructure, structurePaths, useDbStructure } from '../../api/databases';
import { useRunJob } from '../../api/hooks';
import { Button, ConfirmDialog, ErrorNote, Field, Modal, Spinner, compactInputClass, inputClass } from '../ui';

/** What the type field suggests; any type MariaDB writes the same way is taken. */
const COMMON_TYPES = [
  'bigint unsigned',
  'int',
  'int unsigned',
  'tinyint(1)',
  'smallint',
  'decimal(10,2)',
  'double',
  'varchar(191)',
  'varchar(255)',
  'char(36)',
  'text',
  'mediumtext',
  'longtext',
  'json',
  "enum('a','b')",
  'date',
  'datetime',
  'timestamp',
  'time',
  'year',
  'blob',
  'longblob',
  'varbinary(255)',
  'uuid',
];

const WHOLE_NUMBER_RE = /^(?:tinyint|smallint|mediumint|int|integer|bigint)\b/i;
const DATE_TIME_RE = /^(?:datetime|timestamp)(?:\(\d\))?$/i;

const INDEX_KIND_LABELS: Record<DbIndexKind, string> = {
  index: 'Index',
  unique: 'Unique index',
  fulltext: 'Full-text index',
  primary: 'Primary key',
};

type Dialog =
  | { kind: 'column'; column: DbColumnDto | null }
  | { kind: 'index' }
  | { kind: 'foreignKey' }
  | { kind: 'rename' }
  | { kind: 'drop'; what: 'column' | 'index' | 'foreignKey'; name: string }
  | { kind: 'table'; what: 'truncate' | 'drop' };

/**
 * A table's columns, indexes and foreign keys, and the forms that change them. Each change is one
 * ALTER TABLE, shown before it runs, and run as a job: an ALTER on a big table takes a while.
 */
export function StructureEditor({
  slug,
  db,
  table,
  tables,
  onTable,
}: {
  slug: string;
  db: string;
  table: string;
  /** The database's tables, for a foreign key to point at. */
  tables: string[];
  /** A rename or drop finished: the table to show now. */
  onTable: (table: string | null) => void;
}) {
  const s = useDbStructure(slug, db, table);
  const run = useRunJob([['db-structure', slug, db], ['db-tables', slug, db], ['db-rows', slug, db], ['site-databases', slug]]);
  const [dialog, setDialogState] = useState<Dialog | null>(null);
  /** Why the open dialog's change was refused: shown in the dialog, not behind it. */
  const [refused, setRefused] = useState<unknown>(null);
  const setDialog = (d: Dialog | null) => {
    setRefused(null);
    setDialogState(d);
  };
  /** After a rename or drop: where to go once its job is done. */
  const [next, setNext] = useState<{ jobId: number; table: string | null } | null>(null);
  useEffect(() => {
    if (next && run.job?.id === next.jobId && run.job.status === 'succeeded') {
      setNext(null);
      onTable(next.table);
    }
  }, [next, run.job, onTable]);

  if (s.isError && !s.data) return <ErrorNote error={s.error} />;
  if (!s.data) return <Spinner />;
  const st = s.data;
  const editable = st.type === 'table';
  const alterPath = structurePaths.alter(slug, db, table);
  const apply = (changes: DbAlterChange[], then?: string | null) =>
    run.mutate(
      { path: alterPath, body: { changes }, action: `alter:${table}` },
      {
        onSuccess: (job) => {
          setDialog(null);
          if (then !== undefined) setNext({ jobId: job.id, table: then });
        },
        onError: setRefused,
      },
    );
  const busy = run.busy(`alter:${table}`) || run.busy(`table:${table}`);

  return (
    <div className="space-y-5">
      <ErrorNote error={run.error} />
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button small variant="secondary" onClick={() => setDialog({ kind: 'column', column: null })} disabled={busy}>
            Add column
          </Button>
          <Button small variant="secondary" onClick={() => setDialog({ kind: 'index' })} disabled={busy}>
            Add index
          </Button>
          <Button small variant="secondary" onClick={() => setDialog({ kind: 'foreignKey' })} disabled={busy}>
            Add foreign key
          </Button>
          <span className="flex-1" />
          <Button small variant="ghost" onClick={() => setDialog({ kind: 'rename' })} disabled={busy}>
            Rename
          </Button>
          <Button small variant="ghost" onClick={() => setDialog({ kind: 'table', what: 'truncate' })} disabled={busy}>
            Empty
          </Button>
          <Button small variant="ghost" onClick={() => setDialog({ kind: 'table', what: 'drop' })} disabled={busy}>
            Drop
          </Button>
        </div>
      )}
      {!editable && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          A view's structure is its query: change it with SQL.
          <Button small variant="ghost" onClick={() => setDialog({ kind: 'table', what: 'drop' })} disabled={busy}>
            Drop view
          </Button>
        </div>
      )}

      <ColumnsTable s={st} editable={editable} onEdit={(c) => setDialog({ kind: 'column', column: c })} onDrop={(name) => setDialog({ kind: 'drop', what: 'column', name })} />
      {(st.indexes.length > 0 || editable) && (
        <Section title="Indexes">
          {st.indexes.length === 0 ? (
            <p className="text-xs text-neutral-500">None.</p>
          ) : (
            <ul className="space-y-1 text-[13px]">
              {st.indexes.map((i) => (
                <li key={i.name} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono">{i.name}</span>
                  <span className="text-neutral-500">
                    {i.name === 'PRIMARY' ? 'primary key' : i.type === 'FULLTEXT' ? 'full-text' : i.unique ? 'unique' : 'index'} (
                    {i.columns.map((c, n) => (i.lengths[n] ? `${c}(${i.lengths[n]})` : c)).join(', ')})
                  </span>
                  {editable && (
                    <button type="button" className="text-xs text-red-600 underline" onClick={() => setDialog({ kind: 'drop', what: 'index', name: i.name })} disabled={busy}>
                      Drop
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {(st.foreignKeys.length > 0 || editable) && (
        <Section title="Foreign keys">
          {st.foreignKeys.length === 0 ? (
            <p className="text-xs text-neutral-500">None.</p>
          ) : (
            <ul className="space-y-1 text-[13px]">
              {st.foreignKeys.map((f) => (
                <li key={f.name} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono">{f.name}</span>
                  <span className="text-neutral-500">
                    ({f.columns.join(', ')}) → <span className="font-mono">{f.refTable}</span> ({f.refColumns.join(', ')}) · on delete{' '}
                    {f.onDelete.toLowerCase()} · on update {f.onUpdate.toLowerCase()}
                  </span>
                  {editable && (
                    <button type="button" className="text-xs text-red-600 underline" onClick={() => setDialog({ kind: 'drop', what: 'foreignKey', name: f.name })} disabled={busy}>
                      Drop
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {!st.key && st.type === 'table' && <p className="text-xs text-neutral-500">No primary key: rows are read only here. Add one to edit them.</p>}

      {dialog?.kind === 'column' && (
        <ColumnDialog s={st} column={dialog.column} alterPath={alterPath} busy={run.isPending} refused={refused} onApply={(c) => apply(c)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'index' && (
        <IndexDialog s={st} alterPath={alterPath} busy={run.isPending} refused={refused} onApply={(c) => apply(c)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'foreignKey' && (
        <ForeignKeyDialog
          slug={slug}
          db={db}
          s={st}
          tables={tables}
          alterPath={alterPath}
          busy={run.isPending}
          refused={refused}
          onApply={(c) => apply(c)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && (
        <RenameDialog
          table={table}
          tables={tables}
          alterPath={alterPath}
          busy={run.isPending}
          refused={refused}
          onApply={(name) => apply([{ op: 'rename', name }], name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'drop' && (
        <DropPartDialog
          what={dialog.what}
          name={dialog.name}
          table={table}
          alterPath={alterPath}
          onConfirm={(changes) => apply(changes)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'table' && (
        <TableActionDialog
          what={dialog.what}
          table={table}
          view={st.type === 'view'}
          path={dialog.what === 'drop' ? structurePaths.drop(slug, db, table) : structurePaths.truncate(slug, db, table)}
          onConfirm={() =>
            run.mutate(
              {
                path: dialog.what === 'drop' ? structurePaths.drop(slug, db, table) : structurePaths.truncate(slug, db, table),
                method: dialog.what === 'drop' ? 'DELETE' : 'POST',
                action: `table:${table}`,
              },
              {
                onSuccess: (job) => {
                  setDialog(null);
                  if (dialog.what === 'drop') setNext({ jobId: job.id, table: null });
                },
              },
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">{title}</h3>
      {children}
    </div>
  );
}

function ColumnsTable({
  s,
  editable,
  onEdit,
  onDrop,
}: {
  s: DbTableStructureDto;
  editable: boolean;
  onEdit: (c: DbColumnDto) => void;
  onDrop: (name: string) => void;
}) {
  const keyNames = useMemo(() => new Set(s.key ?? []), [s.key]);
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200">
      <table className="w-full text-[13px]">
        <thead className="bg-neutral-50 text-left text-neutral-600">
          <tr>
            <th className="px-2 py-1.5 font-medium">Column</th>
            <th className="px-2 py-1.5 font-medium">Type</th>
            <th className="px-2 py-1.5 font-medium">NULL</th>
            <th className="px-2 py-1.5 font-medium">Default</th>
            <th className="px-2 py-1.5 font-medium">Extra</th>
            <th className="px-2 py-1.5 font-medium">Comment</th>
            {editable && <th className="px-2 py-1.5" />}
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
              <td className="px-2 py-1 text-neutral-600">{[c.extra, c.check && `CHECK (${c.check})`].filter(Boolean).join(' · ')}</td>
              <td className="max-w-[16rem] truncate px-2 py-1 text-neutral-600" title={c.comment}>
                {c.comment}
              </td>
              {editable && (
                <td className="whitespace-nowrap px-2 py-1 text-right text-xs">
                  <button
                    type="button"
                    className="underline disabled:text-neutral-400 disabled:no-underline"
                    onClick={() => onEdit(c)}
                    disabled={lockedReason(c) !== null}
                    title={lockedReason(c) ?? undefined}
                  >
                    Edit
                  </button>
                  <button type="button" className="ml-3 text-red-600 underline" onClick={() => onDrop(c.name)} disabled={s.columns.length === 1} title={s.columns.length === 1 ? 'A table keeps at least one column' : undefined}>
                    Drop
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Preview {
  /** The SQL for the form as it is now; null until the panel has answered for it. */
  statements: string[] | null;
  error: unknown;
  /** The SQL for the form as it was a moment ago: shown faded while the panel answers. */
  last: string[] | null;
}

/**
 * The SQL a form would run, asked of the panel as the form changes (it is the one that checks):
 * shown under the form, or why it would not run. A form applies only what was shown for it.
 */
function usePreview(path: string, method: 'POST' | 'DELETE', body: Record<string, unknown> | undefined, ready: boolean): Preview {
  const key = JSON.stringify([path, method, body, ready]);
  const [state, setState] = useState<{ key: string; statements: string[] | null; error: unknown }>({ key: '', statements: null, error: null });
  useEffect(() => {
    if (!ready) {
      setState({ key, statements: null, error: null });
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      previewStructure(path, method, body).then(
        (res) => live && setState({ key, statements: res.statements, error: null }),
        (err: unknown) => live && setState({ key, statements: null, error: err }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The key stands for path, method, body and ready.
  }, [key]);
  const fresh = state.key === key;
  return { statements: fresh ? state.statements : null, error: fresh ? state.error : null, last: state.statements };
}

function SqlPreview({ preview }: { preview: Preview }) {
  if (preview.error) return <ErrorNote error={preview.error} />;
  const shown = preview.statements ?? preview.last;
  if (!shown) return null;
  return (
    <div className={preview.statements ? undefined : 'opacity-50'}>
      <div className="mb-1 text-xs text-neutral-500">Runs as the site's database user:</div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-neutral-50 p-2 font-mono text-xs text-neutral-800">
        {shown.join(';\n')}
      </pre>
    </div>
  );
}

interface ColumnForm {
  name: string;
  type: string;
  nullable: boolean;
  defaultKind: DbColumnDef['default']['kind'];
  defaultValue: string;
  onUpdate: boolean;
  autoIncrement: boolean;
  comment: string;
  /** '' where it is (or at the end), 'first', or 'after:<column>'. */
  position: string;
}

/** Which kind of value a type holds: a change to another kind converts every row, and no default carries over. */
function typeFamily(type: string): string {
  const t = type.trim();
  if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|dec|numeric|fixed|float|double|real|bit|bool|boolean)\b/i.test(t)) return 'number';
  if (/^(?:date|time|datetime|timestamp|year)\b/i.test(t)) return 'time';
  if (/^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/i.test(t)) return 'binary';
  if (/^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set|json)\b/i.test(t)) return 'text';
  return t.toLowerCase();
}

/**
 * Whether a column's default can be kept as it is. Not where MariaDB shows a character it cannot
 * print as `?` (an emoji, a binary byte): kept, it would become a real `?`.
 */
const keepable = (c: DbColumnDto | null) => c?.default != null && !c.default.includes('?');

/** A default as MariaDB shows it, as the text to type: `'it''s'` is it's. */
const unquoted = (d: string) => (/^'.*'$/s.test(d) ? d.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, '\\') : d);

/** Why the form cannot change a column without losing part of it; null when it can. */
function lockedReason(c: DbColumnDto): string | null {
  if (/\bGENERATED\b/i.test(c.extra)) return 'A generated column: change it with SQL';
  if (/\bINVISIBLE\b/i.test(c.extra)) return 'An invisible column: change it with SQL';
  if (c.check) return 'It has a CHECK constraint: change it with SQL';
  return null;
}

const formFor = (c: DbColumnDto | null): ColumnForm =>
  c
    ? {
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        defaultKind: c.default === null ? 'none' : keepable(c) ? 'keep' : 'value',
        defaultValue: c.default !== null && !keepable(c) ? unquoted(c.default) : '',
        onUpdate: /on update current_timestamp/i.test(c.extra),
        autoIncrement: /auto_increment/i.test(c.extra),
        comment: c.comment,
        position: '',
      }
    : { name: '', type: 'varchar(191)', nullable: false, defaultKind: 'none', defaultValue: '', onUpdate: false, autoIncrement: false, comment: '', position: '' };

function ColumnDialog({
  s,
  column,
  alterPath,
  busy,
  refused,
  onApply,
  onClose,
}: {
  s: DbTableStructureDto;
  /** null: a new column. */
  column: DbColumnDto | null;
  alterPath: string;
  busy: boolean;
  refused: unknown;
  onApply: (changes: DbAlterChange[]) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<ColumnForm>(() => formFor(column));
  const set = (patch: Partial<ColumnForm>) =>
    setF((prev) => {
      const next = { ...prev, ...patch };
      if (next.defaultKind === 'keep' && column) {
        // Kept, NULL is no default once the column takes no NULL; and a default of one kind of
        // value does not fit a type of another.
        const keptNull = column.default?.toUpperCase() === 'NULL';
        if ((keptNull && !next.nullable) || typeFamily(next.type) !== typeFamily(column.type)) next.defaultKind = 'none';
      }
      return next;
    });
  const type = f.type.trim();
  const converts = column !== null && type !== '' && type.toLowerCase() !== column.type.toLowerCase();
  const typeOk = DB_COLUMN_TYPE_RE.test(type) || (column !== null && type === column.type);
  const dateTime = DATE_TIME_RE.test(type);
  const wholeNumber = WHOLE_NUMBER_RE.test(type);
  const others = s.columns.filter((c) => c.name !== column?.name);
  const def: DbColumnDef = {
    name: f.name,
    type,
    nullable: f.nullable,
    default:
      f.defaultKind === 'value' ? { kind: 'value', value: f.defaultValue } : ({ kind: f.defaultKind } as DbColumnDef['default']),
    onUpdateCurrentTimestamp: dateTime && f.onUpdate,
    autoIncrement: wholeNumber && f.autoIncrement,
    comment: f.comment,
    // A change keeps the column's own collation; a new column takes the table's.
    collation: column?.collation ?? null,
  };
  const position = f.position === '' ? null : f.position === 'first' ? 'first' : { after: f.position.slice('after:'.length) };
  const changes: DbAlterChange[] = column
    ? [{ op: 'modifyColumn', name: column.name, column: def, position } as DbAlterChange]
    : [{ op: 'addColumn', column: def, position } as DbAlterChange];
  const ready = f.name.trim() !== '' && typeOk;
  const preview = usePreview(alterPath, 'POST', { changes }, ready);

  return (
    <Modal title={column ? `Change column ${column.name}` : 'Add a column'} onClose={onClose} dismissible={false}>
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && preview.statements) onApply(changes);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={`${inputClass} font-mono`} value={f.name} onChange={(e) => set({ name: e.target.value })} autoFocus spellCheck={false} />
          </Field>
          <Field
            label="Type"
            hint={
              !typeOk && type
                ? 'Not a type this form takes: change it with SQL.'
                : converts
                  ? 'Each row is converted. A value that does not fit stops the change; decimals and fractions of a second are rounded.'
                  : undefined
            }
          >
            <input className={`${inputClass} font-mono`} value={f.type} onChange={(e) => set({ type: e.target.value })} list="wpl7-column-types" spellCheck={false} />
            <datalist id="wpl7-column-types">
              {COMMON_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={f.nullable}
              onChange={(e) => set({ nullable: e.target.checked, defaultKind: !e.target.checked && f.defaultKind === 'null' ? 'none' : f.defaultKind })}
            />
            Allow NULL
          </label>
          {wholeNumber && (
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={f.autoIncrement} onChange={(e) => set({ autoIncrement: e.target.checked })} />
              Counts up by itself
            </label>
          )}
          {dateTime && (
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={f.onUpdate} onChange={(e) => set({ onUpdate: e.target.checked })} />
              Set to the current time on every change
            </label>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Default">
            <select className={inputClass} value={f.defaultKind} onChange={(e) => set({ defaultKind: e.target.value as ColumnForm['defaultKind'] })}>
              {column?.default != null && keepable(column) && !(column.default.toUpperCase() === 'NULL' && !f.nullable) && typeFamily(type) === typeFamily(column.type) && (
                <option value="keep">As it is: {column.default}</option>
              )}
              <option value="none">No default</option>
              {f.nullable && <option value="null">NULL</option>}
              <option value="value">A value</option>
              {dateTime && <option value="currentTimestamp">The current time</option>}
            </select>
          </Field>
          {f.defaultKind === 'value' && (
            <Field label="Default value" hint={column && !keepable(column) && column.default !== null ? 'MariaDB shows some characters of it as ?. Check it.' : undefined}>
              <input className={`${inputClass} font-mono`} value={f.defaultValue} onChange={(e) => set({ defaultValue: e.target.value })} spellCheck={false} />
            </Field>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Comment">
            <input className={inputClass} value={f.comment} onChange={(e) => set({ comment: e.target.value })} />
          </Field>
          <Field label="Position">
            <select className={inputClass} value={f.position} onChange={(e) => set({ position: e.target.value })}>
              <option value="">{column ? 'Where it is' : 'At the end'}</option>
              <option value="first">First</option>
              {others.map((c) => (
                <option key={c.name} value={`after:${c.name}`}>
                  After {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <SqlPreview preview={preview} />
        <DialogButtons busy={busy} ready={ready && !!preview.statements} label={column ? 'Change column' : 'Add column'} refused={refused} onClose={onClose} />
      </form>
    </Modal>
  );
}

function DialogButtons({
  busy,
  ready,
  label,
  refused,
  onClose,
}: {
  busy: boolean;
  ready: boolean;
  label: string;
  refused?: unknown;
  onClose: () => void;
}) {
  return (
    <>
      <ErrorNote error={refused} />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} busy={busy}>
          {label}
        </Button>
      </div>
    </>
  );
}

function IndexDialog({
  s,
  alterPath,
  busy,
  refused,
  onApply,
  onClose,
}: {
  s: DbTableStructureDto;
  alterPath: string;
  busy: boolean;
  refused: unknown;
  onApply: (changes: DbAlterChange[]) => void;
  onClose: () => void;
}) {
  const hasPrimary = s.indexes.some((i) => i.name === 'PRIMARY');
  const [kind, setKind] = useState<DbIndexKind>('index');
  const [name, setName] = useState('');
  const [cols, setCols] = useState<{ name: string; length: string }[]>([{ name: s.columns[0]?.name ?? '', length: '' }]);
  const index = {
    kind,
    name: kind === 'primary' || name.trim() === '' ? null : name.trim(),
    columns: cols.filter((c) => c.name).map((c) => ({ name: c.name, length: c.length ? Number(c.length) : null })),
  };
  // A table has one primary key: a new one replaces it, in the same statement.
  const changes: DbAlterChange[] = [
    ...(kind === 'primary' && hasPrimary ? [{ op: 'dropIndex', name: 'PRIMARY' } as DbAlterChange] : []),
    { op: 'addIndex', index } as DbAlterChange,
  ];
  const ready = index.columns.length > 0 && cols.every((c) => c.length === '' || /^\d+$/.test(c.length));
  const preview = usePreview(alterPath, 'POST', { changes }, ready);

  return (
    <Modal title="Add an index" onClose={onClose} dismissible={false}>
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && preview.statements) onApply(changes);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as DbIndexKind)}>
              {(['index', 'unique', 'fulltext', 'primary'] as const).map((k) => (
                <option key={k} value={k}>
                  {k === 'primary' && hasPrimary ? 'Primary key, in place of the one it has' : INDEX_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          {kind !== 'primary' && (
            <Field label="Name" hint="Empty: named after its first column.">
              <input className={`${inputClass} font-mono`} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
            </Field>
          )}
        </div>
        <Field label="Columns" hint="Length: index only the first characters of a long text column.">
          <div className="space-y-1.5">
            {cols.map((c, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <select
                  className={`${compactInputClass} py-1 font-mono text-xs`}
                  value={c.name}
                  onChange={(e) => setCols((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                >
                  {s.columns.map((col) => (
                    <option key={col.name} value={col.name}>
                      {col.name}
                    </option>
                  ))}
                </select>
                <input
                  className={`${compactInputClass} w-24 py-1 text-xs`}
                  placeholder="Length"
                  value={c.length}
                  onChange={(e) => setCols((all) => all.map((x, j) => (j === i ? { ...x, length: e.target.value.trim() } : x)))}
                />
                {cols.length > 1 && (
                  <button type="button" aria-label="Leave this column out" className="px-1 text-neutral-400 hover:text-neutral-700" onClick={() => setCols((all) => all.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            {cols.length < 16 && (
              <button type="button" className="text-xs underline" onClick={() => setCols((all) => [...all, { name: s.columns[0]?.name ?? '', length: '' }])}>
                Add a column
              </button>
            )}
          </div>
        </Field>
        <SqlPreview preview={preview} />
        <DialogButtons busy={busy} ready={ready && !!preview.statements} label={kind === 'primary' && hasPrimary ? 'Replace primary key' : 'Add index'} refused={refused} onClose={onClose} />
      </form>
    </Modal>
  );
}

function ForeignKeyDialog({
  slug,
  db,
  s,
  tables,
  alterPath,
  busy,
  refused,
  onApply,
  onClose,
}: {
  slug: string;
  db: string;
  s: DbTableStructureDto;
  tables: string[];
  alterPath: string;
  busy: boolean;
  refused: unknown;
  onApply: (changes: DbAlterChange[]) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [refTable, setRefTable] = useState(tables.find((t) => t !== s.table) ?? s.table);
  const ref = useDbStructure(slug, db, refTable);
  const [pairs, setPairs] = useState<{ column: string; refColumn: string }[]>([{ column: s.columns[0]?.name ?? '', refColumn: '' }]);
  const [onDelete, setOnDelete] = useState<(typeof dbForeignKeyActions)[number]>('RESTRICT');
  const [onUpdate, setOnUpdate] = useState<(typeof dbForeignKeyActions)[number]>('RESTRICT');
  const refColumns = ref.data?.columns.map((c) => c.name) ?? [];
  // The referenced side starts at the other table's key, the usual target.
  useEffect(() => {
    const first = ref.data?.key?.[0] ?? ref.data?.columns[0]?.name ?? '';
    setPairs((all) => all.map((p) => ({ ...p, refColumn: refColumns.includes(p.refColumn) ? p.refColumn : first })));
  }, [ref.data]);
  const foreignKey = {
    name: name.trim() === '' ? null : name.trim(),
    columns: pairs.map((p) => p.column),
    refTable,
    refColumns: pairs.map((p) => p.refColumn),
    onDelete,
    onUpdate,
  };
  const changes: DbAlterChange[] = [{ op: 'addForeignKey', foreignKey } as DbAlterChange];
  const ready = pairs.every((p) => p.column && p.refColumn);
  const preview = usePreview(alterPath, 'POST', { changes }, ready);

  return (
    <Modal title="Add a foreign key" onClose={onClose} dismissible={false}>
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && preview.statements) onApply(changes);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Points at the table">
            <select className={`${inputClass} font-mono`} value={refTable} onChange={(e) => setRefTable(e.target.value)}>
              {tables.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name" hint="Empty: MariaDB names it.">
            <input className={`${inputClass} font-mono`} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </Field>
        </div>
        <Field label="Columns">
          <div className="space-y-1.5">
            {pairs.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                <select
                  className={`${compactInputClass} py-1 font-mono text-xs`}
                  value={p.column}
                  onChange={(e) => setPairs((all) => all.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}
                >
                  {s.columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                →
                <select
                  className={`${compactInputClass} py-1 font-mono text-xs`}
                  value={p.refColumn}
                  onChange={(e) => setPairs((all) => all.map((x, j) => (j === i ? { ...x, refColumn: e.target.value } : x)))}
                >
                  {refColumns.map((c) => (
                    <option key={c} value={c}>
                      {refTable}.{c}
                    </option>
                  ))}
                </select>
                {pairs.length > 1 && (
                  <button type="button" aria-label="Leave this pair out" className="px-1 text-neutral-400 hover:text-neutral-700" onClick={() => setPairs((all) => all.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            {pairs.length < 16 && (
              <button
                type="button"
                className="text-xs underline"
                onClick={() => setPairs((all) => [...all, { column: s.columns[0]?.name ?? '', refColumn: refColumns[0] ?? '' }])}
              >
                Add a pair
              </button>
            )}
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="When the row it points at is deleted">
            <select className={inputClass} value={onDelete} onChange={(e) => setOnDelete(e.target.value as typeof onDelete)}>
              {dbForeignKeyActions.map((a) => (
                <option key={a} value={a}>
                  {a.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="When its key changes">
            <select className={inputClass} value={onUpdate} onChange={(e) => setOnUpdate(e.target.value as typeof onUpdate)}>
              {dbForeignKeyActions.map((a) => (
                <option key={a} value={a}>
                  {a.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <SqlPreview preview={preview} />
        <DialogButtons busy={busy} ready={ready && !!preview.statements} label="Add foreign key" refused={refused} onClose={onClose} />
      </form>
    </Modal>
  );
}

function RenameDialog({
  table,
  tables,
  alterPath,
  busy,
  refused,
  onApply,
  onClose,
}: {
  table: string;
  tables: string[];
  alterPath: string;
  busy: boolean;
  refused: unknown;
  onApply: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(table);
  const taken = name !== table && tables.includes(name);
  const ready = name.trim() !== '' && name !== table && !taken;
  const preview = usePreview(alterPath, 'POST', { changes: [{ op: 'rename', name }] }, ready);
  return (
    <Modal title={`Rename ${table}`} onClose={onClose}>
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && preview.statements) onApply(name);
        }}
      >
        <Field label="New name" hint={taken ? 'There is a table with that name.' : 'Code that uses the old name stops finding it.'}>
          <input className={`${inputClass} font-mono`} value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />
        </Field>
        <SqlPreview preview={preview} />
        <DialogButtons busy={busy} ready={ready && !!preview.statements} label="Rename" refused={refused} onClose={onClose} />
      </form>
    </Modal>
  );
}

function DropPartDialog({
  what,
  name,
  table,
  alterPath,
  onConfirm,
  onClose,
}: {
  what: 'column' | 'index' | 'foreignKey';
  name: string;
  table: string;
  alterPath: string;
  onConfirm: (changes: DbAlterChange[]) => void;
  onClose: () => void;
}) {
  const op = what === 'column' ? 'dropColumn' : what === 'index' ? 'dropIndex' : 'dropForeignKey';
  const changes = [{ op, name } as DbAlterChange];
  const preview = usePreview(alterPath, 'POST', { changes }, true);
  const label = what === 'column' ? `column ${name}` : what === 'index' ? (name === 'PRIMARY' ? 'the primary key' : `index ${name}`) : `foreign key ${name}`;
  return (
    <ConfirmDialog
      title={`Drop ${label}`}
      message={what === 'column' ? `From ${table}, with everything in it. It cannot be undone, except from a backup.` : `From ${table}.`}
      confirmLabel="Drop"
      onConfirm={() => onConfirm(changes)}
      onClose={onClose}
    >
      <SqlPreview preview={preview} />
    </ConfirmDialog>
  );
}

function TableActionDialog({
  what,
  table,
  view,
  path,
  onConfirm,
  onClose,
}: {
  what: 'truncate' | 'drop';
  table: string;
  view: boolean;
  path: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const preview = usePreview(path, what === 'drop' ? 'DELETE' : 'POST', undefined, true);
  return (
    <ConfirmDialog
      title={what === 'drop' ? `Drop ${view ? 'view' : 'table'} ${table}` : `Empty ${table}`}
      message={
        what === 'drop'
          ? `${view ? 'The view' : 'The table and every row in it'} go. It cannot be undone, except from a backup.`
          : 'Every row goes; the table stays. It cannot be undone, except from a backup.'
      }
      confirmWord={table}
      confirmLabel={what === 'drop' ? 'Drop' : 'Empty'}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <SqlPreview preview={preview} />
    </ConfirmDialog>
  );
}

interface NewColumn {
  name: string;
  type: string;
  nullable: boolean;
  autoIncrement: boolean;
  key: boolean;
}

/** A new table: its name, its columns and which of them make the primary key. */
export function NewTableDialog({
  slug,
  db,
  tables,
  onCreated,
  onClose,
}: {
  slug: string;
  db: string;
  tables: string[];
  /** Its job is done: the new table, to show it. */
  onCreated: (table: string) => void;
  onClose: () => void;
}) {
  const run = useRunJob([['db-tables', slug, db], ['site-databases', slug]]);
  const [name, setName] = useState('');
  const [cols, setCols] = useState<NewColumn[]>([
    { name: 'id', type: 'bigint unsigned', nullable: false, autoIncrement: true, key: true },
    { name: '', type: 'varchar(191)', nullable: false, autoIncrement: false, key: false },
  ]);
  const [jobId, setJobId] = useState<number | null>(null);
  useEffect(() => {
    if (jobId !== null && run.job?.id === jobId && run.job.status === 'succeeded') onCreated(name.trim());
  }, [jobId, run.job, name, onCreated]);
  const set = (i: number, patch: Partial<NewColumn>) => setCols((all) => all.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const named = cols.filter((c) => c.name.trim() !== '');
  const body = {
    name: name.trim(),
    columns: named.map((c) => ({
      name: c.name.trim(),
      type: c.type.trim(),
      nullable: c.nullable && !c.key,
      default: { kind: 'none' },
      autoIncrement: c.autoIncrement && WHOLE_NUMBER_RE.test(c.type.trim()),
    })),
    primaryKey: named.filter((c) => c.key).map((c) => c.name.trim()),
  };
  const taken = tables.includes(body.name);
  const ready = body.name !== '' && !taken && named.length > 0 && named.every((c) => DB_COLUMN_TYPE_RE.test(c.type.trim()));
  const path = structurePaths.create(slug, db);
  const preview = usePreview(path, 'POST', body, ready);

  return (
    <Modal title="New table" onClose={onClose} dismissible={false} wide>
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || !preview.statements) return;
          run.mutate({ path, body, action: 'create' }, { onSuccess: (job) => setJobId(job.id) });
        }}
      >
        <Field label="Name" hint={taken ? 'There is a table with that name.' : undefined} width="md">
          <input className={`${inputClass} font-mono`} value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />
        </Field>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-neutral-500">
              <tr>
                <th className="pb-1 font-medium">Column</th>
                <th className="pb-1 font-medium">Type</th>
                <th className="pb-1 font-medium">NULL</th>
                <th className="pb-1 font-medium">Counts up</th>
                <th className="pb-1 font-medium">Key</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cols.map((c, i) => (
                <tr key={i}>
                  <td className="py-0.5 pr-1.5">
                    <input className={`${compactInputClass} w-full py-1 font-mono text-xs`} value={c.name} onChange={(e) => set(i, { name: e.target.value })} spellCheck={false} />
                  </td>
                  <td className="py-0.5 pr-1.5">
                    <input
                      className={`${compactInputClass} w-full py-1 font-mono text-xs ${c.type && !DB_COLUMN_TYPE_RE.test(c.type.trim()) ? 'border-red-400' : ''}`}
                      value={c.type}
                      onChange={(e) => set(i, { type: e.target.value })}
                      list="wpl7-new-column-types"
                      spellCheck={false}
                    />
                  </td>
                  <td className="py-0.5 pr-1.5 text-center">
                    <input type="checkbox" checked={c.nullable && !c.key} disabled={c.key} onChange={(e) => set(i, { nullable: e.target.checked })} aria-label="Allow NULL" />
                  </td>
                  <td className="py-0.5 pr-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={c.autoIncrement}
                      disabled={!WHOLE_NUMBER_RE.test(c.type.trim())}
                      onChange={(e) => set(i, { autoIncrement: e.target.checked })}
                      aria-label="Counts up by itself"
                    />
                  </td>
                  <td className="py-0.5 pr-1.5 text-center">
                    <input type="checkbox" checked={c.key} onChange={(e) => set(i, { key: e.target.checked })} aria-label="Part of the primary key" />
                  </td>
                  <td className="py-0.5 text-right">
                    {cols.length > 1 && (
                      <button type="button" aria-label="Leave this column out" className="px-1 text-neutral-400 hover:text-neutral-700" onClick={() => setCols((all) => all.filter((_, j) => j !== i))}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="wpl7-new-column-types">
            {COMMON_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <button
            type="button"
            className="mt-1 text-xs underline"
            onClick={() => setCols((all) => [...all, { name: '', type: 'varchar(191)', nullable: false, autoIncrement: false, key: false }])}
          >
            Add a column
          </button>
        </div>
        <p className="text-xs text-neutral-500">Defaults, comments and indexes can be added once the table is there.</p>
        <SqlPreview preview={preview} />
        <DialogButtons
          busy={run.isPending || (jobId !== null && run.busy('create'))}
          ready={ready && !!preview.statements && jobId === null}
          label="Create table"
          refused={run.error}
          onClose={onClose}
        />
      </form>
    </Modal>
  );
}
