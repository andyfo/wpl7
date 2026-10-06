/**
 * What a scan may move out of a site on its own (docs/security.md). One file at a time, from
 * everything the scan found about it:
 *
 *   where the file is                                  confirmed   anything else ("everything")
 *   uploads; an extra file among WordPress's own        moved       moved
 *   an extra file in a wordpress.org plugin             moved       reported
 *   a package's own file, changed                       reported - Reinstall original instead
 *   WPL7's own file, changed                            reported - Put back instead
 *   wp-config.php, the top index.php and .htaccess,     reported
 *   anything in mu-plugins, any link
 *
 * Confirmed = a malware signature or a known-malware hash. Suspicious-code candidates - what
 * premium plugins trip too - are never a reason to move anything, under any setting. Nothing
 * moves unless the scan knows the file's hash, which the move checks first. More than
 * MAX_AUTO_QUARANTINE files in one scan and nothing moves at all: that many is a site to look
 * at, not to empty.
 */
// @docs security/malware-scans
import type { FindingConfidence, FindingKind, ScanOnFinding } from '../../shared/security.js';

export const MAX_AUTO_QUARANTINE = 25;

export interface PolicyFinding {
  id: number;
  kind: FindingKind;
  confidence: FindingConfidence;
  path: string;
  sha256: string | null;
}

export type FileDecision =
  | { action: 'move'; path: string; sha256: string; findingIds: number[]; reason: string }
  | { action: 'report'; path: string; why: string };

/** Never moved by anybody: the site stops without them, or they are the site's own set-up. */
export function isProtectedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower === 'wp-config.php' ||
    lower === 'index.php' ||
    lower === '.htaccess' ||
    lower === '.user.ini' ||
    lower.startsWith('wp-content/mu-plugins/')
  );
}

/** One file, with everything found about it. */
export function decideFile(path: string, found: PolicyFinding[], mode: ScanOnFinding): FileDecision {
  const report = (why: string): FileDecision => ({ action: 'report', path, why });
  if (mode === 'report') return report('The setting is to report.');
  if (isProtectedPath(path)) return report('The site needs this file; it is never moved on its own.');
  const kinds = new Set(found.map((f) => f.kind));
  if (kinds.has('link-outside')) return report('A link is never moved.');
  if (kinds.has('core-modified') || kinds.has('plugin-modified')) {
    return report('A changed file of WordPress or a plugin is put right by reinstalling it, not moved.');
  }
  if (kinds.has('panel-modified')) return report('A changed WPL7 file is put back, not moved.');
  const confirmed = found.some((f) => f.confidence === 'confirmed' && f.kind === 'signature');
  const facts = found.filter((f) => f.kind !== 'suspicious');
  const inUploads = path.startsWith('wp-content/uploads/');
  const extraAmongCore = kinds.has('core-extra');
  const extraInPlugin = kinds.has('plugin-extra');
  let reason: string | null = null;
  if (inUploads || extraAmongCore) {
    if (confirmed) reason = 'Known malware';
    else if (mode === 'quarantine-all' && facts.length > 0) reason = inUploads ? 'Code in uploads' : "Not one of WordPress's own files";
  } else if (extraInPlugin && confirmed) {
    reason = 'Known malware';
  }
  if (!reason) return report(confirmed ? 'Where this file is, it is only ever reported.' : 'Nothing about it is certain enough to move it.');
  const sha256 = found.map((f) => f.sha256).find((h): h is string => h !== null) ?? null;
  if (!sha256) return report('The scan did not record what the file held, so it cannot be checked before a move.');
  return { action: 'move', path, sha256, findingIds: found.map((f) => f.id), reason };
}

export interface QuarantinePlan {
  move: Extract<FileDecision, { action: 'move' }>[];
  /** Files that would have moved, had there not been too many. */
  overLimit: number;
}

/** Every open finding of a site, grouped by file, decided. */
export function planQuarantine(open: PolicyFinding[], mode: ScanOnFinding, max = MAX_AUTO_QUARANTINE): QuarantinePlan {
  const byPath = new Map<string, PolicyFinding[]>();
  for (const f of open) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  const move = [...byPath]
    .map(([path, found]) => decideFile(path, found, mode))
    .filter((d): d is Extract<FileDecision, { action: 'move' }> => d.action === 'move')
    .sort((a, b) => a.path.localeCompare(b.path));
  return move.length > max ? { move: [], overLimit: move.length } : { move, overLimit: 0 };
}

/** A finding as the buttons on the site's Findings card need it. */
interface ActionableFinding {
  kind: FindingKind;
  path: string;
  sha256: string | null;
  status: string;
  package: string | null;
}

/** Why a finding's file cannot be moved to quarantine by hand; null when it can. */
export function manualQuarantineProblem(f: ActionableFinding): string | null {
  if (f.status === 'quarantined') return 'It is in quarantine already.';
  if (f.status === 'resolved') return 'It is not there any more.';
  if (f.kind === 'panel-modified') return 'A changed WPL7 file is put right with Put back.';
  if (isProtectedPath(f.path)) return 'The site needs this file to run: put it right instead.';
  if (f.kind === 'link-outside') return 'A link is never moved; remove it in the Files tab.';
  if (f.kind === 'core-modified' || f.kind === 'plugin-modified') return 'A changed file of WordPress or a plugin is put right with Reinstall original.';
  if (f.kind === 'core-missing' || f.kind === 'plugin-missing') return 'The file is missing.';
  if (!f.sha256) return 'The scan did not record what the file held; scan again first.';
  return null;
}

/** WPL7's own file, changed: writing the panel's version again puts it right. */
export function canPutBack(f: ActionableFinding): boolean {
  return (f.status === 'open' || f.status === 'ignored') && f.kind === 'panel-modified';
}

/** A package's own file, changed or missing, that downloading the package again puts right. */
export function canReinstall(f: ActionableFinding): boolean {
  return (
    (f.status === 'open' || f.status === 'ignored') &&
    /^(core|plugin)-(modified|missing)$/.test(f.kind) &&
    (f.package === 'core' || /^plugin:[a-z0-9][a-z0-9_.-]{0,99}$/.test(f.package ?? ''))
  );
}
