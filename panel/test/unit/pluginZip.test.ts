import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { storedZipPluginFolder, zipEntries, zipEntryNames, zipPluginFolder } from '../../src/lib/pluginZip.js';
import { zipOf } from '../helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-zip-'));
let written = 0;
const file = (bytes: Buffer): string => {
  const at = path.join(dir, `plugin-${written++}.zip`);
  fs.writeFileSync(at, bytes);
  return at;
};

const ACF = {
  'advanced-custom-fields-pro/': '',
  'advanced-custom-fields-pro/acf.php': '<?php',
  'advanced-custom-fields-pro/pro/updates.php': '<?php',
};

describe('zipPluginFolder', () => {
  it("is the zip's one top-level folder - what WordPress installs the plugin as", () => {
    expect(zipPluginFolder(file(zipOf(ACF)))).toBe('advanced-custom-fields-pro');
    // Plenty of zippers write no entries for folders at all.
    expect(zipPluginFolder(file(zipOf({ 'breakdance/plugin.php': '<?php', 'breakdance/readme.txt': '' })))).toBe('breakdance');
  });

  it('skips the __MACOSX folder, as WordPress does when it unzips', () => {
    const zip = zipOf({ ...ACF, '__MACOSX/': '', '__MACOSX/advanced-custom-fields-pro/._acf.php': 'rsrc' });
    expect(zipPluginFolder(file(zip))).toBe('advanced-custom-fields-pro');
  });

  // WordPress then installs into a folder named after the zip file, which a recipe cannot know.
  it('is null unless the top level is exactly one folder', () => {
    expect(zipPluginFolder(file(zipOf({ 'acf.php': '<?php', 'readme.txt': '' })))).toBeNull();
    expect(zipPluginFolder(file(zipOf({ 'acf.php': '<?php' })))).toBeNull();
    expect(zipPluginFolder(file(zipOf({ ...ACF, '.DS_Store': '' })))).toBeNull();
    expect(zipPluginFolder(file(zipOf({ 'one/a.php': '', 'two/b.php': '' })))).toBeNull();
    expect(zipPluginFolder(file(zipOf({})))).toBeNull();
  });

  // Checked against WordPress's own unzip_file: it writes each entry under its unzip folder
  // by the name as stored, skipping what validate_file refuses.
  it('reads entry names the way WordPress writes them out', () => {
    const dotted = zipOf({ './': '', './breakdance/': '', './breakdance/plugin.php': '<?php' });
    expect(zipPluginFolder(file(dotted))).toBe('breakdance');
    expect(zipPluginFolder(file(zipOf({ '/breakdance/plugin.php': '<?php' })))).toBe('breakdance');
    expect(zipPluginFolder(file(zipOf({ 'breakdance/plugin.php': '<?php', '../evil.php': '' })))).toBe('breakdance');
    // Its __MACOSX rule reads the stored name, so this one is extracted: two folders.
    const macos = zipOf({ './breakdance/plugin.php': '<?php', './__MACOSX/breakdance/._plugin.php': '' });
    expect(zipPluginFolder(file(macos))).toBeNull();
  });

  it('finds the index behind a zip comment, and behind Zip64 end records', () => {
    expect(zipPluginFolder(file(zipOf(ACF, { comment: 'Built by the vendor on a Tuesday' })))).toBe('advanced-custom-fields-pro');
    expect(zipPluginFolder(file(zipOf(ACF, { zip64: true })))).toBe('advanced-custom-fields-pro');
  });

  it('is null for a file that is not a zip, is cut short, or is not there', () => {
    expect(zipPluginFolder(file(Buffer.from('<?php // not a zip')))).toBeNull();
    expect(zipPluginFolder(file(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)])))).toBeNull();
    const whole = zipOf(ACF);
    expect(zipEntryNames(file(whole.subarray(0, whole.length - 30)))).toBeNull();
    expect(zipPluginFolder(path.join(dir, 'missing.zip'))).toBeNull();
  });
});

describe('storedZipPluginFolder', () => {
  it('reads a stored zip once, but keeps trying one it could not read', () => {
    const at = path.join(dir, 'stored.zip');
    expect(storedZipPluginFolder(at)).toBeNull();
    fs.writeFileSync(at, zipOf(ACF));
    expect(storedZipPluginFolder(at)).toBe('advanced-custom-fields-pro');
    fs.rmSync(at);
    expect(storedZipPluginFolder(at)).toBe('advanced-custom-fields-pro');
  });
});

describe('zipEntries', () => {
  it('says what each entry unpacks to, from the central directory alone', () => {
    expect(zipEntries(file(zipOf(ACF)))).toEqual([
      { name: 'advanced-custom-fields-pro/', size: 0 },
      { name: 'advanced-custom-fields-pro/acf.php', size: 5 },
      { name: 'advanced-custom-fields-pro/pro/updates.php', size: 5 },
    ]);
    expect(zipEntries(path.join(dir, 'missing.zip'))).toBeNull();
  });
});
