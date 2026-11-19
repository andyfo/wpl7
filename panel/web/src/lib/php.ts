// @docs sites/php-updates
import type { PhpBranchDto, PhpUpdatesDto } from '../../../shared/types';

/** 8.4.27 against 8.4.28, by their numbers. A site image's PHP is always X.Y.Z. */
export function compareRelease(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "Wed 21 Oct", in UTC: the day php.net names. */
export function phpDay(at: number): string {
  const part = (type: string) => DAY.formatToParts(at).find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
}

/** "Wed 21 Oct, 14:00 UTC", or the day alone. */
export function phpWhen(at: number, time: boolean): string {
  return time ? `${phpDay(at)}, ${new Date(at).toISOString().slice(11, 16)} UTC` : phpDay(at);
}

/** "2 critical, 1 high"; '' for none. */
export function severities(advisories: { severity: string }[]): string {
  const order = ['critical', 'high', 'medium', 'low'];
  const rank = (s: string) => (order.includes(s) ? order.indexOf(s) : order.length);
  const counts = new Map<string, number>();
  for (const a of advisories) counts.set(a.severity, (counts.get(a.severity) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');
}

export type PhpLine =
  | { kind: 'notice'; text: string; url: string }
  | {
      kind: 'release';
      branch: string;
      text: string;
      tone: 'waiting' | 'updating' | 'behind' | 'done';
      /** "Security · 2 critical", for a security release. */
      badge: string | null;
      /** The sites still behind, for `behind`. */
      sites: PhpBranchDto['behind'];
      more: number;
      /** The way to the new PHP is a WPL7 update. */
      update: boolean;
    }
  | { kind: 'next'; text: string };

/** How long before its expected day a coming release is shown. */
const SOON_MS = 7 * 24 * 3600_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "PHP 8.4.28", "PHP 8.4.28 and 8.5.13", "PHP 8.2.36, 8.3.37 and 8.4.28". */
function versions(list: string[]): string {
  const all = [...list];
  const last = all.pop()!;
  return `PHP ${all.length > 0 ? `${all.join(', ')} and ${last}` : last}`;
}

/** What the Overview's PHP card says: nothing at all when nothing is happening. */
export function phpLines(data: PhpUpdatesDto, now: number): PhpLine[] {
  const lines: PhpLine[] = [];
  if (data.notice) {
    const when = data.notice.scheduledAt !== null ? phpWhen(data.notice.scheduledAt, data.notice.scheduledTime) : null;
    lines.push({ kind: 'notice', text: when ? `PHP security release on ${when}` : 'A PHP security release is coming', url: data.notice.url });
  }
  for (const b of data.branches) {
    const latest = b.latest;
    if (!latest || b.sites === 0) continue;
    const badge = latest.security ? ['Security', severities(latest.advisories)].filter(Boolean).join(' · ') : null;
    const base = { kind: 'release' as const, branch: b.branch, badge, sites: [] as PhpBranchDto['behind'], more: 0, update: false };
    if (b.behindCount === 0) {
      if (b.doneRecently) lines.push({ ...base, tone: 'done', text: `All sites run PHP ${latest.version}`, badge: null });
      continue;
    }
    const has = (release: string | null) => release !== null && compareRelease(release, latest.version) >= 0;
    const some = b.images.some((i) => has(i.release));
    const all = b.images.length > 0 && b.images.every((i) => has(i.release));
    if (b.updating || (some && !all)) {
      lines.push({ ...base, tone: 'updating', text: `Updating sites to PHP ${latest.version}: ${b.current} of ${b.sites}` });
    } else if (!some) {
      lines.push(
        data.updateNeeded
          ? { ...base, tone: 'waiting', text: `PHP ${latest.version} is out. Update WPL7 to get it.`, update: true }
          : { ...base, tone: 'waiting', text: `PHP ${latest.version} is out. Waiting for its image.` },
      );
    } else {
      lines.push({
        ...base,
        tone: 'behind',
        text: `${b.behindCount} of ${plural(b.sites, 'site')} still on an older PHP than ${latest.version}`,
        sites: b.behind,
        more: b.behindCount - b.behind.length,
      });
    }
  }
  // Within a week either side of its expected day: one long overdue is not news any more.
  const coming = data.branches
    .filter((b) => b.sites > 0 && b.next && Math.abs(Date.parse(`${b.next.expected}T00:00:00Z`) - now) < SOON_MS)
    .map((b) => b.next!);
  if (coming.length > 0) {
    const expected = coming.map((n) => n.expected).sort()[0]!;
    const day = Date.parse(`${expected}T00:00:00Z`);
    lines.push({
      kind: 'next',
      text: `Next: ${versions(coming.map((n) => n.release))}, ${day < Date.parse(new Date(now).toISOString().slice(0, 10)) ? 'due now' : `expected ${phpDay(day)}`}`,
    });
  }
  return lines;
}

/**
 * The newer release a hosted site is behind, for the mark beside its PHP; null when it runs the
 * newest, or nothing is known.
 */
export function phpBehind(
  site: { kind?: string; app?: string; phpVersion: string; phpRelease: string | null },
  data: PhpUpdatesDto | undefined,
): { version: string; security: boolean } | null {
  if (!data || site.kind === 'external' || site.app === 'container' || !site.phpRelease) return null;
  const latest = data.branches.find((b) => b.branch === site.phpVersion)?.latest;
  if (!latest || compareRelease(site.phpRelease, latest.version) >= 0) return null;
  return { version: latest.version, security: latest.security };
}
