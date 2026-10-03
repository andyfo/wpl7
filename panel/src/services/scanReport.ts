/**
 * What a scan's two engines said, read back from their JSON lines (services/scanScripts.ts)
 * into findings the panel can store. Pure: output in, findings and an honest account of how
 * far each engine got out.
 *
 * Nothing printed by a container is trusted: every line is parsed on its own, every path must
 * stay inside the site, every value is bounded, and an engine whose summary line never came
 * was cut short - incomplete, never clean.
 */
import crypto from 'node:crypto';
import {
  FINDING_KIND_INFO,
  type FindingConfidence,
  type FindingKind,
  type FindingSeverity,
} from '../../shared/security.js';

export type ScanEngine = 'check' | 'signatures';

export interface ScanFinding {
  engine: ScanEngine;
  kind: FindingKind;
  confidence: FindingConfidence;
  severity: FindingSeverity;
  /** Relative to the site's WordPress folder. */
  path: string;
  line: number | null;
  rule: string | null;
  detail: string | null;
  package: string | null;
  packageVersion: string | null;
  sha256: string | null;
}

/** How one package fared against its published checksums (the check's summary). */
export interface PackageCount {
  files: number;
  verified: number;
  modified: number;
  extra: number;
  missing: number;
}

export interface EngineResult {
  engine: ScanEngine;
  /** complete: ran to the end and read everything; incomplete: did not; failed: never ran. */
  state: 'complete' | 'incomplete' | 'failed';
  /** Why it is not complete, in words for the page. */
  problem: string | null;
  findings: ScanFinding[];
  /** More findings than were printed: none of this engine's may be called resolved. */
  truncated: boolean;
  files: number | null;
  elapsedMs: number | null;
  peakMemory: number | null;
  /** The check only. */
  packages: Record<string, PackageCount>;
  /** The check only: every link it met (up to a thousand), which the scanner reads through. */
  links: string[];
  linksTruncated: boolean;
  /** The check only: files of a plugin in a folder of another name that its list did not vouch for. */
  unverified: string[];
  /** The check only: such plugins with more of those than it named - none of their files is vouched for. */
  unverifiedPackages: string[];
  /** The check only: copies a plugin deploys of one of its files that are that file, each with its source. */
  copies: Record<string, string>;
  /** The signatures only: the definitions it ran with. */
  definitions: string | null;
  /** The signatures only: files too large to read whole - only their start and end were screened. */
  partial: PartialFile[];
  partialCount: number;
  /** The signatures only: what WPL7's tuning left out (services/scanTuning.ts), counted. */
  quieted: { presence: number; inert: number };
  /** The signatures only: the exploit overrides applied, and the ones the scanner's own patterns stood in for. */
  tuning: { applied: string[]; skipped: { name: string; why: string }[] } | null;
}

export interface PartialFile {
  path: string;
  bytes: number | null;
}

export interface InventoryPlugin {
  /** Its folder's name (a single-file plugin: the file's, without .php). */
  slug: string;
  version: string | null;
  single: boolean;
  /** Its main file's name without .php, and its Text Domain: what a renamed folder still says it is. */
  mainFile: string | null;
  textDomain: string | null;
}

export interface InventoryResult {
  core: { version: string; locale: string | null } | null;
  plugins: InventoryPlugin[];
  themes: { slug: string; version: string | null }[];
}

export interface RunOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const TRUNCATED_MARK = '…[output truncated]';
/** 'core:wp-admin', 'core:wp-includes/js', 'core:root', 'plugin:<slug>'. */
const PACKAGE_KEY = /^(core:(root|(wp-admin|wp-includes)(\/[A-Za-z0-9_.-]{1,100})?)|plugin:[a-z0-9][a-z0-9_.-]{0,99})$/;
const CHECK_KINDS: ReadonlySet<FindingKind> = new Set([
  'core-modified',
  'core-missing',
  'core-extra',
  'plugin-modified',
  'plugin-missing',
  'plugin-extra',
  'upload-php',
  'upload-handler',
  'link-outside',
  'panel-modified',
]);

function lines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // A line cut in half by the output ceiling, or noise: not ours to guess at.
    }
  }
  return out;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** A path the site could have: relative, no way up, no NUL, not absurdly long. */
