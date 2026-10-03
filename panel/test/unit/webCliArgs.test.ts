import { describe, expect, it } from 'vitest';
import { cliArgsProblem, formatCliArgs, tokenizeCli } from '../../web/src/lib/cliArgs.js';

/**
 * A WP-CLI line typed into the panel becomes the argv the API runs - never a shell string -
 * and a stored argv goes back into the schedule editor's text box. Both directions have to
 * agree, or saving a schedule without touching it would change what it runs.
 */

describe('WP-CLI command lines', () => {
  it('splits on spaces and keeps quoted arguments whole', () => {
    expect(tokenizeCli('cache flush')).toEqual(['cache', 'flush']);
    expect(tokenizeCli('option update blogname "My Site"')).toEqual(['option', 'update', 'blogname', 'My Site']);
    expect(tokenizeCli("post create --post_title='Hello world'")).toEqual(['post', 'create', '--post_title=Hello world']);
    expect(tokenizeCli('  plugin   list  ')).toEqual(['plugin', 'list']);
    expect(tokenizeCli('option update x ""')).toEqual(['option', 'update', 'x', '']);
  });

  it('round-trips an argv through the text box', () => {
    const argvs = [
      ['cache', 'flush'],
      ['option', 'update', 'blogname', 'My Site'],
      ['option', 'update', 'tagline', "It's mine"],
      ['eval', 'echo "hi";'],
      ['option', 'update', 'x', ''],
      ['search-replace', 'http://old', 'https://new', '--all-tables'],
      // Both kinds of quote in one argument: no single kind of quoting can hold it.
      ['eval', 'echo "it\'s fine";'],
      ['eval', `echo '"'; echo "'";`],
      ['option', 'update', 'x', `'"`],
    ];
    for (const argv of argvs) {
      const line = formatCliArgs(argv);
      expect(tokenizeCli(line), line).toEqual(argv);
      // What the editor loads, it can save again.
      expect(cliArgsProblem(line), line).toBeNull();
    }
    expect(formatCliArgs(['eval', 'echo "it\'s fine";'])).toBe(`eval 'echo "it'"'"'s fine";'`);
  });

  it('says what is wrong with a line before it is sent', () => {
    expect(cliArgsProblem('cache flush')).toBeNull();
    expect(cliArgsProblem('option update blogname "My Site')).toMatch(/double quote is never closed/);
    expect(cliArgsProblem("option update blogname 'My Site")).toMatch(/single quote is never closed/);
    expect(cliArgsProblem('   ')).toMatch(/Type a command/);
    expect(cliArgsProblem('')).toMatch(/Type a command/);
  });
});
