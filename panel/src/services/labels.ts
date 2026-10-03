export interface TraefikLabelOpts {
  slug: string;
  /** Canonical hostname; requests to any alias 301 here. */
  primary: string;
  aliases: string[];
  tlsMode: 'letsencrypt' | 'staging' | 'none';
  /** HTTP-01 resolver name for custom domains ('letsencrypt' | 'letsencrypt-staging'). */
  acmeResolver: string;
  devDomain: string;
  /** Non-empty = the letsencrypt-dns wildcard resolver is available. */
  dnsProvider: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function siteScheme(tlsMode: TraefikLabelOpts['tlsMode']): 'http' | 'https' {
  return tlsMode === 'none' ? 'http' : 'https';
}

/**
 * Generate the routing labels for a site container. Traefik v3 syntax:
 * multi-host rules use `Host(a) || Host(b)` (the v2 comma list is gone).
 */
export function traefikLabels(opts: TraefikLabelOpts): Record<string, string> {
  const { slug, primary, aliases } = opts;
  const hosts = [primary, ...aliases];
  const router = `wp-${slug}`;
  const scheme = siteScheme(opts.tlsMode);

  const labels: Record<string, string> = {
    'traefik.enable': 'true',
    [`traefik.http.routers.${router}.rule`]: hosts.map((h) => `Host(\`${h}\`)`).join(' || '),
    [`traefik.http.routers.${router}.entrypoints`]: scheme === 'https' ? 'websecure' : 'web',
    [`traefik.http.services.${router}.loadbalancer.server.port`]: '80',
  };

  if (scheme === 'https') {
    const underDev = (h: string) => h === opts.devDomain || h.endsWith(`.${opts.devDomain}`);
    if (opts.dnsProvider && hosts.every(underDev)) {
      // Pure dev-domain site: share the one *.devDomain wildcard cert (DNS-01). Follow
      // ACME_RESOLVER into staging too - otherwise "test with staging certs" still hit the
      // production CA (and its rate limits) for every dev site.
      const dnsResolver =
        opts.acmeResolver === 'letsencrypt-staging' ? 'letsencrypt-dns-staging' : 'letsencrypt-dns';
      labels[`traefik.http.routers.${router}.tls.certresolver`] = dnsResolver;
      labels[`traefik.http.routers.${router}.tls.domains[0].main`] = opts.devDomain;
      labels[`traefik.http.routers.${router}.tls.domains[0].sans`] = `*.${opts.devDomain}`;
    } else {
      // Custom domains (or no DNS provider): per-host certs via HTTP-01.
      labels[`traefik.http.routers.${router}.tls.certresolver`] = opts.acmeResolver;
    }
  }

  if (aliases.length > 0) {
    const mw = `${router}-canonical`;
    labels[`traefik.http.middlewares.${mw}.redirectregex.regex`] =
      `^https?://(?:${aliases.map(escapeRe).join('|')})(?::\\d+)?/(.*)`;
    labels[`traefik.http.middlewares.${mw}.redirectregex.replacement`] = `${scheme}://${primary}/\${1}`;
    labels[`traefik.http.middlewares.${mw}.redirectregex.permanent`] = 'true';
    labels[`traefik.http.routers.${router}.middlewares`] = mw;
  }

  return labels;
}
