/**
 * A catalog zip's malware check (services/pluginZipChecks.ts) in the fake world: the
 * container is answered by what the manifest script and the reducer would print, so what is
 * tested is everything around it - what the container gets, what is kept, what vouches for a
 * site's plugin and what is withheld until someone reviews it, the alert, and the schedule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, pluginZipChecks, plugins } from '../../src/db/schema.js';
import type { EphemeralOpts } from '../../src/services/docker.js';
import type { RunResult } from '../../src/lib/exec.js';
import { SCAN_PROFILE } from '../../src/services/scanEngines.js';
import { makeWorld, zipOf, type TestWorld } from '../helpers.js';

const log = { info: () => undefined, warn: () => undefined, checkCanceled: () => undefined };
const out = (...lines: object[]): RunResult => ({ stdout: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', stderr: '', exitCode: 0 });
const sha = (c: string) => c.repeat(64);

/** A zip in the catalog: one folder, a main file with its header, a library file. */
function addZip(w: TestWorld, name = 'Premium Pro', folder = 'premium-pro', entries?: Record<string, string>): { id: number; file: string } {
  const file = path.join(w.config.paths.plugins, `${folder}-${Math.random().toString(16).slice(2, 10)}.zip`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    zipOf(
      entries ?? {
        [`${folder}/`]: '',
        [`${folder}/${folder}.php`]: '<?php\n/*\nPlugin Name: Premium Pro\nVersion: 2.0\n*/\n',
        [`${folder}/lib/rsa.php`]: '<?php // .ssh/authorized_keys\n',
      },
    ),
  );
  // Named after the upload, as the catalog does: two zips of one folder are two entries.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const row = w.db.insert(plugins).values({ kind: 'zip', slug, name, zipPath: file, isDefault: 0, createdAt: Date.now() }).returning().get();
  return { id: row.id, file };
}

const signature = (p: string, rule = 'sign:e8cdb6a1') => ({ t: 'finding', path: `premium-pro/${p}`, rule, severity: 'danger', message: 'Malware Signature', line: 230 });
const candidate = (p: string) => ({ t: 'finding', path: `premium-pro/${p}`, rule: 'function:exec', severity: 'warn', message: 'Potentially dangerous function', line: 4 });

/** Answer the zip check's container with the manifest of that zip and `found` from the scanner. */
function zipContainer(w: TestWorld, found: () => object[] = () => []) {
  const runs: EphemeralOpts[] = [];
  w.docker.ephemeral = (opts: EphemeralOpts) => {
    runs.push(opts);
    if (opts.labels?.['wpl7.scan'] !== 'zip') throw new Error(`unexpected container ${JSON.stringify(opts.labels)}`);
    const findings = found();
    return out(
      { t: 'zipfile', path: 'premium-pro.php', sha256: sha('a') },
      { t: 'zipfile', path: 'lib/rsa.php', sha256: sha('b') },
      { t: 'zipsummary', folder: 'premium-pro', found: true, files: 2, bytes: 90, links: 0, other: 0, unreadable: 0, truncated: false, name: 'Premium Pro', version: '2.0', unzip: 0, said: '' },
      ...findings,
      { t: 'summary', engine: 'signatures', exit: findings.length ? 1 : 0, report: true, scanned: 2, complete: true, errors: 0, unreadable: 0, findings: findings.length, truncated: false },
    );
  };
  return runs;
}

const row = (w: TestWorld, id: number) => w.db.select().from(pluginZipChecks).where(eq(pluginZipChecks.pluginId, id)).get();

