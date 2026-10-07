import dns from 'node:dns/promises';
import { CidrSet, PRIVATE_RANGES, formatIp, parseIp } from '../../shared/cidr.js';

/**
 * Where the panel may send a request on an import's behalf: to the old site, at an address the
 * old site's own plugin reported - so an address anyone who held the import's token could have
 * chosen. Without a check that is a way into the panel's own network: the metadata service of a
 * cloud VM, MariaDB on the Docker bridge, an admin page on 127.0.0.1.
 *
 * The answer is the address to connect to as well as a yes: the caller pins its connection to it
 * (services/importPull.ts), so a name that resolves somewhere public now and somewhere private a
 * second later (DNS rebinding) still reaches only the address that was checked.
 */

/** Never an old site: private and local networks, and the address ranges that are not unicast. */
const REFUSED = new CidrSet([
  ...PRIVATE_RANGES,
  '192.0.0.0/24', // IETF protocol assignments
  '198.18.0.0/15', // benchmarking
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, and the broadcast address
  '::/96', // IPv4-compatible (deprecated): could name any v4 address, private ones included
  '64:ff9b::/96', // NAT64: an IPv4 address behind a translator
  '64:ff9b:1::/48',
  '2001::/32', // Teredo
  '2002::/16', // 6to4
  'fec0::/10', // site-local (deprecated)
  'ff00::/8', // multicast
]);

export class OutboundRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundRefusedError';
  }
}

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemLookup: LookupFn = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export interface AllowedSource {
  url: URL;
  /** The address the connection must go to. */
  address: string;
  family: 4 | 6;
}

/** Whether an address is one the panel will never send an import's request to. */
export function isRefusedAddress(address: string): boolean {
  const ip = parseIp(address);
  return !ip || REFUSED.has(ip);
}

/**
 * Check a URL an import is about to call, and pick the address to call it at. Refused: anything
 * but https (http too when the import allows it), ports other than 80 and 443, a user or password
 * in the URL, and a name with any address in a refused range - all of them are checked, so a
 * name that also answers privately is refused rather than tried on its public half.
 */
export async function assertAllowedSource(
  raw: string,
  opts: { allowHttp: boolean; lookup?: LookupFn },
): Promise<AllowedSource> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundRefusedError(`Not a URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new OutboundRefusedError(
      opts.allowHttp ? `Only http and https addresses: ${url.protocol}` : 'The old site has to be reached over HTTPS',
    );
  }
  if (url.username || url.password) throw new OutboundRefusedError('An address with a user name or password in it');
  if (url.port && url.port !== '443' && url.port !== '80') {
    throw new OutboundRefusedError(`Only ports 80 and 443, not ${url.port}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = parseIp(host);
  let answers: { address: string; family: number }[];
  if (literal) {
    answers = [{ address: formatIp(literal), family: literal.family }];
  } else {
    try {
      answers = await (opts.lookup ?? systemLookup)(host);
    } catch (err) {
      throw new OutboundRefusedError(`${host} does not resolve: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (answers.length === 0) throw new OutboundRefusedError(`${host} does not resolve`);
  const refused = answers.find((a) => isRefusedAddress(a.address));
  if (refused) {
    throw new OutboundRefusedError(`${host} resolves to ${refused.address}, a private or reserved address`);
  }
  const first = answers[0]!;
  const parsed = parseIp(first.address)!;
  return { url, address: formatIp(parsed), family: parsed.family };
}
