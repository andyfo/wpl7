import { describe, expect, it } from 'vitest';
import {
  checkDkim,
  checkDmarc,
  checkReverseDns,
  checkSpf,
  evaluateSpf,
  ipInCidr,
  parseDmarc,
  suggestedDmarc,
  suggestedSpf,
  type DnsResolver,
} from '../../src/services/mailDns.js';
import { dkimRecordValue, generateDkimKey } from '../../src/services/mailDkim.js';

/** Scriptable resolver; anything not in the maps answers NXDOMAIN like a real one would. */
function fakeResolver(zone: {
  txt?: Record<string, string[]>;
  a?: Record<string, string[]>;
  mx?: Record<string, { exchange: string; priority: number }[]>;
  ptr?: Record<string, string[]>;
}): DnsResolver & { lookups: string[] } {
  const lookups: string[] = [];
  const nx = (name: string) => {
    const err = new Error(`queryTxt ENOTFOUND ${name}`) as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    return err;
  };
  return {
    lookups,
    async resolveTxt(name) {
      lookups.push(`TXT ${name}`);
      const records = zone.txt?.[name];
      if (!records) throw nx(name);
      // Real resolvers hand back arrays of chunks; long records arrive pre-split.
      return records.map((r) => [r]);
    },
    async resolve4(name) {
      lookups.push(`A ${name}`);
      const records = zone.a?.[name];
      if (!records) throw nx(name);
      return records;
    },
    async resolveMx(name) {
      lookups.push(`MX ${name}`);
      const records = zone.mx?.[name];
      if (!records) throw nx(name);
      return records;
    },
    async reverse(ip) {
      lookups.push(`PTR ${ip}`);
      const records = zone.ptr?.[ip];
      if (!records) throw nx(ip);
      return records;
    },
  };
}

describe('ipInCidr', () => {
  it('matches bare addresses and prefixes', () => {
    expect(ipInCidr('203.0.113.9', '203.0.113.9')).toBe(true);
    expect(ipInCidr('203.0.113.9', '203.0.113.0/24')).toBe(true);
    expect(ipInCidr('203.0.114.9', '203.0.113.0/24')).toBe(false);
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
  });

  it('rejects malformed input instead of matching it', () => {
    expect(ipInCidr('203.0.113.9', 'not-an-ip')).toBe(false);
    expect(ipInCidr('203.0.113.9', '203.0.113.0/99')).toBe(false);
    expect(ipInCidr('999.0.0.1', '0.0.0.0/0')).toBe(false);
  });
});

describe('evaluateSpf', () => {
  it('authorizes an IP listed directly', async () => {
    const resolver = fakeResolver({ txt: { 'acme.test': ['v=spf1 ip4:203.0.113.9 ~all'] } });
    const result = await evaluateSpf(resolver, 'acme.test', '203.0.113.9');
    expect(result.authorizes).toBe(true);
  });

  it('rejects an IP the record does not cover', async () => {
    const resolver = fakeResolver({ txt: { 'acme.test': ['v=spf1 ip4:198.51.100.1 -all'] } });
    const result = await evaluateSpf(resolver, 'acme.test', '203.0.113.9');
    expect(result.authorizes).toBe(false);
    expect(result.qualifier).toBe('-');
  });

  it('follows include: the way a receiving server does', async () => {
    const resolver = fakeResolver({
      txt: {
        'acme.test': ['v=spf1 include:_spf.provider.test ~all'],
        '_spf.provider.test': ['v=spf1 ip4:203.0.113.0/24 -all'],
      },
    });
    const result = await evaluateSpf(resolver, 'acme.test', '203.0.113.9');
    expect(result.authorizes).toBe(true);
    expect(resolver.lookups).toContain('TXT _spf.provider.test');
  });

  it('resolves a and mx mechanisms', async () => {
    const resolver = fakeResolver({
      txt: { 'acme.test': ['v=spf1 a mx ~all'] },
      a: { 'acme.test': ['198.51.100.1'], 'mx1.acme.test': ['203.0.113.9'] },
      mx: { 'acme.test': [{ exchange: 'mx1.acme.test', priority: 10 }] },
    });
    expect((await evaluateSpf(resolver, 'acme.test', '203.0.113.9')).authorizes).toBe(true);
    expect((await evaluateSpf(resolver, 'acme.test', '198.51.100.1')).authorizes).toBe(true);
    expect((await evaluateSpf(resolver, 'acme.test', '192.0.2.1')).authorizes).toBe(false);
  });

  it('follows redirect= when no mechanism matched', async () => {
    const resolver = fakeResolver({
      txt: {
        'acme.test': ['v=spf1 redirect=_spf.parent.test'],
        '_spf.parent.test': ['v=spf1 ip4:203.0.113.9 -all'],
      },
    });
    expect((await evaluateSpf(resolver, 'acme.test', '203.0.113.9')).authorizes).toBe(true);
  });

  it('gives up rather than guessing when the record exceeds the 10-lookup limit', async () => {
    const txt: Record<string, string[]> = {
      'acme.test': [`v=spf1 ${Array.from({ length: 12 }, (_, i) => `include:i${i}.test`).join(' ')} ~all`],
    };
    for (let i = 0; i < 12; i++) txt[`i${i}.test`] = ['v=spf1 ip4:192.0.2.1 ~all'];
    const result = await evaluateSpf(fakeResolver({ txt }), 'acme.test', '203.0.113.9');
    // Receivers treat this as permerror, so "not authorized" would be a misleading answer.
    expect(result.authorizes).toBeNull();
    expect(result.warnings.join(' ')).toContain('more than 10 DNS lookups');
  });

  it('survives an include: loop', async () => {
    const resolver = fakeResolver({ txt: { 'acme.test': ['v=spf1 include:acme.test ~all'] } });
    const result = await evaluateSpf(resolver, 'acme.test', '203.0.113.9');
    expect(result.authorizes === null || result.authorizes === false).toBe(true);
  });
});

