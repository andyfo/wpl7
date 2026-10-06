/**
 * `@docs <slug>[, <slug>…]` markers: comments in the code that name the docs pages documenting
 * it. A marker counts only inside a comment (`//`, `#`, `/* *\/`, `{/* *\/}`, `<!-- -->`, or a
 * `*` line of a block comment), so the words "@docs" in a string are not one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { REPO_ROOT, toPosix } from './pages.js';

/** Where markers are looked for. */
export const MARKER_ROOTS = ['panel/**', 'provision/**', 'deploy/**', 'install.sh', 'scripts/**'];

/** Tests document nothing for readers; a change to one should not ask for a docs change. */
export function isTestFile(rel: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

const SKIP = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.{png,jpg,jpeg,gif,webp,ico,svg,woff,woff2,ttf,otf,zip,gz,tgz,tar,sqlite,db,pdf,lock}',
  '**/package-lock.json',
  'panel/src/db/migrations/meta/**',
];

const SLUG = '[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)*';
const SLUG_LIST_RE = new RegExp(`^@docs[ \\t]+(${SLUG}(?:[ \\t]*,[ \\t]*${SLUG})*)`);

export interface Marker {
  /** Repository-relative path. */
  file: string;
  /** 1-based. */
  line: number;
  slugs: string[];
  /** The marker is a comment line of its own (`// @docs …`, `# @docs …`), not a trailing one. */
  ownLine: boolean;
}

/** Every marker in a file's text. */
export function markersIn(file: string, text: string): Marker[] {
  if (!text.includes('@docs')) return [];
  const out: Marker[] = [];
  const lines = text.split('\n');
  lines.forEach((lineText, i) => {
    let at = lineText.indexOf('@docs');
    while (at !== -1) {
      const before = lineText.slice(0, at);
      const inComment = /(\/\/|#|\/\*|<!--)/.test(before) || /^\s*\*/.test(lineText);
      const match = SLUG_LIST_RE.exec(lineText.slice(at));
      if (inComment && match) {
        out.push({
          file,
          line: i + 1,
          slugs: match[1]!.split(',').map((s) => s.trim()),
          ownLine: /^\s*(\/\/|#|\/\*|\{\/\*|<!--|\*)\s*$/.test(before),
        });
      }
      at = lineText.indexOf('@docs', at + 5);
    }
  });
  return out;
}

/** Every marker under MARKER_ROOTS, tests left out, sorted by file and line. */
export async function scanMarkers(): Promise<Marker[]> {
  const files = await glob(MARKER_ROOTS, { cwd: REPO_ROOT, dot: true, ignore: SKIP });
  const out: Marker[] = [];
  for (const rel of files.map(toPosix).sort()) {
    if (isTestFile(rel)) continue;
    const abs = path.join(REPO_ROOT, rel);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    const buf = fs.readFileSync(abs);
    if (!buf.includes('@docs') || buf.subarray(0, 8192).includes(0)) continue;
    out.push(...markersIn(rel, buf.toString('utf8')));
  }
  return out;
}
