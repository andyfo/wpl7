import dns from 'node:dns/promises';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { sites, type ServerRow, type SiteRow } from '../../db/schema.js';
import type { Config } from '../../config.js';
import type { JobContext } from '../context.js';
import { siteScheme, type TraefikLabelOpts } from '../../services/labels.js';
import { DEFAULT_UPLOADS_INI, sitePaths } from '../../services/siteSpec.js';
import { ensureSiteNetwork } from '../../services/siteNetwork.js';
import { mailLogin, renderMsmtprc, type SenderOwner } from '../../services/mailAuth.js';
import type { CoreServices } from '../../services/index.js';
import type { FilesPort } from '../../lib/files.js';
import type { ContainerState } from '../../services/docker.js';
import type { ServerHandle } from '../../servers/registry.js';
import { httpProbe } from '../../lib/httpProbe.js';
import type { RecipeHook } from '../../../shared/recipes.js';
import type { HookVars, RecipeOutcome } from '../../services/licenses.js';

export function loadSite(db: Db, siteId: number): SiteRow {
  const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
  if (!site) throw new Error(`Site #${siteId} no longer exists`);
  return site;
}

export function siteDomains(site: SiteRow): string[] {
  return JSON.parse(site.domains) as string[];
}

export function siteUrl(config: Config, primary: string): string {
  return `${siteScheme(config.tlsMode)}://${primary}`;
}

export function updateSiteRow(db: Db, siteId: number, patch: Partial<typeof sites.$inferInsert>): void {
  db.update(sites).set({ ...patch, updatedAt: Date.now() }).where(eq(sites.id, siteId)).run();
}

export const isUnderDevDomain = (host: string, devDomain: string) =>
  host === devDomain || host.endsWith(`.${devDomain}`);

/** Warn (never fail) when a custom domain does not resolve to the site's server yet. */
export async function dnsPreflight(
  config: Config,
  server: ServerRow,
  domains: string[],
  ctx: JobContext<unknown>,
): Promise<void> {
  const expectedIp = server.publicIp;
  if (config.tlsMode === 'none' || !expectedIp) return;
  for (const domain of domains) {
    if (server.devDomain && isUnderDevDomain(domain, server.devDomain)) continue;
    try {
      const addrs = await dns.resolve4(domain);
      if (!addrs.includes(expectedIp)) {
        ctx.warn(
          `DNS check: ${domain} resolves to ${addrs.join(', ') || 'nothing'} instead of ${expectedIp}. ` +
            `TLS certificate issuance will fail until the A record points there.`,
        );
      }
    } catch {
      ctx.warn(`DNS check: could not resolve ${domain}. Point an A record at ${expectedIp} for TLS to work.`);
    }
  }
}

/**
 * The wordpress entrypoint copies core into an empty bind mount shortly after start.
 * wp-cli before that copy finishes fails confusingly, so wait for the marker files
 * (checked on the server that hosts the site).
 */
