/**
 * The zips in the plugin catalog, each held once to what it holds (docs/security.md). A zip is
 * unpacked in AMWScan's container with no network, every file of its folder hashed and the
 * scanner run over them - once per zip, and again when AMWScan or WPL7's tuning of it changes
 * - and the result kept.
 *
 * A site's malware scan then has the catalog vouch for its plugin of the same folder
 * (services/malwareScan.ts): a file the same as one of a checked zip's is left out of the
 * scan, like a wordpress.org plugin's published file - whatever version the site has, since a
 * premium plugin updates itself and most of its files stay as they were. Never a file a zip's
 * own check flagged, until a person has looked at those and said they are the plugin's own:
 * that is what makes a premium plugin's false match one alert, here, rather than one on every
 * site after every update. A zip is only ever trusted as far as that check and that review go.
 */
// @docs plugins/catalog, security/malware-scans
import crypto from 'node:crypto';
import fs from 'node:fs';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { jobs, pluginZipChecks, plugins, type JobRow, type PluginZipCheckRow } from '../db/schema.js';
import type { JobWorker } from '../jobs/worker.js';
import type { ServerRegistry } from '../servers/registry.js';
import { FINDING_KIND_INFO, type FindingKind, type FindingSeverity } from '../../shared/security.js';
import type { PluginZipCheckDto, PluginZipFindingDto } from '../../shared/types.js';
import { badRequest, notFound } from '../lib/errors.js';
import { storedZipPluginFolder, zipEntries } from '../lib/pluginZip.js';
import type { Manifest } from './integrityManifests.js';
import { scanLane, type ScanLog } from './malwareScan.js';
import { MAX_UNPACKED_MB, SCAN_PROFILE, ensureScannerImage, runZipCheck } from './scanEngines.js';
import { PARTIAL_RULE } from './scanReport.js';
import type { SettingsService } from './settings.js';
import type { Logger } from './index.js';

const MIB = 1024 * 1024;
/** The panel's own server, where the catalog's zips are kept. */
const PANEL_SERVER_ID = 1;
/** Zip checks queued by one pass of the schedule at most. */
const SWEEP_BATCH = 3;
/** A failed check is tried again this long after. */
const FAILED_RETRY_MS = 24 * 3600_000;

/** What a site's scan is handed for a plugin the checked catalog zips of its folder vouch for. */
export interface CatalogVoucher {
  /** The catalog entry's name - the zip of the site's version where there is one - for the scan's log. */
  name: string;
  /** Every file of those zips, each with every hash it has in them, less those withheld. */
  manifest: Manifest;
  /** Files a check flagged and nobody has reviewed, that no other zip vouches for: left out. */
  withheld: number;
  /** The versions of the zips, newest check first, and whether one of them is the site's. */
  versions: string[];
  exact: boolean;
}

/** A file a catalog zip's check flagged that nobody has reviewed: what a site's finding links to. */
export interface ZipFlag {
  pluginId: number;
  name: string;
  version: string | null;
}

/** What a site's scan asks of the catalog. */
export interface CatalogVouchers {
  vouchFor(folder: string, version: string): CatalogVoucher | null;
}

interface StoredFinding {
  path: string;
  kind: FindingKind;
  severity: FindingSeverity;
  rule: string | null;
  line: number | null;
  detail: string | null;
}

