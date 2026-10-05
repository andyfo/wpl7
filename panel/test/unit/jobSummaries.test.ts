import { describe, expect, it } from 'vitest';
import { jobTypes } from '../../shared/schemas.js';
import { JOB_TYPE_INFO, jobLabel, typesInCategories, typesMatching } from '../../shared/jobTypes.js';
import { maskCliArgs, maskRestRoute, maskResult, maskShell, summarizeJob } from '../../src/jobs/summaries.js';

describe('job type catalog', () => {
  it('names and describes every job type', () => {
    for (const type of jobTypes) {
      const info = JOB_TYPE_INFO[type];
      expect(info.label.length, type).toBeGreaterThan(0);
      expect(info.description.length, type).toBeGreaterThan(10);
    }
  });

  it('falls back to the id for a type this build does not know', () => {
    expect(jobLabel('wp.scanAll')).toBe('WordPress inventory scan');
    expect(jobLabel('from.the.future')).toBe('from.the.future');
  });

  it('finds types by label and by category', () => {
    expect(typesMatching('inventory')).toEqual(['wp.scanAll']);
    expect(typesMatching('')).toEqual([]);
    expect(typesInCategories(['backups'])).toContain('backup.offsite');
    expect(typesInCategories(['backups'])).not.toContain('site.create');
  });
});

