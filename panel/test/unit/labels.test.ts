import { describe, expect, it } from 'vitest';
import { traefikLabels } from '../../src/services/labels.js';

const base = {
  slug: 'demo',
  acmeResolver: 'letsencrypt',
  devDomain: 'dev.host.tld',
  dnsProvider: '',
} as const;

describe('traefikLabels', () => {
  it('single dev host, no TLS (local dev)', () => {
    const labels = traefikLabels({ ...base, primary: 'demo.dev.host.tld', aliases: [], tlsMode: 'none' });
    expect(labels['traefik.http.routers.wp-demo.rule']).toBe('Host(`demo.dev.host.tld`)');
    expect(labels['traefik.http.routers.wp-demo.entrypoints']).toBe('web');
    expect(labels['traefik.http.routers.wp-demo.tls.certresolver']).toBeUndefined();
    expect(labels['traefik.http.routers.wp-demo.middlewares']).toBeUndefined();
    expect(labels['traefik.http.services.wp-demo.loadbalancer.server.port']).toBe('80');
  });

  it('v3 multi-host rule uses ||', () => {
    const labels = traefikLabels({
      ...base,
      primary: 'example.com',
      aliases: ['www.example.com', 'demo.dev.host.tld'],
      tlsMode: 'letsencrypt',
    });
    expect(labels['traefik.http.routers.wp-demo.rule']).toBe(
      'Host(`example.com`) || Host(`www.example.com`) || Host(`demo.dev.host.tld`)',
    );
    expect(labels['traefik.http.routers.wp-demo.entrypoints']).toBe('websecure');
    expect(labels['traefik.http.routers.wp-demo.tls.certresolver']).toBe('letsencrypt');
  });

  it('canonical middleware 301s every alias to the primary with escaped dots', () => {
    const labels = traefikLabels({
      ...base,
      primary: 'example.com',
      aliases: ['www.example.com', 'demo.dev.host.tld'],
      tlsMode: 'letsencrypt',
    });
    expect(labels['traefik.http.middlewares.wp-demo-canonical.redirectregex.regex']).toBe(
      '^https?://(?:www\\.example\\.com|demo\\.dev\\.host\\.tld)(?::\\d+)?/(.*)',
    );
    expect(labels['traefik.http.middlewares.wp-demo-canonical.redirectregex.replacement']).toBe(
      'https://example.com/${1}',
    );
    expect(labels['traefik.http.routers.wp-demo.middlewares']).toBe('wp-demo-canonical');
  });

  it('pure dev-domain site uses the wildcard DNS-01 resolver when available', () => {
    const labels = traefikLabels({
      ...base,
      dnsProvider: 'cloudflare',
      primary: 'demo.dev.host.tld',
      aliases: [],
      tlsMode: 'letsencrypt',
    });
    expect(labels['traefik.http.routers.wp-demo.tls.certresolver']).toBe('letsencrypt-dns');
    expect(labels['traefik.http.routers.wp-demo.tls.domains[0].main']).toBe('dev.host.tld');
    expect(labels['traefik.http.routers.wp-demo.tls.domains[0].sans']).toBe('*.dev.host.tld');
  });

  it('mixed custom+dev hosts fall back to HTTP-01 even with a DNS provider', () => {
    const labels = traefikLabels({
      ...base,
      dnsProvider: 'cloudflare',
      primary: 'example.com',
      aliases: ['demo.dev.host.tld'],
      tlsMode: 'letsencrypt',
    });
    expect(labels['traefik.http.routers.wp-demo.tls.certresolver']).toBe('letsencrypt');
    expect(labels['traefik.http.routers.wp-demo.tls.domains[0].main']).toBeUndefined();
  });

  it('staging mode keeps the passed resolver', () => {
    const labels = traefikLabels({
      ...base,
      acmeResolver: 'letsencrypt-staging',
      primary: 'example.com',
      aliases: [],
      tlsMode: 'staging',
    });
    expect(labels['traefik.http.routers.wp-demo.tls.certresolver']).toBe('letsencrypt-staging');
  });

  it('uses the staging wildcard resolver when ACME_RESOLVER is staging', () => {
    const labels = traefikLabels({
      ...base,
      acmeResolver: 'letsencrypt-staging',
      tlsMode: 'staging',
      dnsProvider: 'cloudflare',
      primary: 'demo.dev.host.tld',
      aliases: [],
    });
    expect(labels['traefik.http.routers.wp-demo.tls.certresolver']).toBe('letsencrypt-dns-staging');
  });
});
