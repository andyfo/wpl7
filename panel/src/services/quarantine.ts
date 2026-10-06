/**
 * Files moved out of a site by its malware scan or by an administrator (docs/security.md).
 *
 * They go to `<SRV_ROOT>/sites/<slug>/quarantine/`, beside the site's folder and mounted into
 * no site - nothing can serve or run them there - under a name that is not theirs. Nothing is
 * deleted unless someone deletes it, or `scan.quarantineKeepDays` says so.
 *
 * The move itself runs where every other change to a site's files runs: not as root on the
 * host (the symlink rule, docs/architecture.md), but in a throwaway container as the site's
 * own user, with only the site's files and its quarantine folder mounted. It refuses a path
 * that leads through a link, checks the file is byte for byte the one the scan saw, copies it,
 * checks the copy, and only then removes the original. A restore is the same in reverse, and
 * never replaces a file that has appeared at that path since.
 */
// @docs security/malware-scans
import crypto from 'node:crypto';
import path from 'node:path';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { siteQuarantine, siteScanFindings, sites, type SiteQuarantineRow, type SiteRow } from '../db/schema.js';
import type { Config } from '../config.js';
import type { JobWorker } from '../jobs/worker.js';
import type { ServerRegistry } from '../servers/registry.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { siteImage, sitePaths } from './siteSpec.js';
import type { Logger } from './index.js';

const QUARANTINE_EXIT: Record<number, string> = {
  10: 'The file is not there any more.',
  11: 'The path leads through a link, or is not a plain file; it is left where it is.',
  12: 'The site\'s user may not change it.',
  13: 'Something is already at that path; nothing was replaced.',
  14: 'The file is not the one the scan saw - it changed since. Scan again first.',
  15: 'Copying it failed; nothing was moved.',
};

/** PHP for `php -r`, as uid 33: `move|restore <path> <stored name> <sha256> [mode]`. */
export const QUARANTINE_SCRIPT = String.raw`
error_reporting(E_ALL);
ini_set('display_errors', 'stderr');
const SITE = '/var/www/html';
const STORE = '/quarantine';
const S_IFMT = 0170000;
const S_IFDIR = 0040000;
const S_IFREG = 0100000;
function fail(int $code, string $why): never { fwrite(STDERR, $why . "\n"); exit($code); }

/** The path in the site: every step a real folder, none of them a link. */
function walk(string $rel, bool $existing): string {
    if ($rel === '' || $rel[0] === '/' || str_contains($rel, "\0")) fail(11, 'bad path');
    $parts = explode('/', $rel);
    foreach ($parts as $p) if ($p === '' || $p === '.' || $p === '..') fail(11, 'bad path');
    $cur = SITE;
    foreach ($parts as $i => $p) {
        $cur .= '/' . $p;
        $last = $i === count($parts) - 1;
        $st = @lstat($cur);
        if ($st === false) {
            if ($existing) fail(10, 'not found');
            if ($last) return $cur;
            if (!@mkdir($cur, 0755)) fail(12, 'cannot create ' . $p);
            continue;
        }
        $type = $st['mode'] & S_IFMT;
        if (!$last && $type !== S_IFDIR) fail(11, 'a link or a file on the way');
        if ($last && !$existing) fail(13, 'something is there already');
        if ($last && $type !== S_IFREG) fail(11, 'not a regular file');
    }
    return $cur;
}

function copy_new(string $from, string $to): void {
    $in = @fopen($from, 'rb');
    if ($in === false) fail(12, 'cannot read');
    $out = @fopen($to, 'xb');
    if ($out === false) { fclose($in); fail(13, 'cannot create the copy'); }
    $ok = stream_copy_to_stream($in, $out) !== false && fflush($out);
    fclose($in);
    fclose($out);
    if (!$ok) { @unlink($to); fail(15, 'copy failed'); }
}

$op = $argv[1] ?? '';
$rel = $argv[2] ?? '';
$stored = $argv[3] ?? '';
$sha = $argv[4] ?? '';
if (!preg_match('/^[0-9a-f]{64}$/', $sha) || !preg_match('/^[A-Za-z0-9._-]{1,100}$/', $stored)) fail(11, 'bad arguments');
$kept = STORE . '/' . $stored;

if ($op === 'move') {
    $file = walk($rel, true);
    if (@hash_file('sha256', $file) !== $sha) fail(14, 'changed since the scan');
    $mode = fileperms($file) & 0777;
    $size = filesize($file);
    copy_new($file, $kept);
    if (@hash_file('sha256', $kept) !== $sha) { @unlink($kept); fail(15, 'the copy differs'); }
    @chmod($kept, 0400);
    if (!@unlink($file)) { @unlink($kept); fail(12, 'cannot remove the original'); }
    echo json_encode(['mode' => sprintf('%o', $mode), 'size' => $size]), "\n";
    exit(0);
}
if ($op === 'restore') {
    $st = @lstat($kept);
    if ($st === false || ($st['mode'] & S_IFMT) !== S_IFREG) fail(10, 'the quarantined copy is gone');
    if (@hash_file('sha256', $kept) !== $sha) fail(14, 'the quarantined copy changed');
    $file = walk($rel, false);
    copy_new($kept, $file);
    if (@hash_file('sha256', $file) !== $sha) { @unlink($file); fail(15, 'the restored file differs'); }
    @chmod($file, octdec(preg_match('/^[0-7]{3,4}$/', $argv[5] ?? '') ? $argv[5] : '644') & 0777);
    if (!@unlink($kept)) fail(12, 'cannot remove the quarantined copy');
    echo json_encode(['restored' => true]), "\n";
    exit(0);
}
fail(2, 'usage: move|restore <path> <stored> <sha256> [mode]');
`;

