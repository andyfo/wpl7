/**
 * Moving files out of a site and back (services/quarantine.ts). The throwaway container is
 * played by the local PHP running the real script over the fake world's files, so the rules
 * that matter are tested for real: no link is followed, a file that changed since the scan is
 * not moved, nothing is ever replaced on the way back.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { siteQuarantine, siteScanFindings, sites, type SiteRow } from '../../src/db/schema.js';
import { QUARANTINE_SCRIPT } from '../../src/services/quarantine.js';
import { sitePaths } from '../../src/services/siteSpec.js';
import { makeWorld, type TestWorld } from '../helpers.js';

const HAS_PHP = spawnSync('php', ['-v']).status === 0;
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

function addSite(w: TestWorld): SiteRow {
  const now = Date.now();
  const site = w.db
    .insert(sites)
    .values({
      slug: 'alpha',
      title: 'alpha',
      serverId: 1,
      domains: '["alpha.test"]',
      phpVersion: '8.3',
      status: 'running',
      dbName: 'alpha',
      dbUser: 'alpha',
      dbPassword: 'x',
      containerName: 'wp-alpha',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  fs.mkdirSync(sitePaths(w.config, 'alpha').wordpress, { recursive: true });
  return site;
}

/** The container, played by the real script with its two mounts pointed at the fake's folders. */
function playContainer(w: TestWorld) {
  const runs: string[][] = [];
  w.docker.ephemeral = (opts) => {
    const [site, store] = opts.binds!.map((b) => b.split(':')[0]!);
    const script = QUARANTINE_SCRIPT.replace("const SITE = '/var/www/html';", `const SITE = ${JSON.stringify(site)};`).replace(
      "const STORE = '/quarantine';",
      `const STORE = ${JSON.stringify(store)};`,
    );
    const args = opts.cmd.slice(opts.cmd.indexOf(QUARANTINE_SCRIPT) + 1);
    runs.push(args);
    const res = spawnSync('php', ['-r', script, ...args], { encoding: 'utf8' });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? -1 };
  };
  return runs;
}

