/**
 * Writes reference/job-types.md: every job type with its label, description and category
 * (panel/shared/jobTypes.ts), the lane it runs in and what starts it.
 *
 * Lanes and starters are in no table: they are decided where a job is queued. So this reads
 * every `worker.enqueue(...)` call in panel/src, as far as the code says:
 * - the lane, from the call's options: a named lane (`exec:<server>`, `housekeeping`, …), a
 *   server lane, both servers of a move, or the shared queue of jobs with no server;
 * - what starts it, by following the call up to three steps: an API route, a built-in schedule
 *   (panel/src/jobs/schedulers.ts), another job's handler (panel/src/jobs/registry.ts), or the
 *   function or service method around it and whoever calls that. Custom schedules come from
 *   SCHEDULE_ACTION_INFO in panel/shared/scheduleActions.ts, which names the job each queues.
 * A starter the reading cannot place is "the panel itself".
 *
 * It is a reading of source text, not a compiler: a refactor can change what it finds, and the
 * `check` job then asks for the page to be regenerated, which is the point.
 */
import fs from 'node:fs';
import path from 'node:path';
import { endpointFor } from '../../../panel/shared/apiDocs.js';
import { JOB_CATEGORY_LABELS, JOB_TYPE_INFO, type JobTypeInfo } from '../../../panel/shared/jobTypes.js';
import { SCHEDULE_ACTION_INFO } from '../../../panel/shared/scheduleActions.js';
import { report, writePages } from './lib/generated.js';
import { cell, code, count, table, text } from './lib/markdown.js';
import { REPO_ROOT, isMain, toPosix } from './lib/pages.js';

const SCRIPT = 'gen-job-types.ts';
const FROM = [
  'panel/shared/jobTypes.ts',
  'panel/shared/scheduleActions.ts',
  'panel/src/jobs/registry.ts',
  'panel/src/jobs/schedulers.ts',
  'panel/src/jobs/lanes.ts',
  'the enqueue calls in panel/src',
];
const SOURCES = FROM.filter((f) => f.startsWith('panel/'));

interface SourceFile {
  rel: string;
  text: string;
  /** Character ranges of import statements, where a name is not a use. */
  imports: [number, number][];
}

function loadSources(): SourceFile[] {
  const root = path.join(REPO_ROOT, 'panel/src');
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'migrations') walk(abs);
      } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        const text = fs.readFileSync(abs, 'utf8');
        const imports = [...text.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?/gm)].map((m) => [m.index, m.index + m[0].length] as [number, number]);
        out.push({ rel: toPosix(path.relative(REPO_ROOT, abs)), text, imports });
      }
    }
  };
  walk(root);
  return out;
}

// ------------------------------------------------------------------ reading calls

/** The index just past the `)` that closes the `(` at `open`, skipping strings, templates and comments. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
    else if (c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i + 2) + 1;
    else if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Top-level arguments of a call whose text is `(...)`. */
function splitArgs(callText: string): string[] {
  const inner = callText.slice(1, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < inner.length && inner[i] !== c; i++) if (inner[i] === '\\') i++;
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (inner.slice(start).trim() !== '') args.push(inner.slice(start).trim());
  return args;
}

interface Call {
  file: SourceFile;
  at: number;
  args: string[];
}

function enqueueCalls(files: SourceFile[]): Call[] {
  const calls: Call[] = [];
  for (const file of files) {
    for (const match of file.text.matchAll(/\.enqueue\(/g)) {
      const open = match.index + match[0].length - 1;
      calls.push({ file, at: match.index, args: splitArgs(file.text.slice(open, closeParen(file.text, open))) });
    }
  }
  return calls;
}

const KNOWN_TYPES = new Set(Object.keys(JOB_TYPE_INFO));
const literalsIn = (expr: string): string[] => [...expr.matchAll(/'([\w.]+)'/g)].map((m) => m[1]!).filter((t) => KNOWN_TYPES.has(t));

/** The job types a call queues: a literal, a `const` it was set from, or the `case` labels above it. */
function typesOf(call: Call): string[] {
  const first = call.args[0] ?? '';
  const literal = /^'([\w.]+)'$/.exec(first);
  if (literal) return KNOWN_TYPES.has(literal[1]!) ? [literal[1]!] : [];
  const name = /^([A-Za-z_$][\w$]*)/.exec(first)?.[1];
  if (!name) return [];
  const before = call.file.text.slice(0, call.at);
  const decl = [...before.matchAll(new RegExp(`const ${name}\\s*=([^;]+);`, 'g'))].at(-1);
  if (decl) return literalsIn(decl[1]!);
  const cases = /((?:\s*case '[\w.]+':)+)\s*return[^;]*$/.exec(before);
  return cases ? literalsIn(cases[1]!) : [];
}

/** A `const NAME = …` initializer anywhere in panel/src. */
function constInit(files: SourceFile[], name: string, prefer?: SourceFile): string | null {
  for (const file of prefer ? [prefer, ...files] : files) {
    const match = new RegExp(`(?:export\\s+)?const ${name}\\s*=\\s*([^;]+);`).exec(file.text);
    if (match) return match[1]!.trim();
  }
  return null;
}

type Lane = { kind: 'named'; name: string; perServer: boolean } | { kind: 'server' } | { kind: 'both' } | { kind: 'shared' };

/** `cond ? a : b` at the top level of an expression, as its two branches. */
function ternary(expr: string): [string, string] | null {
  let depth = 0;
  let q = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < expr.length && expr[i] !== c; i++) if (expr[i] === '\\') i++;
    } else if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if (depth === 0 && c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?') q = q === -1 ? i : q;
    else if (depth === 0 && c === ':' && q !== -1) return [expr.slice(q + 1, i).trim(), expr.slice(i + 1).trim()];
  }
  return null;
}