describe('checkSpf', () => {
  it('reports a missing record as something to add', async () => {
    const check = await checkSpf(fakeResolver({}), 'acme.test', ['203.0.113.9']);
    expect(check.verdict).toBe('missing');
    expect(check.found).toBeNull();
  });

  it('fails a record that omits one of several servers', async () => {
    const resolver = fakeResolver({ txt: { 'acme.test': ['v=spf1 ip4:203.0.113.9 ~all'] } });
    const check = await checkSpf(resolver, 'acme.test', ['203.0.113.9', '198.51.100.4']);
    expect(check.verdict).toBe('error');
    expect(check.detail).toContain('198.51.100.4');
  });

  it('warns about two SPF records, which receivers treat as a permerror', async () => {
    const resolver = fakeResolver({
      txt: { 'acme.test': ['v=spf1 ip4:203.0.113.9 ~all', 'v=spf1 include:other.test ~all'] },
    });
    const check = await checkSpf(resolver, 'acme.test', ['203.0.113.9']);
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('2 SPF records');
  });

  it('warns about +all, which authorizes the whole internet', async () => {
    const resolver = fakeResolver({ txt: { 'acme.test': ['v=spf1 ip4:203.0.113.9 +all'] } });
    const check = await checkSpf(resolver, 'acme.test', ['203.0.113.9']);
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('+all');
  });

  it('passes a correct record', async () => {
    const resolver = fakeResolver({ txt: { 'acme.test': ['v=spf1 ip4:203.0.113.9 ~all'] } });
    expect((await checkSpf(resolver, 'acme.test', ['203.0.113.9'])).verdict).toBe('ok');
  });
});

