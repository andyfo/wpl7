/**
 * Writes reference/configuration.md from deploy/.env.example: every variable with its example
 * value and the comment above it, in the file's own groups and order.
 *
 * How the file is read:
 * - a group header is a title line between two rules: `####…` lines, or `# ----…` lines;
 * - the comment lines right above a variable are what it does; a bare `#` starts a paragraph;
 * - a variable on the line right after another, with no comment of its own, belongs with the
 *   one before it, as the SMTP login does with SMTP_RELAYHOST;
 * - `#NAME=value` is an optional variable: commented out in the example;
 * - a blank line ends a comment that no variable followed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { report, writePages } from './lib/generated.js';
import { code, count, table, text } from './lib/markdown.js';
import { REPO_ROOT, isMain } from './lib/pages.js';

const SCRIPT = 'gen-config.ts';
const SOURCE = 'deploy/.env.example';

interface EnvVar {
  name: string;
  value: string;
  optional: boolean;
  /** Comment paragraphs, each a list of lines. */
  comment: string[][];
  /** The variable this one belongs with. */
  follows?: string;
}

interface EnvGroup {
  title: string;
  vars: EnvVar[];
}

const RULE = /^#(#{3,}|\s*[-=]{4,})\s*$/;
const VAR = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const OPTIONAL_VAR = /^#([A-Z][A-Z0-9_]*)=(.*)$/;

