import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { servers, sites } from '../../src/db/schema.js';
import type { ImageSummary } from '../../src/services/docker.js';
import { BUILD_CACHE_KEEP_BYTES, cleanDocker, imagesToRemove, repositoryOf } from '../../src/services/dockerCleanup.js';
import { SCANNER_IMAGE } from '../../src/services/scanEngines.js';
import { makeWorld, type FakeDocker } from '../helpers.js';

/** The nightly clean-up of Docker on each server (services/dockerCleanup.ts). */

const GiB = 1024 ** 3;

const image = (id: string, tags: string[], created = 0, digests: string[] = []): ImageSummary => ({ id, tags, digests, created });

/** A named image with an id of its own, built at `created`. */
function add(docker: FakeDocker, tag: string, created = 0): string {
  const id = `sha256:${tag.replace(/[^a-z0-9]/g, '')}`;
  docker.images.add(tag);
  docker.imageIds.set(tag, id);
  docker.imageCreated.set(id, created);
  return id;
}

const removed = (docker: FakeDocker) => docker.calls.filter((c) => c.method === 'removeImage').map((c) => c.args[0]);

describe('repositoryOf', () => {
  it('drops the tag or the digest, and keeps a registry port', () => {
    expect(repositoryOf('traefik:v3.7')).toBe('traefik');
    expect(repositoryOf('traefik@sha256:abc')).toBe('traefik');
    expect(repositoryOf('ghcr.io/andyfo/wpl7/panel:0.3.2')).toBe('ghcr.io/andyfo/wpl7/panel');
    expect(repositoryOf('registry.example.com:5000/wpl7/panel')).toBe('registry.example.com:5000/wpl7/panel');
    expect(repositoryOf('registry.example.com:5000/wpl7/panel:1')).toBe('registry.example.com:5000/wpl7/panel');
  });
});

describe('imagesToRemove', () => {
  it("takes WPL7's unused images and nameless leftovers, and leaves what is used, needed, the rollback and other images", () => {
    const images = [
      image('running-panel', ['wpl7-panel:0.3.2-source'], 300),
      image('previous-panel', ['wpl7-panel:0.3.1-source'], 200),
      image('old-panel', ['wpl7-panel:0.3.0-source'], 100),
      image('old-traefik', ['traefik:v3.5']),
      image('theirs', ['example-app:1']),
      image('leftover', []),
      image('leftover-in-use', []),
      image('scanner', [SCANNER_IMAGE]),
      image('old-scanner', ['marcocesarato/php-antimalware-scanner@sha256:0000']),
      image('two-names', ['wpl7-wordpress:php8.4', 'example-copy:keep']),
      image('their-pin', [], 0, ['example-tool@sha256:1111']),
    ];
    const plan = imagesToRemove({
      images,
      inUse: new Set(['running-panel', 'leftover-in-use']),
      needed: new Set(['scanner']),
      repos: new Set(['wpl7-panel', 'wpl7-wordpress', 'traefik', 'marcocesarato/php-antimalware-scanner']),
      panelRepos: new Set(['wpl7-panel']),
    });
    expect(plan.map((i) => i.id)).toEqual(['old-panel', 'old-traefik', 'leftover', 'old-scanner']);
  });

  it('keeps the newest unused panel image when the running one is older, as it is mid-update', () => {
    const plan = imagesToRemove({
      images: [image('new', ['ghcr.io/andyfo/wpl7/panel:0.3.3'], 300), image('running', ['ghcr.io/andyfo/wpl7/panel:0.3.2'], 200)],
      inUse: new Set(['running']),
      needed: new Set(),
      repos: new Set(['ghcr.io/andyfo/wpl7/panel']),
      panelRepos: new Set(['ghcr.io/andyfo/wpl7/panel']),
    });
    expect(plan).toEqual([]);
  });
});