describe('checkDkim', () => {
  const key = generateDkimKey();

  it('passes when the published key is the one we sign with', async () => {
    const resolver = fakeResolver({
      txt: { 'wpl7._domainkey.acme.test': [dkimRecordValue(key.publicKeyB64)] },
    });
    const check = await checkDkim(resolver, 'acme.test', 'wpl7', key.publicKeyB64);
    expect(check.verdict).toBe('ok');
  });

  it('tolerates the whitespace providers introduce when splitting a long value', async () => {
    const chunked = dkimRecordValue(key.publicKeyB64).replace(/p=(.{40})/, 'p=$1\n\t ');
    const resolver = fakeResolver({ txt: { 'wpl7._domainkey.acme.test': [chunked] } });
    expect((await checkDkim(resolver, 'acme.test', 'wpl7', key.publicKeyB64)).verdict).toBe('ok');
  });

  it('flags a stale record left over from a rotated key', async () => {
    const old = generateDkimKey();
    const resolver = fakeResolver({ txt: { 'wpl7._domainkey.acme.test': [dkimRecordValue(old.publicKeyB64)] } });
    const check = await checkDkim(resolver, 'acme.test', 'wpl7', key.publicKeyB64);
    expect(check.verdict).toBe('error');
    expect(check.detail).toContain('different key');
  });

  it('calls out an empty p=, which revokes the key', async () => {
    const resolver = fakeResolver({ txt: { 'wpl7._domainkey.acme.test': ['v=DKIM1; k=rsa; p='] } });
    const check = await checkDkim(resolver, 'acme.test', 'wpl7', key.publicKeyB64);
    expect(check.verdict).toBe('error');
    expect(check.detail).toContain('empty p=');
  });

  it('reports a record that was never published', async () => {
    expect((await checkDkim(fakeResolver({}), 'acme.test', 'wpl7', key.publicKeyB64)).verdict).toBe('missing');
  });
});

describe('DMARC', () => {
  it('parses the tag list', () => {
    expect(parseDmarc('v=DMARC1; p=quarantine; rua=mailto:a@b.test; pct=50')).toMatchObject({
      p: 'quarantine',
      rua: 'mailto:a@b.test',
      pct: '50',
    });
  });

  it('treats p=none without reporting as not yet useful', async () => {
    const resolver = fakeResolver({ txt: { '_dmarc.acme.test': ['v=DMARC1; p=none'] } });
    const check = await checkDmarc(resolver, 'acme.test');
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('nothing is being learned');
  });

  it('accepts an enforcing policy', async () => {
    const resolver = fakeResolver({ txt: { '_dmarc.acme.test': ['v=DMARC1; p=reject; rua=mailto:d@acme.test'] } });
    const check = await checkDmarc(resolver, 'acme.test');
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('p=reject');
  });

  it('rejects a record with no policy tag', async () => {
    const resolver = fakeResolver({ txt: { '_dmarc.acme.test': ['v=DMARC1; rua=mailto:d@acme.test'] } });
    expect((await checkDmarc(resolver, 'acme.test')).verdict).toBe('error');
  });

  it('reports a missing record', async () => {
    expect((await checkDmarc(fakeResolver({}), 'acme.test')).verdict).toBe('missing');
  });
});

describe('checkReverseDns', () => {
  it('passes a forward-confirmed PTR that matches the relay hostname', async () => {
    const resolver = fakeResolver({
      ptr: { '203.0.113.9': ['mail.acme.test'] },
      a: { 'mail.acme.test': ['203.0.113.9'] },
    });
    expect((await checkReverseDns(resolver, '203.0.113.9', 'mail.acme.test')).verdict).toBe('ok');
  });

  it('errors when there is no PTR at all', async () => {
    const check = await checkReverseDns(fakeResolver({}), '203.0.113.9');
    expect(check.verdict).toBe('error');
    expect(check.detail).toContain('reverse DNS');
  });

  it('warns when the name does not resolve back to the address', async () => {
    const resolver = fakeResolver({
      ptr: { '203.0.113.9': ['mail.acme.test'] },
      a: { 'mail.acme.test': ['198.51.100.1'] },
    });
    expect((await checkReverseDns(resolver, '203.0.113.9')).verdict).toBe('warn');
  });

  it('warns when the PTR disagrees with the name postfix announces', async () => {
    const resolver = fakeResolver({
      ptr: { '203.0.113.9': ['vps-1234.provider.test'] },
      a: { 'vps-1234.provider.test': ['203.0.113.9'] },
    });
    const check = await checkReverseDns(resolver, '203.0.113.9', 'mail.acme.test');
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('mail.acme.test');
  });
});

describe('suggested records', () => {
  it('lists every server so moving a site never needs an SPF edit', () => {
    expect(suggestedSpf(['203.0.113.9', '198.51.100.4'])).toBe('v=spf1 ip4:203.0.113.9 ip4:198.51.100.4 ~all');
  });

  it('starts DMARC in monitoring mode with relaxed alignment', () => {
    expect(suggestedDmarc('dmarc@acme.test')).toBe('v=DMARC1; p=none; rua=mailto:dmarc@acme.test; adkim=r; aspf=r');
  });
});
