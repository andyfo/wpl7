/**
 * The PHP a malware scan runs in its containers (services/scanScripts.ts), run here by the
 * local PHP against a site built on the spot - its checksums computed from the files, then
 * the files tampered with the way a break-in does. Skipped where there is no PHP.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { CHECK_SCRIPT, MAX_REPORTED_FINDINGS, MAX_UNVERIFIED_FILES, REDUCER_SCRIPT, RULES_SCRIPT, ZIP_MANIFEST_SCRIPT } from '../../src/services/scanScripts.js';
import { parseCheck, parseInventory, parseSignatures, parseZipCheck } from '../../src/services/scanReport.js';
import { EXPLOIT_OVERRIDES, tuningArg } from '../../src/services/scanTuning.js';

const HAS_PHP = spawnSync('php', ['-v']).status === 0;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/scan');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const md5 = (text: string) => crypto.createHash('md5').update(text).digest('hex');
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

const CORE: Record<string, string> = {
  'index.php': "<?php\ndefine('WP_USE_THEMES', true);\n",
  'wp-login.php': '<?php // login\n',
  'wp-includes/version.php': "<?php\n$wp_version = '6.9.1';\n$wp_local_package = 'de_DE';\n",
  'wp-includes/functions.php': '<?php // functions\n',
  'wp-includes/js/jquery.js': '/* jquery */\n',
  'wp-admin/index.php': '<?php // dashboard\n',
  'wp-admin/css/admin.css': '/* admin */\n',
  'wp-content/plugins/akismet/akismet.php': '<?php // bundled copy, never compared as core\n',
};
const AKISMET: Record<string, string> = {
  'akismet.php': '<?php\n/*\nPlugin Name: Akismet Anti-spam\nVersion: 5.3\n*/\n',
  'class.akismet.php': '<?php // class\n',
  'readme.txt': '=== Akismet ===\n',
};

/** A site of those files, and the input a scan would hand the check for it. */
function makeSite() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-scan-site-'));
  dirs.push(root);
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  for (const [rel, text] of Object.entries(CORE)) if (!rel.startsWith('wp-content/')) put(rel, text);
  for (const [rel, text] of Object.entries(AKISMET)) put(`wp-content/plugins/akismet/${rel}`, text);
  put('wp-config.php', "<?php define('DB_NAME', 'x');\n");
  put('wp-content/plugins/premium/premium.php', '<?php\n/**\n * Plugin Name: Premium Thing\n * Version: 2.0.1\n * Text Domain: premium-thing\n */\n');
  put('wp-content/plugins/hello.php', '<?php\n/*\nPlugin Name: Hello Dolly\nVersion: 1.7.2\n*/\n');
  put('wp-content/themes/twentyx/style.css', '/*\nTheme Name: Twenty X\nVersion: 1.2\n*/\n');
  put('wp-content/uploads/2026/01/photo.jpg', 'JPEG');
  const input = {
    coreVersion: '6.9.1',
    core: { hashType: 'md5', files: Object.fromEntries(Object.entries(CORE).map(([f, t]) => [f, [md5(t)]])) },
    plugins: {
      akismet: { version: '5.3', hashType: 'sha256', files: Object.fromEntries(Object.entries(AKISMET).map(([f, t]) => [f, [sha256(t)]])) },
    },
  };
  return { root, put, input };
}

function run(code: string, root: string, args: string[]) {
  const script = code.replace("const ROOT = '/var/www/html';", `const ROOT = ${JSON.stringify(root)};`);
  const res = spawnSync('php', ['-d', 'display_errors=stderr', '-r', script, ...args], { encoding: 'utf8' });
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? -1 };
}

function check(root: string, input: unknown) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-scan-input-')), 'input.json');
  dirs.push(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(input));
  const res = run(CHECK_SCRIPT, root, ['check', file]);
  expect(res.stderr).toBe('');
  return parseCheck(res);
}