export function sitePath(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 1024) return null;
  if (v.startsWith('/') || v.includes('\0') || v.split('/').some((p) => p === '..' || p === '')) return null;
  return v;
}

const sha = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null);

function cutShort(res: RunOutput, what: string): string {
  if (res.exitCode === 137) return `${what} ran out of memory and was stopped.`;
  const said = (res.stderr || '').trim().split('\n').slice(-1)[0]?.slice(0, 200);
  return `${what} stopped before it finished (exit ${res.exitCode})${said ? `: ${said}` : '.'}`;
}

const blank = (engine: ScanEngine): EngineResult => ({
  engine,
  state: 'failed',
  problem: null,
  findings: [],
  truncated: false,
  files: null,
  elapsedMs: null,
  peakMemory: null,
  packages: {},
  links: [],
  linksTruncated: false,
  unverified: [],
  unverifiedPackages: [],
  copies: {},
  definitions: null,
  partial: [],
  partialCount: 0,
  quieted: { presence: 0, inert: 0 },
  tuning: null,
});

/** An engine that could not be run at all. */
export function engineFailed(engine: ScanEngine, problem: string): EngineResult {
  return { ...blank(engine), problem };
}

export function parseInventory(res: RunOutput): InventoryResult {
  const line = lines(res.stdout).find((l) => l.t === 'inventory');
  if (!line) throw new Error(cutShort(res, 'Reading what is installed'));
  const core = line.core as { version?: unknown; locale?: unknown } | null;
  const version = str(core?.version, 40);
  const slugOk = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v) ? v : null);
  return {
    core: version ? { version, locale: str(core?.locale, 20) } : null,
    plugins: (Array.isArray(line.plugins) ? line.plugins : [])
      .map((p: { slug?: unknown; version?: unknown; single?: unknown; file?: unknown; textDomain?: unknown }) => ({
        slug: slugOk(p?.slug),
        version: str(p?.version, 40),
        single: p?.single === true,
        mainFile: slugOk(typeof p?.file === 'string' ? (p.file.split('/').pop() ?? '').replace(/\.php$/i, '') : null),
        textDomain: slugOk(p?.textDomain),
      }))
      .filter((p): p is InventoryPlugin => p.slug !== null)
      .slice(0, 500),
    themes: (Array.isArray(line.themes) ? line.themes : [])
      .map((t: { slug?: unknown; version?: unknown }) => ({ slug: slugOk(t?.slug), version: str(t?.version, 40) }))
      .filter((t): t is { slug: string; version: string | null } => t.slug !== null)
      .slice(0, 200),
  };
}

export function parseCheck(res: RunOutput): EngineResult {
  const all = lines(res.stdout);
  const summary = all.find((l) => l.t === 'summary' && l.engine === 'check');
  const out = blank('check');
  for (const l of all) {
    if (l.t === 'unverified') {
      const path = sitePath(l.path);
      if (path && out.unverified.length < 5_000) out.unverified.push(path);
      continue;
    }
    if (l.t === 'unverified-package') {
      if (typeof l.package === 'string' && PACKAGE_KEY.test(l.package) && l.package.startsWith('plugin:')) out.unverifiedPackages.push(l.package);
      continue;
    }
    if (l.t === 'copy') {
      const path = sitePath(l.path);
      const source = sitePath(l.source);
      if (path && source && Object.keys(out.copies).length < 100) out.copies[path] = source;
      continue;
    }
    if (l.t !== 'finding') continue;
    const kind = l.kind as FindingKind;
    const path = sitePath(l.path);
    if (!CHECK_KINDS.has(kind) || !path) continue;
    out.findings.push({
      engine: 'check',
      kind,
      confidence: 'suspicious',
      severity: FINDING_KIND_INFO[kind].severity,
      path,
      line: null,
      rule: null,
      detail: str(l.detail, 300),
      package: str(l.package, 120),
      packageVersion: str(l.packageVersion, 40),
      sha256: sha(l.sha256),
    });
  }
  if (!summary) {
    return { ...out, state: 'incomplete', problem: cutShort(res, 'The file check') };
  }
  const packages: Record<string, PackageCount> = {};
  if (summary.packages && typeof summary.packages === 'object') {
    for (const [key, v] of Object.entries(summary.packages as Record<string, Record<string, unknown>>)) {
      if (!PACKAGE_KEY.test(key)) continue;
      packages[key] = {
        files: int(v?.files) ?? 0,
        verified: int(v?.verified) ?? 0,
        modified: int(v?.modified) ?? 0,
        extra: int(v?.extra) ?? 0,
        missing: int(v?.missing) ?? 0,
      };
    }
  }
  const unreadable = int(summary.unreadable) ?? 0;
  const sample = (Array.isArray(summary.unreadableSample) ? summary.unreadableSample : []).map(sitePath).filter(Boolean).slice(0, 3);
  const cut = res.stdout.includes(TRUNCATED_MARK);
  return {
    ...out,
    state: unreadable > 0 || cut ? 'incomplete' : 'complete',
    problem: cut
      ? 'The file check said more than the panel reads; its findings are not all here.'
      : unreadable > 0
        ? `${unreadable} file${unreadable === 1 ? '' : 's'} or folder${unreadable === 1 ? '' : 's'} could not be read${sample.length ? ` (${sample.join(', ')})` : ''}.`
        : null,
    truncated: summary.truncated === true || cut,
    files: int(summary.files),
    elapsedMs: int(summary.elapsedMs),
    peakMemory: int(summary.peakMemory),
    packages,
    links: (Array.isArray(summary.links) ? summary.links : []).map(sitePath).filter((p): p is string => p !== null),
    linksTruncated: summary.linksTruncated === true,
  };
}

