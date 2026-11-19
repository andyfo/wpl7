// @docs security/privacy, sites/php-updates
import { and, desc, eq, inArray } from 'drizzle-orm';
import { jobs, sites, type ServerRow, type SiteRow } from '../db/schema.js';
import type { JobContext } from '../jobs/context.js';
import { hostedSites, siteImageSites } from '../lib/siteKind.js';
import { PANEL_GIT_SHA } from '../lib/version.js';
import { compareVersions } from '../lib/wpVersions.js';
import type { PhpBranchDto, PhpUpdatesDto } from '../../shared/types.js';
import type { DockerPort, ImageSummary } from './docker.js';
import { SETUP_WORDPRESS_IMAGE } from './dockerCleanup.js';
import type { CoreServices } from './index.js';
import { NO_ANSWER, within } from './phpReleases.js';
import { PhpUpstream, type PhpFetch } from './phpUpstream.js';
import { sweepSiteImages } from './siteImages.js';
import { SITE_IMAGE_REPO, releaseImageTag, siteImage } from './siteSpec.js';

/**
 * PHP patch releases reach every site by themselves, without a WPL7 release.
 *
 * A site runs the PHP of its server's `wpl7-wordpress:php<X.Y>`, and the site image sweep
 * (services/siteImages.ts) moves every site onto whatever that name points at now. What was
 * missing was anything that moves the name when PHP releases. That is this, every 15 minutes
 * (the `php-releases` schedule):
 *
 * - **An install that pulls its images** follows the published image of its own build:
 *   `ghcr.io/andyfo/wpl7/wordpress:php8.4-0.4.0` on the stable channel, and on edge the tag of the
 *   commit it runs (`php8.4-sha-<commit>`), never the moving `php8.4-edge`, which would give it the
 *   images of a newer commit, or undo a rollback. CI rebuilds those images when Docker's
 *   `wordpress:php8.4-fpm` has a newer PHP, and once a week for everything else in it, keeping a
 *   rebuild only when a package changed (.github/workflows/site-images-refresh.yml).
 * - **An install that builds its own** builds a new image on a server when php.net has a newer
 *   release than the image there and Docker's base has changed since the server last built on
 *   it, and once a week, on Mondays from 03:00 UTC as CI does. A build that changed no package
 *   and no PHP extension is thrown away, so sites are not recreated for nothing.
 *
 * Either way it is one `server.refreshSiteImages` job per server, in a lane of its own so the
 * server's sites carry on meanwhile, and the sweep's `site.reconcile` per site after it, each with
 * its own rollback. What php.net says (services/phpUpstream.ts) is what the Overview card and the
 * emails tell.
 */

const STATE_KEY = 'php.images';
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Docker Hub counts every manifest request: the base is asked about once in this long per branch. */
const BASE_CHECK_MS = 30 * MIN;
/** How long one server's look at its images may take: a daemon that stops answering is not waited for. */
const PLAN_TIMEOUT_MS = 2 * MIN;
/** A refresh that failed is not queued again on its server before this. */
const RETRY_AFTER_MS = HOUR;
/** "All sites run PHP 8.4.28" stays on the Overview this long. */
const DONE_SHOWN_MS = 24 * HOUR;
/** An advance notice stays on the Overview until this long after the time it names. */
const NOTICE_AFTER_MS = 24 * HOUR;
/** ...or, when it names none that reads, this long after it was posted. */
const NOTICE_UNDATED_MS = 3 * 24 * HOUR;
/** Sites listed by name on the card and in an email. */
const BEHIND_LISTED = 10;
/** A release dated this close to today is news: an email when it is a security one. */
const NEWS_MS = 3 * 24 * HOUR;
/**
 * How long after a server's image of a branch has the new release, however it came, its sites
 * that have not moved count as stuck: the sweep moves them at boot or at its hourly pass, and a
 * site busy with a job of its own at the pass after.
 */
const STUCK_AFTER_MS = 90 * MIN;
/** A release that some server never gets an image of is told as it stands after this long. */
const SETTLE_ANYWAY_MS = 24 * HOUR;

