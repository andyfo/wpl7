/**
 * Writes help/changelog.md from src/data/releases.json (refreshed by `npm run docs:releases`,
 * never by docs:generate): every release newest first, as `## <version>` with its date and its
 * GitHub release notes, their headings moved down to sit under the version, and a short section
 * on the edge channel.
 */
import { report, writePages } from './lib/generated.js';
import { code, text } from './lib/markdown.js';
import { isMain } from './lib/pages.js';
import { readReleases, type Release } from './refresh-releases.js';

const SCRIPT = 'gen-changelog.ts';
const SOURCE = 'docs/site/src/data/releases.json';

const version = (tag: string) => tag.replace(/^v(?=\d)/, '');

/** GitHub's Markdown, fitted under a `##` heading: headings from ### down, comments dropped. */
export function fitNotes(body: string): string {
  const lines = body
    .replace(/<!--[\s\S]*?-->/g, '')
    // A link to these docs is a link inside the site, which the links validator wants relative.
    .replace(/https:\/\/wpl7\.com\/docs\//g, '/docs/')
    .split('\n');
  let fence: string | null = null;
  const headings: number[] = [];
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && (fence === null || f.startsWith(fence))) fence = fence === null ? f : null;
    else if (fence === null && /^#{1,6}\s/.test(line)) headings.push(/^#+/.exec(line)![0].length);
  }
  const shift = headings.length > 0 ? 3 - Math.min(...headings) : 0;
  fence = null;
  const out = lines.map((line) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && (fence === null || f.startsWith(fence))) fence = fence === null ? f : null;
    else if (fence === null && /^#{1,6}\s/.test(line)) {
      const level = Math.min(6, /^#+/.exec(line)![0].length + shift);
      return line.replace(/^#+/, '#'.repeat(level));
    }
    return line;
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function releaseSection(release: Release): string {
  const date = release.publishedAt.slice(0, 10);
  const what = release.prerelease ? 'Prerelease, published' : 'Released';
  const notes = fitNotes(release.body);
  return [
    `## ${text(version(release.tag))}`,
    '',
    `${what} ${date}. [The release on GitHub](${release.url}).`,
    '',
    notes || 'This release has no notes.',
  ].join('\n');
}

export function generateChangelog(): string[] {
  const data = readReleases();
  const latest = data.latest ? version(data.latest) : null;
  const body = [
    `What changed in each release of WPL7, newest first. ${latest ? `The latest release is ${code(latest)}.` : 'No release is marked latest yet.'} ` +
      'The notes are the release notes on GitHub.',
    '',
    data.releases.length > 0 ? data.releases.map(releaseSection).join('\n\n') : 'No release has been published yet.',
    '',
    '## The edge channel',
    '',
    `The edge channel is the rolling build of ${code('main')}, published again after every merge. It has no release notes of its own: its changes reach this page with the next release. ` +
      'A page in these docs that describes something only edge has carries an Edge badge until that release.',
    '',
    'How to follow it: [Channels](/docs/panel/updating/#channels).',
    '',
    '## Related',
    '',
    '- [Updating WPL7](/docs/panel/updating/)',
    '- [Support](/docs/support/)',
  ].join('\n');
  const changed = writePages(SCRIPT, [SOURCE], [
    {
      path: 'help/changelog.md',
      title: 'Changelog',
      description: 'What changed in each release of WPL7, newest first.',
      order: 4,
      sources: [SOURCE],
      body,
    },
  ]);
  report(SCRIPT, changed, 1);
  return changed;
}

if (isMain(import.meta.url)) generateChangelog();
