// @docs security/privacy, sites/php-updates
import { and, eq, inArray } from 'drizzle-orm';
import { jobs, sites, type ServerRow, type SiteRow } from '../db/schema.js';
import type { JobContext } from '../jobs/context.js';
import { hostedSites, siteImageSites } from '../lib/siteKind.js';
import { PANEL_VERSION } from '../lib/version.js';
import { compareVersions } from '../lib/wpVersions.js';
import type { PhpBranchDto, PhpUpdatesDto } from '../../shared/types.js';
import type { DockerPort, ImageSummary } from './docker.js';
import { SETUP_WORDPRESS_IMAGE } from './dockerCleanup.js';
import type { CoreServices } from './index.js';
import { PhpUpstream, type PhpFetch } from './phpUpstream.js';
import { sweepSiteImages } from './siteImages.js';
import { SITE_IMAGE_REPO, siteImage } from './siteSpec.js';

/**
 * PHP patch releases reach every site by themselves, without a WPL7 release.
 *
 * A site runs the PHP of its server's `wpl7-wordpress:php<X.Y>`, and the site image sweep
 * (services/siteImages.ts) moves every site onto whatever that name points at now. What was
 * missing was anything that moves the name when PHP releases. That is this, every 15 minutes
 * (the `php-releases` schedule):
 *
 * - **An install that pulls its images** follows the published image of its own release,
 *   `ghcr.io/andyfo/wpl7/wordpress:php8.4-0.4.0`. CI rebuilds that image when Docker's
 *   `wordpress:php8.4-fpm` has a newer PHP, and once a week for everything else in it, keeping
 *   the rebuild only when a package changed (.github/workflows/site-images-refresh.yml). A server
 *   whose image is not the one the registry names now pulls it.
 * - **An install that builds its own** builds a new image on a server when php.net has a newer
 *   release than the image there and Docker's base has changed since the server last pulled it,
 *   and once a week, on Mondays from 03:00 UTC as CI does. A build that changed no package and no
 *   PHP extension is thrown away, so sites are not recreated for nothing.
 *
 * Either way it is one `server.refreshSiteImages` job per server, in a lane of its own so the
 * server's sites carry on meanwhile, and the sweep's `site.reconcile` per site after it, each with
 * its own rollback. What php.net says (services/phpUpstream.ts) is what the Overview card and the
 * emails tell.
 */

const STATE_KEY = 'php.images';
const MIN = 60_000;
/** Docker Hub counts every manifest request: the base is asked about once in this long per branch. */
const BASE_CHECK_MS = 30 * MIN;
/** "All sites run PHP 8.4.28" stays on the Overview this long. */
const DONE_SHOWN_MS = 24 * 3600_000;
/** An advance notice stays on the Overview until this long after the time it names. */
const NOTICE_AFTER_MS = 24 * 3600_000;
/** ...or, when it names none that reads, this long after it was posted. */
const NOTICE_UNDATED_MS = 3 * 24 * 3600_000;
/** Sites listed by name on the card and in an email. */
const BEHIND_LISTED = 10;
/** A release dated this close to today is news: an email when it is a security one. */
const NEWS_DAYS = 3;
/**
 * How long after its new image a branch's sites that have not moved count as stuck: a site busy
 * with a job of its own moves at the sweep's next hourly pass.
 */
const STUCK_AFTER_MS = 90 * MIN;

/** The named lane a server's image refresh runs in: beside its sites' jobs, not in front of them. */
export const imagesLane = (serverId: number) => `images:${serverId}`;

/** The base image `deploy/wordpress-image/Dockerfile` builds on. */
export const baseImage = (version: string) => `wordpress:php${version}-fpm`;

/** A build's own name, until it is kept or thrown away. */
const candidateOf = (version: string) => `${siteImage(version)}-next`;

/**
 * What changing a site image can change: every package and every PHP extension, with versions.
 * Two images that print the same run the same.
 */
const FINGERPRINT_SCRIPT =
  "dpkg-query -W -f '${Package}=${Version}\\n' | LC_ALL=C sort; " +
  'php -r \'foreach (get_loaded_extensions() as $e) { echo $e, "=", phpversion($e), "\\n"; }\' | LC_ALL=C sort';

