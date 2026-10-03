import { describe, expect, it } from 'vitest';
import { WP_LOCALES } from '../../shared/locales.js';
import { localeSchema } from '../../shared/schemas.js';

describe('WordPress locale list', () => {
  it('offers the whole WordPress language list, English first', () => {
    // WordPress ships well over a hundred translations; a regeneration that silently
    // produced a handful of entries would pass every other assertion here.
    expect(WP_LOCALES.length).toBeGreaterThan(100);
    expect(WP_LOCALES[0]!.code).toBe('en_US');
    for (const code of ['cs_CZ', 'sk_SK', 'de_DE', 'de_DE_formal', 'pt_PT_ao90', 'zh_CN', 'el']) {
      expect(WP_LOCALES.map((l) => l.code)).toContain(code);
    }
  });

  it('has no duplicates and is sorted by English name after en_US', () => {
    const codes = WP_LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    const english = WP_LOCALES.slice(1).map((l) => l.english);
    expect(english).toEqual([...english].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('every offered code is accepted by the API schema', () => {
    // The picker and the validator have to agree, or a language the UI offers is rejected
    // on submit (pt_PT_ao90 used to be).
    const rejected = WP_LOCALES.filter((l) => !localeSchema.safeParse(l.code).success).map((l) => l.code);
    expect(rejected).toEqual([]);
  });

  it('every entry carries a native and an English name', () => {
    for (const l of WP_LOCALES) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.english.length).toBeGreaterThan(0);
    }
  });
});
