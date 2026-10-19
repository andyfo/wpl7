// @docs sites/database
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DbRowKey } from '../../../../shared/databases';
import { editScalar, parsePhp, phpKeyLabel, replaceAt, serializePhp, type PhpValue } from '../../../../shared/phpSerialize';
import type { DbCell, DbColumnDto } from '../../../../shared/types';
import { deleteDbRows, fetchDbRow, insertDbRow, updateDbRow, useDbStructure } from '../../api/databases';
import { formatBytes } from '../../lib/format';
import { Button, ConfirmDialog, ErrorNote, Modal, Spinner, compactInputClass, inputClass } from '../ui';
import { cellText, isBinary, isCut } from './cells';

export type RowSheetMode =
  | { kind: 'edit'; key: DbRowKey }
  | { kind: 'new' }
  /**
   * A row that cannot be found again: what the page showed, read only. `keyCut`: the table has a
   * key, but this row's came too long or binary to find it by.
   */
  | { kind: 'view'; columns: DbColumnDto[]; values: DbCell[]; keyCut?: boolean };

/** All line breaks CRLF, as a browser's form sends them: a textarea hands back LF, so they are put back. */
const usesCrlf = (text: string): boolean => text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
const withCrlf = (typed: string): string => typed.replace(/\r?\n/g, '\r\n');

/**
 * One row, whole: every column with its type, to read, change, insert or delete. Only the columns
 * changed are sent. A value PHP serialized - what WordPress keeps in its options and meta - can be
 * edited as the data it is, and goes back with its lengths counted again.
 */
