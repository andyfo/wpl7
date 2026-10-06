// @docs sites/ftp-sftp
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import argon2 from 'argon2';
// The default import: ssh2 is CommonJS, and Node's ESM loader only finds `Client` and a few
// others as named exports - `utils` is not one (see servers/keys.ts, which does the same).
import ssh2 from 'ssh2';
import { sshFingerprint } from '../servers/sshConnection.js';

const sshUtils = ssh2.utils;

/**
 * Key material and passwords for FTP/SFTP logins (services/ftp.ts).
 *
 * Everything here ends up in files SFTPGo reads, so the formats are SFTPGo's: OpenSSH private
 * keys (what `golang.org/x/crypto/ssh` parses), `SHA256:` fingerprints (what its SFTP-backed
 * filesystem pins), and argon2id hashes in the exact PHC layout its verifier accepts.
 */

export type SshKeyType = 'ed25519' | 'rsa';

export interface SshKeyPair {
  /** OpenSSH format for ed25519, PKCS#1 PEM for RSA - both of which every SSH stack reads. */
  privateKey: string;
  /** One authorized_keys line: `ssh-ed25519 AAAA… comment`. */
  publicKey: string;
  /** `SHA256:<base64>`, as `ssh-keygen -lf` and every SFTP client show it. */
  fingerprint: string;
  /** The SSH algorithm name: `ssh-ed25519` or `ssh-rsa`. */
  type: string;
}

const generateRsa = promisify(crypto.generateKeyPair);

/**
 * A new key pair, from Node's own crypto - not ssh2's generator, which drops the leading
 * zero byte of an ed25519 public key that starts with one (1 in 256 keys), leaving a key no
 * SSH implementation will load. RSA is 3072-bit and generated off the event loop.
 *
 * Both formats are ones SFTPGo (`golang.org/x/crypto/ssh`) and ssh2 read: OpenSSH's own for
 * ed25519, PKCS#1 PEM for RSA.
 */
export async function newSshKeyPair(type: SshKeyType, comment: string): Promise<SshKeyPair> {
  let privateKey: string;
  if (type === 'rsa') {
    const keys = await generateRsa('rsa', { modulusLength: 3072 });
    privateKey = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  } else {
    privateKey = ed25519OpenSshKey(comment);
  }
  return { privateKey, ...sshKeyFacts(privateKey) };
}

/** An SSH wire-format string: its length as a big-endian uint32, then the bytes. */
function sshString(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** OpenSSH's unencrypted private key format (PROTOCOL.key in the OpenSSH sources). */
function ed25519OpenSshKey(comment: string): string {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pk = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const type = Buffer.from('ssh-ed25519');
  const check = crypto.randomBytes(4);
  const secret = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pk),
    sshString(Buffer.concat([seed, pk])),
    sshString(Buffer.from(comment, 'utf8')),
  ]);
  const padding = Array.from({ length: (8 - (secret.length % 8)) % 8 }, (_, i) => i + 1);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    count,
    sshString(Buffer.concat([sshString(type), sshString(pk)])),
    sshString(Buffer.concat([secret, Buffer.from(padding)])),
  ]);
  const body = blob.toString('base64').match(/.{1,70}/g)!.join('\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** The public half of a stored private key, and its fingerprint. */
export function sshKeyFacts(privateKey: string): Omit<SshKeyPair, 'privateKey'> {
  const key = sshUtils.parseKey(privateKey);
  if (key instanceof Error) throw new Error(`Unreadable SSH key: ${key.message}`);
  const blob = key.getPublicSSH();
  const comment = key.comment ? ` ${key.comment}` : '';
  return {
    publicKey: `${key.type} ${blob.toString('base64')}${comment}`,
    fingerprint: sshFingerprint(blob),
    type: key.type,
  };
}

/**
 * A generated FTP password: letters and digits only, none that are easily confused. The
 * panel's usual generator (`generatePassword`) adds `!@#%+=`, and `@`, `#` and `%` break a
 * `ftp://user:password@host` URL - which is exactly where people paste FTP credentials.
 * 24 characters of this 54-letter alphabet is ~138 bits.
 */
export function generateFtpPassword(length = 24): string {
  const charset = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  // Rejection sampling: the alphabet does not divide 256, and a plain modulo would favour
  // its first letters.
  const limit = 256 - (256 % charset.length);
  let out = '';
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < limit && out.length < length) out += charset[b % charset.length];
    }
  }
  return out;
}

/**
 * argon2id at OWASP's minimum (19 MiB, 2 passes, 1 lane) rather than the panel login's
 * 64 MiB: SFTPGo verifies this on every login attempt, and an FTP server is a far more
 * popular brute-force target than the panel. Its defender bans an address after a handful of
 * failures, and a generated password needs no stretching at all.
 */
export const FTP_ARGON2 = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashFtpPassword(password: string): Promise<string> {
  return toSftpgoArgon2(await argon2.hash(password, FTP_ARGON2));
}

/**
 * The same hash, in the parameter order SFTPGo can read.
 *
 * node-argon2 writes the PHC parameters as `m=…,p=…,t=…`; SFTPGo verifies with
 * alexedwards/argon2id, which reads them with `Sscanf("m=%d,t=%d,p=%d")` and fails on
 * anything else - so a login with the right password is refused, silently, as a wrong one.
 * The salt and the hash are unpadded base64 in both, so only the one segment moves.
 */
export function toSftpgoArgon2(phc: string): string {
  const parts = phc.split('$');
  if (parts.length !== 6 || parts[1] !== 'argon2id') throw new Error('Not an argon2id hash');
  const params = new Map(parts[3]!.split(',').map((kv) => kv.split('=') as [string, string]));
  const m = params.get('m');
  const t = params.get('t');
  const p = params.get('p');
  if (!m || !t || !p) throw new Error('argon2id hash without m, t and p');
  parts[3] = `m=${m},t=${t},p=${p}`;
  return parts.join('$');
}

/** True when SFTPGo will read `hash` (see toSftpgoArgon2). */
export function isSftpgoArgon2(hash: string): boolean {
  return /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(hash);
}