interface ServerImages {
  /** By branch: the PHP release in the server's site image, as last read. */
  releases: Record<string, string | null>;
  readAt: number;
  /** When the last weekly rebuild was started, or when the server was first seen. */
  weeklyAt?: number;
  /** By branch: when the base image was last asked about. */
  baseCheckedAt?: Record<string, number>;
  /** Why the last look at the server failed; null when it worked. */
  error: string | null;
}

interface ImagesState {
  /** By server id. */
  servers: Record<string, ServerImages>;
  /** By release version: when the last site moved onto it. */
  doneAt: Record<string, number>;
  /** By branch: when a refresh last gave a server a new image of it. */
  movedAt: Record<string, number>;
}

/** Monday 03:00 UTC on or before `now`: the start of the week a weekly rebuild belongs to. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day, 3);
  if (start > now) start -= 7 * 24 * 3600_000;
  return start;
}

/** A tag's branch: `wpl7-wordpress:php8.4` → 8.4. A build's own `-next` name is not one. */
const branchOfTag = (tag: string) => /:php(\d+\.\d+)$/.exec(tag)?.[1] ?? null;

const hasDigest = (image: ImageSummary | undefined, digest: string) => (image?.digests ?? []).some((d) => d.endsWith(`@${digest}`));

export class PhpUpdatesService {
  readonly upstream: PhpUpstream;

  constructor(
    private readonly s: CoreServices,
    fetchImpl?: PhpFetch,
  ) {
    this.upstream = new PhpUpstream(s.settings, s.log, fetchImpl, s.config.updateToken);
  }

  /** Builds its own site images: from the checkout, as provision/setup.sh does in that mode. */
  get builds(): boolean {
    return this.s.config.source === 'build';
  }

  /** The published image a server of this install pulls for a branch, as provision/setup.sh names it. */
  publishedImage(version: string): string {
    const { config } = this.s;
    const tag = config.imageTag || (config.channel === 'edge' ? 'edge' : PANEL_VERSION);
    return `${config.wordpressImage || SETUP_WORDPRESS_IMAGE}:php${version}-${tag}`;
  }

  private state(): ImagesState {
    const raw = this.s.settings.getRaw(STATE_KEY) as Partial<ImagesState> | undefined;
    return { servers: { ...raw?.servers }, doneAt: { ...raw?.doneAt }, movedAt: { ...raw?.movedAt } };
  }

