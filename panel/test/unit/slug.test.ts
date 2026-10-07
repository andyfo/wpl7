import { describe, expect, it } from 'vitest';
import { containerName, dbIdentifier, isValidSlug, safeJoin, slugify } from '../../src/lib/slug.js';
import { domainSchema } from '../../shared/schemas.js';

describe('slug validation', () => {
  it('accepts normal slugs', () => {
    expect(isValidSlug('my-blog')).toBe(true);
    expect(isValidSlug('abc')).toBe(true);
    expect(isValidSlug('a2c-4')).toBe(true);
  });

  it('rejects traversal, casing, length and reserved names', () => {
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('My-Blog')).toBe(false);
    expect(isValidSlug('a'.repeat(33))).toBe(false);
    expect(isValidSlug('../etc')).toBe(false);
    expect(isValidSlug('a b')).toBe(false);
    expect(isValidSlug('-abc')).toBe(false);
    expect(isValidSlug('abc-')).toBe(false);
    expect(isValidSlug('panel')).toBe(false);
    expect(isValidSlug('mail')).toBe(false);
    expect(isValidSlug('traefik')).toBe(false);
    // /sites/import is the import wizard.
    expect(isValidSlug('import')).toBe(false);
    expect(isValidSlug('imports')).toBe(false);
    expect(slugify('import')).toBe('import-site');
  });

  it('slugifies titles and domains', () => {
    expect(slugify('My Cool Site!')).toBe('my-cool-site');
    expect(slugify('www.Example-Shop.com')).toBe('example-shop');
    expect(slugify('https://foo-bar.example.com/path')).toBe('foo-bar');
    expect(slugify('??')).toBe('');
    expect(slugify('panel')).toBe('panel-site');
  });

  it('derives names', () => {
    expect(containerName('my-blog')).toBe('wp-my-blog');
    expect(dbIdentifier('my-blog')).toBe('wp_my_blog');
  });

  it('safeJoin blocks escapes', () => {
    expect(safeJoin('/srv/sites', 'ok')).toBe('/srv/sites/ok');
    expect(() => safeJoin('/srv/sites', '../mail')).toThrow();
    expect(() => safeJoin('/srv/sites', 'a/../../b')).toThrow();
  });
});

// domainSchema is what every request body actually goes through; it normalizes first
// (trim / lowercase / drop the trailing root dot) and then applies DOMAIN_RE.
const accepts = (d: string) => domainSchema.safeParse(d).success;

describe('domain validation', () => {
  it('accepts hostnames', () => {
    expect(accepts('example.com')).toBe(true);
    expect(accepts('www.example.co.uk')).toBe(true);
    expect(accepts('a-b.dev.example.com')).toBe(true);
    expect(accepts('xn--80ak6aa92e.com')).toBe(true);
  });

  it('rejects injection vectors and invalid names', () => {
    expect(accepts('example')).toBe(false);
    expect(accepts('exa mple.com')).toBe(false);
    expect(accepts('exa`mple.com')).toBe(false);
    expect(accepts("exa'mple.com")).toBe(false);
    expect(accepts('*.example.com')).toBe(false);
    expect(accepts('-bad.example.com')).toBe(false);
    expect(accepts('under_score.example.com')).toBe(false);
    expect(accepts('a'.repeat(64) + '.com')).toBe(false);
  });

  it('normalizes', () => {
    expect(domainSchema.parse(' Example.COM. ')).toBe('example.com');
  });
});
