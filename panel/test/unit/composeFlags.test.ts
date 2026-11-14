/**
 * Traefik's flags live in two compose files, and compose replaces a `command:` list wholesale
 * when an overlay sets one - so the dev overlay is a full copy of the base list, kept in step by
 * hand. A DNS overlay drifted that way once: it never got the access-log flags, and every server
 * with a DNS provider wrote no access log at all - no visitor statistics there, and nothing for
 * the attack detection to read. Its resolvers are in the base file now, on every server.
 */
import { describe, expect, it } from 'vitest';
import { TOKEN_FILE_IN_TRAEFIK, tokenFilePath } from '../../src/services/traefikDns.js';
import { traefikFlags, traefikList } from '../composeFile.js';

/** What the dev overlay leaves out on purpose: it serves plain HTTP on :80, with no ACME at all. */
const DEV_ONLY_HTTP = [/^--entrypoints\.web\.http\.redirections\./, /^--entrypoints\.websecure\./, /^--certificatesresolvers\./];

describe('Traefik flags in the compose files', () => {
  const base = traefikFlags('docker-compose.yml');

  it('reads the base list', () => {
    expect(base).toContain('--accesslog=true');
    expect(base).toContain('--providers.file.directory=/etc/traefik/dynamic');
    expect(base.length).toBeGreaterThan(15);
  });

  it('keeps every base flag in the dev overlay except the TLS ones', () => {
    const overlay = traefikFlags('docker-compose.dev.yml');
    const missing = base.filter((flag) => !overlay.includes(flag) && !DEV_ONLY_HTTP.some((re) => re.test(flag)));
    expect(missing).toEqual([]);
  });

  it('keeps the headers a proxied visitor is identified by', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
      const flags = traefikFlags(file);
      for (const header of ['Cf-Connecting-Ip', 'True-Client-Ip', 'Fastly-Client-Ip']) {
        expect(flags, `${file}: ${header}`).toContain(`--accesslog.fields.headers.names.${header}=keep`);
      }
    }
  });

  it('gives every server the DNS resolvers, on Cloudflare unless DNS_PROVIDER says otherwise', () => {
    // A wildcard certificate is switched on per server in Settings -> DNS, with no .env to edit:
    // so the resolver has to be there already. services/traefikDns.ts reads the provider back.
    for (const resolver of ['letsencrypt-dns', 'letsencrypt-dns-staging']) {
      expect(base).toContain(`--certificatesresolvers.${resolver}.acme.dnschallenge.provider=\${DNS_PROVIDER:-cloudflare}`);
    }
    expect(base).toContain(
      '--certificatesresolvers.letsencrypt-dns-staging.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory',
    );
  });

  it("reads Cloudflare's token from the panel's file, and never from .env", () => {
    const env = traefikList('docker-compose.yml', 'environment');
    expect(env).toContain(`CF_DNS_API_TOKEN_FILE: ${TOKEN_FILE_IN_TRAEFIK}`);
    // lego takes the plain variable over the _FILE one whenever it has a value: passing .env's
    // would mean a token replaced in Settings never reaches Traefik.
    expect(env.filter((line) => /^(CF_DNS_API_TOKEN|CLOUDFLARE_DNS_API_TOKEN|CF_API_KEY):/.test(line))).toEqual([]);
    // ...and the file the panel writes is the one Traefik sees there.
    const volumes = traefikList('docker-compose.yml', 'volumes');
    expect(volumes).toContain('${SRV_ROOT:-/srv}/traefik:/letsencrypt');
    expect(tokenFilePath({ srvRoot: '/srv' })).toBe(TOKEN_FILE_IN_TRAEFIK.replace(/^\/letsencrypt/, '/srv/traefik'));
  });
});