export interface QuarantineRequest {
  path: string;
  sha256: string;
  findingIds: number[];
  reason: string;
}

export class QuarantineService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly servers: ServerRegistry,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  list(siteId: number): SiteQuarantineRow[] {
    return this.db.select().from(siteQuarantine).where(eq(siteQuarantine.siteId, siteId)).orderBy(desc(siteQuarantine.movedAt)).all();
  }

  get(siteId: number, id: number): SiteQuarantineRow {
    const row = this.db
      .select()
      .from(siteQuarantine)
      .where(and(eq(siteQuarantine.siteId, siteId), eq(siteQuarantine.id, id)))
      .get();
    if (!row) throw notFound('No such quarantined file');
    return row;
  }

  /** Hold the site for the length of `fn`, as a Web FTP change does (worker.holdSite). */
  static async held<T>(worker: Pick<JobWorker, 'holdSite'>, site: Pick<SiteRow, 'id' | 'slug'>, fn: () => Promise<T>): Promise<T> {
    const release = worker.holdSite(site);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Move one file out of the site. The caller holds the site. */
  async move(site: SiteRow, req: QuarantineRequest, by: string): Promise<SiteQuarantineRow> {
    const stored = `${this.now()}-${crypto.randomBytes(6).toString('hex')}.quarantined`;
    const res = await this.run(site, ['move', req.path, stored, req.sha256]);
    const info = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { mode?: string; size?: number };
    const now = this.now();
    const row = this.db
      .insert(siteQuarantine)
      .values({
        siteId: site.id,
        findingId: req.findingIds[0] ?? null,
        path: req.path,
        storedName: stored,
        sha256: req.sha256,
        sizeBytes: typeof info.size === 'number' ? info.size : null,
        mode: typeof info.mode === 'string' && /^[0-7]{1,4}$/.test(info.mode) ? info.mode : null,
        reason: req.reason.slice(0, 200),
        movedAt: now,
        movedBy: by,
      })
      .returning()
      .get();
    if (req.findingIds.length > 0) {
      this.db
        .update(siteScanFindings)
        .set({ status: 'quarantined', statusAt: now, statusBy: by })
        .where(and(eq(siteScanFindings.siteId, site.id), inArray(siteScanFindings.id, req.findingIds)))
        .run();
    }
    this.log.info(`Quarantined ${req.path} of "${site.slug}" (${req.reason}, by ${by})`);
    return row;
  }

  /**
   * Put a file back where it was. Its findings become ignored, by whoever restored it: a scan
   * that moved it again would undo the decision, and a change to the file reopens them anyway.
   * The caller holds the site.
   */
  async restore(site: SiteRow, id: number, by: string): Promise<SiteQuarantineRow> {
    const row = this.get(site.id, id);
    if (row.restoredAt !== null || row.deletedAt !== null) throw conflict('That file is no longer in quarantine');
    await this.run(site, ['restore', row.path, row.storedName, row.sha256, row.mode ?? '644']);
    const now = this.now();
    this.db.update(siteQuarantine).set({ restoredAt: now, restoredBy: by }).where(eq(siteQuarantine.id, row.id)).run();
    this.db
      .update(siteScanFindings)
      .set({ status: 'ignored', statusAt: now, statusBy: by })
      .where(and(eq(siteScanFindings.siteId, site.id), eq(siteScanFindings.path, row.path), eq(siteScanFindings.status, 'quarantined')))
      .run();
    this.log.info(`Restored ${row.path} of "${site.slug}" from quarantine (by ${by})`);
    return this.get(site.id, id);
  }

  /** Delete a quarantined copy for good. */
  async remove(site: SiteRow, id: number, by: string): Promise<SiteQuarantineRow> {
    const row = this.get(site.id, id);
    if (row.restoredAt !== null || row.deletedAt !== null) throw conflict('That file is no longer in quarantine');
    await this.servers.handleFor(site.serverId).files.rm(path.join(sitePaths(this.config, site.slug).quarantine, row.storedName));
    this.db.update(siteQuarantine).set({ deletedAt: this.now(), deletedBy: by }).where(eq(siteQuarantine.id, row.id)).run();
    return this.get(site.id, id);
  }

  /** `scan.quarantineKeepDays`: copies older than that are deleted; 0 keeps them until someone does. */
  async prune(keepDays: number): Promise<number> {
    if (!(keepDays > 0)) return 0;
    const cutoff = this.now() - keepDays * 86_400_000;
    const old = this.db
      .select()
      .from(siteQuarantine)
      .where(and(isNull(siteQuarantine.restoredAt), isNull(siteQuarantine.deletedAt), lt(siteQuarantine.movedAt, cutoff)))
      .all();
    let done = 0;
    for (const row of old) {
      const site = this.db.select().from(sites).where(eq(sites.id, row.siteId)).get();
      if (!site) continue;
      try {
        await this.remove(site, row.id, 'retention');
        done++;
      } catch (err) {
        this.log.warn(`Could not delete quarantined ${row.path} of "${site.slug}": ${err instanceof Error ? err.message : err}`);
      }
    }
    return done;
  }

  private async run(site: SiteRow, args: string[]) {
    const handle = this.servers.handleFor(site.serverId);
    const p = sitePaths(this.config, site.slug);
    // The site's own user has to write here, and nothing but these containers mounts it.
    await handle.files.mkdirp(p.quarantine, { mode: 0o700, owner: { uid: 33, gid: 33 } });
    const res = await handle.docker.runEphemeral({
      image: siteImage(site.phpVersion),
      entrypoint: ['php'],
      cmd: ['-d', 'memory_limit=64M', '-r', QUARANTINE_SCRIPT, ...args],
      user: '33:33',
      binds: [`${p.wordpress}:/var/www/html`, `${p.quarantine}:/quarantine`],
      labels: { 'wpl7.quarantine': args[0] ?? '' },
      timeoutMs: 5 * 60_000,
      lockdown: { memoryBytes: 128 * 1024 * 1024, nanoCpus: 1e9, pidsLimit: 32, tmpfs: { '/tmp': 8 } },
    });
    if (res.exitCode !== 0) {
      const why = QUARANTINE_EXIT[res.exitCode];
      if (why) throw badRequest(why);
      throw new Error(`The quarantine container failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
    }
    return res;
  }
}
