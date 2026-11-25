import { describe, expect, it } from 'vitest';
import { phpStringDefines } from '../../src/lib/phpDefines.js';

const read = (src: string, ...names: string[]) => Object.fromEntries(phpStringDefines(src, names.length > 0 ? names : ['K']));

describe('the string constants of a PHP file, read without running it', () => {
  it('reads a define with a single-quoted value, its escapes as PHP reads them', () => {
    expect(read(String.raw`<?php define( 'K', 'it\'s a \\ and a \n' );`)).toEqual({ K: String.raw`it's a \ and a \n` });
    expect(read(`<?php define("K", 'v', true);`)).toEqual({ K: 'v' });
    expect(read(`<?php \\define('K', 'v');`)).toEqual({ K: 'v' });
    expect(read(`<?php defined('K') || define('K', 'v');`)).toEqual({ K: 'v' });
  });

  it('reads a double-quoted value only when PHP has nothing to work out in it', () => {
    expect(read(`<?php define('K', "plain value");`)).toEqual({ K: 'plain value' });
    expect(read(`<?php define('K', "with $var");`)).toEqual({});
    expect(read(`<?php define('K', "with \\x41");`)).toEqual({});
  });

  it('takes no define from a comment, a string, a method or inline HTML', () => {
    const src = `define('K', 'in the HTML before the code');
<?php
// define('K', 'line comment');
# define('K', 'hash comment');
/* define('K', 'block comment'); */
$s = "define('K', 'inside a string')";
$o->define('K', 'a method');
Foo::define('K', 'a static method');
?>
define('K', 'in the HTML after the code')
<?php define('K', 'the real one');`;
    expect(read(src)).toEqual({ K: 'the real one' });
  });

  it('steps over a heredoc, whatever quotes it holds', () => {
    const src = `<?php
$text = <<<EOT
it's "quoted" define('K', 'not this')
EOT;
define('K', 'after the heredoc');`;
    expect(read(src)).toEqual({ K: 'after the heredoc' });
  });

  it('leaves out a constant whose value depends on the run', () => {
    expect(read(`<?php define('K', getenv('K'));`)).toEqual({});
    expect(read(`<?php define('K', 'a' . 'b');`)).toEqual({});
    expect(read(`<?php if ($x) { define('K', 'one'); } else { define('K', 'two'); }`)).toEqual({});
    expect(read(`<?php if ($x) { define('K', getenv('K')); } else { define('K', 'two'); }`)).toEqual({});
    // The same value both ways is that value.
    expect(read(`<?php if ($x) { define('K', 'one'); } else { define('K', 'one'); }`)).toEqual({ K: 'one' });
  });

  it('answers only for the names asked about', () => {
    expect(read(`<?php define('A', 'a'); define('B', 'b'); define('C', 'c');`, 'A', 'C')).toEqual({ A: 'a', C: 'c' });
  });
});
