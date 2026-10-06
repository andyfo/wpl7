/**
 * npm run docs:map
 *
 * Joins the two ways a page is tied to code - `sources:` globs in its front matter, and
 * `@docs <slug>` markers in comments in the code - into .docs-map.json (ignored by git): for
 * every page its title, URL, file, globs and the files they resolve to; for every file the
 * pages that cover it. docs-sync reads it to name the pages a pull request affects.
 *
 * Fails, with one line per problem, when:
 * - an `@docs` slug names no page;
 * - a page in a feature group (Sites … Panel) has no `sources:` and no marker;
 * - a `sources:` glob matches no file;
 * - a generated page was edited by hand: its body no longer matches the hash in its header.
 *
 * The map is written even when there are problems, so docs-sync can still comment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanMarkers, type Marker } from './lib/markers.js';
import { FEATURE_GROUPS, SITE_DIR, isMain, listPages, resolveGlobs, sha256, type Page } from './lib/pages.js';

export const MAP_FILE = path.join(SITE_DIR, '.docs-map.json');

export interface MapPage {
  title: string;
  url: string;
  /** The page's own file. */
  file: string;
  group: string;
  generated: boolean;
  /** The script that writes the page, for a generated one. */
  generator?: string;
  /** `sources:` as written. */
  sources: string[];
  /** Files carrying an `@docs` marker that names this page. */
  markers: string[];
  /** Every file the page covers: what its globs match, plus the marked files. */
  files: string[];
}

export interface DocsMap {
  pages: Record<string, MapPage>;
  /** File -> the slugs of the pages that cover it. */
  files: Record<string, string[]>;
  errors: string[];
}

const sorted = <T>(items: Iterable<T>): T[] => [...new Set(items)].sort();

export async function buildDocsMap(pagesIn?: Page[], markersIn?: Marker[]): Promise<DocsMap> {
  const pages = pagesIn ?? (await listPages());
  const markers = markersIn ?? (await scanMarkers());
  const errors: string[] = [];
  const bySlug = new Map(pages.map((p) => [p.slug, p]));

  for (const page of pages) {
    for (const problem of page.problems) errors.push(`${page.file}: ${problem}`);
  }

  // Code -> page.
  const markedFiles = new Map<string, Set<string>>();
  for (const marker of markers) {
    for (const slug of marker.slugs) {
      if (!bySlug.has(slug)) {
        errors.push(`${marker.file}:${marker.line}: @docs ${slug} names no page (no src/content/docs/${slug}.mdx or .md)`);
        continue;
      }
      const set = markedFiles.get(slug) ?? new Set<string>();
      set.add(marker.file);
      markedFiles.set(slug, set);
    }
  }

  // Page -> code.
  const globs = await resolveGlobs(pages.flatMap((p) => p.sources));
  const out: DocsMap = { pages: {}, files: {}, errors };
  const fileToSlugs = new Map<string, Set<string>>();
  for (const page of pages) {
    const matched: string[] = [];
    for (const pattern of page.sources) {
      const files = globs.get(pattern) ?? [];
      if (files.length === 0) errors.push(`${page.file}: sources: "${pattern}" matches no file`);
      matched.push(...files);
    }
    const marked = sorted(markedFiles.get(page.slug) ?? []);
    const files = sorted([...matched, ...marked]);
    if ((FEATURE_GROUPS as readonly string[]).includes(page.group) && page.sources.length === 0 && marked.length === 0) {
      errors.push(
        `${page.file}: a page in ${page.group}/ must name the code it documents: add sources: to its front matter, or an @docs ${page.slug} comment to that code`,
      );
    }
    if (page.generated && sha256(page.generated.body) !== page.generated.hash) {
      errors.push(
        `${page.file}: written by ${page.generated.by}, then edited by hand (its body no longer matches the sha256 in its header). Change the source instead and run npm run docs:generate in docs/site.`,
      );
    }
    out.pages[page.slug] = {
      title: page.title,
      url: page.url,
      file: page.file,
      group: page.group,
      generated: page.generated !== null,
      ...(page.generated ? { generator: page.generated.by } : {}),
      sources: page.sources,
      markers: marked,
      files,
    };
    for (const file of files) {
      const set = fileToSlugs.get(file) ?? new Set<string>();
      set.add(page.slug);
      fileToSlugs.set(file, set);
    }
  }
  for (const file of sorted(fileToSlugs.keys())) out.files[file] = sorted(fileToSlugs.get(file)!);
  return out;
}

export function writeDocsMap(map: DocsMap): void {
  fs.writeFileSync(MAP_FILE, `${JSON.stringify(map, null, 2)}\n`);
}

/** The map docs:map last wrote, or null when there is none. */
export function readDocsMap(): DocsMap | null {
  if (!fs.existsSync(MAP_FILE)) return null;
  return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) as DocsMap;
}

if (isMain(import.meta.url)) {
  const map = await buildDocsMap();
  writeDocsMap(map);
  const pages = Object.keys(map.pages).length;
  const files = Object.keys(map.files).length;
  const marked = new Set(Object.values(map.pages).flatMap((p) => p.markers)).size;
  console.log(`docs:map: ${pages} pages cover ${files} files (${marked} of them through @docs markers); wrote ${path.relative(process.cwd(), MAP_FILE) || MAP_FILE}`);
  if (map.errors.length > 0) {
    console.error(`\ndocs:map found ${map.errors.length} problem${map.errors.length === 1 ? '' : 's'}:`);
    for (const error of map.errors) console.error(`  ${error}`);
    process.exitCode = 1;
  }
}