/**
 * The scanner's findings, sorted by what they are rather than by what AMWScan calls them: a
 * signature or a known-malware hash is confirmed; an exploit pattern, a hidden risky function
 * and the like are suspicious-code candidates - what premium plugins trip too. A signature is
 * `signature:<its own id>` where the reducer could say which one it was, `sign:<AMWScan's>`
 * where it could not.
 */
export function signatureFinding(l: Record<string, unknown>): ScanFinding | null {
  const path = sitePath(l.path);
  const rule = str(l.rule, 200);
  if (!path || !rule || rule.startsWith('integrity:')) return null;
  const confirmed = /^(sign|signature|hash):/.test(rule);
  const message = str(l.message, 300);
  const match = str(l.match, 200);
  return {
    engine: 'signatures',
    kind: confirmed ? 'signature' : 'suspicious',
    confidence: confirmed ? 'confirmed' : 'suspicious',
    severity: confirmed ? 'high' : l.severity === 'danger' ? 'medium' : 'low',
    path,
    line: int(l.line),
    rule,
    detail: [message, match].filter(Boolean).join(': ').slice(0, 300) || null,
    package: null,
    packageVersion: null,
    sha256: sha(l.sha256),
  };
}

/** The tuning's line (scanScripts.ts RULES_SCRIPT): which overrides it applied and which it did not. */
function parseTuning(line: Record<string, unknown> | undefined): EngineResult['tuning'] {
  if (!line) return null;
  const name = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(v) ? v : null);
  const applied = (Array.isArray(line.applied) ? line.applied : []).map(name).filter((n): n is string => n !== null);
  const skipped = (Array.isArray(line.skipped) ? line.skipped : [])
    .map((s: { name?: unknown; why?: unknown }) => ({ name: name(s?.name), why: str(s?.why, 120) ?? '' }))
    .filter((s): s is { name: string; why: string } => s.name !== null);
  return { applied: applied.slice(0, 20), skipped: skipped.slice(0, 20) };
}

