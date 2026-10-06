// @docs help/support, reference/third-party, security/privacy
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync as fsExistsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PANEL_PORT: z.coerce.number().int().default(3000),
  SRV_ROOT: z.string().default('/srv'),
  TLS_MODE: z.enum(['letsencrypt', 'staging', 'none']).default('letsencrypt'),
  ACME_RESOLVER: z.enum(['letsencrypt', 'letsencrypt-staging']).default('letsencrypt'),
  PANEL_DOMAIN: z.string().default(''),
  DEV_DOMAIN: z.string().default(''),
  DNS_PROVIDER: z.string().default(''),
  CF_DNS_API_TOKEN: z.string().default(''),
  HETZNER_API_KEY: z.string().default(''),
  DO_AUTH_TOKEN: z.string().default(''),
  SERVER_PUBLIC_IP: z.string().default(''),
  DOCKER_PROXY_NETWORK: z.string().default('wpl7_proxy'),
  DOCKER_DB_NETWORK: z.string().default('wpl7_db'),
  MARIADB_HOST: z.string().default('mariadb'),
  MARIADB_ROOT_PASSWORD: z.string().default(''),
  PANEL_SESSION_SECRET: z.string().default(''),
  PANEL_ADMIN_USER: z.string().default('admin'),
  PANEL_ADMIN_PASSWORD: z.string().default(''),
  SMTP_RELAYHOST: z.string().default(''),
  BACKUP_CRON: z.string().default('0 3 * * *'),
  BACKUP_RETENTION: z.coerce.number().int().default(10),
  /**
   * Where server 1's backups live, when that is not `<SRV_ROOT>/backups`. Optional, and
   * only needed because the panel container can only see what compose mounts into it:
   * `deploy/docker-compose.backup-root.yml` bind-mounts this path at the identical path
   * so the panel can write there and hand it to the Docker API as a bind source. Worker
   * servers need nothing here - their root is set per server in the panel.
   */
  BACKUP_ROOT: z.string().default(''),
  WP_DEFAULT_PHP: z.string().default('8.3'),
  WP_PHP_VERSIONS: z.string().default('8.2,8.3,8.4,8.5'),
  WP_DEFAULT_LOCALE: z.string().default('en_US'),
  WP_DEFAULT_PLUGINS: z.string().default(''),
  /** Docker build context for the wpl7-wordpress image (baked into the panel image). */
  WP_IMAGE_CONTEXT: z.string().default(''),
  // What this install runs and where it looks for newer versions. WPL7_VERSION and
  // WPL7_GIT_SHA are NOT here: they are baked into the image (src/lib/version.ts), because
  // a value compose could pass would be a value compose could get wrong.
  WPL7_CHANNEL: z.enum(['stable', 'edge']).default('stable'),
  WPL7_SOURCE: z.enum(['image', 'build']).default('image'),
  WPL7_REPO: z.string().default('andyfo/wpl7'),
  /** The tag this install's images were published under - the version for a release, the
   *  moving `edge` for the rolling build. Needed to provision a WORKER: that machine has no
   *  checkout and no release of its own, so the panel's is the only one it can be given. */
  WPL7_IMAGE_TAG: z.string().default(''),
  /** Registry repository the site images came from, when this install overrides the
   *  upstream default (a fork publishes its own). Empty means "setup.sh's own default". */
  WPL7_WORDPRESS_IMAGE: z.string().default(''),
  /** An SFTPGo image to run as it is - a mirror, a test build - instead of the one this version builds. */
  WPL7_SFTPGO_IMAGE: z.string().default(''),
  /** Read-only, optional. Only needed while the repository is private - and it is what
   *  makes the hourly check free of GitHub's per-address rate limit. */
  WPL7_GITHUB_TOKEN: z.string().default(''),
  /**
   * Where this project's community lives. The About and Support pages link it, and "a question
   * or an idea" in the feedback dialog is posted to `<this>/feedback`. A fork with a community of
   * its own points here instead; a fork with none should empty it rather than send its
   * operators' questions to ours - the panel then offers neither the link nor the option.
   */
  WPL7_COMMUNITY_URL: z.string().default('https://wpl7.com/community'),
  /** Where this install lives ON THE HOST - provision/compose.sh exports it. The panel
   *  needs it to tell systemd which update.sh to run, and the path inside the container
   *  (/app/bundle) is not it. */
  WPL7_INSTALL_DIR: z.string().default('/opt/wpl7'),
  /**
   * The public catalog of plugin recipes the panel fetches hourly (docs/licenses.md).
   * Empty = the official one; `off` = never fetch, use only the recipes bundled with this
   * version. Any other value is a URL of an index in the same format, for a fork that
   * publishes its own - which then also needs its own public key below.
   */
  WPL7_CATALOG_URL: z.string().default(''),
  /** PEM (SPKI) Ed25519 public key the catalog index must be signed with. Empty = the official key. */
  WPL7_CATALOG_PUBLIC_KEY: z.string().default(''),
});

