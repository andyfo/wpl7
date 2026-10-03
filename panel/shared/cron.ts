/**
 * Plain-language rendering of a five-field cron expression, so the schedule editor can
 * show an operator what they just typed before they save it.
 *
 * croner stays the authority on what the panel accepts - it understands more than this
 * (a seconds field, `L`, `#`, `?`), so every entry point here reports "I cannot read
 * this" rather than guessing, which is what lets the editor hand such an expression to
 * a plain text box instead of mangling it.
 */

export type CronFieldKey = 'minute' | 'hour' | 'dom' | 'month' | 'dow';

export interface CronFieldSpec {
  key: CronFieldKey;
  label: string;
  /** Caption under the slot, where only a few characters fit. */
  short: string;
  min: number;
  max: number;
  /** Range reminder, shown on hover. */
  hint: string;
  /** Names cron takes instead of numbers, lowest value first; matched on the first three letters. */
  names?: readonly string[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The five fields in the order cron writes them. */
export const CRON_FIELDS: readonly CronFieldSpec[] = [
  { key: 'minute', label: 'Minute', short: 'min', min: 0, max: 59, hint: '0–59' },
  { key: 'hour', label: 'Hour', short: 'hour', min: 0, max: 23, hint: '0–23' },
  { key: 'dom', label: 'Day of month', short: 'day', min: 1, max: 31, hint: '1–31' },
  { key: 'month', label: 'Month', short: 'month', min: 1, max: 12, hint: '1–12 or JAN', names: MONTH_NAMES },
  { key: 'dow', label: 'Day of week', short: 'weekday', min: 0, max: 7, hint: '0–7, 0 = Sun', names: DAY_NAMES },
];

export const DEFAULT_CRON = '0 3 * * *';

interface ParsedField {
  /** The field is exactly `*`, so it restricts nothing. */
  every: boolean;
  /** Step of a whole-range `*​/n`, kept because "every 15 minutes" reads better than a list. */
  step: number | null;
  /** Matching values, ascending and de-duplicated. */
  values: number[];
}

const NUMBER = /^\d+$/;

/** Split on whitespace; null unless the expression has exactly the five fields of the editor. */
export function cronParts(expr: string): string[] | null {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every(Boolean) ? parts : null;
}

/** A single number or three-letter name, or null when the token is neither. */
function tokenValue(token: string, spec: CronFieldSpec): number | null {
  if (NUMBER.test(token)) {
    const n = Number(token);
    return n >= spec.min && n <= spec.max ? n : null;
  }
  const i = spec.names?.findIndex((name) => name.slice(0, 3).toLowerCase() === token.toLowerCase()) ?? -1;
  return i < 0 ? null : i + spec.min;
}

function parseField(raw: string, spec: CronFieldSpec): { field: ParsedField } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: `${spec.label} is empty — enter a number or *.` };

  const values = new Set<number>();
  for (const term of text.split(',')) {
    const [rangeText = '', stepText, ...extra] = term.split('/');
    if (extra.length > 0) return { error: `"${term}" has more than one /.` };

    let termStep = 1;
    if (stepText !== undefined) {
      if (!NUMBER.test(stepText) || Number(stepText) < 1) {
        return { error: `"${term}": the step after / must be a whole number, 1 or more.` };
      }
      termStep = Number(stepText);
    }

    let lo: number;
    let hi: number;
    if (rangeText === '*') {
      lo = spec.min;
      hi = spec.max;
    } else {
      const bounds = rangeText.split('-');
      if (bounds.length > 2) return { error: `"${term}" is not a value or a range like 1-5.` };
      // croner rejects a numeric prefix before a step, so "5/15" is a typo for "*/15" here too.
      if (stepText !== undefined && bounds.length === 1) {
        return {
          error: `"${term}": put * or a range before the / (*/${termStep} or ${spec.min}-${spec.max}/${termStep}).`,
        };
      }
      const first = tokenValue(bounds[0] ?? '', spec);
      const second = bounds.length === 2 ? tokenValue(bounds[1] ?? '', spec) : first;
      if (first === null || second === null) {
        const offender = first === null ? bounds[0] : bounds[1];
        return {
          error: NUMBER.test(offender ?? '')
            ? `${spec.label} must be between ${spec.min} and ${spec.max} — "${offender}" is outside that.`
            : `"${offender}" is not a ${spec.label.toLowerCase()} value. Use a number, a range like 1-5, a step like */2, or *.`,
        };
      }
      if (first > second) return { error: `"${term}" runs backwards — write the smaller value first.` };
      lo = first;
      hi = second;
    }
    for (let v = lo; v <= hi; v += termStep) values.add(spec.key === 'dow' && v === 7 ? 0 : v);
  }

  // `*/1` is `*` written the long way; treating it as a step would read "every 1 minutes".
  const wholeRangeStep = /^\*\/(\d+)$/.exec(text);
  const step = wholeRangeStep ? Number(wholeRangeStep[1]) : null;
  return {
    field: {
      every: text === '*' || step === 1,
      step: step === 1 ? null : step,
      values: [...values].sort((a, b) => a - b),
    },
  };
}

