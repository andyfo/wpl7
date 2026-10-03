import { describe, expect, it } from 'vitest';
import { backupRootProblem, normalizeAbsolutePath, normalizeBackupRoot } from '../../shared/backupRoot.js';
import { parseMounts } from '../../src/services/storage.js';

const SRV = '/srv';

describe('backup root validation', () => {
  it('accepts an ordinary directory on another disk', () => {
    for (const path of ['/mnt/backups', '/data/ceo/backups', '/srv/backups', '/media/usb1/backups']) {
      expect(backupRootProblem(path, SRV), path).toBeNull();
    }
  });

  it('refuses the filesystem root', () => {
    // The whole reason the check exists: the panel rm -rf's inside this directory.
    expect(backupRootProblem('/', SRV)).toMatch(/filesystem root/);
    expect(backupRootProblem('/../..', SRV)).toMatch(/filesystem root/);
  });

  it('refuses trees that hold live data', () => {
    expect(backupRootProblem('/srv/sites', SRV)).toMatch(/live data/);
    expect(backupRootProblem('/srv/sites/shop', SRV)).toMatch(/live data/);
    expect(backupRootProblem('/srv/mysql', SRV)).toMatch(/live data/);
    // An ancestor is just as dangerous: a site slug "sites" would then collide with the
    // real tree, and pruning that backup would rm -rf every site on the machine.
    expect(backupRootProblem('/srv', SRV)).toMatch(/contains \/srv\/sites/);
  });

  it('refuses system trees but allows the places a disk actually gets mounted', () => {
    expect(backupRootProblem('/etc/backups', SRV)).toMatch(/operating system/);
    expect(backupRootProblem('/usr/local/backups', SRV)).toMatch(/operating system/);
    expect(backupRootProblem('/var/lib/docker/vol', SRV)).toMatch(/operating system/);
    expect(backupRootProblem('/mnt/disk2', SRV)).toBeNull();
    expect(backupRootProblem('/var/backups', SRV)).toBeNull();
  });

  it('refuses relative paths and shell-hostile characters', () => {
    expect(backupRootProblem('backups', SRV)).toMatch(/absolute/);
    expect(backupRootProblem('', SRV)).toMatch(/Enter a directory/);
    // These are spliced into `sh -c` strings on the server and into a Docker bind source.
    for (const bad of ['/mnt/a b`id`', "/mnt/it's", '/mnt/a$(id)', '/mnt/a\nb', '/mnt/a"b']) {
      expect(backupRootProblem(bad, SRV), bad).toMatch(/not allowed/);
    }
  });

  it('normalizes before deciding, so traversal cannot sneak past', () => {
    expect(normalizeAbsolutePath('/mnt/../srv/sites')).toBe('/srv/sites');
    expect(backupRootProblem('/mnt/../srv/sites', SRV)).toMatch(/live data/);
    expect(normalizeBackupRoot('/mnt/disks/../backups/', SRV)).toBe('/mnt/backups');
    expect(() => normalizeBackupRoot('/srv/mail', SRV)).toThrow(/live data/);
  });

  it('respects a non-default SRV_ROOT', () => {
    expect(backupRootProblem('/opt/ceo/sites', '/opt/ceo')).toMatch(/live data/);
    expect(backupRootProblem('/srv/sites', '/opt/ceo')).toBeNull();
  });
});

describe('findmnt parsing', () => {
  const OUTPUT = [
    '/ /dev/sda1 ext4 52573owned 20000000000',
    '/ /dev/sda1 ext4 52573181440 20000000000',
    '/mnt/big /dev/sdb1 xfs 2000398934016 1900000000000',
    '/dev/shm tmpfs tmpfs 8000000000 8000000000',
    '/var/lib/docker/overlay2/abc overlay overlay 52573181440 20000000000',
    '/snap/core/1 /dev/loop0 squashfs 100000000 0',
    '/mnt/with\\x20space /dev/sdc1 ext4 500000000000 400000000000',
  ].join('\n');

  it('keeps real filesystems and drops the virtual ones', () => {
    const mounts = parseMounts(OUTPUT);
    expect(mounts.map((m) => m.target)).toEqual(['/mnt/big', '/mnt/with space', '/']);
    expect(mounts.find((m) => m.target === '/mnt/big')).toMatchObject({
      source: '/dev/sdb1',
      fstype: 'xfs',
      suggested: '/mnt/big/backups',
    });
  });

  it('sorts by free space, so the obvious choice is first', () => {
    const mounts = parseMounts(OUTPUT);
    expect(mounts[0]!.freeBytes).toBeGreaterThan(mounts[1]!.freeBytes);
  });

  it('skips rows it cannot parse rather than inventing a zero-byte disk', () => {
    expect(parseMounts('garbage\n/mnt x')).toEqual([]);
  });
});
