/**
 * Writes the API reference (integrations/api-reference/) from the panel's API catalog,
 * panel/shared/apiDocs.ts: an overview with the error codes and the worked examples, and one
 * page per group with a block for every endpoint. The catalog is what the panel's own Docs tab
 * shows, and test/unit/apiDocs.test.ts holds it to the routes, so these pages list exactly what
 * the API answers.
 *
 * The folder sits second in Integrations, after the REST API page (order 1) and before AI apps
 * over MCP (3). Starlight orders a folder by its lowest page order, so the overview takes 2 and
 * the groups 2.01, 2.02, … in catalog order.
 */
import { ACCESS_LABELS } from '../../../panel/shared/access.js';
import {
  API_DOC_GROUPS,
  API_DOC_RECIPES,
  API_ERROR_CODES,
  mcpToolGroup,
  type ApiDocEndpoint,
  type ApiDocGroup,
} from '../../../panel/shared/apiDocs.js';
import { report, writePages, type GeneratedPage } from './lib/generated.js';
import { cell, code, count, table, text } from './lib/markdown.js';
import { isMain } from './lib/pages.js';

const SCRIPT = 'gen-api.ts';
const FROM = ['panel/shared/apiDocs.ts', 'panel/shared/access.ts'];
const DIR = 'integrations/api-reference';
const BASE = `/docs/${DIR}/`;

const plain = (value: string) => value.replace(/`/g, '');

/** The catalog writes summaries without a full stop; on the page they are sentences. */
const sentence = (value: string) => (/[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`);

/** The notes a summary carries, in the words the overview explains. */
function notes(endpoint: ApiDocEndpoint): string[] {
  const out: string[] = [];
  if (endpoint.job) out.push('Job');
  if (endpoint.danger) out.push('Destructive');
  const tool = mcpToolGroup(endpoint);
  if (tool === null) out.push('Not over MCP');
  if (tool === 'file') out.push('MCP file tools only');
  return out;
}

/**
 * One endpoint as a block: the method and path as a heading (so the page's table of contents
 * lists every endpoint), the summary, then the level, the notes, the input and the result. A
 * table would need six columns, more than the page is wide.
 */
function endpointBlock(endpoint: ApiDocEndpoint): string {
  const marks = notes(endpoint);
  const level = endpoint.open ? 'No key' : ACCESS_LABELS[endpoint.level];
  const lines = [`### ${code(`${endpoint.method} ${endpoint.path}`)}`, '', text(sentence(endpoint.summary))];
  if (endpoint.note) lines.push('', text(sentence(endpoint.note)));
  lines.push('');
  lines.push(`- **Level:** ${level}${endpoint.levelReason && !endpoint.open ? `. ${text(endpoint.levelReason)}` : ''}`);
  if (marks.length > 0) lines.push(`- **Notes:** ${marks.join(' · ')}`);
  if (endpoint.input) lines.push(`- **Input:** ${code(endpoint.input)}`);
  if (endpoint.returns) lines.push(`- **Returns:** ${code(endpoint.returns)}`);
  return lines.join('\n');
}

const RELATED = [
  '## Related',
  '',
  `- [API reference](${BASE})`,
  '- [The REST API](/docs/integrations/api/)',
  '- [MCP tools](/docs/integrations/mcp-tools/)',
  '- [Protection levels and key levels](/docs/reference/security-levels/)',
].join('\n');

function groupPage(group: ApiDocGroup, index: number): GeneratedPage {
  const changes = ACCESS_LABELS[group.changes];
  const body = [
    text(group.intro),
    '',
    `Reading needs **${ACCESS_LABELS.read}** and changes need **${changes}**, unless an endpoint says otherwise. ` +
      `[How to read this page](${BASE}#how-to-read-a-group-page).`,
    '',
    group.endpoints.map(endpointBlock).join('\n\n'),
    '',
    RELATED,
  ].join('\n');
  return {
    path: `${DIR}/${group.id}.md`,
    title: group.title,
    description: plain(group.intro),
    order: (201 + index) / 100,
    sources: ['panel/shared/apiDocs.ts'],
    body,
  };
}

