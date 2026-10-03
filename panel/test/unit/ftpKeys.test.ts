import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import {
  FTP_ARGON2,
  generateFtpPassword,
  hashFtpPassword,
  isSftpgoArgon2,
  newSshKeyPair,
  sshKeyFacts,
  toSftpgoArgon2,
} from '../../src/services/ftpKeys.js';
import { productionArgon2Hash } from '../setup.js';

const hasSshKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // `-?` exits 1 after printing usage; only a missing binary is ENOENT.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
})();

describe('SSH key pairs', () => {
  it('mints ed25519 keys in OpenSSH format and RSA-3072 ones in PKCS#1', async () => {
    const ed = await newSshKeyPair('ed25519', 'wpl7-ftp');
    expect(ed.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
    expect(ed.type).toBe('ssh-ed25519');
    expect(ed.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ wpl7-ftp$/);
    expect(ed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    const rsa = await newSshKeyPair('rsa', 'wpl7-ftp');
    expect(rsa.privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    expect(rsa.type).toBe('ssh-rsa');
    expect(rsa.publicKey.startsWith('ssh-rsa ')).toBe(true);
  });

  it('re-derives the public half and fingerprint from the stored private key', async () => {
    const kp = await newSshKeyPair('ed25519', 'x');
    expect(sshKeyFacts(kp.privateKey)).toEqual({ publicKey: kp.publicKey, fingerprint: kp.fingerprint, type: kp.type });
    expect(() => sshKeyFacts('not a key')).toThrow(/Unreadable SSH key/);
  });

  it('makes ed25519 keys that load, including the 1 in 256 whose public key starts with a zero byte', async () => {
    // ssh2's own generator truncates exactly those, which is why it is not used.
    // Made until one of those turns up - after ~256 keys on average; 5000 without one is a
    // 1-in-3e8 chance.
    let leadingZero = 0;
    for (let i = 0; i < 5000 && leadingZero === 0; i++) {
      const kp = await newSshKeyPair('ed25519', 'x');
      const blob = Buffer.from(kp.publicKey.split(' ')[1]!, 'base64');
      expect(blob.length).toBe(4 + 11 + 4 + 32);
      if (blob[19] === 0) leadingZero++;
    }
    expect(leadingZero).toBeGreaterThan(0);
  });

  it.skipIf(!hasSshKeygen)('writes ed25519 keys OpenSSH itself loads', async () => {
    const kp = await newSshKeyPair('ed25519', 'wpl7-ftp-files');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-keys-')), 'id');
    fs.writeFileSync(file, kp.privateKey, { mode: 0o600 });
    expect(execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim()).toBe(kp.publicKey);
  });

  it.skipIf(!hasSshKeygen)('prints the fingerprint ssh-keygen prints', async () => {
    const kp = await newSshKeyPair('rsa', 'x');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-keys-')), 'key.pub');
    fs.writeFileSync(file, `${kp.publicKey}\n`);
    const out = execFileSync('ssh-keygen', ['-lf', file], { encoding: 'utf8' });
    expect(out).toContain(kp.fingerprint);
    expect(out).toMatch(/^3072 /);
  });
});

describe('generateFtpPassword', () => {
  it('is 24 letters and digits, none of them confusable, and never the same twice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pw = generateFtpPassword();
      expect(pw).toMatch(/^[a-hjkmnp-zA-HJKMNP-Z2-9]{24}$/);
      seen.add(pw);
    }
    expect(seen.size).toBe(200);
  });

  it('stays URL-safe, so ftp://user:password@host works as pasted', () => {
    const pw = generateFtpPassword(64);
    expect(encodeURIComponent(pw)).toBe(pw);
  });
});

describe('FTP password hashes', () => {
  it('reorders the PHC parameters into the m,t,p order SFTPGo parses', () => {
    const node = '$argon2id$v=19$m=19456,p=1,t=2$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';
    expect(toSftpgoArgon2(node)).toBe('$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g');
    expect(isSftpgoArgon2(node)).toBe(false);
    expect(isSftpgoArgon2(toSftpgoArgon2(node))).toBe(true);
    expect(() => toSftpgoArgon2('$2a$10$abc')).toThrow(/argon2id/);
  });

  it('hashes at the FTP cost in production, and still verifies after the reorder', async () => {
    const hash = toSftpgoArgon2(await productionArgon2Hash('secret-ftp-password', FTP_ARGON2));
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await argon2.verify(hash, 'secret-ftp-password')).toBe(true);
    expect(await argon2.verify(hash, 'wrong')).toBe(false);
  });

  it('writes salt and key the way a Go verifier recomputes them', async () => {
    const hash = await hashFtpPassword('pw-under-test');
    expect(isSftpgoArgon2(hash)).toBe(true);
    const [, , , params, saltB64, keyB64] = hash.split('$') as [string, string, string, string, string, string];
    // Canonical unpadded standard base64 - Go decodes with RawStdEncoding.Strict().
    const salt = Buffer.from(saltB64, 'base64');
    const key = Buffer.from(keyB64, 'base64');
    expect(salt.toString('base64').replace(/=+$/, '')).toBe(saltB64);
    expect(key.toString('base64').replace(/=+$/, '')).toBe(keyB64);
    // Recompute from nothing but (salt, m, t, p, key length), as argon2id.ComparePasswordAndHash does.
    const [m, t, p] = /m=(\d+),t=(\d+),p=(\d+)/.exec(params)!.slice(1).map(Number) as [number, number, number];
    const raw = await argon2.hash('pw-under-test', {
      type: argon2.argon2id,
      raw: true,
      salt,
      memoryCost: m,
      timeCost: t,
      parallelism: p,
      hashLength: key.length,
    });
    expect(Buffer.compare(raw, key)).toBe(0);
  });
});
