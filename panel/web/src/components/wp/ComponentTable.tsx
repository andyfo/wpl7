// @docs plugins/overview, sites/wordpress
import type { WpComponentDto } from '../../../../shared/types';
import { Button, EmptyState, StatusBadge } from '../ui';
import { CoverageNote, SeverityBadge } from './severity';

export interface ComponentTableProps {
  items: WpComponentDto[];
  /** Disables every button while a job for this site is in flight. */
  busy?: boolean;
  onUpdate: (item: WpComponentDto) => void;
  onActivate: (item: WpComponentDto) => void;
  onDeactivate: (item: WpComponentDto) => void;
  onDelete: (item: WpComponentDto) => void;
  empty: string;
}

/**
 * One installed plugin or theme per row, with the actions it will actually accept.
 *
 * Deliberately only a severity *badge* per row, not the advisories themselves: the Security
 * card above this table is where they are spelled out and acted on, and repeating them here
 * turned a list you scan into a wall you read. Actions a component cannot accept are simply
 * absent, with the reason under the name — the server enforces the same rules either way
 * (services/wpInventory.ts).
 */
export function ComponentTable({
  items,
  busy,
  onUpdate,
  onActivate,
  onDeactivate,
  onDelete,
  empty,
}: ComponentTableProps) {
  if (items.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <table className="w-full text-sm">
      <tbody>
        {items.map((item) => {
          const unmanageable = !Object.values(item.actionable).some(Boolean);
          return (
            <tr key={`${item.kind}:${item.slug}`} className="border-t border-neutral-100 align-top">
              <td className={`py-2 pr-3 ${unmanageable ? 'text-neutral-400' : ''}`}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{item.title}</span>
                  <span className="font-mono text-xs text-neutral-400">{item.slug}</span>
                  {item.worstSeverity && (
                    <SeverityBadge
                      severity={item.worstSeverity}
                      title={`${item.vulnerabilities.length} known vulnerability/ies affect version ${item.version}`}
                    />
                  )}
                  {item.closedOnWporg && (
                    <span
                      title={`Closed on wordpress.org${item.closedReason ? ` (${item.closedReason.replace(/-/g, ' ')})` : ''} — it will never receive another update.`}
                      className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-red-800"
                    >
                      closed
                    </span>
                  )}
                  <CoverageNote coverage={item.feedCoverage} />
                </div>
                {unmanageable && item.blockedReason && (
                  <div className="mt-1 text-xs text-neutral-400">{item.blockedReason}</div>
                )}
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">
                <StatusBadge status={item.status} />
              </td>
              <td className="py-2 pr-3 whitespace-nowrap text-neutral-500">
                {item.version || '–'}
                {item.updateVersion && item.updateState === 'available' && (
                  <span className="ml-1 font-medium text-amber-600">→ {item.updateVersion}</span>
                )}
                {item.updateState === 'higher' && (
                  <span
                    className="ml-1 text-xs text-neutral-400"
                    title="The installed version is newer than the one wordpress.org offers, so there is nothing to update to."
                  >
                    (ahead)
                  </span>
                )}
                {item.autoUpdate && (
                  <div className="text-[11px] text-neutral-400" title="WordPress updates this one by itself.">
                    auto-updates
                  </div>
                )}
              </td>
              <td className="py-2 text-right">
                {/* Nothing at all for a row the platform owns (mu-plugins, drop-ins): a
                    disabled ghost button looks identical to an enabled one, and the reason
                    is already spelled out under the name. */}
                {!unmanageable && (
                  <div className="flex justify-end gap-1.5">
                    {item.actionable.update && (
                      <Button small variant="secondary" disabled={busy} onClick={() => onUpdate(item)}>
                        Update
                      </Button>
                    )}
                    {item.kind === 'plugin'
                      ? (item.actionable.activate || item.actionable.deactivate) && (
                          <Button
                            small
                            variant="ghost"
                            disabled={busy}
                            onClick={() => (item.actionable.deactivate ? onDeactivate(item) : onActivate(item))}
                          >
                            {item.actionable.deactivate ? 'Deactivate' : 'Activate'}
                          </Button>
                        )
                      : item.actionable.activate && (
                          <Button small variant="ghost" disabled={busy} onClick={() => onActivate(item)}>
                            Activate
                          </Button>
                        )}
                    {item.actionable.delete && (
                      <Button small variant="ghost" disabled={busy} onClick={() => onDelete(item)}>
                        Delete
                      </Button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
