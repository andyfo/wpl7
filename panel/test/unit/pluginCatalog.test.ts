import fs from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTestDb, FakeWporg, makeTestConfig, zipOf } from '../helpers.js';
import { PluginCatalogService } from '../../src/services/pluginCatalog.js';

/** Minimal valid zip: local file header magic + trailing bytes is enough for the magic check. */
const zipBytes = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
const zipStream = () => Readable.from([zipBytes()]) as NodeJS.ReadableStream & { truncated?: boolean };

function makeService() {
  const config = makeTestConfig();
  const wporg = new FakeWporg();
  const svc = new PluginCatalogService(createTestDb(), config.paths.plugins, wporg);
  return { svc, dir: config.paths.plugins, wporg };
}

describe('PluginCatalogService.saveZip', () => {
  it('stores the zip and lists it', async () => {
    const { svc, dir } = makeService();
    const plugin = await svc.saveZip('my-plugin.zip', zipStream(), {});
    expect(plugin.kind).toBe('zip');
    expect(plugin.zipPath && fs.existsSync(plugin.zipPath)).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  // Recipes go by the folder: a vendor's download is usually named for the release.
  it('knows the folder the zip installs into, whatever the file is called', async () => {
    const { svc } = makeService();
    const zip = zipOf({ 'breakdance/plugin.php': '<?php', 'breakdance/readme.txt': '' });
    const plugin = await svc.saveZip('breakdance-2.7.1.zip', Readable.from([zip]), {});
    expect(plugin).toMatchObject({ slug: 'breakdance-2-7-1', pluginDir: 'breakdance' });
    expect(svc.list()[0]?.pluginDir).toBe('breakdance');
  });

  it('rejects non-zip uploads without leaving a file behind', async () => {
    const { svc, dir } = makeService();
    const notZip = Readable.from([Buffer.from('<?php // definitely not a zip')]) as NodeJS.ReadableStream;
    await expect(svc.saveZip('evil.zip', notZip, {})).rejects.toThrow(/not a zip/);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  // Regression: the rejected upload had already been renamed to its final name, and only
  // the (now missing) temp path was cleaned up - leaving up-to-100MB orphans in /srv/plugins.
  it('does not orphan the file when the catalog name is already taken', async () => {
    const { svc, dir } = makeService();
    await svc.saveZip('my-plugin.zip', zipStream(), {});
    await expect(svc.saveZip('my-plugin.zip', zipStream(), {})).rejects.toThrow(/already exists/);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('deletes the zip file when the catalog entry is removed', async () => {
    const { svc, dir } = makeService();
    const plugin = await svc.saveZip('my-plugin.zip', zipStream(), {});
    await svc.delete(plugin.id);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});

describe('PluginCatalogService.createWporg', () => {
  it('stores the directory’s canonical name, not the raw slug', async () => {
    const { svc, wporg } = makeService();
    wporg.add('wordpress-seo', { name: 'Yoast SEO – Advanced SEO' });

    const plugin = await svc.createWporg({ slug: 'wordpress-seo', isDefault: false });

    expect(plugin.name).toBe('Yoast SEO – Advanced SEO');
    expect(plugin.slug).toBe('wordpress-seo');
  });

  // The whole point of the check: a slug typed from memory used to sit in the catalog until
  // a site-create job quietly logged "Plugin \"woo-comerce\" failed to install".
  it('refuses a slug the directory does not have, and stores nothing', async () => {
    const { svc } = makeService();

    await expect(svc.createWporg({ slug: 'woo-comerce', isDefault: false })).rejects.toThrow(
      /not a plugin on wordpress.org/,
    );
    expect(svc.list()).toHaveLength(0);
  });

  it('normalises the slug before checking and storing it', async () => {
    const { svc, wporg } = makeService();

    const plugin = await svc.createWporg({ slug: '  Akismet ', isDefault: false });

    expect(plugin.slug).toBe('akismet');
    expect(wporg.calls).toContainEqual({ method: 'info', arg: 'akismet' });
  });

  it('keeps an explicit name over the directory’s', async () => {
    const { svc } = makeService();
    const plugin = await svc.createWporg({ slug: 'akismet', name: 'Spam filter', isDefault: true });
    expect(plugin.name).toBe('Spam filter');
    expect(plugin.isDefault).toBe(true);
  });

  it('propagates an unreachable directory instead of silently accepting the slug', async () => {
    const { svc, wporg } = makeService();
    wporg.goOffline();

    await expect(svc.createWporg({ slug: 'akismet', isDefault: false })).rejects.toThrow(/Could not reach/);
    expect(svc.list()).toHaveLength(0);
  });

  it('force skips the check, for panels with no outbound internet access', async () => {
    const { svc, wporg } = makeService();
    wporg.goOffline();

    const plugin = await svc.createWporg({ slug: 'internal-plugin', isDefault: false, force: true });

    expect(plugin.slug).toBe('internal-plugin');
    expect(wporg.calls).toHaveLength(0);
  });

  it('still rejects a duplicate slug', async () => {
    const { svc } = makeService();
    await svc.createWporg({ slug: 'akismet', isDefault: false });
    await expect(svc.createWporg({ slug: 'akismet', isDefault: false })).rejects.toThrow(/already in the catalog/);
  });
});
