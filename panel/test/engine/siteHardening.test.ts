/**
 * "No PHP in uploads" on the real site images, with the file the panel renders: a PHP file there
 * must not run and must not be shown, on an image where mod_php's switch means nothing. It is asked
 * again with the <LocationMatch> deny taken out, because each of the two halves has to hold alone.
 *
 * Opt-in, like every test that boots a container. It needs both images, and no database: nothing
 * here gets as far as WordPress.
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine/siteHardening.test.ts
 *
 * WPL7_ENGINE_SITE_IMAGE is the current image (test/engine/siteStack.test.ts leaves one), and
 * WPL7_ENGINE_OLD_SITE_IMAGE one from before stack 2.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderApacheHardening } from '../../src/services/siteHardening.js';
import { APACHE_RELOAD_COMMAND } from '../../src/services/security.js';
import { SITE_STACK_PORT } from '../../src/services/siteStack.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const NEW_IMAGE = process.env.WPL7_ENGINE_SITE_IMAGE ?? 'wpl7-wordpress:php8.4-engine';
const OLD_IMAGE = process.env.WPL7_ENGINE_OLD_SITE_IMAGE ?? 'wpl7-wordpress:php8.4-stack1';
const CONF_IN_CONTAINER = '/etc/apache2/conf-enabled/zz-wpl7-security.conf';
const NEW_SITE = `wpl7-engine-hardening-new-${process.pid}`;
const OLD_SITE = `wpl7-engine-hardening-old-${process.pid}`;
const UPLOADS = '/var/www/html/wp-content/uploads';

/** A line PHP would drop if it ran, and that only someone reading the source could see. */
const SOURCE_ONLY = 'only-in-the-source';
const PHP_FILE = `<?php /* ${SOURCE_ONLY} */ echo 'php-' . 'ran';\n`;

/** Every spelling the panel's pattern covers. Only `evil.php` would run, but all of them hold source. */
const PHP_FILES = ['evil.php', 'evil.PHP', 'evil.php5', 'evil.phtml', 'evil.phar', 'evil.pht', 'evil.phps', 'evil.php.jpg', '2026/10/evil.php'];

interface Done {
  status: number;
  stdout: string;
  stderr: string;
}

function docker(args: string[], input?: string): Promise<Done> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function must(args: string[], input?: string): Promise<string> {
  const done = await docker(args, input);
  if (done.status !== 0) throw new Error(`docker ${args.join(' ')} failed (${done.status}): ${done.stderr}${done.stdout.slice(-2000)}`);
  return done.stdout.trim();
}

