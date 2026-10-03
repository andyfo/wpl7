/**
 * The remote destination catalog: one entry per kind of place backups can be copied to.
 *
 * Everything downstream is derived from here rather than repeated — the zod schemas the API
 * validates with, the fields the Add destination form renders, the environment an rclone
 * container is handed, and the remote path objects land under. Adding a provider is adding
 * a preset; there is no second place that has to learn about it.
 *
 * All of it is rclone underneath: one binary that speaks S3, every S3-compatible vendor,
 * SFTP, FTP/FTPS and WebDAV, brings its own retries and checksum verification, and runs as
 * a short-lived container on whichever server holds the backup — so the data never passes
 * through the panel and no server needs anything installed.
 */
import { z } from 'zod';

export type FieldKind = 'text' | 'password' | 'select' | 'number' | 'textarea';

export interface ProviderField {
  key: string;
  label: string;
  kind: FieldKind;
  /**
   * The rclone config key this maps to (`RCLONE_CONFIG_DEST_<KEY>`). Omitted for fields the
   * panel keeps for itself — `bucket` and `prefix` are part of the remote *path*, not of
   * the remote's configuration.
   */
  rcloneKey?: string;
  required?: boolean;
  /** Stored in `secrets`, never returned by the API. */
  secret?: boolean;
  /**
   * rclone stores this kind of password "obscured". The value is obscured inside the
   * container by rclone itself, so the panel never reimplements that encoding.
   */
  obscure?: boolean;
  placeholder?: string;
  hint?: string;
  default?: string;
  options?: { value: string; label: string; /** Config values prefilled when picked. */ preset?: Record<string, string> }[];
  /** Shown in red under the field when it holds this value. */
  warnWhen?: { value: string; message: string };
}

export interface ProviderPreset {
  key: string;
  label: string;
  group: 'object' | 'servers' | 'advanced';
  /** One line in the provider picker: what this is for. */
  blurb: string;
  rclone: { type: string; fixed?: Record<string, string> };
  fields: ProviderField[];
  /**
   * The path under the remote that everything for this destination lives below — a bucket
   * plus prefix for object storage, a directory for a server. Backups go into
   * `<remoteRoot>/<site>/<timestamp>`.
   */
  remoteRoot(config: Record<string, string>): string;
  /** Extra key/value config the form cannot express (custom rclone only). */
  freeform?: boolean;
}

// ---------------------------------------------------------------------------
// Shared field definitions

const prefixField: ProviderField = {
  key: 'prefix',
  label: 'Path prefix',
  kind: 'text',
  placeholder: 'panel.example.com',
  hint: 'Everything this panel writes goes under this path, so two panels can share one bucket.',
};

const pathField: ProviderField = {
  key: 'path',
  label: 'Remote directory',
  kind: 'text',
  required: true,
  placeholder: 'backups/panel.example.com',
  hint: 'Relative to the login’s home directory unless it starts with "/".',
};

const accessKeyFields: ProviderField[] = [
  { key: 'accessKeyId', label: 'Access key ID', kind: 'text', rcloneKey: 'ACCESS_KEY_ID', required: true },
  {
    key: 'secretAccessKey',
    label: 'Secret access key',
    kind: 'password',
    rcloneKey: 'SECRET_ACCESS_KEY',
    required: true,
    secret: true,
  },
];

/**
 * S3-compatible vendors worth a one-click preset. The stored value is the panel's own id,
 * not rclone's `provider` string: two vendors (Hetzner, MinIO) both map onto rclone's
 * generic "Other", so the id is what lets the form remember which one was picked.
 * `endpoint`/`region` are templates the operator completes.
 */
export const S3_VENDORS: { value: string; label: string; rcloneProvider: string; preset: Record<string, string> }[] = [
  { value: 'minio', label: 'MinIO / other', rcloneProvider: 'Other', preset: { endpoint: '', region: '' } },
  {
    value: 'b2',
    label: 'Backblaze B2 (S3 API)',
    rcloneProvider: 'Backblaze',
    preset: { endpoint: 's3.us-west-004.backblazeb2.com', region: 'us-west-004' },
  },
  {
    value: 'r2',
    label: 'Cloudflare R2',
    rcloneProvider: 'Cloudflare',
    preset: { endpoint: '<account-id>.r2.cloudflarestorage.com', region: 'auto' },
  },
  {
    value: 'wasabi',
    label: 'Wasabi',
    rcloneProvider: 'Wasabi',
    preset: { endpoint: 's3.eu-central-1.wasabisys.com', region: 'eu-central-1' },
  },
  {
    value: 'hetzner',
    label: 'Hetzner Object Storage',
    rcloneProvider: 'Other',
    preset: { endpoint: 'fsn1.your-objectstorage.com', region: 'fsn1' },
  },
  {
    value: 'spaces',
    label: 'DigitalOcean Spaces',
    rcloneProvider: 'DigitalOcean',
    preset: { endpoint: 'fra1.digitaloceanspaces.com', region: 'fra1' },
  },
  {
    value: 'scaleway',
    label: 'Scaleway',
    rcloneProvider: 'Scaleway',
    preset: { endpoint: 's3.fr-par.scw.cloud', region: 'fr-par' },
  },
];

