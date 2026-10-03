/**
 * Traefik's flags live in three compose files, and compose replaces a `command:` list
 * wholesale when an overlay sets one - so an overlay is a full copy of the base list, kept in
 * step by hand. It drifted once: docker-compose.dns.yml never got the access-log flags, and
 * every server with a DNS provider wrote no access log at all. No visitor statistics there,
 * and nothing for the attack detection to read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DEPLOY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy');

/** The `command:` list of the `traefik` service, as written (quotes stripped, comments skipped). */
function traefikFlags(file: string): string[] {
  const lines = fs.readFileSync(path.join(DEPLOY, file), 'utf8').split('\n');
  const flags: string[] = [];
  let inTraefik = false;
  let inCommand = false;
  for (const line of lines) {
    if (/^ {2}\S/.test(line)) {
      inTraefik = /^ {2}traefik:\s*$/.test(line);
      inCommand = false;
      continue;
    }
    if (!inTraefik) continue;
    if (/^ {4}\S/.test(line)) {
      inCommand = /^ {4}command:\s*$/.test(line);
      continue;
    }
    if (!inCommand) continue;
    const item = /^\s+-\s+"(.*)"\s*$/.exec(line);
    if (item) flags.push(item[1]!);
  }
  return flags;
}

/** What the dev overlay leaves out on purpose: it serves plain HTTP on :80, with no ACME at all. */
const DEV_ONLY_HTTP = [/^--entrypoints\.web\.http\.redirections\./, /^--entrypoints\.websecure\./, /^--certificatesresolvers\./];

describe('Traefik flags in the compose overlays', () => {
  const base = traefikFlags('docker-compose.yml');

  it('reads the base list', () => {
    expect(base).toContain('--accesslog=true');
    expect(base).toContain('--providers.file.directory=/etc/traefik/dynamic');
    expect(base.length).toBeGreaterThan(15);
  });

  it('keeps every base flag in the DNS overlay', () => {
    const overlay = traefikFlags('docker-compose.dns.yml');
    expect(base.filter((flag) => !overlay.includes(flag))).toEqual([]);
  });

  it('keeps every base flag in the dev overlay except the TLS ones', () => {
    const overlay = traefikFlags('docker-compose.dev.yml');
    const missing = base.filter((flag) => !overlay.includes(flag) && !DEV_ONLY_HTTP.some((re) => re.test(flag)));
    expect(missing).toEqual([]);
  });

  it('keeps the headers a proxied visitor is identified by', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.dns.yml', 'docker-compose.dev.yml']) {
      const flags = traefikFlags(file);
      for (const header of ['Cf-Connecting-Ip', 'True-Client-Ip', 'Fastly-Client-Ip']) {
        expect(flags, `${file}: ${header}`).toContain(`--accesslog.fields.headers.names.${header}=keep`);
      }
    }
  });
});
