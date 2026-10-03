import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DKIM_SELECTOR,
  dkimRecordBind,
  dkimRecordChunks,
  dkimRecordName,
  dkimRecordValue,
  generateDkimKey,
  renderKeyTable,
  renderOpendkimConf,
  renderSenderLogins,
  renderSigningPolicy,
  type DkimKeyFile,
} from '../../src/services/mailDkim.js';

const KEYS: DkimKeyFile[] = [
  { domain: 'acme.test', selector: 'wpl7', containerPath: '/etc/opendkim/keys/acme.test/wpl7.private' },
  { domain: 'shop.example', selector: 'wpl7', containerPath: '/etc/opendkim/keys/shop.example/wpl7.private' },
];

describe('generateDkimKey', () => {
  it('produces a key opendkim can load and a public half that matches it', () => {
    const key = generateDkimKey();
    expect(key.selector).toBe(DEFAULT_DKIM_SELECTOR);
    // PKCS#1 is what opendkim-genkey writes and what OpenDKIM expects to find.
    expect(key.privateKeyPem).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);

    // The published p= must be the SPKI of this exact private key, or every signature fails.
    const derived = crypto
      .createPublicKey(key.privateKeyPem)
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    expect(key.publicKeyB64).toBe(derived);
  });

  it('signs and verifies with the generated pair', () => {
    const key = generateDkimKey();
    const message = Buffer.from('wpl7');
    const signature = crypto.sign('sha256', message, key.privateKeyPem);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(key.publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(crypto.verify('sha256', message, publicKey, signature)).toBe(true);
  });

  it('is 2048-bit, the size receivers expect', () => {
    const key = generateDkimKey();
    expect(crypto.createPublicKey(key.privateKeyPem).asymmetricKeyDetails?.modulusLength).toBe(2048);
  });
});

describe('DNS record rendering', () => {
  it('names the record the way receivers look it up', () => {
    expect(dkimRecordName('acme.test', 'wpl7')).toBe('wpl7._domainkey.acme.test');
  });

  it('builds a v=DKIM1 value carrying the public key', () => {
    expect(dkimRecordValue('AAAB')).toBe('v=DKIM1; h=sha256; k=rsa; p=AAAB');
  });

  it('splits a 2048-bit record into DNS-legal 255-character strings', () => {
    const value = dkimRecordValue(generateDkimKey().publicKeyB64);
    expect(value.length).toBeGreaterThan(255); // the whole reason the split exists
    const chunks = dkimRecordChunks(value);
    expect(chunks.every((c) => c.length <= 255)).toBe(true);
    expect(chunks.join('')).toBe(value);

    const bind = dkimRecordBind('wpl7._domainkey.acme.test', value);
    expect(bind.startsWith('wpl7._domainkey.acme.test. IN TXT ( "')).toBe(true);
    // Concatenating the quoted strings must reproduce the value exactly.
    expect([...bind.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('')).toBe(value);
  });
});

describe('OpenDKIM tables', () => {
  it('names each key after its domain - how the signing policy finds and asks for it', () => {
    expect(renderKeyTable(KEYS)).toBe(
      'acme.test acme.test:wpl7:/etc/opendkim/keys/acme.test/wpl7.private\n' +
        'shop.example shop.example:wpl7:/etc/opendkim/keys/shop.example/wpl7.private\n',
    );
  });

  it('lists every domain each login owns once, as the policy looks it up', () => {
    expect(
      renderSenderLogins([
        { login: 'shop@wpl7', domain: 'Shop.Example' },
        { login: 'shop@wpl7', domain: 'shop.example' },
        { login: 'acme@wpl7', domain: 'acme.test' },
      ]),
    ).toBe('acme@wpl7/acme.test\nshop@wpl7/shop.example\n');
  });

  it('renders empty tables rather than a stray newline when nothing is in them', () => {
    expect(renderKeyTable([])).toBe('');
    expect(renderSenderLogins([])).toBe('');
  });
});

// What the policy decides, message by message, is tested against the real signer image:
// test/e2e/dkimSigning.mts (needs Docker). These pin what it is built from.
describe('renderSigningPolicy', () => {
  const policy = renderSigningPolicy('/etc/opendkim/keys');

  it('reads the key table and the owners from the mounted volume', () => {
    expect(policy).toContain('"file:/etc/opendkim/keys/KeyTable"');
    expect(policy).toContain('"file:/etc/opendkim/keys/SenderLogins"');
  });

  it("goes by the From: domain and the login the relay authenticated, and trusts only the relay's own sendmail", () => {
    expect(policy).toContain('odkim.get_fromdomain(ctx)');
    expect(policy).toContain('odkim.get_mtasymbol(ctx, "{auth_authen}")');
    expect(policy).toContain('ip == "127.0.0.1" or ip == "::1"');
    // Only an unauthenticated message can be the panel's: a site login never counts as local.
    expect(policy).toContain('local owned = login == nil and');
  });

  it('logs what it will not sign under the queue id, where the mail log finds it', () => {
    expect(policy).toContain('queue .. ": not signing for "');
  });
});

describe('renderOpendkimConf', () => {
  const conf = renderOpendkimConf('/etc/opendkim/keys');

  it('signs rather than verifies, and leaves every signature to the signing policy', () => {
    expect(conf).toContain('Mode                    s');
    expect(conf).toContain('KeyTable                file:/etc/opendkim/keys/KeyTable');
    expect(conf).toContain('SetupPolicyScript       /etc/opendkim/keys/policy.lua');
    // A signing table would sign by the From: header on its own, whoever wrote it.
    expect(conf).not.toMatch(/^SigningTable/m);
    expect(conf).toContain('Socket                  inet:8891');
  });

  it('treats every client as internal, so mail is signed instead of verified', () => {
    expect(conf).toContain('InternalHosts           refile:/etc/opendkim/keys/TrustedHosts');
    expect(conf).toContain('ExternalIgnoreList      refile:/etc/opendkim/keys/TrustedHosts');
  });
});