/** The file the panel renders, as it is, or with one of its parts left out. */
const rendered = renderApacheHardening({ blockPhpInUploads: true });
const withoutLocationDeny = rendered.replace(/<LocationMatch[\s\S]*?<\/LocationMatch>\n/, '');
const withoutRequire = withoutLocationDeny.replace(/^ *Require all denied\n/m, '');
const withoutFpmPart = withoutLocationDeny.replace(/<IfModule proxy_fcgi_module>[\s\S]*?<\/IfModule>\n/, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bootSite(name: string, image: string, conf: string): Promise<string> {
  return must(['run', '-d', '--name', name, '--network', 'none', '-v', `${conf}:${CONF_IN_CONTAINER}:ro`, image]);
}

/** An answer's status and body, from inside the container: Docker Desktop can't reach its address. */
async function ask(container: string, port: number, url: string): Promise<{ status: number; body: string }> {
  const done = await must(['exec', container, 'curl', '-sS', '-H', 'Host: uploads.example.com', '-w', '\n%{http_code}', `http://127.0.0.1:${port}${url}`]);
  const at = done.lastIndexOf('\n');
  return { status: Number(done.slice(at + 1)), body: done.slice(0, at) };
}

async function writeIn(container: string, file: string, content: string): Promise<void> {
  await must(['exec', '-i', '-u', '33:33', container, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file], content);
}

describe.skipIf(!ENABLED)('No PHP in uploads, on the real images', { timeout: 180_000 }, () => {
  let dir: string;
  let newConf: string;
  let oldConf: string;

  /** As the panel changes it in a running container: in place, checked, then a graceful reload. */
  async function apply(content: string): Promise<void> {
    fs.writeFileSync(newConf, content);
    await must(['exec', NEW_SITE, 'apache2ctl', '-t']);
    await must(['exec', NEW_SITE, ...APACHE_RELOAD_COMMAND]);
    await sleep(1_500);
  }

  async function up(container: string, port: number): Promise<void> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const done = await docker(['exec', container, 'curl', '-sS', '-o', '/dev/null', `http://127.0.0.1:${port}/wp-includes/images/blank.gif`]);
      if (done.status === 0) return;
      if (Date.now() > deadline) throw new Error(`${container} did not answer: ${done.stderr}`);
      await sleep(500);
    }
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-hardening-'));
    newConf = path.join(dir, 'new.conf');
    oldConf = path.join(dir, 'old.conf');
    fs.writeFileSync(newConf, rendered);
    fs.writeFileSync(oldConf, rendered);
    await bootSite(NEW_SITE, NEW_IMAGE, newConf);
    await bootSite(OLD_SITE, OLD_IMAGE, oldConf);
    await up(NEW_SITE, SITE_STACK_PORT);
    await up(OLD_SITE, 80);
    for (const container of [NEW_SITE, OLD_SITE]) {
      for (const file of PHP_FILES) await writeIn(container, `${UPLOADS}/${file}`, PHP_FILE);
      await writeIn(container, `${UPLOADS}/photo.jpg`, 'not really a photo');
      await writeIn(container, '/var/www/html/elsewhere.php', PHP_FILE);
    }
  }, 300_000);

  afterAll(async () => {
    await docker(['rm', '-f', '-v', NEW_SITE, OLD_SITE]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const expectRefused = async (container: string, port: number) => {
    for (const file of PHP_FILES) {
      const answer = await ask(container, port, `/wp-content/uploads/${file}`);
      expect(answer.status, file).toBe(403);
      expect(answer.body, file).not.toContain('php-ran');
      expect(answer.body, file).not.toContain(SOURCE_ONLY);
    }
  };

  const expectTheRestWorks = async (container: string, port: number) => {
    expect((await ask(container, port, '/wp-content/uploads/photo.jpg')).body).toBe('not really a photo');
    expect((await ask(container, port, '/elsewhere.php')).body).toBe('php-ran');
  };

  it('stack 2: refused, and everything else still works', async () => {
    await apply(rendered);
    await expectRefused(NEW_SITE, SITE_STACK_PORT);
    await expectTheRestWorks(NEW_SITE, SITE_STACK_PORT);
    // Apache itself, as the panel's REST tool reaches it, without nginx in front.
    await expectRefused(NEW_SITE, 80);
  });

  it('stack 2: refused with the <LocationMatch> deny taken out', async () => {
    expect(withoutLocationDeny).not.toContain('LocationMatch');
    await apply(withoutLocationDeny);
    await expectRefused(NEW_SITE, SITE_STACK_PORT);
    await expectTheRestWorks(NEW_SITE, SITE_STACK_PORT);
  });

  it('stack 2: taking the handler away alone would show the source, which is why it is refused too', async () => {
    await apply(withoutRequire);
    const shown = await ask(NEW_SITE, SITE_STACK_PORT, '/wp-content/uploads/evil.php');
    expect(shown.status).toBe(200);
    expect(shown.body).toContain(SOURCE_ONLY);
  });

  it('stack 2: without that part PHP would run in uploads, because mod_php’s switch means nothing here', async () => {
    await apply(withoutFpmPart);
    expect((await ask(NEW_SITE, SITE_STACK_PORT, '/wp-content/uploads/evil.php')).body).toBe('php-ran');
  });

  it('stack 2: a .htaccess in uploads cannot give PHP back, because the <LocationMatch> comes after it', async () => {
    await apply(rendered);
    await writeIn(NEW_SITE, `${UPLOADS}/.htaccess`, '<FilesMatch "\\.php$">\nSetHandler "proxy:unix:/run/wpl7/php-fpm.sock|fcgi://localhost"\nRequire all granted\n</FilesMatch>\n');
    await expectRefused(NEW_SITE, SITE_STACK_PORT);
    await must(['exec', '-u', '33:33', NEW_SITE, 'rm', '-f', `${UPLOADS}/.htaccess`]);
  });

  it('stack 1: Apache takes the same file, loads nothing new, and refuses the same', async () => {
    await must(['exec', OLD_SITE, 'apache2ctl', '-t']);
    const modules = await must(['exec', OLD_SITE, 'apache2ctl', '-M']);
    expect(modules).toContain('php_module');
    expect(modules).not.toContain('proxy_fcgi_module');
    await expectRefused(OLD_SITE, 80);
    await expectTheRestWorks(OLD_SITE, 80);
  });
});
