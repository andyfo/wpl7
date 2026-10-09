// @docs help/troubleshooting, sites/overview
import type { SiteStatus } from '../../../shared/schemas';
import { timeAgo } from './format';

/**
 * One state per site, from the three things the panel separately knows about it.
 *
 * The panel used to show two indicators side by side - a red/green dot from the HTTP
 * probe and a badge from `sites.status` - and they answer different questions, so they
 * regularly contradicted each other: a site whose container was started but whose router
 * never came back read "RUNNING" next to a red dot, which tells an operator nothing
 * except that the panel is unsure. The three inputs are:
 *
 * - `status`: what the last job *left the site as*. Stored, never re-read from Docker,
 *   so "running" means "the panel started it and nothing has told it otherwise".
 * - `up` / `httpStatus`: whether the site answered its last HTTP probe, and with what.
 *   The only one of the three that knows whether visitors can see anything.
 * - `containerState`: a live `docker inspect`, which costs a round trip per site, so
 *   only the site detail page has it.
 *
 * Collapsing them here means every screen says the same thing, and the disagreements
 * become the states worth naming ("Offline", "No container") rather than a puzzle.
 */
export type HealthTone = 'ok' | 'busy' | 'idle' | 'bad' | 'unknown';

export interface SiteHealthInput {
  status: SiteStatus;
  /** Last probe verdict; null = no probe has completed since the panel started. */
  up?: boolean | null;
  /** Code the probe got back; null = nothing answered at all (refused, timed out). */
  httpStatus?: number | null;
  lastCheckedAt?: number | null;
  /** Live Docker state; omitted on screens that only have the sites list. */
  containerState?: 'running' | 'created' | 'exited' | 'missing' | 'unknown' | null;
  /** A site hosted elsewhere: whether its WPL7 Connect answered the panel's last request. */
  external?: { reachable: boolean | null } | null;
}

export interface SiteHealth {
  /** Two words at most - it sits in a table cell. */
  label: string;
  tone: HealthTone;
  /** Why, in one sentence. The badge's tooltip, and the first line of the site banner. */
  detail: string;
  /** What to do about it, when there is something. Only ever set on a `bad` tone. */
  fix?: string;
  /**
   * The button the site page offers for this state. It has to be chosen per state rather
   * than defaulting to `reconcile` for everything: `site.reconcile` derives whether to
   * start the new container from the state of the old one, so on an *exited* container it
   * rebuilds and leaves it stopped - succeeding while the site is still dark.
   */
  action?: { label: string; path: SiteHealthAction };
}

export type SiteHealthAction = 'start' | 'restart' | 'reconcile';

/**
 * The repair for "the registry and the container no longer agree" - POST /sites/:slug/reconcile.
 * Labelled exactly as the button in the Overview action row, so the banner is understood as
 * pointing at that one rather than offering a second, differently-named thing.
 */
const RECREATE = 'Recreating its container from the registry is the repair; files and database are untouched.';
const RECREATE_ACTION = { label: 'Recreate container', path: 'reconcile' } as const;

