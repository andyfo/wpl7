// @docs get-started/how-it-works, help/faq, reference/architecture, sites/settings
import path from 'node:path';
import type { Config } from '../config.js';
import type { ServerRow, SiteRow } from '../db/schema.js';
import { MIN_PIDS_CAP } from '../../shared/schemas.js';
import type { SiteLimits } from '../../shared/types.js';
import type { ContainerLimits, DockerPort, SiteContainerSpec } from './docker.js';
import type { DnsService } from './dns.js';
import { conflict } from '../lib/errors.js';
import { traefikLabels } from './labels.js';
import type { PanelSettings } from './settings.js';
import { siteNetworkName, siteNetworksFor } from './siteNetwork.js';
import {
  APACHE_CONF_IN_CONTAINER,
  HARDENING_DIR_IN_CONTAINER,
  HARDENING_LABEL,
  HARDENING_VERSION,
  WP_EXTRA_IN_CONTAINER,
} from './siteHardening.js';
import { RUNTIME_DIR_IN_CONTAINER, SITE_STACK_LABEL, SITE_STACK_PORT, WP_CACHE_PHP_IN_CONTAINER, type SiteStack } from './siteStack.js';

/** Where a server keeps its site images: one tag per PHP branch, `php<version>`. */
export const SITE_IMAGE_REPO = 'wpl7-wordpress';

export const siteImage = (phpVersion: string) => `${SITE_IMAGE_REPO}:php${phpVersion}`;

/**
 * The name a site's old container has, stopped, while its next one comes up: its way back
 * (jobs/handlers/sites.ts replaceContainer). The old image is no way back: Docker's containerd
 * store deletes an image when a build takes its name, even while a container runs it. With a dot,
 * which no site's container name has.
 */
export const asideContainerName = (containerName: string) => `${containerName}.previous`;

/** The site container a kept-aside one belongs to; null for any other name. */
export const containerOfAside = (name: string): string | null => (name.endsWith('.previous') ? name.slice(0, -'.previous'.length) : null);

export const WORDPRESS_CONFIG_EXTRA = [
  // Behind Traefik's TLS termination WP would otherwise see is_ssl()=false -> redirect loop.
  `if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }`,
  // WP cron is driven by the panel scheduler instead of visitor-triggered loopback requests.
  `define('DISABLE_WP_CRON', true);`,
  // The site's protection from inside (services/siteHardening.ts): a read-only file the panel
  // rewrites when the protection changes, so no container has to be rebuilt for it.
  `if (is_readable('${WP_EXTRA_IN_CONTAINER}')) { require_once '${WP_EXTRA_IN_CONTAINER}'; }`,
].join('\n');

/**
 * The same, and the WordPress side of the site's caches (services/wpCachePhp.ts). Its folder is
 * mounted read-only, so nothing in the site can change it, and no file lands in wp-content.
 */
export const WORDPRESS_CONFIG_EXTRA_STACK_2 = [
  WORDPRESS_CONFIG_EXTRA,
  `if (is_readable('${WP_CACHE_PHP_IN_CONTAINER}')) { require_once '${WP_CACHE_PHP_IN_CONTAINER}'; }`,
].join('\n');

export const DEFAULT_UPLOADS_INI = `upload_max_filesize = 64M
post_max_size = 64M
memory_limit = 256M
max_execution_time = 120
max_input_vars = 3000
`;

/**
 * Per-site container limits: the site's own, and Settings' for each it has none of. Read at
 * every container build rather than baked into the image or compose, so a site created today
 * cannot end up unbounded because a call site forgot to pass them (the builder requires this
 * argument), and none of them loses its own because a call site forgot the site. Containers
 * that already exist are brought to a changed limit by server.applySiteLimits.
 */
export type SiteRuntime = ContainerLimits;

type RuntimeSettings = Pick<PanelSettings, 'siteCpuLimit' | 'siteMemoryLimitMb' | 'sitePidsLimit'>;
type RuntimeSettingsReader = { get<K extends keyof RuntimeSettings>(key: K): RuntimeSettings[K] };

/** The limits a site sets for itself (sites.cpu_limit and the rest): null = as Settings says. */
export type OwnSiteLimits = Pick<SiteRow, 'cpuLimit' | 'memoryLimitMb' | 'pidsLimit'>;

