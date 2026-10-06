// @docs get-started/how-it-works, help/faq, reference/architecture, sites/settings
import path from 'node:path';
import type { Config } from '../config.js';
import type { ServerRow, SiteRow } from '../db/schema.js';
import type { ContainerLimits, SiteContainerSpec } from './docker.js';
import type { DnsService } from './dns.js';
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

export const siteImage = (phpVersion: string) => `wpl7-wordpress:php${phpVersion}`;

export const WORDPRESS_CONFIG_EXTRA = [
  // Behind Traefik's TLS termination WP would otherwise see is_ssl()=false -> redirect loop.
  `if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }`,
  // WP cron is driven by the panel scheduler instead of visitor-triggered loopback requests.
  `define('DISABLE_WP_CRON', true);`,
  // The site's protection from inside (services/siteHardening.ts): a read-only file the panel
  // rewrites when the protection changes, so no container has to be rebuilt for it.
  `if (is_readable('${WP_EXTRA_IN_CONTAINER}')) { require_once '${WP_EXTRA_IN_CONTAINER}'; }`,
].join('\n');

export const DEFAULT_UPLOADS_INI = `upload_max_filesize = 64M
post_max_size = 64M
memory_limit = 256M
max_execution_time = 120
max_input_vars = 3000
`;

/**
 * Per-site container limits. Read from settings at every container build rather than
 * baked into the image or compose, so a site created today cannot end up unbounded because
 * a call site forgot to pass them (the builder requires this argument). Containers that
 * already exist are brought to a changed limit by server.applySiteLimits.
 */
export type SiteRuntime = ContainerLimits;

type RuntimeSettings = Pick<PanelSettings, 'siteCpuLimit' | 'siteMemoryLimitMb' | 'sitePidsLimit'>;

export function siteRuntimeFrom(settings: { get<K extends keyof RuntimeSettings>(key: K): RuntimeSettings[K] }): SiteRuntime {
  const cpu = Number(settings.get('siteCpuLimit') ?? 0);
  const memMb = Number(settings.get('siteMemoryLimitMb') ?? 0) || 512;
  const pids = Number(settings.get('sitePidsLimit') ?? 0);
  return {
    memoryBytes: memMb * 1024 * 1024,
    ...(cpu > 0 ? { nanoCpus: Math.round(cpu * 1e9) } : {}),
    ...(pids > 0 ? { pidsLimit: pids } : {}),
  };
}

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

export function buildSiteContainerSpec(
  config: Config,
  site: Pick<SiteRow, 'slug' | 'phpVersion' | 'dbName' | 'dbUser' | 'dbPassword' | 'containerName'>,
  domains: string[],
  /** The server this container will run on - its dev domain and wildcard decide the certificate labels. */
  server: SiteTls,
  /** Memory/CPU/pid ceilings; see siteRuntimeFrom. */
  runtime: SiteRuntime,
  /**
   * routing:false = no Traefik router at all. Used while a new site is being installed: with
   * a public router, WordPress serves its web installer to whoever reaches the hostname
   * before `wp core install` has created OUR administrator.
   */
  opts: { routing?: boolean } = {},
): SiteContainerSpec {
  const [primary, ...aliases] = domains;
  if (!primary) throw new Error('site has no domains');
  const p = sitePaths(config, site.slug);
  const routing = opts.routing ?? true;

  return {
    name: site.containerName,
    image: siteImage(site.phpVersion),
    env: {
      WORDPRESS_DB_HOST: config.mariadb.host,
      WORDPRESS_DB_NAME: site.dbName,
      WORDPRESS_DB_USER: site.dbUser,
      WORDPRESS_DB_PASSWORD: site.dbPassword,
      WORDPRESS_TABLE_PREFIX: 'wp_',
      WORDPRESS_CONFIG_EXTRA,
    },
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
          })
        : { 'traefik.enable': 'false' }),
      'wpl7.managed': 'true',
      'wpl7.site': site.slug,
      'wpl7.role': 'wordpress',
      'wpl7.php': site.phpVersion,
      'wpl7.routing': routing ? 'public' : 'none',
      [HARDENING_LABEL]: HARDENING_VERSION,
      // Traefik is attached to many networks and picks the container's IP on the one named
      // here; `--providers.docker.network` only supplies the fleet-wide default. Without
      // this label it would route to whichever endpoint it found first - in practice the
      // egress network, where inter-container traffic is dropped, so every site 502s.
      ...(routing ? { 'traefik.docker.network': siteNetworkName(site.slug) } : {}),
    },
    binds: [
      `${p.wordpress}:/var/www/html`,
      `${p.uploadsIni}:/usr/local/etc/php/conf.d/zz-site.ini:ro`,
      `${p.msmtprc}:/etc/msmtprc:ro`,
      `${p.securityApacheConf}:${APACHE_CONF_IN_CONTAINER}:ro`,
      `${p.securityDir}:${HARDENING_DIR_IN_CONTAINER}:ro`,
      // Catalog zips readable from inside every site so `wp plugin install <path>.zip` just works.
      `${config.paths.plugins}:${config.paths.plugins}:ro`,
    ],
    networks: siteNetworksFor(site.slug),
    memoryBytes: runtime.memoryBytes,
    ...(runtime.nanoCpus ? { nanoCpus: runtime.nanoCpus } : {}),
    ...(runtime.pidsLimit ? { pidsLimit: runtime.pidsLimit } : {}),
  };
}
