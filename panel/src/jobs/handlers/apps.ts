/**
 * A container app's jobs: its create (site.create's own branch), its deploys, the recreate that
 * Recreate container and a settings change run (site.reconcile's branch), and its share of start,
 * stop and delete.
 *
 * A deploy holds the app's routes (Traefik answers 503 itself, services/appRoutes.ts hold), sets
 * the old container aside with the app's stop grace, makes the new one from the image pinned by
 * digest (or the upload's id), and keeps it only once it has passed the health gate
 * (services/appProbe.ts). When anything fails, the old container gets its name back and starts
 * again, and the routes are released: a broken build never serves a request.
 */
// @docs sites/container
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appDeployOrigins, type AppDeployOrigin } from '../../../shared/schemas.js';
import { UPLOAD_ID_RE } from '../../../shared/siteFilePath.js';
import { appDeploys, appEnv, appSettings, backups, jobs as jobsTable, type AppMountRow, type AppSettingsRow, type SiteRow } from '../../db/schema.js';
import type { CoreServices } from '../../services/index.js';
import type { ServerHandle } from '../../servers/registry.js';
import type { JobContext } from '../context.js';
import { BACKUP_DELETE_LANE } from '../../services/backup.js';
import {
  appOwner,
  appPaths,
  appRows,
  buildAppContainerSpec,
  currentImageRef,
  ensureAppFolders,
  parseDataPaths,
  withImageVolumes,
} from '../../services/appSpec.js';
import {
  exposedPort,
  imageUserIds,
  loadUploaded,
  pullPinned,
  registryAuthFor,
  repositoryOfReference,
  resolveDigest,
  uploadImageName,
  uploadRepository,
  type ResolvedImage,
} from '../../services/appImages.js';
import { healthGate } from '../../services/appProbe.js';
import { ensureSiteNetwork, removeSiteNetwork } from '../../services/siteNetwork.js';
import { asideContainerName, siteRuntimeFrom } from '../../services/siteSpec.js';
import { safeJoin } from '../../lib/slug.js';
import { hasDatabase } from '../../lib/siteKind.js';
import {
  attachSiteNetwork,
  dnsPreflight,
  loadSite,
  removeSiteContainers,
  siteDomains,
  siteShouldRun,
  siteUrl,
  startSiteContainer,
  syncRelayAuth,
  updateSiteRow,
  writeSiteJson,
} from './shared.js';
import { dropAside, ensureDevDnsRecord, putBack, setAside, takeBackAside } from './sites.js';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The new container's last lines, kept with a failed deploy. */
const LOG_TAIL_LINES = 50;

/** Between two questions of the health gate; a test's world answers at once. */
const gateInterval = (s: Pick<CoreServices, 'config'>) => (s.config.nodeEnv === 'test' ? 5 : 2000);

// ---------------------------------------------------------------------------
// The image

/** Who queued the job, as a deploy row names it. */
function actorOf(s: Pick<CoreServices, 'db'>, jobId: number, origin: AppDeployOrigin): string | null {
  if (origin === 'hook') return 'hook';
  return s.db.select({ by: jobsTable.createdBy }).from(jobsTable).where(eq(jobsTable.id, jobId)).get()?.by ?? null;
}

/** A registry image, pinned and checked; an upload, renamed, loaded and checked. The upload's file goes once it is in. */
async function obtainImage(
  ctx: JobContext<unknown>,
  s: CoreServices,
  server: ServerHandle,
  site: SiteRow,
  settings: AppSettingsRow,
  want: { digest: string } | { uploadId: string } | { imageId: string },
): Promise<ResolvedImage> {
  if ('digest' in want) {
    ctx.info(`Pulling ${repositoryOfReference(settings.reference)}@${want.digest.slice(0, 19)}… on "${server.name}"`);
    return pullPinned(server, settings.reference, want.digest, registryAuthFor(settings), (line) => ctx.info(line));
  }
  if ('uploadId' in want) {
    const file = s.apps.uploadPath(want.uploadId);
    ctx.info(`Loading the uploaded image into "${server.name}"…`);
    const loaded = await loadUploaded(server, file, uploadImageName(site.slug, want.uploadId), (line) => ctx.info(line));
    if (loaded.archiveNames.length > 0) ctx.info(`The archive named it ${loaded.archiveNames.join(', ')}; it is ${uploadImageName(site.slug, want.uploadId)} here.`);
    return loaded;
  }
  // An uploaded image a roll back runs again: there is nothing to pull it from.
  const config = await server.docker.imageConfig(want.imageId);
  if (!config) throw new Error('That image is no longer on the server, and an uploaded image cannot be pulled again. Upload it again.');
  return { ref: want.imageId, digest: '', imageId: config.id || want.imageId, config };
}

