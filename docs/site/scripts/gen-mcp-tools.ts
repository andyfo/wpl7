/**
 * Writes integrations/mcp-tools.md: every tool the panel's MCP server offers, from the code
 * that registers them (panel/src/mcp/tools.ts). registerTools() is called once per key level
 * with a fake server that records what it is handed, so the page shows each tool's own name,
 * title, description, hints and input schema, and the lowest level that lists it. Nothing is
 * served and no tool runs.
 *
 * The change and destroy tools end their description with a sentence about the connection's
 * level; the page shows what all levels share, then those sentences.
 *
 * WP Godmode's commands are the plugin's own and are not defined in the panel. The page lists
 * what the panel defines for it: its endpoints and worked example in panel/shared/apiDocs.ts.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCESS_LABELS, accessLevels, type AccessLevel } from '../../../panel/shared/access.js';
import { API_DOC_ENDPOINTS, API_DOC_RECIPES, mcpToolGroup, type McpToolGroup } from '../../../panel/shared/apiDocs.js';
import { report, writePages } from './lib/generated.js';
import { cell, code, count, table, text } from './lib/markdown.js';
import { REPO_ROOT, isMain } from './lib/pages.js';

const SCRIPT = 'gen-mcp-tools.ts';
const FROM = ['panel/src/mcp/tools.ts', 'panel/src/mcp/call.ts', 'panel/shared/apiDocs.ts', 'panel/shared/access.ts'];

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
}

interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: { toJSONSchema(params?: { io?: 'input' | 'output' }): JsonSchema };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

interface Tool {
  name: string;
  config: ToolConfig;
  /** The description at each level that lists the tool. */
  descriptions: Map<AccessLevel, string>;
  level: AccessLevel;
}

/** Panel modules that need the server's dependency tree load at run time, outside the typecheck. */
async function panelModule<T>(rel: string): Promise<T> {
  return (await import(pathToFileURL(path.join(REPO_ROOT, rel)).href)) as T;
}

async function recordTools(): Promise<Tool[]> {
  const { registerTools } = await panelModule<{ registerTools(server: unknown, context: unknown): void }>('panel/src/mcp/tools.ts');
  const tools = new Map<string, Tool>();
  for (const access of accessLevels) {
    const server = {
      registerTool(name: string, config: ToolConfig) {
        const tool = tools.get(name) ?? { name, config, descriptions: new Map(), level: access };
        tool.descriptions.set(access, config.description ?? '');
        tools.set(name, tool);
      },
    };
    // The levels are all the registration reads; the rest of the context is for calls.
    registerTools(server, { principal: { access } });
  }
  return [...tools.values()];
}

/** What every level's description says, cut at a sentence, and the sentence each level adds. */
function splitDescription(tool: Tool): { shared: string; perLevel: [AccessLevel, string][] } {
  const texts = [...tool.descriptions.values()];
  if (new Set(texts).size === 1) return { shared: texts[0]!, perLevel: [] };
  let common = 0;
  while (texts.every((t) => t[common] === texts[0]![common])) common++;
  const cut = texts[0]!.lastIndexOf('. ', common) + 1;
  return {
    shared: texts[0]!.slice(0, cut).trim(),
    perLevel: [...tool.descriptions.entries()].map(([level, t]) => [level, t.slice(cut).trim()]),
  };
}

function typeOf(schema: JsonSchema): string {
  if (schema.enum) return `one of ${schema.enum.map((v) => code(String(v), true)).join(', ')}`;
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(' or ');
  if (schema.type === 'array') return schema.items ? `list of ${typeOf(schema.items)}s` : 'list';
  const base = Array.isArray(schema.type) ? schema.type.join(' or ') : (schema.type ?? 'any');
  // zod's .int() bounds every integer by Number.MAX_SAFE_INTEGER: no limit anyone sets.
  const min = schema.minimum !== undefined && schema.minimum > -Number.MAX_SAFE_INTEGER ? schema.minimum : undefined;
  const max = schema.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER ? schema.maximum : undefined;
  const range = min !== undefined && max !== undefined ? `, ${min} to ${max}` : min !== undefined ? `, at least ${min}` : max !== undefined ? `, at most ${max}` : '';
  return `${base}${range}`;
}

