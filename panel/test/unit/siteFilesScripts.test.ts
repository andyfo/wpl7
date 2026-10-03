import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, type Writable } from 'node:stream';
import zlib from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DockerPort, ExecOpts, RunResult } from '../../src/services/docker.js';
import { SiteFilesService } from '../../src/services/siteFiles.js';
import { FILE_EXIT, SCRIPTS } from '../../src/services/siteFilesScripts.js';
import { AppError } from '../../src/lib/errors.js';

/**
 * The Web FTP scripts, for real: every command runs through a local `sh` standing in for
 * `docker exec`, against a temporary folder standing in for /var/www/html. What this checks
 * is the part a fake cannot - that the scripts do what siteFiles.ts believes they do.
 *
 * The scripts are written for the site image (Debian: dash and GNU tools), so they only run
 * where those are: CI's Ubuntu runner, or on a Mac through
 *   docker run --rm -v "$PWD":/w -v /w/panel/node_modules -w /w/panel node:22 \
 *     sh -c 'npm ci --ignore-scripts=false >/dev/null && npx vitest run test/unit/siteFilesScripts.test.ts'
 * Zip tests need `php` with the zip extension, which is all they use.
 */

const gnu =
  spawnSync('find', ['--version']).stdout?.toString().includes('GNU') === true &&
  spawnSync('head', ['--version']).stdout?.toString().includes('GNU') === true;
const phpZip =
  spawnSync('php', ['-n', '-r', 'if (!class_exists("ZipArchive")) @dl("zip.so"); exit(class_exists("ZipArchive") ? 0 : 1);'])
    .status === 0;
const php = spawnSync('php', ['-v']).status === 0;
/** Permission checks mean nothing to root, which may do anything. */
const root = process.getuid?.() === 0;

/** `docker exec` stand-in: the same argv, run here, with the env and working directory it asks for. */
class LocalShell {
  run(cmd: string[], opts: ExecOpts = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const kv of opts.env ?? []) {
      const i = kv.indexOf('=');
      env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return spawn(cmd[0]!, cmd.slice(1), { cwd: opts.workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async execWithInput(_name: string, cmd: string[], input: Buffer, opts?: ExecOpts): Promise<RunResult> {
    const child = this.run(cmd, opts);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    // A script that refuses before reading its input closes stdin under the write.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    const exitCode = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
    return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode };
  }

  exec(name: string, cmd: string[], opts?: ExecOpts): Promise<RunResult> {
    return this.execWithInput(name, cmd, Buffer.alloc(0), opts);
  }

  async execToStream(_name: string, cmd: string[], stdout: Writable, opts?: ExecOpts) {
    const child = this.run(cmd, opts);
    child.stdin.end();
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdout.pipe(stdout, { end: false });
    const exitCode = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
    return { exitCode, stderr: Buffer.concat(err).toString('utf8') };
  }
}

let dir: string;
let files: SiteFilesService;
const shell = new LocalShell();
const C = 'wp-test';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-files-')));
  files = new SiteFilesService(shell as unknown as DockerPort, dir);
});

const at = (...p: string[]) => path.join(dir, ...p);
const put = (rel: string, content: string | Buffer = 'x') => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), content);
};
const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const leftovers = (rel = '') => fs.readdirSync(at(rel)).filter((n) => n.startsWith('.wpl7-'));

