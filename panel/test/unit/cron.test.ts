import { describe, expect, it } from 'vitest';
import { Cron } from 'croner';
import { cronError, cronFieldError, cronParts, describeCron, isCronEditable } from '../../shared/cron.js';

describe('cron descriptions', () => {
  const cases: [string, string][] = [
    ['0 3 * * *', 'At 03:00, every day.'],
    ['*/15 * * * *', 'Every 15 minutes.'],
    ['* * * * *', 'Every minute.'],
    ['*/1 * * * *', 'Every minute.'],
    ['0 * * * *', 'At :00 past every hour.'],
    ['0 */3 * * *', 'At :00 past every 3rd hour.'],
    ['30 2 * * 1', 'At 02:30 on Mondays.'],
    ['0 3,15 * * *', 'At 03:00 and 15:00, every day.'],
    ['0 3 1,15 * *', 'At 03:00 on the 1st and 15th of the month.'],
    ['0 3 1-15 * *', 'At 03:00 from the 1st to the 15th of the month.'],
    ['0 3 */5 * *', 'At 03:00 every 5th day of the month.'],
    ['0 3 * * MON-FRI', 'At 03:00 Monday through Friday.'],
    ['0 3 * * 7', 'At 03:00 on Sundays.'],
    ['*/10 2-5 * * *', 'Every 10 minutes between 02:00 and 05:59.'],
    ['0,30 8-17 * * 1-5', 'At :00 and :30 past every hour from 08:00 to 17:00 Monday through Friday.'],
    ['0 4 * 1,7 *', 'At 04:00, every day in January and July.'],
    ['15 0 1 */3 *', 'At 00:15 on the 1st of the month in January, April, July and October.'],
  ];

  for (const [expr, text] of cases) {
    it(`reads "${expr}" as "${text}"`, () => expect(describeCron(expr)).toBe(text));
  }

  it('splits on any run of whitespace', () => {
    expect(cronParts('  0   3 * * *  ')).toEqual(['0', '3', '*', '*', '*']);
    expect(cronParts('0 3 * *')).toBeNull();
    expect(cronParts('0 0 3 * * *')).toBeNull(); // croner's seconds form - not this editor's
  });

  it('lists the same times croner fires at', () => {
    expect(describeCron('5 0-12/3 * * *')).toBe('At 00:05, 03:05, 06:05, 09:05 and 12:05, every day.');
    const runs = new Cron('5 0-12/3 * * *', { paused: true }).nextRuns(6, new Date(2026, 0, 1));
    const clock = runs.map((d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    expect([...new Set(clock)].sort()).toEqual(['00:05', '03:05', '06:05', '09:05', '12:05']);
  });

  /**
   * cron fires when *either* day field matches once both are restricted. The sentence has
   * to say so, because an operator reading it as "the 1st, if that is a Monday" would be
   * planning around a backup window that is five times wider than they think.
   */
  it('spells out the day-of-month / day-of-week OR the way croner runs it', () => {
    expect(describeCron('0 3 1 * 1')).toBe('At 03:00 on the 1st of the month and on Mondays.');
    const runs = new Cron('0 3 1 * 1', { paused: true }).nextRuns(10, new Date(2026, 0, 1));
    expect(runs.every((d) => d.getDate() === 1 || d.getDay() === 1)).toBe(true);
    expect(runs.some((d) => d.getDate() === 1 && d.getDay() !== 1)).toBe(true);
  });
});

describe('cron validation', () => {
  it('names the field and the range a value missed', () => {
    expect(cronFieldError('99', 0)).toMatch(/Minute must be between 0 and 59/);
    expect(cronFieldError('24', 1)).toMatch(/Hour must be between 0 and 23/);
    expect(cronFieldError('', 2)).toMatch(/is empty/);
    expect(cronFieldError('5-1', 2)).toMatch(/runs backwards/);
    expect(cronFieldError('*/0', 0)).toMatch(/1 or more/);
    expect(cronFieldError('5/15', 0)).toMatch(/put \* or a range before/); // croner rejects it too
    expect(cronFieldError('FOO', 4)).toMatch(/not a day of week value/);
  });

  it('takes every value cron does for that field', () => {
    const fine = ['*', '0', '59', '*/15', '0-30/5', '1,2,3', '10-20'];
    for (const raw of fine) expect(cronFieldError(raw, 0)).toBeNull();
    expect(cronFieldError('JAN-MAR', 3)).toBeNull();
    expect(cronFieldError('mon,fri', 4)).toBeNull();
    expect(cronFieldError('7', 4)).toBeNull(); // 0 and 7 are both Sunday
  });

  it('asks for five fields when it does not get them', () => {
    expect(cronError('0 3 * *')).toMatch(/five fields/);
    expect(cronError('0 3 * * *')).toBeNull();
  });

  /**
   * The editor is the narrower of the two: everything it accepts must survive the panel's
   * own croner check, or a green preview would turn into a 400 on save.
   */
  it('never accepts a pattern croner would reject', () => {
    const patterns = [
      '0 3 * * *', '*/15 * * * *', '* * * * *', '0,30 8-17 * * 1-5', '0 3 * * MON-FRI',
      '0 3 1 * 1', '15 0 1 */3 *', '0 3 * * 7', '0-30/5 */2 1-15 JAN-MAR mon,fri',
    ];
    for (const expr of patterns) {
      expect(isCronEditable(expr)).toBe(true);
      expect(() => new Cron(expr, { paused: true })).not.toThrow();
    }
  });

  /**
   * croner is the wider one: the boxes cannot express a seconds field, `L` or `#`, so the
   * editor hands those to its text box instead of quietly rewriting them.
   */
  it('leaves croner-only syntax to the text box', () => {
    for (const expr of ['0 0 3 * * *', '0 3 L * *', '0 3 * * 1#2']) {
      expect(isCronEditable(expr)).toBe(false);
      expect(() => new Cron(expr, { paused: true })).not.toThrow();
    }
  });
});
