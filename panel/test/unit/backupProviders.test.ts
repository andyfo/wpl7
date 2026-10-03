import { describe, expect, it } from 'vitest';
import {
  BACKUP_PROVIDERS,
  destinationPayloadSchema,
  destinationProblems,
  pathProblem,
  providerByKey,
  rcloneRemoteFor,
  remoteJoin,
  remotePathFor,
  secretFieldKeys,
} from '../../shared/backupProviders.js';
import { redactorFor } from '../../src/services/offsite.js';

/** Every preset, with a configuration complete enough to be stored. */
const FIXTURES: {
  provider: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  expectRoot: string;
  expectEnv: Record<string, string>;
}[] = [
  {
    provider: 's3',
    config: { accessKeyId: 'AKIA1', region: 'eu-central-1', bucket: 'ceo-backups', prefix: 'panel.example.com' },
    secrets: { secretAccessKey: 's3cret' },
    expectRoot: 'DEST:ceo-backups/panel.example.com',
    expectEnv: {
      RCLONE_CONFIG_DEST_TYPE: 's3',
      RCLONE_CONFIG_DEST_PROVIDER: 'AWS',
      RCLONE_CONFIG_DEST_NO_CHECK_BUCKET: 'true',
      RCLONE_CONFIG_DEST_ACCESS_KEY_ID: 'AKIA1',
      RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY: 's3cret',
      RCLONE_CONFIG_DEST_REGION: 'eu-central-1',
    },
  },
  {
    provider: 's3-compatible',
    config: {
      vendor: 'r2',
      endpoint: 'acct.r2.cloudflarestorage.com',
      accessKeyId: 'r2key',
      region: 'auto',
      bucket: 'bucket',
      prefix: 'p',
    },
    secrets: { secretAccessKey: 'r2secret' },
    expectRoot: 'DEST:bucket/p',
    expectEnv: {
      RCLONE_CONFIG_DEST_TYPE: 's3',
      RCLONE_CONFIG_DEST_PROVIDER: 'Cloudflare',
      RCLONE_CONFIG_DEST_ENDPOINT: 'acct.r2.cloudflarestorage.com',
    },
  },
  {
    provider: 'sftp',
    config: { host: 'store.example.com', port: '2222', user: 'backup', path: 'ceo/backups' },
    secrets: { keyPem: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n' },
    expectRoot: 'DEST:ceo/backups',
    expectEnv: {
      RCLONE_CONFIG_DEST_TYPE: 'sftp',
      RCLONE_CONFIG_DEST_HOST: 'store.example.com',
      RCLONE_CONFIG_DEST_PORT: '2222',
      RCLONE_CONFIG_DEST_USER: 'backup',
      RCLONE_CONFIG_DEST_KEY_PEM: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n',
    },
  },
  {
    provider: 'ftp',
    config: { host: 'ftp.example.com', port: '21', user: 'u', tls: 'explicit', path: 'backups' },
    secrets: { pass: 'ftppw' },
    expectRoot: 'DEST:backups',
    expectEnv: { RCLONE_CONFIG_DEST_TYPE: 'ftp', RCLONE_CONFIG_DEST_EXPLICIT_TLS: 'true' },
  },
  {
    provider: 'webdav',
    config: { url: 'https://cloud.example.com/dav', vendor: 'nextcloud', user: 'u', path: 'backups' },
    secrets: { pass: 'davpw' },
    expectRoot: 'DEST:backups',
    expectEnv: {
      RCLONE_CONFIG_DEST_TYPE: 'webdav',
      RCLONE_CONFIG_DEST_URL: 'https://cloud.example.com/dav',
      RCLONE_CONFIG_DEST_VENDOR: 'nextcloud',
    },
  },
  {
    provider: 'rclone',
    config: { type: 'b2', path: 'bucket/prefix', account: '00123' },
    secrets: { key: 'b2key' },
    expectRoot: 'DEST:bucket/prefix',
    expectEnv: {
      RCLONE_CONFIG_DEST_TYPE: 'b2',
      RCLONE_CONFIG_DEST_ACCOUNT: '00123',
      RCLONE_CONFIG_DEST_KEY: 'b2key',
    },
  },
];

const envMap = (env: string[]) =>
  Object.fromEntries(env.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

describe('provider catalog -> rclone environment', () => {
  it.each(FIXTURES)('maps $provider onto the right remote', (fixture) => {
    const remote = rcloneRemoteFor(fixture.provider, fixture.config, fixture.secrets);
    expect(remote.root).toBe(fixture.expectRoot);
    expect(envMap(remote.env)).toMatchObject(fixture.expectEnv);
  });

  it('every preset is exercised above', () => {
    expect(FIXTURES.map((f) => f.provider).sort()).toEqual(BACKUP_PROVIDERS.map((p) => p.key).sort());
  });

  it('obscures the passwords rclone expects obscured, inside the container', () => {
    // The panel never reimplements rclone's obscure encoding: the raw value rides in under
    // its own name and rclone converts it in the prelude.
    const remote = rcloneRemoteFor('ftp', FIXTURES[3]!.config, { pass: 'ftppw' });
    const env = envMap(remote.env);
    expect(env.WPL7_OBSCURE_PASS).toBe('ftppw');
    expect(env.RCLONE_CONFIG_DEST_PASS).toBeUndefined();
    expect(remote.prelude.join('\n')).toContain('rclone obscure "$WPL7_OBSCURE_PASS"');
  });

  it('pins an SFTP host key through a known_hosts file rather than trusting anything', () => {
    const remote = rcloneRemoteFor(
      'sftp',
      { ...FIXTURES[2]!.config, hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5' },
      {},
    );
    expect(envMap(remote.env).WPL7_SFTP_HOST_KEY).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5');
    expect(remote.prelude.join('\n')).toContain('KNOWN_HOSTS_FILE=/tmp/known_hosts');
  });

  it('never puts a secret anywhere but the environment', () => {
    for (const fixture of FIXTURES) {
      const remote = rcloneRemoteFor(fixture.provider, fixture.config, fixture.secrets);
      const secretValues = Object.values(fixture.secrets);
      // The root is what ends up on the rclone command line.
      for (const value of secretValues) expect(remote.root).not.toContain(value);
      for (const line of remote.prelude) {
        for (const value of secretValues) expect(line).not.toContain(value);
      }
    }
  });

  it('turns implicit FTP TLS into the other rclone flag, and "none" into neither', () => {
    const implicit = envMap(rcloneRemoteFor('ftp', { ...FIXTURES[3]!.config, tls: 'implicit' }, {}).env);
    expect(implicit.RCLONE_CONFIG_DEST_TLS).toBe('true');
    expect(implicit.RCLONE_CONFIG_DEST_EXPLICIT_TLS).toBeUndefined();
    const none = envMap(rcloneRemoteFor('ftp', { ...FIXTURES[3]!.config, tls: 'none' }, {}).env);
    expect(none.RCLONE_CONFIG_DEST_TLS).toBeUndefined();
    expect(none.RCLONE_CONFIG_DEST_EXPLICIT_TLS).toBeUndefined();
  });
});

describe('remote layout', () => {
  it('mirrors the local tree so a bucket browser is enough to identify a backup', () => {
    expect(remotePathFor('s3', FIXTURES[0]!.config, 'shop', '20260920-030000')).toBe(
      'ceo-backups/panel.example.com/shop/20260920-030000',
    );
    // No prefix is legal: everything just hangs off the bucket.
    expect(remotePathFor('s3', { bucket: 'b' }, 'shop', 'ts')).toBe('b/shop/ts');
  });
});

describe('validation', () => {
  it('rejects traversal and odd characters in paths', () => {
    expect(pathProblem('../etc', 'The path prefix')).toMatch(/cannot contain/);
    expect(pathProblem('/leading', 'The path prefix')).toMatch(/must be relative/);
    expect(pathProblem('trailing/', 'The path prefix')).toMatch(/must not end/);
    expect(pathProblem('a b', 'The path prefix')).toMatch(/may only contain/);
    expect(pathProblem('panel.example.com/site_1', 'The path prefix')).toBeNull();
    expect(pathProblem('', 'The path prefix')).toBeNull();
  });

  it('names the missing required field for each preset', () => {
    expect(destinationProblems('s3', { bucket: 'b' }, {})).toContain('Access key ID is required.');
    expect(destinationProblems('s3', FIXTURES[0]!.config, {})).toContain('Secret access key is required.');
    // …unless it is already on file, which is what makes editing without retyping work.
    expect(destinationProblems('s3', FIXTURES[0]!.config, {}, ['secretAccessKey'])).toEqual([]);
  });

  it('accepts either an SFTP password or a key, and insists on one of them', () => {
    const base = { host: 'h', user: 'u', path: 'p' };
    expect(destinationProblems('sftp', base, {})).toContain('Give either a password or a private key.');
    expect(destinationProblems('sftp', base, { pass: 'x' })).toEqual([]);
    expect(destinationProblems('sftp', base, { keyPem: 'x' })).toEqual([]);
  });

  it('refuses to write into the root of a server account', () => {
    expect(destinationProblems('webdav', { url: 'u', user: 'u', path: '' }, { pass: 'p' })).toContain(
      'The remote directory cannot be empty — writing straight into the account root is never what you want.',
    );
  });

  it('insists a custom rclone backend type looks like one', () => {
    expect(destinationProblems('rclone', { type: 'Not A Type', path: 'p' }, {})).toContain(
      'The rclone backend type must be a plain lower-case identifier, e.g. "b2".',
    );
  });

  it('reports an unknown provider instead of silently accepting it', () => {
    expect(destinationProblems('dropbox-ish', {}, {})).toEqual(['Unknown provider "dropbox-ish".']);
  });
});

describe('schemas derived from the catalog', () => {
  const schema = destinationPayloadSchema();

  it('accepts each preset and rejects fields it does not define', () => {
    for (const fixture of FIXTURES) {
      expect(schema.safeParse({ provider: fixture.provider, config: fixture.config, secrets: fixture.secrets }).success)
        .toBe(true);
    }
    const strayField = schema.safeParse({ provider: 's3', config: { bucket: 'b', nonsense: 'x' }, secrets: {} });
    expect(strayField.success).toBe(false);
  });

  it('lets the custom rclone preset carry arbitrary keys, because that is the point', () => {
    const res = schema.safeParse({
      provider: 'rclone',
      config: { type: 'b2', path: 'p', hard_delete: 'true' },
      secrets: { key: 'k' },
    });
    expect(res.success).toBe(true);
  });

  it('knows which fields are secret, which is all the API ever reveals', () => {
    expect(secretFieldKeys('s3')).toEqual(['secretAccessKey']);
    expect(secretFieldKeys('sftp')).toEqual(['pass', 'keyPem']);
    expect(providerByKey('sftp')!.fields.find((f) => f.key === 'host')!.secret).toBeUndefined();
  });
});

describe('crypt wrapping', () => {
  const base = FIXTURES[0]!;

  it('anchors the crypt remote at the bucket and prefix, which stay literal', () => {
    const remote = rcloneRemoteFor(base.provider, base.config, base.secrets, {
      password: 'pw-abcdefghij',
      salt: 'salt-abcdefghij',
    });
    const env = envMap(remote.env);
    expect(env.RCLONE_CONFIG_CRYPT_TYPE).toBe('crypt');
    // An S3 bucket name cannot be ciphertext, and the prefix is how two panels share a
    // bucket without colliding. Everything below it is encrypted, names included.
    expect(env.RCLONE_CONFIG_CRYPT_REMOTE).toBe('DEST:ceo-backups/panel.example.com');
    expect(env.RCLONE_CONFIG_CRYPT_DIRECTORY_NAME_ENCRYPTION).toBe('true');
    expect(remote.encrypted).toBe(true);
    expect(remote.root).toBe('CRYPT:');
  });

  it('obscures both halves in the container and neither before', () => {
    const remote = rcloneRemoteFor(base.provider, base.config, base.secrets, {
      password: 'pw-abcdefghij',
      salt: 'salt-abcdefghij',
    });
    const env = envMap(remote.env);
    expect(env.RCLONE_CONFIG_CRYPT_PASSWORD).toBeUndefined();
    expect(env.RCLONE_CONFIG_CRYPT_PASSWORD2).toBeUndefined();
    expect(env.WPL7_CRYPT_PASSWORD).toBe('pw-abcdefghij');
    expect(env.WPL7_CRYPT_SALT).toBe('salt-abcdefghij');
    const prelude = remote.prelude.join('\n');
    expect(prelude).toContain('RCLONE_CONFIG_CRYPT_PASSWORD="$(rclone obscure "$WPL7_CRYPT_PASSWORD")"');
    expect(prelude).toContain('RCLONE_CONFIG_CRYPT_PASSWORD2="$(rclone obscure "$WPL7_CRYPT_SALT")"');
  });

  it('leaves the remote untouched when no key is given, which is the default', () => {
    const remote = rcloneRemoteFor(base.provider, base.config, base.secrets);
    expect(remote.encrypted).toBe(false);
    expect(remote.root).toBe('DEST:ceo-backups/panel.example.com');
    expect(remote.env.some((l) => l.startsWith('RCLONE_CONFIG_CRYPT_'))).toBe(false);
  });

  it('wraps every preset, not just the object-storage ones', () => {
    for (const fixture of FIXTURES) {
      const remote = rcloneRemoteFor(fixture.provider, fixture.config, fixture.secrets, {
        password: 'pw-abcdefghij',
        salt: 'salt-abcdefghij',
      });
      expect(envMap(remote.env).RCLONE_CONFIG_CRYPT_REMOTE, fixture.provider).toBe(fixture.expectRoot);
    }
  });

  it('joins a path onto a bare remote without inventing a slash', () => {
    expect(remoteJoin('CRYPT:', 'shop/20260920')).toBe('CRYPT:shop/20260920');
    expect(remoteJoin('DEST:bucket/prefix', 'shop/20260920')).toBe('DEST:bucket/prefix/shop/20260920');
    expect(remoteJoin('CRYPT:', '')).toBe('CRYPT:');
  });
});

describe('redacting rclone output', () => {
  it('masks every known credential, longest first', () => {
    const redact = redactorFor(['sekrit-value-1', 'sekrit-value-12345', undefined]);
    expect(redact('using sekrit-value-12345 and sekrit-value-1 here')).toBe('using •••••• and •••••• here');
  });

  it('leaves short values alone rather than mangling every diagnostic', () => {
    // A three-character "secret" is as likely to be a substring of an ordinary word.
    expect(redactorFor(['abc'])('abcdef and a backup')).toBe('abcdef and a backup');
  });

  it('is a no-op when there is nothing to hide', () => {
    expect(redactorFor([])('connection refused')).toBe('connection refused');
  });
});
