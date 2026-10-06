/**
 * npm run docs:check-ui-paths
 *
 * Every place in the panel a page names must exist in the panel: each step of a
 * `<UiPath>…</UiPath>` and of a bold path (`**Sites → Security**`), and each bold `**Label**`
 * that looks like one - short, starting with a capital, no sentence punctuation, not code. A
 * renamed button is the most common way docs rot, and this is what catches it.
 *
 * "Exists" means the text is a string literal or JSX text in panel/web/src, or in what it shows
 * from elsewhere: panel/shared (finding kinds, job names, key levels) and the built-in schedule
 * names in panel/src/jobs/schedulers.ts. Compared after collapsing whitespace, ignoring case, a
 * trailing " →", "…" or ":", and a trailing "(…)" such as a count. The TSX is turned
 * into plain JavaScript with esbuild first (the copy tsx itself depends on), so JSX text arrives
 * as string literals and an apostrophe in it cannot derail the reading.
 *
 * Labels that belong to other software, and bold words that are emphasis, go in IGNORE below.
 * Generated pages are not checked. Prints a Markdown report and always exits 0.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { REPO_ROOT, isMain, listPages, type Page } from './lib/pages.js';

/** Not the panel's words: WordPress, Cloudflare, GitHub and other software, and plain emphasis. Compared without case. */
export const IGNORE = new Set(
  [
    // WordPress
    'Settings → Reading',
    'Reading',
    'Discourage search engines from indexing this site',
    'Users → Profile',
    'Profile',
    'Application Passwords',
    'Add New Application Password',
    'Plugins → Add New',
    'Add New Plugin',
    'Tools → Site Health',
    'Site Health',
    'Appearance → Themes',
    'Appearance → Theme File Editor',
    'Settings → General',
    'Settings → Permalinks',
    'WordPress Address (URL)',
    'Site Address (URL)',
    // Cloudflare
    'My Profile',
    'API Tokens',
    'My Profile → API Tokens',
    'Create Token',
    'Edit zone DNS',
    'Zone → Zone → Read',
    'Zone → DNS → Edit',
    'Zone Resources',
    'Proxied',
    'DNS only',
    // GitHub
    'Watch',
    'Custom',
    'Releases',
    // FTP clients
    'Site Manager',
    'Quickconnect',
    // AI apps
    'Settings → Connectors → Add custom connector',
    'Settings → Connectors → Advanced',
    'Connectors',
    'Add custom connector',
    // Emphasis in the page template, not labels
    'Before you start',
    'Limits',
    'Related',
    'What happens',
    'Edge',
    // Emphasis on pages, not labels
    'Before real traffic',
    'Alerts',
    'Account mail',
  ].map((label) => label.toLowerCase()),
);

/** esbuild, as the tsx package resolves it. */
function esbuild(): { transformSync(code: string, opts: Record<string, unknown>): { code: string } } {
  const require = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
  return require('esbuild') as ReturnType<typeof esbuild>;
}

/** The static text of every string literal and template chunk in plain JavaScript. */
export function stringsIn(js: string): string[] {
  const out: string[] = [];
  let last = '';
  for (let i = 0; i < js.length; i++) {
    const c = js[i]!;
    if (c === '/' && js[i + 1] === '/') {
      i = js.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (c === '/' && js[i + 1] === '*') {
      i = js.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) {
      // A regular expression literal: skip it, quotes and all.
      let inClass = false;
      for (i++; i < js.length; i++) {
        if (js[i] === '\\') i++;
        else if (js[i] === '[') inClass = true;
        else if (js[i] === ']') inClass = false;
        else if (js[i] === '/' && !inClass) break;
      }
      last = '/';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let value = '';
      for (i++; i < js.length && js[i] !== c; i++) {
        if (js[i] === '\\') {
          const next = js[++i]!;
          if (next === 'n') value += '\n';
          else if (next === 'u' && js[i + 1] === '{') {
            const end = js.indexOf('}', i);
            value += String.fromCodePoint(parseInt(js.slice(i + 2, end), 16));
            i = end;
          } else if (next === 'u') {
            value += String.fromCharCode(parseInt(js.slice(i + 1, i + 5), 16));
            i += 4;
          } else if (next === 'x') {
            value += String.fromCharCode(parseInt(js.slice(i + 1, i + 3), 16));
            i += 2;
          } else value += next;
        } else if (c === '`' && js[i] === '$' && js[i + 1] === '{') {
          // A template's static chunks are separate texts: skip the expression.
          out.push(value);
          value = '';
          let depth = 0;
          for (i += 1; i < js.length; i++) {
            if (js[i] === '{') depth++;
            else if (js[i] === '}' && --depth === 0) break;
          }
        } else value += js[i];
      }
      out.push(value);
      last = 'x';
      continue;
    }
    if (!/\s/.test(c)) last = /[\w$]/.test(c) ? 'x' : c;
  }
  return out;
}

export const normalize = (label: string): string =>
  label
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*(?:→|->|…|\.\.\.|:)$/, '')
    .trim()
    .toLowerCase();