const joinPath = (...parts: (string | undefined)[]): string =>
  parts
    .filter((p): p is string => !!p && p !== '/')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

export const BACKUP_PROVIDERS: ProviderPreset[] = [
  {
    key: 's3',
    label: 'Amazon S3',
    group: 'object',
    blurb: 'AWS S3, with an IAM key scoped to one bucket prefix.',
    // no_check_bucket keeps the key from ever needing CreateBucket: least privilege, and
    // the bucket is something the operator made deliberately anyway.
    rclone: { type: 's3', fixed: { PROVIDER: 'AWS', NO_CHECK_BUCKET: 'true' } },
    fields: [
      ...accessKeyFields,
      { key: 'region', label: 'Region', kind: 'text', rcloneKey: 'REGION', required: true, placeholder: 'eu-central-1' },
      { key: 'bucket', label: 'Bucket', kind: 'text', required: true },
      prefixField,
    ],
    remoteRoot: (c) => joinPath(c.bucket, c.prefix),
  },
  {
    key: 's3-compatible',
    label: 'S3-compatible storage',
    group: 'object',
    blurb: 'Backblaze B2, Cloudflare R2, Wasabi, Hetzner, DigitalOcean Spaces, Scaleway, MinIO…',
    rclone: { type: 's3', fixed: { NO_CHECK_BUCKET: 'true' } },
    fields: [
      {
        key: 'vendor',
        label: 'Vendor',
        kind: 'select',
        required: true,
        default: 'minio',
        options: S3_VENDORS.map((v) => ({ value: v.value, label: v.label, preset: v.preset })),
        hint: 'Fills in the endpoint pattern; adjust it to your region.',
      },
      {
        key: 'endpoint',
        label: 'Endpoint',
        kind: 'text',
        rcloneKey: 'ENDPOINT',
        required: true,
        placeholder: 's3.eu-central-1.example.com',
      },
      ...accessKeyFields,
      { key: 'region', label: 'Region', kind: 'text', rcloneKey: 'REGION', placeholder: 'auto' },
      { key: 'bucket', label: 'Bucket', kind: 'text', required: true },
      prefixField,
    ],
    remoteRoot: (c) => joinPath(c.bucket, c.prefix),
  },
  {
    key: 'sftp',
    label: 'SFTP',
    group: 'servers',
    blurb: 'Any machine you can log into over SSH.',
    rclone: { type: 'sftp' },
    fields: [
      { key: 'host', label: 'Host', kind: 'text', rcloneKey: 'HOST', required: true },
      { key: 'port', label: 'Port', kind: 'number', rcloneKey: 'PORT', default: '22' },
      { key: 'user', label: 'User', kind: 'text', rcloneKey: 'USER', required: true },
      {
        key: 'pass',
        label: 'Password',
        kind: 'password',
        rcloneKey: 'PASS',
        secret: true,
        obscure: true,
        hint: 'Leave empty when using a private key.',
      },
      {
        key: 'keyPem',
        label: 'Private key (PEM)',
        kind: 'textarea',
        rcloneKey: 'KEY_PEM',
        secret: true,
        hint: 'An OpenSSH private key. Preferred over a password.',
      },
      {
        key: 'hostKey',
        label: 'Host key',
        kind: 'text',
        placeholder: 'ssh-ed25519 AAAAC3Nz…',
        hint: 'The output of `ssh-keyscan -t ed25519 <host>` without the hostname. Pins the server.',
      },
      pathField,
    ],
    remoteRoot: (c) => c.path ?? '',
  },
  {
    key: 'ftp',
    label: 'FTP / FTPS',
    group: 'servers',
    blurb: 'Classic FTP hosting. Use TLS.',
    rclone: { type: 'ftp' },
    fields: [
      { key: 'host', label: 'Host', kind: 'text', rcloneKey: 'HOST', required: true },
      { key: 'port', label: 'Port', kind: 'number', rcloneKey: 'PORT', default: '21' },
      { key: 'user', label: 'User', kind: 'text', rcloneKey: 'USER', required: true },
      { key: 'pass', label: 'Password', kind: 'password', rcloneKey: 'PASS', required: true, secret: true, obscure: true },
      {
        key: 'tls',
        label: 'Encryption',
        kind: 'select',
        required: true,
        default: 'explicit',
        options: [
          { value: 'explicit', label: 'Explicit TLS (FTPS, recommended)' },
          { value: 'implicit', label: 'Implicit TLS (port 990)' },
          { value: 'none', label: 'None — plain FTP' },
        ],
        warnWhen: {
          value: 'none',
          message: 'Plain FTP sends the password and the backups in the clear.',
        },
      },
      pathField,
    ],
    remoteRoot: (c) => c.path ?? '',
  },
  {
    key: 'webdav',
    label: 'WebDAV',
    group: 'servers',
    blurb: 'Nextcloud, ownCloud, Hetzner Storage Box and anything else speaking WebDAV.',
    rclone: { type: 'webdav' },
    fields: [
      {
        key: 'url',
        label: 'URL',
        kind: 'text',
        rcloneKey: 'URL',
        required: true,
        placeholder: 'https://cloud.example.com/remote.php/dav/files/backup',
      },
      {
        key: 'vendor',
        label: 'Server software',
        kind: 'select',
        rcloneKey: 'VENDOR',
        default: 'other',
        options: [
          { value: 'other', label: 'Other / generic' },
          { value: 'nextcloud', label: 'Nextcloud' },
          { value: 'owncloud', label: 'ownCloud' },
        ],
      },
      { key: 'user', label: 'User', kind: 'text', rcloneKey: 'USER', required: true },
      {
        key: 'pass',
        label: 'Password',
        kind: 'password',
        rcloneKey: 'PASS',
        required: true,
        secret: true,
        obscure: true,
        hint: 'For Nextcloud, generate an app password rather than using the account password.',
      },
      pathField,
    ],
    remoteRoot: (c) => c.path ?? '',
  },
  {
    key: 'rclone',
    label: 'Custom rclone remote',
    group: 'advanced',
    blurb: 'Any other rclone backend, configured by hand.',
    rclone: { type: '' },
    freeform: true,
    fields: [
      {
        key: 'type',
        label: 'rclone backend type',
        kind: 'text',
        required: true,
        placeholder: 'b2',
        hint: 'The `type =` value from an rclone.conf section (rclone.org/docs).',
      },
      pathField,
    ],
    remoteRoot: (c) => c.path ?? '',
  },
];