export async function waitForWordPressFiles(
  files: FilesPort,
  wordpressDir: string,
  ctx: JobContext<unknown>,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const ready = async () =>
    (await files.exists(`${wordpressDir}/wp-config.php`)) &&
    (await files.exists(`${wordpressDir}/wp-includes/version.php`));
  while (!(await ready())) {
    if (Date.now() > deadline) {
      const entries = await files.readdir(wordpressDir).catch(() => []);
      if (entries.length > 0) {
        throw new Error(
          'WordPress files did not finish copying (partial copy blocks the image entrypoint). Delete the site and retry.',
        );
      }
      throw new Error('WordPress container did not populate its files in time - check `docker logs` for the site container.');
    }
    ctx.checkCanceled();
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Probe the site, retrying for up to `timeoutMs` — Apache needs a few seconds after
 * container start. Inside the stack this hits the site container directly; otherwise it
 * goes through Traefik with the site's Host header (see lib/httpProbe for why this is
 * not `fetch`, and why a 404 counts as down).
 *
 * This gates destructive steps — the move cutover and the PHP-switch rollback — so it
 * must not be able to report success for a hostname Traefik does not actually route.
 */
export async function probeSite(
  server: ServerHandle,
  containerName: string,
  hostHeader: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  return httpProbe(server.probeUrlFor(containerName), hostHeader, timeoutMs);
}

export async function writeSiteJson(server: ServerHandle, config: Config, site: SiteRow): Promise<void> {
  const p = sitePaths(config, site.slug);
  const manifest = {
    slug: site.slug,
    title: site.title,
    domains: JSON.parse(site.domains),
    devHostname: site.devHostname,
    phpVersion: site.phpVersion,
    locale: site.locale,
    status: site.status,
    dbName: site.dbName,
    dbUser: site.dbUser,
    containerName: site.containerName,
    serverId: site.serverId,
    updatedAt: new Date().toISOString(),
  };
  await server.files.mkdirp(p.root);
  await server.files.writeFile(p.siteJson, JSON.stringify(manifest, null, 2));
}

/**
 * Write the site's msmtp configuration: its own relay login and password. Without it the
 * container has no way to authenticate and `wp_mail()` stops working, so this runs on
 * every path that builds or repairs a site.
 *
 * A site with no credential still gets the file (see renderMsmtprc) - it is a bind mount
 * source, and a missing one costs the site its container, not just its mail.
 *
 * Mode 0644 because msmtp reads it as uid 33 inside the container. The file sits in the
 * site's own directory, which no other site container mounts, and the credential it holds
 * authorizes exactly one thing: sending as this site's own domains.
 */
export async function writeSiteRelayConfig(
  server: ServerHandle,
  config: Config,
  site: Pick<SiteRow, 'slug' | 'mailPassword'>,
  ctx?: Pick<JobContext<unknown>, 'warn'>,
): Promise<void> {
  const p = sitePaths(config, site.slug);
  if (!site.mailPassword) {
    ctx?.warn(`Site "${site.slug}" has no relay credential yet; wp_mail() will not send until it is reconciled.`);
  }
  await server.files.mkdirp(p.configDir);
  await server.files.writeFile(p.msmtprc, renderMsmtprc(mailLogin(site.slug), site.mailPassword ?? null), {
    mode: 0o644,
  });
}

/** What the mount helpers need: where the files go, and the protection they carry. */
export type MountServices = Pick<CoreServices, 'config' | 'security'>;

/**
 * Make every file the site container bind-mounts exist, as a file, before Docker is asked
 * to run it.
 *
 * A bind whose source is missing is not an error to Docker: it CREATES the source, as a
 * directory. The image has a regular file at each of these paths, so the container then
 * fails with "not a directory" - and the directory Docker just made is still there, so
 * every later attempt fails identically, including the rollback that is supposed to put the
 * working container back. One site missing its msmtprc (created before per-site mail auth,
 * or restored from an archive older than it) therefore turns a routine action into a site
 * with no container at all, and no way out through the panel.
 *
 * Binds are resolved when the container STARTS, not only when it is created, so guarding
 * the create paths alone is not enough: plain Start puts the directory straight back, which
 * also undoes a by-hand `rm -rf`. Every start goes through startSiteContainer for that
 * reason.
 *
 * So: repair the directory if one is there, then (re)write the contents. Cheap enough to
 * run before every start, which is the only placement that actually holds - a call site
 * that forgets is a site that can be destroyed by a routine action. The same placement is
 * what makes the site's hardening files (services/siteHardening.ts) follow its protection
 * as it is now, whatever an older archive or a move brought along.
 */
export async function ensureSiteMountSources(
  server: ServerHandle,
  s: MountServices,
  site: Pick<SiteRow, 'id' | 'slug' | 'mailPassword'>,
  ctx?: Pick<JobContext<unknown>, 'warn'>,
): Promise<void> {
  const p = sitePaths(s.config, site.slug);
  await server.files.mkdirp(p.configDir);

  for (const bind of [p.uploadsIni, p.msmtprc, p.securityApacheConf]) {
    if (await server.files.isDirectory(bind)) {
      ctx?.warn(`Removing the empty directory Docker created at ${bind} in place of the file it mounts.`);
      await server.files.rm(bind);
    }
  }

  // Only written when absent: the PHP ini is the one file here an operator may have edited.
  if (!(await server.files.exists(p.uploadsIni))) await server.files.writeFile(p.uploadsIni, DEFAULT_UPLOADS_INI);
  await writeSiteRelayConfig(server, s.config, site, ctx);
  await s.security.prepareHardening(server, site);
}

/**
 * Should the site's container be running once this job is done?
 *
 * Only `exited` means "was running and was deliberately stopped" - the one intent a job
 * that recreates a container has to preserve. `created` means it has never run: it was
 * built and never started, or its start failed. There is nothing to preserve there, so the
 * registry's own status decides, exactly as for a container that is missing entirely.
 *
 * Reading `created` as `exited` is what left a site 404ing after a repair job: the failed
 * start had parked the container in `created`, the job read that as "stopped on purpose",
 * rebuilt it perfectly and then left it down, reporting success.
 */
export function shouldSiteRun(state: ContainerState, site: Pick<SiteRow, 'status'>): boolean {
  if (state === 'running') return true;
  if (state === 'exited') return false;
  return site.status === 'running';
}

/** A site, as much of it as the mount helpers need. */
type StartableSite = Pick<SiteRow, 'id' | 'slug' | 'mailPassword' | 'containerName'>;

/**
 * Start a site container, having first made the files it bind-mounts exist.
 *
 * Use this for EVERY site start - `docker.startContainer` directly is what let a plain
 * Start recreate the directory it was failing on. See ensureSiteMountSources.
 */
export async function startSiteContainer(
  server: ServerHandle,
  s: MountServices,
  site: StartableSite,
  ctx?: Pick<JobContext<unknown>, 'warn'>,
): Promise<void> {
  await ensureSiteMountSources(server, s, site, ctx);
  await server.docker.startContainer(site.containerName);
}

/** Restart, with the same guard: a restart re-resolves the binds exactly as a start does. */
export async function restartSiteContainer(
  server: ServerHandle,
  s: MountServices,
  site: StartableSite,
  ctx?: Pick<JobContext<unknown>, 'warn'>,
): Promise<void> {
  await ensureSiteMountSources(server, s, site, ctx);
  await server.docker.restartContainer(site.containerName);
}

/** Create/repair the site's network and report infrastructure that could not be attached. */
export async function attachSiteNetwork(
  ctx: Pick<JobContext<unknown>, 'warn'>,
  server: ServerHandle,
  slug: string,
): Promise<void> {
  const { missing } = await ensureSiteNetwork(server.docker, slug);
  if (missing.length > 0) {
    ctx.warn(
      `Not attached to the site network (not running on this server): ${missing.join(', ')}. ` +
        `The panel re-attaches them automatically once they are up.`,
    );
  }
}

/** Push the relay's logins and sender map to every server, reporting the ones it could not reach. */
export async function syncRelayAuth(
  ctx: Pick<JobContext<unknown>, 'warn'>,
  s: CoreServices,
  slug?: string,
  extraOwners?: SenderOwner[],
): Promise<void> {
  const results = await s.mail
    .syncMailAuthEverywhere({
      ...(slug ? { forceLogins: [mailLogin(slug)] } : {}),
      ...(extraOwners?.length ? { extraOwners } : {}),
    })
    .catch((err: unknown) => {
      ctx.warn(`Mail relay registration failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
  for (const failed of results.filter((r) => !r.ok)) {
    ctx.warn(`Mail relay not updated on "${failed.name}": ${failed.detail}`);
  }
}

/** Traefik label context for a site on a given server (devDomain/dnsProvider are per-server). */
export function labelOptsFor(
  config: Config,
  server: ServerRow,
): Pick<TraefikLabelOpts, 'tlsMode' | 'acmeResolver' | 'devDomain' | 'dnsProvider'> {
  return {
    tlsMode: config.tlsMode,
    acmeResolver: config.acmeResolver,
    devDomain: server.devDomain,
    dnsProvider: server.dnsProvider,
  };
}

/**
 * Run a plugin-recipe hook for a site (services/licenses.ts) and put what came of it in
 * the job log. Never fails the job: a vendor's licensing server being down, or a key that
 * turns out wrong, is a warning in the middle of creating or moving a site, not a reason
 * to abandon it - the site page has an "Activate" button for afterwards.
 */
export async function runLicenseHook(
  ctx: JobContext<unknown>,
  s: CoreServices,
  server: ServerHandle,
  site: SiteRow,
  hook: RecipeHook,
  vars: HookVars,
  opts: { only?: string } = {},
): Promise<RecipeOutcome[]> {
  try {
    return await s.licenses.runHook(server, site, hook, vars, { info: (m) => ctx.info(m), warn: (m, w) => ctx.warn(m, w) }, opts);
  } catch (err) {
    ctx.warn(
      `Plugin recipes could not run (${err instanceof Error ? err.message : String(err)}); ` +
        "activate licenses from the site's WordPress tab once it is up.",
    );
    return [];
  }
}