export function parseEnvExample(source: string): EnvGroup[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const groups: EnvGroup[] = [];
  let pending: string[][] = [];
  let previous: EnvVar | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (RULE.test(line) && RULE.test(lines[i + 2] ?? '') && /^#\s*\S/.test(lines[i + 1] ?? '')) {
      groups.push({ title: lines[i + 1]!.replace(/^#\s*/, '').trim(), vars: [] });
      pending = [];
      previous = null;
      i += 2;
      continue;
    }
    const match = VAR.exec(line) ?? OPTIONAL_VAR.exec(line);
    if (match) {
      const v: EnvVar = { name: match[1]!, value: match[2]!.trim(), optional: line.startsWith('#'), comment: pending };
      if (pending.length === 0 && previous && previous.comment.length > 0) v.follows = previous.name;
      else if (pending.length === 0 && previous?.follows) v.follows = previous.follows;
      if (groups.length === 0) groups.push({ title: 'General', vars: [] });
      groups.at(-1)!.vars.push(v);
      pending = [];
      previous = v;
      continue;
    }
    if (line.trim() === '') {
      pending = [];
      previous = null;
      continue;
    }
    if (line.startsWith('#')) {
      const body = line.replace(/^#\s?/, '');
      if (body.trim() === '') {
        if (pending.length > 0 && pending.at(-1)!.length > 0) pending.push([]);
      } else {
        if (pending.length === 0) pending.push([]);
        pending.at(-1)!.push(body);
      }
      previous = null;
    }
  }
  return groups;
}

/** Things in comment prose that are code: names, paths, files, `${VARS}`, host:port. */
const URL_RE = /https?:\/\/[^\s,)]+/;
const TOKEN_RE = new RegExp(
  [
    URL_RE.source,
    '`[^`]+`',
    '(?:(?:<\\w+>|\\*)\\.)?\\$\\{[A-Z0-9_]+\\}(?:[\\w/-]|\\.(?=[\\w/-]))*',
    '\\*\\.[a-z0-9.-]+\\.[a-z]{2,}',
    '\\[[a-z0-9.-]+\\]:\\d+',
    '(?<![\\w/.-])(?:\\.{0,2}/)?[\\w.-]+(?:/[\\w*-](?:[\\w.*-]*[\\w*-])?)+(?=[\\s,;:.)]|$)',
    '(?<![\\w/.-])\\.?[\\w-]+(?:\\.[\\w-]+)*\\.(?:sh|yml|yaml|env|md|json|conf)\\b',
    '(?<![\\w/])\\.env\\b',
    '\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\\b(?:=[^\\s,;)]+)?',
  ].join('|'),
  'g',
);

/** A path is code only when it looks like one: a dot in it, or a leading slash. */
const looksLikeCode = (token: string): boolean => !/^[\w-]+(\/[\w-]+)+$/.test(token) || token.startsWith('/');

export function prose(value: string, inTable = false): string {
  const arrows = value.replace(/ -> /g, ' → ');
  let out = '';
  let last = 0;
  for (const match of arrows.matchAll(TOKEN_RE)) {
    const token = match[0];
    const plain = arrows.slice(last, match.index);
    last = match.index + token.length;
    if (URL_RE.test(token) && token.startsWith('http')) out += text(plain, inTable) + token;
    else if (token.startsWith('`')) out += text(plain, inTable) + code(token.slice(1, -1), inTable);
    else if (looksLikeCode(token)) out += text(plain, inTable) + code(token, inTable);
    else out += text(plain + token, inTable);
  }
  return out + text(arrows.slice(last), inTable);
}

/** One paragraph: lines joined, and `term  text` lines (an aligned list in the comment) kept apart. */
function paragraph(lines: string[], inTable: boolean): string {
  const items: string[] = [];
  for (const line of lines) {
    const def = /^(\S+)\s{2,}(\S.*)$/.exec(line);
    if (def) items.push(`${code(def[1]!, inTable)}: ${def[2]!}`);
    else if (/^\s{4,}\S/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
    else if (items.length > 0 && /^\S+\s{2,}/.test(lines[0]!)) items[items.length - 1] += ` ${line.trim()}`;
    else items.push(line.trim());
  }
  const defList = lines.length > 0 && /^(\S+)\s{2,}\S/.test(lines[0]!);
  if (!defList) return prose(items.join(' '), inTable);
  return items
    .map((item) => {
      const head = /^(`[^`]+`): (.*)$/.exec(item);
      return head ? `${head[1]}: ${prose(head[2]!, inTable)}` : prose(item, inTable);
    })
    .join(inTable ? '<br>' : '\n');
}

function describe(v: EnvVar): string {
  const parts = v.comment.filter((p) => p.length > 0).map((p) => paragraph(p, true));
  if (parts.length === 0 && v.follows) parts.push(`See ${code(v.follows, true)} above.`);
  return parts.join('<br><br>');
}

/** "Recipe catalog (docs/licenses.md)" -> "Recipe catalog": the old Markdown docs are not the site. */
const heading = (title: string): string => title.replace(/\s*\(docs\/[\w.-]+\.md\)\s*$/, '');

export function generateConfig(): string[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, SOURCE), 'utf8');
  const groups = parseEnvExample(source);
  const total = groups.reduce((n, g) => n + g.vars.length, 0);
  const optional = groups.reduce((n, g) => n + g.vars.filter((v) => v.optional).length, 0);
  const sections = groups.map((group) =>
    [
      `## ${text(heading(group.title))}`,
      '',
      table(
        ['Variable', 'Example value', 'What it does'],
        group.vars.map((v) => [
          `${code(v.name, true)}${v.optional ? '<br>*optional*' : ''}`,
          v.value === '' ? '*empty*' : code(v.value, true),
          describe(v),
        ]),
      ),
    ].join('\n'),
  );
  const body = [
    "`deploy/.env` holds what the stack needs before the panel can run: the version and channel, domains and certificates, the database, the mail relay and the owner's first sign-in. " +
      'Everything else is a panel setting, changed under [Settings](/docs/panel/settings/).',
    '',
    '`provision/setup.sh` writes the file on a fresh server and never overwrites it. ' +
      'Some variables are read only once, on the panel\'s first boot, to fill in a setting. Their comments below say so.',
    '',
    `This page lists all ${count(total, 'variable')} of \`deploy/.env.example\`, in its own groups and order. ` +
      `The ${count(optional, 'variable')} marked optional are commented out in the example. Remove the \`#\` to set one.`,
    '',
    sections.join('\n\n'),
    '',
    '## Related',
    '',
    '- [Settings](/docs/panel/settings/)',
    '- [Installation](/docs/get-started/installation/)',
    '- [Installer and scripts](/docs/reference/installer-and-scripts/)',
    '- [Architecture](/docs/reference/architecture/)',
  ].join('\n');
  const changed = writePages(SCRIPT, [SOURCE], [
    {
      path: 'reference/configuration.md',
      title: 'Configuration (deploy/.env)',
      description: 'Every setting in deploy/.env, with what it does, grouped as the example file groups them.',
      order: 2,
      sources: [SOURCE],
      body,
    },
  ]);
  report(SCRIPT, changed, 1);
  return changed;
}

if (isMain(import.meta.url)) generateConfig();
