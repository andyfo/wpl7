// @docs sites/php-updates
import { phpDay, phpVersions, phpWhen, severityCounts } from '../../../shared/php';
import type { PhpBranchDto, PhpUpdatesDto } from '../../../shared/types';

export { phpWhen };

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

export type PhpTone = 'waiting' | 'updating' | 'behind' | 'done';

/** The dot beside a line, by how things stand. */
export const PHP_TONES: Record<PhpTone, string> = {
  waiting: 'bg-amber-500',
  updating: 'bg-sky-500',
  behind: 'bg-red-500',
  done: 'bg-emerald-500',
};

const hasRelease = (release: string | null, version: string) => release !== null && compareRelease(release, version) >= 0;
const running = (job: { status: string } | null) => job !== null && (job.status === 'queued' || job.status === 'running');

/** php.net's release notes of a release: 8.4.28 is on ChangeLog-8.php. */
export const phpChangelogUrl = (version: string) => `https://www.php.net/ChangeLog-${version.split('.')[0]}.php#${version}`;

/** Where one server's image of a branch stands against its newest release, for the PHP details. */
export function phpImageState(image: PhpBranchDto['images'][number], version: string, data: PhpUpdatesDto): { tone: PhpTone; text: string } {
  if (hasRelease(image.release, version)) return { tone: 'done', text: `Has ${version}` };
  if (running(image.refresh)) return { tone: 'updating', text: data.images === 'build' ? 'Building the new image' : 'Pulling the new image' };
  if (image.refresh?.status === 'failed') return { tone: 'behind', text: 'Could not get the new image. It tries again within the hour.' };
  if (data.updateNeeded) return { tone: 'waiting', text: 'Needs a WPL7 update' };
  return { tone: 'waiting', text: data.images === 'build' ? "Waiting for Docker's image" : 'Waiting for the published image' };
}

/** Where one site still on an older release stands, for the PHP details. `retry`: its move can be tried again. */
export function phpSiteState(site: PhpBranchDto['behind'][number], branch: PhpBranchDto): { tone: PhpTone; text: string; retry: boolean } {
  const version = branch.latest?.version ?? '';
  if (running(site.move)) return { tone: 'updating', text: 'Moving now', retry: false };
  if (!branch.images.some((i) => i.serverId === site.serverId && hasRelease(i.release, version))) {
    return { tone: 'waiting', text: "Waits for its server's image", retry: false };
  }
  if (site.move?.status === 'failed') return { tone: 'behind', text: 'Its move failed', retry: true };
  if (site.move?.status === 'canceled') return { tone: 'behind', text: 'Its move was stopped', retry: true };
  return { tone: 'waiting', text: 'Moves at the next hourly check', retry: false };
}

/**
 * What is happening with a branch's newest release, and what comes next, for the top of the PHP
 * details. `update`: a WPL7 update is the way to it.
 */
export function phpSummary(b: PhpBranchDto, data: PhpUpdatesDto): { text: string; update: boolean } {
  const version = b.latest?.version ?? '';
  if (b.sites === 0) return { text: `No site runs PHP ${b.branch}.`, update: false };
  if (b.behindCount === 0) {
    return {
      text:
        b.current === b.sites
          ? `${b.sites === 1 ? 'The site runs' : `All ${b.sites} sites run`} PHP ${version}.`
          : `${b.current} of ${plural(b.sites, 'site')} run PHP ${version}. The others' PHP is read at their next check.`,
      update: false,
    };
  }
  if (!b.images.some((i) => hasRelease(i.release, version))) {
    if (b.images.some((i) => running(i.refresh))) {
      return { text: `${data.images === 'build' ? 'Building' : 'Pulling'} the site image with PHP ${version}. Then the sites move onto it.`, update: false };
    }
    if (data.updateNeeded) return { text: `This install's WPL7 release gets no new site images. A WPL7 update brings PHP ${version}.`, update: true };
    return {
      text:
        data.images === 'build'
          ? `Waiting for Docker's WordPress image with PHP ${version}, usually a few hours after the release. Each server then builds its own image, and the sites move onto it.`
          : `Waiting for the site image with PHP ${version}, usually a few hours after the release. Each server then pulls it, and the sites move onto it.`,
      update: false,
    };
  }
  if (b.updating) return { text: `Moving the sites onto PHP ${version}: ${b.current} of ${b.sites} done. Each one restarts for a second or two.`, update: false };
  return { text: `${b.behindCount} of ${plural(b.sites, 'site')} still on an older PHP than ${version}.`, update: false };
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
    const badge = latest.security ? ['Security', severityCounts(latest.advisories)].filter(Boolean).join(' · ') : null;
    const base = { kind: 'release' as const, branch: b.branch, badge, sites: [] as PhpBranchDto['behind'], more: 0, update: false };
    if (b.behindCount === 0) {
      if (b.doneRecently) lines.push({ ...base, tone: 'done', text: `All sites run PHP ${latest.version}`, badge: null });
      continue;
    }
    const has = (release: string | null) => release !== null && compareRelease(release, latest.version) >= 0;
    const some = b.images.some((i) => has(i.release));
    if (b.updating) {
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
      text: `Next: ${phpVersions(coming.map((n) => n.release))}, ${day < Date.parse(new Date(now).toISOString().slice(0, 10)) ? 'due now' : `expected ${phpDay(day)}`}`,
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