describe('cleanDocker', () => {
  it("removes each reachable server's old images and trims its build cache", async () => {
    const w = await makeWorld();
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`) };

    // The panel's own server: a site image per offered version stays, the older ones go.
    const local = w.docker;
    add(local, 'ghcr.io/andyfo/wpl7/wordpress:php8.3-0.2.9');
    add(local, 'wpl7-wordpress:php8.1');
    local.containers.set('wpl7-panel', 'running');
    add(local, 'ghcr.io/andyfo/wpl7/panel:0.3.0', 300);
    add(local, 'ghcr.io/andyfo/wpl7/panel:0.2.9', 200);
    add(local, 'ghcr.io/andyfo/wpl7/panel:0.2.8', 100);
    local.containerImages.set('wpl7-traefik', 'traefik:v3.7');
    add(local, 'traefik:v3.7');
    add(local, 'traefik:v3.5');
    add(local, SCANNER_IMAGE);
    add(local, 'nginx:1.27');
    local.untaggedImages.push({ id: 'sha256:leftover', tags: [], digests: [], created: 1 });
    local.buildCacheBytes = 3 * GiB;

    const worker = w.addSshServer('worker-1');
    add(worker.docker, w.config.sftpgoImage);
    add(worker.docker, 'wpl7-sftpgo:2.7.5-wpl7.1');
    const down = w.addSshServer('worker-2');
    add(down.docker, 'wpl7-panel:0.1.0');
    w.db.update(servers).set({ status: 'unreachable' }).where(eq(servers.id, down.id)).run();

    const total = await cleanDocker(w.core, log);

    expect(removed(local).sort()).toEqual(
      ['ghcr.io/andyfo/wpl7/panel:0.2.8', 'ghcr.io/andyfo/wpl7/wordpress:php8.3-0.2.9', 'sha256:leftover', 'traefik:v3.5', 'wpl7-wordpress:php8.1'].sort(),
    );
    expect([...local.images]).toEqual(
      expect.arrayContaining(['wpl7-wordpress:php8.3', 'ghcr.io/andyfo/wpl7/panel:0.3.0', 'ghcr.io/andyfo/wpl7/panel:0.2.9', 'traefik:v3.7', SCANNER_IMAGE, 'nginx:1.27']),
    );
    expect(local.buildCacheBytes).toBe(BUILD_CACHE_KEEP_BYTES);
    expect(removed(worker.docker)).toEqual(['wpl7-sftpgo:2.7.5-wpl7.1']);
    expect(down.docker.calls).toEqual([]);
    expect(total).toEqual({ imagesRemoved: 6, buildCacheFreedBytes: 2 * GiB });
    expect(lines).toContain('Docker on "worker-1": removed 1 image(s) nothing uses: wpl7-sftpgo:2.7.5-wpl7.1');
    expect(lines).toContainEqual(expect.stringMatching(/^Docker on ".+": removed 5 image\(s\) nothing uses: .+; freed 2\.0 GiB of build cache$/));
  });

  it('keeps an image a site on that server still runs, and one Docker refuses to remove', async () => {
    const w = await makeWorld();
    const log = { info: () => undefined, warn: (m: string) => { throw new Error(m); } };
    const docker = w.docker;
    // A site on PHP 8.1, which is no longer offered: its image stays while the site is on it.
    const now = Date.now();
    w.db
      .insert(sites)
      .values({
        slug: 'legacy',
        title: 'Legacy',
        domains: '["legacy.example.org"]',
        phpVersion: '8.1',
        status: 'stopped',
        dbName: 'wp_legacy',
        dbUser: 'wp_legacy',
        dbPassword: 'x',
        containerName: 'wp-legacy',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    add(docker, 'wpl7-wordpress:php8.1');
    // A container created from it since the list was read: Docker says no, and that is fine.
    add(docker, 'wpl7-wordpress:php8.0');
    const remove = docker.removeImage.bind(docker);
    docker.removeImage = async (ref: string) => {
      if (ref === 'wpl7-wordpress:php8.0') throw Object.assign(new Error('conflict: image is being used'), { statusCode: 409 });
      return remove(ref);
    };

    const total = await cleanDocker(w.core, log);
    expect(docker.images.has('wpl7-wordpress:php8.1')).toBe(true);
    expect(docker.images.has('wpl7-wordpress:php8.0')).toBe(true);
    expect(total.imagesRemoved).toBe(0);
  });
});