describe.skipIf(!HAS_PHP)('the check, in the site image', () => {
  it('reads what is installed from the headers, without running any of it', () => {
    const { root } = makeSite();
    const inv = parseInventory(run(CHECK_SCRIPT, root, ['inventory']));
    expect(inv.core).toEqual({ version: '6.9.1', locale: 'de_DE' });
    expect(inv.plugins).toEqual([
      { slug: 'akismet', version: '5.3', single: false, mainFile: 'akismet', textDomain: null },
      { slug: 'hello', version: '1.7.2', single: true, mainFile: 'hello', textDomain: null },
      { slug: 'premium', version: '2.0.1', single: false, mainFile: 'premium', textDomain: 'premium-thing' },
    ]);
    expect(inv.themes).toEqual([{ slug: 'twentyx', version: '1.2' }]);
  });

  it('finds nothing on a site that is what was published, and counts every package as verified', () => {
    const { root, input } = makeSite();
    const result = check(root, input);
    expect(result.state).toBe('complete');
    expect(result.findings).toEqual([]);
    expect(result.packages['core:wp-admin']).toEqual({ files: 2, verified: 2, modified: 0, extra: 0, missing: 0 });
    expect(result.packages['core:wp-includes/js']).toEqual({ files: 1, verified: 1, modified: 0, extra: 0, missing: 0 });
    expect(result.packages['plugin:akismet']).toMatchObject({ files: 3, verified: 3 });
    // wp-config.php is the site's own; wp-content's copy of akismet in the core list is not core's to check.
    expect(result.files).toBe(Object.keys(CORE).length - 1 + Object.keys(AKISMET).length + 5);
  });

  it('reports what a break-in leaves: changed, missing and extra files of WordPress and of a plugin', () => {
    const { root, put, input } = makeSite();
    put('wp-includes/functions.php', '<?php // functions\n@eval($_POST[1]);\n');
    fs.rmSync(path.join(root, 'wp-admin/index.php'));
    put('wp-includes/js/wp-cache.php', '<?php // dropped\n');
    put('wp-configs.php', '<?php // a lookalike at the top\n');
    put('wp-content/plugins/akismet/class.akismet.php', '<?php // class, patched\n');
    put('wp-content/plugins/akismet/views/x.php', '<?php // extra\n');
    put('wp-content/plugins/akismet/cache.log', 'not code');
    const result = check(root, input);
    const got = result.findings.map((f) => `${f.kind} ${f.path}`).sort();
    expect(got).toEqual([
      'core-extra wp-configs.php',
      'core-extra wp-includes/js/wp-cache.php',
      'core-missing wp-admin/index.php',
      'core-modified wp-includes/functions.php',
      'plugin-extra wp-content/plugins/akismet/views/x.php',
      'plugin-modified wp-content/plugins/akismet/class.akismet.php',
    ]);
    const modified = result.findings.find((f) => f.kind === 'core-modified')!;
    expect(modified).toMatchObject({ package: 'core', packageVersion: '6.9.1', sha256: sha256('<?php // functions\n@eval($_POST[1]);\n') });
    // The stray log file keeps akismet in the signature scan without being a finding itself.
    expect(result.packages['plugin:akismet']).toMatchObject({ modified: 1, extra: 2 });
    expect(result.packages['core:wp-includes']).toMatchObject({ modified: 1, extra: 1 });
    expect(result.packages['core:wp-includes/js']).toMatchObject({ verified: 1, extra: 1 });
    expect(result.packages['core:wp-admin']).toMatchObject({ verified: 1, missing: 1 });
  });

  it('flags PHP and handler tricks in uploads, and leaves protective rules alone', () => {
    const { root, put, input } = makeSite();
    put('wp-content/uploads/2026/01/shell.php', '<?php // x\n');
    put('wp-content/uploads/2026/01/pic.php.jpg', 'x');
    put('wp-content/uploads/2026/01/pic.PHTML', 'x');
    put('wp-content/uploads/.htaccess', '# enable\nAddHandler application/x-httpd-php .jpg\n');
    put('wp-content/uploads/b/.htaccess', 'Options +ExecCGI\n');
    put('wp-content/uploads/c/.user.ini', 'auto_prepend_file = /var/www/html/wp-content/uploads/x.jpg\n');
    // Wordfence's own guard, and a plain deny: nothing is switched on by either.
    put(
      'wp-content/uploads/wf/.htaccess',
      '<IfModule mod_php.c>\nphp_flag engine 0\n</IfModule>\nAddHandler cgi-script .php .phtml .php3 .pl .py\nOptions -ExecCGI\n',
    );
    put('wp-content/uploads/deny/.htaccess', 'Require all denied\n');
    const result = check(root, input);
    const got = result.findings.map((f) => `${f.kind} ${f.path} ${f.detail ?? ''}`.trim()).sort();
    expect(got).toEqual([
      'upload-handler wp-content/uploads/.htaccess AddHandler application/x-httpd-php .jpg',
      'upload-handler wp-content/uploads/b/.htaccess Options +ExecCGI',
      'upload-handler wp-content/uploads/c/.user.ini auto_prepend_file = /var/www/html/wp-content/uploads/x.jpg',
      'upload-php wp-content/uploads/2026/01/pic.PHTML',
      'upload-php wp-content/uploads/2026/01/pic.php.jpg',
      'upload-php wp-content/uploads/2026/01/shell.php',
    ]);
  });

  it('never follows a link, and reports the ones that leave the site or sit among WordPress files', () => {
    const { root, input } = makeSite();
    fs.symlinkSync('/etc/passwd', path.join(root, 'wp-content/uploads/notes.txt'));
    fs.symlinkSync('../index.php', path.join(root, 'wp-admin/alias.php'));
    fs.symlinkSync('/etc', path.join(root, 'wp-content/uploads/etc'));
    fs.symlinkSync('2026', path.join(root, 'wp-content/uploads/latest'));
    const result = check(root, input);
    const got = result.findings.map((f) => `${f.kind} ${f.path} ${f.detail}`).sort();
    expect(got).toEqual([
      'core-extra wp-admin/alias.php a link to ../index.php',
      'link-outside wp-content/uploads/etc /etc',
      'link-outside wp-content/uploads/notes.txt /etc/passwd',
    ]);
    expect(result.links.sort()).toEqual(['wp-admin/alias.php', 'wp-content/uploads/etc', 'wp-content/uploads/latest', 'wp-content/uploads/notes.txt']);
    // /etc was not walked: the files counted are the site's.
    expect(result.files).toBe(Object.keys(CORE).length - 1 + Object.keys(AKISMET).length + 5);
  });

  it('is incomplete, not clean, when it cannot read something', () => {
    const { root, input } = makeSite();
    const locked = [path.join(root, 'wp-content/plugins/akismet/class.akismet.php'), path.join(root, 'wp-content/themes')];
    for (const p of locked) fs.chmodSync(p, 0o000);
    let result: ReturnType<typeof check>;
    try {
      result = check(root, input);
    } finally {
      // Readable again, or the cleanup cannot remove them.
      fs.chmodSync(locked[0]!, 0o644);
      fs.chmodSync(locked[1]!, 0o755);
    }
    expect(result.state).toBe('incomplete');
    expect(result.problem).toMatch(/^2 files or folders could not be read \(wp-content\/(themes|plugins\/akismet\/class\.akismet\.php), /);
  });

  it("holds a plugin in a folder of another name to its list only to vouch for files: what differs is named, never a finding", () => {
    const { root, put, input } = makeSite();
    for (const [rel, text] of Object.entries(AKISMET)) put(`wp-content/plugins/akismet-copy/${rel}`, text);
    // Another edition of it: one file its own, one file more, one file fewer, a link.
    put('wp-content/plugins/akismet-copy/class.akismet.php', '<?php // the premium edition\n');
    put('wp-content/plugins/akismet-copy/pro.php', '<?php // only in the premium edition\n');
    fs.rmSync(path.join(root, 'wp-content/plugins/akismet-copy/readme.txt'));
    fs.symlinkSync('akismet.php', path.join(root, 'wp-content/plugins/akismet-copy/alias.php'));
    const vouchOnly = { ...input.plugins.akismet, vouchOnly: true };
    const result = check(root, { ...input, plugins: { ...input.plugins, 'akismet-copy': vouchOnly } });

    expect(result.state).toBe('complete');
    expect(result.findings.filter((f) => f.path.includes('akismet-copy'))).toEqual([]);
    expect(result.unverified).toEqual(['wp-content/plugins/akismet-copy/class.akismet.php']);
    expect(result.unverifiedPackages).toEqual([]);
    expect(result.packages['plugin:akismet-copy']).toEqual({ files: 4, verified: 1, modified: 1, extra: 2, missing: 0 });
  });

  it(`names at most ${MAX_UNVERIFIED_FILES} such files, and past that vouches for none of the plugin`, () => {
    const { root, put, input } = makeSite();
    const files: Record<string, string[]> = {};
    for (let i = 0; i <= MAX_UNVERIFIED_FILES; i++) {
      put(`wp-content/plugins/big-copy/f${i}.php`, `<?php // ${i}\n`);
      files[`f${i}.php`] = [sha256('something else')];
    }
    const result = check(root, { ...input, plugins: { ...input.plugins, 'big-copy': { version: '1.0', hashType: 'sha256', files, vouchOnly: true } } });
    expect(result.unverified).toHaveLength(MAX_UNVERIFIED_FILES);
    expect(result.unverifiedPackages).toEqual(['plugin:big-copy']);
    expect(result.findings).toEqual([]);
  });

  it("holds the panel's own files to the hashes it wrote them with, and never takes a link for one", () => {
    const { root, put, input } = makeSite();
    const login = '<?php // the panel\'s login drop-in\n';
    const licenses = "<?php define('ACF_PRO_LICENSE', 'k');\n";
    put('wp-content/mu-plugins/wpl7-login.php', login);
    put('wp-content/mu-plugins/wpl7-licenses.php', `${licenses}@eval($_POST[1]);\n`);
    put('wp-content/mu-plugins/someone-else.php', '<?php // not ours, not the check\'s\n');
    const panel = {
      'wp-content/mu-plugins/wpl7-login.php': [sha256(login)],
      'wp-content/mu-plugins/wpl7-licenses.php': [sha256('older'), sha256(licenses)],
    };
    let result = check(root, { ...input, panel });
    expect(result.findings.map((f) => `${f.kind} ${f.path} ${f.sha256}`)).toEqual([
      `panel-modified wp-content/mu-plugins/wpl7-licenses.php ${sha256(`${licenses}@eval($_POST[1]);\n`)}`,
    ]);

    fs.rmSync(path.join(root, 'wp-content/mu-plugins/wpl7-login.php'));
    fs.symlinkSync('someone-else.php', path.join(root, 'wp-content/mu-plugins/wpl7-login.php'));
    result = check(root, { ...input, panel });
    expect(result.findings.map((f) => `${f.kind} ${f.path} ${f.detail ?? ''}`.trim()).sort()).toEqual([
      'panel-modified wp-content/mu-plugins/wpl7-licenses.php',
      'panel-modified wp-content/mu-plugins/wpl7-login.php a link to someone-else.php',
    ]);
  });

  it("takes a plugin's deployed copy that is the same as its file for that file, and nothing else for one", () => {
    const { root, put, input } = makeSite();
    const endpoint = '<?php // recovery endpoint\n';
    put('wp-content/plugins/godmode/godmode.php', '<?php\n/*\nPlugin Name: Godmode\nVersion: 1.3\n*/\n');
    put('wp-content/plugins/godmode/direct/endpoint.php', endpoint);
    put('endpoint.php', endpoint);
    put('other.php', endpoint);
    const copies = { 'endpoint.php': 'wp-content/plugins/godmode/direct/endpoint.php', 'other.php': 'wp-content/plugins/godmode/direct/missing.php' };
    let result = check(root, { ...input, copies });
    expect(result.copies).toEqual({ 'endpoint.php': 'wp-content/plugins/godmode/direct/endpoint.php' });
    expect(result.findings.map((f) => `${f.kind} ${f.path}`)).toEqual(['core-extra other.php']);

    // Changed since it was deployed: an unknown file among WordPress's own like any other.
    put('endpoint.php', `${endpoint}@eval($_POST[1]);\n`);
    result = check(root, { ...input, copies });
    expect(result.copies).toEqual({});
    expect(result.findings.map((f) => `${f.kind} ${f.path}`).sort()).toEqual(['core-extra endpoint.php', 'core-extra other.php']);

    // A source reached through a link is not the plugin's file: the check never follows one.
    put('endpoint.php', endpoint);
    fs.renameSync(path.join(root, 'wp-content/plugins/godmode/direct'), path.join(root, 'elsewhere'));
    fs.symlinkSync('../../../elsewhere', path.join(root, 'wp-content/plugins/godmode/direct'));
    result = check(root, { ...input, copies });
    expect(result.copies).toEqual({});
    expect(result.findings.map((f) => `${f.kind} ${f.path}`)).toContain('core-extra endpoint.php');
  });

  it(`prints at most ${MAX_REPORTED_FINDINGS} findings and says there were more`, () => {
    const { root, put, input } = makeSite();
    for (let i = 0; i < MAX_REPORTED_FINDINGS + 5; i++) put(`wp-content/uploads/x/f${i}.php`, '<?php\n');
    const result = check(root, input);
    expect(result.findings).toHaveLength(MAX_REPORTED_FINDINGS);
    expect(result.truncated).toBe(true);
    expect(result.state).toBe('complete');
  });
});

describe.skipIf(!HAS_PHP)("a catalog zip's manifest, in AMWScan's container", () => {
  /** An unpacked zip: the folder, and what unzip said. */
  function unpacked(files: Record<string, string>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-zip-'));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    const said = path.join(root, '.unzip-said');
    fs.writeFileSync(said, '');
    const manifest = (folder: string, code = '0') => {
      const res = spawnSync('php', ['-d', 'display_errors=stderr', '-r', ZIP_MANIFEST_SCRIPT, root, folder, code, said], { encoding: 'utf8' });
      expect(res.stderr).toBe('');
      return parseZipCheck({ stdout: `${res.stdout}${JSON.stringify({ t: 'summary', engine: 'signatures', exit: 0, report: true, scanned: 2, complete: true, errors: 0, unreadable: 0, findings: 0, truncated: false })}\n`, stderr: '', exitCode: 0 }, folder);
    };
    return { root, said, manifest };
  }

  it("hashes every file of the folder, never a link, and reads the plugin's own header", () => {
    const { root, manifest } = unpacked({
      'premium-pro/premium-pro.php': '<?php\n/**\n * Plugin Name: Premium Pro\n * Version: 2.0.1\n */\n',
      'premium-pro/lib/rsa.php': '<?php // phpseclib\n',
      'premium-pro/readme.txt': 'Premium Pro\n',
    });
    fs.symlinkSync('/etc/passwd', path.join(root, 'premium-pro/lib/passwd.php'));
    const result = manifest('premium-pro');
    expect(result).toMatchObject({ state: 'complete', problem: null, name: 'Premium Pro', version: '2.0.1', findings: [] });
    expect(result.files).toEqual({
      'premium-pro.php': sha256('<?php\n/**\n * Plugin Name: Premium Pro\n * Version: 2.0.1\n */\n'),
      'lib/rsa.php': sha256('<?php // phpseclib\n'),
      'readme.txt': sha256('Premium Pro\n'),
    });
  });

  it('says so when the zip did not unpack to its folder, or unzip complained', () => {
    const { said, manifest } = unpacked({ 'other/x.php': '<?php' });
    fs.writeFileSync(said, 'unzip: short read\n');
    expect(manifest('premium-pro', '1')).toMatchObject({ state: 'failed', problem: 'The zip did not unpack to its folder "premium-pro": unzip: short read' });
    expect(manifest('other', '1')).toMatchObject({ state: 'incomplete', problem: 'unzip said: unzip: short read.', files: { 'x.php': sha256('<?php') } });
  });
});

describe.skipIf(!HAS_PHP)("the reducer, in AMWScan's container", () => {
  const reduce = (report: string, ...rest: string[]) => {
    const res = spawnSync('php', ['-r', REDUCER_SCRIPT, report, ...rest], { encoding: 'utf8' });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? -1 };
  };
  const tmp = (name: string, text: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-reducer-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };

  it("turns a real report into what the panel keeps: most serious first, relative paths, no integrity notes, no presence notes", () => {
    // Without the scanner beside it, as on a machine with only PHP: AMWScan's own names stay.
    const res = reduce(path.join(FIXTURES, 'amwscan-report.json'), '1', '134217728', '/dev/null', tuningArg(), '');
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe(fs.readFileSync(path.join(FIXTURES, 'signatures-output.jsonl'), 'utf8'));
    const parsed = parseSignatures(res);
    expect(parsed.state).toBe('complete');
    expect(parsed.definitions).toBe('2026.09.08.1');
    expect(parsed.findings.every((f) => !f.path.startsWith('/'))).toBe(true);
    expect(parsed.findings.some((f) => f.rule?.startsWith('integrity:'))).toBe(false);
    // exec() in WordPress's own debug page, posix_getpwuid() in its filesystem classes: what code does.
    expect(parsed.findings.some((f) => /^(function|process):/.test(f.rule ?? ''))).toBe(false);
    expect(parsed.quieted).toEqual({ presence: 4, inert: 0 });
    // Too large to read whole: a note, with each file's size, never a finding.
    expect(parsed.findings.some((f) => f.rule?.startsWith('file_size:'))).toBe(false);
    expect(parsed.partial).toEqual([
      { path: 'wp-includes/js/dist/block-editor.js', bytes: 3779971 },
      { path: 'wp-includes/js/dist/block-editor.min.js', bytes: 1411452 },
      { path: 'wp-includes/js/dist/block-library.js', bytes: 3025740 },
    ]);
    expect(parsed.partialCount).toBe(3);
  });

  it('names a signature finding after the signature itself, drops the inert ones, and keeps what it cannot name', () => {
    // The scanner's merged regexes, by the name it reports: each signature in one ends in its own group.
    const groups = tmp(
      'groups.json',
      JSON.stringify({
        '58ed5617': String.raw`<\?php @eval\(base64_decode\((?<X0badc0de>)|nothing-like-it(?<X11112222>)`,
        '2e0e3ce5': String.raw`Password: \S+(?<X22c684e7>)`,
        '4f4983a1': String.raw`does-not-match-the-text(?<X33334444>)`,
      }),
    );
    const res = reduce(path.join(FIXTURES, 'amwscan-report.json'), '1', '0', '/dev/null', JSON.stringify({ inert: ['22c684e7'] }), groups);
    expect(res.stderr).toBe('');
    const parsed = parseSignatures(res);
    const rules = parsed.findings.map((f) => `${f.rule} ${f.path}`);
    expect(rules).toContain('signature:0badc0de wp-content/uploads/2026/09/shell.php');
    expect(parsed.findings.find((f) => f.rule === 'signature:0badc0de')).toMatchObject({ kind: 'signature', confidence: 'confirmed', detail: expect.stringMatching(/^Malware signature 0badc0de: /) });
    // "Password: PASSWORD" in WordPress's own schema: read back to the inert signature, dropped.
    expect(rules.some((r) => r.includes('wp-admin/includes/schema.php') || r.includes('wp-admin/includes/upgrade.php'))).toBe(false);
    expect(parsed.quieted.inert).toBe(2);
    // Its group does not match the reported text, or there is no group: AMWScan's name, still known malware.
    expect(rules).toContain('sign:4f4983a1 wp-admin/includes/class-ftp.php');
    expect(rules).toContain('sign:608dc015 wp-content/uploads/link.php');
  });

  it('keeps a function or a process runner the scanner calls dangerous - hidden behind an encoding, fed from a request', () => {
    const finding = (rule: string, severity: string, message: string) => ({
      kind: 'malware',
      rule_id: rule,
      subject: '/var/www/html/wp-content/uploads/x.php',
      severity,
      message,
      evidence: { line: 1, match: 'eval(...)', content_hash: 'a'.repeat(64) },
    });
    const report = tmp(
      'report.json',
      JSON.stringify({
        scanned: 1,
        coverage: { complete: true, errors: 0, reasons: { unreadable: 0 } },
        findings: [
          finding('function:eval', 'danger', 'Encoded Function `eval`'),
          finding('process:framework_process_symfony', 'danger', 'Process run with request input'),
          finding('function:eval', 'warn', 'Potentially dangerous function `eval`'),
          finding('process:framework_process_symfony', 'warn', 'Potential Symfony process execution'),
        ],
      }),
    );
    const parsed = parseSignatures(reduce(report, '1', '0', '/dev/null', tuningArg(), ''));
    expect(parsed.findings.map((f) => `${f.rule} ${f.severity}`).sort()).toEqual(['function:eval medium', 'process:framework_process_symfony medium']);
    expect(parsed.quieted.presence).toBe(2);
  });

  it('says what the scanner said when there is no report', () => {
    const said = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-said-')), 'out');
    dirs.push(path.dirname(said));
    fs.writeFileSync(said, '\u001b[31mError: could not open definitions\u001b[0m\n');
    const parsed = parseSignatures(reduce('/nonexistent/report.json', '2', '0', said));
    expect(parsed.state).toBe('failed');
    expect(parsed.problem).toBe('The signature scan failed (exit 2): Error: could not open definitions');
  });
});