describe('summarizeJob', () => {
  it('summarizes every job type without throwing, whatever the payload', () => {
    for (const type of jobTypes) {
      for (const payload of [{}, null, 'nonsense', { ops: 'not a list' }]) {
        const summary = summarizeJob(type, payload);
        expect(summary === null || typeof summary === 'string', type).toBe(true);
      }
    }
  });

  it('never repeats the admin password of a new site', () => {
    const summary = summarizeJob('site.create', {
      siteId: 1,
      adminPassword: 'hunter2-hunter2',
      passwordGenerated: false,
      pluginSlugs: ['akismet'],
      pluginZipPaths: [],
    });
    expect(summary).toBe('With 1 plugin');
    expect(JSON.stringify(summary)).not.toContain('hunter2');
  });

  it('says what a WordPress job does', () => {
    expect(summarizeJob('wp.pluginTask', { siteId: 1, action: 'update', name: 'akismet' })).toBe('Update plugin akismet');
    expect(summarizeJob('wp.pluginTask', { siteId: 1, action: 'install', source: { kind: 'wporg', slug: 'wordpress-seo' } })).toBe(
      'Install plugin wordpress-seo',
    );
    expect(
      summarizeJob('wp.bulkTask', {
        siteId: 1,
        ops: [
          { kind: 'plugin', slug: 'a', action: 'update' },
          { kind: 'plugin', slug: 'b', action: 'update' },
          { kind: 'theme', slug: 't', action: 'update' },
          { kind: 'core', action: 'update' },
        ],
      }),
    ).toBe('Update 2 plugins, 1 theme, WordPress');
    expect(
      summarizeJob('wp.bulkTask', { siteId: 1, policy: { plugins: true, themes: false, core: true, onlyVulnerable: true } }),
    ).toBe('Update plugins and WordPress that fix a vulnerability');
    expect(summarizeJob('wp.scanAll', {})).toBe('Every running site');
    expect(summarizeJob('wp.scanAll', { siteIds: [1, 2] })).toBe('2 sites');
  });

  it('says what a deletion of sites and backups keeps', () => {
    expect(summarizeJob('site.delete', { siteId: 1, finalBackup: true })).toBe('After a final backup');
    expect(summarizeJob('site.delete', { siteId: 1, finalBackup: false, deleteBackups: false })).toBe('Without a final backup');
    expect(summarizeJob('site.delete', { siteId: 1, finalBackup: true, deleteBackups: true })).toBe('Keeping only a final backup');
    expect(summarizeJob('site.delete', { siteId: 1, finalBackup: false, deleteBackups: true })).toBe('With its backups, no final one');
    expect(summarizeJob('backup.delete', { backupIds: [4, 5, 6] })).toBe('3 backups');
    expect(summarizeJob('backup.delete', { backupIds: [4], parentJobId: 40 })).toBe('1 backup, after job #40 deleted the site');
  });

  it('names the target server of a move by name when it can', () => {
    expect(summarizeJob('site.move', { targetServerId: 3 }, { server: () => 'fra-2' })).toBe('To fra-2');
    expect(summarizeJob('site.move', { targetServerId: 3 })).toBe('To server #3');
  });

  it('shows a command line with its credentials masked', () => {
    expect(summarizeJob('wp.cli', { args: ['user', 'update', 'admin', '--user_pass=s3cret'] })).toBe(
      'wp user update admin --user_pass=•••',
    );
    expect(summarizeJob('wp.cli', { args: ['option', 'update', 'blogname', 'My Site'] })).toBe(
      'wp option update blogname "My Site"',
    );
    expect(maskCliArgs(['config', 'set', 'DB_PASSWORD', 'hunter2'])).toEqual(['config', 'set', 'DB_PASSWORD', '•••']);
    expect(maskShell('mysql -u wp --password=hunter2 -e "select 1"')).toBe('mysql -u wp --password=••• -e "select 1"');
    expect(summarizeJob('site.shell', { command: 'export API_KEY=abc123 && ./sync.sh' })).toBe('export API_KEY=••• && ./sync.sh');
  });

  it('says how much a command was handed on stdin, never what, however long its command line', () => {
    const stdin = 'Add a hello-world shortcode: ça marche';
    expect(summarizeJob('wp.cli', { args: ['godmode', 'chat', 'send', '--new', '--message=-'], stdin })).toBe(
      'wp godmode chat send --new --message=- + stdin, 39 bytes',
    );
    expect(summarizeJob('wp.cli', { args: ['user', 'update', 'admin', '--prompt=user_pass'], stdin: 'x' })).toBe(
      'wp user update admin --prompt=user_pass + stdin, 1 byte',
    );
    const long = summarizeJob('wp.cli', { args: ['godmode', 'chat', 'send', `--label=${'x'.repeat(300)}`, '--message=-'], stdin })!;
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('… + stdin, 39 bytes')).toBe(true);
    expect(long).not.toContain('hello');
  });

  it('shows a REST request as its address, with credentials in the query string masked', () => {
    expect(summarizeJob('wp.rest', { method: 'GET', route: 'wp/v2/posts?per_page=5' })).toBe('GET /wp-json/wp/v2/posts?per_page=5');
    expect(
      summarizeJob('wp.rest', {
        method: 'POST',
        route: '/wp-json/shop/v1/sync',
        auth: { username: 'sync', applicationPassword: 'abcd efgh ijkl mnop qrst uvwx' },
      }),
    ).toBe('POST /wp-json/shop/v1/sync as sync');
    expect(maskRestRoute('shop/v1/hook?api_key=k123&token=t9&page=2')).toBe('/wp-json/shop/v1/hook?api_key=•••&token=•••&page=2');
  });

  it('keeps a summary to one line of at most 160 characters', () => {
    const summary = summarizeJob('site.shell', { command: `echo ${'x'.repeat(500)}\nrm -f later` })!;
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary).not.toContain('\n');
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('maskResult', () => {
  it('masks every value whose key names a credential, at any depth, and leaves the rest', () => {
    expect(
      maskResult({
        url: 'http://alpha.test',
        adminPassword: 'hunter2',
        ops: [{ slug: 'akismet', apiKey: 'k-123', ok: true }],
        nested: { secret: { deeper: 1 }, count: 3 },
      }),
    ).toEqual({
      url: 'http://alpha.test',
      adminPassword: '•••',
      ops: [{ slug: 'akismet', apiKey: '•••', ok: true }],
      nested: { secret: '•••', count: 3 },
    });
    expect(maskResult(null)).toBeNull();
    expect(maskResult([1, 'two'])).toEqual([1, 'two']);
  });
});