async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function refusal(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe.skipIf(!gnu)('Web FTP scripts, run for real', () => {
  describe('list', () => {
    it('describes files, folders and links - dangling ones included', async () => {
      put('wp-config.php', '<?php // hi');
      fs.chmodSync(at('wp-config.php'), 0o640);
      fs.mkdirSync(at('wp-content'));
      fs.symlinkSync('wp-config.php', at('to-file'));
      fs.symlinkSync('/nowhere/at/all', at('dangling'));
      fs.symlinkSync('wp-content', at('to-dir'));

      const listing = await files.list(C, '');
      const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
      expect(Object.keys(byName).sort()).toEqual(['dangling', 'to-dir', 'to-file', 'wp-config.php', 'wp-content']);
      expect(byName['wp-config.php']).toMatchObject({ type: 'file', size: 11, mode: '640', readable: true, target: null });
      expect(byName['wp-content']).toMatchObject({ type: 'dir', targetType: null });
      expect(byName['to-file']).toMatchObject({ type: 'link', target: 'wp-config.php', targetType: 'file' });
      expect(byName['to-dir']).toMatchObject({ type: 'link', targetType: 'dir' });
      expect(byName.dangling).toMatchObject({ type: 'link', target: '/nowhere/at/all', targetType: null });
      expect(Math.abs(byName['wp-config.php']!.mtimeMs - Date.now())).toBeLessThan(60_000);
      expect(listing.truncated).toBe(false);
      expect(listing.writable).toBe(true);
    });

    it('keeps names with a newline, a slash-free oddity and invalid UTF-8 apart', async () => {
      put('line\nbreak.txt');
      put('ü.txt');
      fs.writeFileSync(Buffer.concat([Buffer.from(dir + '/'), Buffer.from([0x62, 0xff, 0x2e, 0x74])]), 'x');
      const listing = await files.list(C, '');
      const names = listing.entries.map((e) => [e.name, e.nameOk]);
      expect(names).toContainEqual(['line\nbreak.txt', true]);
      expect(names).toContainEqual(['ü.txt', true]);
      expect(names).toContainEqual(['b\uFFFD.t', false]);
    });

    it('enters a folder reached through a symlink, and refuses what is not a folder', async () => {
      put('real/inside.txt');
      fs.symlinkSync('real', at('alias'));
      const listing = await files.list(C, 'alias');
      expect(listing.entries.map((e) => e.name)).toEqual(['inside.txt']);
      expect((await refusal(files.list(C, 'real/inside.txt'))).statusCode).toBe(409);
      expect((await refusal(files.list(C, 'missing'))).statusCode).toBe(404);
    });
  });

  describe('read', () => {
    it('returns the bytes and their SHA-256', async () => {
      const content = Buffer.from([0, 1, 2, 255, 10, 13]);
      put('bin.dat', content);
      const res = await files.read(C, 'bin.dat');
      expect(res.bytes.equals(content)).toBe(true);
      expect(res.etag).toBe(sha(content));
    });

    it('refuses folders and files over the editor limit', async () => {
      fs.mkdirSync(at('d'));
      expect((await refusal(files.read(C, 'd'))).statusCode).toBe(409);
      put('big.log', Buffer.alloc(8 * 1024 * 1024 + 1));
      const err = await refusal(files.read(C, 'big.log'));
      expect(err.statusCode).toBe(409);
      expect(err.message).toMatch(/too large/);
    });
  });

  describe('write', () => {
    it('creates, and refuses to create over something that exists', async () => {
      const written = await files.write(C, 'new.php', Buffer.from('<?php echo 1;'), { createOnly: true });
      expect(fs.readFileSync(at('new.php'), 'utf8')).toBe('<?php echo 1;');
      expect(written).toMatchObject({ path: 'new.php', etag: sha('<?php echo 1;') });
      expect(written.entry).toMatchObject({ name: 'new.php', type: 'file', mode: '644', size: 13 });

      const err = await refusal(files.write(C, 'new.php', Buffer.from('other'), { createOnly: true }));
      expect(err).toMatchObject({ statusCode: 412, code: 'precondition_failed' });
      expect(fs.readFileSync(at('new.php'), 'utf8')).toBe('<?php echo 1;');
    });

    it('replaces only the version it was based on, keeping its permissions', async () => {
      put('wp-config.php', 'old');
      fs.chmodSync(at('wp-config.php'), 0o600);
      const stale = await refusal(files.write(C, 'wp-config.php', Buffer.from('new'), { ifMatch: sha('something else') }));
      expect(stale.statusCode).toBe(412);
      expect(fs.readFileSync(at('wp-config.php'), 'utf8')).toBe('old');

      await files.write(C, 'wp-config.php', Buffer.from('new'), { ifMatch: sha('old') });
      expect(fs.readFileSync(at('wp-config.php'), 'utf8')).toBe('new');
      expect(fs.statSync(at('wp-config.php')).mode & 0o777).toBe(0o600);
      expect(leftovers()).toEqual([]);
    });

    it('answers 412 for If-Match on a file that is gone', async () => {
      const err = await refusal(files.write(C, 'gone.txt', Buffer.from('x'), { ifMatch: sha('x') }));
      expect(err.statusCode).toBe(412);
      expect(fs.existsSync(at('gone.txt'))).toBe(false);
    });

    it('with If-Match: *, replaces whatever version is there - and creates nothing', async () => {
      put('robots.txt', 'old');
      await files.write(C, 'robots.txt', Buffer.from('new'), { mustExist: true });
      expect(fs.readFileSync(at('robots.txt'), 'utf8')).toBe('new');
      const err = await refusal(files.write(C, 'gone.txt', Buffer.from('x'), { mustExist: true }));
      expect(err.statusCode).toBe(412);
      expect(fs.existsSync(at('gone.txt'))).toBe(false);
    });

    it('lands only one of two saves made from the same version', async () => {
      put('wp-config.php', 'old');
      // One save has passed its first check and is still receiving its content...
      const first = spawn('sh', ['-c', SCRIPTS.write, 'sh', at('wp-config.php'), 'replace', sha('old'), '5', sha('first'), '-']);
      first.stdin.on('error', () => undefined);
      const firstExit = new Promise<number | null>((resolve) => first.on('close', resolve));
      await until(() => leftovers().length > 0);
      // ...when another, from the same version, lands. The first must now be refused, not win.
      await files.write(C, 'wp-config.php', Buffer.from('second'), { ifMatch: sha('old') });
      first.stdin.end('first');
      expect(await firstExit).toBe(FILE_EXIT.changed);
      expect(fs.readFileSync(at('wp-config.php'), 'utf8')).toBe('second');
      expect(leftovers()).toEqual([]);
    });

    it('waits for the folder while another write holds it', async () => {
      put('a.txt', 'a');
      const holder = spawn('flock', [dir, 'sleep', '0.7']);
      const released = new Promise((r) => holder.on('close', r));
      await new Promise((r) => setTimeout(r, 150));
      const started = Date.now();
      await files.write(C, 'a.txt', Buffer.from('b'), { ifMatch: sha('a') });
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      expect(fs.readFileSync(at('a.txt'), 'utf8')).toBe('b');
      await released;
    });

    it('writes through a link, leaving the link a link', async () => {
      put('real.css', 'a');
      fs.symlinkSync('real.css', at('style.css'));
      await files.write(C, 'style.css', Buffer.from('b'), { ifMatch: sha('a') });
      expect(fs.readFileSync(at('real.css'), 'utf8')).toBe('b');
      expect(fs.lstatSync(at('style.css')).isSymbolicLink()).toBe(true);
    });

    it('never commits bytes that are not the ones that were sent', async () => {
      put('functions.php', 'working');
      // What a request that died half-way looks like to the script: fewer bytes than promised.
      const res = await shell.execWithInput(
        C,
        ['sh', '-c', SCRIPTS.write, 'sh', at('functions.php'), 'any', '-', '100', sha('x'.repeat(100)), '-'],
        Buffer.from('x'.repeat(40)),
        { workdir: dir },
      );
      expect(res.exitCode).toBe(FILE_EXIT.short);
      expect(fs.readFileSync(at('functions.php'), 'utf8')).toBe('working');
      expect(leftovers()).toEqual([]);
    });

    it.skipIf(!php)('refuses PHP that does not parse, naming the line', async () => {
      put('functions.php', '<?php echo "ok";');
      const err = await refusal(
        files.write(C, 'functions.php', Buffer.from('<?php\n\necho "broken"\n}\n'), { lint: 'php' }),
      );
      expect(err).toMatchObject({ statusCode: 422, code: 'syntax_error' });
      expect(err.details).toMatchObject({ line: 4 });
      expect(fs.readFileSync(at('functions.php'), 'utf8')).toBe('<?php echo "ok";');
      await files.write(C, 'functions.php', Buffer.from('<?php echo "fine";'), { lint: 'php' });
    });

    it.skipIf(root)('says so when the folder is not the site user’s', async () => {
      fs.mkdirSync(at('locked'));
      put('locked/file.txt', 'a');
      fs.chmodSync(at('locked'), 0o555);
      try {
        const err = await refusal(files.write(C, 'locked/file.txt', Buffer.from('b')));
        expect(err.statusCode).toBe(403);
        expect(err.message).toMatch(/Fix ownership/);
      } finally {
        fs.chmodSync(at('locked'), 0o755);
      }
    });
  });

  describe('chunked upload', () => {
    const upload = (p: string, id: string, offset: number, size: number, chunk: Buffer, overwrite = false) =>
      files.appendChunk(C, { path: p, id, offset, size, overwrite }, chunk);
    const ID = 'abcdefghijklmnop';

    it('assembles a file from chunks and puts it in place with the last one', async () => {
      fs.mkdirSync(at('wp-content/uploads'), { recursive: true });
      const data = crypto.randomBytes(3000);
      expect(await upload('wp-content/uploads/a.bin', ID, 0, 3000, data.subarray(0, 1000))).toEqual({ received: 1000, written: null });
      await upload('wp-content/uploads/a.bin', ID, 1000, 3000, data.subarray(1000, 2000));
      const last = await upload('wp-content/uploads/a.bin', ID, 2000, 3000, data.subarray(2000));
      expect(last.written?.entry).toMatchObject({ name: 'a.bin', size: 3000, mode: '644' });
      expect(fs.readFileSync(at('wp-content/uploads/a.bin')).equals(data)).toBe(true);
      expect(leftovers('wp-content/uploads')).toEqual([]);
    });

    it('tells a client that lost track where to resume', async () => {
      await upload('a.bin', ID, 0, 30, Buffer.alloc(10, 1));
      const err = await refusal(upload('a.bin', ID, 20, 30, Buffer.alloc(10, 1)));
      expect(err.statusCode).toBe(409);
      expect(err.details).toEqual({ received: 10 });
    });

    it('refuses to replace an existing file unless asked, then replaces it', async () => {
      put('logo.png', 'old');
      expect((await refusal(upload('logo.png', ID, 0, 3, Buffer.from('new')))).statusCode).toBe(409);
      expect(fs.readFileSync(at('logo.png'), 'utf8')).toBe('old');
      await upload('logo.png', ID, 0, 3, Buffer.from('new'), true);
      expect(fs.readFileSync(at('logo.png'), 'utf8')).toBe('new');
    });

    it('answers the chunk that finished an upload again, when its answer was lost, writing nothing twice', async () => {
      const data = crypto.randomBytes(2000);
      await upload('a.bin', ID, 0, 2000, data.subarray(0, 1000));
      const last = await upload('a.bin', ID, 1000, 2000, data.subarray(1000));
      const { ino, mtimeMs } = fs.statSync(at('a.bin'));
      expect(await upload('a.bin', ID, 1000, 2000, data.subarray(1000))).toEqual({ ...last, replayed: true });
      expect(fs.statSync(at('a.bin'))).toMatchObject({ ino, mtimeMs });
      expect(fs.readFileSync(at('a.bin')).equals(data)).toBe(true);

      // An upload of one chunk, whose retry would otherwise find its own file in the way.
      const one = await upload('b.txt', 'ponmlkjihgfedcba', 0, 3, Buffer.from('abc'));
      expect(await upload('b.txt', 'ponmlkjihgfedcba', 0, 3, Buffer.from('abc'))).toEqual({ ...one, replayed: true });

      // Any other chunk under a finished upload's id is no retry, and is not answered as one.
      expect((await refusal(upload('a.bin', ID, 1000, 2000, Buffer.alloc(1000)))).statusCode).toBe(404);
    });

    it('uploads an empty file', async () => {
      const res = await upload('empty.txt', ID, 0, 0, Buffer.alloc(0));
      expect(res.written?.entry.size).toBe(0);
    });

    it('clears parts abandoned for over a day when a new upload starts in that folder', async () => {
      put('.wpl7-upload-old0000000000000.part', 'stale');
      const old = new Date(Date.now() - 2 * 86_400_000);
      fs.utimesSync(at('.wpl7-upload-old0000000000000.part'), old, old);
      put('.wpl7-upload-new0000000000000.part', 'in progress');
      await upload('x.txt', ID, 0, 1, Buffer.from('x'));
      expect(leftovers()).toEqual(['.wpl7-upload-new0000000000000.part']);
    });

    it('abort removes what arrived', async () => {
      await upload('big.bin', ID, 0, 100, Buffer.alloc(10));
      expect(leftovers()).toHaveLength(1);
      await files.abortUpload(C, 'big.bin', ID);
      expect(leftovers()).toEqual([]);
    });
  });

  describe('folders, moves, copies, deletes, permissions', () => {
    it('creates a folder, but not over anything', async () => {
      expect((await files.mkdir(C, 'assets')).type).toBe('dir');
      expect((await refusal(files.mkdir(C, 'assets'))).statusCode).toBe(409);
      expect((await refusal(files.mkdir(C, 'nope/deeper'))).statusCode).toBe(404);
    });

    it('renames and moves, never into itself and never over a folder', async () => {
      put('a/b/c.txt');
      put('other.txt');
      fs.mkdirSync(at('target'));
      expect((await files.move(C, 'a/b/c.txt', 'a/c2.txt', false)).name).toBe('c2.txt');
      expect(fs.existsSync(at('a/c2.txt'))).toBe(true);
      expect((await refusal(files.move(C, 'a', 'a/b/a', false))).statusCode).toBe(400);
      expect((await refusal(files.move(C, 'other.txt', 'a/c2.txt', false))).statusCode).toBe(409);
      await files.move(C, 'other.txt', 'a/c2.txt', true);
      expect(fs.existsSync(at('other.txt'))).toBe(false);
      expect((await refusal(files.move(C, 'a', 'target', true))).statusCode).toBe(409);
    });

    it('copies files and folders, links as links', async () => {
      put('theme/style.css', 'body{}');
      fs.symlinkSync('/etc/passwd', at('theme/sneaky'));
      await files.copy(C, 'theme', 'theme-backup');
      expect(fs.readFileSync(at('theme-backup/style.css'), 'utf8')).toBe('body{}');
      expect(fs.readlinkSync(at('theme-backup/sneaky'))).toBe('/etc/passwd');
      expect((await refusal(files.copy(C, 'theme', 'theme-backup'))).statusCode).toBe(409);
      expect((await refusal(files.copy(C, 'theme', 'theme/inner'))).statusCode).toBe(400);
    });

    it('deletes nothing when one path of a batch is wrong', async () => {
      put('one.txt');
      put('two.txt');
      const err = await refusal(files.remove(C, ['one.txt', 'missing.txt', 'two.txt']));
      expect(err.statusCode).toBe(404);
      expect(err.message).toContain('"missing.txt"');
      expect(fs.existsSync(at('one.txt'))).toBe(true);
      await files.remove(C, ['one.txt', 'two.txt']);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('deleting a link removes the link, not what it points at', async () => {
      put('keep/me.txt', 'safe');
      fs.symlinkSync('keep', at('link'));
      await files.remove(C, ['link']);
      expect(fs.readFileSync(at('keep/me.txt'), 'utf8')).toBe('safe');
    });

    it('changes permissions, but not through a link', async () => {
      put('script.sh');
      expect((await files.chmod(C, 'script.sh', '750')).mode).toBe('750');
      expect(fs.statSync(at('script.sh')).mode & 0o777).toBe(0o750);
      fs.symlinkSync('script.sh', at('alias'));
      expect((await refusal(files.chmod(C, 'alias', '777'))).statusCode).toBe(409);
      expect(fs.statSync(at('script.sh')).mode & 0o777).toBe(0o750);
    });
  });

  describe("the panel's own drop-ins", () => {
    it('writes, leaves an identical one alone, removes, and clears out the old name', async () => {
      put('wp-content/mu-plugins/ceo-login.php', '<?php // old');
      expect(await files.putDropIn(C, 'wpl7-login.php', '<?php // new', 'ceo-login.php')).toBe('written');
      expect(fs.readFileSync(at('wp-content/mu-plugins/wpl7-login.php'), 'utf8')).toBe('<?php // new');
      expect(fs.existsSync(at('wp-content/mu-plugins/ceo-login.php'))).toBe(false);
      expect(await files.putDropIn(C, 'wpl7-login.php', '<?php // new')).toBe('same');
      expect(await files.putDropIn(C, 'wpl7-login.php', null)).toBe('removed');
      expect(await files.putDropIn(C, 'wpl7-login.php', null)).toBe('absent');
      expect(leftovers('wp-content/mu-plugins')).toEqual([]);
    });

    it('replaces a link planted where the drop-in goes instead of writing through it', async () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-elsewhere-'));
      fs.writeFileSync(path.join(elsewhere, 'target.php'), 'precious');
      fs.mkdirSync(at('wp-content/mu-plugins'), { recursive: true });
      fs.symlinkSync(path.join(elsewhere, 'target.php'), at('wp-content/mu-plugins/wpl7-login.php'));
      await files.putDropIn(C, 'wpl7-login.php', '<?php // login');
      expect(fs.readFileSync(path.join(elsewhere, 'target.php'), 'utf8')).toBe('precious');
      expect(fs.lstatSync(at('wp-content/mu-plugins/wpl7-login.php')).isSymbolicLink()).toBe(false);
    });

    it('refuses when a folder on the way is a symlink - root must not be steerable', async () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-elsewhere-'));
      fs.symlinkSync(elsewhere, at('wp-content'));
      const err = await refusal(files.putDropIn(C, 'wpl7-login.php', '<?php'));
      expect(err.statusCode).toBe(409);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      const fix = await refusal(files.fixOwnership(C, 'wp-content/anything'));
      expect(fix.statusCode).toBe(409);
      expect(fix.message).toMatch(/symlink/);
    });

    it('refuses a mu-plugins folder that is a symlink', async () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-elsewhere-'));
      fs.mkdirSync(at('wp-content'), { recursive: true });
      fs.symlinkSync(elsewhere, at('wp-content/mu-plugins'));
      const err = await refusal(files.putDropIn(C, 'wpl7-login.php', '<?php'));
      expect(err.statusCode).toBe(409);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      put('wp-config.php', "<?php define('DB_NAME', 'x');");
      put('wp-content/plugins/bad/evil.php', '<?php eval(base64_decode($_POST["x"]));');
      put('wp-content/uploads/pic.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0]), Buffer.from('eval(base64_decode(')]));
      put('wp-content/themes/t/[odd].php', '<?php // EVAL(Base64_Decode( in a comment');
    });

    it('finds names, literally and ignoring case by default', async () => {
      const res = await files.search(C, { path: '', q: 'EVIL', mode: 'name', case: false, regex: false, include: [] });
      expect(res.matches).toEqual([{ path: 'wp-content/plugins/bad/evil.php', type: 'file' }]);
      const odd = await files.search(C, { path: 'wp-content', q: '[odd]', mode: 'name', case: false, regex: false, include: [] });
      expect(odd.matches.map((m) => m.path)).toEqual(['wp-content/themes/t/[odd].php']);
    });

    it('keeps a match in a file named with a line break with that file', async () => {
      put('odd\nname.php', '<?php eval(base64_decode($x));');
      const res = await files.search(C, { path: '', q: 'base64_decode($x)', mode: 'content', case: true, regex: false, include: [] });
      expect(res.matches.map((m) => m.path)).toEqual(['odd\nname.php']);
    });

    it('finds text inside files, skipping binaries, with line numbers', async () => {
      const res = await files.search(C, { path: '', q: 'eval(base64_decode(', mode: 'content', case: false, regex: false, include: [] });
      const found = res.matches.map((m) => [m.path, m.line]).sort();
      expect(found).toEqual([
        ['wp-content/plugins/bad/evil.php', 1],
        ['wp-content/themes/t/[odd].php', 1],
      ]);
      const exact = await files.search(C, { path: '', q: 'eval(base64_decode(', mode: 'content', case: true, regex: false, include: ['*.php'] });
      expect(exact.matches).toEqual([
        { path: 'wp-content/plugins/bad/evil.php', line: 1, text: '<?php eval(base64_decode($_POST["x"]));' },
      ]);
    });

    it('treats a regular expression as one when asked, and refuses a broken one', async () => {
      const res = await files.search(C, { path: '', q: "define\\('DB_[A-Z]+'", mode: 'content', case: true, regex: true, include: [] });
      expect(res.matches.map((m) => m.path)).toEqual(['wp-config.php']);
      const err = await refusal(files.search(C, { path: '', q: '(unclosed', mode: 'content', case: true, regex: true, include: [] }));
      expect(err.statusCode).toBe(400);
    });
  });

  describe('downloads', () => {
    it('streams a file whole', async () => {
      const data = crypto.randomBytes(200_000);
      put('a.bin', data);
      expect(await files.probeDownload(C, 'a.bin')).toEqual({ kind: 'file', size: 200_000 });
      const out = new PassThrough();
      const chunks: Buffer[] = [];
      out.on('data', (c: Buffer) => chunks.push(c));
      await files.streamFile(C, 'a.bin', 200_000, out);
      expect(Buffer.concat(chunks).equals(data)).toBe(true);
    });

    it('breaks the download of a file that shrank rather than ending it short', async () => {
      put('a.bin', 'short');
      const out = new PassThrough();
      out.resume();
      await expect(files.streamFile(C, 'a.bin', 100, out)).rejects.toThrow(/changed while/);
      expect(out.destroyed).toBe(true);
    });

    it('archives a folder, leaving the panel’s temporary files out', async () => {
      put('wp-content/themes/t/style.css', 'body{}');
      put('wp-content/themes/t/.wpl7-edit.abc', 'half a save');
      expect(await files.probeDownload(C, 'wp-content/themes')).toEqual({ kind: 'dir' });
      const out = new PassThrough();
      const chunks: Buffer[] = [];
      out.on('data', (c: Buffer) => chunks.push(c));
      await files.streamFolder(C, 'wp-content/themes', 'themes', out);
      const tar = zlib.gunzipSync(Buffer.concat(chunks)).toString('latin1');
      expect(tar).toContain('themes/t/style.css');
      expect(tar).not.toContain('.wpl7-edit');
    });

    it('names the whole site folder after the site', async () => {
      put('index.php', '<?php');
      const out = new PassThrough();
      const chunks: Buffer[] = [];
      out.on('data', (c: Buffer) => chunks.push(c));
      await files.streamFolder(C, '', 'my-blog', out);
      expect(zlib.gunzipSync(Buffer.concat(chunks)).toString('latin1')).toContain('my-blog/index.php');
    });
  });
});

describe.skipIf(!phpZip)('Web FTP zip archives, run for real', () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);

  /** An archive with hand-picked entry names, which no well-behaved tool would write. */
  function craftZip(rel: string, entries: { name: string; content?: string; symlinkTo?: string }[]): void {
    const code = `
      if (!class_exists('ZipArchive')) @dl('zip.so');
      $z = new ZipArchive();
      $z->open($argv[1], ZipArchive::CREATE | ZipArchive::OVERWRITE);
      foreach (json_decode($argv[2], true) as $e) {
        if (isset($e['symlinkTo'])) {
          $z->addFromString($e['name'], $e['symlinkTo']);
          $z->setExternalAttributesName($e['name'], ZipArchive::OPSYS_UNIX, (0120777 << 16));
        } else {
          $z->addFromString($e['name'], $e['content'] ?? 'x');
        }
      }
      $z->close();`;
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
    const res = spawnSync('php', ['-n', '-r', code, '--', at(rel), JSON.stringify(entries)]);
    expect(res.status, res.stderr.toString()).toBe(0);
  }

  it('compresses a folder and extracts it again', async () => {
    put('plugin/plugin.php', '<?php // plugin');
    put('plugin/assets/app.js', 'console.log(1)');
    fs.symlinkSync('/etc', at('plugin/escape'));
    put('plugin/.wpl7-edit.tmp', 'never archived');
    const made = await files.compressZip(C, { paths: ['plugin'], to: 'plugin.zip', overwrite: false }, log);
    expect(made).toMatchObject({ files: 2, skipped: 1 });

    fs.mkdirSync(at('restored'));
    const out = await files.extractZip(C, { path: 'plugin.zip', to: 'restored', overwrite: false }, log);
    expect(out).toMatchObject({ files: 2 });
    expect(fs.readFileSync(at('restored/plugin/assets/app.js'), 'utf8')).toBe('console.log(1)');
    expect(fs.existsSync(at('restored/plugin/escape'))).toBe(false);
    expect(fs.existsSync(at('restored/plugin/.wpl7-edit.tmp'))).toBe(false);
    expect(fs.statSync(at('restored/plugin/plugin.php')).mode & 0o777).toBe(0o644);

    // Again: everything is in the way now.
    const err = await refusal(files.extractZip(C, { path: 'plugin.zip', to: 'restored', overwrite: false }, log));
    expect(err.statusCode).toBe(409);
    expect(err.details).toMatchObject({ count: 2 });
    await files.extractZip(C, { path: 'plugin.zip', to: 'restored', overwrite: true }, log);
  });

  it('refuses a zip-slip archive whole, writing nothing', async () => {
    craftZip('evil.zip', [{ name: 'fine.txt' }, { name: '../outside.txt' }, { name: 'sub\\..\\..\\win.txt' }]);
    fs.mkdirSync(at('into'));
    const err = await refusal(files.extractZip(C, { path: 'evil.zip', to: 'into', overwrite: true }, log));
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/outside the folder/);
    expect(fs.readdirSync(at('into'))).toEqual([]);
    expect(fs.existsSync(at('outside.txt'))).toBe(false);
  });

  it('skips symlink entries, and never writes through a link on disk', async () => {
    craftZip('links.zip', [{ name: 'passwd', symlinkTo: '/etc/passwd' }, { name: 'ok.txt', content: 'fine' }]);
    const res = await files.extractZip(C, { path: 'links.zip', to: '', overwrite: false }, log);
    expect(res).toMatchObject({ files: 1, skipped: 1 });
    expect(fs.existsSync(at('passwd'))).toBe(false);

    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-elsewhere-'));
    fs.symlinkSync(elsewhere, at('uploads'));
    craftZip('through.zip', [{ name: 'uploads/shell.php', content: '<?php' }]);
    const err = await refusal(files.extractZip(C, { path: 'through.zip', to: '', overwrite: true }, log));
    expect(err.statusCode).toBe(409);
    expect(JSON.stringify(err.details)).toContain('a symlink');
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('says what is wrong with something that is not a zip', async () => {
    put('fake.zip', 'not a zip at all');
    const err = await refusal(files.extractZip(C, { path: 'fake.zip', to: '', overwrite: false }, log));
    expect(err.statusCode).toBe(400);
  });
});
