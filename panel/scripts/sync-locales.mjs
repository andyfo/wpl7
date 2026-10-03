#!/usr/bin/env node
/**
 * Regenerate shared/locales.ts from WordPress's own translation index - the very list
 * wp-admin offers under Settings -> Site Language.
 *
 *   node scripts/sync-locales.mjs [<wordpress-version>]
 *
 * Without an argument it asks wordpress.org for the current stable release and takes the
 * languages available for it. The list is committed rather than fetched at runtime: the
 * panel must serve its site wizard without reaching the internet.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'locales.ts');

const getJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
};

const version =
  process.argv[2] ??
  (await getJson('https://api.wordpress.org/core/version-check/1.7/')).offers?.[0]?.current;
if (!version) throw new Error('could not determine the current WordPress version');

const { translations } = await getJson(
  `https://api.wordpress.org/translations/core/1.0/?version=${encodeURIComponent(version)}`,
);
if (!Array.isArray(translations) || translations.length === 0) {
  throw new Error(`no translations returned for WordPress ${version}`);
}

// en_US is not a translation - it is what core is written in, and what WordPress puts at
// the top of its own dropdown.
const locales = [
  { code: 'en_US', label: 'English (United States)', english: 'English (United States)' },
  ...translations
    .map((t) => ({ code: t.language, label: t.native_name, english: t.english_name }))
    .sort((a, b) => a.english.localeCompare(b.english, 'en')),
];

const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const body = locales
  .map((l) => `  { code: ${quote(l.code)}, label: ${quote(l.label)}, english: ${quote(l.english)} },`)
  .join('\n');

await writeFile(
  OUT,
  `/**
 * Every language WordPress ships a translation for, plus en_US - the same set its own
 * "Site Language" dropdown offers.
 *
 * GENERATED from https://api.wordpress.org/translations/core/1.0/?version=${version}
 * (WordPress ${version}, ${new Date().toISOString().slice(0, 10)}). Re-run \`npm run locales:sync\`
 * after a WordPress release to pick up new languages; do not edit by hand.
 *
 * The list drives the panel's pickers only - the API accepts any code localeSchema allows,
 * so a locale released after this file was generated still works over the REST API.
 */
export interface WpLocale {
  /** wp.org locale code, e.g. \`de_DE\` - what \`wp language core install\` takes. */
  code: string;
  /** Native name, the way WordPress labels it ("Deutsch"). */
  label: string;
  /** English name ("German"); the pickers sort by it. */
  english: string;
}

export const WP_LOCALES: WpLocale[] = [
${body}
];
`,
  'utf8',
);
console.log(`shared/locales.ts: ${locales.length} locales (WordPress ${version})`);
