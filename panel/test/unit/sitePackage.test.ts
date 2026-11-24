import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { backups, jobs, sites } from '../../src/db/schema.js';
import { hostExec } from '../../src/lib/exec.js';
import { FORGET_MIGRATE_PLUGIN, WORDPRESS_HTACCESS } from '../../src/jobs/handlers/import.js';
import { holdQueuedPackages } from '../../src/jobs/handlers/sites.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeApp, makeWorld, waitFor, type TestWorld } from '../helpers.js';
import { logOf, wpCalls } from '../importWorld.js';
import { BINARY, OLD_ABS, OLD_HOME, OLD_HTACCESS, archiveTxt, dafBytes, legacySql, packageEntries, zipBytes } from '../duplicatorFixtures.js';

const UPLOAD = 'pkg-upload-0123456789';

/** A world whose image writes wp-config.php at a site's first start, and whose dumps are kept. */
async function world() {
  const w = await makeWorld({ exec: hostExec });
  w.docker.onStart = (name) => {
    if (!name.startsWith('wp-')) return;
    const p = sitePaths(w.config, name.slice(3));
    const config = path.join(p.wordpress, 'wp-config.php');
    if (fs.existsSync(p.wordpress) && !fs.existsSync(config)) fs.writeFileSync(config, '<?php // written by the image');
  };
  const dumps: Buffer[] = [];
  /** How many Docker calls had been made at each import: what came before it. */
  const importedAt: number[] = [];
  const importFromAs = w.dbAdmin.importFromAs.bind(w.dbAdmin);
  w.dbAdmin.importFromAs = async (src, db, user, password) => {
    dumps.push(zlib.gunzipSync(fs.readFileSync(src)));
    importedAt.push(w.docker.calls.length);
    return importFromAs(src, db, user, password);
  };
  return { w, dumps, importedAt };
}

async function signedIn(w: TestWorld) {
  const { app } = await makeApp(w);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  const c = login.cookies.find((x) => x.name === 'panel.sid')!;
  return { app, headers: { cookie: `${c.name}=${c.value}`, 'x-csrf': '1' } };
}

/** Put a package where an upload lands. */
function uploaded(w: TestWorld, bytes: Buffer, id = UPLOAD): string {
  fs.mkdirSync(w.core.packages.dir(), { recursive: true });
  fs.writeFileSync(w.core.packages.path(id), bytes);
  return id;
}

