/**
 * npm run docs:sync -- --base <ref> [--files a,b,c] [--body-file <file>] [--labels a,b] [--out <comment.md>]
 *
 * The docs-sync check of a pull request. The changed files (`git diff --name-only <base>...HEAD`,
 * or --files) are mapped to the pages that document them, through .docs-map.json (npm run
 * docs:map writes it) and through the pages' `sources:` globs, which also catch a new file no
 * marker names yet. Then:
 *
 * - every changed file is under docs/site/: nothing to check, it passes;
 * - no page documents the changed code: it passes;
 * - only generated pages are affected: it passes, because the `check` job holds those to their
 *   sources and a regenerated page is no sign that anyone read the hand-written ones;
 * - one of the affected hand-written pages changed in the pull request: it passes;
 * - the description has a line `Docs: not needed — <reason>` (or `Docs: n/a — <reason>`), with a
 *   reason, or the pull request has the label `no-docs-change`: it passes;
 * - otherwise it fails, and exits 1.
 *
 * Files that change every screenshot (the panel's stylesheet, layout and UI kit) are named in a
 * note for the screenshots job instead of being mapped to pages.
 *
 * Either way it writes one Markdown comment, starting with the marker `<!-- docs-sync -->` so the
 * workflow can find and update it: the verdict, each affected page with its public URL, its file
 * and the changed files behind it, and the reports of check-flags and check-ui-paths.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { checkFlags } from './check-flags.js';
import { checkUiPaths } from './check-ui-paths.js';
import { buildDocsMap, readDocsMap, writeDocsMap, type DocsMap } from './docs-map.js';
import { CONTENT_DIR, REPO_ROOT, isMain, repoRel, slugOf } from './lib/pages.js';

export const MARKER = '<!-- docs-sync -->';
export const OVERRIDE_LABEL = 'no-docs-change';
/** Files every screenshot shows: they go to the screenshots job, not to pages. */
export const SCREENSHOT_FILES = ['panel/web/src/styles.css', 'panel/web/src/components/Layout.tsx', 'panel/web/src/components/ui.tsx'];
const CONTENT_PREFIX = `${repoRel(CONTENT_DIR)}/`;

export interface SyncInput {
  files: string[];
  body: string;
  labels: string[];
}

export type Verdict = 'skip' | 'none' | 'generated' | 'updated' | 'override' | 'fail';

export interface SyncResult {
  verdict: Verdict;
  pass: boolean;
  /** Slug -> the changed files behind it. */
  affected: Map<string, string[]>;
  changedPages: Set<string>;
  screenshots: string[];
  override: string | null;
}

/** The reason after `Docs: not needed` / `Docs: n/a`, or null when the line is missing or gives none. */
export function overrideReason(body: string): string | null {
  const match = /^Docs: (not needed|n\/a)\b(.+)$/im.exec(body.replace(/\r\n?/g, '\n'));
  if (!match) return null;
  const reason = match[2]!.replace(/^[\s\-–—:.,]+/, '').trim();
  // The template's placeholder, pasted as it is, is no reason.
  return reason === '' || /^<\s*reason\s*>$/i.test(reason) ? null : reason;
}

export function evaluate(map: DocsMap, input: SyncInput): SyncResult {
  const files = [...new Set(input.files.map((f) => f.trim()).filter(Boolean))].sort();
  const changedPages = new Set(
    files.filter((f) => f.startsWith(CONTENT_PREFIX) && /\.mdx?$/.test(f)).map((f) => slugOf(f.slice(CONTENT_PREFIX.length))),
  );
  const result: SyncResult = { verdict: 'fail', pass: false, affected: new Map(), changedPages, screenshots: [], override: null };
  if (files.length === 0 || files.every((f) => f.startsWith('docs/site/'))) return { ...result, verdict: 'skip', pass: true };

  const matchers = Object.entries(map.pages).map(([slug, page]) => [slug, page.sources.map((g) => picomatch(g, { dot: true }))] as const);
  for (const file of files) {
    if (file.startsWith('docs/site/')) continue;
    if (SCREENSHOT_FILES.includes(file)) {
      result.screenshots.push(file);
      continue;
    }
    const slugs = new Set(map.files[file] ?? []);
    for (const [slug, globs] of matchers) if (globs.some((isMatch) => isMatch(file))) slugs.add(slug);
    for (const slug of slugs) result.affected.set(slug, [...(result.affected.get(slug) ?? []), file]);
  }

  const hand = [...result.affected.keys()].filter((slug) => !map.pages[slug]?.generated);
  result.override = input.labels.includes(OVERRIDE_LABEL) ? `the label \`${OVERRIDE_LABEL}\`` : overrideReason(input.body);
  if (result.affected.size === 0) return { ...result, verdict: 'none', pass: true };
  if (hand.length === 0) return { ...result, verdict: 'generated', pass: true };
  if (hand.some((slug) => changedPages.has(slug))) return { ...result, verdict: 'updated', pass: true };
  if (result.override) return { ...result, verdict: 'override', pass: true };
  return result;
}