/** What a container from this image runs with: the settings the image decides, unless the app has its own. */
async function settingsFromImage(
  server: ServerHandle,
  settings: AppSettingsRow,
  mounts: AppMountRow[],
  image: ResolvedImage,
): Promise<Pick<AppSettingsRow, 'port' | 'imageUid' | 'imageGid' | 'dataPaths'>> {
  let port = settings.port;
  if (port === 0) {
    const exposed = exposedPort(image.config);
    if (exposed === null) {
      throw new Error(
        image.config.exposedPorts.length === 0
          ? 'The image exposes no port, and the app has none set: give the port it listens on.'
          : `The image exposes ${image.config.exposedPorts.join(', ')}: give the port it serves on.`,
      );
    }
    port = exposed;
  }
  const ids = await imageUserIds(server, image.ref, image.config.user);
  const dataPaths = withImageVolumes(parseDataPaths(settings.dataPaths), image.config.volumes, mounts.map((m) => m.containerPath));
  return { port, imageUid: ids.uid, imageGid: ids.gid, dataPaths: JSON.stringify(dataPaths) };
}

/** Hand the app's folders to another owner, files and all: an image whose user changed. */
async function chownAppFolders(server: ServerHandle, s: Pick<CoreServices, 'config'>, site: Pick<SiteRow, 'slug'>, owner: { uid: number; gid: number }): Promise<void> {
  const p = appPaths(s.config, site.slug);
  const res = await server.exec.run('chown', ['-R', `${owner.uid}:${owner.gid}`, '--', p.data, p.mounts], { timeoutMs: 10 * 60_000 });
  if (res.exitCode !== 0) throw new Error(`Could not hand the app's folders to ${owner.uid}:${owner.gid}: ${res.stderr.trim().slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Replacing the container

/** What the new container is made of: the settings it runs with, and the image. */
export interface NextApp {
  image: string;
  settings: AppSettingsRow;
  mounts: AppMountRow[];
}

export interface ReplacedApp {
  /** When the old container went aside (stopped); null when there was none. */
  asideAt: number | null;
  /** When the new one passed its check. */
  passedAt: number;
}

/**
 * Replace an app's container with one built from `next`. The old one is the way back, as for a
 * site (handlers/sites.ts replaceContainer), stopped with the app's grace so that a worker in it
 * finishes; the new one starts on folders made for the user it runs as, and has to pass `check`.
 * `logTail` is read from the new container before a put-back removes it.
 */
export async function replaceAppContainer(
  ctx: JobContext<unknown>,
  server: ServerHandle,
  s: CoreServices,
  site: SiteRow,
  next: NextApp,
  run: boolean,
  opts: { check?: () => Promise<string | null>; onFailure?: (logTail: string) => void } = {},
): Promise<ReplacedApp> {
  const { docker } = server;
  const name = site.containerName;
  await takeBackAside(ctx, server, s, site, name, run);
  const current = appRows(s.db, site.id)!;
  const before = appOwner(current.settings);
  const after = appOwner(next.settings);
  const owned = before.uid !== after.uid || before.gid !== after.gid;
  await ensureSiteNetwork(docker, site.slug);
  const old = (await docker.containerState(name)) !== 'missing';
  const env = s.db.select().from(appEnv).where(eq(appEnv.siteId, site.id)).orderBy(appEnv.position).all();
  const spec = buildAppContainerSpec(s.config, { site, settings: next.settings, env, mounts: next.mounts, runtime: siteRuntimeFrom(s.settings, site), image: next.image });
  let asideAt: number | null = null;
  let made = false;
  try {
    await ensureAppFolders(server.files, s.config, site, next.settings, next.mounts);
    if (owned) {
      ctx.info(`The image runs as ${after.uid}:${after.gid}, not ${before.uid}:${before.gid}: handing the app's folders over…`);
      await chownAppFolders(server, s, site, after);
    }
    if (old) {
      ctx.info(`Stopping the old container (up to ${current.settings.stopGraceSec} s for it to finish)…`);
      await setAside(docker, name, current.settings.stopGraceSec);
      asideAt = Date.now();
    }
    await docker.createSiteContainer(spec);
    made = true;
    if (run) {
      // Not startSiteContainer: that makes the folders from the rows, which still hold the old settings.
      await docker.startContainer(name);
      const failed = opts.check ? await opts.check() : null;
      if (failed) throw new Error(failed);
    }
  } catch (err) {
    if (made && opts.onFailure) {
      const tail = await docker.containerLogs(name, { tail: LOG_TAIL_LINES }).catch(() => '');
      opts.onFailure(tail);
    }
    ctx.error(`The new container did not go in (${errMsg(err)}); putting the previous one back…`);
    try {
      if (old) await putBack(docker, name);
      else await docker.removeContainer(name);
      if (owned) await chownAppFolders(server, s, site, before);
      if (old && run) await startSiteContainer(server, s, site, ctx);
      if (old) ctx.info('Previous container restored.');
    } catch (restoreErr) {
      ctx.error(
        `Could not restore the previous container either: ${errMsg(restoreErr)}. ` +
          (old
            ? `It is kept, stopped, as ${asideContainerName(name)}: "Recreate container" on the app's page puts it back first.`
            : `The app has no container right now: "Recreate container" on its page makes it again.`),
      );
    }
    throw err;
  }
  if (old) await dropAside(ctx, docker, name);
  return { asideAt, passedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Images left behind

/**
 * Remove the app's images no deploy keeps: what runs and the two before it stay (AppsService
 * keptImages), as does any image a container runs or another app keeps. The nightly clean-up never
 * takes one: their repositories are not WPL7's own (services/dockerCleanup.ts).
 */
export async function cleanAppImages(
  ctx: Pick<JobContext<unknown>, 'warn' | 'info'>,
  s: CoreServices,
  server: ServerHandle,
  site: Pick<SiteRow, 'id' | 'slug'>,
  settings: Pick<AppSettingsRow, 'reference'>,
  opts: { all?: boolean } = {},
): Promise<number> {
  // With `all` the app is going: it keeps nothing, and only another app's three, or a container, keep one.
  const kept = s.apps.keptImagesOn(server.id, opts.all ? site.id : undefined);
  const inUse = new Set(await server.docker.containerImageIds());
  const repos = new Set([uploadRepository(site.slug), ...(settings.reference ? [repositoryOfReference(settings.reference)] : [])]);
  let removed = 0;
  for (const image of await server.docker.listImages()) {
    if (![...image.tags, ...image.digests].some((n) => repos.has(repositoryOfReference(n)))) continue;
    if (inUse.has(image.id) || kept.has(image.id)) continue;
    try {
      await server.docker.removeImage(image.id);
      removed++;
    } catch (err) {
      ctx.warn(`Could not remove an old image of the app (${errMsg(err)}).`);
    }
  }
  if (removed > 0) ctx.info(`Removed ${removed} old image${removed === 1 ? '' : 's'} of the app.`);
  return removed;
}

/** A deploy's own pre_update backups: the newest three stay, so automatic deploys cannot pile them up. */
function pruneDeployBackups(ctx: JobContext<unknown>, s: CoreServices, site: Pick<SiteRow, 'slug'>): void {
  const rows = s.db
    .select({ id: backups.id })
    .from(backups)
    .where(and(eq(backups.siteSlug, site.slug), eq(backups.type, 'pre_update'), eq(backups.status, 'complete')))
    .orderBy(desc(backups.createdAt), desc(backups.id))
    .all();
  const old = rows.slice(3).map((r) => r.id);
  if (old.length === 0) return;
  try {
    const job = s.worker.enqueue('backup.delete', { backupIds: old, parentJobId: ctx.jobId }, undefined, { lane: BACKUP_DELETE_LANE, siteSlug: site.slug });
    ctx.info(`${old.length} older pre-deploy backup${old.length === 1 ? ' goes' : 's go'} next: job #${job.id}.`);
  } catch (err) {
    ctx.warn(`Could not queue the removal of older pre-deploy backups (${errMsg(err)}).`);
  }
}

// ---------------------------------------------------------------------------
// site.create, for an app

export async function createApp(ctx: JobContext<{ siteId: number; uploadId?: string }>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId, { app: 'container' });
  const server = s.servers.handleFor(site.serverId);
  const domains = siteDomains(site);
  const url = siteUrl(s.config, domains[0]!);
  const p = appPaths(s.config, site.slug);
  const startedAt = Date.now();
  let releaseRoutes: (() => void) | null = null;
  const uploadId = ctx.payload.uploadId;
  try {
    ctx.info(`Creating container app "${site.slug}" at ${url} on server "${server.name}"`);
    await ensureDevDnsRecord(ctx, s, server, site.devHostname);
    await dnsPreflight(s.config, server.row, domains, ctx);
    ctx.checkCanceled();

    // Every undo is armed before the step it undoes, as for any site (handlers/sites.ts siteCreate).
    ctx.pushCompensation('remove site directory', async () => {
      await server.files.rm(safeJoin(s.config.paths.sites, site.slug));
    });
    await server.files.mkdirp(p.root);
    await writeSiteJson(server, s.config, site);

    ctx.info('Creating the site network…');
    ctx.pushCompensation('remove site network', () => removeSiteNetwork(server.docker, site.slug));
    await attachSiteNetwork(ctx, server, site.slug);

    if (hasDatabase(site)) {
      ctx.info(`Creating database ${site.dbName}…`);
      ctx.pushCompensation('drop database and user', () => server.dbAdmin.dropSiteDb(site.dbName, site.dbUser));
      await server.dbAdmin.createSiteDb(site.dbName, site.dbUser, site.dbPassword);
      ctx.checkCanceled();
    }

    let settings = s.apps.settingsOf(site.id);
    const want = uploadId ? { uploadId } : { digest: await resolveDigest(server, settings.reference, registryAuthFor(settings)) };
    ctx.pushCompensation('remove the image', () => cleanAppImages(ctx, s, server, site, settings, { all: true }).then(() => undefined));
    const image = await obtainImage(ctx, s, server, site, settings, want);
    ctx.checkCanceled();
    const mounts = appRows(s.db, site.id)!.mounts;
    const fromImage = await settingsFromImage(server, settings, mounts, image);
    s.db
      .update(appSettings)
      .set({ ...fromImage, digest: image.digest, imageId: image.imageId, updatedAt: Date.now() })
      .where(eq(appSettings.siteId, site.id))
      .run();
    settings = s.apps.settingsOf(site.id);
    const owner = appOwner(settings);
    ctx.info(`The image listens on port ${settings.port} and runs as ${owner.uid}:${owner.gid}.`);

    // Before the container starts: an app that sends mail at its first start needs its login.
    ctx.info('Registering the app with the mail relay…');
    await syncRelayAuth(ctx, s, site.slug);

    ctx.info('Creating and starting the container…');
    ctx.pushCompensation('remove container', () => removeSiteContainers(server.docker, site.containerName));
    const env = s.db.select().from(appEnv).where(eq(appEnv.siteId, site.id)).orderBy(appEnv.position).all();
    await ensureAppFolders(server.files, s.config, site, settings, mounts);
    await server.docker.createSiteContainer(
      buildAppContainerSpec(s.config, { site, settings, env, mounts, runtime: siteRuntimeFrom(s.settings, site), image: image.ref }),
    );
    await server.docker.startContainer(site.containerName);
    const failed = await healthGate(server, site, settings, { deployCheck: true, intervalMs: gateInterval(s), log: (l) => ctx.info(l), canceled: () => ctx.checkCanceled() });
    if (failed) {
      const tail = await server.docker.containerLogs(site.containerName, { tail: LOG_TAIL_LINES }).catch(() => '');
      if (tail.trim()) ctx.error(`The container's last lines:\n${tail.trimEnd()}`);
      throw new Error(failed);
    }

    // Its routes: written once the row says it runs (services/appRoutes.ts), and the file is there before the row says so to anyone else.
    releaseRoutes = s.appRoutes.pin(server.id, site.id);
    await s.appRoutes.kick(server.id);
    updateSiteRow(s.db, site.id, { status: 'running' });
    releaseRoutes();
    releaseRoutes = null;
    s.db
      .insert(appDeploys)
      .values({
        siteId: site.id,
        reference: settings.reference,
        digest: image.digest,
        imageId: image.imageId,
        startedAt,
        tookMs: Date.now() - startedAt,
        result: 'ok',
        origin: 'create',
        actor: actorOf(s, ctx.jobId, 'create'),
        jobId: ctx.jobId,
      })
      .run();
    await writeSiteJson(server, s.config, loadSite(s.db, site.id));
    if (uploadId) await removeUpload(s, uploadId);
    if (s.config.tlsMode === 'letsencrypt') ctx.info('HTTPS certificates are issued on the first request; allow up to a minute after DNS is in place.');
    ctx.setResult({ url, slug: site.slug });
    ctx.info(`Container app created: ${url}`);
  } catch (err) {
    ctx.error(`Provisioning failed: ${errMsg(err)}`);
    if (releaseRoutes) releaseRoutes();
    const clean = await ctx.runCompensations();
    if (clean) {
      const { sites } = await import('../../db/schema.js');
      s.db.delete(sites).where(eq(sites.id, site.id)).run();
      await s.mail.syncMailAuthEverywhere().catch(() => undefined);
      ctx.info('All resources rolled back; app removed.');
    } else {
      updateSiteRow(s.db, site.id, { status: 'error' });
      ctx.error('Some rollback steps failed - resolve via Delete, which is safe to repeat.');
    }
    await s.appRoutes.kick(server.id);
    throw err;
  } finally {
    if (uploadId) s.apps.releaseUpload(uploadId);
  }
}

