// @docs automations/jobs
import { useEffect, useRef, useState, type RefObject } from 'react';
import { chipSummary, chipText, outcomeOf } from '../../lib/jobConsole';
import { Icon } from '../Icon';
import { useConsoleControls, useJobSnapshots } from './context';

/**
 * The job console minimized: a pill in the header, before the version, saying whether the jobs
 * it follows still run, and whether any failed. A click opens the console with its log. The
 * header scrolls away with the page, so while it is out of view the pill is pinned to the
 * window's top right corner instead - otherwise a job started far down a long page would show
 * nowhere at all.
 */
export function JobConsoleChip({ headerRef }: { headerRef: RefObject<HTMLElement | null> }) {
  const { state, dispatch, focusNext } = useConsoleControls();
  const snapshots = useJobSnapshots();
  const button = useRef<HTMLButtonElement>(null);
  const shown = state.session.view === 'chip' && state.session.jobs.length > 0;

  // The pill sits in the middle of the header: once less than about its lower 50 px shows, the
  // pill would be cut off at the top of the window.
  const [headerInView, setHeaderInView] = useState(true);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const watch = new IntersectionObserver(([entry]) => setHeaderInView(entry?.isIntersecting ?? true), {
      rootMargin: '-50px 0px 0px 0px',
    });
    watch.observe(header);
    return () => watch.disconnect();
  }, [headerRef]);

  // Minimized with its button: focus follows.
  useEffect(() => {
    if (!shown || focusNext.current !== 'chip') return;
    focusNext.current = null;
    button.current?.focus();
  });

  if (!shown) return null;
  const summary = chipSummary(
    state.session.jobs.map((id) => {
      const s = snapshots.get(id);
      return outcomeOf(s?.job.status ?? null, s?.lost);
    }),
  );
  const { label, title } = chipText(summary);
  return (
    <button
      ref={button}
      type="button"
      className={`job-chip job-chip-${summary.tone} ${headerInView ? '' : 'job-chip-pinned'}`}
      title={title}
      aria-label={title}
      onClick={() => {
        focusNext.current = 'console';
        dispatch({ type: 'open' });
      }}
    >
      {summary.tone === 'running' ? (
        <span className="job-console-spinner" aria-hidden="true" />
      ) : (
        <Icon name={summary.tone === 'failed' ? 'close' : 'check'} size={14} />
      )}
      <span className="job-chip-label">{label}</span>
    </button>
  );
}
