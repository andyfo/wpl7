// @docs sites/files
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { SiteFileEntryDto } from '../../../../shared/types';
import { RESERVED_FILE_PREFIX } from '../../../../shared/siteFilePath';
import { imageTypeFor, isZip } from '../../lib/fileKinds';
import { Button, ErrorNote, Modal } from '../ui';
import { Icon, type IconName } from '../Icon';

/** `755` -> `rwxr-xr-x`; the special bits of a four-digit mode are left to the digits. */
export function permissionString(mode: string): string {
  const digits = mode.slice(-3);
  return [...digits]
    .map((d) => {
      const n = Number(d);
      return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
    })
    .join('');
}

/** Every site's files belong to www-data (33); root (0) is what the panel or a shell left behind. */
export function ownerName(uid: number): string {
  if (uid === 33) return 'www-data';
  if (uid === 0) return 'root';
  return String(uid);
}

export const isFolderLike = (e: SiteFileEntryDto): boolean =>
  e.type === 'dir' || (e.type === 'link' && e.targetType === 'dir');

export const isTemporary = (e: SiteFileEntryDto): boolean => e.name.startsWith(RESERVED_FILE_PREFIX);

export function entryIcon(e: SiteFileEntryDto): IconName {
  if (isFolderLike(e)) return 'folder';
  if (e.type === 'link' && e.targetType === null) return 'link';
  if (imageTypeFor(e.name)) return 'image';
  if (isZip(e.name)) return 'archive';
  return 'file';
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

const MENU_CLASS = 'min-w-44 overflow-hidden rounded-lg border border-neutral-200 bg-surface py-1 shadow-lg';

/**
 * Close an open menu on a press outside it, on Escape, and on Back or Forward, which change
 * the folder under it. A menu at the pointer also closes when the page moves beneath it.
 */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void, atPointer = false) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    const onAway = () => closeRef.current();
    const moves = atPointer ? (['resize', 'blur'] as const) : [];
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onAway);
    for (const type of moves) window.addEventListener(type, onAway);
    if (atPointer) document.addEventListener('scroll', onAway, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onAway);
      for (const type of moves) window.removeEventListener(type, onAway);
      if (atPointer) document.removeEventListener('scroll', onAway, true);
    };
  }, [ref, open, atPointer]);
}

/** The entries of a menu. `onPick` closes it before the item acts. */
function MenuItems({ items, onPick }: { items: MenuItem[]; onPick: () => void }) {
  return items.map((item) => (
    <button
      key={item.label}
      type="button"
      role="menuitem"
      disabled={item.disabled}
      title={item.title}
      onClick={(e) => {
        e.stopPropagation();
        onPick();
        item.onSelect();
      }}
      className={`block w-full px-3 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
        item.danger ? 'text-red-600 hover:bg-red-50' : 'text-neutral-700 hover:bg-neutral-100'
      }`}
    >
      {item.label}
    </button>
  ));
}

/** A row's "…" menu. Closes on a pick, a click elsewhere, Escape, or Back. */
export function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div role="menu" className={`absolute right-0 z-30 mt-1 ${MENU_CLASS}`}>
          <MenuItems items={items} onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/**
 * The same menu where the pointer is (a right-click), with the corner at the click. Near the
 * window's right or bottom edge it opens to the left or upwards instead, as a desktop's does:
 * upwards from `flipAt` when given (a row's top, so a menu opened under it from the keyboard
 * does not cover it), from the click otherwise. `focusFirst` is for the keyboard too.
 */
export function ContextMenu({
  items,
  label,
  x,
  y,
  flipAt,
  focusFirst,
  onClose,
}: {
  items: MenuItem[];
  label: string;
  x: number;
  y: number;
  flipAt?: number;
  focusFirst?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const margin = 8;
    setAt({
      x: x + width > window.innerWidth - margin ? Math.max(margin, x - width) : x,
      y: y + height > window.innerHeight - margin ? Math.max(margin, (flipAt ?? y) - height) : y,
    });
    if (focusFirst) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y, flipAt, focusFirst]);
  useDismiss(ref, true, onClose, true);
  // In <body>: fixed positioning means the viewport only outside any transformed ancestor.
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: at.x, top: at.y }}
      className={`fixed z-50 ${MENU_CLASS}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems items={items} onPick={onClose} />
    </div>,
    document.body,
  );
}

/**
 * A dialog whose button runs one request: busy while it runs, the error inline when it
 * fails, closed when it succeeds.
 */
export function ActionDialog({
  title,
  submitLabel,
  danger,
  disabled,
  disabledReason,
  wide,
  dismissible,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submitLabel: string;
  danger?: boolean;
  disabled?: boolean;
  /** Why the button is disabled, on its title. */
  disabledReason?: string;
  wide?: boolean;
  dismissible?: boolean;
  onSubmit: () => Promise<unknown>;
  onClose: () => void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose} wide={wide} dismissible={dismissible}>
      <form
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || disabled) return;
          setBusy(true);
          setError(null);
          onSubmit()
            .then(onClose)
            .catch((err: unknown) => {
              setError(err);
              setBusy(false);
            });
        }}
      >
        {children}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={danger ? 'danger' : 'primary'}
            disabled={busy || disabled}
            title={disabled ? disabledReason : undefined}
          >
            {busy ? 'Working…' : submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
