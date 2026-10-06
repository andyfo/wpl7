/**
 * npm run docs:check-flags
 *
 * Every flag install.sh and provision/setup.sh accept must appear on the Installer and scripts
 * page. A flag is what a script's own argument parser takes: the `--name)` and `--name=*)`
 * patterns of its `case`. That leaves out the flags it hands to other programs (`docker
 * --format`, `systemctl --now`); a script without such a `case` has every `--flag` in it checked.
 *
 * Prints a Markdown report and always exits 0: it warns, in the docs-sync comment too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, isMain, listPages } from './lib/pages.js';

export const FLAG_SCRIPTS = ['install.sh', 'provision/setup.sh'];
const PAGE_SLUG = 'reference/installer-and-scripts';

/** The flags a script's argument parser accepts, sorted. */
export function scriptFlags(source: string): string[] {
  const flags = new Set<string>();
  for (const line of source.split('\n')) {
    const pattern = /^\s*((?:-{1,2}[\w-]+(?:=\*)?\|)*-{1,2}[\w-]+(?:=\*)?)\)/.exec(line)?.[1];
    if (!pattern) continue;
    for (const alt of pattern.split('|')) if (alt.startsWith('--')) flags.add(alt.replace(/=\*$/, ''));
  }
  if (flags.size === 0) for (const m of source.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) flags.add(m[0]);
  return [...flags].sort();
}

export interface FlagReport {
  markdown: string;
  missing: { script: string; flag: string }[];
}

export async function checkFlags(): Promise<FlagReport> {
  const page = (await listPages()).find((p) => p.slug === PAGE_SLUG);
  const title = page ? `[${page.title}](${page.url})` : `\`${PAGE_SLUG}\``;
  if (!page) {
    return { markdown: `### Flags\n\nThe page ${title} does not exist, so no flag is documented.\n`, missing: [] };
  }
  const missing: FlagReport['missing'] = [];
  let total = 0;
  for (const script of FLAG_SCRIPTS) {
    const flags = scriptFlags(fs.readFileSync(path.join(REPO_ROOT, script), 'utf8'));
    total += flags.length;
    for (const flag of flags) {
      const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(page.content)) missing.push({ script, flag });
    }
  }
  const scripts = FLAG_SCRIPTS.map((s) => `\`${s}\``).join(' and ');
  const markdown =
    missing.length === 0
      ? `### Flags\n\nAll ${total} flags of ${scripts} are on ${title}.\n`
      : [
          '### Flags',
          '',
          `${missing.length} of the ${total} flags of ${scripts} are not on ${title} (\`${page.file}\`):`,
          '',
          '| Script | Flag |',
          '| --- | --- |',
          ...missing.map((m) => `| \`${m.script}\` | \`${m.flag}\` |`),
          '',
        ].join('\n');
  return { markdown, missing };
}

if (isMain(import.meta.url)) {
  const { markdown } = await checkFlags();
  console.log(markdown);
}
