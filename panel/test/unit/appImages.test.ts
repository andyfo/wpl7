/**
 * A container app's image: the registry asked before a pull, the pull by digest with a login, an
 * upload renamed before its load, and the checks every image passes. Against the fake Docker; the
 * real one is in test/engine/containerImages.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TarWriter } from '../../src/lib/tarWriter.js';
import {
  exposedPort,
  imageUserIds,
  labelRefusal,
  loadUploaded,
  pinned,
  platformRefusal,
  pullAuthFor,
  pullPinned,
  registryAuthFor,
  registryHost,
  registryOf,
  repositoryKey,
  repositoryOfReference,
  resolveDigest,
  uploadImageName,
} from '../../src/services/appImages.js';
import { FakeDocker } from '../helpers.js';

const DIGEST = `sha256:${'d'.repeat(64)}`;
const LOGIN = { username: 'ci-reader', password: 'read-only-token' };
const auth = { ...LOGIN, serveraddress: 'ghcr.io' };

function fake() {
  const docker = new FakeDocker();
  return { docker, server: { docker } };
}

async function archive(tags: string[], images = 1): Promise<string> {
  const tar = new TarWriter();
  const done = (async () => {
    await tar.addFile({ name: 'blobs/sha256/c', mode: 0o644, mtime: 0 }, Buffer.from('config'));
    await tar.addFile(
      { name: 'manifest.json', mode: 0o644, mtime: 0 },
      Buffer.from(JSON.stringify(Array.from({ length: images }, () => ({ Config: 'blobs/sha256/c', RepoTags: tags, Layers: [] })))),
    );
    await tar.finish();
  })();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(chunk as Buffer);
  await done;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-upload-')), 'image.tar');
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

describe('references and logins', () => {
  it('finds the registry of a reference, as Docker does', () => {
    expect(registryHost('ghcr.io/example/app:stable')).toBe('ghcr.io');
    expect(registryHost('registry.example.com:5050/app')).toBe('registry.example.com:5050');
    expect(registryHost('localhost/app:1')).toBe('localhost');
    expect(registryHost('example/app:1')).toBe('https://index.docker.io/v1/');
    expect(registryHost('busybox')).toBe('https://index.docker.io/v1/');
    expect(pinned('ghcr.io/example/app:stable', DIGEST)).toBe(`ghcr.io/example/app@${DIGEST}`);
    expect(pinned('registry.example.com:5050/app', DIGEST)).toBe(`registry.example.com:5050/app@${DIGEST}`);
  });

  it('takes the repository off a reference with a tag, a digest or both', () => {
    expect(repositoryOfReference('ghcr.io/example/app:stable')).toBe('ghcr.io/example/app');
    expect(repositoryOfReference(`ghcr.io/example/app@${DIGEST}`)).toBe('ghcr.io/example/app');
    expect(repositoryOfReference(`ghcr.io/example/app:stable@${DIGEST}`)).toBe('ghcr.io/example/app');
    expect(repositoryOfReference(`registry.example.com:5050/app:1@${DIGEST}`)).toBe('registry.example.com:5050/app');
    expect(repositoryOfReference('registry.example.com:5050/app')).toBe('registry.example.com:5050/app');
    // A reference with a tag and a digest is pulled by the digest alone.
    expect(pinned(`ghcr.io/example/app:stable@${DIGEST}`, DIGEST)).toBe(`ghcr.io/example/app@${DIGEST}`);
  });

  it('compares repositories as Docker lists them', () => {
    expect(repositoryKey('docker.io/library/nginx:1.27')).toBe('nginx');
    expect(repositoryKey(`nginx@${DIGEST}`)).toBe('nginx');
    expect(repositoryKey('library/nginx')).toBe('nginx');
    expect(repositoryKey('index.docker.io/example/app:1')).toBe('example/app');
    expect(repositoryKey('docker.io/example/app')).toBe(repositoryKey(`example/app@${DIGEST}`));
    expect(repositoryKey(`ghcr.io/example/app:stable@${DIGEST}`)).toBe('ghcr.io/example/app');
    expect(repositoryKey('registry.example.com/library/app')).toBe('registry.example.com/library/app');
  });

  it('logs in only when the app has a login', () => {
    expect(registryAuthFor({ reference: 'ghcr.io/example/app:stable', registryUser: '', registryToken: '' })).toBeUndefined();
    expect(registryAuthFor({ reference: 'ghcr.io/example/app:stable', registryUser: 'u', registryToken: 't' })).toEqual({ username: 'u', password: 't', serveraddress: 'ghcr.io' });
  });

  it('sends the login to its own registry only, when an older reference is pulled', () => {
    const app = { reference: 'ghcr.io/example/app:stable', registryUser: 'u', registryToken: 't' };
    expect(pullAuthFor(app, 'ghcr.io/example/old-app:1')).toEqual({ username: 'u', password: 't', serveraddress: 'ghcr.io' });
    expect(pullAuthFor(app, 'registry.example.com/app:1')).toBeUndefined();
    expect(pullAuthFor({ ...app, reference: 'example/app:1' }, 'docker.io/example/app:2')).toMatchObject({ username: 'u' });
    expect([registryOf('example/app'), registryOf('docker.io/example/app'), registryOf('registry-1.docker.io/example/app')]).toEqual(['docker.io', 'docker.io', 'docker.io']);
  });

  it('names an upload after the app and the upload, never after the archive', () => {
    expect(uploadImageName('orders-api', 'Ab3_x')).toBe('wpl7-app-orders-api:uAb3_x');
  });
});

describe('the checks', () => {
  const server = { os: 'linux', arch: 'amd64' };

  it('refuses another platform, naming both', () => {
    expect(platformRefusal({ os: 'linux', architecture: 'amd64' }, server)).toBeNull();
    expect(platformRefusal({ os: 'linux', architecture: 'arm64' }, server)).toBe(
      'The image is for linux/arm64, and this server is linux/amd64. Build it for linux/amd64.',
    );
  });

  it('refuses labels for Traefik and for the panel, and nothing else', () => {
    expect(labelRefusal({ 'org.opencontainers.image.version': '1' })).toBeNull();
    expect(labelRefusal({ 'traefik.http.routers.x.rule': 'Host(`a`)', 'wpl7.role': 'wordpress' })).toMatch(/traefik\.http\.routers\.x\.rule, wpl7\.role/);
  });

  it('takes the one TCP port an image exposes', () => {
    expect(exposedPort({ exposedPorts: ['80/tcp'] })).toBe(80);
    expect(exposedPort({ exposedPorts: ['80/tcp', '53/udp'] })).toBe(80);
    expect(exposedPort({ exposedPorts: ['80/tcp', '443/tcp'] })).toBeNull();
    expect(exposedPort({ exposedPorts: [] })).toBeNull();
  });
});

describe('the image’s user, by number', () => {
  const PASSWD = 'root:x:0:0:root:/root:/bin/sh\napp:x:10001:10002::/srv:/sbin/nologin\n';
  const GROUP = 'root:x:0:\napp:x:10002:\nweb:x:33:\n';

  it('reads a name from the image’s own passwd and group files', async () => {
    const { docker, server } = fake();
    docker.images.add('app:1');
    docker.imageFiles.set('app:1', new Map([['/etc/passwd', PASSWD], ['/etc/group', GROUP]]));
    expect(await imageUserIds(server, 'app:1', 'app')).toEqual({ uid: 10001, gid: 10002 });
    expect(await imageUserIds(server, 'app:1', 'app:web')).toEqual({ uid: 10001, gid: 33 });
    expect(await imageUserIds(server, 'app:1', '10001')).toEqual({ uid: 10001, gid: 10002 });
    expect(await imageUserIds(server, 'app:1', '4242')).toEqual({ uid: 4242, gid: 0 });
    expect(await imageUserIds(server, 'app:1', '4242:4243')).toEqual({ uid: 4242, gid: 4243 });
    expect(await imageUserIds(server, 'app:1', '')).toEqual({ uid: 0, gid: 0 });
    await expect(imageUserIds(server, 'app:1', 'nobody-here')).rejects.toThrow(/no such user/);
  });
});

describe('from a registry, pinned by digest', () => {
  it('asks the registry first, then pulls repo@digest with the login, never the tag', async () => {
    const { docker, server } = fake();
    docker.publish('ghcr.io/example/app:stable', DIGEST, { login: LOGIN, imageId: 'sha256:local1' });
    const digest = await resolveDigest(server, 'ghcr.io/example/app:stable', auth);
    expect(digest).toBe(DIGEST);
    const image = await pullPinned(server, 'ghcr.io/example/app:stable', digest, auth);
    expect(image).toMatchObject({ ref: `ghcr.io/example/app@${DIGEST}`, digest: DIGEST, imageId: 'sha256:local1' });
    const pulls = docker.calls.filter((c) => c.method === 'pullImage');
    expect(pulls.map((c) => c.args[0])).toEqual([`ghcr.io/example/app@${DIGEST}`]);
    expect(docker.images.has('ghcr.io/example/app:stable')).toBe(false);
  });

  it('says what the registry said without the login', async () => {
    const { docker, server } = fake();
    docker.publish('ghcr.io/example/app:stable', DIGEST, { login: LOGIN });
    await expect(resolveDigest(server, 'ghcr.io/example/app:stable', undefined)).rejects.toThrow(/no basic auth credentials/);
  });

  it('refuses a list without the server’s platform before anything is pulled', async () => {
    const { docker, server } = fake();
    docker.publish('ghcr.io/example/app:stable', DIGEST, { platforms: [{ os: 'linux', architecture: 'arm64' }] });
    await expect(resolveDigest(server, 'ghcr.io/example/app:stable', undefined)).rejects.toThrow(
      'ghcr.io/example/app:stable has no image for linux/amd64, only for linux/arm64. Build it for linux/amd64.',
    );
    expect(docker.calls.some((c) => c.method === 'pullImage')).toBe(false);
  });

  it('checks a single image after its pull, and removes one it refuses', async () => {
    const { docker, server } = fake();
    docker.publish('ghcr.io/example/app:stable', DIGEST, { imageId: 'sha256:arm', config: { architecture: 'arm64' } });
    await expect(pullPinned(server, 'ghcr.io/example/app:stable', DIGEST, undefined)).rejects.toThrow(/linux\/arm64, and this server is linux\/amd64/);
    expect(docker.calls.filter((c) => c.method === 'removeImage').map((c) => c.args[0])).toEqual([`ghcr.io/example/app@${DIGEST}`]);
  });

  it('refuses an image with Traefik’s labels', async () => {
    const { docker, server } = fake();
    docker.publish('ghcr.io/example/app:stable', DIGEST, { imageId: 'sha256:x', config: { labels: { 'traefik.enable': 'true' } } });
    await expect(pullPinned(server, 'ghcr.io/example/app:stable', DIGEST, undefined)).rejects.toThrow(/only the panel may set: traefik\.enable/);
  });
});

describe('uploaded', () => {
  it('lands under the panel’s name only, whatever the archive called it', async () => {
    const { docker, server } = fake();
    const file = await archive(['wpl7-wordpress:php8.4', 'traefik:v3.7']);
    docker.loadIds = ['sha256:uploaded'];
    const image = await loadUploaded(server, file, 'wpl7-app-orders:u1');
    expect(image).toMatchObject({ ref: 'sha256:uploaded', digest: '', imageId: 'sha256:uploaded', archiveNames: ['wpl7-wordpress:php8.4', 'traefik:v3.7'] });
    expect(docker.images.has('wpl7-app-orders:u1')).toBe(true);
    expect(await docker.imageId('wpl7-wordpress:php8.3')).toBe('sha256:wpl7-wordpress:php8.3');
    expect(docker.images.has('traefik:v3.7')).toBe(false);
  });

  it('refuses an archive of two images before a byte reaches the daemon', async () => {
    const { docker, server } = fake();
    await expect(loadUploaded(server, await archive(['a:1'], 2), 'wpl7-app-orders:u2')).rejects.toThrow(/2 images/);
    expect(docker.calls.some((c) => c.method === 'loadImage')).toBe(false);
  });
});
