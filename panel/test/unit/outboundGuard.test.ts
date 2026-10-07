import { describe, expect, it } from 'vitest';
import { assertAllowedSource, isRefusedAddress, type LookupFn } from '../../src/lib/outboundGuard.js';

const resolvesTo =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('the outbound guard', () => {
  it('lets https to a public address through, and names the address to connect to', async () => {
    const allowed = await assertAllowedSource('https://old-site.example/wp-json/', {
      allowHttp: false,
      lookup: resolvesTo('203.0.113.10', '2001:db8::10'),
    });
    expect(allowed).toMatchObject({ address: '203.0.113.10', family: 4 });
    expect(allowed.url.hostname).toBe('old-site.example');
  });

  it('takes plain http only when the import allows it', async () => {
    const lookup = resolvesTo('203.0.113.10');
    await expect(assertAllowedSource('http://old-site.example/', { allowHttp: false, lookup })).rejects.toThrow(/HTTPS/);
    await expect(assertAllowedSource('http://old-site.example/', { allowHttp: true, lookup })).resolves.toMatchObject({
      address: '203.0.113.10',
    });
    await expect(assertAllowedSource('ftp://old-site.example/', { allowHttp: true, lookup })).rejects.toThrow(/http/);
  });

  it('refuses other ports, and credentials in the address', async () => {
    const lookup = resolvesTo('203.0.113.10');
    await expect(assertAllowedSource('https://old-site.example:8443/', { allowHttp: false, lookup })).rejects.toThrow(/ports/);
    await expect(assertAllowedSource('https://old-site.example:443/', { allowHttp: false, lookup })).resolves.toBeTruthy();
    await expect(assertAllowedSource('https://user:pw@old-site.example/', { allowHttp: false, lookup })).rejects.toThrow(
      /user name or password/,
    );
  });

  it.each([
    '10.1.2.3',
    '127.0.0.1',
    '0.0.0.0',
    '169.254.169.254',
    '172.17.0.2',
    '192.168.1.20',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::5',
    '::ffff:192.168.1.20',
    '::ffff:7f00:1',
    '64:ff9b::a01:203',
    '2002:a01:203::1',
  ])('refuses a name that resolves to %s', async (address) => {
    expect(isRefusedAddress(address)).toBe(true);
    await expect(
      assertAllowedSource('https://old-site.example/', { allowHttp: false, lookup: resolvesTo(address) }),
    ).rejects.toThrow(/private or reserved/);
  });

  it('refuses a name with a private address among public ones', async () => {
    await expect(
      assertAllowedSource('https://old-site.example/', { allowHttp: false, lookup: resolvesTo('203.0.113.10', '10.0.0.7') }),
    ).rejects.toThrow(/10\.0\.0\.7/);
  });

  it('checks an address written as one, without a lookup', async () => {
    const lookup: LookupFn = async () => {
      throw new Error('no lookup for a literal');
    };
    await expect(assertAllowedSource('https://127.0.0.1/', { allowHttp: false, lookup })).rejects.toThrow(/private/);
    await expect(assertAllowedSource('https://[::1]/', { allowHttp: false, lookup })).rejects.toThrow(/private/);
    await expect(assertAllowedSource('https://198.51.100.4/', { allowHttp: false, lookup })).resolves.toMatchObject({
      address: '198.51.100.4',
    });
  });

  it('says so when the name does not resolve', async () => {
    const lookup: LookupFn = async () => {
      throw new Error('getaddrinfo ENOTFOUND gone.example');
    };
    await expect(assertAllowedSource('https://gone.example/', { allowHttp: false, lookup })).rejects.toThrow(/does not resolve/);
    await expect(assertAllowedSource('https://gone.example/', { allowHttp: false, lookup: async () => [] })).rejects.toThrow(
      /does not resolve/,
    );
  });
});
