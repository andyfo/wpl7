// @docs sites/database
import type { DbCell, DbValueKind } from '../../../../shared/types';
import { formatBytes } from '../../lib/format';

/** A cell's text, as far as there is one: null for NULL and for bytes that are not text. */
export function cellText(cell: DbCell): string | null {
  if (cell === null) return null;
  if (typeof cell === 'string') return cell;
  return 'cut' in cell ? cell.cut : null;
}

export const isCut = (cell: DbCell): cell is { cut: string; length: number } =>
  typeof cell === 'object' && cell !== null && 'cut' in cell;

export const isBinary = (cell: DbCell): cell is { binary: number; hex: string } =>
  typeof cell === 'object' && cell !== null && 'binary' in cell;

/**
 * One value in a grid, on one line: NULL set apart from an empty string, bytes described, a line
 * break shown as ↵, long text ended with an ellipsis. Text only: nothing a database holds is ever
 * rendered as HTML here.
 */
export function CellView({ cell, kind }: { cell: DbCell; kind: DbValueKind }) {
  if (cell === null) return <span className="italic text-neutral-400">NULL</span>;
  if (isBinary(cell)) {
    return (
      <span className="text-neutral-500" title={cell.hex ? `0x${cell.hex}${cell.binary > cell.hex.length / 2 ? '…' : ''}` : undefined}>
        binary · {formatBytes(cell.binary)}
      </span>
    );
  }
  const text = cellText(cell) ?? '';
  if (text === '') return <span className="text-neutral-300">empty</span>;
  const shown = text.length > 200 ? text.slice(0, 200) : text;
  return (
    <span className={kind === 'number' ? 'tabular-nums' : undefined}>
      {shown.replace(/\r?\n/g, ' ↵ ')}
      {(isCut(cell) || text.length > 200) && <span className="text-neutral-400">…</span>}
    </span>
  );
}
