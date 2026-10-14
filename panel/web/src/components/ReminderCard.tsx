// @docs automations/reminders
import { Link } from 'react-router';
import { isFlagged } from '../../../shared/reminders';
import { useReminders } from '../api/reminders';
import { Card, ErrorNote } from './ui';

export function ReminderCard({ siteId, serverId }: { siteId?: number; serverId?: number }) {
  const query = useReminders(siteId, serverId);
  const items = (query.data ?? []).filter((r) => (siteId || serverId ? r.state !== 'done' : isFlagged(r)));
  if (!items.length && !query.error) return null;
  return (
    <Card
      title="Reminders"
      action={
        <Link className="text-sm hover:underline" to="/reminders">
          View all
        </Link>
      }
    >
      <ErrorNote error={query.error} />
      <ul className="space-y-2">
        {items.slice(0, 6).map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-4 text-sm">
            <Link to={`/reminders?reminder=${r.id}`} className="hover:underline">
              {r.title}
            </Link>
            <span
              className={
                r.state === 'overdue' || r.state === 'due' ? 'text-red-600' : r.state === 'warning' ? 'text-amber-600' : 'text-neutral-500'
              }
            >
              {r.dueDate}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