describe("a catalog zip's check", () => {
  it('unpacks only the zip, read-only, in a locked-down container, and keeps what it holds', async () => {
    const w = await makeWorld();
    const { id, file } = addZip(w);
    const runs = zipContainer(w);
    expect(await w.core.pluginZipChecks.run(log, id)).toEqual({ status: 'done', files: 2, confirmed: 0, flagged: 0 });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ user: '33:33', binds: [`${file}:/wpl7-zip/plugin.zip:ro`], labels: { 'wpl7.scan': 'zip' } });
    // Unpacked into a tmpfs sized to the zip; the memory ceiling grows by as much.
    expect(runs[0]!.lockdown!.tmpfs).toEqual({ '/tmp': 64, '/var/www/html': 32 });
    expect(runs[0]!.lockdown!.memoryBytes).toBe((512 + 32) * 1024 * 1024);
    expect(runs[0]!.cmd.slice(0, 2)).toEqual(['-c', expect.stringContaining('unzip -q -o /wpl7-zip/plugin.zip -d /var/www/html')]);

    expect(row(w, id)).toMatchObject({ status: 'done', folder: 'premium-pro', version: '2.0', files: 2, confirmed: 0, scanner: SCAN_PROFILE, problem: null });
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')).toEqual({
      name: 'Premium Pro',
      manifest: { hashType: 'sha256', files: { 'premium-pro.php': [sha('a')], 'lib/rsa.php': [sha('b')] } },
      withheld: 0,
      versions: ['2.0'],
      exact: true,
    });
    // A version the plugin updated itself to: the zip still vouches for the files it has unchanged.
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.1')).toMatchObject({ exact: false, versions: ['2.0'], manifest: { files: { 'lib/rsa.php': [sha('b')] } } });
    // Another folder: the zip says nothing about it.
    expect(w.core.pluginZipChecks.vouchFor('premium', '2.0')).toBeNull();
  });

  it('withholds the files it flagged until someone reviews exactly those, and alerts once per zip', async () => {
    const w = await makeWorld();
    const { id } = addZip(w);
    let found: object[] = [signature('lib/rsa.php'), candidate('premium-pro.php')];
    zipContainer(w, () => found);
    const notify = vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);

    expect(await w.core.pluginZipChecks.run(log, id)).toEqual({ status: 'done', files: 2, confirmed: 1, flagged: 2 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe('Plugin zip "Premium Pro": 1 match(es) of known malware');
    expect(notify.mock.calls[0]![1]).toContain('lib/rsa.php (line 230)');
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')).toMatchObject({ manifest: { files: {} }, withheld: 2 });
    expect(w.core.pluginZipChecks.details(id).check).toMatchObject({ status: 'done', flagged: 2, confirmed: 1, needsReview: true, reviewed: null });

    expect(w.core.pluginZipChecks.review(id, 'alice')).toMatchObject({ needsReview: false, reviewed: { by: 'alice' } });
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')).toMatchObject({ manifest: { files: { 'premium-pro.php': [sha('a')], 'lib/rsa.php': [sha('b')] } }, withheld: 0 });

    // The same findings again: the review holds, and nobody is mailed twice.
    await w.core.pluginZipChecks.run(log, id);
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')!.withheld).toBe(0);
    // Another finding - a newer AMWScan, say: the review was not of that, so it no longer holds.
    found = [signature('lib/rsa.php'), signature('lib/rsa.php', 'sign:11111111'), candidate('premium-pro.php')];
    await w.core.pluginZipChecks.run(log, id);
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')!.withheld).toBe(2);
    expect(w.core.pluginZipChecks.details(id).check).toMatchObject({ needsReview: true, reviewed: null });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("vouches across versions file by file: each hash any zip of the folder has, less what a check flagged and nobody reviewed", async () => {
    const w = await makeWorld();
    const older = addZip(w, 'Premium Pro 2.0');
    const newer = addZip(w, 'Premium Pro 2.1');
    // 2.0 and 2.1 share the library; the main file changed; 2.1 brings a file 2.0 did not have.
    const answer = (version: string, files: Record<string, string>, findings: object[] = []) => {
      w.docker.ephemeral = () =>
        out(
          ...Object.entries(files).map(([p, h]) => ({ t: 'zipfile', path: p, sha256: h })),
          { t: 'zipsummary', folder: 'premium-pro', found: true, files: Object.keys(files).length, unreadable: 0, truncated: false, name: 'Premium Pro', version, unzip: 0 },
          ...findings,
          { t: 'summary', engine: 'signatures', exit: findings.length ? 1 : 0, report: true, scanned: 2, complete: true, errors: 0, unreadable: 0, findings: findings.length, truncated: false },
        );
    };
    answer('2.0', { 'premium-pro.php': sha('a'), 'lib/rsa.php': sha('b') }, [signature('lib/rsa.php')]);
    vi.spyOn(w.core.mail, 'notifyOperator').mockResolvedValue(true);
    await w.core.pluginZipChecks.run(log, older.id);
    answer('2.1', { 'premium-pro.php': sha('c'), 'lib/rsa.php': sha('b'), 'lib/new.php': sha('d') });
    await w.core.pluginZipChecks.run(log, newer.id);

    // 2.1's check found nothing in the library 2.0's flagged: those bytes are vouched for by 2.1's.
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.2')).toMatchObject({
      name: 'Premium Pro 2.1',
      exact: false,
      versions: ['2.1', '2.0'],
      withheld: 0,
      manifest: { files: { 'premium-pro.php': [sha('c'), sha('a')], 'lib/rsa.php': [sha('b')], 'lib/new.php': [sha('d')] } },
    });
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')).toMatchObject({ name: 'Premium Pro 2.0', exact: true });

    // A file only the flagging zip has stays out until someone reviews it.
    answer('2.1', { 'premium-pro.php': sha('c'), 'lib/rsa.php': sha('e') });
    await w.core.pluginZipChecks.run(log, newer.id);
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.2')).toMatchObject({ withheld: 0, manifest: { files: { 'lib/rsa.php': [sha('e')] } } });
    expect(w.core.pluginZipChecks.unreviewedFlags().get('premium-pro')?.get('lib/rsa.php')).toEqual({ pluginId: older.id, name: 'Premium Pro 2.0', version: '2.0' });
    w.core.pluginZipChecks.review(older.id, 'alice');
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.2')!.manifest.files['lib/rsa.php']!.sort()).toEqual([sha('b'), sha('e')].sort());
    expect(w.core.pluginZipChecks.unreviewedFlags().get('premium-pro')).toBeUndefined();
  });

  it("holds back a file the scanner could only partly read, like one it flagged, until someone reviews it", async () => {
    const w = await makeWorld();
    const { id } = addZip(w);
    let partial = [{ path: 'premium-pro/lib/rsa.php', bytes: 1_400_000 }];
    let partialCount = 1;
    w.docker.ephemeral = () =>
      out(
        { t: 'zipfile', path: 'premium-pro.php', sha256: sha('a') },
        { t: 'zipfile', path: 'lib/rsa.php', sha256: sha('b') },
        { t: 'zipsummary', folder: 'premium-pro', found: true, files: 2, unreadable: 0, truncated: false, name: 'Premium Pro', version: '2.0', unzip: 0 },
        { t: 'summary', engine: 'signatures', exit: 0, report: true, scanned: 2, complete: true, errors: 0, unreadable: 0, findings: 0, truncated: false, partial, partialCount },
      );
    expect(await w.core.pluginZipChecks.run(log, id)).toEqual({ status: 'done', files: 2, confirmed: 0, flagged: 1 });
    // Its middle was never read: nothing vouches for it on a site until a person says so.
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')).toMatchObject({ withheld: 1, manifest: { files: { 'premium-pro.php': [sha('a')] } } });
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')!.manifest.files['lib/rsa.php']).toBeUndefined();
    expect(w.core.pluginZipChecks.details(id)).toMatchObject({
      check: { needsReview: true, flagged: 1, confirmed: 0 },
      findings: [{ path: 'lib/rsa.php', label: 'Partly scanned', rule: 'partial:too-large', detail: 'Too large to scan whole (1,400,000 bytes): only its start and end were checked.' }],
    });
    w.core.pluginZipChecks.review(id, 'alice');
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')!.manifest.files['lib/rsa.php']).toEqual([sha('b')]);

    // More of them than the scanner names: which ones is not known, so the zip vouches for nothing.
    partial = [];
    partialCount = 60;
    expect((await w.core.pluginZipChecks.run(log, id)).status).toBe('incomplete');
    expect(row(w, id)).toMatchObject({ status: 'incomplete', problem: '60 files were too large to scan whole, more than can be named.' });
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')).toBeNull();
  });

  it('vouches for nothing when it did not get through every file', async () => {
    const w = await makeWorld();
    const { id } = addZip(w);
    w.docker.ephemeral = () =>
      out(
        { t: 'zipfile', path: 'premium-pro.php', sha256: sha('a') },
        { t: 'zipsummary', folder: 'premium-pro', found: true, files: 1, unreadable: 0, truncated: false, name: 'Premium Pro', version: '2.0', unzip: 0 },
        { t: 'summary', engine: 'signatures', exit: 0, report: true, scanned: 1, complete: false, errors: 0, unreadable: 1, findings: 0, truncated: false },
      );
    expect((await w.core.pluginZipChecks.run(log, id)).status).toBe('incomplete');
    expect(row(w, id)).toMatchObject({ status: 'incomplete', problem: 'The signature scan could not read 1 file.' });
    expect(w.core.pluginZipChecks.vouchFor('premium-pro', '2.0')).toBeNull();
  });

  it('fails, and says why, for a zip WordPress would name after its file', async () => {
    const w = await makeWorld();
    const { id } = addZip(w, 'Loose', 'loose', { 'a.php': '<?php', 'b/c.php': '<?php' });
    zipContainer(w);
    await expect(w.core.pluginZipChecks.run(log, id)).rejects.toThrow(/no single top-level folder/);
    expect(row(w, id)).toMatchObject({ status: 'failed', problem: expect.stringContaining('no single top-level folder') });
    expect(w.core.pluginZipChecks.details(id).check).toMatchObject({ status: 'failed', needsReview: false });
  });

  it('queues the zips never checked or checked with another AMWScan, a few at a time, and none while scans are off', async () => {
    const w = await makeWorld();
    const ids = [1, 2, 3, 4].map((n) => addZip(w, `Zip ${n}`, `zip-${n}`).id);
    w.db.insert(plugins).values({ kind: 'wporg', slug: 'akismet', name: 'Akismet', isDefault: 0, createdAt: Date.now() }).run();

    expect(w.core.pluginZipChecks.sweep(w.worker)).toEqual(['Zip 1', 'Zip 2', 'Zip 3']);
    const queued = w.db.select().from(jobs).where(eq(jobs.type, 'plugin.zipCheck')).all();
    expect(queued.map((j) => [JSON.parse(j.payload).pluginId, j.lane])).toEqual([
      [ids[0], 'scan:1'],
      [ids[1], 'scan:1'],
      [ids[2], 'scan:1'],
    ]);
    // Asking again while one waits hands back that one.
    expect(w.core.pluginZipChecks.request(w.worker, ids[0]!)).toMatchObject({ queued: false, job: { id: queued[0]!.id } });
    expect(w.core.pluginZipChecks.sweep(w.worker)).toEqual(['Zip 4']);

    // Checked, then AMWScan changed: due again.
    w.db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.type, 'plugin.zipCheck')).run();
    w.db.update(pluginZipChecks).set({ status: 'done', scanner: SCAN_PROFILE, checkedAt: Date.now() }).run();
    w.db.update(pluginZipChecks).set({ scanner: '0.0.1' }).where(eq(pluginZipChecks.pluginId, ids[3]!)).run();
    expect(w.core.pluginZipChecks.sweep(w.worker)).toEqual(['Zip 4']);

    w.core.settings.set('scanEnabled', false);
    w.db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.type, 'plugin.zipCheck')).run();
    w.db.update(pluginZipChecks).set({ scanner: '0.0.1' }).run();
    expect(w.core.pluginZipChecks.sweep(w.worker)).toEqual([]);
    expect(() => w.core.pluginZipChecks.request(w.worker, 999)).toThrow(/not found/);
  });
});