async function runCreate(w: TestWorld, jobId: number) {
  w.worker.start();
  try {
    await waitFor(() => ['succeeded', 'failed', 'canceled'].includes(w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status), 60_000);
  } finally {
    await w.worker.stop();
  }
  return w.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

describe('a new site from a Duplicator package', () => {
  it('takes a .zip in chunks, says what is in it, and makes the site from it as an import does', async () => {
    const { w, dumps } = await world();
    const { app, headers } = await signedIn(w);
    // WordPress tells its language, as the old site set it in whichever way.
    const exec = w.docker.exec.bind(w.docker);
    w.docker.exec = async (name, cmd, opts) => (cmd.includes('echo get_locale();') ? (await exec(name, cmd, opts), { stdout: 'de_DE\n', stderr: '', exitCode: 0 }) : exec(name, cmd, opts));
    const bytes = zipBytes(packageEntries({ layout: 'new', extra: [{ name: 'wp-config-docker.php', data: "<?php define('DB_HOST', 'old-db');" }] }));
    const half = Math.floor(bytes.length / 2);
    for (const [offset, chunk] of [[0, bytes.subarray(0, half)], [half, bytes.subarray(half)]] as const) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/package-uploads/${UPLOAD}?offset=${offset}&size=${bytes.length}`,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: chunk,
      });
      expect(put.statusCode, put.body).toBe(200);
    }
    const read = await app.inject({ method: 'GET', url: `/api/package-uploads/${UPLOAD}`, headers });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ format: 'zip', duplicator: '5.2.0', blockedReason: null, report: { home: OLD_HOME, tablePrefix: 'wpd_' } });

    const create = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers,
      payload: {
        title: 'Shop',
        slug: 'shop',
        domainMode: 'dev',
        package: {
          uploadId: UPLOAD,
          carryConstants: ['WP_MEMORY_LIMIT'],
          deactivatePlugins: ['litespeed-cache'],
          removeDropins: ['object-cache.php'],
          removeMuPlugins: ['kinsta-mu-plugins.php'],
        },
      },
    });
    expect(create.statusCode, create.body).toBe(202);
    const job = await runCreate(w, create.json().job.id);
    expect(job.status, logOf(w, job.id).join('\n')).toBe('succeeded');

    const site = w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()!;
    // PHP 8.2, the old site's; its tables keep their prefix.
    expect(site).toMatchObject({ status: 'running', tablePrefix: 'wpd_', phpVersion: '8.2', wpAdminEmail: null, locale: 'de_DE' });
    const p = sitePaths(w.config, 'shop');
    const has = (rel: string) => fs.existsSync(path.join(p.wordpress, rel));
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-content/uploads/2024/photo.jpg')).equals(Buffer.alloc(5000, 7))).toBe(true);
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-content/uploads/odd name & ü.txt'), 'utf8')).toBe('odd');
    // Nothing of Duplicator's installer, nor what was left behind; wp-config.php is the image's.
    expect(has('dup-installer')).toBe(false);
    expect(has('shop_abc_20261120_installer-backup.php')).toBe(false);
    expect(has('wp-content/object-cache.php')).toBe(false);
    expect(has('wp-content/mu-plugins/kinsta-mu-plugins.php')).toBe(false);
    expect(fs.readFileSync(path.join(p.wordpress, 'wp-config.php'), 'utf8')).toBe('<?php // written by the image');
    // The old wp-config-docker.php would have been the image's template for it.
    expect(has('wp-config-docker.php')).toBe(false);
    // The old site's .htaccess and .user.ini, back in place.
    expect(fs.readFileSync(path.join(p.wordpress, '.htaccess'), 'utf8')).toContain('# BEGIN WordPress');
    expect(fs.readFileSync(path.join(p.wordpress, '.user.ini'), 'utf8')).toContain('memory_limit = 512M');

    // The database: the files in archive.txt's order, made fit, loaded as the site's own user.
    expect(w.dbAdmin.calls.find((c) => c.method === 'importFromAs')!.args.slice(1)).toEqual([site.dbName, site.dbUser, site.dbPassword]);
    expect(w.dbAdmin.calls.some((c) => c.method === 'importFrom')).toBe(false);
    const dump = dumps[0]!;
    const text = dump.toString('latin1');
    expect(text.startsWith('SET NAMES utf8mb4;\n')).toBe(true);
    // Every row loads or the load fails: no INSERT IGNORE.
    expect(text).not.toContain('INSERT IGNORE');
    expect(text.indexOf('CREATE TABLE IF NOT EXISTS `wpd_options`')).toBeLessThan(text.indexOf('INSERT INTO `wpd_options`'));
    expect(text.indexOf('INSERT INTO `wpd_options`')).toBeLessThan(text.indexOf('INSERT INTO `wpd_posts`'));
    expect(text).not.toContain('DEFINER=`olduser`');
    expect(text.replace('utf8mb4_0900_ai_ci stays', '')).not.toContain('0900');
    expect(text).toContain('"USE other; DEFINER=`x`@`y` utf8mb4_0900_ai_ci stays"');
    expect(dump.includes(Buffer.concat([Buffer.from('raw bytes:'), BINARY]))).toBe(true);

    // WordPress, set up for its new address; the migration plugin's settings go, as after an import.
    const wp = wpCalls(w, site.containerName);
    expect(wp).toContain('wp config set WP_MEMORY_LIMIT 256M --type=constant');
    expect(wp).toContain(
      `wp search-replace ${OLD_HOME} http://shop.dev.example.test --all-tables --skip-columns=guid --report-changed-only --skip-plugins --skip-themes`,
    );
    expect(wp).toContain(`wp search-replace ${OLD_ABS} /var/www/html --all-tables --skip-columns=guid --report-changed-only --skip-plugins --skip-themes`);
    expect(wp).toContain('wp option update blog_public 0 --skip-plugins --skip-themes');
    expect(wp.some((c) => c.startsWith('wp plugin deactivate litespeed-cache'))).toBe(true);
    expect(wp).toContain(`wp eval ${FORGET_MIGRATE_PLUGIN} --skip-plugins --skip-themes`);
    expect(wp).not.toContain('wp option update blog_public 1 --skip-plugins --skip-themes');

    // Published, backed up, scanned; the staging folder and the upload gone.
    const lastSpec = w.docker.calls.filter((c) => c.method === 'createSiteContainer').at(-1)!.args[0] as { labels: Record<string, string>; env: Record<string, string> };
    expect(lastSpec.labels['wpl7.routing']).toBe('public');
    expect(lastSpec.env.WORDPRESS_TABLE_PREFIX).toBe('wpd_');
    expect(w.db.select().from(backups).where(eq(backups.siteSlug, 'shop')).all().map((b) => b.type)).toEqual(['import']);
    expect(w.db.select().from(jobs).where(eq(jobs.type, 'site.malwareScan')).get()).toBeTruthy();
    expect(fs.existsSync(path.join(w.config.srvRoot, 'wpl7-import', `package-${site.id}`))).toBe(false);
    expect(fs.existsSync(w.core.packages.path(UPLOAD))).toBe(false);
    expect(job.result).toContain('http://shop.dev.example.test');
  });

  it('makes a site from a Duplicator 1.x .daf, its one dump and its .htaccess', async () => {
    const { w, dumps, importedAt } = await world();
    const archive = archiveTxt({
      layout: 'legacy',
      prefix: 'wp_',
      charset: 'cp1250',
      triggers: ['wp_log_insert', { name: 'wp_sync', body: 'INSERT INTO shopdb.audit VALUES (NEW.ID)' }],
      defines: { WP_LANG_DIR: `${OLD_ABS}/wp-content/languages` },
    });
    // A file Duplicator noted another CRC-32 for than its content has: it changed while the package was made.
    const entries = packageEntries({ layout: 'legacy', archive }).map((e) => (e.name === 'wp-config-sample.php' ? { ...e, fileHash: 'deadbeef' } : e));
    uploaded(w, dafBytes(entries, { version: '1.0.0' }));
    const body = {
      title: 'Old shop',
      slug: 'oldshop',
      domainMode: 'dev' as const,
      app: 'wordpress' as const,
      discourageSearchEngines: false,
      package: { uploadId: UPLOAD, carryConstants: ['WP_LANG_DIR'], deactivatePlugins: [], removeDropins: [], removeMuPlugins: [], rewritePaths: false },
    };
    const prepared = await w.deps.sites.assertCanCreate(body);
    const { job } = w.deps.sites.create(body, prepared);
    const done = await runCreate(w, job.id);
    expect(done.status, logOf(w, job.id).join('\n')).toBe('succeeded');
    const site = w.db.select().from(sites).where(eq(sites.slug, 'oldshop')).get()!;
    expect(site.tablePrefix).toBe('wp_');
    const p = sitePaths(w.config, 'oldshop');
    expect(fs.readFileSync(path.join(p.wordpress, '.htaccess'), 'utf8')).toBe(OLD_HTACCESS);
    expect(fs.existsSync(path.join(p.wordpress, '.user.ini'))).toBe(false);
    expect(dumps[0]!.toString('latin1')).toContain(legacySql('wp_').toString('latin1').split('\n').find((l) => l.startsWith('INSERT INTO `wp_options` VALUES("2"'))!);
    // Loaded in the set WordPress wrote it in.
    expect(dumps[0]!.toString('latin1').startsWith('SET NAMES cp1250;\n')).toBe(true);
    const log = logOf(w, job.id).join('\n');
    // The trigger Duplicator keeps out of the dump, added last as the site's own user; the one that reaches another database left out.
    expect(dumps).toHaveLength(2);
    expect(dumps[1]!.toString('utf8')).toContain('CREATE TRIGGER `wp_log_insert` AFTER INSERT ON `wp_posts` FOR EACH ROW SET @n = 1;;');
    expect(dumps[1]!.toString('utf8')).not.toContain('olduser');
    // In WordPress's SQL mode, not the dump's, with a short wait for the table's lock.
    expect(dumps[1]!.toString('utf8')).toContain("SET @wpl7_mode = REPLACE(@wpl7_mode, ',STRICT_TRANS_TABLES,', ',');");
    expect(dumps[1]!.toString('utf8')).toContain('SET SESSION lock_wait_timeout = 30;');
    expect(dumps[1]!.toString('utf8')).not.toContain('NO_AUTO_VALUE_ON_ZERO');
    expect(w.dbAdmin.calls.filter((c) => c.method === 'importFromAs').at(-1)!.args.slice(1)).toEqual([site.dbName, site.dbUser, site.dbPassword]);
    const lastFix = w.docker.calls.findLastIndex((c) => c.method === 'exec' && (c.args[1] as string[]).join(' ').startsWith('wp option update blog_public'));
    expect(lastFix).toBeGreaterThan(-1);
    expect(importedAt[1]).toBeGreaterThan(lastFix);
    expect(log).toMatch(/Left out the trigger wp_sync, which names the database shopdb\. The package's archive\.txt has its definition\./);
    expect(log).toMatch(/Added 1 trigger \(wp_log_insert\), owned by the site's database user and run in WordPress's SQL mode\./);
    expect(log).toMatch(/1 file in the package differs from what Duplicator noted for it, likely changed while the package was made: wp-config-sample\.php/);
    const wp = wpCalls(w, site.containerName);
    // The language folder of the old site's, carried as the same folder here.
    expect(wp).toContain('wp config set WP_LANG_DIR /var/www/html/wp-content/languages --type=constant');
    // Paths left as they were, as asked.
    expect(wp.some((c) => c.startsWith(`wp search-replace ${OLD_ABS}`))).toBe(false);
    // Search engines as the form said, whatever the old site had.
    expect(wp).toContain('wp option update blog_public 1 --skip-plugins --skip-themes');
    expect(wp).not.toContain('wp option update blog_public 0 --skip-plugins --skip-themes');
  });

  it("reads a dump Duplicator 1.x's mysqldump wrote in the old host's own set, as its bytes say", async () => {
    for (const [cafe, set] of [
      [Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'latin1'],
      [Buffer.from('café', 'utf8'), 'utf8mb4'],
    ] as const) {
      const { w, dumps } = await world();
      const dump = Buffer.concat([legacySql('wp_'), Buffer.from('INSERT INTO `wp_options` VALUES("3", "blogname", "'), cafe, Buffer.from('");\n')]);
      const archive = archiveTxt({ layout: 'legacy', prefix: 'wp_', buildMode: 'MYSQLDUMP', charset: 'utf8' });
      uploaded(w, zipBytes(packageEntries({ layout: 'legacy', archive }).map((e) => (e.name.startsWith('dup-installer/dup-database__') ? { ...e, data: dump } : e))));
      const body = { title: 'Shop', slug: 'shop', domainMode: 'dev' as const, app: 'wordpress' as const, package: { uploadId: UPLOAD, carryConstants: [], deactivatePlugins: [], removeDropins: [], removeMuPlugins: [], rewritePaths: true } };
      const { job } = w.deps.sites.create(body, await w.deps.sites.assertCanCreate(body));
      const done = await runCreate(w, job.id);
      expect(done.status, logOf(w, job.id).join('\n')).toBe('succeeded');
      expect(dumps[0]!.toString('latin1').startsWith(`SET NAMES ${set};\n`)).toBe(true);
      // Byte for byte, whichever set it is read in.
      expect(dumps[0]!.includes(Buffer.concat([Buffer.from('"blogname", "'), cafe]))).toBe(true);
      expect(logOf(w, job.id).join('\n').includes('The database dump is not UTF-8')).toBe(set === 'latin1');
    }
  });

  it('fails, rather than drops a row, when two rows of the old database count as the same here', async () => {
    const { w } = await world();
    uploaded(w, zipBytes(packageEntries({ layout: 'new' })));
    w.dbAdmin.failOn.set('importFromAs', "Database import failed (exit 1): ERROR 1062 (23000) at line 9: Duplicate entry '…' for key 'option_name'");
    const body = { title: 'Shop', slug: 'shop', domainMode: 'dev' as const, app: 'wordpress' as const, package: { uploadId: UPLOAD, carryConstants: [], deactivatePlugins: [], removeDropins: [], removeMuPlugins: [], rewritePaths: true } };
    const { job } = w.deps.sites.create(body, await w.deps.sites.assertCanCreate(body));
    const done = await runCreate(w, job.id);
    expect(done.status).toBe('failed');
    expect(logOf(w, job.id).join('\n')).toMatch(
      /Duplicate entry '…' for key 'option_name'\. Two rows of the old database count as the same here, as MariaDB tells apart fewer characters than MySQL 8\. Change one of them on the old site, then build the package again\./,
    );
  });

  it('turns a create away when its package went, or changed, while it was being read', async () => {
    const { w } = await world();
    uploaded(w, zipBytes(packageEntries({ layout: 'legacy' })));
    const body = { title: 'Shop', slug: 'shop', domainMode: 'dev' as const, app: 'wordpress' as const, package: { uploadId: UPLOAD, carryConstants: [], deactivatePlugins: [], removeDropins: [], removeMuPlugins: [], rewritePaths: true } };
    const prepared = await w.deps.sites.assertCanCreate(body);
    fs.rmSync(w.core.packages.path(UPLOAD));
    expect(() => w.deps.sites.create(body, prepared)).toThrow(/No such upload/);
    // Another package under the same id: not the one that was checked.
    uploaded(w, zipBytes(packageEntries({ layout: 'new' })));
    expect(() => w.deps.sites.create(body, prepared)).toThrow(/changed while it was being read/);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()).toBeUndefined();
    // Read again, it goes.
    expect(w.deps.sites.create(body, await w.deps.sites.assertCanCreate(body)).job.status).toBe('queued');
  });

  it('adds the triggers the site has every name of, in its own character set, and leaves out the rest', async () => {
    const { w, dumps } = await world();
    const cursor =
      'BEGIN DECLARE done INT DEFAULT 0; DECLARE v BIGINT; DECLARE c CURSOR FOR SELECT ID FROM wp_posts; ' +
      'DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1; OPEN c; FETCH NEXT FROM c INTO v; CLOSE c; END';
    const archive = archiveTxt({
      layout: 'legacy',
      prefix: 'wp_',
      triggers: [
        { name: 'wp_count', body: 'SET @n = (SELECT COUNT(*) FROM (SELECT 1 AS x) d, wp_missing)' },
        { name: 'wp_cursor', body: cursor },
      ],
    });
    // A table of a UTF-8 name, and a trigger on it, as Duplicator 5.x lists it.
    const cafe = 'DELIMITER ;;\nCREATE TRIGGER `wp_cafe_log` AFTER INSERT ON `wp_café` FOR EACH ROW SET @n = NEW.prix;;\nDELIMITER ;';
    const withCafe = JSON.parse(archive) as { dbInfo: { triggerList: Record<string, unknown> } };
    withCafe.dbInfo.triggerList['wp_cafe_log'] = { event: 'INSERT', table: 'wp_café', timing: 'AFTER', create: cafe };
    const dump = Buffer.concat([legacySql('wp_'), Buffer.from('CREATE TABLE `wp_café` (`prix` int);\n', 'utf8')]);
    uploaded(
      w,
      zipBytes(
        packageEntries({ layout: 'legacy', archive: JSON.stringify(withCafe) }).map((e) => (e.name.startsWith('dup-installer/dup-database__') ? { ...e, data: dump } : e)),
      ),
    );
    const body = { title: 'Shop', slug: 'shop', domainMode: 'dev' as const, app: 'wordpress' as const, package: { uploadId: UPLOAD, carryConstants: [], deactivatePlugins: [], removeDropins: [], removeMuPlugins: [], rewritePaths: true } };
    const { job } = w.deps.sites.create(body, await w.deps.sites.assertCanCreate(body));
    const done = await runCreate(w, job.id);
    const log = logOf(w, job.id).join('\n');
    expect(done.status, log).toBe('succeeded');
    expect(log).toMatch(/Left out the trigger wp_count, which names wp_missing, which the site's database does not have\./);
    expect(log).toMatch(/Added 2 triggers \(wp_cursor, wp_cafe_log\)/);
    expect(dumps.slice(1).map((d) => /CREATE TRIGGER `(\w+)`/.exec(d.toString('utf8'))?.[1])).toEqual(['wp_cursor', 'wp_cafe_log']);
  });

  it('stops between triggers when the create is stopped', async () => {
    const { w } = await world();
    const archive = archiveTxt({ layout: 'legacy', prefix: 'wp_', triggers: ['wp_one', 'wp_two', 'wp_three'] });
    uploaded(w, zipBytes(packageEntries({ layout: 'legacy', archive })));
    const body = { title: 'Shop', slug: 'shop', domainMode: 'dev' as const, app: 'wordpress' as const, package: { uploadId: UPLOAD, carryConstants: [], deactivatePlugins: [], removeDropins: [], removeMuPlugins: [], rewritePaths: true } };
    const { job } = w.deps.sites.create(body, await w.deps.sites.assertCanCreate(body));
    const triggersAdded: string[] = [];
    const importFromAs = w.dbAdmin.importFromAs.bind(w.dbAdmin);
    w.dbAdmin.importFromAs = async (src: string, db: string, user: string, password: string) => {
      if (src.includes(`${path.sep}triggers${path.sep}`)) {
        triggersAdded.push(src);
        // Stop is pressed while the first one goes in.
        if (triggersAdded.length === 1) expect(w.worker.cancel(job.id)).toBe('requested');
      }
      return importFromAs(src, db, user, password);
    };
    const done = await runCreate(w, job.id);
    expect(done.status).toBe('canceled');
    expect(triggersAdded).toHaveLength(1);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()).toBeUndefined();
  });

  it("writes WordPress's own .htaccess when the package's cannot be read", async () => {
    const { w } = await world();
    const entries = packageEntries({ layout: 'legacy' }).map((e) => (e.name.endsWith('/source_site_htaccess') ? { ...e, badCrc: true } : e));
    uploaded(w, zipBytes(entries));
    const body = { title: 'Shop', slug: 'shop', domainMode: 'dev' as const, app: 'wordpress' as const, package: { uploadId: UPLOAD, carryConstants: [], deactivatePlugins: [], removeDropins: [], removeMuPlugins: [], rewritePaths: true } };
    const { job } = w.deps.sites.create(body, await w.deps.sites.assertCanCreate(body));
    const done = await runCreate(w, job.id);
    expect(done.status, logOf(w, job.id).join('\n')).toBe('succeeded');
    const htaccess = fs.readFileSync(path.join(sitePaths(w.config, 'shop').wordpress, '.htaccess'), 'utf8');
    expect(htaccess).toBe(WORDPRESS_HTACCESS);
    expect(logOf(w, job.id).join('\n')).toMatch(/Could not read the package's \.htaccess, so WordPress's standard one is written/);
  });

  it('rolls back a package whose dump would load elsewhere, and keeps the upload for another try', async () => {
    const { w } = await world();
    const entries = packageEntries({ layout: 'legacy' }).map((e) =>
      e.name.startsWith('dup-installer/dup-database__') ? { ...e, data: Buffer.concat([Buffer.from('USE `elsewhere`;\n'), legacySql('wp_')]) } : e,
    );
    uploaded(w, zipBytes(entries));
    const { app, headers } = await signedIn(w);
    const create = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: { title: 'Shop', slug: 'shop', domainMode: 'dev', package: { uploadId: UPLOAD } } });
    expect(create.statusCode, create.body).toBe(202);
    const job = await runCreate(w, create.json().job.id);
    expect(job.status).toBe('failed');
    expect(logOf(w, job.id).join('\n')).toMatch(/switches to another database/);
    expect(w.db.select().from(sites).where(eq(sites.slug, 'shop')).get()).toBeUndefined();
    expect(fs.existsSync(w.core.packages.path(UPLOAD))).toBe(true);
    // No longer held: it can be thrown away.
    expect((await app.inject({ method: 'DELETE', url: `/api/package-uploads/${UPLOAD}`, headers })).statusCode).toBe(204);
  });

  it('refuses what does not fit: the form\'s own fields, a package that cannot make a site, choices it does not have, an upload in use', async () => {
    const { w } = await world();
    const { app, headers } = await signedIn(w);
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/sites', headers, payload: { title: 'Shop', domainMode: 'dev', ...payload } });

    uploaded(w, zipBytes(packageEntries({ layout: 'new' })));
    const withAdmin = await post({ adminUser: 'boss', package: { uploadId: UPLOAD } });
    expect(withAdmin.statusCode).toBe(400);
    expect(withAdmin.body).toContain('adminUser comes from the package');
    // Another app is told the package is not for it, then what its own create refuses.
    const php = await post({ app: 'php', adminUser: 'boss', package: { uploadId: UPLOAD } });
    expect(php.statusCode).toBe(400);
    expect(php.body).toContain('package is for WordPress sites only');
    expect(php.body).toContain('adminUser is for WordPress sites only');
    expect(php.body).not.toContain('comes from the package');
    const unknown = await post({ package: { uploadId: UPLOAD, deactivatePlugins: ['not-there'] } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toContain('no plugin not-there');

    const first = await post({ slug: 'one', package: { uploadId: UPLOAD } });
    expect(first.statusCode, first.body).toBe(202);
    const second = await post({ slug: 'two', package: { uploadId: UPLOAD } });
    expect(second.statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/package-uploads/${UPLOAD}`, headers })).statusCode).toBe(409);

    uploaded(w, zipBytes(packageEntries({ layout: 'legacy', archive: archiveTxt({ layout: 'legacy', prefix: 'wp_', multisite: true }) })), 'pkg-upload-multisite01');
    const blocked = await post({ slug: 'three', package: { uploadId: 'pkg-upload-multisite01' } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toContain('multisite');

    uploaded(w, Buffer.from('<?php // installer.php, uploaded by mistake'), 'pkg-upload-installer01');
    const wrong = await app.inject({ method: 'GET', url: '/api/package-uploads/pkg-upload-installer01', headers });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('not a Duplicator archive');
  });

  it('takes one chunk of an upload at a time, and no create or delete while one is written', async () => {
    const { w } = await world();
    const { app, headers } = await signedIn(w);
    const bytes = zipBytes(packageEntries({ layout: 'new' }));
    const put = (offset: number, chunk: Buffer) =>
      app.inject({ method: 'PUT', url: `/api/package-uploads/${UPLOAD}?offset=${offset}&size=${bytes.length}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: chunk });
    expect((await put(0, bytes.subarray(0, 100))).statusCode).toBe(200);
    // As while a chunk is still on its way.
    w.core.packages.beginWrite(UPLOAD);
    const second = await put(100, bytes.subarray(100));
    expect(second.statusCode).toBe(429);
    expect((await app.inject({ method: 'DELETE', url: `/api/package-uploads/${UPLOAD}`, headers })).statusCode).toBe(409);
    expect(() => w.core.packages.claim(UPLOAD)).toThrow(/still going up/);
    w.core.packages.endWrite(UPLOAD);
    expect((await put(100, bytes.subarray(100))).statusCode).toBe(200);
  });

  it("counts what the uploads under way still have to send, and keeps the panel's disk from filling", async () => {
    const { w } = await world();
    const { app, headers } = await signedIn(w);
    const GIB = 1024 ** 3;
    const put = (id: string, offset: number, size: number) =>
      app.inject({ method: 'PUT', url: `/api/package-uploads/${id}?offset=${offset}&size=${size}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(1024, 7) });
    let free = 3 * GIB;
    const statfs = vi.spyOn(fsp, 'statfs').mockImplementation(async () => ({ bavail: free / 4096, bsize: 4096 }) as Awaited<ReturnType<typeof fsp.statfs>>);
    try {
      // 1.5 GiB to come, with the 1 GiB that stays free: it fits in 3.
      expect((await put('pkg-upload-first-0001', 0, 1.5 * GIB)).statusCode).toBe(200);
      // A second of 1 GiB would fit alone, not beside what the first still has to send.
      const second = await put('pkg-upload-second-001', 0, GIB);
      expect(second.statusCode).toBe(507);
      // Once the first is thrown away, its room is free again.
      expect((await app.inject({ method: 'DELETE', url: '/api/package-uploads/pkg-upload-first-0001', headers })).statusCode).toBe(204);
      expect((await put('pkg-upload-second-001', 0, GIB)).statusCode).toBe(200);
      // Something else filled the disk: no chunk may leave less than the 1 GiB.
      free = GIB + 512;
      const late = await put('pkg-upload-second-001', 1024, GIB);
      expect(late.statusCode).toBe(507);
    } finally {
      statfs.mockRestore();
      // Its room is counted for an hour otherwise, by every test after this one.
      await app.inject({ method: 'DELETE', url: '/api/package-uploads/pkg-upload-second-001', headers });
    }
  });

  it('lets only one of two uploads that start together take room meant for one', async () => {
    const { w } = await world();
    const { app, headers } = await signedIn(w);
    const GIB = 1024 ** 3;
    const statfs = vi.spyOn(fsp, 'statfs').mockImplementation(async () => ({ bavail: (3 * GIB) / 4096, bsize: 4096 }) as Awaited<ReturnType<typeof fsp.statfs>>);
    const put = (id: string) =>
      app.inject({ method: 'PUT', url: `/api/package-uploads/${id}?offset=0&size=${1.5 * GIB}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(1024, 7) });
    try {
      const both = await Promise.all([put('pkg-upload-together-a1'), put('pkg-upload-together-b1')]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 507]);
    } finally {
      statfs.mockRestore();
      for (const id of ['pkg-upload-together-a1', 'pkg-upload-together-b1']) await app.inject({ method: 'DELETE', url: `/api/package-uploads/${id}`, headers });
    }
  });

  it('never deletes a stale upload a create took while it was being looked at', async () => {
    const { w } = await world();
    const id = uploaded(w, Buffer.from('PK'));
    const stat = fsp.stat.bind(fsp);
    const spy = vi.spyOn(fsp, 'stat').mockImplementation(async (...args: Parameters<typeof fsp.stat>) => {
      // The create's claim lands while housekeeping waits for the file's age.
      if (String(args[0]).endsWith(`${id}.pkg`)) w.core.packages.claim(id);
      return stat(...args);
    });
    try {
      expect(await w.core.packages.removeStale(Date.now() + 25 * 3600_000)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(w.core.packages.path(id))).toBe(true);
  });

  it('holds the package of a create still queued when the panel restarts', async () => {
    const { w } = await world();
    const { app, headers } = await signedIn(w);
    uploaded(w, zipBytes(packageEntries({ layout: 'new' })));
    const create = await app.inject({ method: 'POST', url: '/api/sites', headers, payload: { title: 'Shop', slug: 'shop', domainMode: 'dev', package: { uploadId: UPLOAD } } });
    expect(create.statusCode, create.body).toBe(202);
    // A restart forgets the create's hold; the boot takes it again before the API answers.
    w.core.packages.release(UPLOAD);
    expect(holdQueuedPackages(w.core)).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/package-uploads/${UPLOAD}`, headers })).statusCode).toBe(409);
  });

  it('clears away uploads nobody made a site from within a day', async () => {
    const { w } = await world();
    const id = uploaded(w, Buffer.from('PK'));
    expect(await w.core.packages.removeStale(Date.now())).toBe(0);
    expect(await w.core.packages.removeStale(Date.now() + 25 * 3600_000)).toBe(1);
    expect(fs.existsSync(w.core.packages.path(id))).toBe(false);
  });
});
