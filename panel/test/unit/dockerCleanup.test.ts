import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { servers, sites } from '../../src/db/schema.js';
import type { ImageSummary } from '../../src/services/docker.js';
import { BUILD_CACHE_KEEP_BYTES, cleanDocker, imagesToRemove, repositoryOf } from '../../src/services/dockerCleanup.js';
import { tryFlock } from '../../src/lib/flock.js';
import { SCANNER_IMAGE } from '../../src/services/scanEngines.js';
import { makeWorld, waitFor, type FakeDocker } from '../helpers.js';

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

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../provision/lib.sh');

/** flock(1) is in util-linux: the panel's image, Ubuntu and CI have it, macOS does not. */
const hasFlock = spawnSync('flock', ['--version']).status === 0;

/** update.sh's lock step in a real shell: `wpl7_hold_image_lock`, then what it would pull. */
function updateShell(dir: string, waitSec: number, after = 'echo PULLING') {
  // A process group of its own: killing the update kills what it started, as stopping it would.
  const child = spawn('bash', ['-c', `set -euo pipefail\n. "${LIB}"\nwpl7_hold_image_lock "${dir}"\n${after}`], {
    env: { ...process.env, WPL7_IMAGE_LOCK_WAIT_SEC: String(waitSec) },
    detached: true,
  });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  // `close`, not `exit`: only then has everything it printed been read.
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return { child, out: () => out, exited, kill: () => process.kill(-child.pid!, 'SIGKILL') };
}

/** Removal on server 1 that stops at its first image until `release` is called. */
function pauseRemoval(docker: FakeDocker) {
  let reached!: () => void;
  const atRemoval = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const remove = docker.removeImage.bind(docker);
  docker.removeImage = async (ref: string) => {
    reached();
    await held;
    return remove(ref);
  };
  return { atRemoval, release };
}

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

  it("leaves the panel's server's images alone while update.sh holds them", async () => {
    const w = await makeWorld();
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`) };
    // update.sh part-way: the next release's site image is pulled and not yet named
    // wpl7-wordpress:php8.3. This panel's release is not that one, so only the lock protects it.
    add(w.docker, 'ghcr.io/andyfo/wpl7/wordpress:php8.3-9.9.9');
    w.docker.buildCacheBytes = 2 * GiB;
    const worker = w.addSshServer('worker-1');
    add(worker.docker, 'wpl7-sftpgo:2.7.5-wpl7.1');
    const free = w.core.system.tryImageLock.bind(w.core.system);
    w.core.system.tryImageLock = async () => null;

    const total = await cleanDocker(w.core, log);

    expect(removed(w.docker)).toEqual([]);
    // The build cache is not what the update needs, and a worker is not where it runs.
    expect(w.docker.buildCacheBytes).toBe(BUILD_CACHE_KEEP_BYTES);
    expect(removed(worker.docker)).toEqual(['wpl7-sftpgo:2.7.5-wpl7.1']);
    expect(total.imagesRemoved).toBe(1);
    expect(lines).toContainEqual(
      expect.stringMatching(/^Docker on ".+": an update of the panel holds its images here, so they wait for the next run; freed 1\.0 GiB of build cache$/),
    );

    // Once it is over, the next run removes what nothing needs.
    w.core.system.tryImageLock = free;
    await cleanDocker(w.core, log);
    expect(removed(w.docker)).toEqual(['ghcr.io/andyfo/wpl7/wordpress:php8.3-9.9.9']);
  });

  it("holds the image lock exactly while it removes images on the panel's server", async () => {
    const w = await makeWorld();
    const log = { info: () => undefined, warn: () => undefined };
    add(w.docker, 'wpl7-wordpress:php8.1');
    const worker = w.addSshServer('worker-1');
    add(worker.docker, 'wpl7-wordpress:php8.1');
    let held = false;
    w.core.system.tryImageLock = async () => {
      held = true;
      return { release: async () => void (held = false) };
    };
    const seen: [string, boolean][] = [];
    for (const [name, docker] of [['local', w.docker], ['worker', worker.docker]] as const) {
      const remove = docker.removeImage.bind(docker);
      docker.removeImage = async (ref: string) => {
        seen.push([name, held]);
        return remove(ref);
      };
    }
    await cleanDocker(w.core, log);
    // A worker is not where update.sh runs, so its images are removed without the lock.
    expect(seen).toEqual([['local', true], ['worker', false]]);
    expect(held).toBe(false);
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

describe.skipIf(!hasFlock)('the clean-up and update.sh, through the real flock', () => {
  const quiet = { info: () => undefined, warn: () => undefined };

  async function world() {
    const w = await makeWorld();
    w.core.system.tryImageLock = () => tryFlock(w.core.system.imageLockFile());
    // An earlier try at 9.9.9 left its site image. A retry finds it, so its pull fetches nothing,
    // and names it only after: the image is in the clean-up's list before the retry starts.
    add(w.docker, 'ghcr.io/andyfo/wpl7/wordpress:php8.3-9.9.9');
    return { w, dir: path.dirname(w.core.system.imageLockFile()) };
  }

  it('an update that starts while the clean-up removes images waits for it, however long it takes', async () => {
    const { w, dir } = await world();
    const pause = pauseRemoval(w.docker);
    const cleaning = cleanDocker(w.core, quiet);
    await pause.atRemoval;

    const update = updateShell(dir, 30);
    await waitFor(() => update.out().includes('waiting'), 15_000);
    // No mark to expire: the lock is held for as long as the clean-up runs.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(update.out()).toBe("   waiting for the panel's Docker clean-up to finish\n");

    pause.release();
    await cleaning;
    expect(await update.exited).toBe(0);
    expect(update.out()).toContain('PULLING');
    // Removed before the retry pulled: it fetches the image again, and names it.
    expect(removed(w.docker)).toEqual(['ghcr.io/andyfo/wpl7/wordpress:php8.3-9.9.9']);
  });

  it('an update gives up rather than run into a clean-up that does not end', async () => {
    const { w, dir } = await world();
    const pause = pauseRemoval(w.docker);
    const cleaning = cleanDocker(w.core, quiet);
    await pause.atRemoval;

    const update = updateShell(dir, 1);
    expect(await update.exited).toBe(1);
    expect(update.out()).not.toContain('PULLING');

    pause.release();
    await cleaning;
  });

  it("leaves the images alone while an update holds the lock, and takes it again once that process is gone", async () => {
    const { w, dir } = await world();
    const update = updateShell(dir, 30, 'echo HELD\nsleep 60');
    await waitFor(() => update.out().includes('HELD'), 15_000);

    await cleanDocker(w.core, quiet);
    expect(removed(w.docker)).toEqual([]);

    // Killed, not finished: the kernel lets the lock go with the processes.
    update.kill();
    await update.exited;
    await cleanDocker(w.core, quiet);
    expect(removed(w.docker)).toEqual(['ghcr.io/andyfo/wpl7/wordpress:php8.3-9.9.9']);
  });
});