  private saveServer(serverId: number, change: (row: ServerImages) => ServerImages): void {
    const state = this.state();
    const row = state.servers[serverId] ?? { releases: {}, readAt: 0, error: null };
    state.servers[serverId] = change(row);
    this.s.settings.setRaw(STATE_KEY, state);
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
        if (await this.planServer(server)) queued++;
        this.saveServer(server.id, (row) => ({ ...row, error: null }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
    if (status.notice && Date.now() - status.notice.publishedAt < 7 * 24 * 3600_000) await this.s.alerts.phpNotice(status.notice);
    const today = Date.now();
    const fresh = status.branches.filter(
      (b) => b.latest?.security && b.sites > 0 && today - Date.parse(`${b.latest.date}T00:00:00Z`) < NEWS_DAYS * 24 * 3600_000,
    );
    if (fresh.length > 0) {
      await this.s.alerts.phpReleases(
        fresh.map((b) => ({ version: b.latest!.version, sites: b.sites, advisories: b.latest!.advisories })),
        status.updateNeeded,
      );
    }
  }

  /** Queue a refresh on one server when its images are behind. True when one was queued. */
  private async planServer(server: ServerRow): Promise<boolean> {
    const docker = this.s.servers.handleFor(server.id).docker;
    const versions = (await docker.imageTags(SITE_IMAGE_REPO)).map(branchOfTag).filter((v): v is string => v !== null);
    const releases: Record<string, string | null> = {};
    for (const v of versions) releases[v] = await docker.imagePhpVersion(siteImage(v));
    this.saveServer(server.id, (row) => ({ ...row, releases, readAt: Date.now(), weeklyAt: row.weeklyAt ?? Date.now() }));
    if (versions.length === 0 || this.refreshActive(server.id)) return false;
    const plan = this.builds ? await this.staleBuilds(server, docker, versions, releases) : await this.stalePulls(docker, versions);
    if (plan.versions.length === 0) return false;
    this.s.worker.enqueue(
      'server.refreshSiteImages',
      { serverId: server.id, versions: plan.versions, reason: plan.reason },
      undefined,
      { lane: imagesLane(server.id) },
    );
    return true;
  }

  /** Branches whose published image is not the one the server has. */
  private async stalePulls(docker: DockerPort, versions: string[]): Promise<{ versions: string[]; reason: 'published' }> {
    const images = await docker.listImages();
    const stale: string[] = [];
    for (const v of versions) {
      // A branch this release does not publish answers "manifest unknown": nothing to follow.
      const digest = await docker.distribution(this.publishedImage(v)).then(
        (info) => info.digest,
        () => null,
      );
      if (!digest) continue;
      if (!hasDigest(images.find((image) => image.tags.includes(siteImage(v))), digest)) stale.push(v);
    }
    return { versions: stale, reason: 'published' };
  }

  /**
   * Branches worth a build: all of them once a week, and at once one whose image is behind
   * php.net's newest release while Docker's base has changed since this server pulled it. The base
   * may have changed for another reason and still have the old PHP: the build is then kept only if
   * a package changed, and tried again once the base changes once more.
   */
  private async staleBuilds(
    server: ServerRow,
    docker: DockerPort,
    versions: string[],
    releases: Record<string, string | null>,
  ): Promise<{ versions: string[]; reason: 'php' | 'weekly' }> {
    const now = Date.now();
    const row = this.state().servers[server.id];
    if ((row?.weeklyAt ?? now) < weekStart(now)) return { versions, reason: 'weekly' };
    const facts = this.upstream.facts();
    const checked = { ...row?.baseCheckedAt };
    let images: ImageSummary[] | null = null;
    const stale: string[] = [];
    for (const v of versions) {
      const latest = facts.releases[v]?.version;
      const have = releases[v];
      if (!latest || !have || compareVersions(have, latest) >= 0) continue;
      if (now - (checked[v] ?? 0) < BASE_CHECK_MS) continue;
      checked[v] = now;
      const digest = await docker.distribution(baseImage(v)).then(
        (info) => info.digest,
        () => null,
      );
      if (!digest) continue;
      images ??= await docker.listImages();
      if (!hasDigest(images.find((image) => image.tags.includes(baseImage(v))), digest)) stale.push(v);
    }
    this.saveServer(server.id, (r) => ({ ...r, baseCheckedAt: checked }));
    return { versions: stale, reason: 'php' };
  }

  /** A refresh queued or running on the server. */
  private refreshActive(serverId: number): boolean {
    return !!this.s.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.type, 'server.refreshSiteImages'), eq(jobs.lane, imagesLane(serverId)), inArray(jobs.status, ['queued', 'running'])))
      .get();
  }

  // ------------------------------------------------------------------ the job

  /** `server.refreshSiteImages`: pull or build each branch's image, then move the sites. */
  async refreshImages(ctx: JobContext<{ serverId: number; versions: string[]; reason: string }>): Promise<void> {
    const handle = this.s.servers.handleFor(ctx.payload.serverId);
    const docker = handle.docker;
    if (this.builds && ctx.payload.reason === 'weekly') this.saveServer(handle.id, (row) => ({ ...row, weeklyAt: Date.now() }));
    const moved: string[] = [];
    const failed: string[] = [];
    for (const v of ctx.payload.versions) {
      ctx.checkCanceled();
      const before = await docker.imagePhpVersion(siteImage(v));
      try {
        const changed = this.builds ? await this.build(ctx, docker, v) : await this.pull(ctx, docker, v);
        if (!changed) continue;
      } catch (err) {
        // One branch's failure leaves the others to go on: its sites keep the image they have.
        ctx.warn(`${siteImage(v)}: ${err instanceof Error ? err.message : String(err)}`);
        failed.push(v);
        continue;
      }
      const after = await docker.imagePhpVersion(siteImage(v));
      ctx.info(after && after !== before ? `${siteImage(v)}: PHP ${before ?? 'unknown'} → ${after}` : `${siteImage(v)}: PHP ${after ?? 'unknown'}, newer packages`);
      moved.push(v);
    }
    if (moved.length > 0) {
      const state = this.state();
      for (const v of moved) state.movedAt[v] = Date.now();
      this.s.settings.setRaw(STATE_KEY, state);
    }
    const releases: Record<string, string | null> = {};
    for (const tag of await docker.imageTags(SITE_IMAGE_REPO)) {
      const v = branchOfTag(tag);
      if (v) releases[v] = await docker.imagePhpVersion(tag);
    }
    this.saveServer(handle.id, (row) => ({ ...row, releases, readAt: Date.now() }));
    if (moved.length > 0) {
      const sweep = await sweepSiteImages(this.s, this.s.worker);
      ctx.info(
        sweep.queued.length > 0
          ? `${sweep.queued.length} ${sweep.queued.length === 1 ? 'site moves' : 'sites move'} onto the new image, each in a job of its own.`
          : 'No site needed to move.',
      );
      if (sweep.busy.length > 0) ctx.info(`Busy now, and moved at the next hourly check: ${sweep.busy.join(', ')}.`);
    } else if (failed.length === 0) {
      ctx.info('Every site image here is current.');
    }
    if (failed.length > 0) throw new Error(`Could not refresh the PHP ${failed.join(', ')} image${failed.length === 1 ? '' : 's'}.`);
  }

  /** Pull the published image; true when it is a new one. */
  private async pull(ctx: JobContext<unknown>, docker: DockerPort, version: string): Promise<boolean> {
    const ref = this.publishedImage(version);
    ctx.info(`Pulling ${ref}…`);
    await docker.pullImage(ref, (line) => ctx.info(line));
    const id = await docker.imageId(ref);
    if (!id) throw new Error(`${ref} was pulled, but Docker has no image by that name.`);
    if (id === (await docker.imageId(siteImage(version)))) {
      ctx.info(`${siteImage(version)} is that image already.`);
      return false;
    }
    await docker.tagImage(id, siteImage(version));
    return true;
  }

  /** Build a new image, and keep it when something in it changed; true when it was kept. */
  private async build(ctx: JobContext<unknown>, docker: DockerPort, version: string): Promise<boolean> {
    const candidate = candidateOf(version);
    ctx.info(`Building ${siteImage(version)} on a freshly pulled ${baseImage(version)}…`);
    try {
      await docker.buildImage(candidate, this.s.config.wpImageContext, { PHP_TAG: `php${version}` }, (line) => ctx.info(line));
      const id = await docker.imageId(candidate);
      if (!id) throw new Error('The build finished, but Docker has no image by its name.');
      if (await this.sameContents(ctx, docker, candidate, siteImage(version))) {
        ctx.info(`Nothing in ${siteImage(version)} changed: it stays as it is.`);
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
  private async sameContents(ctx: JobContext<unknown>, docker: DockerPort, a: string, b: string): Promise<boolean> {
    try {
      const [one, two] = [await this.fingerprint(docker, a), await this.fingerprint(docker, b)];
      return one === two;
    } catch (err) {
      ctx.warn(`Could not compare the new image with the current one, so it is used: ${err instanceof Error ? err.message : String(err)}`);
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
   * An install on an older release of the stable channel: CI refreshes the newest release's
   * images only, so a new PHP reaches it with an update of WPL7.
   */
  private updateNeeded(): boolean {
    return !this.builds && this.s.config.channel !== 'edge' && this.s.updates.status().updateAvailable;
  }

  /**
   * Remember when each branch's newest release reached its last site, and for a recent security
   * release email how it went, once: every site on it, or the ones still behind once they have
   * had their chance.
   */
  private async settleRollouts(): Promise<void> {
    const status = this.status();
    const state = this.state();
    const now = Date.now();
    let changed = false;
    for (const branch of status.branches) {
      const latest = branch.latest;
      if (!latest || branch.sites === 0 || branch.updating) continue;
      const imagesHaveIt = branch.images.length > 0 && branch.images.every((i) => i.release !== null && compareVersions(i.release, latest.version) >= 0);
      if (!imagesHaveIt) continue;
      if (branch.behindCount === 0 && !state.doneAt[latest.version]) {
        state.doneAt[latest.version] = now;
        changed = true;
      }
      if (branch.behindCount > 0 && now - (state.movedAt[branch.branch] ?? 0) < STUCK_AFTER_MS) continue;
      if (latest.security && now - Date.parse(`${latest.date}T00:00:00Z`) < 14 * 24 * 3600_000) {
        await this.s.alerts.phpRollout(latest.version, branch.sites, branch.behind, branch.behindCount);
      }
    }
    if (changed) {
      // The newest few: nothing reads the rest.
      const kept = Object.entries(state.doneAt).sort((a, b) => b[1] - a[1]).slice(0, 12);
      this.s.settings.setRaw(STATE_KEY, { ...this.state(), doneAt: Object.fromEntries(kept) });
    }
  }

  /** What the Overview card and `GET /api/php` show. */
  status(): PhpUpdatesDto {
    const facts = this.upstream.facts();
    const state = this.state();
    const now = Date.now();
    const rows = this.siteRows();
    const servers = this.s.servers.listRows();
    const offered = this.s.settings.get('phpVersions') ?? [];
    const activeJobs = this.s.db
      .select({ type: jobs.type, siteId: jobs.siteId, lane: jobs.lane })
      .from(jobs)
      .where(and(inArray(jobs.type, ['server.refreshSiteImages', 'site.reconcile']), inArray(jobs.status, ['queued', 'running'])))
      .all();
    const refreshing = activeJobs.some((j) => j.type === 'server.refreshSiteImages');
    const reconciling = new Set(activeJobs.filter((j) => j.type === 'site.reconcile').map((j) => j.siteId));
    const branchNames = new Set<string>([...offered, ...rows.map((r) => r.phpVersion)]);
    for (const row of Object.values(state.servers)) for (const v of Object.keys(row.releases)) branchNames.add(v);
    const branches: PhpBranchDto[] = [...branchNames]
      .filter((v) => /^\d+\.\d+$/.test(v))
      .sort(compareVersions)
      .map((branch) => {
        const latest = facts.releases[branch] ?? null;
        const mine = rows.filter((r) => r.phpVersion === branch);
        const behind = latest ? mine.filter((r) => !r.phpRelease || compareVersions(r.phpRelease, latest.version) < 0) : [];
        const doneAt = latest ? (state.doneAt[latest.version] ?? null) : null;
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
          current: mine.length - behind.length,
          behind: behind
            .slice(0, BEHIND_LISTED)
            .map((r) => ({ slug: r.slug, title: r.title, release: r.phpRelease })),
          behindCount: behind.length,
          images: servers
            .filter((server) => state.servers[server.id]?.releases[branch] !== undefined)
            .map((server) => ({ serverId: server.id, serverName: server.name, release: state.servers[server.id]!.releases[branch] ?? null })),
          updating: behind.length > 0 && (refreshing || behind.some((r) => reconciling.has(r.id))),
          doneRecently: doneAt !== null && behind.length === 0 && now - doneAt < DONE_SHOWN_MS,
        };
      });
    const notice = facts.notice;
    const noticeDay = notice ? new Date(notice.publishedAt).toISOString().slice(0, 10) : '';
    const noticeOpen =
      notice !== null &&
      (notice.scheduledAt !== null ? now < notice.scheduledAt + NOTICE_AFTER_MS : now < notice.publishedAt + NOTICE_UNDATED_MS) &&
      // A security release dated since the notice is the one it was about: the card says that instead.
      !Object.values(facts.releases).some((r) => r.security && r.date >= noticeDay);
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
