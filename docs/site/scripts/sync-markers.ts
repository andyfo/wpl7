/**
 * npm run docs:markers [-- --check]
 *
 * Makes every code file a page lists in `sources:` carry an `@docs` marker naming that page, so
 * whoever edits the file sees which pages document it. Code means .ts, .tsx, .mjs, .js, .sh,
 * .yml and .yaml under panel/, provision/ or deploy/, and install.sh. Tests and docs/site/ are
 * never touched, and neither are generated pages' sources: the `check` job already holds those
 * pages to their code, and apiDocs.ts would otherwise carry a slug for every API group.
 *
 * A missing slug goes into one comment line near the top of the file that lists every page
 * documenting it, sorted: `// @docs sites/create, sites/domains`, or `# @docs …` in shell and
 * YAML. It sits after a shebang and before the first import or code line, never inside a
 * comment block or between a doc comment and what it documents. A shell script that prints its
 * own header as help (`sed -n '2,18p' "$0"`) gets the line below that range instead.
 *
 * Idempotent: a file whose slugs are all present, anywhere in it, is left as it is.
 * --check only reports what is missing, and exits 1 when anything is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isTestFile, markersIn } from './lib/markers.js';
import { REPO_ROOT, isMain, listPages, resolveGlobs } from './lib/pages.js';

const CODE_EXT = /\.(ts|tsx|mjs|js|sh|yml|yaml)$/;
const HASH_STYLE = /\.(sh|yml|yaml)$/;

export function wantsMarker(rel: string): boolean {
  if (rel.startsWith('docs/site/') || isTestFile(rel)) return false;
  if (rel === 'install.sh') return true;
  return /^(panel|provision|deploy)\//.test(rel) && CODE_EXT.test(rel);
}

const sortSlugs = (slugs: Iterable<string>): string[] => [...new Set(slugs)].sort();

/** The pages each code file should name, from every hand-written page's `sources:`. */
export async function wantedMarkers(): Promise<Map<string, Set<string>>> {
  const pages = (await listPages()).filter((p) => !p.generated);
  const globs = await resolveGlobs(pages.flatMap((p) => p.sources));
  const wanted = new Map<string, Set<string>>();
  for (const page of pages) {
    for (const pattern of page.sources) {
      for (const file of globs.get(pattern) ?? []) {
        if (!wantsMarker(file)) continue;
        const set = wanted.get(file) ?? new Set<string>();
        set.add(page.slug);
        wanted.set(file, set);
      }
    }
  }
  return wanted;
}

interface Placement {
  /** Index (0-based) to insert a new marker line at. */
  insertAt: number;
  /** The last line index a top-of-file marker may sit on. */
  headerEnd: number;
}

/** Where a marker line goes in a JavaScript or TypeScript file. */
function placeInScript(lines: string[]): Placement {
  const start = lines[0]?.startsWith('#!') ? 1 : 0;
  let inBlock = false;
  let firstCode = lines.length;
  for (let j = start; j < lines.length; j++) {
    const line = lines[j]!.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.slice(2).includes('*/')) inBlock = true;
      continue;
    }
    firstCode = j;
    break;
  }
  const code = lines[firstCode] ?? '';
  if (/^(import\b|export\s+(\*|\{[^}]*\}|type\s+\{)\s*.*\bfrom\b)/.test(code.trim())) {
    // Imports take no doc comment: right above the first one, after any file comment.
    return { insertAt: firstCode, headerEnd: firstCode };
  }
  // Code: above the comment block attached to it, so a doc comment stays with its declaration.
  let attached = firstCode;
  while (attached > start && lines[attached - 1]!.trim() !== '' && isCommentLine(lines, attached - 1)) attached--;
  return { insertAt: attached, headerEnd: firstCode };
}

/** Is line `i` a comment line - `//`, or any line of a `/* *\/` block? */
function isCommentLine(lines: string[], i: number): boolean {
  const line = lines[i]!.trim();
  if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.endsWith('*/')) return true;
  return false;
}

/** Where a marker line goes in a shell script or YAML file. */
function placeInHashFile(lines: string[], text: string): Placement {
  const start = lines[0]?.startsWith('#!') ? 1 : 0;
  let j = start;
  while (j < lines.length && lines[j]!.trimStart().startsWith('#')) j++;
  // A script that prints lines A-B of itself as --help: stay out of that range.
  let helpEnd = 0;
  for (const match of text.matchAll(/sed -n '(\d+),(\d+)p' "(?:\$0|\$\{BASH_SOURCE\[0\]\})"/g)) {
    helpEnd = Math.max(helpEnd, Number(match[2]));
  }
  const insertAt = Math.max(j, helpEnd);
  return { insertAt, headerEnd: insertAt };
}

/** The text with `slugs` named, or null when it already names them all. */
export function withMarkers(rel: string, text: string, slugs: Set<string>): { text: string; added: string[] } | null {
  const present = new Set(markersIn(rel, text).flatMap((m) => m.slugs));
  const added = sortSlugs([...slugs].filter((s) => !present.has(s)));
  if (added.length === 0) return null;
  const hash = HASH_STYLE.test(rel);
  const lead = hash ? '#' : '//';
  const lines = text.split('\n');
  const placement = hash ? placeInHashFile(lines, text) : placeInScript(lines);
  const top = markersIn(rel, text).find(
    (m) => m.ownLine && m.line - 1 <= placement.headerEnd && lines[m.line - 1]!.trimStart().startsWith(lead),
  );
  if (top) {
    const index = top.line - 1;
    const indent = /^\s*/.exec(lines[index]!)![0];
    lines[index] = `${indent}${lead} @docs ${sortSlugs([...top.slugs, ...slugs]).join(', ')}`;
  } else {
    lines.splice(placement.insertAt, 0, `${lead} @docs ${sortSlugs(slugs).join(', ')}`);
  }
  return { text: lines.join('\n'), added };
}

export interface MarkerReport {
  file: string;
  added: string[];
}

export async function syncMarkers(opts: { check: boolean }): Promise<MarkerReport[]> {
  const wanted = await wantedMarkers();
  const report: MarkerReport[] = [];
  for (const rel of [...wanted.keys()].sort()) {
    const abs = path.join(REPO_ROOT, rel);
    const text = fs.readFileSync(abs, 'utf8');
    const result = withMarkers(rel, text, wanted.get(rel)!);
    if (!result) continue;
    report.push({ file: rel, added: result.added });
    if (!opts.check) fs.writeFileSync(abs, result.text);
  }
  return report;
}

if (isMain(import.meta.url)) {
  const check = process.argv.includes('--check');
  const report = await syncMarkers({ check });
  if (report.length === 0) {
    console.log('docs:markers: every source file names the pages that document it');
  } else {
    console.log(`docs:markers: ${report.length} file${report.length === 1 ? '' : 's'} ${check ? 'miss' : 'got'} @docs markers`);
    for (const { file, added } of report) console.log(`  ${file}: ${added.join(', ')}`);
    if (check) {
      console.log('\nRun npm run docs:markers in docs/site to add them.');
      process.exitCode = 1;
    }
  }
}
