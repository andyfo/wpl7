/**
 * What DockerService reads and does for a site's stack, against a stand-in for the Docker client:
 * services/docker.ts. test/engine/siteSwitch.test.ts runs the same calls on a real daemon.
 */
import { describe, expect, it, vi } from 'vitest';
import { DockerService } from '../../src/services/docker.js';

const status = (code: number, message = 'nope') => Object.assign(new Error(message), { statusCode: code });

/** The parts of dockerode these calls reach. */
function client(parts: { image?: Record<string, unknown>; container?: Record<string, unknown>; containers?: unknown[] }) {
  return new DockerService('wpl7_proxy', 'wpl7_db', {
    getImage: () => parts.image,
    getContainer: () => parts.container,
    listContainers: async () => parts.containers ?? [],
  } as never);
}

describe('imageStack', () => {
  it('reads the label, by tag or by id', async () => {
    const inspect = async () => ({ Config: { Labels: { 'wpl7.stack': '2' } } });
    expect(await client({ image: { inspect } }).imageStack('wpl7-wordpress:php8.4')).toBe(2);
    expect(await client({ image: { inspect } }).imageStack('sha256:abc')).toBe(2);
  });

  it('counts a real image with no label as stack 1', async () => {
    expect(await client({ image: { inspect: async () => ({ Config: { Labels: null } }) } }).imageStack('old')).toBe(1);
    expect(await client({ image: { inspect: async () => ({ Config: { Labels: { other: 'x' } } }) } }).imageStack('old')).toBe(1);
    expect(await client({ image: { inspect: async () => ({ Config: {} }) } }).imageStack('old')).toBe(1);
  });

  it('counts an image that is not there as stack 1', async () => {
    const inspect = async () => {
      throw status(404);
    };
    expect(await client({ image: { inspect } }).imageStack('gone')).toBe(1);
  });

  it('does not take a Docker that fails for a missing image: a container would get the wrong stack', async () => {
    const inspect = async () => {
      throw status(500, 'daemon on fire');
    };
    await expect(client({ image: { inspect } }).imageStack('any')).rejects.toThrow('daemon on fire');
  });
});

describe('containerStack', () => {
  it('reads the image id and the label', async () => {
    const inspect = async () => ({ Image: 'sha256:abc', Config: { Image: 'wpl7-wordpress:php8.4', Labels: { 'wpl7.stack': '2' } } });
    expect(await client({ container: { inspect } }).containerStack('wp-demo')).toEqual({ imageId: 'sha256:abc', stack: 2 });
  });

  it('calls a container without the label stack 1', async () => {
    const inspect = async () => ({ Image: 'sha256:abc', Config: { Labels: { 'wpl7.site': 'demo' } } });
    expect(await client({ container: { inspect } }).containerStack('wp-demo')).toEqual({ imageId: 'sha256:abc', stack: 1 });
  });

  it('answers null when it does not exist, and throws when Docker cannot say', async () => {
    const missing = async () => {
      throw status(404);
    };
    expect(await client({ container: { inspect: missing } }).containerStack('wp-none')).toBeNull();
    const broken = async () => {
      throw status(500, 'daemon on fire');
    };
    await expect(client({ container: { inspect: broken } }).containerStack('wp-demo')).rejects.toThrow('daemon on fire');
  });
});

describe('setting a container aside', () => {
  it('stops it at once when asked to, and gives it 20 s otherwise', async () => {
    const stop = vi.fn(async () => undefined);
    await client({ container: { stop } }).stopContainer('wp-demo', 0);
    await client({ container: { stop } }).stopContainer('wp-demo');
    expect(stop.mock.calls).toEqual([[{ t: 0 }], [{ t: 20 }]]);
  });

  it('renames it, and passes on a name Docker refuses', async () => {
    const rename = vi.fn(async () => undefined);
    await client({ container: { rename } }).renameContainer('wp-demo', 'wp-demo.previous');
    expect(rename).toHaveBeenCalledWith({ name: 'wp-demo.previous' });
    const taken = async () => {
      throw status(409, 'name already in use');
    };
    await expect(client({ container: { rename: taken } }).renameContainer('wp-demo', 'wp-demo.previous')).rejects.toThrow('already in use');
  });
});
