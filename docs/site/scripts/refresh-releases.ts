/**
 * npm run docs:releases
 *
 * Refreshes src/data/releases.json from the repository's GitHub releases: the Changelog page is
 * generated from it (gen-changelog.ts), and the Edge badges compare `since:` with `latest`.
 *
 * Drafts are left out, and so are the two releases that are not versions: the rolling `edge`
 * build, and `docs-site`, where the publish job puts the docs for the website. `latest` is the
 * release GitHub marks Latest (never a prerelease), or null when there is none. Releases are
 * newest first, in an order that does not depend on the API's. Uses GITHUB_TOKEN when it is set.
 *
 * Fails soft: on any network or API error it keeps the file as it is, warns, and exits 0, so a
 * publish never stops because GitHub did not answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SITE_DIR, isMain } from './lib/pages.js';

export const RELEASES_FILE = path.join(SITE_DIR, 'src/data/releases.json');
const REPO = 'andyfo/wpl7';
const API = `https://api.github.com/repos/${REPO}`;
/** Releases that are not versions of WPL7 (deploy.yml's `edge`, docs.yml's `docs-site`). */
const NOT_VERSIONS = new Set(['edge', 'docs-site']);

export interface Release {
  tag: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  url: string;
  body: string;
}

export interface Releases {
  latest: string | null;
  releases: Release[];
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  body: string | null;
}

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'wpl7-docs',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function get(url: string): Promise<Response> {
  return fetch(url, { headers: headers(), signal: AbortSignal.timeout(30_000) });
}

/** Every page of the releases list, following the Link header. */
async function allReleases(): Promise<GitHubRelease[]> {
  const out: GitHubRelease[] = [];
  let url: string | null = `${API}/releases?per_page=100`;
  while (url) {
    const res = await get(url);
    if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
    out.push(...((await res.json()) as GitHubRelease[]));
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
  }
  return out;
}

async function latestTag(): Promise<string | null> {
  const res = await get(`${API}/releases/latest`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${API}/releases/latest: ${res.status} ${res.statusText}`);
  return ((await res.json()) as GitHubRelease).tag_name;
}

export async function fetchReleases(): Promise<Releases> {
  const [list, latest] = await Promise.all([allReleases(), latestTag()]);
  const releases = list
    .filter((r) => !r.draft && !NOT_VERSIONS.has(r.tag_name) && r.published_at)
    .map((r) => ({
      tag: r.tag_name,
      name: (r.name ?? '').trim() || r.tag_name,
      publishedAt: r.published_at!,
      prerelease: r.prerelease,
      url: r.html_url,
      body: (r.body ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim(),
    }))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.tag.localeCompare(b.tag));
  return { latest, releases };
}

export function readReleases(): Releases {
  return JSON.parse(fs.readFileSync(RELEASES_FILE, 'utf8')) as Releases;
}

if (isMain(import.meta.url)) {
  try {
    const data = await fetchReleases();
    const next = `${JSON.stringify(data, null, 2)}\n`;
    const changed = !fs.existsSync(RELEASES_FILE) || fs.readFileSync(RELEASES_FILE, 'utf8') !== next;
    if (changed) fs.writeFileSync(RELEASES_FILE, next);
    console.log(`docs:releases: ${data.releases.length} releases, latest ${data.latest ?? 'none'}${changed ? '' : ', unchanged'}`);
  } catch (err) {
    console.warn(`docs:releases: kept the existing src/data/releases.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}
