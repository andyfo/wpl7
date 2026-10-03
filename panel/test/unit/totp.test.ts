import { describe, expect, it } from 'vitest';
import {
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  qrDataUrl,
  totpCode,
  totpStepAt,
  verifyTotp,
} from '../../src/lib/totp.js';

/** The secret every RFC 4226 / 6238 test vector is written against: ASCII "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('base32', () => {
  it('encodes the RFC test secret the way authenticator apps show it', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('round-trips arbitrary bytes, including lengths that need padding bits', () => {
    for (let len = 0; len <= 24; len++) {
      const bytes = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });

  it('accepts a secret retyped with spaces, dashes, padding and lower case', () => {
    const canonical = base32Decode(RFC_SECRET);
    for (const variant of [
      'gezdgnbvgy3tqojqgezdgnbvgy3tqojq',
      'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ',
      'GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ',
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ======',
    ]) {
      expect(base32Decode(variant).equals(canonical)).toBe(true);
    }
  });

  it('rejects characters that are not in the alphabet', () => {
    expect(() => base32Decode('GEZD1NBV')).toThrow(/not valid base32/);
  });
});

describe('totpCode', () => {
  // RFC 4226 Appendix D, truncated to our six digits.
  it('matches the RFC 4226 HOTP vectors', () => {
    const expected = [
      '755224', '287082', '359152', '969429', '338314',
      '254676', '287922', '162583', '399871', '520489',
    ];
    expected.forEach((code, counter) => expect(totpCode(RFC_SECRET, counter)).toBe(code));
  });

  // RFC 6238 Appendix B (SHA-1 rows), again as the last six of the published eight digits.
  it('matches the RFC 6238 TOTP vectors', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    for (const [unixSeconds, code] of vectors) {
      expect(totpCode(RFC_SECRET, totpStepAt(unixSeconds * 1000))).toBe(code);
    }
  });
});

describe('verifyTotp', () => {
  const nowMs = 1_700_000_000_000;
  const step = totpStepAt(nowMs);

  it('accepts the current code and reports which step it came from', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), { nowMs })).toBe(step);
  });

  it('tolerates one step of clock drift either way, but no more', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { nowMs })).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), { nowMs })).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), { nowMs })).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), { nowMs })).toBeNull();
  });

  it('ignores the spaces phones like to put in the middle of a code', () => {
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs })).toBe(step);
  });

  it('rejects anything that is not six digits without hashing it', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5', '12345a']) {
      expect(verifyTotp(RFC_SECRET, bad, { nowMs })).toBeNull();
    }
  });

  it('gives a step a caller can use as a replay guard', () => {
    // Two codes 30 s apart belong to different steps, so "highest step already spent"
    // is enough state to refuse a code someone read off the screen a moment ago.
    const later = verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), {
      nowMs: nowMs + TOTP_STEP_SECONDS * 1000,
    });
    expect(later).toBe(step + 1);
    expect(later).toBeGreaterThan(step);
  });
});

describe('enrolment material', () => {
  it('generates a 160-bit secret', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('builds an otpauth URL an authenticator app can read', () => {
    const url = new URL(otpauthUrl({ secret: RFC_SECRET, issuer: 'panel.example.com', account: 'admin' }));
    expect(url.protocol).toBe('otpauth:');
    expect(`${url.host}${url.pathname}`).toBe('totp/panel.example.com:admin');
    expect(url.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(url.searchParams.get('issuer')).toBe('panel.example.com');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });

  it('escapes an account name with characters the label syntax uses', () => {
    const url = otpauthUrl({ secret: RFC_SECRET, issuer: 'wpl7', account: 'admin:ops team' });
    expect(url).toContain('totp/wpl7:admin%3Aops%20team?');
  });

  it('renders the QR as an img-ready data URL', () => {
    const dataUrl = qrDataUrl(otpauthUrl({ secret: RFC_SECRET, issuer: 'ceo', account: 'admin' }));
    expect(dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(dataUrl.split(',')[1]!, 'base64').toString();
    expect(svg.startsWith('<svg')).toBe(true);
    // The secret must be in the picture, not in markup the page would have to inject.
    expect(svg).not.toContain(RFC_SECRET);
  });

  it('generates unambiguous, grouped recovery codes', () => {
    const codes = Array.from({ length: 50 }, generateRecoveryCode);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    expect(new Set(codes).size).toBe(codes.length);
    // No 0/O/1/l/i confusion for someone reading them off a printout.
    expect(codes.join('')).not.toMatch(/[01lio]/);
  });

  it('normalizes a recovery code the way people retype it', () => {
    const code = generateRecoveryCode();
    const typed = code.replace(/-/g, ' ').toUpperCase();
    expect(normalizeRecoveryCode(typed)).toBe(normalizeRecoveryCode(code));
    expect(normalizeRecoveryCode(code)).toBe(code.replace(/-/g, ''));
  });
});
