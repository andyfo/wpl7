import path from 'node:path';
import { RESERVED_SLUGS, SLUG_RE } from '../../shared/schemas.js';

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !(RESERVED_SLUGS as readonly string[]).includes(slug);
}

export function assertValidSlug(slug: string): void {
  if (!isValidSlug(slug)) throw new Error(`Invalid site slug: ${JSON.stringify(slug)}`);
}

/** Derive a slug from arbitrary input (a domain or title). Returns '' when nothing usable remains. */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]!
    // For domains, use the leftmost label; e.g. "my-shop.example.com" -> "my-shop"
    .split('.')[0]!
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-$/, '');
  if (base.length < 3) return '';
  if ((RESERVED_SLUGS as readonly string[]).includes(base)) return `${base}-site`.slice(0, 32);
  return base;
}

/** Container name for a site. */
export const containerName = (slug: string) => `wp-${slug}`;

/** Database name and user for a site (identifiers are safe: slug charset is locked). */
export const dbIdentifier = (slug: string) => `wp_${slug.replace(/-/g, '_')}`;

/**
 * Resolve a path under a base directory and assert it stayed inside.
 * Defense in depth on top of slug validation before any rm -rf / tar / bind mount.
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments);
  const normalizedBase = path.resolve(base);
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
    throw new Error(`Path escapes base directory: ${resolved}`);
  }
  return resolved;
}
