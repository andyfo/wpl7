import { describe, expect, it } from 'vitest';
import { chartSegments } from '../../web/src/lib/resourceChart.js';

describe('resource chart geometry', () => {
  it('positions samples by elapsed time and leaves outages disconnected', () => {
    const segments = chartSegments(
      [
        { ts: 0, value: 20 },
        { ts: 10, value: 40 },
        { ts: 50, value: 60 },
        { ts: 60, value: null },
        { ts: 70, value: 80 },
        { ts: 80, value: NaN },
        { ts: 100, value: 0 },
      ],
      0,
      100,
      100,
      25,
    );
    expect(segments.map((s) => s.length)).toEqual([2, 1, 1, 1]);
    expect(segments[0]![1]!.x).toBe(32);
    expect(segments[1]![0]!.x).toBe(160);
    expect(segments.at(-1)![0]).toMatchObject({ x: 320, y: 100 });
  });

  it('handles empty, single-sample and zero-use histories without invented data', () => {
    expect(chartSegments([], 0, 100, 1, 25)).toEqual([]);
    expect(chartSegments([{ ts: 50, value: null }], 0, 100, 1, 25)).toEqual([]);
    expect(chartSegments([{ ts: 50, value: 0 }], 0, 100, 1, 25)).toEqual([
      [{ x: 160, y: 100, point: { ts: 50, value: 0 } }],
    ]);
  });
});
