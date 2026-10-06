// @docs panel/updating
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { UpdateStatusDto } from '../../../shared/types';

/**
 * Watch an update through the moment the panel serving this page stops existing.
 *
 * Between `switching` and the new container answering, every request fails - not with an
 * error the API produced, but with no answer at all. That gap is the update working, so a
 * failed poll is a state to render ("Restarting…"), never a reason to stop. What comes back
 * afterwards is either the new panel or, after a rollback, the old one reading `failed` out
 * of the same file; both are shown by the same code, because from here they are the same
 * thing: the update finished, and here is what happened.
 */
const POLL_MS = 2000;

const PHASE_LABEL: Record<string, string> = {
  fetching: 'Pulling images',
  preflight: 'Checking this server',
  switching: 'Replacing the panel',
  healthcheck: 'Waiting for the new panel',
  switched: 'Done',
  failed: 'Failed',
};

export function UpdateProgress({ onFinished }: { onFinished?: () => void }) {
  const [status, setStatus] = useState<UpdateStatusDto | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const finished = useRef(false);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const next = await api<UpdateStatusDto>('/api/system/update/status');
        if (stopped) return;
        setStatus(next);
        setUnreachable(false);
        const phase = next.state?.phase;
        if (!next.running && (phase === 'switched' || phase === 'failed') && !finished.current) {
          finished.current = true;
          onFinished?.();
        }
      } catch {
        // The panel is being recreated. Expected, and the only honest thing to show.
        if (!stopped) setUnreachable(true);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [onFinished]);

  const state = status?.state ?? null;
  const phase = state?.phase;
  const done = phase === 'switched';
  const failed = phase === 'failed';

  return (
    <div
      className={`rounded-lg border px-4 py-3 text-sm ${
        failed
          ? 'border-red-200 bg-red-50 text-red-900'
          : done
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-blue-200 bg-blue-50 text-blue-900'
      }`}
    >
      <div className="font-medium">
        {unreachable && !done && !failed
          ? 'Restarting… the panel is being replaced'
          : state
            ? `${PHASE_LABEL[state.phase] ?? state.phase} · ${state.from || 'unknown'} → ${state.to}`
            : 'Starting…'}
      </div>

      {state?.warnings?.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {state.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      {failed && (
        <div className="mt-2 space-y-1">
          <div>{state?.error ?? 'The update did not finish.'}</div>
          <div>
            {state?.rolledBack
              ? 'Rolled back: this panel is the previous version, and its database was restored from the snapshot taken before the migrations ran.'
              : 'It was NOT rolled back. Check the server before doing anything else.'}
          </div>
        </div>
      )}

      {done && (
        <div className="mt-2">
          Now on {state?.to}. Reload the page to see it.{' '}
          <button className="font-medium underline" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}

      {(status?.log?.length ?? 0) > 0 && (
        <details className="mt-3" open={failed}>
          <summary className="cursor-pointer select-none font-medium">
            {failed ? 'What it printed' : 'Log'}
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded bg-white/60 p-3 text-xs leading-relaxed">
            {status!.log.join('\n')}
          </pre>
        </details>
      )}

      {failed && (state?.logTail?.length ?? 0) > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none font-medium">Panel container log</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded bg-white/60 p-3 text-xs leading-relaxed">
            {state!.logTail.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}
