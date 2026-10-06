// @docs automations/jobs
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { JobDto } from '../../../shared/types';
import { Icon } from './Icon';

/**
 * Who or what queued a job: an admin (by name), an API key, an AI app over MCP, a schedule
 * (linked to it) or the panel itself. "Run now" on a schedule is the person who pressed it,
 * and names the schedule underneath.
 */
export function TriggeredBy({ job, scheduleName }: { job: JobDto; scheduleName: (id: number) => string | null }) {
  const via =
    job.scheduleId !== null && job.origin !== 'schedule' ? (
      <div className="text-[11px] text-neutral-400">
        ran{' '}
        <Link className="hover:underline" to={`/jobs/schedules#schedule-${job.scheduleId}`}>
          {scheduleName(job.scheduleId) ?? `schedule #${job.scheduleId}`}
        </Link>
      </div>
    ) : null;
  const line = (icon: 'user' | 'key' | 'clock' | 'system' | 'sparkles', body: ReactNode, title?: string) => (
    <span className="inline-flex max-w-56 items-center gap-1.5 text-xs text-neutral-600" title={title}>
      <span className="shrink-0 text-neutral-400">
        <Icon name={icon} size={13} />
      </span>
      <span className="truncate">{body}</span>
    </span>
  );
  switch (job.origin) {
    case 'user':
      return (
        <div>
          {line('user', job.createdBy ?? 'Someone', 'Started in the panel')}
          {via}
        </div>
      );
    case 'api':
      return (
        <div>
          {line('key', job.createdBy ?? 'An API key', 'Started through the API')}
          {via}
        </div>
      );
    case 'mcp':
      return (
        <div>
          {line('sparkles', job.createdBy ?? 'An AI app', 'Started by an AI app over MCP')}
          {via}
        </div>
      );
    case 'schedule':
      return line(
        'clock',
        job.scheduleId !== null ? (
          <Link className="hover:underline" to={`/jobs/schedules#schedule-${job.scheduleId}`}>
            {scheduleName(job.scheduleId) ?? job.createdBy ?? `Schedule #${job.scheduleId}`}
          </Link>
        ) : (
          (job.createdBy ?? 'A schedule')
        ),
        'Queued by a schedule',
      );
    case 'system':
      return line('system', 'Panel', 'Queued by the panel itself');
    default:
      return <span className="text-neutral-300">–</span>;
  }
}
