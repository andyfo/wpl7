import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { notFound, preconditionFailed } from '../../src/lib/errors.js';
import { clearPluginLeftovers, withoutWpRocketRules } from '../../src/services/pluginLeftovers.js';

/** WP Rocket's block as it writes it, between rules of the site's own. */
const ROCKET = '# BEGIN WP Rocket\n<IfModule mod_expires.c>\nExpiresByType text/html "access plus 0 seconds"\n</IfModule>\n# END WP Rocket\n';

/** A site's files with one .htaccess, as SiteFilesService reads and saves it. */
function filesWith(htaccess: Buffer | null) {
  const saved: { body: Buffer; ifMatch?: string }[] = [];
  const etag = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  return {
    saved,
    files: {
      read: async (_container: string, path: string) => {
        if (path !== '.htaccess' || htaccess === null) throw notFound(`"${path}" does not exist`);
        return { bytes: htaccess, etag: etag(htaccess) };
      },
      write: async (_container: string, path: string, body: Buffer, opts: { ifMatch?: string } = {}) => {
        saved.push({ body, ...opts });
        return { path, entry: {} as never, etag: etag(body) };
      },
    },
  };
}

describe("WP Rocket's rules, which its deactivation leaves in .htaccess under WP-CLI", () => {
  it('takes out the lines from its BEGIN marker to its END marker, and nothing else', () => {
    expect(withoutWpRocketRules(`# BEGIN Imagify\nAddType image/webp .webp\n# END Imagify\n\n${ROCKET}#AddType application/wasm wasm\n`)).toBe(
      '# BEGIN Imagify\nAddType image/webp .webp\n# END Imagify\n\n#AddType application/wasm wasm\n',
    );
    // Windows line ends stay as they were around the block.
    expect(withoutWpRocketRules(`a\r\n${ROCKET.replaceAll('\n', '\r\n')}b\r\n`)).toBe('a\r\nb\r\n');
  });

  it('leaves a file without a whole block alone, as WP Rocket would take everything after a BEGIN with no END', () => {
    expect(withoutWpRocketRules('# BEGIN WordPress\nRewriteEngine On\n# END WordPress\n')).toBeNull();
    expect(withoutWpRocketRules('# BEGIN WP Rocket\nExpiresActive on\n# BEGIN WordPress\n')).toBeNull();
    expect(withoutWpRocketRules('# END WP Rocket\n# BEGIN WP Rocket\n')).toBeNull();
  });

  it("saves .htaccess without them after WP Rocket is deactivated, over the version it read, every other byte as it was", async () => {
    // A byte that is not UTF-8 and a curly quote that is: both come back as they were.
    const before = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\n'), Buffer.from(ROCKET), Buffer.from('# don’t\n')]);
    const { files, saved } = filesWith(before);
    expect(await clearPluginLeftovers(files, 'wp-shop', ['akismet', 'wp-rocket'])).toEqual({
      ok: true,
      message: "Took WP Rocket's rules out of .htaccess, as WP Rocket does when it is deactivated in wp-admin.",
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.body.equals(Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\n# don’t\n')]))).toBe(true);
    expect(saved[0]!.ifMatch).toBe(crypto.createHash('sha256').update(before).digest('hex'));
  });

  it('does nothing for other plugins, without a block, or without an .htaccess', async () => {
    for (const [htaccess, slugs] of [
      [Buffer.from(ROCKET), ['akismet']],
      [Buffer.from('# BEGIN WordPress\n# END WordPress\n'), ['wp-rocket']],
      [null, ['wp-rocket']],
    ] as const) {
      const { files, saved } = filesWith(htaccess);
      expect(await clearPluginLeftovers(files, 'wp-shop', slugs)).toBeNull();
      expect(saved).toEqual([]);
    }
  });

  it('says so when .htaccess changed in between, and saves nothing over the change', async () => {
    const { files } = filesWith(Buffer.from(ROCKET));
    files.write = async () => {
      throw preconditionFailed('.htaccess changed since it was read');
    };
    expect(await clearPluginLeftovers(files, 'wp-shop', ['wp-rocket'])).toEqual({
      ok: false,
      message: "Could not take WP Rocket's rules out of .htaccess (.htaccess changed since it was read): take them out on the Files tab.",
    });
  });
});
