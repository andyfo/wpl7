import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/lib/wpVersions.js';
import { pluginFolderEntries, pluginHeaderVersion } from '../../src/lib/zipWriter.js';

/**
 * WPL7 Connect's version is its own, not the panel's. A site is offered the panel's copy only when
 * that copy's version is higher than the one it runs (docs/internal/connect-protocol.md, section
 * 12), so a change to any of the plugin's files needs a higher version, or no site ever gets it.
 *
 * PINNED is the version and a hash of the files that carry it. After a change to the plugin, raise
 * its version - the header of wpl7-connect.php, WPL7_CONNECT_VERSION in the same file, and the
 * Stable tag in readme.txt - then pin the new version and hash here.
 */
const PINNED = { version: '1.0.0', sha256: 'a6f8426e6c7de3e34a50f1af1faca0f0dd7ac398a334dfb67857cce2a04518cb' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../connect-plugin/wpl7-connect');

const version = () => pluginHeaderVersion(path.join(ROOT, 'wpl7-connect.php'));

/** The plugin's files as its zip takes them, hashed: every name, and every file's own hash. */
function filesHash(): string {
  const hash = crypto.createHash('sha256');
  for (const entry of pluginFolderEntries(ROOT)) {
    hash.update(`${entry.name}\n`);
    if (entry.data) hash.update(`${crypto.createHash('sha256').update(entry.data).digest('hex')}\n`);
  }
  return hash.digest('hex');
}

describe("WPL7 Connect's version", () => {
  it('is one version in the header, the constant and the readme', () => {
    const v = version();
    // What the plugin takes in an offer (WPL7_Connect_Selfupdate::VERSION_RE): it refuses anything else.
    expect(v).toMatch(/^[0-9][0-9A-Za-z.+-]{0,63}$/);
    expect(fs.readFileSync(path.join(ROOT, 'wpl7-connect.php'), 'utf8')).toContain(`define('WPL7_CONNECT_VERSION', '${v}');`);
    expect(fs.readFileSync(path.join(ROOT, 'readme.txt'), 'utf8').split('\n')).toContain(`Stable tag: ${v}`);
  });

  it("is above every version the plugin carried while it had the panel's", () => {
    // A release, a source build, an edge build, a checkout and an on-box build of the panel.
    for (const old of ['0.3.0-beta.3', '0.3.0-beta.3-source', '0.3.0-edge.f9e8d7c', '0.3.0-beta.3-dev', 'dev']) {
      expect(compareVersions(version()!, old), `${version()} against ${old}`).toBe(1);
    }
  });

  it("rises with any change to the plugin's files", () => {
    const now = { version: version(), sha256: filesHash() };
    if (now.version !== PINNED.version) {
      expect(compareVersions(now.version!, PINNED.version), `From ${PINNED.version} down to ${now.version}: no site would take it.`).toBe(1);
    }
    const advice =
      now.version === PINNED.version
        ? `WPL7 Connect's files changed, but its version is still ${PINNED.version}, so no site would be offered the change. Raise the version, then pin it with the new hash at the top of this file.`
        : `WPL7 Connect is ${now.version} now: pin it with its hash at the top of this file.`;
    expect(now, advice).toEqual(PINNED);
  });
});
