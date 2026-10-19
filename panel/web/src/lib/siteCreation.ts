// @docs sites/create
import type { JobDto, WporgPluginDto } from '../../../shared/types';

/**
 * A new site goes from the New site form straight to its own page, which shows its `site.create`
 * job until the site is made. What the two pass between them.
 */

/**
 * The `site.create` job for `slug` among `jobs`, the newest. Given the site's own creation time,
 * a job from before it is left out: it made an earlier site of the same name, since deleted.
 */
export function createJobFor(
  jobs: Iterable<JobDto | null>,
  slug: string,
  siteCreatedAt: number | null,
): JobDto | null {
  let found: JobDto | null = null;
  for (const job of jobs) {
    if (job?.type !== 'site.create' || job.siteSlug !== slug) continue;
    if (siteCreatedAt !== null && job.createdAt < siteCreatedAt) continue;
    if (!found || job.id > found.id) found = job;
  }
  return found;
}

/**
 * Which of the creates a site's page knows of it shows: the newest, as job ids only grow. A read
 * of the site kept from before a rollback still names the create that rolled back, while a retry
 * of the same name is a later job.
 */
export function newestJob(...ids: (number | null | undefined)[]): number | null {
  const known = ids.filter((id): id is number => typeof id === 'number');
  return known.length > 0 ? Math.max(...known) : null;
}

/** The New site form, as it was sent. */
export interface NewSiteDraft {
  title: string;
  slugEdited: string;
  serverId: number | null;
  customDomain: boolean;
  domainsText: string;
  adminUser: string;
  adminEmail: string | null;
  generatePw: boolean;
  adminPassword: string;
  locale: string | null;
  phpVersion: string | null;
  discourageSearch: boolean;
  selectedCatalog: number[];
  extraPlugins: WporgPluginDto[];
}

/**
 * The form each create was sent with, by its job, for Back to the form when the site is not
 * made. In memory only: it holds the admin password when one was typed in, so a reload loses it.
 */
const drafts = new Map<number, NewSiteDraft>();

export function keepDraft(jobId: number, draft: NewSiteDraft): void {
  drafts.set(jobId, draft);
}

export function draftOf(jobId: number): NewSiteDraft | null {
  return drafts.get(jobId) ?? null;
}

/** The creates whose generated admin password the admin has put away (Done), in this tab. */
const SEEN_KEY = 'wpl7-site-passwords-seen';

function seenJobs(): number[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : [];
  } catch {
    // Storage refused or garbled: every password counts as not put away yet.
    return [];
  }
}

export function passwordSeen(jobId: number): boolean {
  return seenJobs().includes(jobId);
}

export function markPasswordSeen(jobId: number): void {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seenJobs().filter((id) => id !== jobId), jobId].slice(-20)));
  } catch {
    // Refused: the password shows again after a reload.
  }
}
