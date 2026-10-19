// @docs get-started/first-site, sites/create, sites/overview
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { JobDto, JobLogLine, SiteDetail } from '../../../shared/types';
import { isTerminal, useJob } from '../api/hooks';
import { IMPORT_STATUS_LABEL, importPath } from '../lib/imports';
import { createJobFor, draftOf, markPasswordSeen, newestJob, passwordSeen } from '../lib/siteCreation';
import { JobLogViewer } from './JobProgress';
import { useJobSnapshots } from './jobConsole/context';
import { Button, Card, CopyField, ErrorNote, JobStatusBadge } from './ui';

/** A site's `site.create`, as its page shows it. */
export interface SiteCreation {
  /** null until it is known, and for a site whose create is neither running nor started here. */
  job: JobDto | null;
  logs: JobLogLine[];
  /** It is over, and the rest of its log is still being read. */
  draining: boolean;
  /** It could not be read. */
  error: unknown;
  /** This tab started it: only that tab is shown the admin password it generated. */
  startedHere: boolean;
}

/** Over without making the site. */
export const createFailed = (job: JobDto | null): boolean => job?.status === 'failed' || job?.status === 'canceled';

/**
 * The `site.create` a site's page shows: the one the site is busy with, else the one this page saw
 * or this tab started. Read with its log until it is over, and after it failed. One this tab started
 * that succeeded is not read again: its result, with the password, is in the console's snapshot.
 * When it ends while the page is open, the site is read again: running, left as Error, or gone.
 */
export function useSiteCreation(slug: string, site: SiteDetail | undefined): SiteCreation {
  const qc = useQueryClient();
  const snapshots = useJobSnapshots();
  const active = site?.activeJob?.type === 'site.create' ? site.activeJob.id : null;
  // Kept once seen: the page goes on showing how the create ended after it lets go of the site.
  const [seen, setSeen] = useState<{ slug: string; id: number } | null>(null);
  if (active !== null && (seen?.slug !== slug || seen.id !== active)) setSeen({ slug, id: active });
  const seenId = seen?.slug === slug ? seen.id : null;

  const started = createJobFor(
    [...snapshots.values()].map((s) => s.job),
    slug,
    site?.createdAt ?? null,
  );
  const id = newestJob(active, seenId, started?.id);
  const read = useJob(id !== null && (id !== started?.id || started.status !== 'succeeded') ? id : null, 'site');
  const job = read.job ?? (started?.id === id ? started : null);

  // Only an end seen here: a create that was over before the page opened left the site as it reads.
  const last = useRef<{ id: number; over: boolean } | null>(null);
  const jobId = job?.id ?? null;
  const over = isTerminal(job?.status);
  useEffect(() => {
    if (jobId === null) return;
    const before = last.current;
    last.current = { id: jobId, over };
    if (over && before?.id === jobId && !before.over) void qc.invalidateQueries({ queryKey: ['site', slug] });
  }, [jobId, over, slug, qc]);

  return {
    job,
    logs: read.logs,
    draining: read.draining,
    error: read.error,
    startedHere: started !== null && started.id === id,
  };
}

const LINK = 'text-xs text-neutral-500 hover:text-neutral-800 hover:underline';

/**
 * The create, while it runs and once it failed: its status and log. `left`, once known, is what
 * a failed create left: nothing (`gone`), so the form it was sent from is offered again, filled in
 * as it was; or a site it could not clean up (`kept`), which only Delete removes.
 */
export function SiteCreationCard({ creation, left }: { creation: SiteCreation; left?: 'gone' | 'kept' }) {
  const navigate = useNavigate();
  const { job } = creation;
  const failed = createFailed(job);
  const title = failed ? 'Creating the site failed' : job?.status === 'succeeded' ? 'Site created' : 'Creating the site';
  return (
    <Card
      title={title}
      action={
        job && (
          <Link to={`/jobs/${job.id}`} className={LINK}>
            Open job →
          </Link>
        )
      }
    >
      <div className="space-y-3 text-sm">
        {job ? (
          <div className="flex flex-wrap items-center gap-2">
            <JobStatusBadge status={job.status} stopping={job.cancelRequested} />
            {job.status === 'queued' && (
              <span className="text-neutral-500">Waiting to start – each server runs one job at a time.</span>
            )}
            {failed && job.error && <span className="text-red-700">{job.error}</span>}
          </div>
        ) : (
          !creation.error && <p className="text-neutral-500">Still being created.</p>
        )}
        <ErrorNote error={creation.error} />
        <JobLogViewer logs={creation.logs} />
        {creation.draining && <p className="text-xs text-neutral-500">Loading the rest of the log…</p>}
        {failed && left === 'gone' && job && (
          <Button variant="secondary" onClick={() => void navigate('/sites/new', { state: { draftOf: job.id } })}>
            {draftOf(job.id) ? 'Back to the form' : 'New site'}
          </Button>
        )}
        {failed && left === 'kept' && job?.siteSlug && (
          <p>
            Its clean-up failed too:{' '}
            <Link className="underline" to={`/sites/${job.siteSlug}?tab=settings`}>
              delete the site
            </Link>{' '}
            on its Settings tab.
          </p>
        )}
      </div>
    </Card>
  );
}

/** A site an import is making: how the import stands, which its own page shows in full. */
export function SiteImportingCard({ source }: { source: NonNullable<SiteDetail['importSource']> }) {
  return (
    <Card
      title="Importing the site"
      action={
        <Link to={importPath(source.importId)} className={LINK}>
          Open the import →
        </Link>
      }
    >
      <p className="text-sm text-neutral-600">{IMPORT_STATUS_LABEL[source.status]}.</p>
    </Card>
  );
}

/** The admin password a create generated, on its site's page in the tab that started it, until Done. */
export function SiteCreatedNote({ creation, adminUser }: { creation: SiteCreation; adminUser: string | null }) {
  const [done, setDone] = useState(false);
  const { job } = creation;
  const password = (job?.result as { adminPassword?: unknown } | null)?.adminPassword;
  if (!job || job.status !== 'succeeded' || !creation.startedHere || typeof password !== 'string') return null;
  if (done || passwordSeen(job.id)) return null;
  return (
    <Card title="Site created">
      <div className="space-y-2 text-sm">
        <p>WordPress admin password for “{adminUser ?? 'admin'}”:</p>
        <div className="flex max-w-xl items-center gap-2">
          <div className="min-w-0 flex-1">
            <CopyField value={password} />
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              markPasswordSeen(job.id);
              setDone(true);
            }}
          >
            Done
          </Button>
        </div>
      </div>
    </Card>
  );
}
