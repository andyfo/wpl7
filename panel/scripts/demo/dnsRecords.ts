/**
 * Public DNS as the demo's resolver answers it: what the mail setup guide checks, and the
 * reverse names of the servers. Every live domain is signed and published; two are left with
 * something to fix, so the guide has a verdict of each kind to show: bluefern.example has no
 * DMARC record, and cedarstone.example's SPF lets anyone send.
 */
import { DEV_DOMAIN, SERVERS, SITES, rng, seedOf } from './data.js';

/** A stand-in DKIM public key: the shape of a 2048-bit RSA key, the same on every run. */
export function demoDkimPublicKey(domain: string): string {
  const next = rng(seedOf(`dkim:${domain}`));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let body = '';
  for (let i = 0; i < 348; i++) body += alphabet[Math.floor(next() * 64)];
  return `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${body}IDAQAB`;
}

export const MAIL_HOSTNAMES: Record<string, string> = {
  fra1: `mail.fra1.${DEV_DOMAIN}`,
  nyc1: `mail.nyc1.${DEV_DOMAIN}`,
  sin1: `mail.sin1.${DEV_DOMAIN}`,
};

const allIps = SERVERS.map((s) => `ip4:${s.ip}`).join(' ');

/** The domains with a DKIM key: every customer domain, and the dev domain dev sites send from. */
export const SIGNED_DOMAINS = [...SITES.filter((s) => s.domain).map((s) => s.domain!), DEV_DOMAIN];

export const DNS_TXT: Record<string, string[]> = {};
export const DNS_A: Record<string, string> = {};
export const DNS_PTR: Record<string, string> = {};

for (const server of SERVERS) {
  const hostname = MAIL_HOSTNAMES[server.name]!;
  DNS_A[hostname] = server.ip;
  DNS_PTR[server.ip] = hostname;
}

for (const site of SITES) {
  if (!site.domain) continue;
  const server = SERVERS.find((s) => s.id === site.server)!;
  DNS_A[site.domain] = server.ip;
  DNS_A[`www.${site.domain}`] = server.ip;
  DNS_TXT[site.domain] = [
    site.domain === 'cedarstone.example' ? 'v=spf1 +all' : `v=spf1 ${allIps} -all`,
  ];
  DNS_TXT[`wpl7._domainkey.${site.domain}`] = [`v=DKIM1; k=rsa; p=${demoDkimPublicKey(site.domain)}`];
  if (site.domain !== 'bluefern.example') {
    DNS_TXT[`_dmarc.${site.domain}`] = [`v=DMARC1; p=quarantine; rua=mailto:dmarc@${site.domain}`];
  }
}

// The dev domain, which dev sites send from before they go live.
DNS_TXT[DEV_DOMAIN] = [`v=spf1 ${allIps} -all`];
DNS_TXT[`wpl7._domainkey.${DEV_DOMAIN}`] = [`v=DKIM1; k=rsa; p=${demoDkimPublicKey(DEV_DOMAIN)}`];
DNS_TXT[`_dmarc.${DEV_DOMAIN}`] = [`v=DMARC1; p=reject; rua=mailto:dmarc@${DEV_DOMAIN}`];
