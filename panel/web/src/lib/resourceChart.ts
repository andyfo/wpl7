export type ResourcePoint = { ts: number; value: number | null };

/** Time-positioned paths; unavailable readings and collection gaps break the line. */
export function chartSegments(points: ResourcePoint[], since: number, until: number, ceiling: number, gapMs: number) {
  const segments: { x: number; y: number; point: ResourcePoint }[][] = [];
  let segment: (typeof segments)[number] = [];
  let previousTs: number | undefined;
  for (const point of points) {
    if (
      point.value === null ||
      !Number.isFinite(point.value) ||
      (previousTs !== undefined && point.ts - previousTs > gapMs)
    ) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (point.value !== null && Number.isFinite(point.value)) {
      segment.push({
        x: ((point.ts - since) / Math.max(1, until - since)) * 320,
        y: 100 - (Math.max(0, Math.min(ceiling, point.value)) / ceiling) * 92,
        point,
      });
    }
    previousTs = point.ts;
  }
  if (segment.length) segments.push(segment);
  return segments;
}
