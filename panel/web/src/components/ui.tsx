import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { JobStatus } from '../../../shared/schemas';
import type { HealthTone, SiteHealth } from '../lib/siteHealth';

export function Card({
  title,
  action,
  children,
  id,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  /** An anchor, for a link that should land on this card (/settings#backups). */
  id?: string;
}) {
  return (
    <div className="panel-card" id={id}>
      {(title || action) && (
        <div className="panel-card-header">
          <h2 className="panel-card-title">{title}</h2>
          {action}
        </div>
      )}
      <div className="panel-card-body">{children}</div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled,
  small,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  small?: boolean;
  /** Also what a disabled button says about why it is disabled. */
  title?: string;
}) {
  const base = small ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm';
  const styles = {
    primary: 'button-primary',
    secondary: 'bg-surface text-neutral-800 border border-neutral-300 hover:bg-neutral-50',
    danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300',
    ghost: 'text-neutral-600 hover:bg-neutral-100',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${styles} inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-emerald-100 text-emerald-800',
  succeeded: 'bg-emerald-100 text-emerald-800',
  active: 'bg-emerald-100 text-emerald-800',
  provisioning: 'bg-amber-100 text-amber-800',
  queued: 'bg-amber-100 text-amber-800',
  stopped: 'bg-neutral-200 text-neutral-700',
  canceled: 'bg-neutral-200 text-neutral-700',
  error: 'bg-red-100 text-red-800',
  failed: 'bg-red-100 text-red-800',
  deleting: 'bg-red-100 text-red-800',
  live: 'bg-sky-100 text-sky-800',
  dev: 'bg-violet-100 text-violet-800',
  move: 'bg-sky-100 text-sky-800',
  unreachable: 'bg-red-100 text-red-800',
  ok: 'bg-emerald-100 text-emerald-800',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_COLORS[status] ?? 'bg-neutral-200 text-neutral-700'}`}
    >
      {status}
    </span>
  );
}

const JOB_TONES: Record<JobStatus, string> = {
  queued: 'bg-amber-100 text-amber-800',
  running: 'bg-sky-100 text-sky-800',
  succeeded: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  canceled: 'bg-neutral-200 text-neutral-700',
};

/**
 * A job's status. Its own badge rather than StatusBadge, which sites share: a running site is
 * the healthy green one, while a running job is work under way - blue, with the pulsing dot
 * SiteHealthBadge uses for "busy". `stopping` = a cancel was asked for and the job has not
 * reached a safe point to stop at yet.
 */
export function JobStatusBadge({ status, stopping = false }: { status: JobStatus; stopping?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${JOB_TONES[status] ?? 'bg-neutral-200 text-neutral-700'}`}
      >
        {status === 'running' && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" />}
        {status}
      </span>
      {stopping && status === 'running' && <span className="text-[11px] text-neutral-500">stopping…</span>}
    </span>
  );
}

/**
 * A row of mutually exclusive choices - a filter's scope, a form's mode - where a select
 * would hide the options that are the point of showing it.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  small = false,
  label,
}: {
  options: readonly { id: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (id: T) => void;
  small?: boolean;
  /** What the group chooses, for screen readers. */
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={`rounded-lg font-medium transition-colors ${small ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'} ${
            value === option.id ? 'button-primary' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Reachability of one thing the panel talks to: a server, a mail relay. Sites use SiteHealthBadge. */
export function UpDot({ up }: { up: boolean | null }) {
  const color = up === null ? 'bg-neutral-300' : up ? 'bg-emerald-500' : 'bg-red-500';
  const label = up === null ? 'unknown' : up ? 'up' : 'down';
  return <span title={label} className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

const HEALTH_TONES: Record<HealthTone, string> = {
  ok: 'bg-emerald-100 text-emerald-800',
  busy: 'bg-amber-100 text-amber-800',
  idle: 'bg-neutral-200 text-neutral-700',
  bad: 'bg-red-100 text-red-800',
  unknown: 'bg-neutral-100 text-neutral-500',
};

/**
 * The single answer to "is this site serving?" - dot and word in one badge, so there is
 * no second indicator left to disagree with it. The dot is `currentColor`, which is how
 * it keeps working against the dark theme's own emerald/red/amber ramps.
 */
export function SiteHealthBadge({ health }: { health: SiteHealth }) {
  return (
    <span
      title={[health.detail, health.fix].filter(Boolean).join(' ')}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${HEALTH_TONES[health.tone]}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${health.tone === 'busy' ? 'animate-pulse' : ''}`} />
      {health.label}
    </span>
  );
}

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="panel-card stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/**
 * How wide the control may get. Almost nothing a panel asks for is long, and a full-width
 * box for a port or a username reads as a bug - so the default is capped and the few fields
 * that really do hold a path, a domain list or a key opt out.
 */
const FIELD_WIDTHS = {
  sm: 'max-w-56',
  md: 'max-w-sm',
  lg: 'max-w-xl',
  full: '',
} as const;