/** For a site with no limits of its own: what Settings gives every site. */
export const NO_OWN_LIMITS: OwnSiteLimits = { cpuLimit: null, memoryLimitMb: null, pidsLimit: null };

/** Settings' limits, in the units a site's own are in. */
export function defaultSiteLimits(settings: RuntimeSettingsReader): SiteLimits<number> {
  return {
    cpuLimit: Number(settings.get('siteCpuLimit') ?? 0),
    memoryLimitMb: Number(settings.get('siteMemoryLimitMb') ?? 0) || 512,
    pidsLimit: Number(settings.get('sitePidsLimit') ?? 0),
  };
}

export function siteRuntimeFrom(settings: RuntimeSettingsReader, own: OwnSiteLimits): SiteRuntime {
  const defaults = defaultSiteLimits(settings);
  const cpu = own.cpuLimit ?? defaults.cpuLimit;
  const memMb = own.memoryLimitMb ?? defaults.memoryLimitMb;
  const pids = own.pidsLimit ?? defaults.pidsLimit;
  return {
    memoryBytes: memMb * 1024 * 1024,
    ...(cpu > 0 ? { nanoCpus: Math.round(cpu * 1e9) } : {}),
    // A limit saved before MIN_PIDS_CAP existed would put the site in a restart loop.
    ...(pids > 0 ? { pidsLimit: Math.max(pids, MIN_PIDS_CAP) } : {}),
  };
}

/** Whether a site has any limit of its own. */
export const hasOwnLimits = (own: OwnSiteLimits): boolean =>
  own.cpuLimit !== null || own.memoryLimitMb !== null || own.pidsLimit !== null;

/**
 * What it takes to bring a container from `current` to `desired`. Docker changes all three
 * ceilings on a live container but one way: an update with no CPU limit in it means "leave
 * the CPU limit as it is", so only a new container can lose a CPU cap.
 */
export function limitsChange(current: SiteRuntime, desired: SiteRuntime): 'none' | 'in-place' | 'recreate' {
  const cpu = (l: SiteRuntime) => l.nanoCpus ?? 0;
  const pids = (l: SiteRuntime) => l.pidsLimit ?? 0;
  if (current.memoryBytes === desired.memoryBytes && cpu(current) === cpu(desired) && pids(current) === pids(desired)) {
    return 'none';
  }
  return cpu(current) > 0 && cpu(desired) === 0 ? 'recreate' : 'in-place';
}

export function sitePaths(config: Config, slug: string) {
  const root = path.join(config.paths.sites, slug);
  return {
    root,
    wordpress: path.join(root, 'wordpress'),
    /** Drop-ins the panel manages itself (one-click login); loaded by WP before anything else. */
    muPlugins: path.join(root, 'wordpress', 'wp-content', 'mu-plugins'),
    configDir: path.join(root, 'config'),
    uploadsIni: path.join(root, 'config', 'uploads.ini'),
    /**
     * Bind-mounted over /etc/msmtprc. Per site rather than baked into the image because it
     * carries this site's own relay credential - which is what stops it sending as one of
     * its neighbours' domains. Readable inside the container (uid 33 has to read it to
     * send); that is not a leak, the credential authorizes only this site's own domains.
     */
    msmtprc: path.join(root, 'config', 'msmtprc'),
    /** Apache's part of the site's protection (services/siteHardening.ts). */
    securityApacheConf: path.join(root, 'config', 'security-apache.conf'),
    /** Mounted whole at /etc/wpl7, so the file in it can be replaced rather than rewritten. */
    securityDir: path.join(root, 'config', 'security'),
    securityWpPhp: path.join(root, 'config', 'security', 'wp-config-extra.php'),
    /**
     * Mounted whole at /etc/wpl7-runtime on stack 2 (services/siteStack.ts), so its files can be
     * replaced rather than rewritten, and one can come and go as the object cache does.
     */
    runtimeDir: path.join(root, 'config', 'runtime'),
    /** Files a scan or an administrator moved out of the site (services/quarantine.ts). Mounted into no site. */
    quarantine: path.join(root, 'quarantine'),
    siteJson: path.join(root, 'site.json'),
  };
}

/**
 * What decides a site's certificate on the server it runs on. Built by siteTlsFor, never from
 * the server row as it is: the row may name Cloudflare with no token there to answer for it.
 */