/** The named lane a server's image refresh runs in: beside its sites' jobs, not in front of them. */
export const imagesLane = (serverId: number) => `images:${serverId}`;

/** The base image `deploy/wordpress-image/Dockerfile` builds on. */
export const baseImage = (version: string) => `wordpress:php${version}-fpm`;

/** A build's own name, until it is kept or thrown away. */
export const candidateOf = (version: string) => `${siteImage(version)}-next`;

/**
 * What changing a site image can change: every package and every PHP extension, with versions.
 * Two images that print the same run the same. scripts/site-image-refresh.sh compares the same.
 */
const FINGERPRINT_SCRIPT =
  "dpkg-query -W -f '${Package}=${Version}\\n' | LC_ALL=C sort; " +
  'php -r \'foreach (get_loaded_extensions() as $e) { echo $e, "=", phpversion($e), "\\n"; }\' | LC_ALL=C sort';

interface ServerImages {
  /** By branch: the PHP release in the server's site image, as last read. */
  releases: Record<string, string | null>;
  /**
   * By branch: when that release was first read there. It dates the image however it came: a
   * refresh, a WPL7 update, or a rebuild from the checkout.
   */
  releaseSince?: Record<string, number>;
  readAt: number;
  /**
   * By branch: when its last build here finished, kept or not, or when the branch was first seen.
   * A weekly rebuild is due for a branch whose last one is from before this week's Monday 03:00 UTC.
   */
  weeklyDone?: Record<string, number>;
  /** By branch: when the base image was last asked about. */
  baseCheckedAt?: Record<string, number>;
  /**
   * By branch: the base the last finished build was made on, by every digest Docker lists for it.
   * The same image pulled again under a new digest has both, in no particular order.
   */
  builtBase?: Record<string, string[]>;
  /** Why the last look at the server failed; null when it worked. */
  error: string | null;
}

interface ImagesState {
  /** By server id. */
  servers: Record<string, ServerImages>;
  /**
   * By release version: when a site was first seen on an older release. Only such a release gets a
   * `doneAt`: sites that ran it from the start, as after an install, did not move.
   */
  behindAt: Record<string, number>;
  /** By release version: when the last site moved onto it, for the Overview. */
  doneAt: Record<string, number>;
}

type RefreshPayload = { serverId: number; versions: string[]; reason: 'published' | 'php' | 'weekly' };

/** Monday 03:00 UTC on or before `now`: the start of the week a weekly rebuild belongs to. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day, 3);
  if (start > now) start -= 7 * 24 * HOUR;
  return start;
}

/** A tag's branch: `wpl7-wordpress:php8.4` → 8.4. A build's own `-next` name is not one. */
const branchOfTag = (tag: string) => /:php(\d+\.\d+)$/.exec(tag)?.[1] ?? null;

/**
 * Every digest an image was pulled as, from the registry's names for it (`repo@sha256:…`). Docker's
 * classic store keeps each one an unchanged image was pulled again under, sorted, not newest first.
 */
const digestsOf = (image: ImageSummary | undefined) => (image?.digests ?? []).map((name) => name.slice(name.indexOf('@') + 1));

const hasDigest = (image: ImageSummary | undefined, digest: string) => (image?.digests ?? []).some((d) => d.endsWith(`@${digest}`));

/**
 * A registry's "no such tag": a branch the release does not publish, not a failure. Docker answers
 * it with a 404 (`manifest unknown`); a registry it cannot reach or that refuses it is a 500, and a
 * 401 reads `no such image` in dockerode's words. Those are failures, and said.
 */
const unpublished = (err: unknown) =>
  (err as { statusCode?: unknown } | null)?.statusCode === 404 || /manifest unknown/i.test(errorText(err));

/** A site on an older release than `version`. One whose release is not known yet is not. */
const behindOf = (release: string | null, version: string) => !!release && compareVersions(release, version) < 0;

