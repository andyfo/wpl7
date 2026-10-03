import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certPemSha256, selfSignedCert } from '../../src/lib/x509.js';

describe('selfSignedCert', () => {
  it('builds a certificate Node parses, signed by its own key', async () => {
    const c = await selfSignedCert({ commonName: 'WPL7 FTP (web-1)', ips: ['203.0.113.9'] });
    const x = new crypto.X509Certificate(c.certPem);
    expect(x.subject).toBe('CN=WPL7 FTP (web-1)');
    expect(x.issuer).toBe(x.subject);
    expect(x.verify(x.publicKey)).toBe(true);
    // The key that comes back is the one the certificate carries.
    expect(x.checkPrivateKey(crypto.createPrivateKey(c.keyPem))).toBe(true);
    expect(c.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(x.publicKey.asymmetricKeyType).toBe('rsa');
    expect(x.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('names the server IP, is no CA, and is for TLS servers only', async () => {
    const c = await selfSignedCert({ commonName: 'x', ips: ['198.51.100.7'], dnsNames: ['ftp.example.com'] });
    const x = new crypto.X509Certificate(c.certPem);
    expect(x.checkIP('198.51.100.7')).toBe('198.51.100.7');
    expect(x.checkIP('198.51.100.8')).toBeUndefined();
    expect(x.checkHost('ftp.example.com')).toBe('ftp.example.com');
    expect(x.ca).toBe(false);
    expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
  });

  it('reports the same fingerprint Node computes', async () => {
    const c = await selfSignedCert({ commonName: 'x' });
    expect(c.sha256).toBe(new crypto.X509Certificate(c.certPem).fingerprint256);
    expect(certPemSha256(c.certPem)).toBe(c.sha256);
    expect(c.sha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('is valid from an hour ago for the requested days', async () => {
    const now = new Date('2026-09-25T10:00:00Z');
    const c = await selfSignedCert({ commonName: 'x', days: 30, now });
    const x = new crypto.X509Certificate(c.certPem);
    expect(new Date(x.validFrom).toISOString()).toBe('2026-09-25T09:00:00.000Z');
    expect(new Date(x.validTo).toISOString()).toBe('2026-10-25T10:00:00.000Z');
    expect(c.notAfter).toBe(Date.parse('2026-10-25T10:00:00Z'));
  });

  it('switches to GeneralizedTime past 2049, as RFC 5280 requires', async () => {
    const c = await selfSignedCert({ commonName: 'x', days: 3650, now: new Date('2045-01-01T00:00:00Z') });
    const x = new crypto.X509Certificate(c.certPem);
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2054);
    expect(x.verify(x.publicKey)).toBe(true);
  });

  it('never mints a negative or zero serial', async () => {
    for (let i = 0; i < 5; i++) {
      const x = new crypto.X509Certificate((await selfSignedCert({ commonName: 'x' })).certPem);
      expect(x.serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/);
      expect(BigInt(`0x${x.serialNumber}`)).toBeGreaterThan(0n);
    }
  });

  it('refuses an address that is not IPv4', async () => {
    await expect(selfSignedCert({ commonName: 'x', ips: ['2001:db8::1'] })).rejects.toThrow(/IPv4/);
  });
});
