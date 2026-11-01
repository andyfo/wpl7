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

describe('untagImage', () => {
  const ID = 'sha256:abc';
  const refused = () => {
    throw status(409, 'conflict: must force');
  };

  it('is a plain removal when Docker allows one: another name, or nothing using it', async () => {
    const remove = vi.fn(async () => undefined);
    expect(await client({ image: { remove } }).untagImage('wpl7-rollback:demo')).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith();
  });

  it('is done when the name is not there', async () => {
    const remove = vi.fn(async () => {
      throw status(404);
    });
    expect(await client({ image: { remove } }).untagImage('wpl7-rollback:demo')).toBe(true);
  });

  it('forces the name off when a running container uses the image, which keeps it there', async () => {
    const remove = vi.fn(async (opts?: { force?: boolean }) => {
      if (!opts?.force) refused();
    });
    const containers = [
      { ImageID: 'sha256:other', State: 'exited' },
      { ImageID: ID, State: 'running' },
    ];
    expect(await client({ image: { remove, inspect: async () => ({ Id: ID }) }, containers }).untagImage('wpl7-rollback:demo')).toBe(true);
    expect(remove).toHaveBeenLastCalledWith({ force: true });
  });

  it.each(['exited', 'created'])('leaves the name on when only a container that is %s uses it: force would delete the image on overlay2', async (state) => {
    const remove = vi.fn(async (opts?: { force?: boolean }) => {
      if (!opts?.force) refused();
    });
    const containers = [{ ImageID: ID, State: state }];
    expect(await client({ image: { remove, inspect: async () => ({ Id: ID }) }, containers }).untagImage('wpl7-rollback:demo')).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith();
  });

  it('counts the name as gone when an image built on it refused the rest', async () => {
    const remove = vi.fn(async () => refused());
    const inspect = async () => {
      throw status(404);
    };
    expect(await client({ image: { remove, inspect } }).untagImage('wpl7-rollback:demo')).toBe(true);
  });

  it('passes on anything else', async () => {
    const remove = vi.fn(async () => {
      throw status(500, 'daemon on fire');
    });
    await expect(client({ image: { remove } }).untagImage('wpl7-rollback:demo')).rejects.toThrow('daemon on fire');
  });
});
