/**
 * Writes reference/limits.md: every page's Limits section, collected into one list in sidebar
 * order, each under a link to its page. Generated so it cannot fall behind: a page whose Limits
 * change needs this page written again, which the `check` job asks for.
 */
import { report, writePages } from './lib/generated.js';
import { isMain, listPages, type Page } from './lib/pages.js';

const SCRIPT = 'gen-limits.ts';
const FROM = ['the Limits section of every page'];

/** The sidebar's groups and its Support page, in its order (astro.config.mjs). */
const GROUPS: [dir: string, label: string][] = [
  ['get-started', 'Get started'],
  ['sites', 'Sites'],
  ['servers', 'Servers'],
  ['plugins', 'Plugins'],
  ['backups', 'Backups'],
  ['mail', 'Mail'],
  ['security', 'Security'],
  ['automations', 'Automations'],
  ['integrations', 'Integrations'],
  ['panel', 'Panel'],
  ['reference', 'Reference'],
  ['help', 'Help'],
  ['support', 'Support'],
];

/** The lines under `## Limits`, up to the next heading of that level or higher. */
function limitsOf(page: Page): string | null {
  const lines = page.content.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+Limits\s*$/.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body ? plain(body) : null;
}

/** MDX to plain Markdown: badges and comments dropped, a UI path kept as bold text. */
function plain(mdx: string): string {
  return mdx
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<Since\b[^>]*\/>\s*/g, '')
    .replace(/<UiPath\b[^>]*>([\s\S]*?)<\/UiPath>/g, '**$1**')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

const order = (p: Page): number => {
  const sidebar = p.frontMatter.sidebar as { order?: unknown } | undefined;
  return typeof sidebar?.order === 'number' ? sidebar.order : Number.MAX_SAFE_INTEGER;
};

export async function generateLimits(): Promise<string[]> {
  const pages = (await listPages()).filter((p) => !p.generated && p.slug !== 'reference/limits' && p.slug !== '404');
  const sections: string[] = [];
  for (const [dir, label] of GROUPS) {
    const inGroup = pages
      .filter((p) => (dir === 'get-started' ? p.group === dir || p.slug === '' : p.group === dir))
      .sort((a, b) => (a.slug === '' ? -1 : b.slug === '' ? 1 : order(a) - order(b) || a.slug.localeCompare(b.slug)));
    const entries = inGroup.flatMap((p) => {
      const limits = limitsOf(p);
      return limits ? [`### [${p.title}](/docs/${p.slug ? `${p.slug}/` : ''})\n\n${limits}`] : [];
    });
    if (entries.length) sections.push(`## ${label}\n\n${entries.join('\n\n')}`);
  }
  const body = [
    'What WPL7 does not do, does not contain or does not automate, as each page says it in its Limits section. Each heading links to the page with the details.',
    ...sections,
    '## Related',
    '- [Security in WPL7](/docs/security/overview/)',
    '- [Troubleshooting](/docs/help/troubleshooting/)',
    '- [FAQ](/docs/help/faq/)',
  ].join('\n\n');
  const changed = writePages(SCRIPT, FROM, [
    {
      path: 'reference/limits.md',
      title: 'Known limits',
      description: 'Everything WPL7 does not do, does not contain or does not automate, in one list.',
      order: 8,
      sources: ['docs/site/src/content/docs/**/*.mdx'],
      body,
    },
  ]);
  report(SCRIPT, changed, 1);
  return changed;
}

if (isMain(import.meta.url)) await generateLimits();
