/**
 * WPL7's tuning of AMWScan (services/scanTuning.ts), held to what it was written for: each
 * tightened exploit pattern still matches the backdoor shapes the original was there to catch,
 * and no longer matches the plugin code it tripped on. Run by the local PHP - the patterns are
 * PCRE, possessive quantifiers and all. Skipped where there is no PHP.
 *
 * The real scanner over real plugins, with the tuning, is test/engine (docs/internal/watchlist.md).
 */
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EXPLOIT_OVERRIDES, INERT_SIGNATURES } from '../../src/services/scanTuning.js';

const HAS_PHP = spawnSync('php', ['-v']).status === 0;

/** Whether `pattern` matches `code`, by PHP's preg_match. */
function matches(pattern: string, code: string): boolean {
  const res = spawnSync('php', ['-r', 'echo preg_match($argv[1], $argv[2]);', pattern, code], { encoding: 'utf8' });
  if (res.stdout !== '0' && res.stdout !== '1') throw new Error(`preg_match failed: ${res.stdout}${res.stderr}`);
  return res.stdout === '1';
}

const override = (name: string) => EXPLOIT_OVERRIDES.find((o) => o.name === name)!;

/** Backdoor shapes each exploit was written for: both patterns must match every one. */
const CAUGHT: Record<string, string[]> = {
  str_replace_eval: [
    "<?php\n$c = str_replace('<?php', '', base64_decode($_POST['d']));\neval($c);\n",
    '<?php\n$a = str_replace("<?", "", file_get_contents($u));\n$b = trim($a);\neval($b);\n',
    "<?php $x=str_replace(\"<?php\",\"\",$y);eval($x);",
  ],
  execution2: [
    "<?php\narray_filter(array($_POST['x']), $_POST['f']);\n",
    "<?php\nusort($list, $_GET['cmp']);\n",
    "<?php\narray_walk($a, base64_decode('c3lzdGVt'));\n",
    "<?php\nuasort($rows, getenv('HTTP_X'));\n",
  ],
};

/** Ordinary plugin code each original pattern matched: the tightened one must not. */
const ORDINARY: Record<string, string[]> = {
  // A path made relative near the top, an eval of the plugin's own code far below it.
  str_replace_eval: [
    [
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
    ].join('\n'),
    // A test case: the fixture's name made relative, the condition it carries evaluated later.
    [
      '<?php',
      "$tests[] = [str_replace($fixturesDir.'/', '', $file), $message, $condition];",
      '}',
      'return $tests;',
      '}',
      'protected function doIntegrationTest($file, $message, $condition) {',
      '$this->assertNotEmpty($file);',
      'if ($condition) {',
      "  eval('$ret = '.$condition.';');",
      '}',
    ].join('\n'),
  ],
  // The callback is intval; the request value is array_map's, not array_filter's.
  execution2: ["<?php\n$ids = array_filter(array_map('intval', $_POST['allowed_users']));\n"],
};

describe.skipIf(!HAS_PHP)("WPL7's exploit overrides", () => {
  it('replace exactly the two patterns they were written against', () => {
    expect(EXPLOIT_OVERRIDES.map((o) => o.name).sort()).toEqual(Object.keys(CAUGHT).sort());
    for (const o of EXPLOIT_OVERRIDES) expect(o.pattern, o.name).not.toBe(o.replaces);
  });

  for (const name of Object.keys(CAUGHT)) {
    it(`${name}: still catches what AMWScan's pattern catches`, () => {
      const o = override(name);
      for (const code of CAUGHT[name]!) {
        expect(matches(o.replaces, code), `AMWScan's on ${code}`).toBe(true);
        expect(matches(o.pattern, code), `WPL7's on ${code}`).toBe(true);
      }
    });

    it(`${name}: no longer matches the plugin code AMWScan's did`, () => {
      const o = override(name);
      for (const code of ORDINARY[name]!) {
        expect(matches(o.replaces, code), `AMWScan's on ${code}`).toBe(true);
        expect(matches(o.pattern, code), `WPL7's on ${code}`).toBe(false);
      }
    });
  }
});

describe('inert signatures', () => {
  it('are named the way AMWScan names a signature inside its merged regexes: crc32b of the pattern', () => {
    // A raw signature's pattern is its text, regex-quoted - "@preg_replace" has nothing to quote.
    const preg = INERT_SIGNATURES.find((s) => s.id === '22c684e7')!;
    expect(zlib.crc32('@preg_replace').toString(16).padStart(8, '0')).toBe(preg.id);
  });
});
