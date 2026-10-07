/**
 * Runs before every build and dev server (npm run build / dev):
 *
 * - copies the panel's favicon and touch icon into public/, so the docs wear the panel's own
 *   files rather than copies that could drift;
 * - copies screens/*.png into public/screens/ and writes a WebP twin of each, which the
 *   <Screenshot> component offers first. The committed PNGs stay the source of truth.
 *   DOCS_SCREENS=.screens-local takes a local capture's folder instead, to preview it.
 *
 * Both outputs are ignored by git.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const site = path.resolve(import.meta.dirname, '..');
const panelPublic = path.resolve(site, '../../panel/web/public');
const publicDir = path.join(site, 'public');

// Nothing in public/ is committed, so a fresh checkout has no such folder.
fs.mkdirSync(publicDir, { recursive: true });
for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
  fs.copyFileSync(path.join(panelPublic, file), path.join(publicDir, file));
}

const screens = path.resolve(site, process.env.DOCS_SCREENS ?? 'screens');
const out = path.join(publicDir, 'screens');
// Start clean: a shot that no longer exists must not linger in public/.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const pngs: string[] = [];
const walk = (dir: string, rel = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
    else if (entry.name.endsWith('.png')) pngs.push(relPath);
  }
};
if (fs.existsSync(screens)) walk(screens);

let written = 0;
for (const rel of pngs) {
  const from = path.join(screens, rel);
  const png = path.join(out, rel);
  const webp = png.replace(/\.png$/, '.webp');
  fs.mkdirSync(path.dirname(png), { recursive: true });
  const fresh = (target: string) => fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(from).mtimeMs;
  if (!fresh(png)) fs.copyFileSync(from, png);
  if (!fresh(webp)) {
    // Lossless keeps text crisp; effort 6 is slow but this runs once per changed shot.
    await sharp(from).webp({ lossless: true, effort: 6 }).toFile(webp);
    written++;
  }
}
console.log(`prepare: icons copied, ${pngs.length} screenshots (${written} WebP written)`);
