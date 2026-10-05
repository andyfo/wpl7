import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { ExecPort } from './exec.js';

/**
 * Filesystem operations on ONE server, always by absolute path.
 * LocalFiles = node:fs on the panel host; ExecFiles = shell commands through an
 * ExecPort (SSH for remote servers — GNU/Linux semantics, which every server is).
 */
export interface WriteOpts {
  /**
   * Permission bits to enforce, e.g. 0o600. Applied to existing paths too - `fs.writeFile`
   * and `mkdir` only honour a mode when they create the path, which would silently leave an
   * overwritten DKIM key world-readable (OpenDKIM then refuses to load it).
   */
  mode?: number;
  /**
   * Owner to give the file (or, for mkdirp, the last directory) - a uid a container runs as,
   * which need not exist on the host. Applied before an atomic write's rename, so the file
   * is never there with the wrong owner. Skipped where the panel is not root (the test
   * suite, a panel run outside its container), which cannot give files away.
   */
  owner?: { uid: number; gid: number };
  /**
   * Write a temporary file next to the target and rename it into place: a reader - a
   * container reloading its config - sees the old content or the new, never half of it.
   */
  atomic?: boolean;
}

export interface FileStat {
  sizeBytes: number;
  mtimeMs: number;
  /**
   * `<device>:<inode>`: which directory entry this is. A folder renamed away and replaced
   * by another of the same name has a new one - what tells a container that bind-mounted
   * the old folder is still looking at it (services/ftp.ts).
   */
  id: string;
}

/**
 * The checks below - exists, isDirectory, stat, readOptional - answer "not there" only when
 * that is what the path is. A check that could not be made throws: on a server, a command that
 * timed out or a shell that never ran answers no differently from a missing file, and callers
 * act on absence - write a default over a file, leave a folder out of a backup, delete a site
 * without its final one. A caller to whom a guess is good enough says so with a `.catch`.
 */