export function parseSignatures(res: RunOutput): EngineResult {
  const all = lines(res.stdout);
  const summary = all.find((l) => l.t === 'summary' && l.engine === 'signatures');
  const out = blank('signatures');
  out.tuning = parseTuning(all.find((l) => l.t === 'tuning'));
  for (const l of all) {
    if (l.t !== 'finding') continue;
    const finding = signatureFinding(l);
    if (finding) out.findings.push(finding);
  }
  if (!summary) return { ...out, state: 'incomplete', problem: cutShort(res, 'The signature scan') };
  const exit = int(summary.exit) ?? 2;
  const said = str(summary.said, 300);
  const base = {
    ...out,
    files: int(summary.scanned),
    peakMemory: int(summary.peakMemory) || null,
    definitions: str(summary.definitions, 40),
    partial: (Array.isArray(summary.partial) ? summary.partial : [])
      .map((p: { path?: unknown; bytes?: unknown }) => ({ path: sitePath(p?.path), bytes: int(p?.bytes) }))
      .filter((p): p is PartialFile => p.path !== null)
      .slice(0, 50),
    partialCount: int(summary.partialCount) ?? 0,
    quieted: { presence: int(summary.presence) ?? 0, inert: int(summary.inert) ?? 0 },
  };
  if (summary.report !== true) {
    if (exit === 137) return { ...base, state: 'incomplete', problem: 'The signature scan ran out of memory and was stopped.' };
    return { ...base, state: 'failed', problem: `The signature scan failed (exit ${exit})${said ? `: ${said}` : '.'}` };
  }
  const unreadable = (int(summary.unreadable) ?? 0) + (int(summary.errors) ?? 0);
  const cut = res.stdout.includes(TRUNCATED_MARK);
  const complete = summary.complete === true && unreadable === 0 && !cut && exit < 2;
  return {
    ...base,
    state: complete ? 'complete' : 'incomplete',
    problem: complete
      ? null
      : cut
        ? 'The signature scan said more than the panel reads; its findings are not all here.'
        : unreadable > 0
          ? `The signature scan could not read ${unreadable} file${unreadable === 1 ? '' : 's'}.`
          : `The signature scan did not get through every file${exit >= 2 ? ` (exit ${exit})` : ''}.`,
    truncated: summary.truncated === true || cut,
  };
}

/**
 * What the site is known to hold as published, for leaving the scanner's findings on those
 * files out: a file of WordPress or of a wordpress.org plugin whose hash matched is exactly
 * what everyone else runs, whatever a pattern thinks of it.
 */
export interface KnownFiles {
  /** Listed in a package's published checksums (and the check read it). */
  published(path: string): boolean;
}

export function fingerprintOf(f: Pick<ScanFinding, 'engine' | 'kind' | 'path' | 'rule'>): string {
  return crypto.createHash('sha256').update([f.engine, f.kind, f.path, f.rule ?? ''].join('\n')).digest('hex').slice(0, 40);
}

/**
 * Whether the check vouched for a file: listed by what it was held to, and not named as changed.
 * Only when the check said everything: past its ceiling, a changed file may be one it did not
 * name, and would pass for the published one. A plugin's deployed copy that is the same as its
 * source is vouched for exactly as far as the source is.
 */
function vouchedBy(check: EngineResult | null, known: KnownFiles): (path: string) => boolean {
  const checked = check?.state === 'complete' && !check.truncated;
  // Changed files: named as findings, or - in a renamed plugin - only as not vouched for.
  const modified = new Set([...(check?.findings ?? []).filter((f) => f.kind.endsWith('-modified')).map((f) => f.path), ...(check?.unverified ?? [])]);
  const unvouched = new Set(check?.unverifiedPackages ?? []);
  const pluginOf = (p: string) => /^wp-content\/plugins\/([^/]+)\//.exec(p)?.[1];
  const copies = check?.copies ?? {};
  return (path) => {
    const p = Object.hasOwn(copies, path) ? copies[path]! : path;
    return checked && known.published(p) && !modified.has(p) && !unvouched.has(`plugin:${pluginOf(p)}`);
  };
}

/**
 * The findings of one scan: the check's, then the scanner's minus those on files the check
 * vouched for and on links (it reads through them, so what it found is somewhere else). One per
 * fingerprint - the scanner reports a rule once for every line it matches.
 */
export function combineFindings(check: EngineResult | null, signatures: EngineResult | null, known: KnownFiles): ScanFinding[] {
  const out = new Map<string, ScanFinding>();
  for (const f of check?.findings ?? []) {
    const key = fingerprintOf(f);
    if (!out.has(key)) out.set(key, f);
  }
  const vouched = vouchedBy(check, known);
  const links = new Set(check?.links ?? []);
  for (const f of signatures?.findings ?? []) {
    if (links.has(f.path) || vouched(f.path)) continue;
    const key = fingerprintOf(f);
    const seen = out.get(key);
    if (!seen || (f.line !== null && (seen.line === null || f.line < seen.line))) out.set(key, f);
  }
  return [...out.values()];
}