export function providerByKey(key: string): ProviderPreset | undefined {
  return BACKUP_PROVIDERS.find((p) => p.key === key);
}

export const providerLabel = (key: string): string => providerByKey(key)?.label ?? key;

// ---------------------------------------------------------------------------
// Validation

/** Path segments end up in a URL and in an rclone remote path; keep the charset boring. */
export const SAFE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

export function pathProblem(value: string, label: string): string | null {
  if (value === '') return null;
  if (value.includes('..')) return `${label} cannot contain "..".`;
  if (value.startsWith('/') && label === 'The path prefix') return `${label} must be relative (no leading "/").`;
  const bare = value.replace(/^\//, '');
  if (!SAFE_PATH_RE.test(bare)) return `${label} may only contain letters, digits, dots, dashes, underscores and "/".`;
  if (value.endsWith('/')) return `${label} must not end with "/".`;
  return null;
}

/**
 * A field is a capped string, whatever its widget. Required-ness is checked in
 * `destinationProblems` instead, because an edit that leaves a password untouched is
 * complete even though the body carries no value for it.
 */
const fieldSchema = (f: ProviderField) => z.string().max(f.kind === 'textarea' ? 16384 : 1024);

/**
 * One zod object per preset, discriminated on `provider`. Built from the catalog so a new
 * preset is validated the moment it is listed, with no schema to keep in step.
 */
export function destinationPayloadSchema() {
  const variants = BACKUP_PROVIDERS.map((preset) => {
    const configShape: Record<string, z.ZodType> = {};
    const secretShape: Record<string, z.ZodType> = {};
    for (const f of preset.fields) {
      (f.secret ? secretShape : configShape)[f.key] = fieldSchema(f).optional();
    }
    const config = preset.freeform
      ? z.object(configShape).catchall(z.string().max(4096))
      : z.object(configShape).strict();
    const secrets = preset.freeform
      ? z.object(secretShape).catchall(z.string().max(16384))
      : z.object(secretShape).strict();
    return z.object({
      provider: z.literal(preset.key),
      config: config.default({}),
      /** Keys omitted on update keep their stored value; an empty string clears one. */
      secrets: secrets.default({}),
    });
  });
  return z.discriminatedUnion('provider', variants as [(typeof variants)[number], ...typeof variants]);
}

/**
 * Cross-field checks the per-field schemas cannot express. `storedSecretKeys` names the
 * secrets already on file, so an edit that does not retype a password is not told it is
 * missing one.
 */
export function destinationProblems(
  provider: string,
  config: Record<string, string>,
  secrets: Record<string, string>,
  storedSecretKeys: string[] = [],
): string[] {
  const preset = providerByKey(provider);
  if (!preset) return [`Unknown provider "${provider}".`];
  const problems: string[] = [];
  const have = (key: string) => (secrets[key] ?? '') !== '' || storedSecretKeys.includes(key);

  for (const f of preset.fields) {
    if (!f.required) continue;
    if (f.secret ? !have(f.key) : !(config[f.key] ?? '').trim()) problems.push(`${f.label} is required.`);
  }
  const prefix = pathProblem(config.prefix ?? '', 'The path prefix');
  if (prefix) problems.push(prefix);
  const remotePath = pathProblem((config.path ?? '').replace(/^\//, ''), 'The remote directory');
  if (remotePath) problems.push(remotePath);
  if (preset.key === 'sftp' && !have('pass') && !have('keyPem')) {
    problems.push('Give either a password or a private key.');
  }
  if (preset.key === 'rclone' && !/^[a-z0-9]+$/.test((config.type ?? '').trim())) {
    problems.push('The rclone backend type must be a plain lower-case identifier, e.g. "b2".');
  }
  if (preset.remoteRoot(config) === '' && preset.group !== 'object') {
    problems.push('The remote directory cannot be empty — writing straight into the account root is never what you want.');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// rclone wiring

/** The remote name every command uses; nothing else ever appears in an rclone argv. */
export const RCLONE_REMOTE = 'DEST';
/** The crypt remote wrapping it, when the destination is encrypted. */
export const RCLONE_CRYPT_REMOTE = 'CRYPT';

/** The passphrase pair rclone's crypt backend needs. Generated by the panel, never derived. */
export interface CryptKey {
  password: string;
  /** rclone's `password2`: a second secret mixed into the key derivation. */
  salt: string;
}

export interface RcloneRemote {
  /** `RCLONE_CONFIG_DEST_*` (and helper) variables, as `KEY=value` strings. */
  env: string[];
  /**
   * Shell lines that must run before rclone does: obscuring passwords, materializing a
   * known_hosts file, deriving the crypt keys. Empty for most providers.
   */
  prelude: string[];
  /**
   * What commands address. `DEST:<bucket>/<prefix>` normally; `CRYPT:` when encrypted,
   * because the crypt remote is already anchored at that path and everything below it is
   * named in ciphertext. Compose paths onto it with `remoteJoin`.
   */
  root: string;
  encrypted: boolean;
}

/**
 * `<root>/<sub>`, except that a bare remote (`CRYPT:`) takes the path straight after the
 * colon. Getting this wrong is an rclone path that silently addresses the wrong directory.
 */
export const remoteJoin = (root: string, sub: string): string =>
  sub === '' ? root : root.endsWith(':') ? `${root}${sub}` : `${root}/${sub}`;

const envName = (key: string) => `RCLONE_CONFIG_${RCLONE_REMOTE}_${key}`;
const cryptEnvName = (key: string) => `RCLONE_CONFIG_${RCLONE_CRYPT_REMOTE}_${key}`;

/**
 * Turn a stored destination into the environment an rclone container needs.
 *
 * Credentials go in as environment variables of a container that lives for the length of
 * one upload: never on argv (visible in `ps` to anything on the host), never written to an
 * rclone.conf on disk. Passwords rclone expects obscured are obscured by rclone itself in
 * the prelude, so this never has to reimplement that encoding.
 */
export function rcloneRemoteFor(
  provider: string,
  config: Record<string, string>,
  secrets: Record<string, string>,
  /** Set to wrap the whole thing in rclone's `crypt` backend. Null = plaintext, the default. */
  crypt: CryptKey | null = null,
): RcloneRemote {
  const preset = providerByKey(provider);
  if (!preset) throw new Error(`Unknown backup destination provider "${provider}"`);
  const env: string[] = [];
  const prelude: string[] = [];

  const type = preset.freeform ? (config.type ?? '').trim() : preset.rclone.type;
  env.push(`${envName('TYPE')}=${type}`);
  for (const [key, value] of Object.entries(preset.rclone.fixed ?? {})) env.push(`${envName(key)}=${value}`);

  for (const f of preset.fields) {
    if (!f.rcloneKey) continue;
    const raw = (f.secret ? secrets[f.key] : config[f.key]) ?? f.default ?? '';
    if (raw === '') continue;
    if (f.obscure) {
      // The raw value rides in under its own name; rclone turns it into the obscured form
      // it expects and exports that, so the plain one never reaches the config key.
      env.push(`WPL7_OBSCURE_${f.rcloneKey}=${raw}`);
      prelude.push(`export ${envName(f.rcloneKey)}="$(rclone obscure "$WPL7_OBSCURE_${f.rcloneKey}")"`);
      continue;
    }
    env.push(`${envName(f.rcloneKey)}=${raw}`);
  }

  if (preset.freeform) {
    // Anything the operator added by hand, minus the keys the preset owns.
    const own = new Set(preset.fields.map((f) => f.key));
    for (const [key, value] of Object.entries(config)) {
      if (own.has(key) || value === '') continue;
      env.push(`${envName(key.toUpperCase())}=${value}`);
    }
    for (const [key, value] of Object.entries(secrets)) {
      if (own.has(key) || value === '') continue;
      env.push(`${envName(key.toUpperCase())}=${value}`);
    }
  }

  if (preset.key === 's3-compatible') {
    const vendor = S3_VENDORS.find((v) => v.value === (config.vendor ?? ''));
    env.push(`${envName('PROVIDER')}=${vendor?.rcloneProvider ?? 'Other'}`);
  }
  if (preset.key === 'ftp') {
    if (config.tls === 'implicit') env.push(`${envName('TLS')}=true`);
    else if (config.tls !== 'none') env.push(`${envName('EXPLICIT_TLS')}=true`);
  }
  const hostKey = (config.hostKey ?? '').trim();
  if (preset.key === 'sftp' && hostKey) {
    // Written inside the container, next to nothing else: the backup directory is bind
    // mounted read-only, and a known_hosts file is not state worth keeping anyway.
    env.push(`WPL7_SFTP_HOST_KEY=${hostKey}`);
    prelude.push(
      `printf '%s %s\\n' "$${envName('HOST')}" "$WPL7_SFTP_HOST_KEY" > /tmp/known_hosts`,
      `export ${envName('KNOWN_HOSTS_FILE')}=/tmp/known_hosts`,
    );
  }

  const plainRoot = `${RCLONE_REMOTE}:${preset.remoteRoot(config)}`;
  if (!crypt) return { env, prelude, root: plainRoot, encrypted: false };

  // The crypt remote is anchored AT the bucket+prefix (or the remote directory), so those
  // stay literal - an S3 bucket name has to be, and a shared prefix is how two panels tell
  // their objects apart. Everything below it - site names, timestamps, file names and every
  // byte of content - is encrypted before it leaves the server.
  env.push(
    `${cryptEnvName('TYPE')}=crypt`,
    `${cryptEnvName('REMOTE')}=${plainRoot}`,
    `${cryptEnvName('FILENAME_ENCRYPTION')}=standard`,
    `${cryptEnvName('DIRECTORY_NAME_ENCRYPTION')}=true`,
    // Obscured by rclone itself in the prelude, same as every other password here.
    `WPL7_CRYPT_PASSWORD=${crypt.password}`,
    `WPL7_CRYPT_SALT=${crypt.salt}`,
  );
  prelude.push(
    `export ${cryptEnvName('PASSWORD')}="$(rclone obscure "$WPL7_CRYPT_PASSWORD")"`,
    `export ${cryptEnvName('PASSWORD2')}="$(rclone obscure "$WPL7_CRYPT_SALT")"`,
  );
  return { env, prelude, root: `${RCLONE_CRYPT_REMOTE}:`, encrypted: true };
}

/** `<prefix>/<slug>/<ts>` — the remote path one backup occupies, relative to the root. */
export function remotePathFor(provider: string, config: Record<string, string>, slug: string, ts: string): string {
  const preset = providerByKey(provider);
  const root = preset ? preset.remoteRoot(config) : '';
  return joinPath(root, slug, ts);
}

/** Field keys a preset stores as secrets — what `secretsSet` in the API is built from. */
export function secretFieldKeys(provider: string): string[] {
  return (providerByKey(provider)?.fields ?? []).filter((f) => f.secret).map((f) => f.key);
}