export interface FilesPort {
  exists(path: string): Promise<boolean>;
  /**
   * True only for a directory; false for a regular file and for a path that is not there.
   * Used to spot the empty directory Docker leaves behind when a bind mount's source file
   * was missing at container-create time (see ensureSiteMountSources).
   */
  isDirectory(path: string): Promise<boolean>;
  mkdirp(path: string, opts?: WriteOpts): Promise<void>;
  /** mkdir WITHOUT parents; 'exists' on EEXIST. Atomic claim primitive for backup dirs. */
  mkdirExclusive(path: string): Promise<'created' | 'exists'>;
  writeFile(path: string, content: string | Buffer, opts?: WriteOpts): Promise<void>;
  readFile(path: string): Promise<string>;
  /** The file's contents, or null when it is not there; something there that cannot be read throws. */
  readOptional(path: string): Promise<string | null>;
  /**
   * A file a site controls, read the way such a file must be: only a regular file, never
   * through a link as its last step, and at most `maxBytes` of it. Null for anything else. A
   * site can turn its files into links to /dev/zero or to the host's own files - any hacked
   * plugin can, and so can Manage (docs/mcp.md) - and this reads them as the panel, or as root
   * on a server.
   */
  readUntrusted(path: string, maxBytes: number): Promise<string | null>;
  rm(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat | null>;
  statvfs(path: string): Promise<{ totalBytes: number; freeBytes: number } | null>;
  sha256(path: string): Promise<string>;
}

/** Not there: the path itself is missing, or something on the way to it is not a directory. */
const isAbsent = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export class LocalFiles implements FilesPort {
  /** Only root can give a file to another uid. */
  private readonly canChown = process.getuid?.() === 0;

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.stat(path);
      return true;
    } catch (err) {
      if (isAbsent(err)) return false;
      throw err;
    }
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await fsp.stat(path)).isDirectory();
    } catch (err) {
      if (isAbsent(err)) return false;
      throw err;
    }
  }

  async mkdirp(path: string, opts: WriteOpts = {}): Promise<void> {
    await fsp.mkdir(path, { recursive: true, ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
    if (opts.mode !== undefined) await fsp.chmod(path, opts.mode);
    if (opts.owner && this.canChown) await fsp.chown(path, opts.owner.uid, opts.owner.gid);
  }

  async mkdirExclusive(path: string): Promise<'created' | 'exists'> {
    try {
      await fsp.mkdir(path);
      return 'created';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw err;
    }
  }

  async writeFile(path: string, content: string | Buffer, opts: WriteOpts = {}): Promise<void> {
    if (!opts.atomic) {
      await fsp.writeFile(path, content, opts.mode !== undefined ? { mode: opts.mode } : undefined);
      if (opts.mode !== undefined) await fsp.chmod(path, opts.mode);
      if (opts.owner && this.canChown) await fsp.chown(path, opts.owner.uid, opts.owner.gid);
      return;
    }
    const tmp = `${path}.wpl7-tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      // 0600 from the first byte, whatever the mode ends up as: the content may be a key.
      await fsp.writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
      if (opts.mode !== undefined) await fsp.chmod(tmp, opts.mode);
      if (opts.owner && this.canChown) await fsp.chown(tmp, opts.owner.uid, opts.owner.gid);
      await fsp.rename(tmp, path);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async readFile(path: string): Promise<string> {
    return fsp.readFile(path, 'utf8');
  }

  async readOptional(path: string): Promise<string | null> {
    try {
      return await fsp.readFile(path, 'utf8');
    } catch (err) {
      if (isAbsent(err)) return null;
      throw err;
    }
  }

  async readUntrusted(path: string, maxBytes: number): Promise<string | null> {
    let handle: fsp.FileHandle | undefined;
    try {
      // O_NOFOLLOW refuses a link as the last step; O_NONBLOCK keeps a FIFO from hanging the
      // open. What was opened is then checked, not the path, which could change in between.
      handle = await fsp.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!(await handle.stat()).isFile()) return null;
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }

  async rm(path: string): Promise<void> {
    await fsp.rm(path, { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  }

  async readdir(path: string): Promise<string[]> {
    try {
      return await fsp.readdir(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const st = await fsp.stat(path);
      return { sizeBytes: st.size, mtimeMs: st.mtimeMs, id: `${st.dev}:${st.ino}` };
    } catch (err) {
      if (isAbsent(err)) return null;
      throw err;
    }
  }

  async statvfs(path: string): Promise<{ totalBytes: number; freeBytes: number } | null> {
    try {
      const st = await fsp.statfs(path);
      return { totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize };
    } catch {
      return null; // statfs unsupported on this platform — callers treat as unknown
    }
  }

  async sha256(path: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return hash.digest('hex');
  }
}

/**
 * The exit code that means "not there", and nothing else. `test` says no with 1, but sudo and
 * `cat` fail with 1 too, and the `timeout` SshExec wraps every command in ends with 124: read as
 * "no", any of them makes a check that never ran look like a missing file.
 */
const NOT_THERE = 3;

export class ExecFiles implements FilesPort {
  constructor(private readonly exec: ExecPort) {}

  async exists(path: string): Promise<boolean> {
    return this.test('-e', path);
  }

  async isDirectory(path: string): Promise<boolean> {
    return this.test('-d', path);
  }

  private async test(flag: '-e' | '-d', path: string): Promise<boolean> {
    const res = await this.exec.run('sh', ['-c', `[ ${flag} "$1" ] && exit 0; exit ${NOT_THERE}`, 'sh', path]);
    if (res.exitCode === 0) return true;
    if (res.exitCode === NOT_THERE) return false;
    throw new Error(`test ${flag} ${path} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }

  async mkdirp(path: string, opts: WriteOpts = {}): Promise<void> {
    const res = await this.exec.run('mkdir', ['-p', '--', path]);
    if (res.exitCode !== 0) throw new Error(`mkdir -p ${path} failed: ${res.stderr.trim()}`);
    await this.chmod(path, opts.mode);
    if (opts.owner) {
      const own = await this.exec.run('chown', [`${opts.owner.uid}:${opts.owner.gid}`, '--', path]);
      if (own.exitCode !== 0) throw new Error(`chown ${path} failed: ${own.stderr.trim()}`);
    }
  }

  async mkdirExclusive(path: string): Promise<'created' | 'exists'> {
    const res = await this.exec.run('mkdir', ['--', path]);
    if (res.exitCode === 0) return 'created';
    if (/file exists/i.test(res.stderr)) return 'exists';
    throw new Error(`mkdir ${path} failed: ${res.stderr.trim()}`);
  }

  async writeFile(path: string, content: string | Buffer, opts: WriteOpts = {}): Promise<void> {
    if (opts.atomic || opts.owner) {
      // One round trip, and no moment where the file exists with the wrong owner or mode:
      // written 0600 under a temporary name, given away, then renamed over the target.
      const res = await this.exec.runWithInput(
        'sh',
        [
          '-c',
          `set -e; umask 077; t="$1.wpl7-tmp.$$"; trap 'rm -f -- "$t"' EXIT; cat > "$t"; ` +
            `[ -z "$2" ] || chown -- "$2" "$t"; [ -z "$3" ] || chmod -- "$3" "$t"; mv -f -- "$t" "$1"; trap - EXIT`,
          'sh',
          path,
          opts.owner ? `${opts.owner.uid}:${opts.owner.gid}` : '',
          opts.mode !== undefined ? opts.mode.toString(8).padStart(3, '0') : '',
        ],
        Readable.from([content]),
      );
      if (res.exitCode !== 0) throw new Error(`write ${path} failed: ${res.stderr.trim()}`);
      return;
    }
    const res = await this.exec.runWithInput('sh', ['-c', `cat > ${shellQuotePath(path)}`], Readable.from([content]));
    if (res.exitCode !== 0) throw new Error(`write ${path} failed: ${res.stderr.trim()}`);
    await this.chmod(path, opts.mode);
  }

  private async chmod(path: string, mode: number | undefined): Promise<void> {
    if (mode === undefined) return;
    const res = await this.exec.run('chmod', [mode.toString(8).padStart(3, '0'), '--', path]);
    if (res.exitCode !== 0) throw new Error(`chmod ${path} failed: ${res.stderr.trim()}`);
  }

  async readFile(path: string): Promise<string> {
    const res = await this.exec.run('cat', ['--', path]);
    if (res.exitCode !== 0) throw new Error(`read ${path} failed: ${res.stderr.trim()}`);
    return res.stdout;
  }

  async readOptional(path: string): Promise<string | null> {
    const res = await this.exec.run('sh', ['-c', `[ -e "$1" ] || exit ${NOT_THERE}; exec cat -- "$1"`, 'sh', path]);
    if (res.exitCode === NOT_THERE) return null;
    if (res.exitCode !== 0) throw new Error(`read ${path} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
    return res.stdout;
  }

  async readUntrusted(path: string, maxBytes: number): Promise<string | null> {
    // The same checks in the shell. A link or a FIFO swapped in after the test is still held:
    // head stops at the cap, and the timeout ends a read that never gets any.
    try {
      const res = await this.exec.run(
        'sh',
        ['-c', '[ -f "$1" ] && [ ! -L "$1" ] && exec head -c "$2" -- "$1"', 'sh', path, String(maxBytes)],
        { timeoutMs: 15_000 },
      );
      return res.exitCode === 0 ? res.stdout : null;
    } catch {
      return null;
    }
  }

  async rm(path: string): Promise<void> {
    const res = await this.exec.run('rm', ['-rf', '--', path]);
    if (res.exitCode !== 0) throw new Error(`rm -rf ${path} failed: ${res.stderr.trim()}`);
  }

  async rename(from: string, to: string): Promise<void> {
    const res = await this.exec.run('mv', ['-T', '--', from, to]);
    if (res.exitCode !== 0) throw new Error(`mv ${from} -> ${to} failed: ${res.stderr.trim()}`);
  }

  async readdir(path: string): Promise<string[]> {
    if (!(await this.exists(path))) return [];
    const res = await this.exec.run('ls', ['-1A', '--', path]);
    if (res.exitCode !== 0) throw new Error(`ls ${path} failed: ${res.stderr.trim()}`);
    return res.stdout.split('\n').filter(Boolean);
  }

  async stat(path: string): Promise<FileStat | null> {
    // `-L` too: `stat` describes a link itself, so a link to nowhere is still something there.
    const res = await this.exec.run(
      'sh',
      ['-c', `[ -e "$1" ] || [ -L "$1" ] || exit ${NOT_THERE}; exec stat -c "%s %Y %d %i" -- "$1"`, 'sh', path],
    );
    if (res.exitCode === NOT_THERE) return null;
    if (res.exitCode !== 0) throw new Error(`stat ${path} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
    const [size, mtime, dev, ino] = res.stdout.trim().split(/\s+/);
    const sizeBytes = Number(size);
    const mtimeSec = Number(mtime);
    if (!Number.isFinite(sizeBytes) || !Number.isFinite(mtimeSec)) {
      throw new Error(`stat ${path} answered "${res.stdout.trim().slice(0, 80)}"`);
    }
    return { sizeBytes, mtimeMs: mtimeSec * 1000, id: `${dev}:${ino}` };
  }

  async statvfs(path: string): Promise<{ totalBytes: number; freeBytes: number } | null> {
    const res = await this.exec.run('df', ['-kP', '--', path]);
    if (res.exitCode !== 0) return null;
    const lines = res.stdout.trim().split('\n');
    const cols = lines[lines.length - 1]?.split(/\s+/);
    // df -kP: Filesystem 1024-blocks Used Available Capacity Mounted-on
    const totalKb = Number(cols?.[1]);
    const freeKb = Number(cols?.[3]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb)) return null;
    return { totalBytes: totalKb * 1024, freeBytes: freeKb * 1024 };
  }

  async sha256(path: string): Promise<string> {
    const res = await this.exec.run('sha256sum', ['--', path]);
    if (res.exitCode !== 0) throw new Error(`sha256sum ${path} failed: ${res.stderr.trim()}`);
    const hex = res.stdout.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/.test(hex ?? '')) throw new Error(`sha256sum ${path}: unparseable output`);
    return hex!;
  }
}

/** Single-quote a path for embedding in a `sh -c` string. */
export function shellQuotePath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