/** A server's row with the releases just read in its images, each dated from when it was first read there. */
function withReleases(row: ServerImages, releases: Record<string, string | null>, now: number): ServerImages {
  const since: Record<string, number> = {};
  for (const [v, release] of Object.entries(releases)) {
    const known = row.releaseSince?.[v];
    since[v] = known !== undefined && v in row.releases && row.releases[v] === release ? known : now;
  }
  return { ...row, releases, releaseSince: since, readAt: now };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PhpUpdatesService {
  readonly upstream: PhpUpstream;

  constructor(
    private readonly s: CoreServices,
    fetchImpl?: PhpFetch,
    /** The commit this panel was built from: an edge install follows its images. */
    private readonly gitSha: string = PANEL_GIT_SHA,
  ) {
    this.upstream = new PhpUpstream(s.settings, s.log, fetchImpl, s.config.updateToken);
  }

  /** Builds its own site images: from the checkout, as provision/setup.sh does in that mode. */
  get builds(): boolean {
    return this.s.config.source === 'build';
  }

  /**
   * The published image a server of this install follows for a branch: its release's, as
   * provision/setup.sh pulls it, and on edge the tag of the very commit it runs.
   */
  publishedImage(version: string): string {
    const { config } = this.s;
    let tag = releaseImageTag(config);
    if (tag === 'edge' && /^[0-9a-f]{7,40}$/.test(this.gitSha)) tag = `sha-${this.gitSha.slice(0, 7)}`;
    return `${config.wordpressImage || SETUP_WORDPRESS_IMAGE}:php${version}-${tag}`;
  }

  private state(): ImagesState {
    const raw = this.s.settings.getRaw(STATE_KEY) as Partial<ImagesState> | undefined;
    return { servers: { ...raw?.servers }, behindAt: { ...raw?.behindAt }, doneAt: { ...raw?.doneAt } };
  }

  private change(fn: (state: ImagesState) => void): void {
    const state = this.state();
    fn(state);
    this.s.settings.setRaw(STATE_KEY, state);
  }

  /** Note when a release was first behind, or done: in `state` as read, and as stored. */
  private mark(state: ImagesState, field: 'behindAt' | 'doneAt', version: string, at: number): void {
    state[field][version] = at;
    this.change((s) => {
      // The newest few: nothing reads the rest.
      s[field] = Object.fromEntries(Object.entries({ ...s[field], [version]: at }).sort((a, b) => b[1] - a[1]).slice(0, 12));
    });
  }

  private saveServer(serverId: number, change: (row: ServerImages) => ServerImages): void {
    this.change((state) => {
      state.servers[serverId] = change(state.servers[serverId] ?? { releases: {}, readAt: 0, error: null });
    });
  }

  // ------------------------------------------------------------------ the schedule

  /**
   * The `php-releases` schedule: read php.net, email what is news, and give every server whose
   * site image is behind a refresh job. Returns the schedule's message.
   */
  async tick(): Promise<{ message: string | null; error: string | null }> {
    await this.upstream.refresh();
    await this.tell();
    let queued = 0;
    const errors: string[] = [];
    for (const server of this.s.servers.listRows()) {
      if (server.status === 'unreachable' || server.status === 'provisioning') continue;
      try {
        const planned = await within(this.planServer(server), PLAN_TIMEOUT_MS);
        if (planned === NO_ANSWER) throw new Error('Docker did not answer in time');
        if (planned.queued) queued++;
        if (planned.problem) throw new Error(planned.problem);
        this.saveServer(server.id, (row) => ({ ...row, error: null }));
      } catch (err) {
        const message = errorText(err);
        const before = this.state().servers[server.id]?.error ?? null;
        this.saveServer(server.id, (row) => ({ ...row, error: message }));
        // Every 15 minutes: said once, until it changes.
        if (before !== message) this.s.log.warn(`PHP releases: "${server.name}" could not be checked: ${message}`);
        errors.push(server.name);
      }
    }
    await this.settleRollouts();
    const facts = this.upstream.facts();
    const error = facts.error ?? (errors.length > 0 ? `Could not check ${errors.join(', ')}` : null);
    return { message: queued > 0 ? `Refreshing site images on ${queued} ${queued === 1 ? 'server' : 'servers'}` : null, error };
  }

  /**
   * The emails php.net's facts are worth: an advance notice while it is open, and each security
   * release of a branch sites run, dated in the last few days. Offered at every pass; the alert
   * service sends each once, and tries again one the relay did not take. A release dated long
   * ago is how things are, not news: so an update to this version emails nothing.
   */
  private async tell(): Promise<void> {
    const status = this.status();
    const now = Date.now();
    if (status.notice && now - status.notice.publishedAt < 7 * 24 * HOUR) await this.s.alerts.phpNotice(status.notice, status.updateNeeded);
    const fresh = status.branches.filter((b) => b.latest?.security && b.sites > 0 && now - Date.parse(`${b.latest.date}T00:00:00Z`) < NEWS_MS);
    if (fresh.length > 0) {
      await this.s.alerts.phpReleases(
        fresh.map((b) => ({ version: b.latest!.version, sites: b.sites, advisories: b.latest!.advisories })),
        status.updateNeeded,
      );
    }
  }

  /**
   * Read one server's site images, and queue a refresh when they are behind. `problem` is what
   * kept a branch from being checked; the others are planned all the same.
   */
  private async planServer(server: ServerRow): Promise<{ queued: boolean; problem: string | null }> {
    const docker = this.s.servers.handleFor(server.id).docker;
    const versions = (await docker.imageTags(SITE_IMAGE_REPO)).map(branchOfTag).filter((v): v is string => v !== null);
    const releases: Record<string, string | null> = {};
    for (const v of versions) releases[v] = await docker.imagePhpVersion(siteImage(v));
    const now = Date.now();
    // A branch seen for the first time waits for next week's rebuild: it was just built or pulled.
    this.saveServer(server.id, (row) => ({
      ...withReleases(row, releases, now),
      weeklyDone: { ...Object.fromEntries(versions.map((v) => [v, now])), ...row.weeklyDone },
    }));
    if (versions.length === 0 || this.refreshBlocked(server.id)) return { queued: false, problem: null };
    const plan = this.builds ? await this.staleBuilds(server, docker, versions, releases) : await this.stalePulls(docker, versions);
    if (plan.versions.length > 0) {
      const payload: RefreshPayload = { serverId: server.id, versions: plan.versions, reason: plan.reason };
      this.s.worker.enqueue('server.refreshSiteImages', payload, undefined, { lane: imagesLane(server.id) });
    }
    return { queued: plan.versions.length > 0, problem: plan.problems.length > 0 ? plan.problems.join('; ') : null };
  }

  /** Branches whose published image is not the one the server has. */
  private async stalePulls(docker: DockerPort, versions: string[]): Promise<{ versions: string[]; reason: 'published'; problems: string[] }> {
    const images = await docker.listImages();
    const stale: string[] = [];
    const problems: string[] = [];
    for (const v of versions) {
      const ref = this.publishedImage(v);
      let digest: string;
      try {
        digest = (await docker.distribution(ref)).digest;
      } catch (err) {
        // A branch its release does not publish has nothing to follow; anything else is said.
        if (!unpublished(err)) problems.push(`${ref}: ${errorText(err)}`);
        continue;
      }
      if (!hasDigest(images.find((image) => image.tags.includes(siteImage(v))), digest)) stale.push(v);
    }
    return { versions: stale, reason: 'published', problems };
  }

  /**
   * Branches worth a build: each once a week, until its build there finishes, and at once one
   * whose image is behind php.net's newest release while Docker's base differs from the one the
   * server last built on. The base may have changed for another reason and still have the old PHP:
   * the build is then kept only if a package changed, and tried again once the base changes once
   * more. A failed build is tried again an hour later (refreshBlocked), weekly or not.
   */
  private async staleBuilds(
    server: ServerRow,
    docker: DockerPort,
    versions: string[],
    releases: Record<string, string | null>,
  ): Promise<{ versions: string[]; reason: 'php' | 'weekly'; problems: string[] }> {
    const now = Date.now();
    const row = this.state().servers[server.id];
    const weekly = versions.filter((v) => (row?.weeklyDone?.[v] ?? now) < weekStart(now));
    const facts = this.upstream.facts();
    const checked = { ...row?.baseCheckedAt };
    // The base each branch was last built on. Until a build here records one, the base the server
    // has now, taken once: a failed build may pull a newer base, and must not pass for a finished one.
    const built = { ...row?.builtBase };
    const unknown = versions.filter((v) => !built[v]?.length);
    if (unknown.length > 0) {
      const images = await docker.listImages();
      for (const v of unknown) {
        const digests = digestsOf(images.find((image) => image.tags.includes(baseImage(v))));
        if (digests.length > 0) built[v] = digests;
      }
    }
    const stale: string[] = [];
    const problems: string[] = [];
    for (const v of versions.filter((b) => !weekly.includes(b))) {
      const latest = facts.releases[v]?.version;
      const have = releases[v];
      if (!latest || !have || compareVersions(have, latest) >= 0) continue;
      if (now - (checked[v] ?? 0) < BASE_CHECK_MS) continue;
      checked[v] = now;
      let digest: string;
      try {
        digest = (await docker.distribution(baseImage(v))).digest;
      } catch (err) {
        problems.push(`${baseImage(v)}: ${errorText(err)}`);
        continue;
      }
      if (!built[v]?.includes(digest)) stale.push(v);
    }
    this.saveServer(server.id, (r) => ({ ...r, baseCheckedAt: checked, builtBase: { ...built, ...r.builtBase } }));
    return { versions: [...weekly, ...stale], reason: weekly.length > 0 ? 'weekly' : 'php', problems };
  }

  /** A refresh queued or running on the server, or one that failed within the last RETRY_AFTER_MS. */
  private refreshBlocked(serverId: number): boolean {
    const last = this.s.db
      .select({ status: jobs.status, finishedAt: jobs.finishedAt })
      .from(jobs)
      .where(and(eq(jobs.type, 'server.refreshSiteImages'), eq(jobs.lane, imagesLane(serverId))))
      .orderBy(desc(jobs.id))
      .limit(1)
      .get();
    if (!last) return false;
    if (last.status === 'queued' || last.status === 'running') return true;
    return last.status === 'failed' && Date.now() - (last.finishedAt ?? 0) < RETRY_AFTER_MS;
  }

  // ------------------------------------------------------------------ the job

  /** `server.refreshSiteImages`: pull or build each branch's image, then move the server's sites. */
  async refreshImages(ctx: JobContext<RefreshPayload>): Promise<void> {
    const handle = this.s.servers.handleFor(ctx.payload.serverId);
    const docker = handle.docker;
    const moved: string[] = [];
    const failed: string[] = [];
    try {
      for (const v of ctx.payload.versions) {
        ctx.checkCanceled();
        try {
          const before = await docker.imagePhpVersion(siteImage(v));
          const changed = this.builds ? await this.build(ctx, docker, handle.id, v) : await this.pull(ctx, docker, v);
          // This week's rebuild of the branch is done once a build finished, whatever came of it.
          if (this.builds) this.saveServer(handle.id, (row) => ({ ...row, weeklyDone: { ...row.weeklyDone, [v]: Date.now() } }));
          if (!changed) continue;
          moved.push(v);
          const after = await docker.imagePhpVersion(siteImage(v));
          ctx.info(after && after !== before ? `${siteImage(v)}: PHP ${before ?? 'unknown'} → ${after}` : `${siteImage(v)}: PHP ${after ?? 'unknown'}, newer packages`);
        } catch (err) {
          // One branch's failure leaves the others to go on: its sites keep the image they have.
          ctx.warn(`${siteImage(v)}: ${errorText(err)}`);
          failed.push(v);
        }
      }
    } finally {
      // However the rest went, a name that moved has sites to move.
      await this.afterRefresh(ctx, handle.id, docker, moved);
    }
    if (moved.length === 0 && failed.length === 0) ctx.info('Every site image here is current.');
    if (failed.length > 0) throw new Error(`Could not refresh the PHP ${failed.join(', ')} image${failed.length === 1 ? '' : 's'}.`);
  }

  /** Read the server's images again, and move its sites onto those that changed. */
  private async afterRefresh(ctx: JobContext<RefreshPayload>, serverId: number, docker: DockerPort, moved: string[]): Promise<void> {
    try {
      const releases: Record<string, string | null> = {};
      for (const tag of await docker.imageTags(SITE_IMAGE_REPO)) {
        const v = branchOfTag(tag);
        if (v) releases[v] = await docker.imagePhpVersion(tag);
      }
      this.saveServer(serverId, (row) => withReleases(row, releases, Date.now()));
    } catch (err) {
      ctx.warn(`Could not read the site images again: ${errorText(err)}. The next check does.`);
    }
    if (moved.length === 0) return;
    const sweep = await sweepSiteImages(this.s, this.s.worker, serverId);
    if (sweep.failed?.length) ctx.warn('Could not look for the sites to move. The hourly check moves them.');
    else
      ctx.info(
        sweep.queued.length > 0
          ? `${sweep.queued.length} ${sweep.queued.length === 1 ? 'site moves' : 'sites move'} onto the new image, each in a job of its own.`
          : 'No site needed to move.',
      );
    if (sweep.busy.length > 0) ctx.info(`Busy now, and moved at the next hourly check: ${sweep.busy.join(', ')}.`);
  }

  /** Pull the published image; true when it is a new one and the site image's name moved onto it. */
  private async pull(ctx: JobContext<RefreshPayload>, docker: DockerPort, version: string): Promise<boolean> {
    const ref = this.publishedImage(version);
    const was = await docker.imageId(siteImage(version));
    ctx.info(`Pulling ${ref}…`);
    await docker.pullImage(ref, (line) => ctx.info(line));
    const id = await docker.imageId(ref);
    if (!id) throw new Error(`${ref} was pulled, but Docker has no image by that name.`);
    if (id === was) {
      ctx.info(`${siteImage(version)} is that image already.`);
      return false;
    }
    // An update that moved the name meanwhile brought images of its own release: those stay.
    if ((await docker.imageId(siteImage(version))) !== was) {
      ctx.info(`${siteImage(version)} changed while it was pulled, by an update. It stays as the update left it.`);
      return false;
    }
    await docker.tagImage(id, siteImage(version));
    return true;
  }

  /** Build a new image, and keep it when something in it changed; true when it was kept. */
  private async build(ctx: JobContext<RefreshPayload>, docker: DockerPort, serverId: number, version: string): Promise<boolean> {
    const candidate = candidateOf(version);
    const was = await docker.imageId(siteImage(version));
    ctx.info(`Building ${siteImage(version)} on a freshly pulled ${baseImage(version)}…`);
    try {
      // No cache: a weekly rebuild is for the packages a cached step would keep.
      await docker.buildImage(candidate, this.s.config.wpImageContext, { PHP_TAG: `php${version}` }, (line) => ctx.info(line), {
        noCache: true,
      });
      const id = await docker.imageId(candidate);
      if (!id) throw new Error('The build finished, but Docker has no image by its name.');
      // Built on this base, whatever comes of the build: a PHP rebuild waits for the next one.
      const base = digestsOf((await docker.listImages()).find((image) => image.tags.includes(baseImage(version))));
      if (base.length > 0) this.saveServer(serverId, (row) => ({ ...row, builtBase: { ...row.builtBase, [version]: base } }));
      if (await this.sameContents(ctx, docker, candidate, siteImage(version))) {
        ctx.info(`Nothing in ${siteImage(version)} changed: it stays as it is.`);
        return false;
      }
      // A rebuild from the checkout (deploy.sh, build.sh) moved the name meanwhile: that one stays.
      if ((await docker.imageId(siteImage(version))) !== was) {
        ctx.info(`${siteImage(version)} was rebuilt meanwhile, from the checkout. It stays as that build left it.`);
        return false;
      }
      await docker.tagImage(id, siteImage(version));
      return true;
    } finally {
      // Only the name: the image itself stays under its real one when it was kept.
      await docker.removeImage(candidate).catch(() => undefined);
    }
  }

  /** Whether two images have the same packages and PHP extensions. A check that fails says no. */
  private async sameContents(ctx: JobContext<RefreshPayload>, docker: DockerPort, a: string, b: string): Promise<boolean> {
    try {
      const [one, two] = [await this.fingerprint(docker, a), await this.fingerprint(docker, b)];
      return one === two;
    } catch (err) {
      ctx.warn(`Could not compare the new image with the current one, so it is used: ${errorText(err)}`);
      return false;
    }
  }

  private async fingerprint(docker: DockerPort, image: string): Promise<string> {
    const run = await docker.runEphemeral({
      image,
      entrypoint: ['/bin/sh', '-c', FINGERPRINT_SCRIPT],
      cmd: [],
      timeoutMs: 60_000,
      labels: { 'wpl7.imageCheck': 'true' },
      lockdown: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1e9, pidsLimit: 64, tmpfs: { '/tmp': 16 } },
    });
    if (run.exitCode !== 0 || !run.stdout.trim()) throw new Error(`${image} did not list its packages: ${run.stderr.trim() || `exit ${run.exitCode}`}`);
    return run.stdout;
  }

  // ------------------------------------------------------------------ what it says

  /** Hosted sites that run the site image: WordPress and PHP sites. */
  private siteRows(): SiteRow[] {
    return this.s.db.select().from(sites).where(and(hostedSites(), siteImageSites())).all();
  }

  /**
   * An install behind the newest release of its channel, or on edge behind the newest edge build:
   * CI refreshes only the images of those, so a new PHP reaches it with an update of WPL7.
   */
  private updateNeeded(): boolean {
    return !this.builds && this.s.updates.status().updateAvailable;
  }

  /**
   * Remember when each branch's newest release reached its last site, and tell how a security
   * release went, once its sites had their chance: every site on it, or the ones still behind.
   * A release that some server never gets an image of is told as it stands after a day. One that
   * no server has an image of is not: no site could move, and the Overview says why.
   */
  private async settleRollouts(): Promise<void> {
    const status = this.status();
    const state = this.state();
    const now = Date.now();
    for (const branch of status.branches) {
      const latest = branch.latest;
      if (!latest || branch.sites === 0) continue;
      if (branch.behindCount > 0 && !state.behindAt[latest.version]) this.mark(state, 'behindAt', latest.version, now);
      if (branch.updating) continue;
      const has = (release: string | null) => release !== null && compareVersions(release, latest.version) >= 0;
      const ready = new Set(branch.images.filter((i) => has(i.release)).map((i) => i.serverId));
      const everywhere = branch.images.length > 0 && ready.size === branch.images.length;
      if (!everywhere && now - latest.seenAt < SETTLE_ANYWAY_MS) continue;
      if (branch.behindCount === 0) {
        // A site whose release is not known yet is not done: it waits, and so does the email.
        if (branch.current < branch.sites) continue;
        // On the Overview only once sites moved onto it: not for sites that ran it from the start.
        if (state.behindAt[latest.version] && !state.doneAt[latest.version]) this.mark(state, 'doneAt', latest.version, now);
        if (latest.security) await this.s.alerts.phpRolloutDone(latest.version, branch.sites);
        continue;
      }
      if (ready.size === 0) continue;
      if (latest.security) await this.tellBehind(state, latest.version, branch.branch, branch.sites, ready, now);
    }
  }

  /**
   * Email the sites still behind a security release: those whose server has its image, and those
   * whose has not. Not while a site's server got the image within STUCK_AFTER_MS: its move may not
   * have been tried yet.
   */
  private async tellBehind(state: ImagesState, version: string, branch: string, total: number, ready: Set<number>, now: number): Promise<void> {
    const behind = this.siteRows().filter((r) => r.phpVersion === branch && behindOf(r.phpRelease, version));
    const since = (serverId: number) => state.servers[serverId]?.releaseSince?.[branch] ?? 0;
    if (behind.some((r) => ready.has(r.serverId) && now - since(r.serverId) < STUCK_AFTER_MS)) return;
    const listed = (rows: SiteRow[]) => ({
      sites: rows.slice(0, BEHIND_LISTED).map((r) => ({ slug: r.slug, title: r.title, release: r.phpRelease })),
      count: rows.length,
    });
    const waiting = behind.filter((r) => !ready.has(r.serverId));
    const servers = this.s.servers.listRows().filter((server) => waiting.some((r) => r.serverId === server.id));
    await this.s.alerts.phpRolloutBehind(version, total, listed(behind.filter((r) => ready.has(r.serverId))), {
      ...listed(waiting),
      servers: servers.map((server) => server.name),
    });
  }

  /** What the Overview card and `GET /api/php` show. */
  status(): PhpUpdatesDto {
    const facts = this.upstream.facts();
    const state = this.state();
    const now = Date.now();
    const rows = this.siteRows();
    const servers = this.s.servers.listRows();
    const offered = this.s.settings.get('phpVersions') ?? [];
    const active = this.s.db
      .select({ type: jobs.type, siteId: jobs.siteId, payload: jobs.payload })
      .from(jobs)
      .where(and(inArray(jobs.type, ['server.refreshSiteImages', 'site.reconcile']), inArray(jobs.status, ['queued', 'running'])))
      .all();
    const refreshing = new Set<string>();
    for (const job of active.filter((j) => j.type === 'server.refreshSiteImages')) {
      try {
        for (const v of (JSON.parse(job.payload) as Partial<RefreshPayload>).versions ?? []) refreshing.add(v);
      } catch {
        // A payload that does not read names no branch.
      }
    }
    const reconciling = new Set(active.filter((j) => j.type === 'site.reconcile').map((j) => j.siteId));
    const branchNames = new Set<string>([...offered, ...rows.map((r) => r.phpVersion)]);
    for (const row of Object.values(state.servers)) for (const v of Object.keys(row.releases)) branchNames.add(v);
    const branches: PhpBranchDto[] = [...branchNames]
      .filter((v) => /^\d+\.\d+$/.test(v))
      .sort(compareVersions)
      .map((branch) => {
        const latest = facts.releases[branch] ?? null;
        const mine = rows.filter((r) => r.phpVersion === branch);
        // A site whose release is not known yet, or that has no container, is neither behind nor current.
        const behind = latest ? mine.filter((r) => behindOf(r.phpRelease, latest.version)) : [];
        const current = latest ? mine.filter((r) => r.phpRelease && compareVersions(r.phpRelease, latest.version) >= 0).length : 0;
        const doneAt = latest ? (state.doneAt[latest.version] ?? null) : null;
        // The servers whose image matters: those with sites on the branch.
        const where = new Set(mine.map((r) => r.serverId));
        return {
          branch,
          latest: latest
            ? {
                version: latest.version,
                date: latest.date,
                security: latest.security,
                seenAt: latest.seenAt,
                advisories: latest.security ? (facts.advisories[latest.version]?.items ?? []) : [],
              }
            : null,
          next: facts.candidates[branch] ?? null,
          sites: mine.length,
          current,
          behind: behind.slice(0, BEHIND_LISTED).map((r) => ({ slug: r.slug, title: r.title, release: r.phpRelease })),
          behindCount: behind.length,
          images: servers
            .filter((server) => where.has(server.id) && state.servers[server.id]?.releases[branch] !== undefined)
            .map((server) => ({ serverId: server.id, serverName: server.name, release: state.servers[server.id]!.releases[branch] ?? null })),
          updating: behind.length > 0 && (refreshing.has(branch) || behind.some((r) => reconciling.has(r.id))),
          doneRecently: doneAt !== null && behind.length === 0 && current === mine.length && now - doneAt < DONE_SHOWN_MS,
        };
      });
    const notice = facts.notice;
    const noticeDay = notice ? new Date(notice.publishedAt).toISOString().slice(0, 10) : '';
    const noticeOpen =
      notice !== null &&
      (notice.scheduledAt !== null ? now < notice.scheduledAt + NOTICE_AFTER_MS : now < notice.publishedAt + NOTICE_UNDATED_MS) &&
      // A security release out since the notice was posted is the one it was about: the card says that instead.
      !Object.values(facts.releases).some((r) => r.security && r.date >= noticeDay && r.seenAt > notice.publishedAt);
    return {
      checkedAt: facts.checkedAt,
      error: facts.error,
      notice: noticeOpen ? notice : null,
      branches,
      images: this.builds ? 'build' : 'registry',
      updateNeeded: this.updateNeeded(),
      serverErrors: servers
        .filter((server) => state.servers[server.id]?.error)
        .map((server) => ({ serverId: server.id, serverName: server.name, error: state.servers[server.id]!.error! })),
    };
  }
}
