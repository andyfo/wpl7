import { describe, expect, it } from 'vitest';
import type { JobLogLine } from '../../shared/types.js';
import { filterLog, firstErrorSeq, levelCounts, logToText } from '../../web/src/lib/jobLog.js';

const line = (seq: number, level: JobLogLine['level'], message: string): JobLogLine => ({
  seq,
  ts: Date.UTC(2026, 8, 27, 3, 0, seq),
  level,
  message,
});

const LOG: JobLogLine[] = [
  line(1, 'info', 'Backup of shop started'),
  line(2, 'warn', 'Plugin akismet reported a notice'),
  line(3, 'info', 'Dumping the database'),
  line(4, 'error', 'mysqldump: Got error 2013'),
  line(5, 'error', 'Backup failed'),
];

describe('job log tools', () => {
  it('counts lines per level', () => {
    expect(levelCounts(LOG)).toEqual({ info: 2, warn: 1, error: 2 });
    expect(levelCounts([])).toEqual({ info: 0, warn: 0, error: 0 });
  });

  it('keeps warnings and errors for "problems"', () => {
    expect(filterLog(LOG, 'problems', '').map((l) => l.seq)).toEqual([2, 4, 5]);
    expect(filterLog(LOG, 'all', '')).toHaveLength(5);
  });

  it('searches case-insensitively, ignoring the spaces around the words', () => {
    expect(filterLog(LOG, 'all', '  BACKUP ').map((l) => l.seq)).toEqual([1, 5]);
    expect(filterLog(LOG, 'problems', 'backup').map((l) => l.seq)).toEqual([5]);
    expect(filterLog(LOG, 'all', '   ')).toHaveLength(5);
    expect(filterLog(LOG, 'all', 'nothing like this')).toEqual([]);
  });

  it('finds the first error for "Show in log"', () => {
    expect(firstErrorSeq(LOG)).toBe(4);
    expect(firstErrorSeq(LOG.slice(0, 3))).toBeNull();
  });

  it('writes a file with UTC timestamps and the level on every line', () => {
    const text = logToText(LOG.slice(0, 2));
    expect(text).toBe(
      '2026-09-27T03:00:01.000Z INFO  Backup of shop started\n' + '2026-09-27T03:00:02.000Z WARN  Plugin akismet reported a notice\n',
    );
    expect(logToText([])).toBe('');
  });
});
