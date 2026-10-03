import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * A self-signed X.509 certificate, built by hand.
 *
 * FTPS needs a certificate, and FTP clients (FileZilla, WinSCP, lftp) do not care who issued
 * it: they show its fingerprint and ask to trust it once, which is what the FTP tab prepares
 * the operator for by showing the same fingerprint. Node can sign but has no API to BUILD a
 * certificate, and the libraries that do (node-forge, @peculiar/x509) are sizeable
 * dependency trees for a process that holds root on every server. What a certificate needs
 * is a few dozen bytes of ASN.1 DER around a public key and a signature, so it is written out
 * here - and `crypto.X509Certificate` parses and verifies the result in the tests.
 *
 * RSA rather than an elliptic curve: older FTP clients and TLS stacks still negotiate RSA
 * everywhere, and the key is minted once per server, so its cost does not matter.
 */

export interface SelfSignedCert {
  certPem: string;
  /** PKCS#8, which is what Go's `tls.X509KeyPair` (SFTPGo) reads. */
  keyPem: string;
  /** SHA-256 over the DER, colon-separated upper-case hex (what `openssl x509 -fingerprint` prints). */
  sha256: string;
  notAfter: number;
}

export interface SelfSignedOpts {
  commonName: string;
  /** IPv4 addresses for the subjectAltName; what a client that checks names compares with. */
  ips?: string[];
  dnsNames?: string[];
  days?: number;
  now?: Date;
}

const generateKeyPair = promisify(crypto.generateKeyPair);

export async function selfSignedCert(opts: SelfSignedOpts): Promise<SelfSignedCert> {
  const { privateKey, publicKey } = await generateKeyPair('rsa', { modulusLength: 2048 });
  const now = opts.now ?? new Date();
  // An hour of slack both ways on the start: a client whose clock runs a little behind the
  // server's must not see a certificate that is "not valid yet".
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now.getTime() + (opts.days ?? 3650) * 86_400_000);

  const name = seq(set(seq(oid('2.5.4.3'), utf8(opts.commonName))));
  const sha256WithRsa = seq(oid('1.2.840.113549.1.1.11'), nul());
  const altNames = [
    ...(opts.ips ?? []).map((ip) => tlv(0x87, ipv4Bytes(ip))),
    ...(opts.dnsNames ?? []).map((dns) => tlv(0x82, Buffer.from(dns, 'ascii'))),
  ];
  const extensions = [
    // basicConstraints (critical): an end-entity certificate, never a CA.
    seq(oid('2.5.29.19'), bool(true), octets(seq())),
    // keyUsage (critical): digitalSignature + keyEncipherment.
    seq(oid('2.5.29.15'), bool(true), octets(bitString(Buffer.from([0xa0]), 5))),
    // extKeyUsage: TLS server authentication only.
    seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))),
    ...(altNames.length > 0 ? [seq(oid('2.5.29.17'), octets(seq(...altNames)))] : []),
  ];

  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // version: v3
    integer(serialNumber()),
    sha256WithRsa,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, sha256WithRsa, bitString(signature, 0));

  return {
    certPem: pem('CERTIFICATE', der),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    sha256: certSha256(der),
    notAfter: notAfter.getTime(),
  };
}

/** The fingerprint of a certificate, from its PEM - the same string `selfSignedCert` returned. */
export function certPemSha256(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

function certSha256(der: Buffer): string {
  const hex = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
  return hex.match(/../g)!.join(':');
}

function pem(label: string, der: Buffer): string {
  const body = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** 16 random bytes, made a positive INTEGER that is never zero (RFC 5280 4.1.2.2). */
function serialNumber(): Buffer {
  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x01;
  return bytes;
}

// ---------------------------------------------------------------------------- DER

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
}

const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const octets = (value: Buffer) => tlv(0x04, value);
const nul = () => Buffer.from([0x05, 0x00]);
const bool = (v: boolean) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bitString = (value: Buffer, unusedBits: number) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));

/** DER INTEGER from big-endian magnitude bytes: minimal, with a 0x00 in front if the top bit is set. */
function integer(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const trimmed = magnitude.subarray(start);
  return tlv(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime through 2049, GeneralizedTime from 2050 on (RFC 5280 4.1.2.5). */
function time(d: Date): Buffer {
  const iso = d.toISOString(); // 2026-09-25T10:11:12.345Z
  const digits = iso.slice(0, 19).replace(/[-:T]/g, ''); // 20260925101112
  return d.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
}

function ipv4Bytes(ip: string): Buffer {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Not an IPv4 address: ${ip}`);
  }
  return Buffer.from(parts);
}