export function RowSheet({
  slug,
  db,
  table,
  mode,
  onClose,
  onSaved,
}: {
  slug: string;
  db: string;
  table: string;
  mode: RowSheetMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const structure = useDbStructure(slug, db, table);
  const row = useQuery({
    queryKey: ['db-row', slug, db, table, mode.kind === 'edit' ? mode.key : null],
    queryFn: () => fetchDbRow(slug, db, table, (mode as { key: DbRowKey }).key),
    enabled: mode.kind === 'edit',
    // Read afresh every time the sheet opens: an edit made on what an earlier opening read would
    // write back the values from before the last save.
    staleTime: 0,
    gcTime: 0,
  });
  /** Changed values only: column -> text, or null for NULL. */
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const columns = mode.kind === 'view' ? mode.columns : mode.kind === 'edit' ? row.data?.columns : structure.data?.columns;
  const values = mode.kind === 'view' ? mode.values : mode.kind === 'edit' ? row.data?.values : undefined;
  const keyColumns = new Set(mode.kind === 'edit' ? (row.data?.key ?? []) : []);
  const readOnly = mode.kind === 'view';
  const changed = Object.keys(draft).length;
  // A PHP value edited as text into something PHP cannot read: WordPress would take it as empty.
  const broken = new Set(
    (columns ?? [])
      .filter((c, i) => {
        const next = draft[c.name];
        const before = values?.[i];
        return typeof next === 'string' && typeof before === 'string' && parsePhp(before) !== null && parsePhp(next) === null;
      })
      .map((c) => c.name),
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (mode.kind === 'edit') await updateDbRow(slug, db, table, mode.key, draft);
      else await insertDbRow(slug, db, table, draft);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const title =
    mode.kind === 'new'
      ? `New row in ${table}`
      : mode.kind === 'edit'
        ? `${table}: ${Object.entries(mode.key)
            .map(([k, v]) => `${k} ${v ?? 'NULL'}`)
            .join(', ')}`
        : `Row in ${table}`;

  return (
    <Modal
      title={title}
      sheet
      onClose={onClose}
      dismissible={changed === 0}
      footer={
        <div className="flex items-center justify-between gap-2">
          <div>
            {mode.kind === 'edit' && (
              <Button variant="danger" small onClick={() => setConfirmDelete(true)}>
                Delete row
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {!readOnly && (
              <Button
                onClick={() => void save()}
                disabled={(mode.kind === 'edit' && changed === 0) || broken.size > 0}
                title={broken.size > 0 ? 'A PHP value no longer reads as PHP data' : undefined}
                busy={saving}
              >
                {mode.kind === 'new' ? 'Insert row' : changed > 1 ? `Save ${changed} changes` : 'Save'}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <ErrorNote error={error ?? row.error ?? (mode.kind === 'new' ? structure.error : null)} />
      {readOnly && (
        <p className="mb-4 text-xs text-neutral-500">
          {mode.kind === 'view' && mode.keyCut
            ? "This row's key is too long or binary to find the row by, so it cannot be changed here. Use SQL."
            : 'This table has no primary key, so its rows cannot be changed here. Use SQL.'}
        </p>
      )}
      {!columns || (mode.kind === 'edit' && !values) ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          {columns.map((c, i) => (
            <ValueField
              key={c.name}
              column={c}
              original={values ? (values[i] ?? null) : undefined}
              value={c.name in draft ? draft[c.name]! : undefined}
              locked={readOnly || keyColumns.has(c.name)}
              lockedWhy={keyColumns.has(c.name) ? 'Part of the key that finds this row' : undefined}
              broken={broken.has(c.name)}
              onChange={(next) =>
                setDraft((d) => {
                  const out = { ...d };
                  const before = values ? (values[i] ?? null) : undefined;
                  if (next === undefined || (before !== undefined && next === (typeof before === 'string' ? before : before === null ? null : undefined))) {
                    delete out[c.name];
                  } else {
                    out[c.name] = next;
                  }
                  return out;
                })
              }
            />
          ))}
        </div>
      )}
      {confirmDelete && mode.kind === 'edit' && (
        <ConfirmDialog
          title="Delete this row"
          message={`From ${table}. It cannot be undone, except from a backup.`}
          confirmLabel="Delete row"
          onConfirm={() => {
            deleteDbRows(slug, db, table, [mode.key]).then(onSaved, setError);
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </Modal>
  );
}

/**
 * One column of the row. `original`: the value read (undefined for a new row). `value`: what the
 * edit has made of it, undefined while unchanged - or, on a new row, left to its default.
 */
function ValueField({
  column: c,
  original,
  value,
  locked,
  lockedWhy,
  broken,
  onChange,
}: {
  column: DbColumnDto;
  original: DbCell | undefined;
  value: string | null | undefined;
  locked: boolean;
  lockedWhy?: string;
  broken: boolean;
  onChange: (next: string | null | undefined) => void;
}) {
  const [asData, setAsData] = useState(false);
  const isNew = original === undefined;
  const current: string | null | undefined = value !== undefined ? value : isNew ? undefined : cellText(original ?? null);
  const label = (
    <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
      <span className="font-mono text-sm font-medium">{c.name}</span>
      <span className="text-xs text-neutral-400">
        {c.type}
        {c.extra ? ` · ${c.extra}` : ''}
      </span>
    </div>
  );

  if (original !== undefined && isBinary(original)) {
    return (
      <div>
        {label}
        <p className="text-sm text-neutral-500">
          Binary data, {formatBytes(original.binary)}
          {original.hex && <span className="ml-2 font-mono text-xs">0x{original.hex.slice(0, 64)}…</span>}. Change it with SQL.
        </p>
      </div>
    );
  }
  if (original !== undefined && isCut(original) && value === undefined) {
    return (
      <div>
        {label}
        <p className="text-sm text-neutral-500">
          Too long to edit here ({original.length.toLocaleString()} characters). It starts:
        </p>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-2 text-xs">{original.cut.slice(0, 2000)}</pre>
      </div>
    );
  }

  const isNull = current === null;
  const text = current ?? '';
  const long = /text|json/.test(c.type) || text.includes('\n') || text.length > 80;
  const placeholder = isNew
    ? c.extra.includes('auto_increment')
      ? 'automatic'
      : c.default !== null && c.default !== 'NULL'
        ? `default: ${c.default}`
        : c.nullable
          ? 'NULL'
          : ''
    : '';
  const php = !isNull && text ? parsePhp(text) : null;
  const json = !php && !isNull && /^\s*[[{]/.test(text) ? safeJson(text) : undefined;
  // Lengths are recounted as UTF-8 bytes, which is what they are in a UTF-8 column and nowhere else.
  const phpEditable = !!php && php.editable && !locked && (c.charset ?? '').startsWith('utf8');
  const crlf = typeof original === 'string' && usesCrlf(original);
  // Whatever surrounds the serialized value goes back with it.
  const [lead, trail] = [/^\s*/.exec(text)![0], /\s*$/.exec(text)![0]];

  return (
    <div>
      {label}
      {long ? (
        <textarea
          className={`${inputClass} font-mono text-xs ${broken ? 'border-red-400' : ''}`}
          rows={Math.min(12, Math.max(3, text.split('\n').length))}
          value={isNull ? '' : text}
          placeholder={isNull ? 'NULL' : placeholder}
          disabled={locked || isNull || (asData && (!!php || json !== undefined))}
          onChange={(e) => onChange(crlf ? withCrlf(e.target.value) : e.target.value)}
          spellCheck={false}
        />
      ) : (
        <input
          className={`${inputClass} font-mono text-sm`}
          value={isNull ? '' : text}
          placeholder={isNull ? 'NULL' : placeholder}
          disabled={locked || isNull}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      )}
      {broken && (
        <p className="mt-1 text-xs text-red-600">
          No longer reads as PHP data, so WordPress would take it as empty. Edit it as PHP data instead.
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
        {lockedWhy && <span>{lockedWhy}</span>}
        {c.nullable && !locked && (
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={isNull} onChange={(e) => onChange(e.target.checked ? null : '')} />
            NULL
          </label>
        )}
        {isNew && value !== undefined && (
          <button type="button" className="underline" onClick={() => onChange(undefined)}>
            Use the default
          </button>
        )}
        {php && (
          <button type="button" className="underline" onClick={() => setAsData((v) => !v)}>
            {asData ? 'Edit as text' : phpEditable ? 'Edit as PHP data' : 'View as PHP data'}
          </button>
        )}
        {json !== undefined && (
          <button type="button" className="underline" onClick={() => setAsData((v) => !v)}>
            {asData ? 'Hide JSON' : 'View as JSON'}
          </button>
        )}
      </div>
      {asData && php && (
        <div className="mt-2 rounded-lg border border-neutral-200 p-2">
          <PhpTree
            value={php.value}
            editable={phpEditable}
            onChange={(next) => onChange(lead + serializePhp(next) + trail)}
          />
        </div>
      )}
      {asData && json !== undefined && (
        <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-xs">{JSON.stringify(json, null, 2)}</pre>
      )}
    </div>
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A PHP value as a tree. Editable: its scalars can be changed, and the whole goes back through serializePhp. */
function PhpTree({ value, editable, onChange }: { value: PhpValue; editable: boolean; onChange: (v: PhpValue) => void }) {
  return (
    <PhpNode
      node={value}
      path={[]}
      editable={editable}
      onLeaf={(path, next) => onChange(replaceAt(value, path, next))}
    />
  );
}

function PhpNode({
  node,
  path,
  editable,
  onLeaf,
}: {
  node: PhpValue;
  path: number[];
  editable: boolean;
  onLeaf: (path: number[], next: PhpValue) => void;
}) {
  const [open, setOpen] = useState(path.length < 2);
  if (node.t === 'array' || node.t === 'object') {
    const entries = node.t === 'array' ? node.items : node.props;
    return (
      <div className="text-xs">
        <button type="button" className="font-mono text-neutral-500 hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} {node.t === 'array' ? `array (${entries.length})` : `${node.cls} (${entries.length})`}
        </button>
        {open && (
          <div className="ml-3 mt-1 space-y-1 border-l border-neutral-200 pl-2">
            {entries.map((e, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="shrink-0 pt-1 font-mono text-neutral-500">{phpKeyLabel(e.key)}</span>
                <div className="min-w-0 flex-1">
                  <PhpNode node={e.value} path={[...path, i]} editable={editable} onLeaf={onLeaf} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return <PhpLeaf node={node} editable={editable} onChange={(next) => onLeaf(path, next)} />;
}

function PhpLeaf({ node, editable, onChange }: { node: PhpValue; editable: boolean; onChange: (v: PhpValue) => void }) {
  const initial = node.t === 'string' || node.t === 'int' || node.t === 'float' ? node.v : node.t === 'bool' ? String(node.v) : '';
  const [text, setText] = useState(initial);
  const [bad, setBad] = useState(false);
  const scalar = node.t === 'string' || node.t === 'int' || node.t === 'float' || node.t === 'bool';
  if (!scalar || !editable) {
    const shown =
      node.t === 'null'
        ? 'null'
        : node.t === 'string'
          ? `"${node.v}"`
          : node.t === 'custom'
            ? `${node.cls} (its own format)`
            : node.t === 'ref'
              ? 'a reference'
              : 'v' in node
                ? String(node.v)
                : '';
    return <span className="break-all font-mono text-xs">{shown}</span>;
  }
  if (node.t === 'bool') {
    return (
      <select
        className={`${compactInputClass} py-0.5 text-xs`}
        value={String(node.v)}
        onChange={(e) => onChange({ t: 'bool', v: e.target.value === 'true' })}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (node.t === 'string') {
    // A textarea, not an input: an input drops line breaks, and a widget's text has paragraphs.
    const crlf = usesCrlf(node.v);
    return (
      <textarea
        className={`${compactInputClass} w-full py-0.5 font-mono text-xs`}
        rows={Math.min(8, text.split('\n').length)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(editScalar(node, crlf ? withCrlf(e.target.value) : e.target.value)!);
        }}
        spellCheck={false}
        title="text"
      />
    );
  }
  return (
    <input
      className={`${compactInputClass} w-full py-0.5 font-mono text-xs ${bad ? 'border-red-400' : ''}`}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = editScalar(node, e.target.value);
        setBad(next === null);
        if (next) onChange(next);
      }}
      title={node.t === 'int' ? 'whole number' : 'number'}
    />
  );
}
