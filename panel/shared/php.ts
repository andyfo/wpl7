// @docs sites/php-updates
/**
 * How PHP releases read, the same in the panel's emails and on its pages (services/phpUpdates.ts,
 * web/src/lib/php.ts).
 */

/** "2 critical, 1 high", most severe first; '' for none. */
export function severityCounts(advisories: { severity: string }[]): string {
  const order = ['critical', 'high', 'medium', 'low'];
  const rank = (severity: string) => (order.includes(severity) ? order.indexOf(severity) : order.length);
  const counts = new Map<string, number>();
  for (const a of advisories) counts.set(a.severity, (counts.get(a.severity) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([severity, n]) => `${n} ${severity}`)
    .join(', ');
}

/** "PHP 8.4.28", "PHP 8.4.28 and 8.5.13", "PHP 8.2.36, 8.3.37 and 8.4.28". */
export function phpVersions(versions: string[]): string {
  const all = [...versions];
  const last = all.pop() ?? '';
  return `PHP ${all.length > 0 ? `${all.join(', ')} and ${last}` : last}`;
}

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "Wed 21 Oct", in UTC: the day php.net names. */
export function phpDay(at: number): string {
  const part = (type: string) => DAY.formatToParts(at).find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
}

/** "Wed 21 Oct, 14:00 UTC", or the day alone when no time is known. */
export function phpWhen(at: number, time: boolean): string {
  return time ? `${phpDay(at)}, ${new Date(at).toISOString().slice(11, 16)} UTC` : phpDay(at);
}