/** Where the interface's words are: the web app, the shared modules it imports, the schedule names the API sends. */
export const UI_TEXT_SOURCES = ['panel/web/src/**/*.{ts,tsx}', 'panel/shared/**/*.ts', 'panel/src/jobs/schedulers.ts'];

/** Every text the panel's interface holds, normalized, each also without a trailing "(…)". */
export async function panelTexts(): Promise<Set<string>> {
  const { transformSync } = esbuild();
  const files = await glob(UI_TEXT_SOURCES, { cwd: REPO_ROOT, ignore: ['**/*.test.ts'] });
  const texts = new Set<string>();
  for (const rel of files.sort()) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const { code } = transformSync(source, { loader: rel.endsWith('x') ? 'tsx' : 'ts', jsx: 'automatic', charset: 'utf8' });
    for (const value of stringsIn(code)) {
      const text = normalize(value);
      if (!text) continue;
      texts.add(text);
      // `Update all (${n})`, "Record visitor addresses (Busiest addresses, per-site)".
      const bare = normalize(text.replace(/\s*\([^)]*\)?\s*$/, ''));
      if (bare) texts.add(bare);
    }
  }
  return texts;
}

interface Label {
  text: string;
  /** `path` for a UiPath or a bold path step, `bold` for a bold label. */
  kind: 'path' | 'bold';
  /** The whole path or label it came from. */
  from: string;
}

/** A page's prose: no front matter (already gone), code, comments or imports. */
function prose(content: string): string {
  return content
    .replace(/^(```|~~~)[\s\S]*?^\1\s*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^import .*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/** Short, a capital first, no sentence punctuation, no code, and no article: "A zip in the catalog" is prose. */
const looksLikeLabel = (text: string): boolean =>
  /^["'“]?[A-Z0-9]/.test(text) &&
  !/^(A|An|The)\s/.test(text) &&
  text.split(/\s+/).length <= 6 &&
  !/[.!?;,]$/.test(text) &&
  !/[`[\]]/.test(text) &&
  !/^\d+$/.test(text);

export function labelsIn(page: Page): Label[] {
  const text = prose(page.content);
  const out: Label[] = [];
  const steps = (path: string) => path.split(/\s*(?:→|->)\s*/).map((s) => s.replace(/\*\*/g, '').trim()).filter(Boolean);
  for (const m of text.matchAll(/<UiPath\b[^>]*>([\s\S]*?)<\/UiPath>/g)) {
    const path = m[1]!.replace(/<[^>]+>/g, '').trim();
    for (const step of steps(path)) out.push({ text: step, kind: 'path', from: path });
  }
  for (const m of text.replace(/<UiPath\b[^>]*>[\s\S]*?<\/UiPath>/g, '').matchAll(/\*\*([^*\n]+?)\*\*/g)) {
    const bold = m[1]!.trim();
    if (/→|->/.test(bold)) {
      for (const step of steps(bold)) out.push({ text: step, kind: 'path', from: bold });
    } else if (looksLikeLabel(bold.replace(/\s*(?:→|…)$/, ''))) {
      out.push({ text: bold, kind: 'bold', from: bold });
    }
  }
  return out;
}

export interface UiPathReport {
  markdown: string;
  missing: { page: Page; label: Label }[];
  checked: number;
}

export async function checkUiPaths(): Promise<UiPathReport> {
  const texts = await panelTexts();
  const pages = (await listPages()).filter((p) => !p.generated);
  const missing: UiPathReport['missing'] = [];
  let checked = 0;
  for (const page of pages) {
    const seen = new Set<string>();
    for (const label of labelsIn(page)) {
      const key = normalize(label.text);
      if (seen.has(`${label.from}|${key}`)) continue;
      seen.add(`${label.from}|${key}`);
      checked++;
      if (texts.has(key) || IGNORE.has(key) || IGNORE.has(label.from.toLowerCase())) continue;
      missing.push({ page, label });
    }
  }
  const escape = (s: string) => s.replace(/\|/g, '\\|');
  const markdown =
    missing.length === 0
      ? `### UI labels\n\nAll ${checked} UI labels and path steps on ${pages.length} pages exist in the panel's own text.\n`
      : [
          '### UI labels',
          '',
          `${missing.length} of ${checked} UI labels and path steps were not found in the panel's own text (\`panel/web/src\`, \`panel/shared\`, the schedule names). ` +
            'Fix the page, or the panel if its label is wrong. Labels of other software go in IGNORE in `docs/site/scripts/check-ui-paths.ts`.',
          '',
          ...(missing.length > 10 ? [`<details><summary>The ${missing.length} labels</summary>`, ''] : []),
          '| Page | Label | In |',
          '| --- | --- | --- |',
          ...missing.map(({ page, label }) => `| [${escape(page.title)}](${page.url}) | ${escape(label.text)} | ${label.kind === 'path' ? escape(label.from) : 'bold'} |`),
          ...(missing.length > 10 ? ['', '</details>'] : []),
          '',
        ].join('\n');
  return { markdown, missing, checked };
}

if (isMain(import.meta.url)) {
  const { markdown } = await checkUiPaths();
  console.log(markdown);
}