export function siteHealth(input: SiteHealthInput): SiteHealth {
  const { status, up = null, httpStatus = null, lastCheckedAt = null, containerState = null } = input;
  const checked = lastCheckedAt ? ` Checked ${timeAgo(lastCheckedAt)}.` : '';
  if (input.external) return externalHealth(input, input.external, checked);

  if (status === 'provisioning') {
    return { label: 'Creating', tone: 'busy', detail: 'Still being created - it serves nothing yet.' };
  }
  if (status === 'deleting') {
    return { label: 'Deleting', tone: 'busy', detail: 'Being removed.' };
  }
  if (status === 'error') {
    return {
      label: 'Error',
      tone: 'bad',
      detail: `A job on this site failed and left it half-applied.${servingNote(up, containerState)}`,
      fix: `Jobs shows which one failed and why. ${RECREATE}`,
      action: RECREATE_ACTION,
    };
  }
  if (status === 'stopped') {
    return containerState === 'running'
      ? {
          label: 'Stopped',
          tone: 'idle',
          detail:
            'The panel has this site stopped, but its container is running - something outside the panel started it.',
        }
      : { label: 'Stopped', tone: 'idle', detail: 'Stopped on purpose. It answers nothing until it is started.' };
  }

  // status === 'running': the panel believes it started this site, so anything short of
  // "answering" is a disagreement worth naming.
  if (containerState === 'missing') {
    return {
      label: 'No container',
      tone: 'bad',
      detail: 'The panel expects this site to be running, but it has no container at all.',
      fix: RECREATE,
      action: RECREATE_ACTION,
    };
  }
  // Built but never run - since #29 that means its start failed, and a plain Start is the
  // documented repair (it rewrites the files the container mounts before running it), not
  // the recreate that produced this container in the first place.
  if (containerState === 'created') {
    return {
      label: 'Offline',
      tone: 'bad',
      detail: 'Its container was built but has never run - the start did not get through.',
      fix: 'Start it: that repairs the files it mounts and runs it. Its container logs say what the first start hit.',
      action: { label: 'Start', path: 'start' },
    };
  }
  if (containerState === 'exited') {
    // Deliberately not the recreate: shouldSiteRun (jobs/handlers/shared.ts) reads `exited`
    // as "stopped on purpose", so reconcile would rebuild, report success and leave the site
    // down. `created` above is the opposite case - no intent, so it defers to the registry.
    return {
      label: 'Offline',
      tone: 'bad',
      detail: 'Its container exited on its own, so nothing is being served.',
      fix: 'Start it again; if it exits a second time, its container logs say why.',
      action: { label: 'Start', path: 'start' },
    };
  }
  if (containerState === 'unknown') {
    return {
      label: 'Unknown',
      tone: 'unknown',
      detail: 'Its server could not be reached, so none of this is a live reading.',
    };
  }
  if (up === null) {
    return { label: 'Checking', tone: 'unknown', detail: 'Started; no health check has completed yet.' };
  }
  if (up) {
    return { label: 'Online', tone: 'ok', detail: `Running and answering requests.${checked}` };
  }
  // Only the detail page has actually inspected the container; the list knows just what the
  // registry claims, and saying "the container is running" there would be inventing a reading.
  const lead = containerState === 'running' ? 'The container is running' : 'The panel has this site started';
  // A 404 is the router's answer, not the site's, so restarting the container changes
  // nothing - the labels have to be rebuilt. Anything else came from inside the site.
  return httpStatus === 404
    ? {
        label: 'Offline',
        tone: 'bad',
        detail: `${lead}, but ${probeReason(httpStatus)}.${checked}`,
        fix: RECREATE,
        action: RECREATE_ACTION,
      }
    : {
        label: 'Offline',
        tone: 'bad',
        detail: `${lead}, but ${probeReason(httpStatus)}.${checked}`,
        fix: 'Restarting it is the first move; its container logs say what it is failing on.',
        action: { label: 'Restart', path: 'restart' },
      };
}

/**
 * Whether a site in a broken lifecycle state is nevertheless serving visitors - which is
 * the first thing worth knowing about one, since plenty of jobs fail without taking the
 * site down. Sound only because MonitorService probes `error` sites for real; it used to
 * assert `up: false` for every non-running row, and this then reported "not serving" about
 * a site nobody had asked.
 */
function servingNote(up: boolean | null, containerState: SiteHealthInput['containerState']): string {
  if (containerState === 'missing') return ' It has no container.';
  if (containerState === 'created') return ' Its container has never run.';
  if (up === true) return ' It is still serving pages.';
  if (up === false) return ' It is not serving pages.';
  return '';
}

/**
 * Traefik answers its catch-all 404 for a hostname no router matches, which is what a
 * site with a half-recreated container looks like from outside - indistinguishable, in
 * the old red dot, from a site that was never started.
 */
function probeReason(httpStatus: number | null): string {
  if (httpStatus === null) return 'nothing answered on its HTTP port';
  if (httpStatus === 404) return 'it answered 404 - no route matches this hostname, or WordPress served a 404 for the home page';
  if (httpStatus >= 500) return `it answered ${httpStatus} - PHP or WordPress is erroring`;
  return `it answered ${httpStatus}`;
}

/**
 * A site hosted elsewhere: no container to read and nothing the panel can repair, so no action.
 * Its own address is probed as a hosted site's is; its plugin answers the hourly check.
 */
function externalHealth(input: SiteHealthInput, external: { reachable: boolean | null }, checked: string): SiteHealth {
  const { status, up = null, httpStatus = null } = input;
  if (status === 'deleting') return { label: 'Removing', tone: 'busy', detail: 'Being removed from the panel.' };
  if (status === 'disconnected') {
    return { label: 'Disconnected', tone: 'idle', detail: 'The panel no longer manages this site. Reconnect it on its Settings tab.' };
  }
  if (up === false) {
    return {
      label: 'Offline',
      tone: 'bad',
      detail: `${httpStatus === null ? 'Nothing answered' : `It answered ${httpStatus}`} at its address.${checked}`,
    };
  }
  if (external.reachable === false) {
    return {
      label: 'Plugin unreachable',
      tone: 'bad',
      detail: 'WPL7 Connect on the site does not answer the panel.',
      fix: 'A firewall or security plugin may block the panel: let requests to /wp-json/wpl7-connect/ and ?wpl7-connect= through.',
    };
  }
  if (up === null) return { label: 'Checking', tone: 'unknown', detail: 'No check has completed yet.' };
  return { label: 'Online', tone: 'ok', detail: `Answering requests.${checked}` };
}