function overview(): GeneratedPage {
  const endpoints = API_DOC_GROUPS.flatMap((g) => g.endpoints);
  const groups = table(
    ['Group', 'Endpoints', 'What it covers'],
    API_DOC_GROUPS.map((g) => [`[${text(g.title, true)}](${BASE}${g.id}/)`, String(g.endpoints.length), cell(g.intro)]),
  );
  const errors = table(
    ['Code', 'Status', 'What it means'],
    API_ERROR_CODES.map((e) => [code(e.code, true), e.status, cell(e.meaning)]),
  );
  const recipes = API_DOC_RECIPES.map((recipe) =>
    [
      `### ${text(recipe.title)}`,
      '',
      text(recipe.intro),
      '',
      ...recipe.steps.map((step, i) => `${i + 1}. ${code(`${step.method} ${step.path}`)}: ${text(step.comment)}`),
    ].join('\n'),
  );
  const body = [
    `Every endpoint of the panel's REST API: ${count(endpoints.length, 'endpoint')} in ${count(API_DOC_GROUPS.length, 'group')}, one page per group. ` +
      'The pages come from the catalog the panel shows under **Integrations → API keys → Docs**. ' +
      "The panel's tests hold that catalog to its routes, so a page lists exactly what the API answers.",
    '',
    'For keys, authentication and the conventions every endpoint follows, read [The REST API](/docs/integrations/api/).',
    '',
    '## How to read a group page',
    '',
    'Every endpoint has its method and path as a heading, then one line on what it does, then:',
    '',
    table(
      ['Field', 'What it holds'],
      [
        ['Level', 'The API key level the endpoint needs. No key: it answers without one.'],
        ['Notes', 'Job, Destructive, Not over MCP or MCP file tools only, as below.'],
        ['Input', `The JSON body, or the query string when it starts with ${code('?')}. A field followed by ${code('?')} may be left out.`],
        ['Returns', 'What a successful answer holds.'],
      ],
    ),
    '',
    `Fill in ${code(':slug')}, ${code(':id')} and the other parts of a path that start with a colon. The notes:`,
    '',
    table(
      ['Note', 'What it means'],
      [
        ['Job', `The answer is ${code('202')} with a job, and a ${code('Location: /api/jobs/<id>', true)} header. Poll the job for the outcome.`],
        ['Destructive', `It removes or overwrites something. Over MCP it goes through ${code('wpl7_api_dangerous')}.`],
        ['Not over MCP', 'No MCP tool reaches it.'],
        ['MCP file tools only', `Over MCP only ${code('wpl7_read_site_file')} and ${code('wpl7_write_site_file')} reach it.`],
      ],
    ),
    '',
    '## Groups',
    '',
    groups,
    '',
    '## Error codes',
    '',
    `Every answer that is not 2xx carries ${code('{"error": {"code", "message", "details"}}', true)}. The code says what to do:`,
    '',
    errors,
    '',
    '## Worked examples',
    '',
    'Each example runs as it stands in the test console under **Integrations → API keys → Docs**, which fills in the request bodies.',
    '',
    recipes.join('\n\n'),
    '',
    '## Related',
    '',
    '- [The REST API](/docs/integrations/api/)',
    '- [MCP tools](/docs/integrations/mcp-tools/)',
    '- [Protection levels and key levels](/docs/reference/security-levels/)',
    '- [Jobs](/docs/automations/jobs/)',
  ].join('\n');
  return {
    path: `${DIR}/index.md`,
    title: 'API reference',
    description: 'Every endpoint of the REST API with its method, path, input, result and the key level it needs.',
    order: 2,
    label: 'Overview',
    sources: FROM,
    body,
  };
}

export function generateApi(): string[] {
  if (API_DOC_GROUPS.length > 98) throw new Error('gen-api.ts: more than 98 groups no longer fit between orders 2 and 3');
  const pages = [overview(), ...API_DOC_GROUPS.map(groupPage)];
  const changed = writePages(SCRIPT, FROM, pages, { ownDir: DIR });
  report(SCRIPT, changed, pages.length);
  return changed;
}

if (isMain(import.meta.url)) generateApi();