/** A definitions archive the way AMWScan ships one: a gzipped tar, exploits.json in it. */
function amwdb(exploits: object): Buffer {
  const entry = (name: string, body: Buffer) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  };
  const manifest = Buffer.from('{"format":"amwdb"}');
  return zlib.gzipSync(Buffer.concat([entry('manifest.json', manifest), entry('exploits.json', Buffer.from(JSON.stringify(exploits))), Buffer.alloc(1024)]));
}

describe.skipIf(!HAS_PHP)("the tuning, before AMWScan runs", () => {
  const upstream = (patterns: Record<string, string>) => ({
    schemaVersion: 1,
    default: Object.fromEntries(
      Object.entries(patterns).map(([name, pattern]) => [name, { description: `${name} upstream`, level: 'danger', pattern, link: 'https://example.test' }]),
    ),
    liteOverrides: {},
    liteExclusions: [],
  });
  const original = Object.fromEntries(EXPLOIT_OVERRIDES.map((o) => [o.name, o.replaces]));

  function prelude(archive: Buffer | null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-rules-'));
    dirs.push(dir);
    const file = path.join(dir, 'definitions.amwdb');
    if (archive) fs.writeFileSync(file, archive);
    const res = spawnSync('php', ['-d', 'display_errors=stderr', '-r', RULES_SCRIPT, file, tuningArg(), path.join(dir, 'rules')], { encoding: 'utf8' });
    expect(res.stderr).toBe('');
    const rules = path.join(dir, 'rules', 'exploits.json');
    return { line: JSON.parse(res.stdout.trim()), written: fs.existsSync(rules) ? JSON.parse(fs.readFileSync(rules, 'utf8')) : null };
  }

  it("writes WPL7's pattern into the scanner's local rules while AMWScan's is still the one it replaced", () => {
    const { line, written } = prelude(amwdb(upstream(original)));
    expect(line).toEqual({ t: 'tuning', applied: EXPLOIT_OVERRIDES.map((o) => o.name), skipped: [] });
    for (const o of EXPLOIT_OVERRIDES) {
      // Only the pattern is ours: AMWScan's description, level and link stay.
      expect(written.default[o.name]).toEqual({ pattern: o.pattern, description: `${o.name} upstream`, level: 'danger', link: 'https://example.test' });
    }
    expect(written).toMatchObject({ schemaVersion: 1, liteOverrides: {}, liteExclusions: [] });
  });

  it('leaves the scanner its own pattern once that is no longer the one replaced, and says so', () => {
    const [first, second] = EXPLOIT_OVERRIDES;
    const { line, written } = prelude(amwdb(upstream({ [first!.name]: '/fixed upstream/i', other: '/x/' })));
    expect(line.applied).toEqual([]);
    expect(line.skipped).toEqual([
      { name: first!.name, why: 'changed upstream' },
      { name: second!.name, why: 'gone upstream' },
    ]);
    expect(written).toBeNull();
  });

  it('applies nothing when it cannot read the definitions', () => {
    for (const archive of [null, Buffer.from('not gzip')]) {
      const { line, written } = prelude(archive);
      expect(line.applied).toEqual([]);
      expect(line.skipped.map((s: { why: string }) => s.why)).toEqual(EXPLOIT_OVERRIDES.map(() => 'definitions unreadable'));
      expect(written).toBeNull();
    }
  });
});