export interface SiteTls {
  devDomain: string;
  /** Where dev sites get the shared wildcard certificate from; '' = each gets its own. */
  wildcardProvider: string;
}

export function siteTlsFor(
  dns: Pick<DnsService, 'wildcardProvider'>,
  server: Pick<ServerRow, 'devDomain' | 'dnsProvider'>,
): SiteTls {
  return { devDomain: server.devDomain, wildcardProvider: dns.wildcardProvider(server.dnsProvider) };
}

/** On a PHP site's container: what it runs, beside `wpl7.role=wordpress`, which every site's has. */
export const SITE_APP_LABEL = 'wpl7.app';

export function buildSiteContainerSpec(
  config: Config,
  site: Pick<SiteRow, 'slug' | 'app' | 'phpVersion' | 'dbName' | 'dbUser' | 'dbPassword' | 'containerName' | 'tablePrefix'>,
  domains: string[],
  /** The server this container will run on - its dev domain and wildcard decide the certificate labels. */
  server: SiteTls,
  /** Memory/CPU/pid ceilings; see siteRuntimeFrom. */
  runtime: SiteRuntime,
  /**
   * routing:false = no Traefik router at all. Used while a new site is being installed: with
   * a public router, WordPress serves its web installer to whoever reaches the hostname
   * before `wp core install` has created OUR administrator.
   *
   * stack: what the image runs (services/siteStack.ts), which has to match it: a container needs
   * nginx's port, and the folder of runtime files, only from an image that has nginx. There is no
   * default, and only siteContainerSpec calls this: it is what knows the image.
   * image: a particular image, by tag or id, in place of the site's PHP tag.
   */
  opts: { routing?: boolean; stack: SiteStack; image?: string },
): SiteContainerSpec {
  const [primary, ...aliases] = domains;
  if (!primary) throw new Error('site has no domains');
  const p = sitePaths(config, site.slug);
  const routing = opts.routing ?? true;
  const { stack } = opts;
  // A PHP site's container gets none of WordPress's variables: the image puts WordPress into a
  // folder only for a container that has them (deploy/wordpress-image/wpl7-start).
  const wordpress = site.app !== 'php';

  return {
    name: site.containerName,
    image: opts.image ?? siteImage(site.phpVersion),
    env: wordpress
      ? {
          WORDPRESS_DB_HOST: config.mariadb.host,
          WORDPRESS_DB_NAME: site.dbName,
          WORDPRESS_DB_USER: site.dbUser,
          WORDPRESS_DB_PASSWORD: site.dbPassword,
          WORDPRESS_TABLE_PREFIX: site.tablePrefix,
          WORDPRESS_CONFIG_EXTRA: stack === 2 ? WORDPRESS_CONFIG_EXTRA_STACK_2 : WORDPRESS_CONFIG_EXTRA,
        }
      : {},
    labels: {
      ...(routing
        ? traefikLabels({
            slug: site.slug,
            primary,
            aliases,
            tlsMode: config.tlsMode,
            acmeResolver: config.acmeResolver,
            devDomain: server.devDomain,
            dnsProvider: server.wildcardProvider,
            ...(stack === 2 ? { port: SITE_STACK_PORT } : {}),
          })
        : { 'traefik.enable': 'false' }),
      'wpl7.managed': 'true',
      'wpl7.site': site.slug,
      // Every site's container, a PHP site's too: the sweeps find them by it.
      'wpl7.role': 'wordpress',
      ...(wordpress ? {} : { [SITE_APP_LABEL]: 'php' }),
      'wpl7.php': site.phpVersion,
      'wpl7.routing': routing ? 'public' : 'none',
      [HARDENING_LABEL]: HARDENING_VERSION,
      // Traefik is attached to many networks and picks the container's IP on the one named
      // here; `--providers.docker.network` only supplies the fleet-wide default. Without
      // this label it would route to whichever endpoint it found first - in practice the
      // egress network, where inter-container traffic is dropped, so every site 502s.
      ...(routing ? { 'traefik.docker.network': siteNetworkName(site.slug) } : {}),
      // No label means stack 1, so a container from before all this needs nothing added.
      ...(stack === 2 ? { [SITE_STACK_LABEL]: '2' } : {}),
    },
    binds: [
      `${p.wordpress}:/var/www/html`,
      `${p.uploadsIni}:/usr/local/etc/php/conf.d/zz-site.ini:ro`,
      `${p.msmtprc}:/etc/msmtprc:ro`,
      `${p.securityApacheConf}:${APACHE_CONF_IN_CONTAINER}:ro`,
      `${p.securityDir}:${HARDENING_DIR_IN_CONTAINER}:ro`,
      // Catalog zips readable from inside every WordPress site so `wp plugin install <path>.zip` just works.
      ...(wordpress ? [`${config.paths.plugins}:${config.paths.plugins}:ro`] : []),
      ...(stack === 2 ? [`${p.runtimeDir}:${RUNTIME_DIR_IN_CONTAINER}:ro`] : []),
    ],
    networks: siteNetworksFor(site.slug),
    memoryBytes: runtime.memoryBytes,
    ...(runtime.nanoCpus ? { nanoCpus: runtime.nanoCpus } : {}),
    ...(runtime.pidsLimit ? { pidsLimit: runtime.pidsLimit } : {}),
  };
}

