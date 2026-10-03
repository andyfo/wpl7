/**
 * Write src/services/aiRanges.ts: the AI companies' published address lists as they are
 * today - the copy an install that has never fetched them uses. They are fetched, checked and
 * merged by the panel's own refresh, so the copy shipped passed exactly what a download must.
 *
 *   npx tsx scripts/ai-ranges.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { AI_SOURCES, ProxyRangesService, RANGE_SOURCES } from '../src/services/proxyRanges.js';
import type { SettingsService } from '../src/services/settings.js';

const store = new Map<string, unknown>();
const settings = { getRaw: (key: string) => store.get(key), setRaw: (key: string, value: unknown) => void store.set(key, value), get: () => undefined };
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const service = new ProxyRangesService(settings as unknown as SettingsService, quiet);
const { failed } = await service.refresh();
const missing = AI_SOURCES.filter((source) => failed.includes(source));
if (missing.length > 0) {
  const errors = service.status().filter((s) => missing.includes(s.source as (typeof AI_SOURCES)[number]));
  for (const s of errors) console.error(`${s.label}: ${s.error}`);
  process.exit(1);
}

/** Quoted ranges, as many to a line as fit in about 120 characters. */
function lines(ranges: string[]): string[] {
  const out: string[] = [];
  let line = '';
  for (const range of ranges) {
    const item = `'${range}',`;
    if (line && line.length + 1 + item.length > 116) {
      out.push(`    ${line}`);
      line = item;
    } else {
      line = line ? `${line} ${item}` : item;
    }
  }
  if (line) out.push(`    ${line}`);
  return out;
}

const today = new Date().toISOString().slice(0, 10);
const text = [
  '/**',
  ` * The AI companies' published address lists as they were on ${today}, checked and merged as a`,
  " * download is: what an install that has never fetched them uses (services/proxyRanges.ts, which",
  ' * names the lists). Written by `npx tsx scripts/ai-ranges.ts` - not by hand.',
  ' */',
  "import type { AiSource } from './proxyRanges.js';",
  '',
  'export const AI_BUILTIN: Record<AiSource, string[]> = {',
  ...AI_SOURCES.flatMap((source) => [`  // ${RANGE_SOURCES[source].label}`, `  ${source}: [`, ...lines(service.ranges(source)), '  ],']),
  '};',
  '',
].join('\n');
const target = path.join(import.meta.dirname, '..', 'src', 'services', 'aiRanges.ts');
fs.writeFileSync(target, text);
for (const source of AI_SOURCES) console.log(`${RANGE_SOURCES[source].label}: ${service.ranges(source).length} ranges`);
