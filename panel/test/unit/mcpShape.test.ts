import { describe, expect, it } from 'vitest';
import { fitAnswer, project } from '../../src/mcp/shape.js';

const sites = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ slug: `site-${i}`, status: 'running', domains: [`site-${i}.test`], wp: { version: '6.8' } }));

describe('project', () => {
  it('keeps only the named fields of each item in the lists an answer holds', () => {
    expect(project({ items: sites(2), total: 2 }, ['slug', 'wp.version'])).toEqual({
      items: [
        { slug: 'site-0', wp: { version: '6.8' } },
        { slug: 'site-1', wp: { version: '6.8' } },
      ],
      total: 2,
    });
    expect(project(sites(1), ['status'])).toEqual([{ status: 'running' }]);
  });

  it('leaves everything alone when nothing is selected', () => {
    const body = { items: sites(1) };
    expect(project(body, undefined)).toBe(body);
    expect(project(body, [])).toBe(body);
  });
});

describe('fitAnswer', () => {
  it('passes a small answer through as compact JSON', () => {
    const envelope = { status: 200, endpoint: 'GET /api/sites', body: { items: sites(2) } };
    expect(JSON.parse(fitAnswer(envelope))).toEqual(envelope);
    expect(fitAnswer(envelope)).not.toContain('\n');
  });

  it('cuts the longest list to what fits, keeps its head, and says how much was left out', () => {
    const text = fitAnswer({ status: 200, endpoint: 'GET /api/sites', body: { items: sites(2000), total: 2000 } }, 5_000);
    expect(text.length).toBeLessThanOrEqual(5_000);
    const parsed = JSON.parse(text);
    expect(parsed.body.items[0].slug).toBe('site-0');
    expect(parsed.body.total).toBe(2000);
    expect(parsed.truncated).toEqual([{ field: 'body.items', returned: parsed.body.items.length, total: 2000 }]);
    expect(parsed.body.items.length).toBeGreaterThan(10);
  });

  it('clips long strings when cutting lists is not enough', () => {
    const text = fitAnswer({ status: 200, body: { readme: 'x'.repeat(50_000), note: 'short' } }, 5_000);
    expect(text.length).toBeLessThanOrEqual(5_000);
    const parsed = JSON.parse(text);
    expect(parsed.body.note).toBe('short');
    expect(parsed.body.readme).toMatch(/^x{2000}… \[48000 more characters\]$/);
  });

  it('never exceeds the budget and always answers valid JSON, whatever it is given', () => {
    const shapes: Record<string, unknown>[] = [
      { body: Array.from({ length: 300 }, (_, i) => 'y'.repeat(100 + i)) },
      { body: { deep: { deeper: { list: sites(5000) } } } },
      { body: Array.from({ length: 50 }, () => ({ blob: 'z'.repeat(3000) })) },
      { body: 'q'.repeat(100_000) },
      { body: { one: [{ huge: Array.from({ length: 4000 }, (_, i) => i) }] } },
    ];
    for (const shape of shapes) {
      for (const budget of [1_000, 4_000, 40_000]) {
        const text = fitAnswer({ status: 200, endpoint: 'GET /api/x', ...shape }, budget);
        expect(text.length, JSON.stringify(Object.keys(shape))).toBeLessThanOrEqual(budget);
        expect(() => JSON.parse(text)).not.toThrow();
      }
    }
  });

  it('holds the budget for an answer with no body, and for text that is mostly quotes', () => {
    const noBody = fitAnswer({ done: true, status: 'failed', log: ['"'.repeat(60_000)], lastSeq: 9 }, 5_000);
    expect(noBody.length).toBeLessThanOrEqual(5_000);
    expect(JSON.parse(noBody)).toMatchObject({ done: true, status: 'failed', lastSeq: 9 });
    const quotes = fitAnswer({ status: 200, body: { blob: '"\\'.repeat(40_000) } }, 3_000);
    expect(quotes.length).toBeLessThanOrEqual(3_000);
    expect(() => JSON.parse(quotes)).not.toThrow();
  });

  it('hands back the start of an answer that is one enormous value, as a string, and says so', () => {
    const text = fitAnswer({ status: 200, endpoint: 'GET /api/x', body: { blob: 'q'.repeat(100_000) } }, 1_000);
    const parsed = JSON.parse(text);
    expect(parsed.partial).toMatch(/^\{"body":\{"blob":"q+/);
    expect(parsed.truncated).toMatch(/start of its JSON text/);
    expect(parsed).toMatchObject({ status: 200, endpoint: 'GET /api/x' });
  });
});