/** What buildSiteContainerSpec needs to know about a site (a row, or a row with in-memory edits). */
export type SpecSite = Parameters<typeof buildSiteContainerSpec>[1];

/** What a PHP site gets on a server whose site image is older than PHP sites. */
export const phpImageRefusal = (serverName: string) =>
  conflict(`The site image on "${serverName}" is from before PHP sites. Update the server, then try again.`);

/**
 * Whether an image can run a PHP site. An older one runs WordPress only: its wpl7-start puts
 * WordPress into any folder that has none, so a PHP site's files would get a WordPress whose
 * installer anyone could run. siteContainerSpec asks this of every PHP site's container; the jobs
 * that make one ask it again before they change anything (assertPhpImage), so nothing is left half
 * done.
 */
export const imageRunsPhp = async (docker: Pick<DockerPort, 'imageApps'>, image: string): Promise<boolean> =>
  (await docker.imageApps(image)).includes('php');

/**
 * The early check, for a PHP site about to get a container from `image`: refused on an image from
 * before PHP sites. With `missingIsFine`, an image the server doesn't have yet passes: the panel
 * builds or pulls it at the panel's own version, which can.
 */
export async function assertPhpImage(
  server: { docker: Pick<DockerPort, 'imageApps' | 'imageExists'>; row: Pick<ServerRow, 'name'> },
  image: string,
  opts: { missingIsFine?: boolean } = {},
): Promise<void> {
  if (opts.missingIsFine && !(await server.docker.imageExists(image))) return;
  if (!(await imageRunsPhp(server.docker, image))) throw phpImageRefusal(server.row.name);
}

/**
 * The container a site gets on a server, from what the image there runs. Every container is built
 * through this, so none can come out with the port or the mounts of another stack: a server that
 * has not had its update yet keeps getting containers its images can run, and one that has gets the
 * new kind. The stack is read at the last moment, after ensureSiteImage if the caller runs that.
 *
 * `from` puts a particular image back, by id: what a container ran before it was replaced, whose
 * stack is known, and whose tag may have moved on since.
 */
export async function siteContainerSpec(
  s: { config: Config; dns: Pick<DnsService, 'wildcardProvider'> },
  server: { docker: Pick<DockerPort, 'imageStack' | 'imageApps'>; row: Pick<ServerRow, 'name' | 'devDomain' | 'dnsProvider'> },
  site: SpecSite,
  domains: string[],
  runtime: SiteRuntime,
  opts: { routing?: boolean; from?: { imageId: string; stack: SiteStack } } = {},
): Promise<SiteContainerSpec> {
  // The guard for a server that still has an image from before PHP sites, whichever job asked.
  if (site.app === 'php' && !(await imageRunsPhp(server.docker, opts.from?.imageId ?? siteImage(site.phpVersion)))) {
    throw phpImageRefusal(server.row.name);
  }
  const stack = opts.from?.stack ?? (await server.docker.imageStack(siteImage(site.phpVersion)));
  return buildSiteContainerSpec(s.config, site, domains, siteTlsFor(s.dns, server.row), runtime, {
    routing: opts.routing,
    stack,
    image: opts.from?.imageId,
  });
}
