// @docs sites/php-updates
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { phpDay, severityCounts } from '../../../shared/php';
import type { PhpBranchDto, PhpUpdatesDto } from '../../../shared/types';
import { useMeta, usePhpUpdates, useRunJob } from '../api/hooks';
import { PHP_TONES, phpChangelogUrl, phpImageState, phpSiteState, phpSummary, type PhpTone } from '../lib/php';
import { Button, ErrorNote, Modal, OutLink } from './ui';

/** Opens the details of a PHP branch: the Overview's `?php=8.4`. */
export function usePhpDetails(): (branch: string) => void {
  const [, setParams] = useSearchParams();
  return (branch) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('php', branch);
      return next;
    });
}

/**
 * What is happening with a PHP branch's newest release, what comes next, and what can be done:
 * each server's image, each site still on an older release, and what the release fixes. Opened
 * from the Overview's PHP card, and by `?php=8.4` on the Overview.
 */
export function PhpDetails() {
  const [params, setParams] = useSearchParams();
  const branch = params.get('php');
  const php = usePhpUpdates();
  if (!branch) return null;
  const close = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('php');
        return next;
      },
      { replace: true },
    );
  const b = php.data?.branches.find((x) => x.branch === branch);
  return (
    <Modal sheet title={`PHP ${branch}`} onClose={close}>
      <ErrorNote error={php.error} />
      {php.isPending ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : b?.latest && php.data ? (
        <Details b={b} data={php.data} />
      ) : (
        <p className="text-sm text-neutral-500">php.net lists no release of PHP {branch}.</p>
      )}
    </Modal>
  );
}

function Details({ b, data }: { b: PhpBranchDto; data: PhpUpdatesDto }) {
  const latest = b.latest!;
  const meta = useMeta();
  const qc = useQueryClient();
  const run = useRunJob([['php'], ['sites']]);
  const multiServer = meta.data?.multiServer ?? false;
  const summary = phpSummary(b, data);
  const badge = latest.security ? ['Security', severityCounts(latest.advisories)].filter(Boolean).join(' · ') : null;
  const serverName = (id: number) => meta.data?.servers.find((s) => s.id === id)?.name ?? `server ${id}`;
  const errorOf = (serverId: number) => data.serverErrors.find((e) => e.serverId === serverId)?.error ?? null;
  const retry = (slug: string) =>
    run.mutate({ path: `/api/sites/${slug}/reconcile`, action: slug }, { onSuccess: () => void qc.invalidateQueries({ queryKey: ['php'] }) });

  return (
    <div className="space-y-6 text-sm">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold">PHP {latest.version}</span>
          {badge && <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">{badge}</span>}
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          Released {phpDay(Date.parse(`${latest.date}T00:00:00Z`))} · <OutLink href={phpChangelogUrl(latest.version)}>Release notes</OutLink>
        </p>
        <p className="mt-3">{summary.text}</p>
        {summary.update && (
          <Link className="button-primary mt-3 inline-flex rounded-lg px-3.5 py-2 text-sm font-medium" to="/settings#updates">
            Go to Updates
          </Link>
        )}
        {b.next && (
          <p className="mt-3 text-xs text-neutral-500">
            Next: {b.next.release}, expected {phpDay(Date.parse(`${b.next.expected}T00:00:00Z`))}
          </p>
        )}
      </div>

      {b.images.length > 0 && (
        <section>
          <h4 className="mb-2 font-medium">Servers</h4>
          <table className="w-full">
            <tbody>
              {b.images.map((image) => {
                const state = phpImageState(image, latest.version, data);
                const error = errorOf(image.serverId);
                return (
                  <tr key={image.serverId} className="border-b border-neutral-100 align-top last:border-0">
                    <td className="py-2 pr-3 font-medium sm:w-56">{image.serverName}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-neutral-500 sm:w-24">{image.release ?? 'unknown'}</td>
                    <td className="py-2">
                      <State tone={state.tone} text={state.text} jobId={state.tone === 'done' ? null : (image.refresh?.id ?? null)} />
                      {error && <p className="mt-1 text-xs text-red-700">Could not be checked: {error}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {b.behindCount > 0 && (
        <section>
          <h4 className="mb-2 font-medium">
            Sites on an older PHP <span className="font-normal text-neutral-500">· {b.behindCount} of {b.sites}</span>
          </h4>
          <ErrorNote error={run.error} />
          <table className="w-full">
            <tbody>
              {b.behind.map((site) => {
                const state = phpSiteState(site, b);
                return (
                  <tr key={site.slug} className="border-b border-neutral-100 align-top last:border-0">
                    <td className="py-2 pr-3 sm:w-56">
                      <Link className="font-medium hover:underline" to={`/sites/${site.slug}`}>
                        {site.title}
                      </Link>
                      {multiServer && <div className="text-xs text-neutral-500">{serverName(site.serverId)}</div>}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-neutral-500 sm:w-24">{site.release ?? 'unknown'}</td>
                    <td className="py-2 pr-3">
                      <State tone={state.tone} text={state.text} jobId={site.move?.id ?? null} />
                    </td>
                    <td className="py-2 text-right">
                      {state.retry && (
                        <Button small variant="secondary" busy={run.busy(site.slug)} onClick={() => retry(site.slug)}>
                          Try again
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {b.behindCount > b.behind.length && <p className="mt-2 text-xs text-neutral-500">and {b.behindCount - b.behind.length} more</p>}
        </section>
      )}

      {latest.security && (
        <section>
          <h4 className="mb-2 font-medium">What it fixes</h4>
          {latest.advisories.length === 0 ? (
            <p className="text-neutral-500">GitHub has not published its advisories yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {latest.advisories.map((a) => (
                <li key={a.id} className="flex items-baseline gap-2">
                  <span className={`w-16 shrink-0 text-xs font-medium ${SEVERITY[a.severity] ?? 'text-neutral-500'}`}>{a.severity}</span>
                  <span>
                    <OutLink href={a.url}>{a.summary}</OutLink>
                    {a.cve && <span className="ml-1.5 text-xs text-neutral-500">{a.cve}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

const SEVERITY: Record<string, string> = {
  critical: 'text-red-700',
  high: 'text-orange-700',
  medium: 'text-amber-700',
  low: 'text-neutral-500',
};

function State({ tone, text, jobId }: { tone: PhpTone; text: string; jobId: number | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHP_TONES[tone]}`} />
      <span>{text}</span>
      {jobId !== null && (
        <Link className="text-xs text-neutral-500 hover:underline" to={`/jobs/${jobId}`}>
          Job #{jobId}
        </Link>
      )}
    </span>
  );
}
