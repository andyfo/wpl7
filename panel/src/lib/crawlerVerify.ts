/**
 * Is this really Google? A search engine's crawler can walk hundreds of dead URLs in minutes,
 * and blocking it costs the site its place in the results - but anyone can call themselves
 * Googlebot. The engines' own answer is reverse DNS, confirmed forward: the address names a
 * host of theirs, and that host names the address back.
 */
import dns from 'node:dns/promises';
import { normalizeIp } from '../../shared/cidr.js';

export interface CrawlerResolver {
  reverse(ip: string): Promise<string[]>;
  lookup(host: string): Promise<string[]>;
}

export const systemResolver: CrawlerResolver = {
  reverse: (ip) => dns.reverse(ip),
  lookup: async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address),
};

/**
 * The crawlers that publish a way to be verified, and the domains their hosts are under. Not
 * googleusercontent.com: Google's user-triggered fetchers use it, none of the agents below do,
 * and every Google Cloud machine answers to a name under it (`<ip>.bc.googleusercontent.com`).
 */
const CRAWLERS: { name: string; ua: RegExp; domains: string[] }[] = [
  { name: 'Googlebot', ua: /googlebot|google-inspectiontool|googleother|adsbot-google|mediapartners-google|storebot-google/i, domains: ['googlebot.com', 'google.com'] },
  { name: 'Bingbot', ua: /bingbot|bingpreview|adidxbot|msnbot/i, domains: ['search.msn.com'] },
  { name: 'Applebot', ua: /applebot/i, domains: ['applebot.apple.com'] },
  { name: 'YandexBot', ua: /yandex(?:bot|images|video|mobilebot)/i, domains: ['yandex.ru', 'yandex.net', 'yandex.com'] },
  { name: 'Baiduspider', ua: /baiduspider/i, domains: ['crawl.baidu.com', 'crawl.baidu.jp'] },
  { name: 'PetalBot', ua: /petalbot/i, domains: ['petalsearch.com'] },
];

/** The crawler a user agent claims to be, if it claims one that can be verified. */
export function claimedCrawler(userAgent: string): string | null {
  return CRAWLERS.find((c) => c.ua.test(userAgent))?.name ?? null;
}

export interface CrawlerCheck {
  claims: string | null;
  verified: boolean;
  /** The host that confirmed it. */
  host: string | null;
}

export async function verifyCrawler(ip: string, userAgent: string, resolver: CrawlerResolver = systemResolver): Promise<CrawlerCheck> {
  const claims = claimedCrawler(userAgent);
  const crawler = CRAWLERS.find((c) => c.name === claims);
  if (!crawler) return { claims: null, verified: false, host: null };
  let hosts: string[] = [];
  try {
    hosts = await resolver.reverse(ip);
  } catch {
    return { claims, verified: false, host: null };
  }
  for (const raw of hosts.slice(0, 5)) {
    const host = raw.toLowerCase().replace(/\.$/, '');
    if (!crawler.domains.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    const back = await resolver.lookup(host).catch(() => [] as string[]);
    const wanted = normalizeIp(ip);
    if (wanted && back.some((a) => normalizeIp(a) === wanted)) return { claims, verified: true, host };
  }
  return { claims, verified: false, host: null };
}