export function Field({
  label,
  children,
  hint,
  width = 'md',
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  width?: keyof typeof FIELD_WIDTHS;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span>
      <div className={`field-control ${FIELD_WIDTHS[width]}`}>{children}</div>
      {hint && <span className="measure mt-1 block text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-neutral-300 bg-surface px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none';

/** The same look without the full width, for a number or a choice inside a sentence. */
export const compactInputClass =
  'rounded-lg border border-neutral-300 bg-surface px-2.5 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none';

/**
 * `busy` = this switch is waiting on the server. It shows its own spinner and refuses
 * further clicks, so a toggle that costs a round trip never has to report progress
 * somewhere else on the page.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  busy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled || busy}
      className="flex items-start gap-2 text-left text-sm text-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-neutral-300'}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`}
        />
      </span>
      {label}
      {busy && <Spinner />}
    </button>
  );
}

/** Open dialogs, innermost last: Escape closes the one on top, not every one under it. */
const openModals: object[] = [];

export function Modal({
  title,
  onClose,
  children,
  wide = false,
  dismissible = true,
  sheet = false,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** For a dialog that holds a document (a pasted recipe) rather than a few fields. */
  wide?: boolean;
  /**
   * false = a click beside the dialog and Escape leave it open, for a form holding work that
   * a stray click would throw away. The close button and Cancel still close it.
   */
  dismissible?: boolean;
  /**
   * A panel the full height of the window, on its right, for a form longer than a dialog
   * holds - a site's whole protection - with the page it belongs to still in view beside it.
   */
  sheet?: boolean;
  /** Under the content, and in a sheet always in view: the buttons of a long form. */
  footer?: ReactNode;
}) {
  const latest = useRef({ onClose, dismissible });
  latest.current = { onClose, dismissible };
  // Where the press started: a text selection dragged out of the dialog ends with a click
  // on the backdrop, and must not close it.
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const token = {};
    openModals.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openModals[openModals.length - 1] !== token || !latest.current.dismissible) return;
      latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openModals.splice(openModals.indexOf(token), 1);
    };
  }, []);
  const close = (
    <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-700">
      ✕
    </button>
  );
  return (
    <div
      className={`fixed inset-0 z-50 flex bg-black/40 ${sheet ? 'justify-end' : 'items-center justify-center p-4'}`}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (dismissible && pressedBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={
          sheet
            ? 'modal-panel modal-sheet flex h-full w-full max-w-4xl flex-col bg-surface shadow-xl'
            : `modal-panel max-h-[90vh] w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} overflow-y-auto rounded-xl bg-surface p-6 shadow-xl`
        }
        // A dialog opened from a clickable row is still that row's child in React's tree.
        onClick={(e) => e.stopPropagation()}
      >
        {sheet ? (
          <>
            <div className="flex items-center justify-between gap-4 border-b border-neutral-200 px-6 py-4">
              <h3 className="text-base font-semibold">{title}</h3>
              {close}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
            {footer && <div className="border-t border-neutral-200 px-6 py-3">{footer}</div>}
          </>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold">{title}</h3>
              {close}
            </div>
            {children}
            {footer && <div className="mt-5">{footer}</div>}
          </>
        )}
      </div>
    </div>
  );
}

/** Destructive confirmation; optionally requires typing the site name. */
export function ConfirmDialog({
  title,
  message,
  confirmWord,
  confirmLabel = 'Confirm',
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  message: ReactNode;
  confirmWord?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const armed = !confirmWord || typed === confirmWord;
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4 text-sm text-neutral-700">
        <div>{message}</div>
        {children}
        {confirmWord && (
          <Field label={`Type "${confirmWord}" to confirm`}>
            <input className={inputClass} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!armed}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * A value to copy. `secret` is the loud one, for something shown once and never again;
 * `plain` is for a DNS record or a key that is public anyway, where amber reads as a
 * warning that is not there.
 */
export function CopyField({ value, tone = 'secret' }: { value: string; tone?: 'secret' | 'plain' }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border p-2 ${
        tone === 'secret' ? 'border-amber-300 bg-amber-50' : 'border-neutral-200 bg-neutral-50'
      }`}
    >
      <code className="flex-1 overflow-x-auto text-xs">{value}</code>
      <Button
        small
        variant="secondary"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </Button>
    </div>
  );
}

/**
 * The "this leaves the panel" glyph, for links that open a new tab. Inline rather than a
 * dependency; it inherits currentColor so it dims and highlights with the text it follows.
 */
export function ExternalLinkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block shrink-0 align-[-0.05em]"
      aria-hidden
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/**
 * A plain link that leaves the panel in a new tab. It takes its size and colour from the text
 * around it and only darkens on hover, so a row of them reads as quiet as the line it sits in.
 * The underline stays under the words: in a flex box it reaches the text but not the glyph.
 */
export function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="inline-flex items-center gap-1 underline decoration-neutral-300 underline-offset-2 transition-colors hover:text-neutral-900"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
      <ExternalLinkIcon />
    </a>
  );
}

/**
 * A link dressed as a button, for one that leaves the panel in a new tab. Both kinds carry a
 * border - transparent on the primary - so a pair of them stand the same height side by side.
 */
export function OutButton({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) {
  const tone = primary
    ? 'button-primary border-transparent'
    : 'border-neutral-300 bg-surface text-neutral-800 hover:bg-neutral-50';
  return (
    <a
      className={`${tone} inline-flex items-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-medium transition-colors`}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
      <ExternalLinkIcon />
    </a>
  );
}

/** Named pass/fail lines: server verification, mail records, a remote connection test. */
export function ChecksList({ checks }: { checks: { name: string; ok: boolean; detail: string }[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {checks.map((c) => (
        <li key={c.name} className="flex items-start gap-2">
          <span className={c.ok ? 'text-emerald-600' : 'text-red-600'}>{c.ok ? '✓' : '✗'}</span>
          <span>
            <span className="font-medium">{c.name}</span>
            <span className="ml-2 text-neutral-500">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="measure mx-auto py-8 text-center text-sm text-neutral-500">{children}</div>;
}

export function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800" />
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</div>;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-neutral-200">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            active === t.id
              ? 'border-neutral-900 text-neutral-900'
              : 'border-transparent text-neutral-500 hover:text-neutral-800'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