async function removeUpload(s: CoreServices, uploadId: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(s.apps.uploadPath(uploadId), { force: true }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// app.deploy

export const appDeployPayload = z.object({
  siteId: z.number().int(),
  origin: z.enum(appDeployOrigins).default('user'),
  /** Roll back: this deploy's image again. */
  deployId: z.number().int().positive().optional(),
  /** An uploaded archive, on the panel's disk (services/apps.ts uploadPath). */
  uploadId: z.string().regex(UPLOAD_ID_RE).optional(),
  backupFirst: z.boolean().default(false),
});

export async function appDeploy(ctx: JobContext<z.infer<typeof appDeployPayload>>, s: CoreServices): Promise<void> {
  const { uploadId } = ctx.payload;
  try {
    await deploy(ctx, s);
  } finally {
    // Loaded or refused, an upload is used up: the archive is never deployed twice.
    if (uploadId) {
      s.apps.releaseUpload(uploadId);
      await removeUpload(s, uploadId);
    }
  }
}

async function deploy(ctx: JobContext<z.infer<typeof appDeployPayload>>, s: CoreServices): Promise<void> {
  const site = loadSite(s.db, ctx.payload.siteId, { app: 'container' });
  const server = s.servers.handleFor(site.serverId);
  const settings = s.apps.settingsOf(site.id);
  const { origin } = ctx.payload;
  const startedAt = Date.now();

  // 1. What to run.
  let want: { digest: string } | { uploadId: string } | { imageId: string };
  if (ctx.payload.deployId !== undefined) {
    const row = s.db.select().from(appDeploys).where(and(eq(appDeploys.id, ctx.payload.deployId), eq(appDeploys.siteId, site.id))).get();
    if (!row || row.result !== 'ok') throw new Error(`Deploy #${ctx.payload.deployId} is not one to go back to.`);
    want = row.digest ? { digest: row.digest } : { imageId: row.imageId };
    ctx.info(`Rolling back to deploy #${row.id} (${row.digest ? row.digest.slice(0, 19) : row.imageId.slice(0, 19)}…).`);
  } else if (ctx.payload.uploadId) {
    want = { uploadId: ctx.payload.uploadId };
  } else {
    if (settings.source !== 'registry') throw new Error(`"${site.slug}" runs an uploaded image: upload a new one to deploy it.`);
    ctx.info(`Asking the registry what ${settings.reference} is now…`);
    const digest = await resolveDigest(server, settings.reference, registryAuthFor(settings));
    const there = settings.imageId ? await server.docker.imageExists(settings.imageId) : false;
    const container = await server.docker.containerState(site.containerName);
    if (digest === settings.digest && there && container !== 'missing') {
      s.db.update(appSettings).set({ checkedAt: Date.now(), checkError: null, pendingDigest: '' }).where(eq(appSettings.siteId, site.id)).run();
      ctx.info(`${settings.reference} is still ${digest.slice(0, 19)}…, which runs already. Nothing to deploy.`);
      ctx.setResult({ slug: site.slug, unchanged: true, digest });
      return;
    }
    want = { digest };
  }

  const deployId = s.db
    .insert(appDeploys)
    .values({
      siteId: site.id,
      reference: settings.reference,
      digest: 'digest' in want ? want.digest : '',
      imageId: 'imageId' in want ? want.imageId : '',
      startedAt,
      result: 'running',
      origin,
      actor: actorOf(s, ctx.jobId, origin),
      jobId: ctx.jobId,
    })
    .returning({ id: appDeploys.id })
    .get().id;
  let logTail: string | null = null;
  let held = false;
  try {
    // 2. Pull or load it, and check it.
    const image = await obtainImage(ctx, s, server, site, settings, want);
    s.db.update(appDeploys).set({ digest: image.digest, imageId: image.imageId }).where(eq(appDeploys.id, deployId)).run();
    ctx.checkCanceled();
    const mounts = appRows(s.db, site.id)!.mounts;
    const fromImage = await settingsFromImage(server, settings, mounts, image);
    const next: NextApp = { image: image.ref, settings: { ...settings, ...fromImage, digest: image.digest, imageId: image.imageId }, mounts };

    // 3. A backup first, of what runs now.
    const hasContainer = (await server.docker.containerState(site.containerName)) !== 'missing';
    if (ctx.payload.backupFirst && hasContainer) {
      ctx.info('Taking a pre-deploy backup…');
      s.monitor.busySlugs.add(site.slug);
      try {
        const backup = await s.backup.create(site, 'pre_update', { jobId: ctx.jobId, log: (l, m) => ctx.log(l, m), note: `Before deploy #${deployId}` });
        ctx.info(`Pre-deploy backup #${backup.id} complete.`);
      } finally {
        s.monitor.busySlugs.delete(site.slug);
      }
      pruneDeployBackups(ctx, s, site);
    }

    // 4. Hold the routes, then the swap behind the health gate.
    const run = site.status === 'running' || (await siteShouldRun(server.docker, site));
    if (run) {
      await s.appRoutes.hold(site);
      held = true;
    } else {
      ctx.warn('The app is stopped: its new container is made, and stays stopped until it is started.');
    }
    const replaced = await replaceAppContainer(ctx, server, s, site, next, run, {
      check: () => healthGate(server, site, next.settings, { deployCheck: true, intervalMs: gateInterval(s), log: (l) => ctx.info(l), canceled: () => ctx.checkCanceled() }),
      onFailure: (tail) => {
        logTail = tail.trim() ? tail.trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n') : null;
        if (logTail) ctx.error(`The new container's last lines:\n${logTail}`);
      },
    });

    // 5. It is in.
    s.db
      .update(appSettings)
      .set({
        ...fromImage,
        digest: image.digest,
        imageId: image.imageId,
        ...(origin !== 'rollback' && settings.pendingDigest === image.digest ? { pendingDigest: '' } : {}),
        ...(origin === 'auto' || origin === 'user' || origin === 'hook' ? { checkedAt: Date.now(), checkError: null } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(appSettings.siteId, site.id))
      .run();
    const gapMs = replaced.asideAt !== null && run ? replaced.passedAt - replaced.asideAt : null;
    s.db
      .update(appDeploys)
      .set({ result: 'ok', tookMs: Date.now() - startedAt, gapMs })
      .where(eq(appDeploys.id, deployId))
      .run();
    if (held) {
      await s.appRoutes.release(site);
      held = false;
    }
    if (gapMs !== null) ctx.info(`The app answered 503 for ${(gapMs / 1000).toFixed(1)} s while its container was replaced.`);
    await cleanAppImages(ctx, s, server, site, settings);
    await writeSiteJson(server, s.config, loadSite(s.db, site.id));
    ctx.setResult({ slug: site.slug, deployId, digest: image.digest, imageId: image.imageId, gapMs });
    ctx.info(`Deployed ${image.digest ? image.digest.slice(0, 19) : image.imageId.slice(0, 19)}…`);
  } catch (err) {
    s.db
      .update(appDeploys)
      .set({ result: 'failed', tookMs: Date.now() - startedAt, error: errMsg(err).slice(0, 2000), logTail })
      .where(eq(appDeploys.id, deployId))
      .run();
    throw err;
  } finally {
    if (held) await s.appRoutes.release(site);
  }
}

// ---------------------------------------------------------------------------
// The rest of a site's jobs, for an app

/**
 * Recreate the app's container from what it runs, with its settings as they are now: Recreate
 * container, a settings change, a CPU cap taken off (site.reconcile). Behind the health gate, with
 * the routes held, as a deploy is; a registry image that is gone is pulled again by its digest.
 */
export async function reconcileApp(ctx: JobContext<unknown>, s: CoreServices, site: SiteRow): Promise<void> {
  const server = s.servers.handleFor(site.serverId);
  const rows = appRows(s.db, site.id);
  if (!rows) throw new Error(`"${site.slug}" has no settings: delete it and create it again.`);
  const { settings, mounts } = rows;
  const ref = currentImageRef(settings);
  if (!ref) throw new Error(`"${site.slug}" has never been deployed: deploy it first.`);
  ctx.info('Creating/repairing the site network…');
  await attachSiteNetwork(ctx, server, site.slug);
  ctx.info('Registering the app with the mail relay…');
  await syncRelayAuth(ctx, s, site.slug);
  if (!(await server.docker.imageExists(ref))) {
    if (settings.source !== 'registry' || !settings.digest) {
      throw new Error('The image this app runs is no longer on the server, and an uploaded image cannot be pulled again. Upload it again.');
    }
    ctx.info('The image it runs is no longer on the server: pulling it again by its digest…');
    await pullPinned(server, settings.reference, settings.digest, registryAuthFor(settings), (line) => ctx.info(line));
  }
  const run = await siteShouldRun(server.docker, site);
  if (run) await s.appRoutes.hold(site);
  try {
    ctx.info('Recreating the container…');
    await replaceAppContainer(ctx, server, s, site, { image: ref, settings, mounts }, run, {
      check: () => healthGate(server, site, settings, { deployCheck: false, intervalMs: gateInterval(s), log: (l) => ctx.info(l), canceled: () => ctx.checkCanceled() }),
      onFailure: (tail) => {
        if (tail.trim()) ctx.error(`The new container's last lines:\n${tail.trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n')}`);
      },
    });
  } finally {
    if (run) await s.appRoutes.release(site);
  }
  if (!run) ctx.warn('The app was stopped before this, so it has been left stopped. Use Start to bring it up.');
  await writeSiteJson(server, s.config, loadSite(s.db, site.id));
  await s.appRoutes.kick(server.id);
  ctx.info('Recreated.');
  ctx.setResult({ slug: site.slug, changed: ['container'] });
}

/** An app's images and its uploads, as it is deleted: after its containers, before its row. */
export async function removeAppImages(ctx: JobContext<unknown>, s: CoreServices, server: ServerHandle, site: SiteRow): Promise<void> {
  const settings = appRows(s.db, site.id)?.settings;
  if (!settings) return;
  ctx.info("Removing the app's images…");
  await cleanAppImages(ctx, s, server, site, settings, { all: true }).catch((err: unknown) => ctx.warn(`Could not remove the app's images: ${errMsg(err)}`));
}
