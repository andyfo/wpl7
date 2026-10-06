/**
 * After a CI shoot: keeps every committed screenshot whose new capture differs in at most 0.1 %
 * of its pixels, so rendering noise never churns a file, and reports what was added, changed and
 * removed. `--before` is a copy of screens/ taken before the shoot cleared it.
 *
 *   tsx scripts/compare-shots.ts --before <dir> [--report <file.md>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const MAX_CHANGED_SHARE = 0.001;

const { values } = parseArgs({ options: { before: { type: 'string' }, report: { type: 'string' } } });
if (!values.before) throw new Error('--before <dir> is required');

const screens = path.resolve(import.meta.dirname, '../screens');
const before = path.resolve(values.before);

const list = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.png')) out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
};

const read = (file: string) => PNG.sync.read(fs.readFileSync(file));

const added: string[] = [];
const changed: { file: string; share: number }[] = [];
const kept: string[] = [];
for (const rel of list(screens)) {
  const oldFile = path.join(before, rel);
  if (!fs.existsSync(oldFile)) {
    added.push(rel);
    continue;
  }
  const a = read(oldFile);
  const b = read(path.join(screens, rel));
  if (a.width !== b.width || a.height !== b.height) {
    changed.push({ file: rel, share: 1 });
    continue;
  }
  const differing = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
  const share = differing / (a.width * a.height);
  if (share <= MAX_CHANGED_SHARE) {
    fs.copyFileSync(oldFile, path.join(screens, rel));
    kept.push(rel);
  } else {
    changed.push({ file: rel, share });
  }
}
const now = new Set(list(screens));
const removed = list(before).filter((rel) => !now.has(rel));

const lines = ['### Docs screenshots', ''];
if (added.length + changed.length + removed.length === 0) {
  lines.push(`No visible change: all ${kept.length} screenshots kept as they are.`);
} else {
  for (const f of added) lines.push(`- added \`${f}\``);
  for (const c of changed) lines.push(`- changed \`${c.file}\` (${(c.share * 100).toFixed(2)} % of pixels)`);
  for (const f of removed) lines.push(`- removed \`${f}\``);
  lines.push('', `${kept.length} kept as they are.`);
}
const report = `${lines.join('\n')}\n`;
process.stdout.write(report);
if (values.report) fs.writeFileSync(values.report, report);
