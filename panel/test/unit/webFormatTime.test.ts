import { describe, expect, it } from 'vitest';
import { formatDuration, timeAgo, timeUntil } from '../../web/src/lib/format.js';

const NOW = 1_700_000_000_000;
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe('relative times', () => {
  it('reads the past as before', () => {
    expect(timeAgo(NOW - 5 * S, NOW)).toBe('5s ago');
    expect(timeAgo(NOW - 3 * M, NOW)).toBe('3m ago');
    expect(timeAgo(NOW - 5 * H, NOW)).toBe('5h ago');
    expect(timeAgo(NOW - 3 * D, NOW)).toBe('3d ago');
    expect(timeAgo(null, NOW)).toBe('–');
  });

  it('never prints a negative age for a time a little ahead of this clock', () => {
    expect(timeAgo(NOW, NOW)).toBe('just now');
    expect(timeAgo(NOW + 3 * S, NOW)).toBe('just now');
    expect(timeAgo(NOW + 2 * H, NOW)).toBe('just now');
  });

  it('reads the future as "in …", rounded', () => {
    expect(timeUntil(NOW + 45 * S, NOW)).toBe('in 45s');
    expect(timeUntil(NOW + 12 * M, NOW)).toBe('in 12m');
    expect(timeUntil(NOW + 12 * M + 40 * S, NOW)).toBe('in 13m');
    expect(timeUntil(NOW + 3 * H, NOW)).toBe('in 3h');
    expect(timeUntil(NOW + 3 * H + 50 * M, NOW)).toBe('in 4h');
    expect(timeUntil(NOW + 2 * D, NOW)).toBe('in 2d');
    expect(timeUntil(null, NOW)).toBe('–');
  });

  it('does not say "in 60m" or "in 24h"', () => {
    expect(timeUntil(NOW + 59 * M + 50 * S, NOW)).toBe('in 1h');
    expect(timeUntil(NOW + 23 * H + 45 * M, NOW)).toBe('in 1d');
    expect(timeUntil(NOW + 59.7 * S, NOW)).toBe('in 1m');
  });

  it('calls a run that is due, or a tick late, "any moment"', () => {
    expect(timeUntil(NOW + 2 * S, NOW)).toBe('any moment');
    expect(timeUntil(NOW, NOW)).toBe('any moment');
    expect(timeUntil(NOW - 30 * S, NOW)).toBe('any moment');
  });
});

describe('durations', () => {
  it('uses the two largest units', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(12 * S)).toBe('12s');
    expect(formatDuration(12.4 * S)).toBe('12s');
    expect(formatDuration(3 * M + 20 * S)).toBe('3m 20s');
    expect(formatDuration(3 * M)).toBe('3m');
    expect(formatDuration(H + 5 * M + 30 * S)).toBe('1h 5m');
    expect(formatDuration(2 * H)).toBe('2h');
  });

  it('rounds up into the next unit instead of printing "1000 ms" or "60s"', () => {
    expect(formatDuration(999.7)).toBe('1s');
    expect(formatDuration(59.6 * S)).toBe('1m');
  });

  it('has nothing to say about a missing or impossible duration', () => {
    expect(formatDuration(null)).toBe('–');
    expect(formatDuration(undefined)).toBe('–');
    expect(formatDuration(-5)).toBe('–');
    expect(formatDuration(Number.NaN)).toBe('–');
  });
});