export const DEFAULT_CATALOG_URL = 'https://andyfo.github.io/wpl7-catalog/v1/index.json';
/** The maintainers' catalog signing key; the private half lives only in the catalog repository's CI. */
export const DEFAULT_CATALOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANTy/HTx1/8UfqSeTf7eiLDl3A4lRAokEmfAcAzMZvzg=
-----END PUBLIC KEY-----
`;

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }
  const e = parsed.data;

  if (e.NODE_ENV === 'production') {
    for (const key of ['PANEL_SESSION_SECRET', 'MARIADB_ROOT_PASSWORD', 'DEV_DOMAIN'] as const) {
      if (!e[key]) throw new Error(`${key} must be set in production`);
    }
    if (e.PANEL_SESSION_SECRET.length < 32) {
      throw new Error('PANEL_SESSION_SECRET must be at least 32 characters');
    }
  }

  const srvRoot = path.resolve(e.SRV_ROOT);
  const sftpgoImageContext = fsExistsSync('/app/sftpgo-image')
    ? '/app/sftpgo-image'
    : path.resolve(process.cwd(), '../deploy/sftpgo-image');
  // `<SFTPGo release>-wpl7.<n>`; empty when the build context is missing, which the FTP sync reports.
  const sftpgoVersion = readTrimmed(path.join(sftpgoImageContext, 'VERSION'));
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PANEL_PORT,
    srvRoot,
    tlsMode: e.TLS_MODE,
    acmeResolver: e.ACME_RESOLVER,
    panelDomain: e.PANEL_DOMAIN,
    devDomain: e.DEV_DOMAIN || 'dev.localtest.me',
    /** The provider Traefik's DNS-01 resolver uses on this server; empty means Cloudflare (deploy/docker-compose.yml). */
    dnsProvider: e.DNS_PROVIDER,
    /**
     * deploy/.env's Cloudflare token. Read once, into Settings -> DNS on the first boot that
     * finds it (db/seed.ts); from then on the panel owns the token, as it owns the backup
     * schedule, and editing .env changes nothing.
     */
    cloudflareTokenSeed: e.DNS_PROVIDER === '' || e.DNS_PROVIDER === 'cloudflare' ? e.CF_DNS_API_TOKEN.trim() : '',
    /**
     * Another provider's token (hetzner, digitalocean), which the panel does not manage: handed
     * to a worker server provisioned for the same provider, whose Traefik reads it from that
     * server's own .env.
     */
    otherDnsToken:
      e.DNS_PROVIDER === 'hetzner' ? e.HETZNER_API_KEY : e.DNS_PROVIDER === 'digitalocean' ? e.DO_AUTH_TOKEN : '',
    serverPublicIp: e.SERVER_PUBLIC_IP,
    channel: e.WPL7_CHANNEL,
    source: e.WPL7_SOURCE,
    updateRepo: e.WPL7_REPO,
    /** A fork's own, so the About and Support pages send its operators to its issues, not ours. */
    repoUrl: `https://github.com/${e.WPL7_REPO}`,
    updateToken: e.WPL7_GITHUB_TOKEN,
    imageTag: e.WPL7_IMAGE_TAG,
    wordpressImage: e.WPL7_WORDPRESS_IMAGE,
    installDir: e.WPL7_INSTALL_DIR,
    communityUrl: e.WPL7_COMMUNITY_URL.replace(/\/+$/, ''),
    proxyNetwork: e.DOCKER_PROXY_NETWORK,
    dbNetwork: e.DOCKER_DB_NETWORK,
    mariadb: {
      host: e.MARIADB_HOST,
      rootPassword: e.MARIADB_ROOT_PASSWORD,
      container: 'wpl7-mariadb',
      clientImage: 'mariadb:11.4',
    },
    /**
     * Pinned: offsite copies are the last line of defence, and "whatever :latest resolved
     * to this week" is not a property to want in one. Bumped deliberately, like mariadb.
     */
    rcloneImage: 'rclone/rclone:1.71',
    /**
     * The FTP/SFTP gateway and file servers (services/ftp.ts): SFTPGo built from
     * deploy/sftpgo-image - a pinned upstream release, distroless, with the one patch that keeps
     * a file in place while an upload replaces it. Like the site images, each server has it
     * under a local name: an install from released images pulls the published build
     * (`sftpgoPublishedImage`, which CI pushes once per VERSION) and one built from source builds
     * it on the server, from the context the panel carries (FtpService.ensureImage).
     */
    sftpgoImage: e.WPL7_SFTPGO_IMAGE || `wpl7-sftpgo:${sftpgoVersion}`,
    /** WPL7_SFTPGO_IMAGE is set: that image is pulled if missing, and never built. */
    sftpgoImagePinned: e.WPL7_SFTPGO_IMAGE !== '',
    sftpgoPublishedImage: `ghcr.io/${e.WPL7_REPO.toLowerCase()}/sftpgo:${sftpgoVersion}`,
    sftpgoImageContext,
    // Ephemeral fallback keeps `npm run dev` bootable without a .env; production requires the real secret.
    sessionSecret: e.PANEL_SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    adminUser: e.PANEL_ADMIN_USER,
    adminInitialPassword: e.PANEL_ADMIN_PASSWORD,
    mailMode: (e.SMTP_RELAYHOST ? 'smarthost' : 'direct') as 'smarthost' | 'direct',
    /** Empty = server 1 uses `paths.backups`; otherwise the path mounted by the overlay. */
    backupRoot: e.BACKUP_ROOT ? path.resolve(e.BACKUP_ROOT) : '',
    seedDefaults: {
      backupCron: e.BACKUP_CRON,
      backupRetention: e.BACKUP_RETENTION,
      defaultPhpVersion: e.WP_DEFAULT_PHP,
      phpVersions: e.WP_PHP_VERSIONS.split(',').map((v) => v.trim()).filter(Boolean),
      defaultLocale: e.WP_DEFAULT_LOCALE,
      defaultPlugins: e.WP_DEFAULT_PLUGINS.split(',').map((v) => v.trim()).filter(Boolean),
    },
    // Smoke checks retry while Apache boots; tests use a single attempt so the suite
    // never depends on whether anything is listening on 127.0.0.1:80.
    probeTimeoutMs: e.NODE_ENV === 'test' ? 0 : 30_000,
    wpImageContext:
      e.WP_IMAGE_CONTEXT ||
      (fsExistsSync('/app/wordpress-image')
        ? '/app/wordpress-image'
        : path.resolve(process.cwd(), '../deploy/wordpress-image')),
    // provision/ + deploy/ trees pushed to blank VPSes by the server-provision job.
    provisionBundle: fsExistsSync('/app/bundle') ? '/app/bundle' : path.resolve(process.cwd(), '..'),
    /** The bundled catalog (plugin recipes); `panel/catalog` in a checkout, baked into the image. */
    catalogDir: fsExistsSync('/app/catalog') ? '/app/catalog' : path.resolve(process.cwd(), 'catalog'),
    catalog: {
      /** null = fetching is off; only the bundled recipes are used. */
      url: e.WPL7_CATALOG_URL.trim() === 'off' ? null : e.WPL7_CATALOG_URL.trim() || DEFAULT_CATALOG_URL,
      // A PEM pasted into an env file tends to lose its line breaks; a single-line SPKI
      // base64 body is accepted too and re-wrapped here.
      publicKeyPem: normalizePem(e.WPL7_CATALOG_PUBLIC_KEY) || DEFAULT_CATALOG_PUBLIC_KEY,
    },
    paths: {
      sites: path.join(srvRoot, 'sites'),
      backups: path.join(srvRoot, 'backups'),
      plugins: path.join(srvRoot, 'plugins'),
      panel: path.join(srvRoot, 'panel'),
      dbFile: path.join(srvRoot, 'panel', 'panel.db'),
      sshDir: path.join(srvRoot, 'panel', 'ssh'),
      sshKey: path.join(srvRoot, 'panel', 'ssh', 'id_ed25519'),
      sshPubKey: path.join(srvRoot, 'panel', 'ssh', 'id_ed25519.pub'),
    },
  };
}

/** Accept a PEM with real line breaks, with literal `\n`, or just its base64 body. */
function normalizePem(raw: string): string {
  const text = raw.replace(/\\n/g, '\n').trim();
  if (!text) return '';
  if (text.includes('-----BEGIN')) return `${text}\n`;
  const body = text.replace(/\s+/g, '');
  return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)?.join('\n') ?? body}\n-----END PUBLIC KEY-----\n`;
}

function readTrimmed(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}
