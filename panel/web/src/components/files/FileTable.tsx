// @docs sites/files
import { useMemo, useState, type MouseEvent } from 'react';
import type { SiteFileEntryDto } from '../../../../shared/types';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import { EmptyState } from '../ui';
import { Icon } from '../Icon';
import {
  ContextMenu,
  entryIcon,
  isFolderLike,
  isTemporary,
  ownerName,
  permissionString,
  RowMenu,
  type MenuItem,
} from './common';

type SortKey = 'name' | 'size' | 'mtime';

/** Rows drawn at first; a folder of 10 000 uploads should not freeze the tab. */
const FIRST_ROWS = 1000;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** "3m ago" for what changed this week; a date for the rest - "2422d ago" says nothing. */
function modified(ms: number): string {
  if (Date.now() - ms < 7 * 86_400_000) return timeAgo(ms);
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function FileTable({
  entries,
  parent,
  selected,
  onSelect,
  onOpen,
  onUp,
  menuFor,
  emptyText,
}: {
  entries: SiteFileEntryDto[];
  /** The folder above, or null at the site folder. */
  parent: string | null;
  /** Names in this folder. */
  selected: Set<string>;
  onSelect: (next: Set<string>) => void;
  onOpen: (e: SiteFileEntryDto) => void;
  onUp: () => void;
  menuFor: (e: SiteFileEntryDto) => MenuItem[];
  emptyText: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [showAll, setShowAll] = useState(false);
  // A right-click opens the row's own menu where the pointer is. The items are made then, so
  // they act on that row's path even if the folder changes before one is picked.
  const [context, setContext] = useState<
    { name: string; items: MenuItem[]; x: number; y: number; flipAt?: number; fromKeyboard: boolean } | null
  >(null);

  const openContext = (e: SiteFileEntryDto, ev: MouseEvent<HTMLTableRowElement>) => {
    // A name the panel cannot address has no menu; the browser keeps its own there.
    if (!e.nameOk) return;
    ev.preventDefault();
    // The menu key and Shift-F10 report no pointer position: open it under the row instead.
    const fromKeyboard = ev.clientX === 0 && ev.clientY === 0;
    const row = ev.currentTarget.getBoundingClientRect();
    setContext({
      name: e.name,
      items: menuFor(e),
      x: fromKeyboard ? row.left + 48 : ev.clientX,
      y: fromKeyboard ? row.bottom : ev.clientY,
      flipAt: fromKeyboard ? row.top : undefined,
      fromKeyboard,
    });
  };

  const sorted = useMemo(() => {
    const dir = sort.desc ? -1 : 1;
    return [...entries].sort((a, b) => {
      // Folders first, whatever the column.
      const folders = Number(isFolderLike(b)) - Number(isFolderLike(a));
      if (folders !== 0) return folders;
      if (sort.key === 'size') return (a.size - b.size) * dir || byName.compare(a.name, b.name);
      if (sort.key === 'mtime') return (a.mtimeMs - b.mtimeMs) * dir || byName.compare(a.name, b.name);
      return byName.compare(a.name, b.name) * dir;
    });
  }, [entries, sort]);

  const rows = showAll ? sorted : sorted.slice(0, FIRST_ROWS);
  const selectable = entries.filter((e) => e.nameOk);
  const allSelected = selectable.length > 0 && selectable.every((e) => selected.has(e.name));

  const header = (key: SortKey, label: string, className = '') => (
    <th className={`pb-2 font-medium ${className}`}>
      <button
        type="button"
        className="uppercase hover:text-neutral-700"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}
      >
        {label}
        {sort.key === key && <span aria-hidden> {sort.desc ? '↓' : '↑'}</span>}
      </button>
    </th>
  );

  if (entries.length === 0 && parent === null) return <EmptyState>{emptyText}</EmptyState>;

  return (
    <div className="overflow-x-auto px-4 pb-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs tracking-wide text-neutral-400">
            <th className="w-8 pb-2 pt-3">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSelected}
                onChange={() => onSelect(allSelected ? new Set() : new Set(selectable.map((e) => e.name)))}
              />
            </th>
            {header('name', 'Name', 'pt-3')}
            {header('size', 'Size', 'pt-3 text-right')}
            {header('mtime', 'Modified', 'pt-3 pl-6')}
            <th className="pb-2 pt-3 font-medium uppercase">Permissions</th>
            <th className="pb-2 pt-3 font-medium uppercase">Owner</th>
            <th className="w-10 pb-2 pt-3" />
          </tr>
        </thead>
        <tbody>
          {parent !== null && (
            <tr className="border-t border-neutral-100">
              <td />
              <td colSpan={6} className="py-1.5">
                <button type="button" onClick={onUp} className="flex items-center gap-2 text-neutral-600 hover:underline">
                  <Icon name="up" size={15} /> ..
                </button>
              </td>
            </tr>
          )}
          {rows.map((e) => {
            const folder = isFolderLike(e);
            const temp = isTemporary(e);
            return (
              <tr
                key={e.name}
                onContextMenu={(ev) => openContext(e, ev)}
                className={`group border-t border-neutral-100 hover:bg-neutral-50 ${temp ? 'opacity-60' : ''} ${
                  context?.name === e.name ? 'bg-neutral-100' : ''
                }`}
              >
                <td className="py-1.5">
                  <input
                    type="checkbox"
                    aria-label={`Select ${e.name}`}
                    disabled={!e.nameOk}
                    checked={selected.has(e.name)}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(e.name)) next.delete(e.name);
                      else next.add(e.name);
                      onSelect(next);
                    }}
                  />
                </td>
                <td className="max-w-md py-1.5 pr-3">
                  <button
                    type="button"
                    disabled={!e.nameOk}
                    title={
                      e.nameOk ? undefined : 'This name is not valid UTF-8, so the panel cannot address it. Rename it from a shell.'
                    }
                    onClick={() => onOpen(e)}
                    className="flex max-w-full items-center gap-2 text-left disabled:cursor-not-allowed"
                  >
                    <span className={folder ? 'text-[var(--accent)]' : 'text-neutral-400'}>
                      <Icon name={entryIcon(e)} size={16} />
                    </span>
                    <span className={`truncate ${folder ? 'font-medium text-neutral-900' : 'text-neutral-800'} group-hover:underline`}>
                      <bdi>{e.name}</bdi>
                    </span>
                    {e.type === 'link' && (
                      <span className="truncate text-xs text-neutral-400" title={`Symlink to ${e.target}`}>
                        → <bdi>{e.target}</bdi>
                        {e.targetType === null && ' (missing)'}
                      </span>
                    )}
                    {temp && <span className="text-xs text-neutral-400">(temporary)</span>}
                    {!e.writable && !temp && (
                      <span className="text-amber-600" title="The site's user cannot write this">
                        <Icon name="lock" size={13} />
                      </span>
                    )}
                  </button>
                </td>
                <td className="whitespace-nowrap py-1.5 text-right text-neutral-600">
                  {e.type === 'dir' ? '' : e.type === 'link' ? '' : formatBytes(e.size)}
                </td>
                <td className="whitespace-nowrap py-1.5 pl-6 text-neutral-600" title={formatDate(e.mtimeMs)}>
                  {modified(e.mtimeMs)}
                </td>
                <td className="whitespace-nowrap py-1.5 font-mono text-xs text-neutral-600" title={permissionString(e.mode)}>
                  {e.type === 'link' ? '' : e.mode}
                </td>
                <td className={`whitespace-nowrap py-1.5 text-xs ${e.uid === 33 ? 'text-neutral-600' : 'text-amber-700'}`}>
                  {ownerName(e.uid)}
                </td>
                <td className="py-1 text-right">{e.nameOk && <RowMenu label={`Actions for ${e.name}`} items={menuFor(e)} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {entries.length === 0 && <EmptyState>{emptyText}</EmptyState>}
      {context && (
        <ContextMenu
          items={context.items}
          label={`Actions for ${context.name}`}
          x={context.x}
          y={context.y}
          flipAt={context.flipAt}
          focusFirst={context.fromKeyboard}
          onClose={() => setContext(null)}
        />
      )}
      {!showAll && sorted.length > FIRST_ROWS && (
        <div className="py-3 text-center">
          <button type="button" className="text-sm underline" onClick={() => setShowAll(true)}>
            Show all {sorted.length} entries
          </button>
        </div>
      )}
    </div>
  );
}