/** The files the scanner could only partly read that nothing vouched for: a note on the scan, never a finding. */
export function partlyScanned(check: EngineResult | null, signatures: EngineResult | null, known: KnownFiles): { count: number; files: PartialFile[] } {
  if (!signatures) return { count: 0, files: [] };
  const vouched = vouchedBy(check, known);
  const files = signatures.partial.filter((p) => !vouched(p.path));
  // Past the ones named, nothing says which of the rest were vouched for: they count as not.
  return { count: files.length + Math.max(0, signatures.partialCount - signatures.partial.length), files };
}

/** What a catalog zip holds and what the scanner says about it (services/pluginZipChecks.ts). */
export interface ZipCheckResult {
  /** complete: every file hashed and scanned; incomplete: not all; failed: nothing usable. */
  state: 'complete' | 'incomplete' | 'failed';
  problem: string | null;
  /** The plugin's own name and Version, from its header; null when it has none. */
  name: string | null;
  version: string | null;
  /** Path in the zip's folder -> sha256. */
  files: Record<string, string>;
  /** The scanner's findings, with paths in the zip's folder. */
  findings: ScanFinding[];
  scanned: number | null;
}

/**
 * A file of a catalog zip the scanner could only partly read. On a site that is a note; in a
 * zip it is held back like a finding: vouching for it would vouch for bytes nobody scanned.
 */
export const PARTIAL_RULE = 'partial:too-large';

/**
 * The zip check's output: the manifest script's lines, then the reducer's, as for a site.
 * The scanner saw the zip unpacked at /var/www/html, so its paths start with the folder,
 * which is taken off - they are then the same paths as a site's plugin folder has. Files it
 * could only partly read come back as findings of their own (PARTIAL_RULE), so the zip does
 * not vouch for them until someone has looked; more of them than the reducer names, and the
 * check is incomplete - it cannot say which.
 */
export function parseZipCheck(res: RunOutput, folder: string): ZipCheckResult {
  const all = lines(res.stdout);
  const summary = all.find((l) => l.t === 'zipsummary');
  const files: Record<string, string> = {};
  for (const l of all) {
    if (l.t !== 'zipfile') continue;
    const path = sitePath(l.path);
    const hash = sha(l.sha256);
    if (path && hash && !Object.hasOwn(files, path)) files[path] = hash;
  }
  const signatures = parseSignatures(res);
  const prefix = `${folder}/`;
  const partial: ScanFinding[] = signatures.partial.map((p) => ({
    engine: 'signatures',
    kind: 'suspicious',
    confidence: 'suspicious',
    severity: 'low',
    path: p.path,
    line: null,
    rule: PARTIAL_RULE,
    detail: `Too large to scan whole${p.bytes !== null ? ` (${p.bytes.toLocaleString('en-US')} bytes)` : ''}: only its start and end were checked.`,
    package: null,
    packageVersion: null,
    sha256: null,
  }));
  const findings = [...signatures.findings, ...partial].filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
  const failed = (problem: string): ZipCheckResult => ({ state: 'failed', problem, name: null, version: null, files: {}, findings: [], scanned: null });
  if (!summary) return failed(cutShort(res, 'The zip check'));
  const said = str(summary.said, 300);
  if (summary.found !== true) {
    return failed(`The zip did not unpack to its folder "${folder}"${said ? `: ${said}` : '.'}`);
  }
  const problems = [
    int(summary.unzip) ? `unzip said: ${said ?? `exit ${int(summary.unzip)}`}.` : null,
    summary.truncated === true ? 'It holds more files than are checked.' : null,
    (int(summary.unreadable) ?? 0) > 0 ? `${int(summary.unreadable)} of its files could not be read.` : null,
    signatures.partialCount > signatures.partial.length ? `${signatures.partialCount} files were too large to scan whole, more than can be named.` : null,
    signatures.state !== 'complete' ? signatures.problem : null,
  ].filter((p): p is string => p !== null);
  return {
    state: problems.length > 0 ? 'incomplete' : 'complete',
    problem: problems.length > 0 ? problems.join(' ') : null,
    name: str(summary.name, 60),
    version: str(summary.version, 40),
    files,
    findings,
    scanned: signatures.files,
  };
}