function parameters(tool: Tool): string {
  const schema = tool.config.inputSchema?.toJSONSchema({ io: 'input' });
  const props = Object.entries(schema?.properties ?? {});
  if (props.length === 0) return 'No parameters.';
  const required = new Set(schema?.required ?? []);
  return table(
    ['Parameter', 'Type', 'Required', 'What it is'],
    props.map(([name, prop]) => [
      code(name, true),
      typeOf(prop),
      required.has(name) ? 'Yes' : 'No',
      [
        prop.description ? cell(/[.!?]$/.test(prop.description) ? prop.description : `${prop.description}.`) : '',
        prop.default !== undefined ? `Default ${code(JSON.stringify(prop.default), true)}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ]),
  );
}

/** The MCP annotations an app decides on: read-only, destructive, or a change that is neither. */
function hints(config: ToolConfig): { label: string; sentence: string } {
  const a = config.annotations ?? {};
  if (a.readOnlyHint) return { label: 'Read-only', sentence: 'It tells the app it only reads.' };
  if (a.destructiveHint) return { label: 'Destructive', sentence: 'It tells the app it is destructive.' };
  return { label: 'Changes', sentence: 'It tells the app it makes changes, none of them destructive.' };
}

function toolSection(tool: Tool): string {
  const { shared, perLevel } = splitDescription(tool);
  const lines = [
    `### ${tool.name}`,
    '',
    `**${text(tool.config.title ?? tool.name)}**. Offered from **${ACCESS_LABELS[tool.level]}** up. ${hints(tool.config).sentence}`,
    '',
    text(shared),
  ];
  if (perLevel.length > 0) {
    lines.push('', 'The description ends with a sentence about the connection:', '');
    for (const [level, sentence] of perLevel) lines.push(`- ${ACCESS_LABELS[level]}: ${text(sentence)}`);
  }
  lines.push('', parameters(tool));
  return lines.join('\n');
}

async function godmode(): Promise<string> {
  const { TOOL_FOR_GROUP } = await panelModule<{ TOOL_FOR_GROUP: Record<McpToolGroup, string> }>('panel/src/mcp/call.ts');
  const endpoints = API_DOC_ENDPOINTS.filter((e) => e.path.includes('/godmode/') || e.path.endsWith('/wp/cli/help') || e.path.endsWith('/wp/cli'));
  const recipe = API_DOC_RECIPES.find((r) => r.id === 'godmode');
  const toolFor = (group: McpToolGroup | null) => (group ? TOOL_FOR_GROUP[group].split(' / ').map((t) => code(t, true)).join(' or ') : 'none');
  const lines = [
    '## WP Godmode',
    '',
    'WP Godmode is a WordPress plugin with WP-CLI commands of its own, `wp godmode …`. The panel does not define them, so they are not listed here. ' +
      "A site answers with the plugin's own guide for the version it runs, through the help endpoint below.",
    '',
    'These are the endpoints the panel has for it, and the tool that reaches each:',
    '',
    table(
      ['Endpoint', 'What it does', 'Tool', 'Level'],
      endpoints.map((e) => [code(`${e.method} ${e.path}`, true), cell(e.summary), toolFor(mcpToolGroup(e)), ACCESS_LABELS[e.level]]),
    ),
  ];
  if (recipe) {
    lines.push(
      '',
      `### ${text(recipe.title)}`,
      '',
      text(recipe.intro),
      '',
      ...recipe.steps.map((step, i) => `${i + 1}. ${code(`${step.method} ${step.path}`)}: ${text(step.comment)}`),
    );
  }
  return lines.join('\n');
}

export async function generateMcpTools(): Promise<string[]> {
  const tools = await recordTools();
  const perLevel = accessLevels.map((level) => [level, tools.filter((t) => t.descriptions.has(level)).length] as const);
  const body = [
    `The panel's MCP server reaches the whole REST API through ${count(tools.length, 'generic tool')}: reading, changing and destroying each have their own, so an app can let reads run and ask before the rest. ` +
      'A connection is offered the tools its level reaches anything through:',
    '',
    table(['Level', 'Tools offered'], perLevel.map(([level, n]) => [ACCESS_LABELS[level], String(n)])),
    '',
    'The descriptions below are the ones the server sends, word for word. An app reads them to decide which tool to call. ' +
      'Every call goes through the API, so the endpoint decides what the key level allows, as the [API reference](/docs/integrations/api-reference/) says for each.',
    '',
    '## Tools',
    '',
    table(
      ['Tool', 'Title', 'Offered from', 'Kind'],
      tools.map((t) => [code(t.name, true), cell(t.config.title ?? ''), ACCESS_LABELS[t.level], hints(t.config).label]),
    ),
    '',
    tools.map(toolSection).join('\n\n'),
    '',
    await godmode(),
    '',
    '## Related',
    '',
    '- [AI apps over MCP](/docs/integrations/mcp/)',
    '- [API reference](/docs/integrations/api-reference/)',
    '- [Protection levels and key levels](/docs/reference/security-levels/)',
    '- [The REST API](/docs/integrations/api/)',
  ].join('\n');
  const changed = writePages(SCRIPT, FROM, [
    {
      path: 'integrations/mcp-tools.md',
      title: 'MCP tools',
      description: `Every tool the panel's MCP server offers, ${count(tools.length, 'tool')} in all, and the level each needs.`,
      order: 4,
      sources: FROM,
      body,
    },
  ]);
  report(SCRIPT, changed, 1);
  return changed;
}

if (isMain(import.meta.url)) await generateMcpTools();
