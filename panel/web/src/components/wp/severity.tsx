// @docs plugins/updates
import type { FeedCoverage, VulnSeverity } from '../../../../shared/types';

const SEVERITY_STYLES: Record<VulnSeverity, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-red-100 text-red-800',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-yellow-50 text-yellow-800',
  unknown: 'bg-neutral-200 text-neutral-700',
};

/**
 * The severity chip. `cvss` is shown next to the word rather than instead of it: the word
 * is what an operator triages on, the number is what they argue about.
 */
export function SeverityBadge({
  severity,
  cvss,
  title,
}: {
  severity: VulnSeverity;
  cvss?: number | null;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${SEVERITY_STYLES[severity]}`}
    >
      {severity === 'unknown' ? 'unrated' : severity}
      {cvss != null && <span className="font-mono normal-case opacity-80">{cvss.toFixed(1)}</span>}
    </span>
  );
}

/** The one-word state of the feed's knowledge about a component. */
export function CoverageNote({ coverage }: { coverage: FeedCoverage }) {
  const text: Record<FeedCoverage, string | null> = {
    // "Nothing known against it" is the normal, quiet case: no badge at all.
    known: null,
    unknown: 'no data',
    pending: 'not checked',
    stale: 'check overdue',
    error: 'check failed',
    off: null,
  };
  const hint: Record<FeedCoverage, string> = {
    known: '',
    unknown: 'wpvulnerability.net has no record of this slug — not the same as "no vulnerabilities".',
    pending: 'Not looked up yet; the next scan does it.',
    stale: 'The cached answer is older than a day and the refresh has not run yet.',
    error: 'The last lookup failed; this is the previous answer.',
    off: 'The vulnerability feed is switched off in Settings.',
  };
  const label = text[coverage];
  if (!label) return null;
  return (
    <span
      title={hint[coverage]}
      className="inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500"
    >
      {label}
    </span>
  );
}