/** What is wrong with one box of the editor, or null when it is fine. */
export function cronFieldError(raw: string, index: number): string | null {
  const spec = CRON_FIELDS[index];
  if (!spec) return null;
  const parsed = parseField(raw, spec);
  return 'error' in parsed ? parsed.error : null;
}

/** The first problem in a whole expression, or null when the editor can render it. */
export function cronError(expr: string): string | null {
  const parts = cronParts(expr);
  if (!parts) {
    return 'A schedule has five fields: minute, hour, day of month, month and day of week.';
  }
  for (const [i, raw] of parts.entries()) {
    const error = cronFieldError(raw, i);
    if (error) return error;
  }
  return null;
}

/** True when the five-box editor can hold this expression without changing its meaning. */
export function isCronEditable(expr: string): boolean {
  return cronError(expr) === null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Long runs read as "1st through 15th" instead of thirteen items of punctuation. */
function isRun(values: number[]): boolean {
  return values.length > 2 && values.every((v, i) => i === 0 || v === values[i - 1]! + 1);
}

/** "03:00" / "every 3rd hour" / "the hours 02, 05" - the window a repeating minute runs in. */
function hourWindow(hour: ParsedField): string {
  if (hour.step) return `of every ${ordinal(hour.step)} hour`;
  const values = hour.values;
  if (values.length === 1) return `between ${pad(values[0]!)}:00 and ${pad(values[0]!)}:59`;
  if (isRun(values)) return `between ${pad(values[0]!)}:00 and ${pad(values[values.length - 1]!)}:59`;
  return `during the hours ${joinList(values.map((h) => `${pad(h)}:00`))}`;
}

function timePhrase(minute: ParsedField, hour: ParsedField): string {
  const repeating = minute.every ? 'Every minute' : minute.step ? `Every ${minute.step} minutes` : null;
  if (repeating) return hour.every ? repeating : `${repeating} ${hourWindow(hour)}`;

  const minutes = minute.values.map((m) => `:${pad(m)}`);
  if (hour.every) return `At ${joinList(minutes)} past every hour`;
  if (hour.step) return `At ${joinList(minutes)} past every ${ordinal(hour.step)} hour`;
  if (hour.values.length * minute.values.length <= 8) {
    const times = hour.values.flatMap((h) => minute.values.map((m) => `${pad(h)}:${pad(m)}`));
    return `At ${joinList(times)}`;
  }
  if (isRun(hour.values)) {
    const [first] = hour.values;
    return `At ${joinList(minutes)} past every hour from ${pad(first!)}:00 to ${pad(hour.values[hour.values.length - 1]!)}:00`;
  }
  return `At ${joinList(minutes)} past the hours ${joinList(hour.values.map(pad))}`;
}

function dayOfMonthPhrase(dom: ParsedField): string {
  if (dom.step) return `every ${ordinal(dom.step)} day of the month`;
  if (isRun(dom.values)) {
    return `from the ${ordinal(dom.values[0]!)} to the ${ordinal(dom.values[dom.values.length - 1]!)} of the month`;
  }
  return `on the ${joinList(dom.values.map(ordinal))} of the month`;
}

function weekdayPhrase(dow: ParsedField): string {
  const names = dow.values.map((d) => DAY_NAMES[d] ?? String(d));
  if (isRun(dow.values)) return `${names[0]} through ${names[names.length - 1]}`;
  return `on ${joinList(names.map((n) => `${n}s`))}`;
}

/**
 * cron runs a job when *either* the day of month or the day of week matches once both are
 * restricted - the classic surprise - so both clauses are spelled out, joined by "and".
 */
function dayPhrase(dom: ParsedField, month: ParsedField, dow: ParsedField): string {
  const clauses: string[] = [];
  if (!dom.every) clauses.push(dayOfMonthPhrase(dom));
  if (!dow.every) clauses.push(weekdayPhrase(dow));
  let days = clauses.length > 0 ? joinList(clauses) : 'every day';
  if (!month.every) {
    const names = month.values.map((m) => MONTH_NAMES[m - 1] ?? String(m));
    days += isRun(month.values)
      ? ` in ${names[0]} through ${names[names.length - 1]}`
      : ` in ${joinList(names)}`;
  }
  return days;
}

/** The expression in words ("At 03:00, every day."), or null when the editor cannot read it. */
export function describeCron(expr: string): string | null {
  const parts = cronParts(expr);
  if (!parts) return null;

  const parsed: ParsedField[] = [];
  for (const [i, raw] of parts.entries()) {
    const result = parseField(raw, CRON_FIELDS[i]!);
    if ('error' in result) return null;
    parsed.push(result.field);
  }
  const [minute, hour, dom, month, dow] = parsed as [
    ParsedField, ParsedField, ParsedField, ParsedField, ParsedField,
  ];

  const time = timePhrase(minute, hour);
  const days = dayPhrase(dom, month, dow);
  // "Every 15 minutes, every day" says the same thing twice; anything narrower needs the clause.
  const repeats = minute.every || minute.step !== null || hour.every || hour.step !== null;
  if (days === 'every day' && repeats) return `${time}.`;
  return days.startsWith('every day') ? `${time}, ${days}.` : `${time} ${days}.`;
}