function put(w: TestWorld, rel: string, text: string, mode = 0o644): string {
  const file = path.join(sitePaths(w.config, 'alpha').wordpress, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
  return file;
}

function finding(w: TestWorld, site: SiteRow, rel: string, hash: string): number {
  const now = Date.now();
  return w.db
    .insert(siteScanFindings)
    .values({
      siteId: site.id,
      fingerprint: `fp-${rel}`,
      engine: 'signatures',
      kind: 'signature',
      confidence: 'confirmed',
      severity: 'high',
      path: rel,
      sha256: hash,
      firstSeenAt: now,
      lastSeenAt: now,
      status: 'open',
    })
    .returning()
    .get().id;
}

describe('the quarantine container', () => {
  it("runs locked down, as the site's user, with only the site's files and its quarantine folder", async () => {
    const w = await makeWorld();
    const site = addSite(w);
    const calls: Parameters<NonNullable<typeof w.docker.ephemeral>>[0][] = [];
    w.docker.ephemeral = (opts) => {
      calls.push(opts);
      return { stdout: '{"mode":"644","size":4}\n', stderr: '', exitCode: 0 };
    };
    await w.core.quarantine.move(site, { path: 'wp-content/uploads/x.php', sha256: 'b'.repeat(64), findingIds: [], reason: 'Known malware' }, 'alice');
    const p = sitePaths(w.config, 'alpha');
    expect(calls[0]).toMatchObject({
      image: 'wpl7-wordpress:php8.3',
      user: '33:33',
      binds: [`${p.wordpress}:/var/www/html`, `${p.quarantine}:/quarantine`],
      lockdown: { nanoCpus: 1e9, tmpfs: { '/tmp': 8 } },
    });
    expect(fs.statSync(p.quarantine).mode & 0o777).toBe(0o700);
  });
});

describe.skipIf(!HAS_PHP)('moving a file out and back', () => {
  it('moves it out after checking it, and puts it back as it was', async () => {
    const w = await makeWorld();
    const site = addSite(w);
    playContainer(w);
    const file = put(w, 'wp-content/uploads/2026/x.php', '<?php evil();', 0o640);
    const id = finding(w, site, 'wp-content/uploads/2026/x.php', sha('<?php evil();'));

    const row = await w.core.quarantine.move(site, { path: 'wp-content/uploads/2026/x.php', sha256: sha('<?php evil();'), findingIds: [id], reason: 'Known malware' }, 'automatic');
    expect(fs.existsSync(file)).toBe(false);
    const kept = path.join(sitePaths(w.config, 'alpha').quarantine, row.storedName);
    expect(fs.readFileSync(kept, 'utf8')).toBe('<?php evil();');
    expect(row).toMatchObject({ mode: '640', sizeBytes: 13, movedBy: 'automatic', reason: 'Known malware' });
    expect(row.storedName).toMatch(/^\d+-[0-9a-f]{12}\.quarantined$/);
    expect(w.db.select().from(siteScanFindings).where(eq(siteScanFindings.id, id)).get()).toMatchObject({ status: 'quarantined', statusBy: 'automatic' });

    // Somebody decided it belongs there: back it goes, and its findings are theirs to have ignored.
    fs.rmSync(path.dirname(file), { recursive: true });
    const back = await w.core.quarantine.restore(site, row.id, 'alice');
    expect(fs.readFileSync(file, 'utf8')).toBe('<?php evil();');
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.existsSync(kept)).toBe(false);
    expect(back).toMatchObject({ restoredBy: 'alice' });
    expect(w.db.select().from(siteScanFindings).where(eq(siteScanFindings.id, id)).get()).toMatchObject({ status: 'ignored', statusBy: 'alice' });
    await expect(w.core.quarantine.restore(site, row.id, 'alice')).rejects.toThrow(/no longer in quarantine/);
  });

  it('refuses a file that changed since the scan, a link, and a path through a link', async () => {
    const w = await makeWorld();
    const site = addSite(w);
    playContainer(w);
    const file = put(w, 'wp-content/uploads/x.php', 'now different');
    const move = (rel: string, hash: string) =>
      w.core.quarantine.move(site, { path: rel, sha256: hash, findingIds: [], reason: 'Known malware' }, 'automatic');

    await expect(move('wp-content/uploads/x.php', sha('as the scan saw it'))).rejects.toThrow('The file is not the one the scan saw');
    expect(fs.existsSync(file)).toBe(true);

    const outside = put(w, 'elsewhere/secret.php', 'secret');
    fs.symlinkSync(outside, path.join(path.dirname(file), 'link.php'));
    await expect(move('wp-content/uploads/link.php', sha('secret'))).rejects.toThrow('The path leads through a link');
    fs.symlinkSync(path.dirname(outside), path.join(path.dirname(file), 'dir'));
    await expect(move('wp-content/uploads/dir/secret.php', sha('secret'))).rejects.toThrow('The path leads through a link');
    expect(fs.existsSync(outside)).toBe(true);
    await expect(move('wp-content/uploads/../../wp-config.php', sha('x'))).rejects.toThrow('The path leads through a link');
    expect(w.db.select().from(siteQuarantine).all()).toEqual([]);
  });

  it('never replaces a file that has appeared at the path since', async () => {
    const w = await makeWorld();
    const site = addSite(w);
    playContainer(w);
    const file = put(w, 'wp-content/uploads/x.php', 'old');
    const row = await w.core.quarantine.move(site, { path: 'wp-content/uploads/x.php', sha256: sha('old'), findingIds: [], reason: 'Code in uploads' }, 'alice');
    fs.writeFileSync(file, 'new');
    await expect(w.core.quarantine.restore(site, row.id, 'alice')).rejects.toThrow('Something is already at that path');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(sitePaths(w.config, 'alpha').quarantine, row.storedName))).toBe(true);
  });

  it('deletes a copy for good when asked, and after the keep period when there is one', async () => {
    const w = await makeWorld();
    const site = addSite(w);
    playContainer(w);
    put(w, 'wp-content/uploads/a.php', 'a');
    put(w, 'wp-content/uploads/b.php', 'b');
    const a = await w.core.quarantine.move(site, { path: 'wp-content/uploads/a.php', sha256: sha('a'), findingIds: [], reason: 'x' }, 'alice');
    const b = await w.core.quarantine.move(site, { path: 'wp-content/uploads/b.php', sha256: sha('b'), findingIds: [], reason: 'x' }, 'alice');
    const store = sitePaths(w.config, 'alpha').quarantine;

    expect(await w.core.quarantine.remove(site, a.id, 'alice')).toMatchObject({ deletedBy: 'alice' });
    expect(fs.existsSync(path.join(store, a.storedName))).toBe(false);

    expect(await w.core.quarantine.prune(0)).toBe(0);
    w.db.update(siteQuarantine).set({ movedAt: Date.now() - 31 * 86_400_000 }).where(eq(siteQuarantine.id, b.id)).run();
    expect(await w.core.quarantine.prune(60)).toBe(0);
    expect(await w.core.quarantine.prune(30)).toBe(1);
    expect(fs.existsSync(path.join(store, b.storedName))).toBe(false);
    expect(w.core.quarantine.get(site.id, b.id)).toMatchObject({ deletedBy: 'retention' });
  });
});