function fileLink(file: string): string {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.DOCS_SYNC_REF;
  return server && repo && ref ? `[\`${file}\`](${server}/${repo}/blob/${ref}/${file})` : `\`${file}\``;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function comment(map: DocsMap, result: SyncResult, reports: string[]): string {
  const hand = [...result.affected.keys()].filter((slug) => !map.pages[slug]?.generated).sort();
  const generated = [...result.affected.keys()].filter((slug) => map.pages[slug]?.generated).sort();
  const lines = [MARKER, '## Docs sync', ''];
  const updated = hand.filter((s) => result.changedPages.has(s));
  switch (result.verdict) {
    case 'skip':
      lines.push('**Passed.** Only `docs/site/` changed, so there is no code to hold the pages to.');
      break;
    case 'none':
      lines.push('**Passed.** No docs page documents the code this pull request changes.');
      break;
    case 'generated':
      lines.push('**Passed.** Only generated pages document the changed code, and the `check` job keeps those in step.');
      break;
    case 'updated':
      lines.push(`**Passed.** ${plural(updated.length, 'affected page')} changed in this pull request. Check that the others below still hold.`);
      break;
    case 'override':
      lines.push(`**Passed** by ${result.override?.startsWith('the label') ? result.override : `the description: “${result.override}”`}.`);
      break;
    case 'fail':
      lines.push(
        `**Failing.** This pull request changes code that ${plural(hand.length, 'docs page')} document${hand.length === 1 ? 's' : ''}, and none of them changed. ` +
          'Update the pages that no longer hold, or add a line with the reason to the description:',
        '',
        '```',
        'Docs: not needed — <reason>',
        '```',
      );
      break;
  }
  if (hand.length > 0) {
    lines.push('', '| Page | File | Changed code behind it |', '| --- | --- | --- |');
    for (const slug of hand) {
      const page = map.pages[slug]!;
      const mark = result.changedPages.has(slug) ? ' (changed)' : '';
      lines.push(`| [${page.title}](${page.url})${mark} | ${fileLink(page.file)} | ${result.affected.get(slug)!.map((f) => `\`${f}\``).join(', ')} |`);
    }
  }
  if (generated.length > 0) {
    const byScript = new Map<string, string[]>();
    for (const slug of generated) {
      const script = map.pages[slug]!.generator ?? 'a generator';
      byScript.set(script, [...(byScript.get(script) ?? []), slug]);
    }
    lines.push('', 'Generated pages these changes feed, which `npm run docs:generate` in `docs/site` rewrites:', '');
    for (const [script, slugs] of byScript) {
      const titles = slugs.length > 3 ? `${plural(slugs.length, 'page')}, from ${map.pages[slugs[0]!]!.title}` : slugs.map((s) => map.pages[s]!.title).join(', ');
      lines.push(`- \`${path.basename(script)}\`: ${titles}`);
    }
  }
  if (result.screenshots.length > 0) {
    lines.push('', `Every screenshot shows ${result.screenshots.map((f) => `\`${f}\``).join(', ')}: expect the screenshots job to take them all again.`);
  }
  if (map.errors.length > 0) {
    lines.push('', `<details><summary>docs:map found ${plural(map.errors.length, 'problem')} (the check job fails on these)</summary>`, '');
    for (const error of map.errors) lines.push(`- ${error}`);
    lines.push('', '</details>');
  }
  for (const report of reports) lines.push('', report.trim());
  return `${lines.join('\n')}\n`;
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function changedFiles(base: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

if (isMain(import.meta.url)) {
  const base = arg('base');
  const filesArg = arg('files');
  if (!base && filesArg === undefined) {
    console.error('docs:sync needs --base <ref> (or --files a,b,c to try it)');
    process.exit(2);
  }
  const files = filesArg !== undefined ? filesArg.split(',') : changedFiles(base!);
  const bodyFile = arg('body-file');
  const body = bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '';
  const labels = (arg('labels') ?? '').split(',').map((l) => l.trim()).filter(Boolean);
  let map = readDocsMap();
  if (!map) {
    map = await buildDocsMap();
    writeDocsMap(map);
  }
  const result = evaluate(map, { files, body, labels });
  const reports = [(await checkFlags()).markdown, (await checkUiPaths()).markdown];
  const text = comment(map, result, reports);
  const out = arg('out');
  if (out) fs.writeFileSync(out, text);
  console.log(text);
  if (!result.pass) process.exitCode = 1;
}