/** The findings a review was of: exactly these files and rules, whatever their order. */
function digestOf(findings: StoredFinding[]): string {
  const lines = findings.map((f) => `${f.path}\n${f.rule ?? ''}`).sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class PluginZipChecks implements CatalogVouchers {
  constructor(
    private readonly db: Db,
    private readonly servers: ServerRegistry,
    private readonly settings: SettingsService,
    private readonly notify: (subject: string, body: string) => Promise<boolean>,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Queue the check of one catalog zip, in the scan lane of the panel's server. Asking while
   * one is waiting or running hands back that one.
   */
  request(worker: Pick<JobWorker, 'enqueue'>, pluginId: number): { job: JobRow; queued: boolean } {
    const plugin = this.db.select().from(plugins).where(eq(plugins.id, pluginId)).get();
    if (!plugin) throw notFound(`Catalog plugin #${pluginId} not found`);
    if (plugin.kind !== 'zip') throw badRequest("A wordpress.org plugin is checked on each site against wordpress.org's own checksums");
    const active = this.activeJob(pluginId);
    if (active) return { job: active, queued: false };
    const at = this.now();
    this.db
      .insert(pluginZipChecks)
      .values({ pluginId, status: 'pending', requestedAt: at })
      .onConflictDoUpdate({ target: pluginZipChecks.pluginId, set: { requestedAt: at } })
      .run();
    const job = worker.enqueue('plugin.zipCheck', { pluginId }, undefined, { lane: scanLane(PANEL_SERVER_ID) });
    return { job, queued: true };
  }

  /** The check of this zip that is queued or running, if there is one. */
  activeJob(pluginId: number): JobRow | null {
    return (
      this.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.type, 'plugin.zipCheck'),
            inArray(jobs.status, ['queued', 'running']),
            sql`json_extract(${jobs.payload}, '$.pluginId') = ${pluginId}`,
          ),
        )
        .get() ?? null
    );
  }

  /**
   * The schedule's pass: queue the zips never checked, checked with another AMWScan or tuning
   * of it, or whose check failed a day ago - a few at a time. Nothing while scans are off.
   */
  sweep(worker: Pick<JobWorker, 'enqueue'>): string[] {
    if (this.settings.get('scanEnabled') === false) return [];
    const now = this.now();
    const checks = new Map(this.db.select().from(pluginZipChecks).all().map((c) => [c.pluginId, c]));
    const queued: string[] = [];
    for (const plugin of this.db.select().from(plugins).where(eq(plugins.kind, 'zip')).all()) {
      if (queued.length >= SWEEP_BATCH) break;
      const check = checks.get(plugin.id);
      const due =
        !check ||
        (check.status === 'pending' && check.checkedAt === null) ||
        (check.status !== 'pending' && check.scanner !== SCAN_PROFILE) ||
        (check.status === 'failed' && (check.checkedAt ?? 0) + FAILED_RETRY_MS <= now);
      if (!due || this.activeJob(plugin.id)) continue;
      this.request(worker, plugin.id);
      queued.push(plugin.name);
    }
    return queued;
  }

  /** The check itself, as the plugin.zipCheck job runs it. Throws when nothing could be checked. */
  async run(log: ScanLog, pluginId: number): Promise<{ status: string; files: number; confirmed: number; flagged: number }> {
    const plugin = this.db.select().from(plugins).where(eq(plugins.id, pluginId)).get();
    if (!plugin || plugin.kind !== 'zip' || !plugin.zipPath) throw new Error('This zip is no longer in the catalog');
    const previous = this.db.select().from(pluginZipChecks).where(eq(pluginZipChecks.pluginId, pluginId)).get();
    const record = (set: Partial<typeof pluginZipChecks.$inferInsert>) =>
      this.db
        .insert(pluginZipChecks)
        .values({ pluginId, status: 'pending', ...set })
        .onConflictDoUpdate({ target: pluginZipChecks.pluginId, set })
        .run();
    const fail: (problem: string) => never = (problem) => {
      record({ status: 'failed', problem, checkedAt: this.now(), scanner: SCAN_PROFILE });
      throw new Error(problem);
    };

    const zipPath = plugin.zipPath;
    if (!fs.existsSync(zipPath)) fail("The zip file is missing from the panel's server.");
    const zipSha256 = await sha256File(zipPath);
    const folder = storedZipPluginFolder(zipPath);
    if (!folder) {
      fail("The zip has no single top-level folder. WordPress names such a plugin after the file, so no site's plugin can be matched to it.");
    }
    const entries = zipEntries(zipPath);
    if (!entries) fail('The file is not a zip that can be read.');
    const sized = entries.every((e) => e.size >= 0);
    const bytes = entries.reduce((n, e) => n + Math.max(0, e.size), 0);
    if (bytes > MAX_UNPACKED_MB * MIB) fail(`It unpacks to more than ${MAX_UNPACKED_MB} MB, which is more than is checked.`);
    const unpackedMb = sized ? Math.min(MAX_UNPACKED_MB, Math.max(32, Math.ceil((bytes / MIB) * 1.1) + 16)) : MAX_UNPACKED_MB;

    const handle = this.servers.localHandle();
    log.info(`Unpacking "${plugin.name}" (${folder}) in a throwaway container with no network…`);
    await ensureScannerImage(handle, (line) => log.info(line));
    log.checkCanceled();
    const result = await runZipCheck(handle, zipPath, folder, {
      memoryBytes: (Number(this.settings.get('scanMemoryMb')) || 512) * MIB,
      timeoutMs: (Number(this.settings.get('scanTimeoutMin')) || 30) * 60_000,
      unpackedMb,
    });
    if (result.state === 'failed') fail(result.problem ?? 'The zip check failed.');

    const findings: StoredFinding[] = result.findings.map((f) => ({
      path: f.path,
      kind: f.kind,
      severity: f.severity,
      rule: f.rule,
      line: f.line,
      detail: f.detail,
    }));
    const confirmed = findings.filter((f) => f.kind === 'signature').length;
    const digest = digestOf(findings);
    const status = result.state === 'complete' ? 'done' : 'incomplete';
    const files = Object.keys(result.files).length;
    record({
      status,
      zipSha256,
      scanner: SCAN_PROFILE,
      folder,
      version: result.version,
      files,
      manifest: JSON.stringify(result.files),
      findings: JSON.stringify(findings),
      confirmed,
      problem: result.problem,
      checkedAt: this.now(),
      // A review holds for exactly the findings it was of: anything else is looked at again.
      ...(previous?.reviewedDigest && previous.reviewedDigest !== digest ? { reviewedAt: null, reviewedBy: null, reviewedDigest: null } : {}),
    });

    const flagged = new Set(findings.map((f) => f.path)).size;
    const partial = findings.filter((f) => f.rule === PARTIAL_RULE).length;
    log.info(
      `${plugin.name}: ${files} files${result.version ? ` of version ${result.version}` : ', no Version in its header'}; ` +
        (flagged === 0
          ? 'AMWScan found nothing.'
          : `${flagged} file(s) to review: ${confirmed} known-malware match(es)${partial > 0 ? `, ${partial} too large to scan whole` : ''}.`),
    );
    if (result.problem) log.warn(result.problem);

    const reviewedStill = previous?.reviewedDigest === digest && previous.reviewedAt !== null;
    if (confirmed > 0 && previous?.alertedFor !== zipSha256 && !reviewedStill) {
      record({ alertedFor: zipSha256 });
      await this.alert(plugin.name, result.version, findings);
    }
    return { status, files, confirmed, flagged };
  }

  private async alert(name: string, version: string | null, findings: StoredFinding[]): Promise<boolean> {
    const known = findings.filter((f) => f.kind === 'signature');
    const lines = [
      `The zip "${name}"${version ? ` (version ${version})` : ''} in the plugin catalog matches malware signatures in ${known.length} place(s):`,
      '',
      ...known.slice(0, 20).map((f) => `  - ${f.path}${f.line ? ` (line ${f.line})` : ''}: ${f.detail ?? f.rule ?? ''}`),
      ...(known.length > 20 ? [`  …and ${known.length - 20} more`] : []),
      '',
      'Some plugins trip a signature with their own code. Until you look at these files on the',
      "Plugins page and say they are the plugin's own, every site's copy of them is reported as",
      "known malware; the zip's other files are vouched for on every site that has them unchanged.",
      'If the zip should not be trusted, remove it from the catalog.',
    ];
    return this.notify(`Plugin zip "${name}": ${known.length} match(es) of known malware`, lines.join('\n'));
  }

  /** Say the files the last check flagged are the plugin's own: from now on they are vouched for too. */
  review(pluginId: number, by: string): PluginZipCheckDto {
    const row = this.db.select().from(pluginZipChecks).where(eq(pluginZipChecks.pluginId, pluginId)).get();
    if (!row || row.status !== 'done') throw badRequest('Only a finished check can be reviewed');
    const findings = parseJson<StoredFinding[]>(row.findings, []);
    if (findings.length === 0) throw badRequest("The zip's check flagged nothing");
    this.db
      .update(pluginZipChecks)
      .set({ reviewedAt: this.now(), reviewedBy: by, reviewedDigest: digestOf(findings) })
      .where(eq(pluginZipChecks.pluginId, pluginId))
      .run();
    return this.dto(this.db.select().from(pluginZipChecks).where(eq(pluginZipChecks.pluginId, pluginId)).get()!);
  }

  /**
   * The catalog's word on a site's plugin: every finished check of a zip of that folder, of any
   * version, each file with every hash it has in them - less the files a check flagged that
   * nobody reviewed. A file is the same bytes or it is not: a version's other files changing
   * says nothing about this one. Null when no zip of that folder has been checked.
   */
  vouchFor(folder: string, version: string): CatalogVoucher | null {
    const hits = this.db
      .select({ check: pluginZipChecks, name: plugins.name })
      .from(pluginZipChecks)
      .innerJoin(plugins, eq(plugins.id, pluginZipChecks.pluginId))
      .where(and(eq(pluginZipChecks.status, 'done'), eq(pluginZipChecks.folder, folder)))
      .orderBy(desc(pluginZipChecks.checkedAt))
      .all();
    if (hits.length === 0) return null;
    const vouched: Record<string, string[]> = {};
    const held = new Set<string>();
    for (const hit of hits) {
      const files = parseJson<Record<string, string>>(hit.check.manifest, {});
      const findings = parseJson<StoredFinding[]>(hit.check.findings, []);
      const withheld = this.isReviewed(hit.check, findings) ? new Set<string>() : new Set(findings.map((f) => f.path));
      for (const [path, sha256] of Object.entries(files)) {
        if (withheld.has(path)) {
          held.add(path);
          continue;
        }
        const list = Object.hasOwn(vouched, path) ? vouched[path]! : (vouched[path] = []);
        if (!list.includes(sha256)) list.push(sha256);
      }
    }
    const exact = hits.find((h) => h.check.version === version);
    return {
      name: (exact ?? hits[0]!).name,
      manifest: { hashType: 'sha256', files: vouched },
      withheld: [...held].filter((path) => !Object.hasOwn(vouched, path)).length,
      versions: [...new Set(hits.map((h) => h.check.version).filter((v): v is string => v !== null))],
      exact: exact !== undefined,
    };
  }

  /**
   * Files the zips' checks flagged that nobody has reviewed, by folder and path in it - what a
   * site's finding on the same file points to: one review there, and every site's copy of it
   * is vouched for.
   */
  unreviewedFlags(): Map<string, Map<string, ZipFlag>> {
    const out = new Map<string, Map<string, ZipFlag>>();
    const rows = this.db
      .select({ check: pluginZipChecks, name: plugins.name })
      .from(pluginZipChecks)
      .innerJoin(plugins, eq(plugins.id, pluginZipChecks.pluginId))
      .where(eq(pluginZipChecks.status, 'done'))
      .orderBy(desc(pluginZipChecks.checkedAt))
      .all();
    for (const { check, name } of rows) {
      if (!check.folder) continue;
      const findings = parseJson<StoredFinding[]>(check.findings, []);
      if (findings.length === 0 || this.isReviewed(check, findings)) continue;
      const byPath = out.get(check.folder) ?? new Map<string, ZipFlag>();
      out.set(check.folder, byPath);
      for (const f of findings) if (!byPath.has(f.path)) byPath.set(f.path, { pluginId: check.pluginId, name, version: check.version });
    }
    return out;
  }

  private isReviewed(row: PluginZipCheckRow, findings: StoredFinding[]): boolean {
    return row.reviewedAt !== null && row.reviewedDigest === digestOf(findings);
  }

  /** Every zip's check, for the catalog's list. */
  all(): Map<number, PluginZipCheckDto> {
    return new Map(this.db.select().from(pluginZipChecks).all().map((row) => [row.pluginId, this.dto(row)]));
  }

  dto(row: PluginZipCheckRow): PluginZipCheckDto {
    const findings = parseJson<StoredFinding[]>(row.findings, []);
    const reviewed = this.isReviewed(row, findings);
    return {
      status: row.status as PluginZipCheckDto['status'],
      checking: this.activeJob(row.pluginId) !== null,
      folder: row.folder,
      version: row.version,
      files: row.files,
      flagged: new Set(findings.map((f) => f.path)).size,
      confirmed: row.confirmed,
      problem: row.problem,
      checkedAt: row.checkedAt,
      reviewed: reviewed ? { at: row.reviewedAt!, by: row.reviewedBy } : null,
      needsReview: row.status === 'done' && findings.length > 0 && !reviewed,
    };
  }

  /** One zip's check, with what AMWScan said, most serious first. */
  details(pluginId: number): { check: PluginZipCheckDto | null; findings: PluginZipFindingDto[] } {
    const row = this.db.select().from(pluginZipChecks).where(eq(pluginZipChecks.pluginId, pluginId)).get();
    if (!row) return { check: null, findings: [] };
    const order: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };
    const findings = parseJson<StoredFinding[]>(row.findings, [])
      .map((f) => ({ ...f, label: f.rule === PARTIAL_RULE ? 'Partly scanned' : (FINDING_KIND_INFO[f.kind]?.label ?? f.kind) }))
      .sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));
    return { check: this.dto(row), findings };
  }
}