function lanesOf(call: Call, files: SourceFile[]): Lane[] {
  let opts = call.args[3] ?? '';
  if (/^[A-Za-z_$][\w$]*$/.test(opts)) opts = constInit([], opts, call.file) ?? opts;
  const branches = ternary(opts);
  if (branches) return branches.flatMap((b) => lanesOf({ ...call, args: [...call.args.slice(0, 3), b] }, files));
  return [laneOf(call, opts, files)];
}

function laneOf(call: Call, opts: string, files: SourceFile[]): Lane {
  const lane = /\blane:\s*([^,}\n]+)/.exec(opts)?.[1]?.trim();
  if (lane) {
    const literal = /^'([^']+)'$/.exec(lane);
    if (literal) return { kind: 'named', name: literal[1]!, perServer: false };
    const fn = /^(\w+)\(/.exec(lane)?.[1];
    if (fn) {
      const init = constInit(files, fn) ?? '';
      const prefix = /`([\w-]+):\$\{/.exec(init)?.[1];
      if (prefix) return { kind: 'named', name: prefix, perServer: true };
    }
    const value = /^'([^']+)'$/.exec(constInit(files, lane) ?? '')?.[1];
    if (value) return { kind: 'named', name: value, perServer: false };
    return { kind: 'named', name: lane, perServer: false };
  }
  if (/\bauxServerId\b/.test(opts)) return { kind: 'both' };
  const site = call.args[2] ?? '';
  if (/\bserverId\b/.test(opts) || (site !== '' && site !== 'undefined')) return { kind: 'server' };
  return { kind: 'shared' };
}

function laneText(lane: Lane): string {
  switch (lane.kind) {
    case 'named':
      return lane.perServer ? `${code(lane.name, true)}, one per server` : code(lane.name, true);
    case 'server':
      return 'Server';
    case 'both':
      return 'Both servers';
    case 'shared':
      return 'Shared queue';
  }
}

/** Server lanes first, then both, then named lanes, then the shared queue. */
const laneRank = (lane: string): number => (lane === 'Server' ? 0 : lane === 'Both servers' ? 1 : lane === 'Shared queue' ? 3 : 2);

// ------------------------------------------------------------------ what starts a job

type Starter = { kind: 'api' | 'schedule' | 'job' | 'panel'; text: string };
const PANEL: Starter = { kind: 'panel', text: 'The panel itself' };

/** handler function name -> job type, from the registry. */
function handlerTypes(files: SourceFile[]): Map<string, string> {
  const registry = files.find((f) => f.rel === 'panel/src/jobs/registry.ts')!;
  return new Map([...registry.text.matchAll(/'([\w.]+)':\s*entry\(\s*\w+,\s*(\w+)/g)].map((m) => [m[2]!, m[1]!]));
}

const lastMatch = (re: RegExp, text: string): RegExpExecArray | null => {
  let found: RegExpExecArray | null = null;
  for (const m of text.matchAll(re)) found = m as RegExpExecArray;
  return found;
};

/** The class method around `at`, written at two spaces of indentation. */
function methodAt(file: SourceFile, at: number): string | null {
  const before = file.text.slice(0, at);
  const classStart = lastMatch(/^(?:export\s+)?class\s+\w+/gm, before);
  const fnStart = lastMatch(/^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?const\s+\w+\s*[=:]/gm, before);
  if (!classStart || (fnStart && fnStart.index > classStart.index)) return null;
  const method = lastMatch(/^ {2}(?:(?:private|public|protected|static|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/gm, before);
  return method && method.index > classStart.index ? method[1]! : null;
}

/** The top-level function or const around `at`. */
function topLevelAt(file: SourceFile, at: number): string | null {
  const m = lastMatch(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[=:]/gm, file.text.slice(0, at));
  return m ? (m[1] ?? m[2])! : null;
}

function routeStarters(file: SourceFile, at: number, type?: string): Starter[] {
  const before = file.text.slice(0, at);
  const route = lastMatch(/\b(?:r|app)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g, before);
  if (!route) return [];
  const method = route[1]!.toUpperCase();
  let paths = [route[3]!];
  const loopVar = /\$\{(\w+)\}/.exec(route[3]!)?.[1];
  if (loopVar) {
    const loop = lastMatch(new RegExp(`for \\(const ${loopVar} of \\[([^\\]]+)\\]`, 'g'), before.slice(0, route.index));
    const values = loop ? [...loop[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : [];
    // One handler for several job types (start, stop, restart): the route whose value names the type.
    const own = values.filter((v) => type?.split('.').pop() === v);
    if (values.length > 0) paths = (own.length > 0 ? own : values).map((v) => route[3]!.replace(`\${${loopVar}}`, v));
  }
  return paths.map((p) => ({ kind: 'api', text: `${method} ${endpointFor(method, p)?.path ?? p}` }));
}

/** A built-in schedule's name, for a point inside panel/src/jobs/schedulers.ts. */
function scheduleStarter(file: SourceFile, at: number, depth = 0): Starter[] {
  const method = methodAt(file, at);
  if (!method) return [];
  if (method === 'defineTasks') {
    const name = lastMatch(/\bname:\s*'([^']+)'/g, file.text.slice(0, at));
    return name ? [{ kind: 'schedule', text: name[1]! }] : [];
  }
  if (depth > 2) return [];
  const out: Starter[] = [];
  for (const use of file.text.matchAll(new RegExp(`this\\.${method}\\(`, 'g'))) out.push(...scheduleStarter(file, use.index, depth + 1));
  return out;
}

function startersAt(
  files: SourceFile[],
  handlers: Map<string, string>,
  file: SourceFile,
  at: number,
  depth: number,
  seen: Set<string>,
  type?: string,
): Starter[] {
  const rel = file.rel;
  if (rel.startsWith('panel/src/routes/')) return routeStarters(file, at, type);
  if (rel === 'panel/src/jobs/actions.ts') return []; // custom schedules: SCHEDULE_ACTION_INFO
  if (rel === 'panel/src/jobs/schedulers.ts') return scheduleStarter(file, at);
  const method = methodAt(file, at);
  const name = method ?? topLevelAt(file, at);
  if (!name) return [];
  if (!method && handlers.has(name)) {
    const info = (JOB_TYPE_INFO as Record<string, JobTypeInfo>)[handlers.get(name)!];
    return info ? [{ kind: 'job', text: info.label }] : [];
  }
  const key = `${rel}#${name}`;
  if (seen.has(key) || depth >= 3) return [];
  seen.add(key);
  const uses: { file: SourceFile; at: number }[] = [];
  const add = (f: SourceFile, re: RegExp) => {
    for (const m of f.text.matchAll(re)) {
      if (f.imports.some(([a, b]) => m.index >= a && m.index < b)) continue;
      if (f === file && !method && new RegExp(`(?:function|const)\\s+${name}\\b`).test(f.text.slice(Math.max(0, m.index - 20), m.index + name.length + 1))) continue;
      uses.push({ file: f, at: m.index });
    }
  };
  if (method) {
    const service = path.basename(rel, '.ts');
    for (const f of files) add(f, new RegExp(`\\.${service}\\.${method}\\(`, 'g'));
    // A service registered under another name (deps.system for systemUpdate.ts): a long method name is distinctive enough.
    if (uses.length === 0 && method.length >= 10) for (const f of files) if (f !== file) add(f, new RegExp(`\\.${method}\\(`, 'g'));
    add(file, new RegExp(`this\\.${method}\\(`, 'g'));
  } else {
    for (const f of files) add(f, new RegExp(`\\b${name}\\b`, 'g'));
  }
  // A use that leads nowhere further is the panel acting on its own: at boot, after an update.
  return uses.flatMap((u) => {
    const found = startersAt(files, handlers, u.file, u.at, depth + 1, seen, type);
    return found.length > 0 || u.file.rel === 'panel/src/jobs/actions.ts' ? found : [PANEL];
  });
}

function starterText(starters: Starter[], custom: string[]): string {
  const by = (kind: Starter['kind']) => [...new Set(starters.filter((s) => s.kind === kind).map((s) => s.text))].sort();
  const lines: string[] = [];
  const api = by('api');
  if (api.length > 0) lines.push(`API: ${api.map((t) => code(t, true)).join(', ')}`);
  const schedules = by('schedule');
  if (schedules.length > 0) lines.push(`Built-in schedule: ${schedules.map((t) => cell(t)).join(', ')}`);
  if (custom.length > 0) lines.push(`Custom schedule: ${custom.map((t) => cell(t)).join(', ')}`);
  const jobs = by('job');
  if (jobs.length > 0) lines.push(`Another job: ${jobs.map((t) => cell(t)).join(', ')}`);
  if (lines.length === 0 || starters.some((s) => s.kind === 'panel')) lines.push(PANEL.text);
  return lines.join('<br>');
}

// ------------------------------------------------------------------ the page

export function generateJobTypes(): string[] {
  const files = loadSources();
  const handlers = handlerTypes(files);
  const calls = enqueueCalls(files);
  const lanes = new Map<string, Set<string>>();
  const starters = new Map<string, Starter[]>();
  for (const call of calls) {
    for (const type of typesOf(call)) {
      const set = lanes.get(type) ?? new Set<string>();
      for (const lane of lanesOf(call, files)) set.add(laneText(lane));
      lanes.set(type, set);
      const list = starters.get(type) ?? [];
      const found = startersAt(files, handlers, call.file, call.at, 0, new Set(), typesOf(call).length > 1 ? type : undefined);
      list.push(...(found.length > 0 || call.file.rel === 'panel/src/jobs/actions.ts' ? found : [PANEL]));
      starters.set(type, list);
    }
  }
  const custom = new Map<string, string[]>();
  for (const info of Object.values(SCHEDULE_ACTION_INFO)) custom.set(info.jobType, [...(custom.get(info.jobType) ?? []), info.label]);

  const types = (Object.entries(JOB_TYPE_INFO) as [string, JobTypeInfo][]).filter(([, info]) => !info.internal);
  const categories = Object.keys(JOB_CATEGORY_LABELS) as (keyof typeof JOB_CATEGORY_LABELS)[];
  const sections = categories
    .map((category) => {
      const rows = types.filter(([, info]) => info.category === category);
      if (rows.length === 0) return null;
      return [
        `## ${text(JOB_CATEGORY_LABELS[category])}`,
        '',
        table(
          ['Job', 'What it does', 'Lane', 'Started by'],
          rows.map(([type, info]) => [
            `**${cell(info.label)}**<br>${code(type, true)}`,
            cell(info.description),
            [...(lanes.get(type) ?? new Set(['Not found']))].sort((a, b) => laneRank(a) - laneRank(b) || a.localeCompare(b)).join('<br>'),
            starterText(starters.get(type) ?? [], custom.get(type) ?? []),
          ]),
        ),
      ].join('\n');
    })
    .filter((s): s is string => s !== null);

  const body = [
    `Every kind of job the panel runs, ${count(types.length, 'type')} in all, grouped as the filters on **Automations → All jobs** group them. ` +
      'The id under each name is what the API and the job log use.',
    '',
    '## How lanes work',
    '',
    'A lane decides what a job waits for. Jobs in one lane run one at a time, and jobs in different lanes run side by side.',
    '',
    table(
      ['Lane', 'What waits for what'],
      [
        ['Server', "One job at a time per server: the site's server, or the server the job works on."],
        ['Both servers', 'A move holds the lanes of both servers it works on.'],
        ['Shared queue', 'Jobs that belong to no server run one at a time among themselves.'],
        ['A named lane', 'Jobs in a named lane run one at a time within it, beside the server lanes. A lane marked one per server has a lane for each server.'],
      ],
    ),
    '',
    'The lanes and starters below are read from the places in the code that queue each job. Every job a person starts in the panel goes through the same API.',
    '',
    sections.join('\n\n'),
    '',
    '## Related',
    '',
    '- [Jobs](/docs/automations/jobs/)',
    '- [Schedules](/docs/automations/schedules/)',
    '- [Your own scheduled jobs](/docs/automations/custom-jobs/)',
    '- [API reference](/docs/integrations/api-reference/)',
  ].join('\n');

  const changed = writePages(SCRIPT, FROM, [
    {
      path: 'reference/job-types.md',
      title: 'Job types',
      description: 'Every kind of job the panel runs, its lane, and what starts it.',
      order: 4,
      sources: SOURCES,
      body,
    },
  ]);
  report(SCRIPT, changed, 1);
  return changed;
}

if (isMain(import.meta.url)) generateJobTypes();
